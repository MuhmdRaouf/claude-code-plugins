// Focused tests for the front's exported functions: the front's own behaviour with an in-process
// fake worker over loopback (every case where the worker dies, restarts, is replaced or is slow,
// and claude-* traffic keeps flowing), plus the real fork — this binary re-executed in child
// mode — driving a real router child.
package router

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

const focusHealth = "/acme-router/health"
const focusToken = "front-token"

// focusChildEnv turns this test binary into the front's worker child; the focusChild* variables
// carry its configuration.
const focusChildEnv = "FRONT_FOCUS_CHILD"

func TestMain(m *testing.M) {
	switch os.Getenv(focusChildEnv) {
	case "worker":
		runFocusChildWorker()
	case "hang":
		for {
			time.Sleep(time.Hour)
		}
	case "session-hang":
		// The fake session a watchdog test watches (watch_test.go): it ends by itself within
		// the backstop window, so one a failed test leaks cannot outlive the suite.
		time.Sleep(60 * time.Second)
		os.Exit(0)
	case "code":
		os.Exit(3)
	case "front":
		// The process card's real router process: a front started by the starter (front_test.go).
		runProcessChildFront()
	case "retired":
		// The process card's real retired router (process_test.go).
		runProcessRetiredChild()
	case "service":
		// The service card's real router service: the front the starter spawns and the worker it
		// forks (uninstall_test.go).
		runServiceChild()
	case "hold-port":
		// The watch card's silent holder (watch_test.go): binds the port it is told and never
		// answers, the shape of a hung front or a foreign holder.
		runHoldPortChild()
	case chaosChildMode:
		// The chaos suite's router child (chaos_child_test.go).
		runChaosServiceChild()
	case "chaos-session":
		// The chaos suite's stand-in for an open Claude Code session (chaos_test.go): a process
		// named claude the retired router waits for, gone when the test kills it or 120 s pass.
		time.Sleep(120 * time.Second)
	}
	if os.Getenv(installedFrontChildEnv) == installedFrontChildMode {
		// The upgrade group's protocol-2 front child (upgrade_front_test.go), keyed by its own
		// env name so only its own spawn lands in the mode.
		runInstalledFrontChild()
	}
	if os.Getenv(powerLossChildEnv) == powerLossChildMode {
		// The power-loss group's service child (power_loss_test.go), keyed by its own env name
		// so the start child's spawns keep it through ChildEnv's filter.
		runPowerLossServiceChild()
	}
	if os.Getenv(exitLogChildEnv) == exitLogChildMode {
		// The exit-log group's child (exitlog_test.go), keyed the same way.
		runExitLogChild()
	}
	os.Exit(m.Run())
}

// waitUntil polls check every 10 ms until it holds, failing the test at the deadline.
func waitUntil(t *testing.T, ms time.Duration, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(ms)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for the front", ms)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// focusNotes is the front's note lines, written from any goroutine.
type focusNotes struct {
	mu    sync.Mutex
	lines []string
}

func (n *focusNotes) add(line string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.lines = append(n.lines, line)
}

func (n *focusNotes) joined() string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return strings.Join(n.lines, "\n")
}

// focusAnthropic is the fake Anthropic behind the front's own passthrough, counting what it was
// handed.
func focusAnthropic(t *testing.T) (*url.URL, *atomic.Int32) {
	t.Helper()
	var got atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = w.Write([]byte("from anthropic"))
	}))
	t.Cleanup(server.Close)
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return parsed, &got
}

// focusBehaviour is how one fake worker answers.
type focusBehaviour string

const (
	focusOK           focusBehaviour = "ok"
	focusCut          focusBehaviour = "cut"
	focusCutAfterAck  focusBehaviour = "cut-after-ack"
	focusAbortMidBody focusBehaviour = "abort-mid-body"
	focusHang         focusBehaviour = "hang"
	focusStream       focusBehaviour = "stream"
	focusLinger       focusBehaviour = "linger"
)

var focusNextPid atomic.Int64

// focusWorker is an in-process worker: an HTTP server on a loopback port, talking to the front
// through callbacks the way the IPC channel does. One pump goroutine delivers its messages and its
// exit in arrival order, never on a caller's own stack: the front registers its listeners while
// holding its lock (spawnLocked), and an event that arrived before that registration must not call
// back into that lock on the registrant's goroutine — that self-deadlocks the front for good.
type focusWorker struct {
	pid        int
	execPath   string
	behaviour  focusBehaviour
	listenUp   bool
	answerKey  bool
	beats      bool
	exitedFlag bool

	mu              sync.Mutex
	sent            [][]byte
	received        []http.Header
	servedCount     int
	messageListener func([]byte)
	queuedMessages  [][]byte
	exitListener    func(int, string)
	exitDelivered   bool
	exitReady       bool
	exitCode        int
	exitSignal      string
	listener        net.Listener
	server          *http.Server
	heartbeats      *time.Ticker
	heartbeatsGone  bool
	kick            chan struct{}
}

func newFocusWorker(execPath string, behaviour focusBehaviour, listenUp, answerKey, beats bool) *focusWorker {
	w := &focusWorker{
		pid:       70000 + int(focusNextPid.Add(1)),
		execPath:  execPath,
		behaviour: behaviour,
		listenUp:  listenUp,
		answerKey: answerKey,
		beats:     beats,
		kick:      make(chan struct{}, 1),
	}
	go w.deliverLoop()
	return w
}

func (w *focusWorker) Pid() int { return w.pid }

func (w *focusWorker) OnMessage(listener func([]byte)) {
	w.mu.Lock()
	w.messageListener = listener
	w.mu.Unlock()
	w.wake()
}

func (w *focusWorker) OnExit(listener func(int, string)) {
	w.mu.Lock()
	w.exitListener = listener
	w.mu.Unlock()
	w.wake()
}

// message is the worker's side of the IPC channel.
func (w *focusWorker) message(value []byte) {
	w.mu.Lock()
	w.queuedMessages = append(w.queuedMessages, value)
	w.mu.Unlock()
	w.wake()
}

// deliverLoop hands the queued messages, then the exit, to the registered listeners, one at a time
// and off every caller's stack (see the focusWorker comment). It ends once the exit was delivered.
func (w *focusWorker) deliverLoop() {
	for {
		w.mu.Lock()
		var next []byte
		listener := w.messageListener
		if listener != nil && len(w.queuedMessages) > 0 {
			next = w.queuedMessages[0]
			w.queuedMessages = w.queuedMessages[1:]
		}
		var exitListener func(int, string)
		if next == nil && w.exitReady && !w.exitDelivered && w.exitListener != nil {
			exitListener = w.exitListener
			w.exitDelivered = true
		}
		code, signal := w.exitCode, w.exitSignal
		w.mu.Unlock()
		switch {
		case next != nil:
			listener(next)
		case exitListener != nil:
			exitListener(code, signal)
			return
		default:
			<-w.kick
		}
	}
}

// wake nudges the delivery pump.
func (w *focusWorker) wake() {
	select {
	case w.kick <- struct{}{}:
	default:
	}
}

func (w *focusWorker) boot() {
	if !w.listenUp {
		return
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return
	}
	w.mu.Lock()
	w.listener = listener
	w.server = &http.Server{Handler: http.HandlerFunc(w.serve)}
	w.mu.Unlock()
	go w.server.Serve(listener)
	port := listener.Addr().(*net.TCPAddr).Port
	w.message([]byte(`{"t":"listening","port":` + strconv.Itoa(port) + `}`))
	if w.beats {
		ticker := time.NewTicker(20 * time.Millisecond)
		w.mu.Lock()
		w.heartbeats = ticker
		w.mu.Unlock()
		go func() {
			for range ticker.C {
				w.message([]byte(`{"t":"hb","rss":50}`))
			}
		}()
	}
}

// serve answers one request the way the behaviour says, on a hijacked connection.
func (w *focusWorker) serve(rw http.ResponseWriter, r *http.Request) {
	_, _ = io.Copy(io.Discard, r.Body)
	w.mu.Lock()
	w.received = append(w.received, r.Header.Clone())
	w.servedCount++
	behaviour := w.behaviour
	w.mu.Unlock()
	hijacker, ok := rw.(http.Hijacker)
	if !ok {
		return
	}
	conn, _, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	id := r.Header.Get(RequestID)
	switch behaviour {
	case focusCut:
		// The socket dies before anything is said: no ack, no answer.
		return
	case focusHang:
		// Never answer; the read ends when the front gives up on the call.
		_, _ = io.Copy(io.Discard, conn)
		return
	}
	w.message([]byte(`{"t":"ack","id":` + strconv.Quote(id) + `}`))
	switch behaviour {
	case focusCutAfterAck:
		return
	case focusAbortMidBody:
		_, _ = conn.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial"))
		time.Sleep(20 * time.Millisecond)
		return
	case focusStream:
		// An answer that takes a while: the drain lands in its middle.
		_, _ = conn.Write([]byte("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: keep-alive\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nhalf\r\n"))
		time.Sleep(300 * time.Millisecond)
		_, _ = conn.Write([]byte("9\r\n and done\r\n0\r\n\r\n"))
		// The stream was this worker's last work: a draining one exits now, like the real worker.
		w.mu.Lock()
		draining := w.heartbeatsGone
		w.mu.Unlock()
		if draining {
			go w.stop("")
		}
		return
	default:
		answer := fmt.Sprintf("worker %d", w.pid)
		_, _ = fmt.Fprintf(conn, "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: keep-alive\r\nContent-Length: %d\r\n\r\n%s", len(answer), answer)
	}
}

func (w *focusWorker) Send(message []byte) {
	w.mu.Lock()
	w.sent = append(w.sent, append([]byte(nil), message...))
	answerKey := w.answerKey
	behaviour := w.behaviour
	w.mu.Unlock()
	var parsed struct {
		T  string `json:"t"`
		Id string `json:"id"`
	}
	_ = json.Unmarshal(message, &parsed)
	switch parsed.T {
	case "key":
		if answerKey {
			w.message([]byte(`{"t":"key","id":` + strconv.Quote(parsed.Id) + `,"ok":true,"source":"ACME_KEY"}`))
		}
	case "drain":
		// The real worker stops heartbeating the moment its drain begins, while its streams still go.
		w.mu.Lock()
		if w.heartbeats != nil {
			w.heartbeats.Stop()
			w.heartbeats = nil
		}
		w.heartbeatsGone = true
		w.mu.Unlock()
		if behaviour != focusStream && behaviour != focusLinger {
			go w.stop("")
		}
	}
}

func (w *focusWorker) Kill(signal string) {
	go w.stop(signal)
}

func (w *focusWorker) stop(signal string) {
	w.mu.Lock()
	if w.exitedFlag {
		w.mu.Unlock()
		return
	}
	w.exitedFlag = true
	code, exitSignal := 0, ""
	if signal != "" {
		code, exitSignal = -1, signal
	}
	w.exitCode, w.exitSignal = code, exitSignal
	listener, server := w.listener, w.server
	if w.heartbeats != nil {
		w.heartbeats.Stop()
		w.heartbeats = nil
	}
	w.mu.Unlock()
	if listener != nil {
		_ = listener.Close()
	}
	if server != nil {
		_ = server.Close()
	}
	time.Sleep(5 * time.Millisecond)
	// The exit is the pump's to deliver, after anything it still holds.
	w.mu.Lock()
	w.exitReady = true
	w.mu.Unlock()
	w.wake()
}

func (w *focusWorker) hasExited() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.exitedFlag
}

func (w *focusWorker) sentLines() [][]byte {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([][]byte(nil), w.sent...)
}

func (w *focusWorker) receivedHeaders() []http.Header {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]http.Header(nil), w.received...)
}

func (w *focusWorker) servedTotal() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.servedCount
}

// focusSetup is what a test changes about the rig. AnswerKey nil is
// true; RealFork hands the front no fork of its own, so it re-executes the binary.
type focusSetup struct {
	knobs        FrontKnobs
	behaviours   []focusBehaviour
	listen       func(index int) bool
	answerKey    *bool
	forkThrows   bool
	heartbeats   bool
	realFork     bool
	peers        func(model string) (PeerTarget, bool)
	events       func(event domain.SpoolEvent)
	watch        *FrontWatch
	retiredWatch *RetiredWatch
	onRetire     func()
	port         int
	listenPort   int
	fork         ForkWorker
	exec         string
	log          func(line string)
}

// focusRig is a started front with its fake workers, notes and fake Anthropic.
type focusRig struct {
	t         *testing.T
	front     *Front
	port      int
	canonical int
	options   FrontOptions
	notes     *focusNotes
	done      *atomic.Int32

	mu             sync.Mutex
	workers        []*focusWorker
	forkThrows     bool
	behaviours     []focusBehaviour
	listen         func(index int) bool
	answerKey      bool
	heartbeats     bool
	anthropicCount *atomic.Int32
}

// focusRigKnobs are the rig's fast knobs; a test's non-zero knob replaces its field.
func focusRigKnobs(overrides FrontKnobs) FrontKnobs {
	knobs := FrontKnobs{
		HeartbeatMs:  20,
		HangMs:       200,
		ExitWindowMs: 5000,
		DegradeExits: 3,
		DegradedMs:   300,
		StartMs:      300,
		WaitWorkerMs: 500,
		AckWaitMs:    100,
		DrainMs:      1000,
		KeyCheckMs:   100,
	}
	if overrides.HeartbeatMs != 0 {
		knobs.HeartbeatMs = overrides.HeartbeatMs
	}
	if overrides.HangMs != 0 {
		knobs.HangMs = overrides.HangMs
	}
	if overrides.ExitWindowMs != 0 {
		knobs.ExitWindowMs = overrides.ExitWindowMs
	}
	if overrides.DegradeExits != 0 {
		knobs.DegradeExits = overrides.DegradeExits
	}
	if overrides.DegradedMs != 0 {
		knobs.DegradedMs = overrides.DegradedMs
	}
	if overrides.StartMs != 0 {
		knobs.StartMs = overrides.StartMs
	}
	if overrides.WaitWorkerMs != 0 {
		knobs.WaitWorkerMs = overrides.WaitWorkerMs
	}
	if overrides.AckWaitMs != 0 {
		knobs.AckWaitMs = overrides.AckWaitMs
	}
	if overrides.DrainMs != 0 {
		knobs.DrainMs = overrides.DrainMs
	}
	if overrides.KeyCheckMs != 0 {
		knobs.KeyCheckMs = overrides.KeyCheckMs
	}
	if overrides.BodyLimit != 0 {
		knobs.BodyLimit = overrides.BodyLimit
	}
	return knobs
}

func newFocusRig(t *testing.T, setup focusSetup) *focusRig {
	t.Helper()
	canonical := setup.port
	if canonical == 0 {
		canonical = freeRouterPort(t)
	}
	listenPort := setup.listenPort
	if listenPort == 0 {
		listenPort = canonical
	}
	anthropicURL, served := focusAnthropic(t)
	r := &focusRig{
		t:              t,
		canonical:      canonical,
		notes:          &focusNotes{},
		done:           &atomic.Int32{},
		forkThrows:     setup.forkThrows,
		behaviours:     setup.behaviours,
		listen:         setup.listen,
		answerKey:      setup.answerKey == nil || *setup.answerKey,
		heartbeats:     setup.heartbeats,
		anthropicCount: served,
	}
	if r.listen == nil {
		r.listen = func(int) bool { return true }
	}
	fork := setup.fork
	if fork == nil && !setup.realFork {
		fork = func(exec string, _ string) (WorkerHandle, error) {
			if r.forkThrows {
				return nil, errors.New("no fork")
			}
			r.mu.Lock()
			index := len(r.workers)
			behaviour := focusOK
			if index < len(r.behaviours) {
				behaviour = r.behaviours[index]
			}
			listenUp := r.listen(index)
			answerKey := r.answerKey
			beats := r.heartbeats
			worker := newFocusWorker(exec, behaviour, listenUp, answerKey, beats)
			r.workers = append(r.workers, worker)
			r.mu.Unlock()
			go worker.boot()
			return worker, nil
		}
	}
	r.options = FrontOptions{
		Name:         "acme",
		Display:      "Acme Models",
		HealthPath:   focusHealth,
		Claim:        domain.ModelClaim{Prefixes: []string{"big-"}},
		Port:         canonical,
		ListenPort:   listenPort,
		Anthropic:    anthropicURL,
		Env:          ProxyEnv{},
		Version:      "v1",
		Token:        focusToken,
		Exec:         setup.exec,
		Fork:         fork,
		Knobs:        focusRigKnobs(setup.knobs),
		Peers:        setup.peers,
		Watch:        setup.watch,
		RetiredWatch: setup.retiredWatch,
		OnRetire:     setup.onRetire,
		Note:         r.notes.add,
		Log:          setup.log,
		Events:       setup.events,
		Done:         func() { r.done.Add(1) },
	}
	r.front = CreateFront(r.options)
	t.Cleanup(func() { r.front.Close() })
	t.Cleanup(func() {
		for _, worker := range r.snapshotWorkers() {
			worker.stop("SIGKILL")
		}
	})
	bound, err := r.front.Start()
	if err != nil {
		t.Fatalf("front start: %v", err)
	}
	r.port = bound
	return r
}

func (r *focusRig) snapshotWorkers() []*focusWorker {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*focusWorker(nil), r.workers...)
}

func (r *focusRig) workerAt(index int) *focusWorker {
	r.mu.Lock()
	defer r.mu.Unlock()
	if index >= len(r.workers) {
		return nil
	}
	return r.workers[index]
}

func (r *focusRig) workerCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.workers)
}

// requestWithHost sends one request to the front the way Claude Code would (a fresh connection
// each time); an empty host names the canonical port. Every rig request carries a deadline: the
// front's server has none by design, so a wedged front must fail the test, not hang it.
func (r *focusRig) requestWithHost(method, path string, body []byte, headers map[string]string, host string) (int, string, error) {
	var payload io.Reader
	if body != nil {
		payload = strings.NewReader(string(body))
	}
	request, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", r.port, path), payload)
	if err != nil {
		return 0, "", err
	}
	if host != "" {
		request.Host = host
	} else {
		request.Host = fmt.Sprintf("127.0.0.1:%d", r.canonical)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 30 * time.Second}
	answer, err := client.Do(request)
	if err != nil {
		return 0, "", err
	}
	defer answer.Body.Close()
	text, err := io.ReadAll(answer.Body)
	if err != nil {
		return answer.StatusCode, "", err
	}
	return answer.StatusCode, string(text), nil
}

type focusAnswer struct {
	status int
	body   string
	err    error
}

// post posts one request to /v1/messages, the model (or rawBody) as its body; extra carries
// headers ("host", "path", "rawBody" are not headers).
func (r *focusRig) post(model string, extra map[string]string) (int, string, error) {
	path := "/v1/messages"
	body := []byte(`{"model":"` + model + `"}`)
	if extra == nil {
		extra = map[string]string{}
	}
	if raw := extra["rawBody"]; raw != "" {
		body = []byte(raw)
	}
	if custom := extra["path"]; custom != "" {
		path = custom
	}
	headers := map[string]string{}
	for name, value := range extra {
		switch name {
		case "rawBody", "path", "host":
		default:
			headers[name] = value
		}
	}
	return r.requestWithHost(http.MethodPost, path, body, headers, extra["host"])
}

func (r *focusRig) get(path string, headers map[string]string) (int, string, error) {
	host := ""
	if headers != nil {
		host = headers["host"]
		delete(headers, "host")
	}
	return r.requestWithHost(http.MethodGet, path, nil, headers, host)
}

// control makes one control call with the token.
func (r *focusRig) control(action, body, token string) (int, string, error) {
	method := http.MethodPost
	var payload io.Reader
	if action == "key" {
		method = http.MethodGet
	} else {
		payload = strings.NewReader(body)
	}
	request, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s/%s", r.port, focusHealth, action), payload)
	if err != nil {
		return 0, "", err
	}
	request.Host = fmt.Sprintf("127.0.0.1:%d", r.canonical)
	request.Header.Set(TokenHeader, token)
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 30 * time.Second}
	answer, err := client.Do(request)
	if err != nil {
		return 0, "", err
	}
	defer answer.Body.Close()
	text, _ := io.ReadAll(answer.Body)
	return answer.StatusCode, string(text), nil
}

// healthBody is the front's health answer.
type healthBody struct {
	OK           bool    `json:"ok"`
	Name         string  `json:"name"`
	Provider     string  `json:"provider"`
	Mode         string  `json:"mode"`
	Worker       string  `json:"worker"`
	Version      string  `json:"version"`
	FrontVersion int     `json:"frontVersion"`
	Pid          int     `json:"pid"`
	RetiredAt    *string `json:"retiredAt"`
	WorkerPid    *int    `json:"workerPid"`
}

func (r *focusRig) health() healthBody {
	r.t.Helper()
	status, body, err := r.get(focusHealth, nil)
	if err != nil || status != 200 {
		r.t.Fatalf("health: %d %v", status, err)
	}
	var parsed healthBody
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		r.t.Fatalf("health body %q: %v", body, err)
	}
	return parsed
}

// postAsync posts on its own goroutine, for requests whose answer waits on a worker's fate.
func (r *focusRig) postAsync(model string) <-chan focusAnswer {
	out := make(chan focusAnswer, 1)
	go func() {
		status, body, err := r.post(model, nil)
		out <- focusAnswer{status: status, body: body, err: err}
	}()
	return out
}

func awaitFocusAnswer(t *testing.T, answers <-chan focusAnswer) focusAnswer {
	t.Helper()
	select {
	case answer := <-answers:
		return answer
	case <-time.After(8 * time.Second):
		t.Fatal("the request never answered")
		return focusAnswer{}
	}
}

// rawFocusRequest writes one raw request over a socket the test owns, and returns the connection.
func rawFocusRequest(t *testing.T, port, canonical int, body string) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	request := fmt.Sprintf("POST /v1/messages HTTP/1.1\r\nhost: 127.0.0.1:%d\r\ncontent-length: %d\r\n\r\n%s", canonical, len(body), body)
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	return conn
}

func TestFrontFocusedRequests(t *testing.T) {
	t.Parallel()
	t.Run("hands requests to its worker and reports itself in health", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		worker := r.workerAt(0)
		status, body, err := r.post("claude-x", nil)
		if err != nil || status != 200 || body != fmt.Sprintf("worker %d", worker.pid) {
			t.Fatalf("post = %d %q %v, want 200 %q", status, body, err, fmt.Sprintf("worker %d", worker.pid))
		}
		health := r.health()
		wantPid := worker.pid
		if !health.OK || health.Name != "acme" || health.Provider != "Acme Models" ||
			health.Mode != "router" || health.Worker != "up" || health.Version != "v1" ||
			health.FrontVersion != FrontVersion || health.WorkerPid == nil || *health.WorkerPid != wantPid {
			t.Fatalf("health = %+v", health)
		}
	})

	t.Run("stamps the worker hop with the front's token, so the worker knows the request is the front's", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		if _, _, err := r.post("claude-x", nil); err != nil {
			t.Fatal(err)
		}
		headers := r.workerAt(0).receivedHeaders()
		if len(headers) == 0 || headers[0].Get(TokenHeader) != focusToken {
			t.Fatalf("the worker hop carried token %q", headers[0].Get(TokenHeader))
		}
	})

	t.Run("refuses a foreign Host, a path that could change the upstream host, and a body over the limit", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{knobs: FrontKnobs{BodyLimit: 10}})
		status, _, err := r.get("/v1/models", map[string]string{"host": "evil.example"})
		if err != nil || status != 421 {
			t.Fatalf("a foreign Host: %d %v, want 421", status, err)
		}
		status, _, err = r.post("claude-x", map[string]string{"path": "//other-host/x"})
		if err != nil || status != 400 {
			t.Fatalf("a path changing the host: %d %v, want 400", status, err)
		}
		status, body, err := r.post("claude-x", map[string]string{"rawBody": strings.Repeat("x", 100)})
		if err != nil || status != 413 {
			t.Fatalf("a body over the limit: %d %v, want 413", status, err)
		}
		var parsed struct {
			Type  string `json:"type"`
			Error struct {
				Type string `json:"type"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(body), &parsed); err != nil {
			t.Fatal(err)
		}
		if parsed.Type != "error" || parsed.Error.Type != "request_too_large" {
			t.Fatalf("the 413 body = %q", body)
		}
	})

	t.Run("waits for a worker that is still starting instead of refusing", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{listen: func(index int) bool { return index > 0 }})
		// The first worker never listens; after startMs the front kills it, but meanwhile requests wait.
		if worker := r.front.Status().Worker; worker != "starting" {
			t.Fatalf("worker = %q, want starting", worker)
		}
		status, body, err := r.post("claude-x", nil)
		if err != nil || status != 200 || body != "from anthropic" {
			t.Fatalf("post = %d %q %v, want 200 from anthropic", status, body, err)
		}
	})

	t.Run("retries a request the worker never sent upstream on the next worker", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{behaviours: []focusBehaviour{focusCut, focusOK}})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		first := r.workerAt(0)
		answering := r.postAsync("claude-x")
		time.Sleep(30 * time.Millisecond)
		first.stop("SIGKILL")
		answer := awaitFocusAnswer(t, answering)
		if answer.status != 200 || answer.body != fmt.Sprintf("worker %d", r.workerAt(1).pid) {
			t.Fatalf("answer = %d %q, want the second worker's", answer.status, answer.body)
		}
	})

	t.Run("answers a 502 when the worker had already sent the request upstream", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{behaviours: []focusBehaviour{focusCutAfterAck}})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		status, body, err := r.post("claude-x", nil)
		if err != nil || status != 502 {
			t.Fatalf("post = %d %v, want 502", status, err)
		}
		if !strings.Contains(body, "cut off by a router restart") {
			t.Fatalf("body = %q", body)
		}
	})

	t.Run("serves a request itself when its retry is cut too", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{behaviours: []focusBehaviour{focusCut, focusCut}})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		status, body, err := r.post("claude-x", nil)
		if err != nil || status != 200 || body != "from anthropic" {
			t.Fatalf("post = %d %q %v, want 200 from anthropic", status, body, err)
		}
	})

	t.Run("ends the client's answer when the worker's answer stops mid-body", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{behaviours: []focusBehaviour{focusAbortMidBody}})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		_, _, err := r.post("claude-x", nil)
		if err == nil {
			t.Fatal("the cut answer was delivered whole, want an error")
		}
	})

	t.Run("stops the worker's request when the client goes away", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{behaviours: []focusBehaviour{focusHang}})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		conn := rawFocusRequest(t, r.port, r.canonical, "{}")
		time.Sleep(50 * time.Millisecond)
		_ = conn.Close()
		time.Sleep(50 * time.Millisecond)
		if r.workerAt(0).hasExited() {
			t.Fatal("the worker exited with the client's request")
		}
	})

	t.Run("does not forward a request whose client left while a worker was being waited for", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{
			listen: func(index int) bool { return index > 0 },
			knobs:  FrontKnobs{StartMs: 10000, WaitWorkerMs: 5000},
		})
		conn := rawFocusRequest(t, r.port, r.canonical, `{"model":"claude-x"}`)
		time.Sleep(30 * time.Millisecond)
		_ = conn.Close()
		// The replacement takes over while the client is already gone: nothing is forwarded for it.
		if _, _, err := r.control("reload", "{}", focusToken); err != nil {
			t.Fatal(err)
		}
		waitUntil(t, 2*time.Second, func() bool {
			status := r.front.Status()
			return status.WorkerPid != nil && r.workerAt(1) != nil && *status.WorkerPid == r.workerAt(1).pid
		})
		time.Sleep(50 * time.Millisecond)
		if served := r.workerAt(1).servedTotal(); served != 0 {
			t.Fatalf("the replacement served %d requests for a gone client", served)
		}
		if served := r.workerAt(0).servedTotal(); served != 0 {
			t.Fatalf("the first worker served %d requests", served)
		}
		if got := r.anthropicCount.Load(); got != 0 {
			t.Fatalf("anthropic was handed %d requests", got)
		}
	})
}

// focusHealthEvent is one health event without its timestamp, for ordering assertions.
type focusHealthEvent struct {
	Plugin string
	Event  string
	Reason string
	Model  *string
}

func TestFrontFocusedEvents(t *testing.T) {
	t.Parallel()
	collect := func() (func(domain.SpoolEvent), *sync.Mutex, *[]focusHealthEvent) {
		var mu sync.Mutex
		events := []focusHealthEvent{}
		return func(event domain.SpoolEvent) {
			if health, ok := event.(domain.RouterHealthEvent); ok {
				mu.Lock()
				events = append(events, focusHealthEvent{Plugin: health.Plugin, Event: string(health.Event), Reason: health.Reason, Model: health.Model})
				mu.Unlock()
			}
		}, &mu, &events
	}

	t.Run("records a restart per worker it replaces, the degraded one saying so, and a fallback per request it serves", func(t *testing.T) {
		events, mu, list := collect()
		r := newFocusRig(t, focusSetup{events: events})
		for exit := 0; exit < 3; exit++ {
			waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
			last := r.workerAt(r.workerCount() - 1)
			last.stop("SIGKILL")
			waitUntil(t, 2*time.Second, last.hasExited)
		}
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Mode == "degraded" })
		if _, _, err := r.post("claude-x", nil); err != nil {
			t.Fatal(err)
		}
		if _, _, err := r.post("big-model", map[string]string{"rawBody": `{"model":"big-model","messages":[{"content":"private"}]}`}); err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		defer mu.Unlock()
		want := []focusHealthEvent{
			{Plugin: "acme", Event: "restart", Reason: "worker exited (SIGKILL)", Model: nil},
			{Plugin: "acme", Event: "restart", Reason: "worker exited (SIGKILL)", Model: nil},
			{Plugin: "acme", Event: "restart", Reason: "worker exited (SIGKILL); degraded after 3 exits", Model: nil},
		}
		if len(*list) != 5 {
			t.Fatalf("events = %+v", *list)
		}
		for i := range want {
			if (*list)[i].Plugin != want[i].Plugin || (*list)[i].Event != want[i].Event || (*list)[i].Reason != want[i].Reason {
				t.Fatalf("event %d = %+v, want %+v", i, (*list)[i], want[i])
			}
		}
		for i, model := range []string{"claude-x", "big-model"} {
			event := (*list)[3+i]
			if event.Event != "fallback" || event.Reason != "degraded after repeated worker exits" ||
				event.Model == nil || *event.Model != model {
				t.Fatalf("fallback %d = %+v, want model %q", i, event, model)
			}
		}
	})

	t.Run("names why it served a request itself: a worker that failed it twice, a worker that never started", func(t *testing.T) {
		twiceEvents, twiceMu, twiceList := collect()
		cut := newFocusRig(t, focusSetup{behaviours: []focusBehaviour{focusCut, focusCut}, events: twiceEvents})
		waitUntil(t, 2*time.Second, func() bool { return cut.front.Status().Worker == "up" })
		if _, _, err := cut.post("claude-x", nil); err != nil {
			t.Fatal(err)
		}
		twiceMu.Lock()
		found := false
		for _, event := range *twiceList {
			if event.Plugin == "acme" && event.Event == "fallback" && event.Reason == "the worker failed the request twice" &&
				event.Model != nil && *event.Model == "claude-x" {
				found = true
			}
		}
		twiceMu.Unlock()
		if !found {
			t.Fatalf("events = %+v, want a twice-failure fallback for claude-x", twiceList)
		}

		noneEvents, noneMu, noneList := collect()
		forkless := newFocusRig(t, focusSetup{forkThrows: true, knobs: FrontKnobs{WaitWorkerMs: 50}, events: noneEvents})
		if _, _, err := forkless.post("claude-x", map[string]string{"rawBody": "not json"}); err != nil {
			t.Fatal(err)
		}
		noneMu.Lock()
		defer noneMu.Unlock()
		if len(*noneList) != 1 || (*noneList)[0].Event != "fallback" || (*noneList)[0].Reason != "no worker was ready" || (*noneList)[0].Model != nil {
			t.Fatalf("events = %+v, want one no-worker fallback with no model", *noneList)
		}
	})

	t.Run("records a worker that fails to start as a restart into degraded mode", func(t *testing.T) {
		events, mu, list := collect()
		r := newFocusRig(t, focusSetup{listen: func(int) bool { return false }, knobs: FrontKnobs{StartMs: 5000}, events: events})
		r.workerAt(0).stop("")
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Mode == "degraded" })
		mu.Lock()
		defer mu.Unlock()
		want := []focusHealthEvent{{Plugin: "acme", Event: "restart", Reason: "a worker failed to start (code 0); degraded", Model: nil}}
		if len(*list) != 1 || (*list)[0] != want[0] {
			t.Fatalf("events = %+v, want %+v", *list, want)
		}
	})
}

func ptr(text string) *string { return &text }

func boolPtr(value bool) *bool { return &value }

func intPtr(value int) *int { return &value }

func TestFrontFocusedSupervision(t *testing.T) {
	t.Parallel()
	t.Run("replaces a worker that exits, and degrades after three exits in the window, then recovers", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{})
		for exit := 0; exit < 3; exit++ {
			waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
			last := r.workerAt(r.workerCount() - 1)
			last.stop("SIGKILL")
			waitUntil(t, 2*time.Second, last.hasExited)
		}
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Mode == "degraded" })
		if notes := r.notes.joined(); !strings.Contains(notes, "degraded: 3 worker exits") {
			t.Fatalf("notes = %q", notes)
		}
		status, body, err := r.post("claude-x", nil)
		if err != nil || status != 200 || body != "from anthropic" {
			t.Fatalf("a claude model while degraded: %d %q %v", status, body, err)
		}
		providerStatus, providerBody, err := r.post("big-model", nil)
		if err != nil || providerStatus != 503 {
			t.Fatalf("a provider model while degraded: %d %v, want 503", providerStatus, err)
		}
		if !strings.Contains(providerBody, "Acme Models router degraded after repeated crashes; Claude models still work.") {
			t.Fatalf("the degraded 503 = %q", providerBody)
		}
		waitUntil(t, 5*time.Second, func() bool {
			status := r.front.Status()
			return status.Mode == "router" && status.Worker == "up"
		})
		if status, _, err := r.post("claude-x", nil); err != nil || status != 200 {
			t.Fatalf("after recovery: %d %v", status, err)
		}
	})

	t.Run("degrades at once when a worker exits before it listens", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{listen: func(int) bool { return false }, knobs: FrontKnobs{StartMs: 5000}})
		r.workerAt(0).stop("")
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Mode == "degraded" })
		if notes := r.notes.joined(); !strings.Contains(notes, "a worker failed to start") {
			t.Fatalf("notes = %q", notes)
		}
		status, body, err := r.post("claude-x", nil)
		if err != nil || status != 200 || body != "from anthropic" {
			t.Fatalf("post = %d %q %v", status, body, err)
		}
	})

	t.Run("refuses a peer-bound request with the honest 503 while degraded, and passes the rest to Anthropic", func(t *testing.T) {
		var logMu sync.Mutex
		logLines := []string{}
		r := newFocusRig(t, focusSetup{
			listen: func(int) bool { return false },
			knobs:  FrontKnobs{StartMs: 5000},
			peers: func(model string) (PeerTarget, bool) {
				if strings.HasPrefix(model, "peer-") {
					return PeerTarget{Name: "peer", Port: 1}, true
				}
				return PeerTarget{}, false
			},
			log: func(line string) {
				logMu.Lock()
				logLines = append(logLines, line)
				logMu.Unlock()
			},
		})
		r.workerAt(0).stop("")
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Mode == "degraded" })

		hoppedStatus, hoppedBody, err := r.post("claude-x", map[string]string{PeerHop: "other"})
		if err != nil || hoppedStatus != 503 {
			t.Fatalf("a hopped request: %d %v, want 503", hoppedStatus, err)
		}
		if !strings.Contains(hoppedBody, "Run /acme:setup") {
			t.Fatalf("the hopped 503 = %q", hoppedBody)
		}
		logMu.Lock()
		if len(logLines) != 1 || !strings.Contains(logLines[0], "model=claude-x → refused (degraded)") {
			t.Fatalf("the front's own log = %q", logLines)
		}
		logMu.Unlock()
		peerStatus, peerBody, err := r.post("peer-model", nil)
		if err != nil || peerStatus != 503 {
			t.Fatalf("a peer's model: %d %v, want 503", peerStatus, err)
		}
		var parsed struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(peerBody), &parsed); err != nil {
			t.Fatal(err)
		}
		if want := "the peer plugin's router serves peer-model; the degraded acme router cannot forward it; run /peer:setup."; parsed.Error.Message != want {
			t.Fatalf("the peer 503 message = %q, want %q", parsed.Error.Message, want)
		}
		status, body, err := r.post("claude-x", nil)
		if err != nil || status != 200 || body != "from anthropic" {
			t.Fatalf("post = %d %q %v", status, body, err)
		}
	})

	t.Run("kills a worker that never listens, and one whose heartbeat stops", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{listen: func(index int) bool { return index != 0 }})
		waitUntil(t, 3*time.Second, func() bool { return strings.Contains(r.notes.joined(), "did not listen") })
		waitUntil(t, 3*time.Second, func() bool { return r.front.Status().Worker == "up" })
		// No heartbeat from the fake: it is hung.
		waitUntil(t, 3*time.Second, func() bool { return strings.Contains(r.notes.joined(), "no heartbeat") })
	})

	t.Run("keeps a worker that heartbeats, and recycles one over the memory limit: the new one first, then a drain", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{knobs: FrontKnobs{RssLimitMb: 100, HangMs: 10000}})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		first := r.workerAt(0)
		first.message([]byte(`{"t":"hb","rss":50}`))
		first.message([]byte(`{"t":"hb","rss":600}`))
		waitUntil(t, 2*time.Second, func() bool {
			status := r.front.Status()
			return r.workerCount() == 2 && status.WorkerPid != nil && *status.WorkerPid == r.workerAt(1).pid
		})
		sent := first.sentLines()
		found := false
		for _, line := range sent {
			if string(line) == `{"t":"drain","ms":1000}` {
				found = true
			}
		}
		if !found {
			t.Fatalf("the old worker was sent %+v, want a drain of 1000 ms", sent)
		}
		waitUntil(t, 2*time.Second, func() bool { return strings.Contains(r.notes.joined(), "a draining worker exited") })
	})

	t.Run("finishes the stream a draining worker is serving: a hot update never cuts it mid-response", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{
			behaviours: []focusBehaviour{focusStream, focusOK},
			knobs:      FrontKnobs{HangMs: 150, DrainMs: 50},
			heartbeats: true,
		})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		streaming := r.postAsync("claude-x")
		time.Sleep(50 * time.Millisecond)
		// The new worker takes over while the old one is mid-answer; its drain stops the old worker's heartbeat.
		if _, _, err := r.control("reload", "{}", focusToken); err != nil {
			t.Fatal(err)
		}
		answer := awaitFocusAnswer(t, streaming)
		if answer.status != 200 || answer.body != "half and done" {
			t.Fatalf("the stream = %d %q, want 200 half and done", answer.status, answer.body)
		}
		// It finishes and exits by itself, never declared hung.
		waitUntil(t, 2*time.Second, r.workerAt(0).hasExited)
		if notes := r.notes.joined(); strings.Contains(notes, "hung") {
			t.Fatalf("notes = %q", notes)
		}
	})

	t.Run("never hang-kills a draining worker that stopped heartbeating: only the drain limit ends it", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{
			behaviours: []focusBehaviour{focusLinger, focusOK},
			knobs:      FrontKnobs{HangMs: 150, DrainMs: 50},
			heartbeats: true,
		})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		if _, _, err := r.control("reload", "{}", focusToken); err != nil {
			t.Fatal(err)
		}
		waitUntil(t, 2*time.Second, func() bool {
			status := r.front.Status()
			return status.WorkerPid != nil && *status.WorkerPid == r.workerAt(1).pid
		})
		// Well past the hang window: heartbeats stopped at the drain, yet the worker and its streams are untouched.
		time.Sleep(300 * time.Millisecond)
		if r.workerAt(0).hasExited() {
			t.Fatal("the draining worker was hang-killed")
		}
		if notes := r.notes.joined(); strings.Contains(notes, "hung") {
			t.Fatalf("notes = %q", notes)
		}
		// The drain limit is what finally ends it, and only then.
		waitUntil(t, 8*time.Second, func() bool { return strings.Contains(r.notes.joined(), "a draining worker exited (SIGKILL)") })
		if !r.workerAt(0).hasExited() {
			t.Fatal("the draining worker never exited")
		}
	})

	t.Run("notes a fork that throws and serves requests itself", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{forkThrows: true, knobs: FrontKnobs{WaitWorkerMs: 50}})
		if notes := r.notes.joined(); !strings.Contains(notes, "worker fork failed: no fork") {
			t.Fatalf("notes = %q", notes)
		}
		status, body, err := r.post("claude-x", nil)
		if err != nil || status != 200 || body != "from anthropic" {
			t.Fatalf("post = %d %q %v", status, body, err)
		}
	})

	t.Run("ignores messages that are not its protocol", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		worker := r.workerAt(0)
		worker.message([]byte(`null`))
		worker.message([]byte(`"hello"`))
		worker.message([]byte(`{"t":"ack","id":"unknown"}`))
		worker.message([]byte(`{"t":"unknown"}`))
		if worker := r.front.Status().Worker; worker != "up" {
			t.Fatalf("worker = %q, want up", worker)
		}
	})
}

func TestFrontFocusedControl(t *testing.T) {
	t.Parallel()
	t.Run("refuses a call without the token, and an unknown action", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{})
		status, _, err := r.control("reload", "{}", "wrong")
		if err != nil || status != 403 {
			t.Fatalf("a call without the token: %d %v, want 403", status, err)
		}
		status, _, err = r.control("explode", "{}", focusToken)
		if err != nil || status != 404 {
			t.Fatalf("an unknown action: %d %v, want 404", status, err)
		}
	})

	t.Run("reload recycles the worker onto the new script and reports the new version", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{knobs: FrontKnobs{HangMs: 10000, StartMs: 10000}, listen: func(index int) bool { return index != 2 }})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		status, body, err := r.control("reload", `{"exec":"/stable/new.js","version":"v2"}`, focusToken)
		if err != nil || status != 200 || body != `{"ok":true}` {
			t.Fatalf("reload = %d %q %v", status, body, err)
		}
		waitUntil(t, 2*time.Second, func() bool {
			status := r.front.Status()
			return status.WorkerPid != nil && *status.WorkerPid == r.workerAt(1).pid
		})
		if exec := r.workerAt(1).execPath; exec != "/stable/new.js" {
			t.Fatalf("the new worker runs %q", exec)
		}
		if version := r.health().Version; version != "v2" {
			t.Fatalf("health version = %q", version)
		}
		// A reload whose new worker never listens leaves the running one in place.
		if _, _, err := r.control("reload", "not json", focusToken); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
		r.workerAt(2).stop("SIGKILL")
		waitUntil(t, 2*time.Second, func() bool { return strings.Contains(r.notes.joined(), "the running one stays") })
		status2 := r.front.Status()
		if status2.WorkerPid == nil || *status2.WorkerPid != r.workerAt(1).pid {
			t.Fatalf("worker pid = %+v", status2.WorkerPid)
		}
	})

	t.Run("answers the key check through the worker, and says when it cannot", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		_, body, err := r.control("key", "", focusToken)
		if err != nil {
			t.Fatal(err)
		}
		if body != `{"ok":true,"source":"ACME_KEY"}` {
			t.Fatalf("key = %q", body)
		}

		silent := newFocusRig(t, focusSetup{answerKey: boolPtr(false)})
		waitUntil(t, 2*time.Second, func() bool { return silent.front.Status().Worker == "up" })
		_, body, err = silent.control("key", "", focusToken)
		if err != nil {
			t.Fatal(err)
		}
		if body != `{"ok":false,"error":"the key lookup timed out"}` {
			t.Fatalf("a silent key check = %q", body)
		}

		none := newFocusRig(t, focusSetup{forkThrows: true})
		_, body, err = none.control("key", "", focusToken)
		if err != nil {
			t.Fatal(err)
		}
		if body != `{"ok":false,"error":"no worker is running"}` {
			t.Fatalf("a workerless key check = %q", body)
		}
	})

	t.Run("hands over: stops accepting so a new front can bind, finishes open connections, then is done", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		status, body, err := r.control("handover", "", focusToken)
		if err != nil || status != 200 || body != `{"ok":true}` {
			t.Fatalf("handover = %d %q %v", status, body, err)
		}
		waitUntil(t, 2*time.Second, func() bool { return r.done.Load() == 1 })
		waitUntil(t, 2*time.Second, func() bool {
			listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", r.canonical))
			if err != nil {
				return false
			}
			_ = listener.Close()
			return true
		})
	})

	t.Run("adopts the canonical port from a temporary one, retrying while it is still taken", func(t *testing.T) {
		canonical := freeRouterPort(t)
		blocker, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", canonical))
		if err != nil {
			t.Fatal(err)
		}
		r := newFocusRig(t, focusSetup{port: canonical, listenPort: freeRouterPort(t)})
		adopting := make(chan focusAnswer, 1)
		go func() {
			status, body, err := r.control("adopt", "", focusToken)
			adopting <- focusAnswer{status: status, body: body, err: err}
		}()
		time.Sleep(50 * time.Millisecond)
		_ = blocker.Close()
		answer := awaitFocusAnswer(t, adopting)
		if answer.err != nil || answer.status != 200 {
			t.Fatalf("adopt = %d %v", answer.status, answer.err)
		}
		if want := `{"ok":true,"port":` + strconv.Itoa(canonical) + `}`; answer.body != want {
			t.Fatalf("adopt body = %q, want %q", answer.body, want)
		}
		if port := r.front.Status().Port; port != canonical {
			t.Fatalf("status port = %d, want %d", port, canonical)
		}
		// The front answers on the canonical port now; the control call goes there.
		r.port = canonical
		_, body, err := r.control("adopt", "", focusToken)
		if err != nil {
			t.Fatal(err)
		}
		if want := `{"ok":true,"port":` + strconv.Itoa(canonical) + `}`; body != want {
			t.Fatalf("a second adopt = %q, want %q", body, want)
		}
	})

	t.Run("gives up adopting a port that stays taken", func(t *testing.T) {
		canonical := freeRouterPort(t)
		blocker, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", canonical))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = blocker.Close() })
		r := newFocusRig(t, focusSetup{port: canonical, listenPort: freeRouterPort(t)})
		status, _, err := r.control("adopt", "", focusToken)
		if err != nil || status != 500 {
			t.Fatalf("adopt = %d %v, want 500", status, err)
		}
	})
}

func TestFrontFocusedWatch(t *testing.T) {
	t.Parallel()
	t.Run("runs the watch, survives a failing tick, and retires when it says retire", func(t *testing.T) {
		var ticks atomic.Int32
		r := newFocusRig(t, focusSetup{watch: &FrontWatch{
			EveryMs: 20,
			Tick: func() (string, error) {
				count := ticks.Add(1)
				if count == 1 {
					return "", errors.New("bad tick")
				}
				if count >= 3 {
					return "retire", nil
				}
				return "stay", nil
			},
			Cleanup: func() error { return nil },
		}})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Mode == "retired" })
		notes := r.notes.joined()
		if !strings.Contains(notes, "uninstall watch failed: bad tick") {
			t.Fatalf("notes = %q", notes)
		}
		if !strings.Contains(notes, "retired: the plugin was uninstalled or disabled") {
			t.Fatalf("notes = %q", notes)
		}
		// A retired front ticks the uninstall watch no more.
		seen := ticks.Load()
		time.Sleep(100 * time.Millisecond)
		if again := ticks.Load(); again != seen {
			t.Fatalf("ticks went %d -> %d after retiring", seen, again)
		}
		if done := r.done.Load(); done != 0 {
			t.Fatalf("done = %d, want 0", done)
		}
	})

	t.Run("ticks once at start, before the first interval, so a quick uninstall still finds the ledger", func(t *testing.T) {
		var ticks atomic.Int32
		newFocusRig(t, focusSetup{watch: &FrontWatch{
			EveryMs: 60000,
			Tick:    func() (string, error) { ticks.Add(1); return "stay", nil },
			Cleanup: func() error { return nil },
		}})
		waitUntil(t, 2*time.Second, func() bool { return ticks.Load() == 1 })
	})

	t.Run("drain without open connections is done at once, and a second drain changes nothing", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{})
		r.front.Drain()
		r.front.Drain()
		waitUntil(t, 2*time.Second, func() bool { return r.done.Load() == 1 })
		r.front.Close()
		r.front.Close()
		if done := r.done.Load(); done != 1 {
			t.Fatalf("done = %d, want 1", done)
		}
	})
}

func TestFrontFocusedRetired(t *testing.T) {
	t.Parallel()
	const removed = "Acme Models was removed: restart Claude Code to stop using its router"

	t.Run("drains its worker, passes Claude requests through, refuses the provider, peers and hops with a 400", func(t *testing.T) {
		var mu sync.Mutex
		events := []domain.SpoolEvent{}
		retired := 0
		var logMu sync.Mutex
		logLines := []string{}
		r := newFocusRig(t, focusSetup{
			events: func(event domain.SpoolEvent) {
				mu.Lock()
				events = append(events, event)
				mu.Unlock()
			},
			peers: func(model string) (PeerTarget, bool) {
				if strings.HasPrefix(model, "peer-") {
					return PeerTarget{Name: "peer", Port: 1}, true
				}
				return PeerTarget{}, false
			},
			log: func(line string) {
				logMu.Lock()
				logLines = append(logLines, line)
				logMu.Unlock()
			},
			onRetire: func() { retired++ },
		})
		waitUntil(t, 2*time.Second, func() bool { return r.front.Status().Worker == "up" })
		status, body, err := r.control("retire", "", focusToken)
		if err != nil || status != 200 {
			t.Fatalf("retire = %d %v", status, err)
		}
		var retireAnswer struct {
			OK        bool   `json:"ok"`
			Already   bool   `json:"already"`
			RetiredAt string `json:"retiredAt"`
		}
		if err := json.Unmarshal([]byte(body), &retireAnswer); err != nil {
			t.Fatal(err)
		}
		if !retireAnswer.OK || retireAnswer.Already || retireAnswer.RetiredAt == "" {
			t.Fatalf("retire answer = %+v", retireAnswer)
		}
		drained := false
		for _, line := range r.workerAt(0).sentLines() {
			if string(line) == `{"t":"drain","ms":1000}` {
				drained = true
			}
		}
		if !drained {
			t.Fatal("the worker was never told to drain")
		}
		if health := r.health(); health.Mode != "retired" || health.Worker != "down" || health.RetiredAt == nil {
			t.Fatalf("health = %+v", health)
		}

		if status, body, err := r.post("claude-x", nil); err != nil || status != 200 || body != "from anthropic" {
			t.Fatalf("a claude model: %d %q %v", status, body, err)
		}
		wantBody := `{"type":"error","error":{"type":"invalid_request_error","message":"` + removed + `"}}`
		for i, ask := range []struct {
			model string
			extra map[string]string
		}{
			{model: "big-1"},
			{model: "peer-model"},
			{model: "claude-x", extra: map[string]string{PeerHop: "other"}},
		} {
			status, body, err := r.post(ask.model, ask.extra)
			if err != nil {
				t.Fatal(err)
			}
			if status != 400 || body != wantBody {
				t.Fatalf("refusal %d (%s) = %d %q, want 400 %q", i, ask.model, status, body, wantBody)
			}
		}
		logMu.Lock()
		if len(logLines) != 4 {
			t.Fatalf("the front's own log = %q", logLines)
		}
		for i, want := range []string{"anthropic 200 (passthrough)", "model=big-1 → refused (retired)", "model=peer-model → refused (retired)", "model=claude-x → refused (retired)"} {
			if !strings.Contains(logLines[i], want) {
				t.Fatalf("log %d = %q, want %q", i, logLines[i], want)
			}
		}
		logMu.Unlock()
		// One spool line for the retirement, nothing after it; a second retire changes nothing.
		mu.Lock()
		if len(events) != 1 {
			t.Fatalf("events = %d, want 1", len(events))
		}
		if health, ok := events[0].(domain.RouterHealthEvent); !ok || health.Event != domain.HealthRestart || health.Plugin != "acme" {
			t.Fatalf("the retirement event = %+v", events[0])
		}
		mu.Unlock()
		_, body, err = r.control("retire", "", focusToken)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(body, `"already":true`) {
			t.Fatalf("a second retire = %q", body)
		}
		r.front.Retire("again")
		mu.Lock()
		if len(events) != 1 {
			t.Fatalf("events = %d after a second retire, want 1", len(events))
		}
		mu.Unlock()
		if retired != 1 {
			t.Fatalf("the retire hook ran %d times", retired)
		}
		if count := r.workerCount(); count != 1 {
			t.Fatalf("%d workers were forked after retiring", count)
		}
	})

	t.Run("serves a request that waited for a worker once it retires, and never forks again", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{listen: func(int) bool { return false }, knobs: FrontKnobs{StartMs: 10000}})
		waiting := r.postAsync("claude-x")
		time.Sleep(50 * time.Millisecond)
		r.front.Retire("test")
		answer := awaitFocusAnswer(t, waiting)
		if answer.status != 200 || answer.body != "from anthropic" {
			t.Fatalf("the waiting request = %d %q", answer.status, answer.body)
		}
		time.Sleep(100 * time.Millisecond)
		if count := r.workerCount(); count != 1 {
			t.Fatalf("%d workers were forked after retiring", count)
		}
	})

	t.Run("exits when the retired watch says so, after the uninstall cleanup; a failing check keeps it up", func(t *testing.T) {
		var checks atomic.Int32
		cleaned := false
		r := newFocusRig(t, focusSetup{
			retiredWatch: &RetiredWatch{
				EveryMs: 20,
				Exit: func(retiredAt int64) (bool, error) {
					count := checks.Add(1)
					if count == 1 {
						return false, errors.New("ps failed")
					}
					return count >= 3 && retiredAt > 0, nil
				},
			},
			watch: &FrontWatch{
				EveryMs: 60000,
				Tick:    func() (string, error) { return "stay", nil },
				Cleanup: func() error { cleaned = true; return nil },
			},
			onRetire: func() { panic(errors.New("registry gone")) },
		})
		r.front.Retire("test")
		waitUntil(t, 2*time.Second, func() bool { return r.done.Load() == 1 })
		if !cleaned {
			t.Fatal("the uninstall cleanup never ran")
		}
		notes := r.notes.joined()
		for _, want := range []string{"retire hook failed: registry gone", "retired exit check failed: ps failed", "exiting"} {
			if !strings.Contains(notes, want) {
				t.Fatalf("notes = %q, want %q", notes, want)
			}
		}
	})

	t.Run("exits by its retired watch alone, with no uninstall watch to clean up", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{retiredWatch: &RetiredWatch{
			EveryMs: 20,
			Exit:    func(int64) (bool, error) { return true, nil },
		}})
		r.front.Retire("test")
		waitUntil(t, 2*time.Second, func() bool { return r.done.Load() == 1 })
	})

	t.Run("stays up when the uninstall cleanup itself fails", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{
			retiredWatch: &RetiredWatch{
				EveryMs: 20,
				Exit:    func(int64) (bool, error) { return true, nil },
			},
			watch: &FrontWatch{
				EveryMs: 60000,
				Tick:    func() (string, error) { return "stay", nil },
				Cleanup: func() error { return errors.New("cleanup boom") },
			},
		})
		r.front.Retire("test")
		waitUntil(t, 2*time.Second, func() bool {
			return strings.Contains(r.notes.joined(), "retired exit check failed: cleanup boom")
		})
		time.Sleep(50 * time.Millisecond)
		if done := r.done.Load(); done != 0 {
			t.Fatalf("done = %d, want 0", done)
		}
	})

	t.Run("does not retire once closed", func(t *testing.T) {
		r := newFocusRig(t, focusSetup{})
		r.front.Close()
		r.front.Retire("late")
		if mode := r.front.Status().Mode; mode != "router" {
			t.Fatalf("mode = %q, want router", mode)
		}
	})
}

// runFocusChildWorker is the front's real fork target: this binary re-executed as
// `plugin-core <name> router worker`, speaking the worker's IPC protocol on stdio while serving
// a real router on a loopback port.
func runFocusChildWorker() {
	fail := func(line string) {
		fmt.Fprintln(os.Stderr, line)
		os.Exit(3)
	}
	name := os.Getenv("FRONT_FOCUS_CHILD_NAME")
	if len(os.Args) != 4 || os.Args[1] != name || os.Args[2] != "router" || os.Args[3] != "worker" {
		fail(fmt.Sprintf("worker argv = %v", os.Args))
	}
	if os.Getenv(WorkerTokenEnv) != os.Getenv("FRONT_FOCUS_CHILD_TOKEN") {
		fail("the worker did not receive the front's token")
	}
	anthropic, err := url.Parse(os.Getenv("FRONT_FOCUS_CHILD_ANTHROPIC"))
	if err != nil {
		fail("bad anthropic url: " + err.Error())
	}
	hbMs := int64(20)
	if raw := os.Getenv("FRONT_FOCUS_CHILD_HB"); raw != "" {
		hbMs, _ = strconv.ParseInt(raw, 10, 64)
	}
	var stdout sync.Mutex
	send := func(line string) {
		stdout.Lock()
		defer stdout.Unlock()
		fmt.Fprintln(os.Stdout, line)
	}
	token := os.Getenv(WorkerTokenEnv)
	server := CreateRouter(RouterOptions{
		Provider:    routerProvider,
		Port:        0,
		Anthropic:   anthropic,
		ProviderURL: anthropic,
		Key:         func(context.Context) (string, error) { return "", nil },
		Env:         ProxyEnv{},
		Token:       token,
		OnUpstream: func(req *http.Request) {
			if id := req.Header.Get(RequestID); id != "" {
				send(`{"t":"ack","id":` + strconv.Quote(id) + `}`)
			}
		},
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fail("listen: " + err.Error())
	}
	go func() { _ = server.Serve(listener) }()
	send(`{"t":"listening","port":` + strconv.Itoa(listener.Addr().(*net.TCPAddr).Port) + `}`)
	heartbeats := time.NewTicker(time.Duration(hbMs) * time.Millisecond)
	go func() {
		for range heartbeats.C {
			send(`{"t":"hb","rss":50}`)
		}
	}()
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var message struct {
			T  string `json:"t"`
			Ms int64  `json:"ms"`
			Id string `json:"id"`
		}
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			continue
		}
		switch message.T {
		case "drain":
			ms := message.Ms
			if ms == 0 {
				ms = 600000
			}
			go func() {
				_ = server.Shutdown(context.Background())
				os.Exit(0)
			}()
			time.AfterFunc(time.Duration(ms)*time.Millisecond, func() { os.Exit(0) })
		case "key":
			send(`{"t":"key","id":` + strconv.Quote(message.Id) + `,"ok":true,"source":"CHILD_KEY"}`)
		}
	}
	// Stdin ended: the front is gone, and nobody routes here any more.
	os.Exit(0)
}

// TestFrontFocusedChild stays serial: the child mode is switched by the process's own environment.
func TestFrontFocusedChild(t *testing.T) {
	t.Run("forks its worker by re-executing the binary, and keeps Claude traffic flowing across the worker's death", func(t *testing.T) {
		anthropic, served := focusAnthropic(t)
		t.Setenv(focusChildEnv, "worker")
		t.Setenv("FRONT_FOCUS_CHILD_NAME", "acme")
		t.Setenv("FRONT_FOCUS_CHILD_ANTHROPIC", anthropic.String())
		t.Setenv("FRONT_FOCUS_CHILD_TOKEN", focusToken)
		t.Setenv("FRONT_FOCUS_CHILD_HB", "20")
		r := newFocusRig(t, focusSetup{
			realFork: true,
			exec:     "",
			knobs:    FrontKnobs{HeartbeatMs: 20, HangMs: 2000, StartMs: 5000, WaitWorkerMs: 5000, AckWaitMs: 200, DrainMs: 500},
		})
		waitUntil(t, 8*time.Second, func() bool { return r.front.Status().Worker == "up" })
		status := r.front.Status()
		if status.WorkerPid == nil || *status.WorkerPid <= 1 {
			t.Fatalf("worker pid = %+v", status.WorkerPid)
		}
		firstPid := *status.WorkerPid

		code, body, err := r.post("claude-x", nil)
		if err != nil || code != 200 || body != "from anthropic" {
			t.Fatalf("post through the child = %d %q %v", code, body, err)
		}
		_, keyBody, err := r.control("key", "", focusToken)
		if err != nil {
			t.Fatal(err)
		}
		if keyBody != `{"ok":true,"source":"CHILD_KEY"}` {
			t.Fatalf("the key check through the child = %q", keyBody)
		}

		killPid(t, firstPid)
		waitUntil(t, 8*time.Second, func() bool {
			status := r.front.Status()
			return status.Worker == "up" && status.WorkerPid != nil && *status.WorkerPid != firstPid
		})
		code, body, err = r.post("claude-x", nil)
		if err != nil || code != 200 || body != "from anthropic" {
			t.Fatalf("post after the child died = %d %q %v", code, body, err)
		}
		if got := served.Load(); got < 2 {
			t.Fatalf("anthropic was handed %d requests", got)
		}
	})
}

// TestFrontFocusedInternals covers the front's own guard paths directly: the knob defaults, the
// recycle refusals, the wait and fate shortcuts, and the fork's raw plumbing.
func TestFrontFocusedInternals(t *testing.T) {
	t.Parallel()
	t.Run("resolveFrontKnobs fills every default and keeps what is set", func(t *testing.T) {
		knobs := resolveFrontKnobs(FrontKnobs{})
		want := FrontKnobs{
			HeartbeatMs: 1000, HangMs: 5000, ExitWindowMs: 60000, DegradeExits: 3,
			DegradedMs: 60000, RssLimitMb: 512, StartMs: 10000, WaitWorkerMs: 10000,
			AckWaitMs: 2000, DrainMs: 600000, KeyCheckMs: 3000, BodyLimit: BodyLimitBytes,
		}
		if knobs != want {
			t.Fatalf("defaults = %+v, want %+v", knobs, want)
		}
		knobs = resolveFrontKnobs(FrontKnobs{HeartbeatMs: 7, BodyLimit: 10})
		if knobs.HeartbeatMs != 7 || knobs.BodyLimit != 10 || knobs.HangMs != 5000 {
			t.Fatalf("overrides = %+v", knobs)
		}
	})

	t.Run("health reports a faked old front protocol, and a front can start without a note", func(t *testing.T) {
		anthropic, _ := focusAnthropic(t)
		port := freeRouterPort(t)
		front := CreateFront(FrontOptions{
			Name: "acme", Display: "Acme Models", HealthPath: focusHealth,
			Claim: domain.ModelClaim{Prefixes: []string{"big-"}},
			Port:  port, Anthropic: anthropic, Env: ProxyEnv{},
			Version: "v1", FrontVersion: intPtr(0), Token: focusToken,
		})
		bound, err := front.Start()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(front.Close)
		answer, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d%s", bound, focusHealth))
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(answer.Body)
		answer.Body.Close()
		var health healthBody
		if err := json.Unmarshal(body, &health); err != nil {
			t.Fatal(err)
		}
		if health.FrontVersion != 0 {
			t.Fatalf("frontVersion = %d, want 0", health.FrontVersion)
		}

		// A front cannot bind a port someone else holds: start reports it.
		blocked := freeRouterPort(t)
		taker, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", blocked))
		if err != nil {
			t.Fatal(err)
		}
		defer taker.Close()
		second := CreateFront(FrontOptions{Port: blocked, HealthPath: focusHealth, Anthropic: anthropic})
		if _, err := second.Start(); err == nil {
			second.Close()
			t.Fatal("a second front bound a taken port")
		}
	})

	newInternalsFront := func(t *testing.T) (*Front, *atomic.Int32) {
		t.Helper()
		var forks atomic.Int32
		front := CreateFront(FrontOptions{
			Name: "acme", Display: "Acme Models", HealthPath: focusHealth,
			Port: freeRouterPort(t), Anthropic: mustURL(t, "http://127.0.0.1:1"), Env: ProxyEnv{},
			Fork: func(exec string, _ string) (WorkerHandle, error) {
				forks.Add(1)
				worker := newFocusWorker(exec, focusOK, false, true, false)
				go worker.boot()
				return worker, nil
			},
		})
		t.Cleanup(front.Close)
		return front, &forks
	}

	t.Run("recycle refuses while a replacement is pending, once retired, and once closed", func(t *testing.T) {
		front, forks := newInternalsFront(t)
		front.recycle("first")  // no current worker: one is forked
		front.recycle("second") // a replacement is forked
		front.recycle("third")  // refused: a replacement is pending
		if got := forks.Load(); got != 2 {
			t.Fatalf("%d workers were forked, want 2", got)
		}
		front.Retire("test")
		front.recycle("fourth") // refused: retired
		front.Close()
		front.recycle("fifth") // refused: closed
		if got := forks.Load(); got != 2 {
			t.Fatalf("%d workers were forked in the end, want 2", got)
		}
	})

	t.Run("afterWorkerFate returns at once for a worker that already exited", func(t *testing.T) {
		front, _ := newInternalsFront(t)
		done := make(chan struct{})
		go func() {
			front.afterWorkerFate(&workerState{exited: true})
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("afterWorkerFate waited for a worker that already exited")
		}
	})

	t.Run("a request waits for no worker while the front is degraded or closed", func(t *testing.T) {
		front, _ := newInternalsFront(t)
		front.mu.Lock()
		front.degradedUntil = front.now() + 60000
		front.mu.Unlock()
		if worker := front.workerWithin(50); worker != nil {
			t.Fatalf("workerWithin while degraded = %+v", worker)
		}
		front.Close()
		if worker := front.workerWithin(50); worker != nil {
			t.Fatalf("workerWithin while closed = %+v", worker)
		}
	})

	t.Run("two waits each time out on their own", func(t *testing.T) {
		front, _ := newInternalsFront(t)
		started := time.Now()
		first := make(chan *workerState, 1)
		second := make(chan *workerState, 1)
		go func() { first <- front.workerWithin(40) }()
		go func() { second <- front.workerWithin(40) }()
		if worker := <-first; worker != nil {
			t.Fatalf("first wait = %+v", worker)
		}
		if worker := <-second; worker != nil {
			t.Fatalf("second wait = %+v", worker)
		}
		if took := time.Since(started); took > 2*time.Second {
			t.Fatalf("the waits took %s", took)
		}
	})

	t.Run("degrade twice re-arms its timer", func(t *testing.T) {
		front, _ := newInternalsFront(t)
		front.mu.Lock()
		front.degradeLocked("first")
		front.degradeLocked("second")
		front.mu.Unlock()
		if mode := front.Status().Mode; mode != "degraded" {
			t.Fatalf("mode = %q", mode)
		}
	})

	t.Run("the exit check does nothing before the front retires", func(t *testing.T) {
		front, _ := newInternalsFront(t)
		front.retiredTick()
		if mode := front.Status().Mode; mode != "router" {
			t.Fatalf("mode = %q", mode)
		}
	})

	t.Run("the exec handle queues what arrives early and drops sends to a dead worker", func(t *testing.T) {
		_, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		handle := newExecHandle(nil, writer)
		handle.deliver([]byte(`{"t":"hb","rss":50}`))
		var gotMu sync.Mutex
		var got [][]byte
		handle.OnMessage(func(message []byte) {
			gotMu.Lock()
			got = append(got, message)
			gotMu.Unlock()
		})
		// What arrives early is delivered once the listener is registered, and so is what arrives
		// live: both wait for the handle's pump.
		waitUntil(t, time.Second, func() bool {
			gotMu.Lock()
			defer gotMu.Unlock()
			return len(got) == 1 && string(got[0]) == `{"t":"hb","rss":50}`
		})
		handle.deliver([]byte(`{"t":"ack","id":"r1"}`))
		waitUntil(t, time.Second, func() bool {
			gotMu.Lock()
			defer gotMu.Unlock()
			return len(got) == 2 && string(got[1]) == `{"t":"ack","id":"r1"}`
		})
		_ = writer.Close()
		handle.Send([]byte(`{"t":"drain","ms":1}`))
		handle.Send([]byte(`{"t":"drain","ms":2}`))
		if handle.stdinClosed != true {
			t.Fatal("the dead stdin was not noticed")
		}
		handle.recordExit(7, "")
		exits := make(chan int, 1)
		handle.OnExit(func(code int, signal string) { exits <- code })
		select {
		case code := <-exits:
			if code != 7 {
				t.Fatalf("exit code = %d", code)
			}
		case <-time.After(time.Second):
			t.Fatal("the early exit was never delivered")
		}
	})

	t.Run("the exec handle delivers early messages, a live message and the exit strictly in arrival order", func(t *testing.T) {
		_, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		handle := newExecHandle(nil, writer)
		handle.deliver([]byte(`{"t":"one"}`))
		handle.deliver([]byte(`{"t":"two"}`))
		// The first delivery stalls mid-queue: whatever delivers messages must not let a later, live
		// one (or the exit) overtake the ones that arrived first.
		release := make(chan struct{})
		var mu sync.Mutex
		var got []string
		note := func(line string) {
			mu.Lock()
			got = append(got, line)
			mu.Unlock()
		}
		handle.OnMessage(func(message []byte) {
			if string(message) == `{"t":"one"}` {
				<-release
			}
			note(string(message))
		})
		handle.deliver([]byte(`{"t":"three"}`))
		handle.recordExit(9, "SIGKILL")
		handle.OnExit(func(code int, signal string) { note(fmt.Sprintf("exit %d %s", code, signal)) })
		close(release)
		waitUntil(t, 2*time.Second, func() bool {
			mu.Lock()
			defer mu.Unlock()
			return strings.Join(got, " | ") == `{"t":"one"} | {"t":"two"} | {"t":"three"} | exit 9 SIGKILL`
		})
		_ = writer.Close()
	})

	t.Run("a listening message that arrives before the front registers its listener does not deadlock it", func(t *testing.T) {
		// FIX-HANG-ADOPT: the front registers its worker's listeners with its lock held, so the
		// handle must deliver an early message off the registering goroutine. A synchronous flush
		// re-enters that lock and wedges the front for good (the 2026-10-13 covergate hang).
		anthropic, _ := focusAnthropic(t)
		front := CreateFront(FrontOptions{
			Name: "acme", Display: "Acme Models", HealthPath: focusHealth,
			Claim: domain.ModelClaim{Prefixes: []string{"big-"}},
			Port:  freeRouterPort(t), Anthropic: anthropic, Env: ProxyEnv{},
			Version: "v1", Token: focusToken, Knobs: focusRigKnobs(FrontKnobs{}),
			Fork: func(exec string, _ string) (WorkerHandle, error) {
				worker := newFocusWorker(exec, focusOK, true, true, false)
				worker.boot() // synchronous: the listening message queues before the registration
				return worker, nil
			},
		})
		started := make(chan int, 1)
		failed := make(chan error, 1)
		go func() {
			port, err := front.Start()
			if err != nil {
				failed <- err
				return
			}
			started <- port
		}()
		select {
		case <-started:
			// Closed only on the healthy path: a wedged front's Close would block on its lock too.
			t.Cleanup(front.Close)
		case err := <-failed:
			t.Fatal(err)
		case <-time.After(3 * time.Second):
			t.Fatal("the front never started: its worker's early listening message deadlocked it")
		}
		waitUntil(t, 2*time.Second, func() bool { return front.Status().Worker == "up" })
	})

	t.Run("a fork of a missing binary fails", func(t *testing.T) {
		if _, err := execFork("acme")("/nonexistent/plugin-core", "token"); err == nil {
			t.Fatal("a fork of a missing binary succeeded")
		}
	})

	t.Run("a control call is loopback only", func(t *testing.T) {
		for _, address := range []string{"127.0.0.1:1", "[::1]:1", "junk", "10.0.0.1:2"} {
			if loopbackRequest(&http.Request{RemoteAddr: address}) != (address == "127.0.0.1:1" || address == "[::1]:1") {
				t.Fatalf("loopbackRequest(%q)", address)
			}
		}
	})

	t.Run("a degrade window that ends while a worker runs forks nothing", func(t *testing.T) {
		front, forks := newInternalsFront(t)
		front.mu.Lock()
		front.knobs.DegradedMs = 20
		front.degradeLocked("test")
		front.mu.Unlock()
		front.recycle("a worker came back") // one worker is forked before the window ends
		time.Sleep(100 * time.Millisecond)
		if got := forks.Load(); got != 1 {
			t.Fatalf("%d workers were forked, want 1", got)
		}
	})
}

// TestFrontEndWorkers is the uninstall cleanup's worker wait: a worker still alive when the
// retiring front cleans up holds the router log as its inherited stderr (the fork passes the
// front's own stdio on) — so everything still alive is killed and its exit awaited before the
// router's files go.
func TestFrontEndWorkers(t *testing.T) {
	t.Parallel()
	// A retired front with one worker left over, the shape the cleanup meets: retirement moved
	// the worker to the draining set, so its exit forks no replacement.
	newRetiredFront := func(t *testing.T, handle WorkerHandle) *Front {
		t.Helper()
		front := CreateFront(FrontOptions{
			Name: "acme", Display: "Acme Models", HealthPath: focusHealth,
			Port: freeRouterPort(t), Anthropic: mustURL(t, "http://127.0.0.1:1"), Env: ProxyEnv{},
			Fork: func(string, string) (WorkerHandle, error) { return handle, nil },
		})
		t.Cleanup(front.Close)
		front.recycle("test")
		front.Retire("test")
		return front
	}

	t.Run("kills a worker still alive, waits for its exit, and not again once gone", func(t *testing.T) {
		dying := &endWorkersDying{}
		front := newRetiredFront(t, dying)
		if !front.EndWorkers(2 * time.Second) {
			t.Fatal("EndWorkers gave up on a worker that dies on the kill")
		}
		if kills := dying.kills.Load(); kills != 1 {
			t.Fatalf("kills = %d, want 1", kills)
		}
		if !front.EndWorkers(2 * time.Second) {
			t.Fatal("EndWorkers gave up on the worker it already ended")
		}
		if kills := dying.kills.Load(); kills != 1 {
			t.Fatalf("kills = %d after the second pass, want 1", kills)
		}
	})

	t.Run("gives up after the wait on a worker that will not die, having killed it", func(t *testing.T) {
		stub := &endWorkersStub{}
		front := newRetiredFront(t, stub)
		start := time.Now()
		if front.EndWorkers(80 * time.Millisecond) {
			t.Fatal("EndWorkers waited out a worker that never exits")
		}
		if waited := time.Since(start); waited < 80*time.Millisecond {
			t.Fatalf("waited %s, want the whole bound", waited)
		}
		if kills := stub.kills.Load(); kills < 1 {
			t.Fatal("the overstaying worker was never killed")
		}
	})
}

// endWorkersStub is a forked worker that ignores its kill: no exit ever comes.
type endWorkersStub struct{ kills atomic.Int32 }

func (s *endWorkersStub) Pid() int                 { return 7777 }
func (s *endWorkersStub) OnMessage(func([]byte))   {}
func (s *endWorkersStub) OnExit(func(int, string)) {}
func (s *endWorkersStub) Send([]byte)              {}
func (s *endWorkersStub) Kill(string)              { s.kills.Add(1) }

// endWorkersDying is a forked worker whose kill ends it, the exit delivered off the killer's own
// stack the way the real handle's exit goroutine delivers it.
type endWorkersDying struct {
	kills atomic.Int32
	mu    sync.Mutex
	exit  func(code int, signal string)
}

func (s *endWorkersDying) Pid() int               { return 7778 }
func (s *endWorkersDying) OnMessage(func([]byte)) {}
func (s *endWorkersDying) OnExit(listener func(int, string)) {
	s.mu.Lock()
	s.exit = listener
	s.mu.Unlock()
}

func (s *endWorkersDying) Send([]byte) {}

func (s *endWorkersDying) Kill(signal string) {
	s.kills.Add(1)
	s.mu.Lock()
	listener := s.exit
	s.mu.Unlock()
	if listener != nil {
		go listener(-1, signal)
	}
}

// hangChild starts this binary as a child that never exits on its own.
func hangChild(t *testing.T) *exec.Cmd {
	t.Helper()
	command := exec.Command(os.Args[0])
	command.Env = append(os.Environ(), focusChildEnv+"=hang")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = command.Process.Kill() })
	return command
}

// awaitChildExit waits for the child's exit and returns it as the front reads it.
func awaitChildExit(t *testing.T, command *exec.Cmd) (int, string) {
	t.Helper()
	waited := make(chan error, 1)
	go func() { waited <- command.Wait() }()
	select {
	case err := <-waited:
		code, signal := exitOf(err)
		return code, signal
	case <-time.After(5 * time.Second):
		t.Fatal("the child never exited")
		return 0, ""
	}
}

func TestFrontFocusedUnixSignals(t *testing.T) {
	t.Parallel()
	t.Run("a nil exit is a clean code, and a wait error that is not an exit is a code alone", func(t *testing.T) {
		if code, signal := exitOf(nil); code != 0 || signal != "" {
			t.Fatalf("exitOf(nil) = %d %q", code, signal)
		}
		if code, signal := exitOf(errors.New("wait failed")); code != 1 || signal != "" {
			t.Fatalf("exitOf(error) = %d %q", code, signal)
		}
		if name := signalName(syscall.SIGINT); name != "SIGINT" {
			t.Fatalf("signalName(SIGINT) = %q", name)
		}
	})

	t.Run("a child that exits by itself reports its code", func(t *testing.T) {
		command := exec.Command(os.Args[0])
		command.Env = append(os.Environ(), focusChildEnv+"=code")
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		if code, signal := awaitChildExit(t, command); code != 3 || signal != "" {
			t.Fatalf("the child's exit = %d %q, want 3", code, signal)
		}
	})

	t.Run("every kill spelling ends the child, and its exit names the signal", func(t *testing.T) {
		for _, ask := range []struct {
			signal string
			want   string
		}{
			{signal: "SIGKILL", want: "SIGKILL"},
			{signal: "SIGTERM", want: "SIGTERM"},
			{signal: "SIGOTHER", want: "SIGKILL"},
		} {
			command := hangChild(t)
			killProcess(command.Process, ask.signal)
			if _, signal := awaitChildExit(t, command); signal != ask.want {
				t.Fatalf("kill(%s) ended the worker with %q, want %q", ask.signal, signal, ask.want)
			}
		}
	})

	t.Run("a kill of an already-gone child is not an error", func(t *testing.T) {
		command := hangChild(t)
		killProcess(command.Process, "SIGKILL")
		awaitChildExit(t, command)
		killProcess(command.Process, "SIGTERM")
	})
}
