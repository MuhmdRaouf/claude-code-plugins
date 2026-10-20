// The front as an HTTPS proxy: CONNECT in, api.anthropic.com decrypted with the local CA and
// routed exactly as base-URL mode routes it, every other host tunnelled blind. Every upstream in
// here is a fake the tests reach through the front's own hooks — a fake Anthropic, a fake
// provider, a fake other host — and no test dials a real one.
package router

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/localca"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// connectSetup is what one connect rig changes.
type connectSetup struct {
	// brokenCA plants an unreadable ca.key: the CA cannot load.
	brokenCA bool
	// noDialHook leaves FrontOptions.Dial nil: the front dials through the user's proxy or
	// directly.
	noDialHook bool
	// viaUserProxy points the front's environment at the fake user proxy (r.proxyOfProxy), so the
	// blind tunnels go through it.
	viaUserProxy bool
	// env is extra proxy environment for the front.
	env ProxyEnv
}

// connectRig is a started front with a real router worker behind it, a fake Anthropic, a fake
// provider, a fake other host behind CONNECT other.test:443, and the clock the front reads.
type connectRig struct {
	t            *testing.T
	front        *Front
	port         int
	roots        *x509.CertPool
	notes        *focusNotes
	workerLog    *lineLog
	anthropic    *fakeAnthropic
	provider     *url.URL
	providerSeen *seenList
	other        *httptest.Server
	realTarget   *httptest.Server
	proxyOfProxy *httptest.Server
	proxySeen    *seenList
	clock        *atomic.Int64

	mu      sync.Mutex
	dials   []string
	targets map[string]string
	workers []*connectWorker
}

func newConnectRig(t *testing.T, setup connectSetup) *connectRig {
	t.Helper()
	port := freeRouterPort(t)
	now := &atomic.Int64{}
	now.Store(time.Now().UnixMilli())
	r := &connectRig{
		t:            t,
		port:         port,
		notes:        &focusNotes{},
		workerLog:    &lineLog{},
		anthropic:    newFakeAnthropic(t),
		providerSeen: &seenList{},
		proxySeen:    &seenList{},
		clock:        now,
	}
	// The CA: shared with the front through its directory, trusted by the clients through its
	// certificate.
	caDir := t.TempDir()
	r.roots = x509.NewCertPool()
	if setup.brokenCA {
		if err := os.WriteFile(filepath.Join(caDir, "ca.key"), []byte("not a ca"), 0o644); err != nil {
			t.Fatal(err)
		}
	} else {
		ca, err := localca.LoadOrCreate(context.Background(), caDir, time.UnixMilli(now.Load()))
		if err != nil {
			t.Fatal(err)
		}
		r.roots.AddCert(ca.Certificate())
	}
	// The fake other host and the fake real target, each with a certificate of its own; the
	// front's Dial hook is the only way a test reaches them.
	r.other = fakeTLSServer(t, "hello from other")
	r.realTarget = fakeTLSServer(t, "the real target")
	r.targets = map[string]string{
		"other.test:443":        hostPortOf(t, r.other.URL),
		"api.anthropic.com:443": hostPortOf(t, r.realTarget.URL),
	}
	// The user's own proxy a blind tunnel may be sent through (TestConnectProxiedDial): it records
	// every CONNECT and echoes the bytes after it.
	r.proxyOfProxy = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodConnect {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		r.proxySeen.record(req.RequestURI, req.Header, "")
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		conn, rw, err := hijacker.Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		if _, err := conn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n")); err != nil {
			return
		}
		_, _ = io.Copy(conn, rw)
	}))
	t.Cleanup(r.proxyOfProxy.Close)
	// The fake provider, exactly the upstream TestRouting records against.
	r.provider = recordingUpstream(t, "provider", "/api/anthropic", r.providerSeen)
	// The worker behind the front is the real router: model requests are routed the way they are
	// in base-URL mode.
	fork := func(string, string) (WorkerHandle, error) {
		worker := newConnectWorker(RouterOptions{
			Provider:    routerProvider,
			Anthropic:   r.anthropic.url,
			ProviderURL: r.provider,
			Key:         func(context.Context) (string, error) { return "provider-secret", nil },
			Log:         r.workerLog.add,
			Token:       focusToken,
			Env:         ProxyEnv{},
		})
		r.mu.Lock()
		r.workers = append(r.workers, worker)
		r.mu.Unlock()
		return worker, nil
	}
	dial := r.dial
	if setup.noDialHook {
		dial = nil
	}
	env := ProxyEnv{}
	for name, value := range setup.env {
		env[name] = value
	}
	if setup.viaUserProxy {
		env["HTTPS_PROXY"] = r.proxyOfProxy.URL
	}
	options := FrontOptions{
		Name:       "acme",
		Display:    "Acme Models",
		HealthPath: focusHealth,
		Claim:      domain.ModelClaim{Prefixes: []string{"big-"}},
		Port:       port,
		Anthropic:  r.anthropic.url,
		Env:        env,
		CADir:      caDir,
		Dial:       dial,
		Version:    "v1",
		Token:      focusToken,
		Fork:       fork,
		Knobs:      focusRigKnobs(FrontKnobs{}),
		Note:       r.notes.add,
		Now:        func() int64 { return now.Load() },
		Done:       func() {},
	}
	r.front = CreateFront(options)
	t.Cleanup(r.front.Close)
	t.Cleanup(func() {
		for _, worker := range r.snapshotWorkers() {
			worker.stop("")
		}
	})
	bound, err := r.front.Start()
	if err != nil {
		t.Fatalf("front start: %v", err)
	}
	r.port = bound
	return r
}

func (r *connectRig) snapshotWorkers() []*connectWorker {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*connectWorker(nil), r.workers...)
}

// dial is the front's blind-tunnel hook: each fake host's name goes to the fake listening for it,
// and every dial is counted so the refusals prove no tunnel was opened.
func (r *connectRig) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	r.mu.Lock()
	r.dials = append(r.dials, addr)
	target, ok := r.targets[addr]
	r.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("no fake target for %s", addr)
	}
	var dialer net.Dialer
	return dialer.DialContext(ctx, network, target)
}

func (r *connectRig) dialed() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.dials...)
}

// targetFor teaches the dial hook one more fake host: the CONNECT authority name goes to the
// server listening for it.
func (r *connectRig) targetFor(name string, server *httptest.Server) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.targets[name] = hostPortOf(r.t, server.URL)
}

// client is an HTTP client the way Claude Code runs in proxy mode: the front as its proxy, the
// local CA as a root.
func (r *connectRig) client() *http.Client {
	return &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			Proxy: func(*http.Request) (*url.URL, error) {
				return &url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", r.port)}, nil
			},
			TLSClientConfig:   &tls.Config{RootCAs: r.roots},
			DisableKeepAlives: true,
		},
	}
}

// tlsConfig is the client side of a handshake with whatever answers the tunnel: the local CA's
// time, so a re-signed leaf is judged by the clock the front signs with.
func (r *connectRig) tlsConfig(serverName string) *tls.Config {
	return &tls.Config{
		ServerName: serverName,
		RootCAs:    r.roots,
		NextProtos: []string{"http/1.1"},
		Time:       func() time.Time { return time.UnixMilli(r.clock.Load()) },
	}
}

// waitWorkerUp waits for the real worker behind the front.
func (r *connectRig) waitWorkerUp() {
	r.t.Helper()
	waitUntil(r.t, 4*time.Second, func() bool { return r.front.Status().Worker == "up" })
}

// fakeTLSServer is one HTTPS fake with a certificate of its own, for the blind tunnels.
func fakeTLSServer(t *testing.T, answer string) *httptest.Server {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_, _ = io.WriteString(w, answer)
	}))
	t.Cleanup(server.Close)
	return server
}

func hostPortOf(t *testing.T, raw string) string {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed.Host
}

// fakeAnthropic is the api.anthropic.com stand-in: it records what it was handed, streams
// /v1/messages in two events 150 ms apart, upgrades websockets and echoes their bytes, and
// answers everything else with a line naming what arrived.
type fakeAnthropic struct {
	server *httptest.Server
	url    *url.URL
	seen   *seenList
}

func newFakeAnthropic(t *testing.T) *fakeAnthropic {
	t.Helper()
	fake := &fakeAnthropic{seen: &seenList{}}
	handler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body := ""
		if !upgradeRequested(req) {
			raw, err := ReadBody(req, BodyLimitBytes)
			if err != nil {
				return
			}
			body = string(raw)
		}
		fake.seen.record(pathOf(req), req.Header, body)
		switch {
		case upgradeRequested(req):
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			conn, rw, err := hijacker.Hijack()
			if err != nil {
				return
			}
			defer conn.Close()
			if _, err := conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")); err != nil {
				return
			}
			_, _ = io.Copy(conn, rw)
		case req.URL.Path == "/v1/messages":
			res := NewResponse(w)
			res.Header().Set("Content-Type", "text/event-stream")
			res.WriteHeader(200)
			res.Write([]byte("data: anthropic-1\n\n"))
			time.Sleep(150 * time.Millisecond)
			res.End([]byte("data: anthropic-2\n\n"))
		default:
			res := NewResponse(w)
			res.Header().Set("Content-Type", "text/plain")
			res.Header().Set("X-Fake-Anthropic", "yes")
			res.WriteHeader(200)
			res.End([]byte(fmt.Sprintf("anthropic %s %s\n%s", req.Method, pathOf(req), body)))
		}
	})
	fake.server = httptest.NewServer(handler)
	t.Cleanup(fake.server.Close)
	parsed, err := url.Parse(fake.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	fake.url = parsed
	return fake
}

func upgradeRequested(req *http.Request) bool {
	return strings.EqualFold(req.Header.Get("Upgrade"), "websocket") && len(req.Header.Values("Connection")) > 0
}

// connectWorker is the front's fork for these tests: the real router server on a loopback port,
// reporting itself, heartbeating and draining the way a forked worker's IPC pipes do.
type connectWorker struct {
	pid    int
	server *http.Server

	mu              sync.Mutex
	messageListener func([]byte)
	queued          [][]byte
	exitListener    func(int, string)
	exitReady       bool
	exitDelivered   bool
	heartbeats      *time.Ticker
	kick            chan struct{}
}

func newConnectWorker(options RouterOptions) *connectWorker {
	w := &connectWorker{pid: 80000 + int(focusNextPid.Add(1)), kick: make(chan struct{}, 1)}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err == nil {
		w.server = CreateRouter(options)
		go func() { _ = w.server.Serve(listener) }()
		w.message([]byte(`{"t":"listening","port":` + strconv.Itoa(listener.Addr().(*net.TCPAddr).Port) + `}`))
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
	go w.deliverLoop()
	return w
}

func (w *connectWorker) Pid() int { return w.pid }

func (w *connectWorker) OnMessage(listener func([]byte)) {
	w.mu.Lock()
	w.messageListener = listener
	w.mu.Unlock()
	w.wake()
}

func (w *connectWorker) OnExit(listener func(int, string)) {
	w.mu.Lock()
	w.exitListener = listener
	w.mu.Unlock()
	w.wake()
}

// message is the worker's side of the IPC channel.
func (w *connectWorker) message(value []byte) {
	w.mu.Lock()
	w.queued = append(w.queued, value)
	w.mu.Unlock()
	w.wake()
}

// deliverLoop hands the queued messages, then the exit, to the registered listeners, one at a
// time and off every caller's stack (see focusWorker's comment for why).
func (w *connectWorker) deliverLoop() {
	for {
		w.mu.Lock()
		var next []byte
		listener := w.messageListener
		if listener != nil && len(w.queued) > 0 {
			next = w.queued[0]
			w.queued = w.queued[1:]
		}
		var exitListener func(int, string)
		if next == nil && w.exitReady && !w.exitDelivered && w.exitListener != nil {
			exitListener = w.exitListener
			w.exitDelivered = true
		}
		w.mu.Unlock()
		switch {
		case next != nil:
			listener(next)
		case exitListener != nil:
			exitListener(0, "")
			return
		default:
			<-w.kick
		}
	}
}

func (w *connectWorker) wake() {
	select {
	case w.kick <- struct{}{}:
	default:
	}
}

func (w *connectWorker) Send(message []byte) {
	var parsed struct {
		T string `json:"t"`
	}
	_ = json.Unmarshal(message, &parsed)
	if parsed.T == "drain" {
		w.mu.Lock()
		if w.heartbeats != nil {
			w.heartbeats.Stop()
			w.heartbeats = nil
		}
		w.mu.Unlock()
		go w.stop("")
	}
}

func (w *connectWorker) Kill(signal string) {
	go w.stop(signal)
}

func (w *connectWorker) stop(signal string) {
	w.mu.Lock()
	if w.exitReady {
		w.mu.Unlock()
		return
	}
	w.exitReady = true
	server, heartbeats := w.server, w.heartbeats
	w.heartbeats = nil
	w.mu.Unlock()
	if heartbeats != nil {
		heartbeats.Stop()
	}
	if server != nil {
		_ = server.Close()
	}
	w.wake()
}

// connectThrough opens a CONNECT tunnel through the front and returns the socket once the front
// has answered, with its answer.
func connectThrough(t *testing.T, port int, target string) (net.Conn, *http.Response) {
	t.Helper()
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	request := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	answer, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	return conn, answer
}

// refuseBody is the body of a refused CONNECT, read to the end.
func refuseBody(t *testing.T, answer *http.Response) string {
	t.Helper()
	text, err := io.ReadAll(answer.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func TestConnect(t *testing.T) {
	t.Parallel()

	// (a) A claude model request through the front reaches the fake Anthropic whole, and its
	// streamed answer arrives chunk by chunk.
	t.Run("routes a claude model request to the fake Anthropic, streaming chunk by chunk", func(t *testing.T) {
		t.Parallel()
		r := newConnectRig(t, connectSetup{})
		r.waitWorkerUp()
		body := `{"model":"claude-opus-5","messages":[],"stream":true}`
		request, err := http.NewRequest(http.MethodPost, "https://api.anthropic.com/v1/messages?beta=true", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Api-Key", "anthropic-key")
		request.Header.Set("Authorization", "Bearer anthropic-oauth")
		request.Header.Set("Anthropic-Beta", "claude-code-20250219")
		request.Header.Set("Anthropic-Version", "2023-06-01")
		answer, err := r.client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer answer.Body.Close()
		if answer.StatusCode != 200 {
			t.Fatalf("status = %d", answer.StatusCode)
		}
		reader := bufio.NewReader(answer.Body)
		first := make([]byte, len("data: anthropic-1\n\n"))
		started := time.Now()
		if _, err := io.ReadFull(reader, first); err != nil {
			t.Fatal(err)
		}
		// The first event was answerable before the fake had written the second: the answer
		// streamed instead of arriving whole.
		if elapsed := time.Since(started); elapsed > 140*time.Millisecond {
			t.Fatalf("the first event took %s, the whole answer was buffered", elapsed)
		}
		if string(first) != "data: anthropic-1\n\n" {
			t.Fatalf("first chunk = %q", string(first))
		}
		rest, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		if string(rest) != "data: anthropic-2\n\n" {
			t.Fatalf("rest = %q", string(rest))
		}
		seen := r.anthropic.seen.list()
		if len(seen) != 1 {
			t.Fatalf("Anthropic saw %d requests", len(seen))
		}
		if seen[0].path != "/v1/messages?beta=true" {
			t.Errorf("path = %q", seen[0].path)
		}
		if seen[0].body != body {
			t.Errorf("body = %q, want it intact", seen[0].body)
		}
		for name, want := range map[string]string{
			"X-Api-Key":         "anthropic-key",
			"Authorization":     "Bearer anthropic-oauth",
			"Anthropic-Beta":    "claude-code-20250219",
			"Anthropic-Version": "2023-06-01",
		} {
			if got := seen[0].headers.Get(name); got != want {
				t.Errorf("%s = %q, want %q", name, got, want)
			}
		}
	})

	// (b) A provider model request through the front is routed to the provider exactly as
	// base-URL mode routes it.
	t.Run("routes a provider model to the fake provider, as base-URL mode does", func(t *testing.T) {
		t.Parallel()
		r := newConnectRig(t, connectSetup{})
		r.waitWorkerUp()
		got, err := postViaProxy(r.client(), "https://api.anthropic.com/v1/messages?beta=true",
			`{"model":"glm-5.3-flash","messages":[]}`, map[string]string{"X-Api-Key": "anthropic-key"})
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 200 {
			t.Fatalf("status = %d", got.status)
		}
		if got.body != "data: provider-1\n\ndata: provider-2\n\n" {
			t.Errorf("body = %q", got.body)
		}
		if r.anthropic.seen.len() != 0 {
			t.Error("the request reached Anthropic")
		}
		seen := r.providerSeen.list()
		if len(seen) != 1 {
			t.Fatalf("the provider saw %d requests", len(seen))
		}
		if seen[0].path != "/api/anthropic/v1/messages?beta=true" {
			t.Errorf("path = %q", seen[0].path)
		}
		if header := seen[0].headers.Get("Authorization"); header != "Bearer provider-secret" {
			t.Errorf("authorization = %q", header)
		}
		if header := seen[0].headers.Get("X-Api-Key"); header != "" {
			t.Errorf("x-api-key = %q, want none", header)
		}
	})

	// (c) Anthropic's other endpoints pass through to the fake Anthropic without the worker.
	t.Run("passes Anthropic's other endpoints through without the worker", func(t *testing.T) {
		t.Parallel()
		r := newConnectRig(t, connectSetup{})
		got, err := getViaProxy(r.client(), "https://api.anthropic.com/api/claude_code/settings?x=1")
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 200 {
			t.Fatalf("status = %d", got.status)
		}
		if header := got.header.Get("X-Fake-Anthropic"); header != "yes" {
			t.Errorf("x-fake-anthropic = %q", header)
		}
		if want := "anthropic GET /api/claude_code/settings?x=1\n"; got.body != want {
			t.Errorf("body = %q, want %q", got.body, want)
		}
		batch, err := postViaProxy(r.client(), "https://api.anthropic.com/api/event_logging/v2/batch", `{"events":[1,2]}`, nil)
		if err != nil {
			t.Fatal(err)
		}
		if want := "anthropic POST /api/event_logging/v2/batch\n{\"events\":[1,2]}"; batch.body != want {
			t.Errorf("batch body = %q, want %q", batch.body, want)
		}
		seen := r.anthropic.seen.list()
		if len(seen) != 2 {
			t.Fatalf("Anthropic saw %d requests, want 2", len(seen))
		}
		if seen[0].path != "/api/claude_code/settings?x=1" || seen[1].path != "/api/event_logging/v2/batch" {
			t.Errorf("paths = %q, %q", seen[0].path, seen[1].path)
		}
		// None of it went through f.route: the worker never heard of these paths.
		for _, line := range r.workerLog.list() {
			if strings.Contains(line, "/api/claude_code") || strings.Contains(line, "/api/event_logging") {
				t.Errorf("the worker handled a pass-through request: %q", line)
			}
		}
	})

	// (d) A websocket upgrade to api.anthropic.com is relayed both ways.
	t.Run("relays a websocket upgrade both ways", func(t *testing.T) {
		t.Parallel()
		r := newConnectRig(t, connectSetup{})
		conn, answer := connectThrough(t, r.port, "api.anthropic.com:443")
		defer conn.Close()
		if answer.StatusCode != 200 {
			t.Fatalf("CONNECT = %d", answer.StatusCode)
		}
		tlsConn := tls.Client(conn, r.tlsConfig(localca.Host))
		tlsConn.SetDeadline(time.Now().Add(10 * time.Second))
		if err := tlsConn.HandshakeContext(context.Background()); err != nil {
			t.Fatal(err)
		}
		state := tlsConn.ConnectionState()
		if state.NegotiatedProtocol != "http/1.1" {
			t.Errorf("negotiated protocol = %q, want http/1.1", state.NegotiatedProtocol)
		}
		if len(state.PeerCertificates) == 0 || len(state.PeerCertificates[0].DNSNames) != 1 ||
			state.PeerCertificates[0].DNSNames[0] != localca.Host {
			t.Fatalf("the handshake was not with a leaf for %s", localca.Host)
		}
		upgrade := "GET /ws HTTP/1.1\r\nHost: api.anthropic.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
		if _, err := tlsConn.Write([]byte(upgrade)); err != nil {
			t.Fatal(err)
		}
		answer101, err := http.ReadResponse(bufio.NewReader(tlsConn), &http.Request{Method: http.MethodGet})
		if err != nil {
			t.Fatal(err)
		}
		if answer101.StatusCode != http.StatusSwitchingProtocols {
			t.Fatalf("upgrade = %d, want 101", answer101.StatusCode)
		}
		if _, err := tlsConn.Write([]byte("tunnel-echo")); err != nil {
			t.Fatal(err)
		}
		echoed := make([]byte, len("tunnel-echo"))
		if _, err := io.ReadFull(tlsConn, echoed); err != nil {
			t.Fatal(err)
		}
		if string(echoed) != "tunnel-echo" {
			t.Fatalf("echo = %q", string(echoed))
		}
	})

	// (e) CONNECT other.test:443 is a blind tunnel: the handshake is with the fake other host's
	// own certificate, never the local CA's.
	t.Run("tunnels another host blind, its handshake with that host", func(t *testing.T) {
		t.Parallel()
		r := newConnectRig(t, connectSetup{})
		conn, answer := connectThrough(t, r.port, "other.test:443")
		defer conn.Close()
		if answer.StatusCode != 200 {
			t.Fatalf("CONNECT = %d", answer.StatusCode)
		}
		tlsConn := tls.Client(conn, &tls.Config{ServerName: "other.test", InsecureSkipVerify: true})
		tlsConn.SetDeadline(time.Now().Add(10 * time.Second))
		if err := tlsConn.HandshakeContext(context.Background()); err != nil {
			t.Fatal(err)
		}
		peer := tlsConn.ConnectionState().PeerCertificates[0]
		if !bytes.Equal(peer.Raw, r.other.Certificate().Raw) {
			t.Fatal("the handshake was not with the other host's own certificate")
		}
		if _, err := tlsConn.Write([]byte("GET /hello HTTP/1.1\r\nHost: other.test\r\nConnection: close\r\n\r\n")); err != nil {
			t.Fatal(err)
		}
		text, err := io.ReadAll(tlsConn)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(text), "hello from other") {
			t.Fatalf("answer = %q", string(text))
		}
	})

	// (f) A tunnel the front must not open is refused with a 403 and never dialled. Every port on
	// a remote host is tunnelled (TestConnectPorts), so only the local names and the portless
	// authority stay in this list.
	t.Run("refuses the tunnels it must not open", func(t *testing.T) {
		t.Parallel()
		r := newConnectRig(t, connectSetup{})
		for _, target := range []string{"127.0.0.1:443", "[::1]:443", "localhost:443", "LOCALHOST:443", "api.localhost:443", "portless.test"} {
			conn, answer := connectThrough(t, r.port, target)
			if answer.StatusCode != 403 {
				conn.Close()
				t.Fatalf("CONNECT %s = %d, want 403", target, answer.StatusCode)
			}
			body := refuseBody(t, answer)
			conn.Close()
			if !strings.Contains(body, `"type":"error"`) {
				t.Fatalf("CONNECT %s body = %q, want the Anthropic error shape", target, body)
			}
		}
		if dialed := r.dialed(); len(dialed) != 0 {
			t.Fatalf("the front dialled %v for refused CONNECTs", dialed)
		}
	})

	// (g) When the CA cannot load, CONNECT api.anthropic.com:443 still works: a blind tunnel to
	// the real target, one log line for the episode.
	t.Run("falls back to a blind tunnel when the CA cannot load, and says so once", func(t *testing.T) {
		t.Parallel()
		r := newConnectRig(t, connectSetup{brokenCA: true})
		tunnel := func() {
			conn, answer := connectThrough(t, r.port, "api.anthropic.com:443")
			defer conn.Close()
			if answer.StatusCode != 200 {
				t.Fatalf("CONNECT = %d, want nothing refused", answer.StatusCode)
			}
			tlsConn := tls.Client(conn, &tls.Config{ServerName: localca.Host, InsecureSkipVerify: true})
			tlsConn.SetDeadline(time.Now().Add(10 * time.Second))
			if err := tlsConn.HandshakeContext(context.Background()); err != nil {
				t.Fatal(err)
			}
			if peer := tlsConn.ConnectionState().PeerCertificates[0]; !bytes.Equal(peer.Raw, r.realTarget.Certificate().Raw) {
				t.Fatal("the client did not see the real target's certificate")
			}
		}
		tunnel()
		tunnel()
		// An hour later the front tries the CA again; the failure is still one episode.
		r.clock.Add(61 * 1000)
		tunnel()
		lines := 0
		for _, line := range strings.Split(r.notes.joined(), "\n") {
			if strings.Contains(line, "local CA unusable") {
				lines++
				if !strings.Contains(line, "lets other users in") {
					t.Errorf("the log line does not name the reason: %q", line)
				}
			}
		}
		if lines != 1 {
			t.Fatalf("%d local-CA lines in the log, want one per episode", lines)
		}
	})

	// (h) Base-URL mode is untouched: the same request over http answers as before, and a
	// non-CONNECT request naming api.anthropic.com is still refused.
	t.Run("keeps base-URL mode and the Host refusal as they were", func(t *testing.T) {
		t.Parallel()
		r := newConnectRig(t, connectSetup{})
		r.waitWorkerUp()
		got, err := postRawBody(r.port, "/v1/messages?beta=true", `{"model":"claude-opus-5"}`, map[string]string{
			"Content-Type": "application/json",
		})
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 200 || !strings.Contains(got.body, "data: anthropic-1") {
			t.Fatalf("base-URL post = %d %q", got.status, got.body)
		}
		request, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/anything", r.port), nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Host = "api.anthropic.com"
		answer, err := (&http.Client{Timeout: 30 * time.Second}).Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer answer.Body.Close()
		if answer.StatusCode != 421 {
			t.Fatalf("a non-CONNECT request for api.anthropic.com = %d, want 421", answer.StatusCode)
		}
	})
}

// TestConnectPorts is the port rule: any valid port on a remote host is tunnelled blind, the
// local machine is refused on every port, and only api.anthropic.com:443 is ever decrypted.
func TestConnectPorts(t *testing.T) {
	t.Parallel()

	// (a) A CONNECT to a remote host on a port other than 443 is a blind tunnel like any other:
	// the handshake is with that host and the bytes flow both ways.
	t.Run("tunnels a remote host on a non-443 port, bytes both ways", func(t *testing.T) {
		t.Parallel()
		r := newConnectRig(t, connectSetup{})
		r.targetFor("example.com:8443", r.other)
		conn, answer := connectThrough(t, r.port, "example.com:8443")
		defer conn.Close()
		if answer.StatusCode != 200 {
			t.Fatalf("CONNECT = %d", answer.StatusCode)
		}
		tlsConn := tls.Client(conn, &tls.Config{ServerName: "example.com", InsecureSkipVerify: true})
		tlsConn.SetDeadline(time.Now().Add(10 * time.Second))
		if err := tlsConn.HandshakeContext(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := tlsConn.Write([]byte("GET /hello HTTP/1.1\r\nHost: example.com:8443\r\nConnection: close\r\n\r\n")); err != nil {
			t.Fatal(err)
		}
		text, err := io.ReadAll(tlsConn)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(text), "hello from other") {
			t.Fatalf("answer = %q", string(text))
		}
		if dialed := r.dialed(); len(dialed) != 1 || dialed[0] != "example.com:8443" {
			t.Fatalf("the front dialled %v, want one example.com:8443", dialed)
		}
	})

	// (b) The local-machine refusal is about the target, not the port: any port is refused, and by
	// the local rule, not the port one.
	t.Run("still refuses the local machine on any port", func(t *testing.T) {
		t.Parallel()
		r := newConnectRig(t, connectSetup{})
		for _, target := range []string{"127.0.0.1:8443", "[::1]:9443", "localhost:8443"} {
			conn, answer := connectThrough(t, r.port, target)
			if answer.StatusCode != 403 {
				conn.Close()
				t.Fatalf("CONNECT %s = %d, want 403", target, answer.StatusCode)
			}
			body := refuseBody(t, answer)
			conn.Close()
			if !strings.Contains(body, `"type":"error"`) {
				t.Fatalf("CONNECT %s body = %q, want the Anthropic error shape", target, body)
			}
			if !strings.Contains(body, "may not name this machine") {
				t.Fatalf("CONNECT %s body = %q, want the local-target refusal", target, body)
			}
		}
		if dialed := r.dialed(); len(dialed) != 0 {
			t.Fatalf("the front dialled %v for refused CONNECTs", dialed)
		}
	})

	// (c) The intercepted host on a port other than 443 is a blind tunnel too: the client sees the
	// target's own certificate, never the local CA's leaf.
	t.Run("tunnels the intercepted host on a non-443 port blind", func(t *testing.T) {
		t.Parallel()
		r := newConnectRig(t, connectSetup{})
		r.targetFor("api.anthropic.com:8443", r.realTarget)
		conn, answer := connectThrough(t, r.port, "api.anthropic.com:8443")
		defer conn.Close()
		if answer.StatusCode != 200 {
			t.Fatalf("CONNECT = %d", answer.StatusCode)
		}
		tlsConn := tls.Client(conn, &tls.Config{ServerName: localca.Host, InsecureSkipVerify: true})
		tlsConn.SetDeadline(time.Now().Add(10 * time.Second))
		if err := tlsConn.HandshakeContext(context.Background()); err != nil {
			t.Fatal(err)
		}
		if peer := tlsConn.ConnectionState().PeerCertificates[0]; !bytes.Equal(peer.Raw, r.realTarget.Certificate().Raw) {
			t.Fatal("the handshake was not with the real target's certificate")
		}
		if _, err := tlsConn.Write([]byte("GET / HTTP/1.1\r\nHost: api.anthropic.com:8443\r\nConnection: close\r\n\r\n")); err != nil {
			t.Fatal(err)
		}
		text, err := io.ReadAll(tlsConn)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(text), "the real target") {
			t.Fatalf("answer = %q", string(text))
		}
		if dialed := r.dialed(); len(dialed) != 1 || dialed[0] != "api.anthropic.com:8443" {
			t.Fatalf("the front dialled %v, want one api.anthropic.com:8443", dialed)
		}
	})

	// (d) An authority without a usable port is refused before anything is dialled. A port that is
	// not a number is refused by Go's own server with a bare 400 before the front's handler runs;
	// a missing port, 0 and a port above 65535 reach the front and get the Anthropic 403.
	t.Run("refuses a malformed authority", func(t *testing.T) {
		t.Parallel()
		r := newConnectRig(t, connectSetup{})
		for _, target := range []string{"portless.test", "x.test:0", "x.test:65536", "x.test:99999999999999999999"} {
			conn, answer := connectThrough(t, r.port, target)
			if answer.StatusCode != 403 {
				conn.Close()
				t.Fatalf("CONNECT %s = %d, want 403", target, answer.StatusCode)
			}
			body := refuseBody(t, answer)
			conn.Close()
			if !strings.Contains(body, `"type":"error"`) {
				t.Fatalf("CONNECT %s body = %q, want the Anthropic error shape", target, body)
			}
			if !strings.Contains(body, "a CONNECT names host:port") {
				t.Fatalf("CONNECT %s body = %q, want the port refusal", target, body)
			}
		}
		conn, answer := connectThrough(t, r.port, "x.test:not-a-port")
		if answer.StatusCode != 400 && answer.StatusCode != 403 {
			conn.Close()
			t.Fatalf("CONNECT x.test:not-a-port = %d, want refused", answer.StatusCode)
		}
		conn.Close()
		if dialed := r.dialed(); len(dialed) != 0 {
			t.Fatalf("the front dialled %v for refused CONNECTs", dialed)
		}
	})
}

// proxyAnswer is one answer a proxied request got.
type proxyAnswer struct {
	status int
	header http.Header
	body   string
}

func postViaProxy(client *http.Client, rawURL, body string, headers map[string]string) (proxyAnswer, error) {
	return doViaProxy(http.MethodPost, client, rawURL, body, headers)
}

func getViaProxy(client *http.Client, rawURL string) (proxyAnswer, error) {
	return doViaProxy(http.MethodGet, client, rawURL, "", nil)
}

func doViaProxy(method string, client *http.Client, rawURL, body string, headers map[string]string) (proxyAnswer, error) {
	request, err := http.NewRequest(method, rawURL, strings.NewReader(body))
	if err != nil {
		return proxyAnswer{}, err
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	answer, err := client.Do(request)
	if err != nil {
		return proxyAnswer{}, err
	}
	defer answer.Body.Close()
	text, err := io.ReadAll(answer.Body)
	if err != nil {
		return proxyAnswer{status: answer.StatusCode, header: answer.Header}, err
	}
	return proxyAnswer{status: answer.StatusCode, header: answer.Header, body: string(text)}, nil
}

// TestConnectResign re-signs the leaf only when its life has less than a day left, and the new
// leaf is a fresh certificate.
func TestConnectResign(t *testing.T) {
	t.Parallel()
	r := newConnectRig(t, connectSetup{})
	leafOf := func() []byte {
		conn, answer := connectThrough(t, r.port, "api.anthropic.com:443")
		defer conn.Close()
		if answer.StatusCode != 200 {
			t.Fatalf("CONNECT = %d", answer.StatusCode)
		}
		tlsConn := tls.Client(conn, r.tlsConfig(localca.Host))
		tlsConn.SetDeadline(time.Now().Add(10 * time.Second))
		if err := tlsConn.HandshakeContext(context.Background()); err != nil {
			t.Fatal(err)
		}
		return tlsConn.ConnectionState().PeerCertificates[0].Raw
	}
	first := leafOf()
	r.clock.Add(7 * 24 * time.Hour.Milliseconds())
	second := leafOf()
	if bytes.Equal(first, second) {
		t.Fatal("the leaf was never re-signed")
	}
}

// TestConnectDefaultDial is the blind tunnel without a Dial hook: the front dials through the
// user's own proxy when one applies, else directly.
func TestConnectDefaultDial(t *testing.T) {
	t.Parallel()

	t.Run("dials directly and closes the tunnel when the target cannot be reached", func(t *testing.T) {
		t.Parallel()
		r := newConnectRig(t, connectSetup{noDialHook: true})
		// An address in the documentation range: no DNS, never routed, refused by no rule of the
		// front's — the dial itself is what must fail.
		conn, answer := connectThrough(t, r.port, "203.0.113.1:443")
		defer conn.Close()
		if answer.StatusCode != 200 {
			t.Fatalf("CONNECT = %d", answer.StatusCode)
		}
		tlsConn := tls.Client(conn, &tls.Config{ServerName: "other.test", InsecureSkipVerify: true})
		tlsConn.SetDeadline(time.Now().Add(10 * time.Second))
		if err := tlsConn.HandshakeContext(context.Background()); err == nil {
			t.Fatal("the tunnel stayed open with nothing behind it")
		}
	})

	t.Run("dials through the user's own proxy when the environment names one", func(t *testing.T) {
		t.Parallel()
		r := newConnectRig(t, connectSetup{noDialHook: true, viaUserProxy: true})
		conn, answer := connectThrough(t, r.port, "other.test:443")
		defer conn.Close()
		if answer.StatusCode != 200 {
			t.Fatalf("CONNECT = %d", answer.StatusCode)
		}
		if _, err := conn.Write([]byte("through-the-proxy")); err != nil {
			t.Fatal(err)
		}
		echoed := make([]byte, len("through-the-proxy"))
		conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		if _, err := io.ReadFull(conn, echoed); err != nil {
			t.Fatal(err)
		}
		if string(echoed) != "through-the-proxy" {
			t.Fatalf("echo = %q", string(echoed))
		}
		seen := r.proxySeen.list()
		if len(seen) != 1 || seen[0].path != "other.test:443" {
			t.Fatalf("the user's proxy saw %+v, want one CONNECT other.test:443", seen)
		}
	})
}

// TestInterceptUpstream is the pass-through's own failure: an Anthropic that will not answer
// gets the Anthropic-shaped 502.
func TestInterceptUpstream(t *testing.T) {
	t.Parallel()
	r := newConnectRig(t, connectSetup{})
	r.anthropic.server.Close()
	got, err := getViaProxy(r.client(), "https://api.anthropic.com/api/claude_code/settings")
	if err != nil {
		t.Fatal(err)
	}
	if got.status != 502 {
		t.Fatalf("status = %d, want 502", got.status)
	}
	if !strings.Contains(got.body, `"type":"error"`) {
		t.Fatalf("body = %q, want the Anthropic error shape", got.body)
	}
}

func TestRefuseLocalDial(t *testing.T) {
	t.Parallel()
	for _, address := range []string{"127.0.0.1:443", "[::1]:443", "0.0.0.0:443", "169.254.1.1:443", "[fe80::1]:443"} {
		if err := refuseLocalDial("tcp", address, nil); err == nil {
			t.Errorf("a dial to %s was allowed", address)
		}
	}
	for _, address := range []string{"203.0.113.1:443", "[2001:db8::1]:443"} {
		if err := refuseLocalDial("tcp", address, nil); err != nil {
			t.Errorf("a dial to %s was refused: %v", address, err)
		}
	}
}
