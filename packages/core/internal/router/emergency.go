// The emergency passthrough: what `start` runs on the router port when the main router cannot
// start at all (a bundle broken by an update, a syntax error, a missing module). It is a pure
// Anthropic pipe with nothing to break: it sends every request that is not for this provider's
// models to Anthropic untouched and answers the provider's models 503 with what to run. Its health
// answers `"mode":"emergency"`; the next hook retries the main router and takes the port over
// through `/handover`, exactly as a front restart does.
package router

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/spool"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// EmergencyOptions is what the emergency passthrough needs to know.
type EmergencyOptions struct {
	Name       string
	Display    string
	HealthPath string
	// Claim is the resolved provider's model claim: these requests are answered 503.
	Claim     domain.ModelClaim
	Port      int
	Anthropic *url.URL
	Env       ProxyEnv
	// Token is the pid file's token, for `/handover`.
	Token string
	Log   func(line string)
	// Events is Radar's spool: one `fallback` health event per request served here.
	Events func(event domain.SpoolEvent)
	// Done is called once a handover has drained the last connection.
	Done func()
}

// StartEmergency starts the emergency server on its port; it returns once the server listens.
func StartEmergency(ctx context.Context, options EmergencyOptions) (*http.Server, error) {
	var accepting atomic.Bool
	accepting.Store(true)
	connections := TrackConnections(func(open int) {
		if !accepting.Load() && open == 0 && options.Done != nil {
			options.Done()
		}
	})
	passthrough := PassthroughOptions{
		Name:      options.Name,
		Display:   options.Display,
		Claim:     options.Claim,
		Anthropic: options.Anthropic,
		Env:       options.Env,
		State:     "in emergency passthrough (the main router could not start)",
		Log:       options.Log,
	}
	var server *http.Server
	handover := func(req *http.Request, res *Response) {
		if req.Header.Get(TokenHeader) != options.Token {
			AnthropicError(res, 403, "permission_error", options.Name+" router: control refused")
			return
		}
		res.Header().Set("Content-Type", "application/json")
		res.Header().Set("Connection", "close")
		res.WriteHeader(200)
		res.End([]byte(`{"ok":true}`))
		accepting.Store(false)
		// Node's server.close() only stops accepting and lets in-flight answers finish; Go's Close
		// would cut them, so Shutdown runs in its own goroutine (it waits for this very handler).
		go func() { _ = server.Shutdown(context.Background()) }()
		connections.Drain()
		if connections.Size() == 0 && options.Done != nil {
			options.Done()
		}
	}
	server = Harden(&http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		res := NewResponse(w)
		if RefuseHost(r, res, options.Name, []int{options.Port}) {
			return
		}
		if !accepting.Load() {
			res.Header().Set("Connection", "close")
		}
		if r.Method == http.MethodGet && r.URL.Path == options.HealthPath {
			res.Header().Set("Content-Type", "application/json")
			res.WriteHeader(200)
			res.End([]byte(marshalCompact(struct {
				OK       bool   `json:"ok"`
				Mode     string `json:"mode"`
				Name     string `json:"name"`
				Provider string `json:"provider"`
			}{OK: true, Mode: "emergency", Name: options.Name, Provider: options.Display})))
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == options.HealthPath+"/handover" {
			handover(r, res)
			return
		}
		Receive(r, res, options.Name, BodyLimitBytes, func(body []byte) {
			if options.Events != nil {
				options.Events(domain.HealthEvent(options.Name, domain.HealthFallback,
					"emergency passthrough", RequestModel(body), time.Now().UnixMilli()))
			}
			PassThrough(passthrough, r, res, body)
		})
	})})
	connections.Watch(server)
	listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(options.Port))
	if err != nil {
		return nil, err
	}
	go func() { _ = server.Serve(listener) }()
	return server, nil
}

// EmergencyProvider is the provider subset the emergency bundle's entry reads from the
// environment's owner.
type EmergencyProvider struct {
	Name       string
	Display    string
	EnvPrefix  string
	HealthPath string
	Port       int
	Claim      domain.ModelClaim
}

// RunEmergency is the emergency bundle's entry: everything from the environment the starter set,
// then serve until handed over (or told to go). A nil exit is os.Exit.
func RunEmergency(provider EmergencyProvider, env domain.EnvLookup, exit func(code int)) error {
	if exit == nil {
		exit = os.Exit
	}
	prefix := provider.EnvPrefix
	stateRoot := envOrDefault(env, prefix+"_STATE_DIR", ".")
	log := RotatingLog(domain.NewStateLayout(stateRoot).RouterLog, nil, 0)
	// A panic in the entry logs a crash line and exits 1, the closest a Go process comes to Node's
	// process-wide handlers.
	crash := InstallCrashHandlers(RoleEmergency, stateRoot, "emergency", nil, nil)
	defer exitOnPanic("passthrough", crash, log, stateRoot)()
	anthropicURL := envOrDefault(env, prefix+"_ROUTER_ANTHROPIC_URL", "https://api.anthropic.com")
	anthropic, err := url.Parse(anthropicURL)
	if err != nil {
		return err
	}
	port := portFromEnv(env, prefix+"_ROUTER_PORT", provider.Port)
	// Registered before the server starts, so a signal that lands while it comes up is still
	// ours.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer signal.Stop(signals)
	handed := make(chan struct{})
	server, err := StartEmergency(context.Background(), EmergencyOptions{
		Name:       provider.Name,
		Display:    provider.Display,
		HealthPath: provider.HealthPath,
		Claim:      provider.Claim,
		Port:       port,
		Anthropic:  anthropic,
		Env:        ProxyEnv(env),
		Token:      envOrDefault(env, prefix+"_ROUTER_TOKEN", ""),
		Log:        log,
		Events:     spool.CreateSpoolWriter(env, log, nil),
		Done:       func() { close(handed) },
	})
	if err != nil {
		return err
	}
	log(provider.Name + "-router emergency passthrough listening on 127.0.0.1")
	select {
	case <-handed:
		log(provider.Name + "-router: handed over to the new router; exiting")
		markLoggedExit(stateRoot)
	case got := <-signals:
		log(fmt.Sprintf("%s-router: exiting on %s", provider.Name, termSignalName(got)))
		markLoggedExit(stateRoot)
	}
	exit(0)
	// os.Exit never returns; an injected exit (the tests) lets the caller wind the server down.
	_ = server.Close()
	return nil
}

// portFromEnv is `Number(env[name]) || fallback`: an unset, empty or unparsable value falls back,
// and so does 0 (surrounding spaces are trimmed first).
func portFromEnv(env domain.EnvLookup, name string, fallback int) int {
	raw, ok := env[name]
	if !ok {
		return fallback
	}
	port, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || port == 0 {
		return fallback
	}
	return port
}

// envOrDefault is `env[name] ?? fallback`: a present empty string stands, a missing key falls
// back.
func envOrDefault(env domain.EnvLookup, name, fallback string) string {
	if value, ok := env[name]; ok {
		return value
	}
	return fallback
}
