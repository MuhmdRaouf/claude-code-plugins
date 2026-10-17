// The router's worker: the router core on an internal loopback port, forked and supervised by the
// front (`plugin-core <name> router worker`, the front's token in its environment). Over IPC (JSON
// lines on stdio) it reports its port once it listens, a heartbeat with its resident size every
// second from its own goroutine (a blocked loop stops the heartbeat and the front kills it), and
// an ack just before each request goes upstream, so the front knows which requests a crash cut and
// which it can retry. It drains on command: stop accepting, finish the streams in flight (at most
// the front's drain window), exit. The provider key is read only for a provider request, through
// one shared lookup per worker (warmed at start, read again when the provider refuses the key),
// behind the router core's 2 s budget.
package router

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/keystore"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/spool"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// WorkerOptions is what the worker needs to know.
type WorkerOptions struct {
	Provider domain.Provider
	Env      domain.EnvLookup
	// StateRoot is the plugin's state root; the crash log lives there.
	StateRoot string
	Version   string
	// LogFile is the router log file.
	LogFile string
	// Token is the front's token, required on the data path when set (the front hands it over at
	// fork).
	Token       string
	HeartbeatMs int64
	IdleMs      int64
}

// workerSender is the worker's IPC send: one JSON line per message, serialized (the heartbeat and
// the acks race).
type workerSender struct {
	mu     sync.Mutex
	send   func(line string)
	closed bool
}

func (s *workerSender) line(value any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		// The front is gone; the ended input ends this worker.
		return
	}
	s.send(marshalCompact(value))
}

// RunWorker runs the worker until it drains or its front goes away (its input ends). The send and
// exit plugs are the process's stdio and os.Exit in production; tests bring their own.
func RunWorker(options WorkerOptions, input io.Reader, send func(line string), exit func(code int)) {
	if exit == nil {
		exit = os.Exit
	}
	env := options.Env
	// Resolved once: the model ids this worker claims and the endpoint both follow the env
	// overrides.
	provider := domain.ResolveProvider(options.Provider, env)
	crash := InstallCrashHandlers(RoleWorker, options.StateRoot, options.Version, nil, nil)
	defer func() {
		if reason := recover(); reason != nil {
			crash("uncaught", reason)
		}
	}()
	log := RotatingLog(options.LogFile, nil, 0)
	anthropicURL := envOrDefault(env, domain.RouterEnvName(provider, domain.RouterEnvKnobAnthropicURL), "https://api.anthropic.com")
	anthropic, err := url.Parse(anthropicURL)
	if err != nil {
		log("worker: bad anthropic url: " + err.Error())
		exit(1)
		return
	}
	// The router follows the same endpoint override as the jobs: `${envPrefix}_BASE_URL`, plus
	// `${envPrefix}_ROUTER_URL` for the router alone.
	providerURL, err := url.Parse(envOrDefault(env, domain.RouterEnvName(provider, domain.RouterEnvKnobURL), provider.BaseURL))
	if err != nil {
		log("worker: bad provider url: " + err.Error())
		exit(1)
		return
	}
	heartbeats := &workerSender{send: send}
	server, core := createRouter(RouterOptions{
		Provider:    provider,
		Port:        0,
		Anthropic:   anthropic,
		ProviderURL: providerURL,
		Log:         log,
		Peers:       CreatePeerLookup(env, provider.Name, nil),
		Events:      spool.CreateSpoolWriter(env, log, nil),
		Budget:      CreateBudgetGate(provider.Name, env, nil, 0),
		Env:         ProxyEnv(env),
		Token:       options.Token,
		OnUpstream: func(req *http.Request) {
			if id := req.Header.Get(RequestID); id != "" {
				heartbeats.line(struct {
					T  string `json:"t"`
					Id string `json:"id"`
				}{T: "ack", Id: id})
			}
		},
		IdleMs: options.IdleMs,
	}, func(ctx context.Context) (ports.ProviderKey, *ports.WorkerError) {
		return workerKey(ctx, provider, env)
	})
	// The first lookup starts while nobody is waiting on it, so the first request normally finds
	// the key ready.
	core.keys.warm()
	connections := TrackConnections(nil)
	connections.Watch(server)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log("worker: " + err.Error())
		exit(1)
		return
	}
	go func() { _ = server.Serve(listener) }()
	var finished sync.Once
	done := make(chan struct{})
	finish := func(code int) {
		finished.Do(func() {
			heartbeats.mu.Lock()
			heartbeats.closed = true
			heartbeats.mu.Unlock()
			exit(code)
			// os.Exit never returns; an injected exit lets the input loop notice and end
			// RunWorker.
			select {
			case <-done:
			default:
				close(done)
			}
		})
	}
	heartbeats.line(struct {
		T    string `json:"t"`
		Port int    `json:"port"`
	}{T: "listening", Port: listener.Addr().(*net.TCPAddr).Port})
	heartbeatMs := options.HeartbeatMs
	if heartbeatMs == 0 {
		heartbeatMs = 1000
	}
	ticker := time.NewTicker(time.Duration(heartbeatMs) * time.Millisecond)
	go func() {
		for range ticker.C {
			heartbeats.line(struct {
				T   string  `json:"t"`
				Rss float64 `json:"rss"`
			}{T: "hb", Rss: workerRssMb()})
		}
	}()
	var draining sync.Once
	drain := func(ms int64) {
		if ms == 0 {
			ms = 600_000
		}
		draining.Do(func() {
			ticker.Stop()
			// Shutdown owns the drain's order: it stops accepting, closes exactly the idle
			// sockets and lets the busy ones finish, so a socket carrying a request is never
			// swept from under it (a socket accepted but not yet read is Shutdown's to close
			// too; the request on it dies unread). The sweep follows Shutdown instead of racing
			// it — the chaos suite counts zero failed requests through a hot update's recycle —
			// and the deadline below still ends a worker that never goes quiet.
			go func() {
				_ = server.Shutdown(context.Background())
				connections.Drain()
				finish(0)
			}()
			time.AfterFunc(time.Duration(ms)*time.Millisecond, func() { finish(0) })
		})
	}
	messages := make(chan []byte)
	go func() {
		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			// The scanner reuses its buffer; the line belongs to the loop below.
			messages <- append([]byte(nil), scanner.Bytes()...)
		}
		close(messages)
	}()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	for {
		select {
		case raw, ok := <-messages:
			if !ok {
				// The front is gone (killed): nobody routes to this worker any more.
				finish(0)
				<-done
				return
			}
			workerMessage(raw, heartbeats, drain, core.keys)
		case <-signals:
			drain(10_000)
		case <-done:
			return
		}
	}
}

// workerMessage acts on one IPC message: a drain, or a key check (answered from the same cache
// the requests serve from, so a check never starts a second store read).
func workerMessage(raw []byte, send *workerSender, drain func(ms int64), keys *keyCache) {
	message := parseBodyNode(raw)
	if !message.isObject() {
		return
	}
	switch nodeText(message.get("t")) {
	case "drain":
		ms := int64(0)
		if node := message.get("ms"); node != nil && node.kind == jsonNumber {
			if value, err := node.num.Float64(); err == nil {
				ms = int64(value)
			}
		}
		drain(ms)
	case "key":
		id := nodeText(message.get("id"))
		if id == "" {
			return
		}
		answer := struct {
			T      string `json:"t"`
			Id     string `json:"id"`
			OK     bool   `json:"ok"`
			Source string `json:"source,omitempty"`
			Error  string `json:"error,omitempty"`
		}{T: "key", Id: id}
		if found := keys.get(context.Background()); found.key.Value != "" {
			answer.OK = true
			answer.Source = found.key.Source
		} else if found.err != nil {
			answer.Error = string(found.err.Kind)
		} else {
			answer.Error = string(ports.WorkerErrorNoKey)
		}
		send.line(answer)
	}
}

// workerKey is the provider key the way setup reads it (env, OS store, key file), never logged.
func workerKey(ctx context.Context, provider domain.Provider, env domain.EnvLookup) (ports.ProviderKey, *ports.WorkerError) {
	store := keystore.PlatformKeyStore(provider, env, keystore.PlatformOptions{})
	return adapters.LoadKey(ctx, provider, env, provider.KeyFile, store)
}

// workerRssMb is the worker's resident size in MB, the number the front's memory limit reads:
// /proc's resident pages where there is a /proc, the runtime's view of its own memory elsewhere.
func workerRssMb() float64 {
	if data, err := os.ReadFile("/proc/self/statm"); err == nil {
		if fields := strings.Fields(string(data)); len(fields) >= 2 {
			if pages, err := strconv.ParseFloat(fields[1], 64); err == nil {
				return pages * float64(os.Getpagesize()) / (1024 * 1024)
			}
		}
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	return float64(mem.Sys) / (1024 * 1024)
}
