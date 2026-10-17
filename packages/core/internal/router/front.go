// The router's front: the one process the plugin starts. It owns 127.0.0.1:<port> and never lets
// go of it while it runs, holds no provider logic and no key, and hands each request to one
// worker (the router, re-executed from this binary) over loopback. The worker is disposable: an
// exit is replaced at once, a hang (no heartbeat for 5 s) is killed and replaced, a worker over
// 512 MB or a hot update is recycled by forking the new one first and draining the old. A request
// the worker never sent upstream (it says so over IPC just before it does) is retried on the next
// worker, so a crash costs only the requests that were already talking to Anthropic. When workers
// will not stay up (3 exits in a minute, or one that never starts) the front serves requests
// itself through the passthrough for a minute, then tries one worker again. Claude traffic never
// sees a refused connection.
//
// When the plugin is removed (a `retire` control call from setup --remove, or the uninstall watch
// seeing the plugin uninstalled or disabled) the front retires instead of stopping: Claude Code
// sessions keep the base URL they started with, so the port stays open. A retired front drains its
// worker, passes every other request to Anthropic exactly as it came, answers this provider's
// models and peer hops with a non-retryable 400 that says to restart Claude Code, writes nothing
// more to the spool, and exits once its `RetiredWatch` says the sessions from before are gone.
package router

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// FrontVersion is the front's protocol: its control endpoints and the worker IPC. A running front
// with another number cannot take a hot update; the starter hands its port to a fresh front
// instead. 3 forks workers as processes of its own binary and hands them the data-path token; the
// 0.0.1 release's front speaks 2, and neither loads the other's engine, so a starter hands over
// from a front of either protocol instead of reloading it.
const FrontVersion = 3

// WorkerTokenEnv is the env name the front hands its token to a forked worker under, so the worker
// can require it on its data path (never logged, never sent anywhere but the loopback hop).
const WorkerTokenEnv = "PROVIDER_ROUTER_WORKER_TOKEN"

// NoWorker is the key check's answer while the front has no worker up yet (just started, or
// replacing one).
const NoWorker = "no worker is running"

// WorkerHandle is a forked worker as the front sees it: its pid, the JSON lines it reports
// (listening once, heartbeats, acks, key answers), the JSON lines it takes (drain, key), and its
// end. Reports are delivered in arrival order, the exit last, on the handle's own goroutine —
// never on the goroutine that registers a listener, which the front does with its lock held.
type WorkerHandle interface {
	Pid() int
	OnMessage(listener func(message []byte))
	OnExit(listener func(code int, signal string))
	Send(message []byte)
	Kill(signal string)
}

// ForkWorker forks one worker: the binary at exec in its worker mode, the front's token in its
// environment.
type ForkWorker func(execPath string, token string) (WorkerHandle, error)

// FrontKnobs is how often the front checks its workers and how long it waits for each thing; a
// zero field takes its default.
type FrontKnobs struct {
	// HeartbeatMs is how often the front checks its workers (and expects their heartbeat).
	HeartbeatMs int64
	// HangMs: no heartbeat for this long means the worker is hung and gets SIGKILL.
	HangMs int64
	// ExitWindowMs is the window DegradeExits worker exits inside put the front in degraded mode.
	ExitWindowMs int64
	DegradeExits int
	// DegradedMs is how long degraded mode lasts before one worker is tried again.
	DegradedMs int64
	// RssLimitMb: a worker whose resident size passes this is recycled.
	RssLimitMb float64
	// StartMs: a worker that does not listen within this long failed to start.
	StartMs int64
	// WaitWorkerMs is how long a request waits for a worker before the front serves it itself.
	WaitWorkerMs int64
	// AckWaitMs is how long a failed request waits to learn whether its worker had sent it
	// upstream.
	AckWaitMs int64
	// DrainMs is the longest a draining worker (or a handed-over front) may take to finish its
	// streams.
	DrainMs int64
	// KeyCheckMs is how long the key check waits for the worker's answer.
	KeyCheckMs int64
	// BodyLimit is the largest request body (64 MiB).
	BodyLimit int64
}

// resolveFrontKnobs fills in each zero field's default.
func resolveFrontKnobs(knobs FrontKnobs) FrontKnobs {
	if knobs.HeartbeatMs == 0 {
		knobs.HeartbeatMs = 1000
	}
	if knobs.HangMs == 0 {
		knobs.HangMs = 5000
	}
	if knobs.ExitWindowMs == 0 {
		knobs.ExitWindowMs = 60000
	}
	if knobs.DegradeExits == 0 {
		knobs.DegradeExits = 3
	}
	if knobs.DegradedMs == 0 {
		knobs.DegradedMs = 60000
	}
	if knobs.RssLimitMb == 0 {
		knobs.RssLimitMb = 512
	}
	if knobs.StartMs == 0 {
		knobs.StartMs = 10000
	}
	if knobs.WaitWorkerMs == 0 {
		knobs.WaitWorkerMs = 10000
	}
	if knobs.AckWaitMs == 0 {
		knobs.AckWaitMs = 2000
	}
	if knobs.DrainMs == 0 {
		knobs.DrainMs = 10 * 60000
	}
	if knobs.KeyCheckMs == 0 {
		knobs.KeyCheckMs = 3000
	}
	if knobs.BodyLimit == 0 {
		knobs.BodyLimit = BodyLimitBytes
	}
	return knobs
}

// FrontWatch is the uninstall watch the front runs: every EveryMs, Tick says "retire" once the
// plugin is gone and its settings are restored; Cleanup removes what the plugin left behind, just
// before the retired front exits.
type FrontWatch struct {
	EveryMs int64
	// Tick returns "stay" or "retire".
	Tick    func() (string, error)
	Cleanup func() error
}

// RetiredWatch is a retired front's exit check: every EveryMs, Exit gets the retirement time and
// says whether to go.
type RetiredWatch struct {
	EveryMs int64
	Exit    func(retiredAt int64) (bool, error)
}

// FrontOptions is everything the front needs. The callbacks (Note, Log, Events, Done, OnRetire,
// Peers) are leaves: they must not call back into the Front.
type FrontOptions struct {
	Name       string
	Display    string
	HealthPath string
	// Claim is the resolved provider's model claim, for the requests the front serves itself.
	Claim domain.ModelClaim
	// Port is the canonical port the base URL names.
	Port int
	// ListenPort is where the front binds first: the canonical port, or a temporary one during a
	// handover (then `/adopt`). Zero is Port.
	ListenPort int
	Anthropic  *url.URL
	Env        ProxyEnv
	// Version is the bundle's version, reported by health so the starter can tell a stale router.
	Version string
	// FrontVersion is the front protocol this front speaks; nil is FrontVersion (the chaos suite
	// fakes an old one, zero included).
	FrontVersion *int
	// Token is the pid file's token; control calls must carry it.
	Token string
	// Exec is the worker binary; "" is this binary itself. A hot update re-points it.
	Exec string
	// Fork forks a worker; nil re-executes the binary at Exec.
	Fork   ForkWorker
	Knobs  FrontKnobs
	IdleMs int64
	Watch  *FrontWatch
	// Peers says which other plugin's router serves a model: a retired front refuses those
	// requests instead of hopping.
	Peers func(model string) (PeerTarget, bool)
	// RetiredWatch decides when a retired front exits; without one it stays until stopped.
	RetiredWatch *RetiredWatch
	// OnRetire runs once when the front retires (production takes the registry entry out, so no
	// peer forwards here).
	OnRetire func()
	// Note receives the supervision lines (exits, hangs, recycles, degraded transitions) for the
	// router log and the crash log.
	Note func(line string)
	// MarkExit runs once as the front begins its final drain, before the port is released: the
	// exit's line in router.log is already written, and the marker it leaves (router.exit) tells
	// the next start this death was logged. Nothing may write it after the port frees — a starter
	// or a test may treat the free port as the front's end.
	MarkExit func()
	// Log receives per-request lines of the front's own passthrough.
	Log func(line string)
	// Events is Radar's spool: a `fallback` health event per request the front serves itself, a
	// `restart` per worker it has to replace, and one `restart` when it retires (nothing after it).
	Events func(event domain.SpoolEvent)
	// Done runs once the front is finished (handed over, stopped, or retired and its sessions
	// gone); production exits.
	Done func()
	// Now is the clock, epoch milliseconds.
	Now func() int64
}

// FrontStatus is the front's own report.
type FrontStatus struct {
	// Mode is "router", "degraded" or "retired".
	Mode string
	// Worker is "up", "starting" or "down".
	Worker    string
	WorkerPid *int
	Port      int
}

// pendingRequest is one request the worker holds: whether it said (over IPC) that the request had
// gone upstream.
type pendingRequest struct{ acked bool }

// workerState is one forked worker as the front supervises it.
type workerState struct {
	handle    WorkerHandle
	execPath  string
	startedAt int64
	port      int
	lastHb    int64
	draining  bool
	exited    bool
	inflight  map[string]*pendingRequest
	onExit    []func()
}

// frontListener is one bound port (the canonical one, and a handover's temporary one), all serving
// the same front.
type frontListener struct {
	server   *http.Server
	listener net.Listener
}

// workerWaiter is one request waiting for a worker: resolved once, by a worker becoming ready or
// by the wait running out.
type workerWaiter struct {
	once sync.Once
	ch   chan *workerState
}

func (w *workerWaiter) resolve(worker *workerState) {
	w.once.Do(func() { w.ch <- worker })
}

// workerTransport carries the front's requests to its worker over loopback, pooled: the front is
// the only dialer, and one fresh connection per request pins an ephemeral port in TIME_WAIT for
// every one of the thousands of requests a loaded session routes. A dead worker's socket is still
// never handed a request it can lose: the next worker listens on its own port (its own pool
// entry), and a stale pooled socket fails its request exactly where a fresh one fails it — before
// any byte reaches the worker, through afterFailure's retry.
var workerTransport = &http.Transport{
	MaxIdleConns:        256,
	MaxIdleConnsPerHost: 64,
	IdleConnTimeout:     90 * time.Second,
	DisableCompression:  true,
}

// Front is the router's front. CreateFront builds it; Start binds the port and forks the first
// worker.
type Front struct {
	options     FrontOptions
	knobs       FrontKnobs
	fork        ForkWorker
	now         func() int64
	note        func(line string)
	connections *Connections

	mu              sync.Mutex
	execPath        string
	version         string
	current         *workerState
	replacement     *workerState
	drainingWorkers map[*workerState]bool
	degradedUntil   int64
	degradeTimer    *time.Timer
	exits           []int64
	waiters         []*workerWaiter
	retiredFlag     bool
	retiredAt       int64
	closed          bool
	accepting       bool
	finished        bool
	checkingRetired bool
	watching        bool
	seq             int
	listenPort      int
	frontVersion    int
	listeners       []*frontListener
	keyQueries      map[string]chan []byte

	supervise     *time.Ticker
	watchTicker   *time.Ticker
	retiredTicker *time.Ticker
}

// workerReady is a worker requests can go to.
func workerReady(worker *workerState) bool {
	return worker != nil && worker.port != 0 && !worker.draining && !worker.exited
}

// CreateFront builds the front; Start binds and forks. A nil Note is a no-op, a nil Now is the
// wall clock, a nil Fork re-executes the binary, and zero knobs take their defaults.
func CreateFront(options FrontOptions) *Front {
	now := options.Now
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	note := options.Note
	if note == nil {
		note = func(string) {}
	}
	fork := options.Fork
	if fork == nil {
		fork = execFork(options.Name)
	}
	listenPort := options.ListenPort
	if listenPort == 0 {
		listenPort = options.Port
	}
	frontVersion := FrontVersion
	if options.FrontVersion != nil {
		frontVersion = *options.FrontVersion
	}
	f := &Front{
		options:         options,
		knobs:           resolveFrontKnobs(options.Knobs),
		fork:            fork,
		now:             now,
		note:            note,
		execPath:        options.Exec,
		version:         options.Version,
		frontVersion:    frontVersion,
		listenPort:      listenPort,
		accepting:       true,
		drainingWorkers: map[*workerState]bool{},
		keyQueries:      map[string]chan []byte{},
	}
	f.connections = TrackConnections(func(open int) {
		f.mu.Lock()
		accepting := f.accepting
		f.mu.Unlock()
		if !accepting && open == 0 {
			// Off the tracker's own path: finishing closes the very connections the tracker
			// counts, and the tracker runs this callback under its lock.
			go f.finish()
		}
	})
	return f
}

// Start binds the listen port and forks the first worker; it returns the bound port.
func (f *Front) Start() (int, error) {
	f.mu.Lock()
	port := f.listenPort
	heartbeatMs := f.knobs.HeartbeatMs
	f.mu.Unlock()
	if err := f.listen(port); err != nil {
		return 0, err
	}
	f.mu.Lock()
	f.current = f.spawnLocked(f.execPath)
	f.mu.Unlock()
	supervise := time.NewTicker(time.Duration(heartbeatMs) * time.Millisecond)
	f.mu.Lock()
	f.supervise = supervise
	f.mu.Unlock()
	go func() {
		for range supervise.C {
			f.check()
		}
	}()
	if f.options.Watch != nil {
		watchTicker := time.NewTicker(time.Duration(f.options.Watch.EveryMs) * time.Millisecond)
		f.mu.Lock()
		f.watchTicker = watchTicker
		f.mu.Unlock()
		go func() {
			for range watchTicker.C {
				f.watchTick()
			}
		}()
		// One tick at once: the watch keeps the ledger in memory, and a plugin uninstalled within
		// the first interval after setup takes its data dir (and the ledger) with it before a
		// delayed first tick could read it.
		go f.watchTick()
	}
	return port, nil
}

// Status is the front's own report.
func (f *Front) Status() FrontStatus {
	f.mu.Lock()
	defer f.mu.Unlock()
	status := FrontStatus{Mode: "router", Worker: "down", Port: f.listenPort}
	if f.retiredFlag {
		status.Mode = "retired"
	} else if f.now() < f.degradedUntil {
		status.Mode = "degraded"
	}
	if workerReady(f.current) {
		status.Worker = "up"
	} else if f.current != nil || f.replacement != nil {
		status.Worker = "starting"
	}
	if f.current != nil {
		pid := f.current.handle.Pid()
		status.WorkerPid = &pid
	}
	return status
}

// Close stops everything at once (tests and shutdown): listeners, timers, workers.
func (f *Front) Close() {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return
	}
	f.closed = true
	f.accepting = false
	supervise, watchTicker, retiredTicker, degradeTimer := f.supervise, f.watchTicker, f.retiredTicker, f.degradeTimer
	f.supervise, f.watchTicker, f.retiredTicker, f.degradeTimer = nil, nil, nil, nil
	listeners := f.listeners
	f.listeners = nil
	workers := f.allWorkersLocked()
	f.mu.Unlock()
	if supervise != nil {
		supervise.Stop()
	}
	if watchTicker != nil {
		watchTicker.Stop()
	}
	if retiredTicker != nil {
		retiredTicker.Stop()
	}
	if degradeTimer != nil {
		degradeTimer.Stop()
	}
	for _, each := range listeners {
		_ = each.listener.Close()
		_ = each.server.Close()
	}
	f.connections.CloseAll()
	for _, worker := range workers {
		if worker != nil {
			worker.handle.Kill("SIGTERM")
		}
	}
	f.wakeWaiters()
}

// EndWorkers ends any worker still alive and waits, up to wait, for every worker's exit: the
// uninstall cleanup that follows removes the router directory, and a forked worker holds the
// router log the directory carries (its inherited stderr) until the process is gone. Workers
// were drained at retirement, so one still alive is overstaying its drain and is killed. The
// answer is whether all are gone.
func (f *Front) EndWorkers(wait time.Duration) bool {
	f.mu.Lock()
	workers := f.allWorkersLocked()
	alive := make([]*workerState, 0, len(workers))
	for _, worker := range workers {
		if worker != nil && !worker.exited {
			alive = append(alive, worker)
		}
	}
	f.mu.Unlock()
	// Killed off the lock: a handle may deliver its exit on this same goroutine's stack, and that
	// path takes the lock (onExitWorker).
	for _, worker := range alive {
		worker.handle.Kill("SIGKILL")
	}
	deadline := time.Now().Add(wait)
	for {
		f.mu.Lock()
		left := 0
		for _, worker := range workers {
			if worker != nil && !worker.exited {
				left++
			}
		}
		f.mu.Unlock()
		if left == 0 {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Drain stops accepting (the port is free for a new front), finishes what is in flight, then Done.
func (f *Front) Drain() {
	f.mu.Lock()
	if !f.accepting {
		f.mu.Unlock()
		return
	}
	f.accepting = false
	listeners := f.listeners
	f.listeners = nil
	drainMs := f.knobs.DrainMs
	markExit := f.options.MarkExit
	f.mu.Unlock()
	// The logged-exit marker precedes the port's release (see MarkExit).
	if markExit != nil {
		markExit()
	}
	for _, each := range listeners {
		// The listener closes at once (a new front may bind); the answers still going out finish.
		_ = each.listener.Close()
		go func(l *frontListener) { _ = l.server.Shutdown(context.Background()) }(each)
	}
	f.connections.Drain()
	// The worker keeps serving the connections still open; it is stopped once the last of them
	// closes.
	if f.connections.Size() == 0 {
		f.finish()
	}
	time.AfterFunc(time.Duration(drainMs)*time.Millisecond, f.finish)
}

// Retire retires the front (see the header); why goes to the router log and the one spool event.
// Idempotent.
func (f *Front) Retire(why string) {
	f.mu.Lock()
	if f.retiredFlag || f.closed {
		f.mu.Unlock()
		return
	}
	f.reportLocked(domain.HealthRestart,
		fmt.Sprintf("retired: %s; Claude requests pass through until the sessions that use it close", why), "")
	f.retiredFlag = true
	f.retiredAt = f.now()
	f.note(fmt.Sprintf("retired: %s; serving Claude requests until the sessions from before have closed", why))
	if f.degradeTimer != nil {
		f.degradeTimer.Stop()
		f.degradeTimer = nil
	}
	f.degradedUntil = 0
	// The current worker and any replacement drain; none is forked again.
	workers := []*workerState{f.current, f.replacement}
	f.current = nil
	f.replacement = nil
	f.mu.Unlock()
	for _, worker := range workers {
		if worker != nil && !worker.exited {
			f.drainWorker(worker)
		}
	}
	f.wakeWaiters()
	f.announceRetired()
	if f.options.RetiredWatch == nil {
		return
	}
	ticker := time.NewTicker(time.Duration(f.options.RetiredWatch.EveryMs) * time.Millisecond)
	f.mu.Lock()
	f.retiredTicker = ticker
	f.mu.Unlock()
	go func() {
		for range ticker.C {
			f.retiredTick()
		}
	}()
}

// ── the server ─────────────────────────────────────────────────────────────────────────────────────────────────────

// listen binds one port and serves the front on it.
func (f *Front) listen(port int) error {
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return err
	}
	server := Harden(&http.Server{Handler: http.HandlerFunc(f.handle)})
	f.connections.Watch(server)
	f.mu.Lock()
	f.listeners = append(f.listeners, &frontListener{server: server, listener: listener})
	f.mu.Unlock()
	go func() { _ = server.Serve(listener) }()
	return nil
}

func (f *Front) handle(w http.ResponseWriter, req *http.Request) {
	res := NewResponse(w)
	f.mu.Lock()
	listenPort := f.listenPort
	accepting := f.accepting
	f.mu.Unlock()
	if RefuseHost(req, res, f.options.Name, []int{f.options.Port, listenPort}) {
		return
	}
	if !accepting {
		res.Header().Set("Connection", "close")
	}
	path := req.RequestURI
	if req.Method == http.MethodGet && path == f.options.HealthPath {
		f.health(res)
		return
	}
	if strings.HasPrefix(path, f.options.HealthPath+"/") {
		f.control(req, res, path[len(f.options.HealthPath)+1:])
		return
	}
	Receive(req, res, f.options.Name, f.knobs.BodyLimit, func(body []byte) {
		f.route(req, res, body, false)
	})
}

func (f *Front) health(res *Response) {
	status := f.Status()
	f.mu.Lock()
	version := f.version
	frontVersion := f.frontVersion
	var retiredAt *string
	if f.retiredFlag {
		iso := time.UnixMilli(f.retiredAt).UTC().Format("2006-01-02T15:04:05.000Z07:00")
		retiredAt = &iso
	}
	f.mu.Unlock()
	jsonAnswer(res, 200, struct {
		OK           bool    `json:"ok"`
		Name         string  `json:"name"`
		Provider     string  `json:"provider"`
		Mode         string  `json:"mode"`
		Worker       string  `json:"worker"`
		Version      string  `json:"version"`
		FrontVersion int     `json:"frontVersion"`
		Pid          int     `json:"pid"`
		RetiredAt    *string `json:"retiredAt,omitempty"`
		WorkerPid    *int    `json:"workerPid,omitempty"`
	}{
		OK:           true,
		Name:         f.options.Name,
		Provider:     f.options.Display,
		Mode:         status.Mode,
		Worker:       status.Worker,
		Version:      version,
		FrontVersion: frontVersion,
		Pid:          os.Getpid(),
		RetiredAt:    retiredAt,
		WorkerPid:    status.WorkerPid,
	})
}

// ── control: loopback and the pid file's token only ─────────────────────────────────────────────────────────────────

func (f *Front) control(req *http.Request, res *Response, action string) {
	if !loopbackRequest(req) || req.Header.Get(TokenHeader) != f.options.Token {
		AnthropicError(res, 403, "permission_error", f.options.Name+" router: control refused")
		return
	}
	text := ""
	if body, err := ReadBody(req, 64*1024); err == nil {
		text = string(body)
	}
	message := parseControlMessage(text)
	switch fmt.Sprintf("%s %s", req.Method, action) {
	case "POST reload":
		f.reload(res, message)
	case "POST handover":
		f.handoverNow(res)
	case "POST retire":
		f.mu.Lock()
		already := f.retiredFlag
		f.mu.Unlock()
		f.Retire("the plugin was removed (setup --remove)")
		f.mu.Lock()
		at := f.retiredAt
		f.mu.Unlock()
		if at == 0 {
			at = f.now()
		}
		iso := time.UnixMilli(at).UTC().Format("2006-01-02T15:04:05.000Z07:00")
		jsonAnswer(res, 200, struct {
			OK        bool   `json:"ok"`
			Already   bool   `json:"already"`
			RetiredAt string `json:"retiredAt"`
		}{OK: true, Already: already, RetiredAt: iso})
	case "POST adopt":
		adopted := f.adopt()
		status := 200
		if !adopted {
			status = 500
		}
		f.mu.Lock()
		port := f.listenPort
		f.mu.Unlock()
		jsonAnswer(res, status, struct {
			OK   bool `json:"ok"`
			Port int  `json:"port"`
		}{OK: adopted, Port: port})
	case "GET key":
		jsonAnswer(res, 200, json.RawMessage(f.keyCheck()))
	default:
		AnthropicError(res, 404, "not_found_error", f.options.Name+" router: unknown control call")
	}
}

// reload is a hot update: the next worker runs the new binary; the port never closes.
func (f *Front) reload(res *Response, message *jsonNode) {
	f.mu.Lock()
	if node := message.get("exec"); node != nil && node.kind == jsonString && node.str != "" {
		f.execPath = node.str
	}
	if node := message.get("version"); node != nil && node.kind == jsonString {
		f.version = node.str
	}
	f.mu.Unlock()
	f.recycle("hot update")
	jsonAnswer(res, 200, struct {
		OK bool `json:"ok"`
	}{OK: true})
}

func (f *Front) handoverNow(res *Response) {
	res.Header().Set("Connection", "close")
	jsonAnswer(res, 200, struct {
		OK bool `json:"ok"`
	}{OK: true})
	f.note("handover: stopped accepting; a new front takes the port")
	f.Drain()
}

// parseControlMessage is a control call's body as an object, or an empty one.
func parseControlMessage(text string) *jsonNode {
	message := parseBodyNode([]byte(text))
	if !message.isObject() {
		return &jsonNode{kind: jsonObject, fields: map[string]*jsonNode{}}
	}
	return message
}

// keyCheck asks the worker whether it can read the provider's key (only the source comes back,
// never the key).
func (f *Front) keyCheck() []byte {
	f.mu.Lock()
	ready := workerReady(f.current)
	worker := f.current
	f.mu.Unlock()
	if !ready {
		return []byte(`{"ok":false,"error":"` + NoWorker + `"}`)
	}
	f.mu.Lock()
	f.seq++
	id := fmt.Sprintf("k%d", f.seq)
	f.mu.Unlock()
	answer := make(chan []byte, 1)
	f.mu.Lock()
	f.keyQueries[id] = answer
	f.mu.Unlock()
	worker.handle.Send([]byte(marshalCompact(struct {
		T  string `json:"t"`
		Id string `json:"id"`
	}{T: "key", Id: id})))
	select {
	case got := <-answer:
		return got
	case <-time.After(time.Duration(f.knobs.KeyCheckMs) * time.Millisecond):
		f.mu.Lock()
		delete(f.keyQueries, id)
		f.mu.Unlock()
		return []byte(`{"ok":false,"error":"the key lookup timed out"}`)
	}
}

// adopt is the handover's second half, on the new front: take the canonical port, retrying for up
// to 2 s while the old front lets go of it, then drop the temporary one.
func (f *Front) adopt() bool {
	f.mu.Lock()
	atCanonical := f.listenPort == f.options.Port
	f.mu.Unlock()
	if atCanonical {
		return true
	}
	f.mu.Lock()
	temporaries := append([]*frontListener(nil), f.listeners...)
	f.mu.Unlock()
	for tried := 0; tried < 200; tried++ {
		if err := f.listen(f.options.Port); err == nil {
			f.mu.Lock()
			f.listenPort = f.options.Port
			f.removeListenersLocked(temporaries)
			f.mu.Unlock()
			for _, each := range temporaries {
				_ = each.listener.Close()
				go func(l *frontListener) { _ = l.server.Shutdown(context.Background()) }(each)
			}
			f.note(fmt.Sprintf("took over port %d", f.options.Port))
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

func (f *Front) removeListenersLocked(toRemove []*frontListener) {
	kept := f.listeners[:0]
	for _, each := range f.listeners {
		drop := false
		for _, candidate := range toRemove {
			if candidate == each {
				drop = true
				break
			}
		}
		if !drop {
			kept = append(kept, each)
		}
	}
	f.listeners = kept
}

// ── requests ────────────────────────────────────────────────────────────────────────────────────────────────────────

// peerBound is true of a request that belongs to another plugin's router: a hop another router
// forwarded here, or a model this front's registry names a peer for. Anthropic cannot serve these,
// so the front's own paths must not send them there.
func (f *Front) peerBound(req *http.Request, model string) bool {
	if hopPresent(req) {
		return true
	}
	if model == "" || f.options.Peers == nil {
		return false
	}
	_, ok := f.options.Peers(model)
	return ok
}

// direct serves a request itself, the way the degraded front does; why is the fallback event's
// reason. A peer-bound request gets the honest 503: the front cannot hop, and the model is not
// Anthropic's to serve.
func (f *Front) direct(req *http.Request, res *Response, body []byte, why string) {
	model := RequestModel(body)
	f.mu.Lock()
	f.reportLocked(domain.HealthFallback, why, model)
	f.mu.Unlock()
	if f.peerBound(req, model) {
		var peer *PeerTarget
		if model != "" && f.options.Peers != nil {
			if target, ok := f.options.Peers(model); ok {
				peer = &target
			}
		}
		if f.options.Log != nil {
			f.options.Log(fmt.Sprintf("%s %s model=%s → refused (degraded)", req.Method, requestPath(req), modelOrDash(model)))
		}
		message := DegradedMessage(f.options.Name, f.options.Display, "degraded after repeated crashes")
		if peer != nil {
			message = fmt.Sprintf("the %s plugin's router serves %s; the degraded %s router cannot forward it; run /%s:setup.",
				peer.Name, model, f.options.Name, peer.Name)
		}
		AnthropicError(res, 503, "api_error", message)
		return
	}
	PassThrough(f.passthrough("degraded after repeated crashes"), req, res, body)
}

// serveRetired is a retired front's answer: this provider's models, peers' models and peer hops
// are refused with a 400 that is not retried; everything else goes to Anthropic exactly as it
// came.
func (f *Front) serveRetired(req *http.Request, res *Response, body []byte) {
	model := RequestModel(body)
	if !(f.peerBound(req, model) || domain.Claims(f.options.Claim, model)) {
		PassThrough(f.passthrough("removed"), req, res, body)
		return
	}
	if f.options.Log != nil {
		f.options.Log(fmt.Sprintf("%s %s model=%s → refused (retired)", req.Method, requestPath(req), modelOrDash(model)))
	}
	answer := RemovedAnswer(f.options.Display)
	writeHead(res, answer.Status, answer.Headers)
	res.End([]byte(answer.Body))
}

// route is one request: to the worker, or (retired, degraded, workerless) to the front's own
// paths. The client is watched from the moment the body is here: one that leaves while a worker is
// waited for (or a failed request retried) is answered by nobody, so nothing goes upstream for it.
func (f *Front) route(req *http.Request, res *Response, body []byte, retried bool) {
	gone := WatchClient(req)
	if gone() {
		return
	}
	if f.retired() {
		f.serveRetired(req, res, body)
		return
	}
	if f.degradedNow() {
		f.direct(req, res, body, "degraded after repeated worker exits")
		return
	}
	worker := f.workerWithin(f.knobs.WaitWorkerMs)
	if gone() {
		return
	}
	switch {
	case f.retired():
		f.serveRetired(req, res, body)
	case worker == nil:
		f.direct(req, res, body, "no worker was ready")
	default:
		f.toWorker(worker, req, res, body, retried)
	}
}

// workerWithin is the worker a request goes to within ms: the ready one, nil when the wait runs
// out (or the front is closed or degraded).
func (f *Front) workerWithin(ms int64) *workerState {
	f.mu.Lock()
	if workerReady(f.current) {
		worker := f.current
		f.mu.Unlock()
		return worker
	}
	if f.closed || f.now() < f.degradedUntil {
		f.mu.Unlock()
		return nil
	}
	waiter := &workerWaiter{ch: make(chan *workerState, 1)}
	f.waiters = append(f.waiters, waiter)
	f.mu.Unlock()
	timer := time.AfterFunc(time.Duration(ms)*time.Millisecond, func() {
		f.mu.Lock()
		f.removeWaiterLocked(waiter)
		var worker *workerState
		if workerReady(f.current) {
			worker = f.current
		}
		f.mu.Unlock()
		waiter.resolve(worker)
	})
	defer timer.Stop()
	return <-waiter.ch
}

func (f *Front) removeWaiterLocked(waiter *workerWaiter) {
	kept := f.waiters[:0]
	for _, candidate := range f.waiters {
		if candidate != waiter {
			kept = append(kept, candidate)
		}
	}
	f.waiters = kept
}

func (f *Front) wakeWaiters() {
	f.mu.Lock()
	f.wakeWaitersLocked()
	f.mu.Unlock()
}

func (f *Front) wakeWaitersLocked() {
	var worker *workerState
	if workerReady(f.current) {
		worker = f.current
	}
	waiters := f.waiters
	f.waiters = nil
	for _, waiter := range waiters {
		waiter.resolve(worker)
	}
}

// toWorker hands one request to the worker and pipes its answer back, streaming.
func (f *Front) toWorker(worker *workerState, req *http.Request, res *Response, body []byte, retried bool) {
	f.mu.Lock()
	f.seq++
	id := fmt.Sprintf("r%d", f.seq)
	pending := &pendingRequest{}
	worker.inflight[id] = pending
	port := worker.port
	f.mu.Unlock()
	target := &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(port))}
	headers := ForwardHeaders(req.Header, target, len(body))
	headers.Set(RequestID, id)
	// The worker refuses its data path without it; the worker strips it again before anything goes
	// upstream.
	headers.Set(TokenHeader, f.options.Token)
	// The body's own length is the request's; a copied Content-Length header would fight it.
	headers.Del("Content-Length")
	call, err := http.NewRequestWithContext(req.Context(), req.Method, target.String()+req.RequestURI, bytes.NewReader(body))
	if err != nil {
		AnthropicError(res, 400, "invalid_request_error", f.options.Name+" router: bad request path")
		return
	}
	call.Header = headers
	answer, err := workerTransport.RoundTrip(call)
	if err != nil {
		if res.HeadersSent() {
			res.Destroy()
			return
		}
		// Whether the worker had sent it upstream is known once its IPC has drained: at its exit,
		// or soon after.
		f.afterWorkerFate(worker)
		f.mu.Lock()
		delete(worker.inflight, id)
		acked := pending.acked
		f.mu.Unlock()
		if !res.Destroyed() && req.Context().Err() == nil {
			f.afterFailure(req, res, body, acked, retried)
		}
		return
	}
	defer answer.Body.Close()
	f.mu.Lock()
	delete(worker.inflight, id)
	f.mu.Unlock()
	writeHead(res, answer.StatusCode, ResponseHeaders(answer.Header))
	buffer := make([]byte, 32*1024)
	for {
		n, readErr := answer.Body.Read(buffer)
		if n > 0 {
			if _, writeErr := res.Write(buffer[:n]); writeErr != nil {
				// The client went away mid-answer (Esc in Claude Code): stop reading the worker's
				// answer too — nobody waits for it.
				return
			}
		}
		if readErr == io.EOF {
			res.End(nil)
			return
		}
		if readErr != nil {
			// The worker's answer stopped mid-body; the client's answer ends with it.
			res.Destroy()
			return
		}
	}
}

// afterFailure answers a request whose worker failed before answering: retried once when that
// worker never sent it upstream (then served directly if the retry fails too); a 502 when it may
// have reached the upstream.
func (f *Front) afterFailure(req *http.Request, res *Response, body []byte, acked, retried bool) {
	if !acked && !retried {
		f.route(req, res, body, true)
		return
	}
	if !acked {
		f.direct(req, res, body, "the worker failed the request twice")
		return
	}
	AnthropicError(res, 502, "api_error", f.options.Name+" router: the request was cut off by a router restart")
}

// afterWorkerFate waits until the worker's fate is known — its exit, or the ack wait — so a failed
// request learns whether its worker had sent it upstream.
func (f *Front) afterWorkerFate(worker *workerState) {
	f.mu.Lock()
	if worker.exited {
		f.mu.Unlock()
		return
	}
	fate := &workerFate{done: make(chan struct{})}
	worker.onExit = append(worker.onExit, fate.fire)
	f.mu.Unlock()
	time.AfterFunc(time.Duration(f.knobs.AckWaitMs)*time.Millisecond, fate.fire)
	<-fate.done
}

// workerFate fires once, from the worker's exit or the ack wait, whichever comes first.
type workerFate struct {
	once sync.Once
	done chan struct{}
}

func (w *workerFate) fire() {
	w.once.Do(func() { close(w.done) })
}

// ── supervision ─────────────────────────────────────────────────────────────────────────────────────────────────────

// spawnLocked forks one worker of execPath; nil when the front is closed or the fork failed.
// Called with f.mu held: the worker is assigned to its slot before its first IPC message can be
// delivered.
func (f *Front) spawnLocked(execPath string) *workerState {
	if f.closed {
		return nil
	}
	handle, err := f.fork(workerBinary(execPath), f.options.Token)
	if err != nil {
		f.note("worker fork failed: " + err.Error())
		return nil
	}
	worker := &workerState{
		handle:    handle,
		execPath:  execPath,
		startedAt: f.now(),
		lastHb:    f.now(),
		inflight:  map[string]*pendingRequest{},
	}
	handle.OnMessage(func(message []byte) { f.onMessage(worker, message) })
	handle.OnExit(func(code int, signal string) { f.onExitWorker(worker, code, signal) })
	return worker
}

// workerBinary is the binary a worker is forked from: the exec the front was given (the state
// root's copy, re-pointed by a hot update), or this binary itself.
func workerBinary(execPath string) string {
	if execPath == "" {
		if self, err := os.Executable(); err == nil {
			return self
		}
	}
	return execPath
}

func (f *Front) onMessage(worker *workerState, raw []byte) {
	message := parseBodyNode(raw)
	if !message.isObject() {
		return
	}
	kind := ""
	if node := message.get("t"); node != nil && node.kind == jsonString {
		kind = node.str
	}
	ids := ""
	if node := message.get("id"); node != nil && node.kind == jsonString {
		ids = node.str
	}
	switch kind {
	case "listening":
		if node := message.get("port"); node != nil && node.kind == jsonNumber {
			if port, err := node.num.Float64(); err == nil {
				f.listening(worker, int(port))
			}
		}
	case "hb":
		rss, known := 0.0, false
		if node := message.get("rss"); node != nil && node.kind == jsonNumber {
			rss, _ = node.num.Float64()
			known = true
		}
		f.heartbeat(worker, rss, known)
	case "ack":
		f.mu.Lock()
		if pending := worker.inflight[ids]; pending != nil {
			pending.acked = true
		}
		f.mu.Unlock()
	case "key":
		answer := stripWorkerFields(message)
		f.mu.Lock()
		query, waiting := f.keyQueries[ids]
		if waiting {
			delete(f.keyQueries, ids)
		}
		f.mu.Unlock()
		if waiting {
			query <- []byte(marshalNode(answer))
		}
	}
}

// stripWorkerFields is the answer a key query resolves with: the worker's message minus its own
// protocol fields.
func stripWorkerFields(message *jsonNode) *jsonNode {
	out := &jsonNode{kind: jsonObject, fields: map[string]*jsonNode{}}
	for _, key := range message.keys {
		switch key {
		case "t", "id", "port", "rss":
		default:
			out.set(key, message.fields[key])
		}
	}
	return out
}

func (f *Front) listening(worker *workerState, port int) {
	f.mu.Lock()
	worker.port = port
	worker.lastHb = f.now()
	isReplacement := worker == f.replacement
	isCurrent := worker == f.current
	f.mu.Unlock()
	if isReplacement {
		f.promote(worker)
	} else if isCurrent {
		f.wakeWaiters()
	}
}

// heartbeat is proof the worker's event loop runs, with its resident size: a worker past the limit
// is recycled.
func (f *Front) heartbeat(worker *workerState, rss float64, known bool) {
	f.mu.Lock()
	worker.lastHb = f.now()
	if !known || rss <= f.knobs.RssLimitMb || worker != f.current || worker.draining {
		f.mu.Unlock()
		return
	}
	f.mu.Unlock()
	f.recycle(fmt.Sprintf("worker at %d MB, over %v MB", int64(math.Round(rss)), f.knobs.RssLimitMb))
}

func (f *Front) promote(worker *workerState) {
	f.mu.Lock()
	old := f.current
	f.current = worker
	f.replacement = nil
	oldAlive := old != nil && !old.exited
	f.wakeWaitersLocked()
	f.mu.Unlock()
	if oldAlive {
		f.drainWorker(old)
	}
}

func (f *Front) drainWorker(worker *workerState) {
	f.mu.Lock()
	worker.draining = true
	f.drainingWorkers[worker] = true
	drainMs := f.knobs.DrainMs
	f.mu.Unlock()
	worker.handle.Send([]byte(marshalCompact(struct {
		T  string `json:"t"`
		Ms int64  `json:"ms"`
	}{T: "drain", Ms: drainMs})))
	time.AfterFunc(time.Duration(drainMs+5000)*time.Millisecond, func() {
		f.mu.Lock()
		exited := worker.exited
		f.mu.Unlock()
		if !exited {
			worker.handle.Kill("SIGKILL")
		}
	})
}

func (f *Front) onExitWorker(worker *workerState, code int, signal string) {
	f.mu.Lock()
	worker.exited = true
	for _, then := range worker.onExit {
		then()
	}
	worker.onExit = nil
	delete(f.drainingWorkers, worker)
	how := signal
	if how == "" {
		how = fmt.Sprintf("code %d", code)
	}
	switch {
	case worker == f.replacement:
		f.replacement = nil
		f.note(fmt.Sprintf("the new worker exited before it listened (%s); the running one stays", how))
	case worker != f.current:
		f.note(fmt.Sprintf("a draining worker exited (%s)", how))
	default:
		f.current = nil
		if !f.closed {
			f.replaceExitedLocked(worker, how)
		}
	}
	f.mu.Unlock()
}

// replaceExitedLocked is the current worker's exit: degrade when it never started or exits keep
// coming, else fork a replacement. Called with f.mu held.
func (f *Front) replaceExitedLocked(worker *workerState, how string) {
	if worker.port == 0 {
		f.reportLocked(domain.HealthRestart, fmt.Sprintf("a worker failed to start (%s); degraded", how), "")
		f.degradeLocked(fmt.Sprintf("a worker failed to start (%s)", how))
		return
	}
	now := f.now()
	fresh := make([]int64, 0, len(f.exits)+1)
	for _, at := range f.exits {
		if now-at < f.knobs.ExitWindowMs {
			fresh = append(fresh, at)
		}
	}
	f.exits = append(fresh, now)
	if len(f.exits) >= f.knobs.DegradeExits {
		f.reportLocked(domain.HealthRestart, fmt.Sprintf("worker exited (%s); degraded after %d exits", how, len(f.exits)), "")
		f.degradeLocked(fmt.Sprintf("%d worker exits within %g s", len(f.exits), float64(f.knobs.ExitWindowMs)/1000))
		return
	}
	f.reportLocked(domain.HealthRestart, fmt.Sprintf("worker exited (%s)", how), "")
	f.note(fmt.Sprintf("worker exited (%s); forking a replacement", how))
	f.current = f.spawnLocked(worker.execPath)
}

// degradeLocked serves requests itself for DegradedMs, then tries one worker again. Called with
// f.mu held.
func (f *Front) degradeLocked(why string) {
	f.degradedUntil = f.now() + f.knobs.DegradedMs
	f.exits = nil
	f.note(fmt.Sprintf("degraded: %s; the front serves requests itself for %g s", why, float64(f.knobs.DegradedMs)/1000))
	f.wakeWaitersLocked()
	if f.degradeTimer != nil {
		f.degradeTimer.Stop()
	}
	f.degradeTimer = time.AfterFunc(time.Duration(f.knobs.DegradedMs)*time.Millisecond, func() {
		f.mu.Lock()
		if f.closed || f.current != nil || f.retiredFlag {
			f.mu.Unlock()
			return
		}
		f.note("degraded window over: trying one worker again")
		f.current = f.spawnLocked(f.execPath)
		f.mu.Unlock()
	})
}

func (f *Front) recycle(why string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed || f.replacement != nil || f.retiredFlag {
		return
	}
	f.note(fmt.Sprintf("%s: forking a new worker, then draining the old one", why))
	if f.current == nil {
		f.degradedUntil = 0
		f.current = f.spawnLocked(f.execPath)
		return
	}
	f.replacement = f.spawnLocked(f.execPath)
}

func (f *Front) check() {
	f.mu.Lock()
	workers := f.allWorkersLocked()
	var kill []*workerState
	for _, worker := range workers {
		if worker == nil || worker.exited {
			continue
		}
		if why := f.stuckLocked(worker); why != "" {
			f.note(fmt.Sprintf("%s; killing it", why))
			kill = append(kill, worker)
		}
	}
	f.mu.Unlock()
	for _, worker := range kill {
		worker.handle.Kill("SIGKILL")
	}
}

// stuckLocked is why a worker must go: it never listened, or its heartbeat stopped (a blocked
// event loop); "" when well. A draining worker is exempt from the heartbeat check: it stopped
// heartbeating on purpose the moment its drain began (while its streams are still going), so the
// hang check would read that as a hang and cut live answers mid-response. Only the drain limit —
// the kill timer drainWorker arms at DrainMs — ends a draining worker; an active worker that stops
// heartbeating is killed. Called with f.mu held.
func (f *Front) stuckLocked(worker *workerState) string {
	if worker.port == 0 {
		if f.now()-worker.startedAt > f.knobs.StartMs {
			return fmt.Sprintf("a worker did not listen within %g s", float64(f.knobs.StartMs)/1000)
		}
		return ""
	}
	if worker.draining {
		return ""
	}
	if silent := f.now() - worker.lastHb; silent > f.knobs.HangMs {
		return fmt.Sprintf("a worker sent no heartbeat for %d ms (hung)", silent)
	}
	return ""
}

func (f *Front) allWorkersLocked() []*workerState {
	workers := []*workerState{f.current, f.replacement}
	for worker := range f.drainingWorkers {
		workers = append(workers, worker)
	}
	return workers
}

// ── the uninstall watch and retirement ──────────────────────────────────────────────────────────────────────────────

func (f *Front) watchTick() {
	f.mu.Lock()
	if f.watching || f.closed || f.retiredFlag || f.options.Watch == nil {
		f.mu.Unlock()
		return
	}
	f.watching = true
	f.mu.Unlock()
	say, err := f.options.Watch.Tick()
	if err != nil {
		f.note("uninstall watch failed: " + err.Error())
	} else if say == "retire" {
		f.Retire("the plugin was uninstalled or disabled")
	}
	f.mu.Lock()
	f.watching = false
	f.mu.Unlock()
}

func (f *Front) announceRetired() {
	if f.options.OnRetire == nil {
		return
	}
	defer func() {
		if reason := recover(); reason != nil {
			f.note(fmt.Sprintf("retire hook failed: %v", reason))
		}
	}()
	f.options.OnRetire()
}

func (f *Front) retiredTick() {
	f.mu.Lock()
	if f.checkingRetired || f.closed || !f.accepting || !f.retiredFlag || f.options.RetiredWatch == nil {
		f.mu.Unlock()
		return
	}
	f.checkingRetired = true
	retiredAt := f.retiredAt
	f.mu.Unlock()
	done := func() {
		f.mu.Lock()
		f.checkingRetired = false
		f.mu.Unlock()
	}
	exit, err := f.options.RetiredWatch.Exit(retiredAt)
	if err != nil {
		done()
		f.note("retired exit check failed: " + err.Error())
		return
	}
	if !exit {
		done()
		return
	}
	f.note("retired: no Claude Code session from before the retirement is left, or the 7-day cap passed; exiting")
	if f.options.Watch != nil && f.options.Watch.Cleanup != nil {
		if err := f.options.Watch.Cleanup(); err != nil {
			done()
			f.note("retired exit check failed: " + err.Error())
			return
		}
	}
	done()
	f.Drain()
}

// ── shutdown ────────────────────────────────────────────────────────────────────────────────────────────────────────

func (f *Front) finish() {
	f.mu.Lock()
	if f.finished {
		f.mu.Unlock()
		return
	}
	f.finished = true
	f.mu.Unlock()
	f.Close()
	if f.options.Done != nil {
		f.options.Done()
	}
}

func (f *Front) retired() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.retiredFlag
}

func (f *Front) degradedNow() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now() < f.degradedUntil
}

// reportLocked writes one health event while the front is not retired: a retired front writes
// nothing more to the spool (the plugin is gone from the dashboard's point of view). Called with
// f.mu held.
func (f *Front) reportLocked(event domain.RouterHealth, reason, model string) {
	if f.retiredFlag || f.options.Events == nil {
		return
	}
	f.options.Events(domain.HealthEvent(f.options.Name, event, reason, model, f.now()))
}

func (f *Front) passthrough(state string) PassthroughOptions {
	return PassthroughOptions{
		Name:      f.options.Name,
		Display:   f.options.Display,
		Claim:     f.options.Claim,
		Anthropic: f.options.Anthropic,
		Env:       f.options.Env,
		State:     state,
		IdleMs:    f.options.IdleMs,
		Log:       f.options.Log,
	}
}

// jsonAnswer writes one JSON answer.
func jsonAnswer(res *Response, status int, value any) {
	res.Header().Set("Content-Type", "application/json")
	res.WriteHeader(status)
	res.End([]byte(marshalCompact(value)))
}

// loopbackRequest is true when the call came from this machine over loopback.
func loopbackRequest(req *http.Request) bool {
	host, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		host = req.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// ── the fork ────────────────────────────────────────────────────────────────────────────────────────────────────────

// execFork is the production fork: the worker is this binary re-executed in its worker mode
// (`plugin-core <name> router worker`), the front's token in its environment. The worker is the
// same program run again, and the fork's IPC is JSON lines on the child's stdin and stdout.
func execFork(name string) ForkWorker {
	return func(execPath string, token string) (WorkerHandle, error) {
		command := exec.Command(execPath, name, "router", "worker")
		command.Env = append(os.Environ(), WorkerTokenEnv+"="+token)
		stdin, stdinErr := command.StdinPipe()
		stdout, stdoutErr := command.StdoutPipe()
		command.Stderr = os.Stderr
		// Every way a fork can fail is one answer: no worker.
		if err := errors.Join(stdinErr, stdoutErr, command.Start()); err != nil {
			return nil, err
		}
		handle := newExecHandle(command.Process, stdin)
		go handle.readMessages(stdout)
		go handle.awaitExit(command)
		return handle, nil
	}
}

// workerEvent is one report from a forked worker: a message line, or its end.
type workerEvent struct {
	message []byte
	exit    bool
	code    int
	signal  string
}

// execHandle is a forked worker process: JSON lines to its stdin, its messages from its stdout,
// its exit from the process. The reader and the exit path only append events to a queue; one pump
// goroutine hands them to the registered listeners in arrival order (the exit therefore lands
// after every message that arrived before it), never on the goroutine that registers a listener.
// Built only by newExecHandle, which starts its delivery pump.
type execHandle struct {
	pid     int
	process *os.Process
	stdin   io.WriteCloser

	mu              sync.Mutex
	stdinClosed     bool
	messageListener func([]byte)
	exitListener    func(int, string)
	events          []workerEvent
	kick            chan struct{}
}

// newExecHandle builds the handle for one forked worker and starts its delivery pump.
func newExecHandle(process *os.Process, stdin io.WriteCloser) *execHandle {
	pid := 0
	if process != nil {
		pid = process.Pid
	}
	h := &execHandle{process: process, stdin: stdin, pid: pid, kick: make(chan struct{}, 1)}
	go h.deliverLoop()
	return h
}

func (h *execHandle) Pid() int { return h.pid }

func (h *execHandle) OnMessage(listener func([]byte)) {
	h.mu.Lock()
	h.messageListener = listener
	h.mu.Unlock()
	h.wake()
}

func (h *execHandle) OnExit(listener func(int, string)) {
	h.mu.Lock()
	h.exitListener = listener
	h.mu.Unlock()
	h.wake()
}

// deliver appends one message from the worker's stdout. The bytes are the scanner's buffer, so
// they are copied: they wait in the queue until the pump picks them up.
func (h *execHandle) deliver(message []byte) {
	h.enqueue(workerEvent{message: append([]byte(nil), message...)})
}

// recordExit appends the worker's end, delivered once its listener is registered.
func (h *execHandle) recordExit(code int, signal string) {
	h.enqueue(workerEvent{exit: true, code: code, signal: signal})
}

func (h *execHandle) enqueue(event workerEvent) {
	h.mu.Lock()
	h.events = append(h.events, event)
	h.mu.Unlock()
	h.wake()
}

// deliverLoop hands the queued reports to the registered listeners one at a time and in arrival
// order, waiting while the head report's listener is not registered yet. It ends once the exit was
// delivered.
func (h *execHandle) deliverLoop() {
	for {
		h.mu.Lock()
		var next workerEvent
		var messageListener func([]byte)
		var exitListener func(int, string)
		if len(h.events) > 0 {
			head := h.events[0]
			if !head.exit && h.messageListener != nil {
				next, messageListener = head, h.messageListener
				h.events = h.events[1:]
			} else if head.exit && h.exitListener != nil {
				next, exitListener = head, h.exitListener
				h.events = h.events[1:]
			}
		}
		h.mu.Unlock()
		switch {
		case messageListener != nil:
			messageListener(next.message)
		case exitListener != nil:
			exitListener(next.code, next.signal)
			return
		default:
			<-h.kick
		}
	}
}

// wake nudges the delivery pump.
func (h *execHandle) wake() {
	select {
	case h.kick <- struct{}{}:
	default:
	}
}

// readMessages is the child's stdout: one JSON message per line. A line that is not the front's
// protocol is ignored by the message handler.
func (h *execHandle) readMessages(stdout io.ReadCloser) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		h.deliver(scanner.Bytes())
	}
}

// awaitExit reports the child's exit once, after its stdout has ended.
func (h *execHandle) awaitExit(command *exec.Cmd) {
	err := command.Wait()
	code, signal := exitOf(err)
	h.mu.Lock()
	h.stdinClosed = true
	h.mu.Unlock()
	_ = h.stdin.Close()
	h.recordExit(code, signal)
}

func (h *execHandle) Send(message []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.stdinClosed {
		// The worker is gone; its exit is the front's business, not this send's.
		return
	}
	if _, err := h.stdin.Write(append(append([]byte(nil), message...), '\n')); err != nil {
		h.stdinClosed = true
	}
}

func (h *execHandle) Kill(signal string) {
	killProcess(h.process, signal)
}
