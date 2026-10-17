// The HTTP plumbing every router process shares: the front, the worker and the emergency
// passthrough. Standard library only, so the binary that carries it stays free of any
// dependency. It owns the hardening every server gets, the Anthropic-shaped error, the bounded
// body read, the single-leading-slash path rule, and the upstream request: keep-alive clients,
// the caller's proxy environment, a retry on a socket the upstream had already closed, an idle
// timeout on silence (never a total one) and a client stream that always ends when the upstream
// does.
package router

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/andybalholm/brotli"
)

// ProxyEnv is the environment a router process reads its proxy settings from.
type ProxyEnv map[string]string

// BodyLimitBytes is the largest request body any router process accepts; a larger one gets an
// Anthropic-shaped 413.
const BodyLimitBytes int64 = 64 * 1024 * 1024

// TokenHeader is the header carrying the pid file's token on a control call to a front or an
// emergency passthrough.
const TokenHeader = "x-provider-router-token"

// InspectLimitBytes is the most of an answer an inspection may hold back before deciding; a longer
// one goes out unchanged.
const InspectLimitBytes = 64 * 1024

// idleTimeout is how long an upstream that sends nothing (no headers, no byte of the body) is
// given up on: silence, not a total duration, so a stream that keeps talking is never cut however
// long it runs.
const idleTimeout = 10 * time.Minute

// hopByHop: headers that describe one connection, never the message: they are not copied across
// a hop.
var hopByHop = map[string]bool{
	"connection":          true,
	"content-length":      true,
	"host":                true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"proxy-connection":    true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
}

// responseHop: response headers that describe one hop's connection or framing, not the answer.
// Each server frames the body it sends itself (chunked when no length is known); a copied
// `transfer-encoding: chunked` over a body ended in one piece makes the next hop send it unchunked
// next to a Content-Length, an answer the hop after that rejects as invalid.
var responseHop = map[string]bool{
	"connection":        true,
	"keep-alive":        true,
	"transfer-encoding": true,
}

// anthropicEvent is the error envelope Claude Code reads: {type:"error",error:{type,message}}.
type anthropicEvent struct {
	Type  string          `json:"type"`
	Error anthropicDetail `json:"error"`
}

type anthropicDetail struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// marshalCompact is JSON.stringify: field order as declared, no indentation and no HTML
// escaping.
func marshalCompact(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return strings.TrimSuffix(buffer.String(), "\n")
}

// anthropicErrorJSON is the body of Anthropic's error shape.
func anthropicErrorJSON(typ, message string) string {
	return marshalCompact(anthropicEvent{Type: "error", Error: anthropicDetail{Type: typ, Message: message}})
}

// Response is the client's side of one answer: it knows whether the head already went out and can
// cut the connection the answer was going out on.
type Response struct {
	writer      http.ResponseWriter
	flusher     http.Flusher
	headersSent bool
	ended       bool
	destroyed   bool
}

// NewResponse wraps the client's ResponseWriter.
func NewResponse(writer http.ResponseWriter) *Response {
	flusher, _ := writer.(http.Flusher)
	return &Response{writer: writer, flusher: flusher}
}

// Header is the answer's headers.
func (r *Response) Header() http.Header { return r.writer.Header() }

// HeadersSent reports whether the head already went out.
func (r *Response) HeadersSent() bool { return r.headersSent }

// WritableEnded reports whether the answer was ended.
func (r *Response) WritableEnded() bool { return r.ended }

// Destroyed reports whether the answer was destroyed.
func (r *Response) Destroyed() bool { return r.destroyed }

// WriteHeader sends the head, once.
func (r *Response) WriteHeader(status int) {
	if r.headersSent {
		return
	}
	r.headersSent = true
	r.writer.WriteHeader(status)
}

// Write sends bytes of the answer and flushes them: a streamed answer reaches the client as the
// upstream sends it, never buffered.
func (r *Response) Write(chunk []byte) (int, error) {
	r.headersSent = true
	n, err := r.writer.Write(chunk)
	r.Flush()
	return n, err
}

// End finishes the answer.
func (r *Response) End(chunk []byte) {
	if len(chunk) > 0 {
		r.Write(chunk)
	}
	r.ended = true
	r.Flush()
}

// Flush pushes what was written to the client.
func (r *Response) Flush() {
	if r.flusher != nil {
		r.flusher.Flush()
	}
}

// Destroy cuts the connection the answer was going out on. A head that already went out cannot be
// taken back, so this is the only honest ending left for it.
func (r *Response) Destroy() {
	if r.ended {
		return
	}
	r.destroyed = true
	cut()
}

// MarkDestroyed records the destruction without cutting yet, so a failure's hooks can still run
// before the connection goes down.
func (r *Response) MarkDestroyed() {
	if !r.ended {
		r.destroyed = true
	}
}

// Cut takes down the connection of an answer marked destroyed. Failures mark first and cut after
// their hooks, so the stream ends before the failure reports.
func (r *Response) Cut() {
	if r.destroyed && !r.ended {
		cut()
	}
}

// cut aborts this handler's response: net/http swallows ErrAbortHandler and closes the connection.
func cut() {
	panic(http.ErrAbortHandler)
}

// AnthropicError answers with Anthropic's error shape, so Claude Code shows the message instead of
// a parse failure. A response whose headers already went out is destroyed instead.
func AnthropicError(res *Response, status int, typ, message string) {
	if res.HeadersSent() || res.Destroyed() {
		res.Destroy()
		return
	}
	res.Header().Set("Content-Type", "application/json")
	res.WriteHeader(status)
	res.End([]byte(anthropicErrorJSON(typ, message)))
}

// Harden applies the server settings that never cut a Claude connection: keep-alive longer than
// any client's, a bounded header phase and no request or response timeout at all (long uploads,
// endless streams). Go's server has no total request timeout to turn off; the header timeout is
// the bounded phase.
func Harden(server *http.Server) *http.Server {
	server.IdleTimeout = 120 * time.Second
	server.ReadHeaderTimeout = 125 * time.Second
	server.ReadTimeout = 0
	server.WriteTimeout = 0
	return server
}

// Connections tracks the sockets of one or more servers. A streaming response keeps its socket in
// flight until its last byte, and the router closes sockets itself: Drain ends each socket with no
// request in flight now and each other one as soon as its last response is done, CloseAll ends
// every one at once. Go's own CloseIdleConnections leaves a streaming response open and cannot be
// told apart from an idle one at shutdown time, which is why the router tracks sockets itself.
type Connections struct {
	mu       sync.Mutex
	sockets  map[net.Conn]http.ConnState
	draining bool
	closed   func(open int)
}

// TrackConnections tracks connections; closed runs after each socket closes, with how many are
// still open.
func TrackConnections(closed func(open int)) *Connections {
	if closed == nil {
		closed = func(int) {}
	}
	return &Connections{sockets: map[net.Conn]http.ConnState{}, closed: closed}
}

// Watch tracks this server's sockets from now on. The connection states are the in-flight count:
// a socket is busy exactly from the moment a request reached it to the moment its response is
// fully flushed (Go moves it to StateIdle only after the last byte went out).
func (c *Connections) Watch(server *http.Server) {
	server.ConnState = func(conn net.Conn, state http.ConnState) {
		c.mu.Lock()
		if state == http.StateClosed {
			delete(c.sockets, conn)
			// The callback runs inside the same locked transition as the deletion (delete and
			// closed in one synchronous step): once Size() reports the socket gone, closed has
			// already run for it. The callback must not call back into the tracker, which would
			// deadlock on the lock held here.
			c.closed(len(c.sockets))
			c.mu.Unlock()
			return
		}
		c.sockets[conn] = state
		draining := c.draining
		c.mu.Unlock()
		// Draining: a keep-alive socket whose last response just went out closes now, not at the
		// drain deadline.
		if draining && state == http.StateIdle {
			conn.Close()
		}
	}
}

// Size is the number of open sockets.
func (c *Connections) Size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.sockets)
}

// Drain ends every socket with no request in flight; each other one ends as soon as its last
// response is done.
func (c *Connections) Drain() {
	c.mu.Lock()
	c.draining = true
	var idle []net.Conn
	for conn, state := range c.sockets {
		if state != http.StateActive {
			idle = append(idle, conn)
		}
	}
	c.mu.Unlock()
	for _, conn := range idle {
		conn.Close()
	}
}

// CloseAll ends every tracked socket at once.
func (c *Connections) CloseAll() {
	c.mu.Lock()
	sockets := make([]net.Conn, 0, len(c.sockets))
	for conn := range c.sockets {
		sockets = append(sockets, conn)
	}
	c.mu.Unlock()
	for _, conn := range sockets {
		conn.Close()
	}
}

// SafePath is a request path the router may forward: exactly one leading slash. `//host/x` would
// make the upstream URL resolve to another host, so it is refused (and so is anything absolute).
func SafePath(path string) (string, bool) {
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return "", false
	}
	return path, true
}

// UpstreamURL is the upstream URL: the target's origin, its path prefix, then the request path,
// never resolved against the base.
func UpstreamURL(target *url.URL, path string) (*url.URL, error) {
	return url.Parse(target.Scheme + "://" + target.Host + strings.TrimSuffix(target.Path, "/") + path)
}

// ErrBodyTooLarge is ReadBody's "too-large": the body passed the limit; the rest was drained, not
// buffered.
var ErrBodyTooLarge = errors.New("too-large")

// ReadBody reads the whole body, or reports ErrBodyTooLarge once it passes the limit (the rest is
// drained, not buffered).
func ReadBody(req *http.Request, limit int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(req.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		_, _ = io.Copy(io.Discard, req.Body)
		return nil, ErrBodyTooLarge
	}
	return body, nil
}

// RefuseHost is the Host check every router server runs first (DNS rebinding): true, after
// answering 421, when the request does not name one of the ports as 127.0.0.1 or localhost.
func RefuseHost(req *http.Request, res *Response, name string, ports []int) bool {
	for _, port := range ports {
		host := fmt.Sprintf("127.0.0.1:%d", port)
		if req.Host == host {
			return false
		}
		host = fmt.Sprintf("localhost:%d", port)
		if req.Host == host {
			return false
		}
	}
	AnthropicError(res, 421, "invalid_request_error", name+" router: wrong Host")
	return true
}

// Receive reads a request to be forwarded: a path that would change the host is answered 400, a
// body over the limit 413 (closing the connection; the message names the 64 MiB default even when
// the caller passes a smaller limit — the wording is fixed); otherwise then gets the whole body.
// A request stream that errors destroys the response.
func Receive(req *http.Request, res *Response, name string, limit int64, then func(body []byte)) {
	if _, ok := SafePath(req.RequestURI); !ok {
		AnthropicError(res, 400, "invalid_request_error", name+" router: bad request path")
		return
	}
	body, err := ReadBody(req, limit)
	if err != nil {
		if errors.Is(err, ErrBodyTooLarge) {
			res.Header().Set("Connection", "close")
			AnthropicError(res, 413, "request_too_large", name+" router: request body over 64 MiB")
			return
		}
		res.Destroy()
		return
	}
	then(body)
}

// RequestModel is the `model` field of a JSON body, or "" when there is none (unparsable bodies
// included: never block on them).
func RequestModel(body []byte) string {
	var parsed struct {
		Model any `json:"model"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return ""
	}
	if model, ok := parsed.Model.(string); ok {
		return model
	}
	return ""
}

// WatchClient watches the client's close from the moment its request is in: gone turns true once
// the client has left — a close that fired before this was called included — so nothing is
// forwarded for a request nobody waits for. The request's context is Go's own signal for exactly
// that close.
func WatchClient(req *http.Request) func() bool {
	ctx := req.Context()
	return func() bool {
		select {
		case <-ctx.Done():
			return true
		default:
			return false
		}
	}
}

// ForwardHeaders is the client's headers for the next hop: hop-by-hop ones dropped, Host and
// Content-Length set for the target.
func ForwardHeaders(incoming http.Header, target *url.URL, length int) http.Header {
	out := http.Header{}
	for name, values := range incoming {
		if hopByHop[strings.ToLower(name)] {
			continue
		}
		out[http.CanonicalHeaderKey(name)] = values
	}
	out.Set("Host", target.Host)
	out.Set("Content-Length", strconv.Itoa(length))
	return out
}

// ResponseHeaders is the upstream's response headers for the client: the connection-level ones
// belong to each hop, and so does the framing.
func ResponseHeaders(incoming http.Header) http.Header {
	out := http.Header{}
	for name, values := range incoming {
		if responseHop[strings.ToLower(name)] {
			continue
		}
		out[http.CanonicalHeaderKey(name)] = values
	}
	return out
}

// envValue reads one variable from the proxy environment, lowercase first, trimmed; an empty value
// counts as unset.
func envValue(env ProxyEnv, name string) (string, bool) {
	for _, key := range []string{strings.ToLower(name), strings.ToUpper(name)} {
		if value, present := env[key]; present && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value), true
		}
	}
	return "", false
}

// splitNoProxy splits a NO_PROXY list on runs of spaces and commas, dropping empties.
func splitNoProxy(list string) []string {
	return strings.FieldsFunc(list, func(r rune) bool {
		return r == ',' || unicode.IsSpace(r)
	})
}

// NoProxy is true when NO_PROXY exempts the host: `*`, the host itself, or a domain suffix (`.corp`,
// `corp`, `*.corp`).
func NoProxy(host, port string, env ProxyEnv) bool {
	list, ok := envValue(env, "NO_PROXY")
	if !ok {
		return false
	}
	for _, entry := range splitNoProxy(list) {
		if entry == "*" {
			return true
		}
		name := entry
		only := ""
		hasPort := false
		if index := strings.IndexByte(entry, ':'); index >= 0 {
			name = entry[:index]
			only = entry[index+1:]
			hasPort = true
			// The port part is the entry's second segment; anything after another colon is not
			// part of it.
			if end := strings.IndexByte(only, ':'); end >= 0 {
				only = only[:end]
			}
		}
		if hasPort && only != port {
			continue
		}
		domain := name
		if strings.HasPrefix(domain, "*.") {
			domain = strings.TrimPrefix(domain, "*.")
		}
		domain = strings.ToLower(strings.TrimPrefix(domain, "."))
		lower := strings.ToLower(host)
		if lower == domain || strings.HasSuffix(lower, "."+domain) {
			return true
		}
	}
	return false
}

// ExemptLoopback is the router's own environment with loopback exempt from any proxy: NO_PROXY (and
// no_proxy) gain 127.0.0.1 and localhost whenever a proxy is set. The front, its worker and the peer
// routers talk over loopback, and a runtime's HTTP client may apply HTTP_PROXY to every request it
// sends unless NO_PROXY exempts the host. Keys come out sorted, so a build stays deterministic.
func ExemptLoopback(env map[string]string) map[string]string {
	proxySet := false
	for name, value := range env {
		if (strings.EqualFold(name, "http_proxy") || strings.EqualFold(name, "https_proxy")) && strings.TrimSpace(value) != "" {
			proxySet = true
			break
		}
	}
	if !proxySet {
		out := make(map[string]string, len(env))
		for name, value := range env {
			out[name] = value
		}
		return out
	}
	current := ""
	if value, present := env["no_proxy"]; present {
		current = value
	} else if value, present := env["NO_PROXY"]; present {
		current = value
	} else {
		keys := make([]string, 0, len(env))
		for name := range env {
			if strings.EqualFold(name, "no_proxy") {
				keys = append(keys, name)
			}
		}
		sortStrings(keys)
		if len(keys) > 0 {
			current = env[keys[0]]
		}
	}
	entries := splitNoProxy(current)
	for _, loopback := range []string{"127.0.0.1", "localhost"} {
		present := false
		for _, entry := range entries {
			if entry == loopback {
				present = true
				break
			}
		}
		if !present {
			entries = append(entries, loopback)
		}
	}
	out := make(map[string]string, len(env)+2)
	for name, value := range env {
		if !strings.EqualFold(name, "no_proxy") {
			out[name] = value
		}
	}
	joined := strings.Join(entries, ",")
	out["NO_PROXY"] = joined
	out["no_proxy"] = joined
	return out
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

// ProxyFor is the proxy a request to the target goes through, from HTTPS_PROXY/HTTP_PROXY (either
// case), or none.
func ProxyFor(target *url.URL, env ProxyEnv) (*url.URL, bool) {
	port := target.Port()
	if port == "" {
		if target.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	if NoProxy(target.Hostname(), port, env) {
		return nil, false
	}
	name := "HTTP_PROXY"
	if target.Scheme == "https" {
		name = "HTTPS_PROXY"
	}
	raw, ok := envValue(env, name)
	if !ok {
		return nil, false
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	proxy, err := url.Parse(raw)
	if err != nil {
		return nil, false
	}
	return proxy, true
}

// builtinProxy: Node's own proxy support (NODE_USE_ENV_PROXY=1) handles clients given a proxy
// environment; otherwise the client opens a CONNECT tunnel itself, the same on every runtime.
func builtinProxy(env ProxyEnv) bool {
	return env["NODE_USE_ENV_PROXY"] == "1"
}

// BunProxiesItself is true on Bun before 1.4: its node:http client proxies from the environment by
// itself, so a tunnel of our own would be doubled up on it. A Go router never runs on Bun; the
// check stays because the router's environment is built the same way for every runtime.
func BunProxiesItself(bun string) bool {
	if bun == "" {
		return false
	}
	parts := strings.Split(bun, ".")
	major, majorNumber := bunNumber(parts[0])
	minor, minorNumber := 0, true
	if len(parts) > 1 {
		minor, minorNumber = bunNumber(parts[1])
	}
	if majorNumber && major < 1 {
		return true
	}
	return majorNumber && major == 1 && minorNumber && minor < 4
}

// bunNumber is Number(part) with its NaN rule: a part that is not a number compares false to
// everything, and a missing part counts as 0.
func bunNumber(text string) (int, bool) {
	value, err := strconv.Atoi(text)
	if err != nil {
		return 0, false
	}
	return value, true
}

// idleBudgetKey carries the call's idle budget into the client's dialer — the only channel into a
// Transport's connection setup.
type idleBudgetKey struct{}

func withIdleBudget(ctx context.Context, idle time.Duration) context.Context {
	return context.WithValue(ctx, idleBudgetKey{}, idle)
}

// idleBudget is the call's silence budget as the dialer sees it.
func idleBudget(ctx context.Context) time.Duration {
	if idle, ok := ctx.Value(idleBudgetKey{}).(time.Duration); ok {
		return idle
	}
	return idleTimeout
}

// abortSignalKey carries the cancellable call context into the client's dialer, so a client that
// goes away while its CONNECT is still unanswered aborts it there: the transport detaches a dial
// from the request's cancellation (a future request may reuse the connection), so the signal rides
// as a value the dialer watches itself. Destroying the request alone never reaches a tunnel still
// being opened.
type abortSignalKey struct{}

// abortSignal is the context a dial aborts on: the call's cancellable context when the request
// carried one, the dial context itself otherwise.
func abortSignal(ctx context.Context) context.Context {
	if signal, ok := ctx.Value(abortSignalKey{}).(context.Context); ok {
		return signal
	}
	return ctx
}

// bufferedConn keeps bytes a bufio.Reader already took off the tunnel's socket.
type bufferedConn struct {
	net.Conn
	front *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.front.Read(p) }

// proxyAddress is where the proxy itself is dialled; a proxy URL without a port means 80.
func proxyAddress(proxy *url.URL) string {
	if proxy.Port() == "" {
		return net.JoinHostPort(proxy.Hostname(), "80")
	}
	return proxy.Host
}

// tunnel opens a CONNECT tunnel through the proxy to host:port. A proxy that accepts the
// connection and never answers CONNECT hangs the call in here — the request's idle timeout cannot
// reach this phase (no socket of the call's is on the request yet), so the CONNECT keeps its own
// deadline, the same idle budget. A request whose context goes away (the client left) closes the
// CONNECT too; destroying the request alone never reaches a tunnel still being opened.
func tunnel(proxy *url.URL) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		proxyAddr := proxyAddress(proxy)
		signal := abortSignal(ctx)
		var dialer net.Dialer
		conn, err := dialer.DialContext(signal, "tcp", proxyAddr)
		if err != nil {
			return nil, err
		}
		watch := make(chan struct{})
		defer close(watch)
		go func() {
			select {
			case <-signal.Done():
				conn.Close()
			case <-watch:
			}
		}()
		authority := addr
		if host, port, splitErr := net.SplitHostPort(addr); splitErr == nil && strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
			authority = "[" + host + "]:" + port
		}
		request := "CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n"
		if proxy.User != nil {
			password, _ := proxy.User.Password()
			credentials := base64.StdEncoding.EncodeToString([]byte(proxy.User.Username() + ":" + password))
			request += "Proxy-Authorization: Basic " + credentials + "\r\n"
		}
		request += "\r\n"
		if err := conn.SetDeadline(time.Now().Add(idleBudget(ctx))); err != nil {
			conn.Close()
			return nil, err
		}
		defer conn.SetDeadline(time.Time{})
		if _, err := conn.Write([]byte(request)); err != nil {
			conn.Close()
			return nil, err
		}
		buffered := bufio.NewReader(conn)
		answer, err := http.ReadResponse(buffered, &http.Request{Method: http.MethodConnect})
		if err != nil {
			conn.Close()
			return nil, err
		}
		if answer.StatusCode != http.StatusOK {
			conn.Close()
			return nil, fmt.Errorf("proxy CONNECT %s answered %d", authority, answer.StatusCode)
		}
		if buffered.Buffered() == 0 {
			return conn, nil
		}
		return &bufferedConn{Conn: conn, front: buffered}, nil
	}
}

var (
	agentsMu sync.Mutex
	agents   = map[string]*http.Transport{}
	// directTransport serves Direct calls the way Node's global agent serves an agentless request.
	// No transport of the router's decompresses an answer: Node's client never does, so the answer's
	// own bytes (gzip included) reach the client as the upstream sent them. The idle pool matches
	// the concurrency cap: with Go's default of 2 idle per host, a burst of parallel requests opens
	// and closes a connection for each, pinning an ephemeral port per request in TIME_WAIT.
	directTransport = &http.Transport{
		MaxConnsPerHost:     256,
		MaxIdleConns:        256,
		MaxIdleConnsPerHost: 64,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  true,
	}
)

// AgentFor is the keep-alive HTTP client for a target: direct, through the runtime's own proxy
// support (NODE_USE_ENV_PROXY=1), or through our own CONNECT tunnel. A fresh one (no pooling) is
// made for a retry, so it can never be handed the same dead socket again. One pooled client per
// route is package state.
func AgentFor(target *url.URL, env ProxyEnv, fresh bool) *http.Transport {
	proxy, _ := ProxyFor(target, env)
	key := target.Scheme + "|direct"
	if proxy != nil {
		key = target.Scheme + "|" + proxy.String()
	}
	key += "|" + strconv.FormatBool(builtinProxy(env))
	if !fresh {
		agentsMu.Lock()
		cached, present := agents[key]
		agentsMu.Unlock()
		if present {
			return cached
		}
	}
	transport := &http.Transport{
		MaxConnsPerHost:     256,
		MaxIdleConns:        256,
		MaxIdleConnsPerHost: 64,
		IdleConnTimeout:     90 * time.Second,
		DisableKeepAlives:   fresh,
		DisableCompression:  true,
	}
	if proxy != nil {
		if builtinProxy(env) {
			transport.Proxy = http.ProxyURL(proxy)
		} else {
			transport.DialContext = tunnel(proxy)
		}
	}
	if !fresh {
		agentsMu.Lock()
		agents[key] = transport
		agentsMu.Unlock()
	}
	return transport
}

// InspectBody is the body an inspection reads: the answer's own bytes when they are plain, their
// decompressed copy when the provider compressed them — never more decompressed than the inspect
// limit — and the raw bytes back when they cannot be read (an encoding that fails says nothing; it
// never fails the request).
func InspectBody(body []byte, encoding string) []byte {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "gzip":
		return decompress(body, func(reader io.Reader) (io.ReadCloser, error) { return gzip.NewReader(reader) })
	case "deflate":
		return decompress(body, func(reader io.Reader) (io.ReadCloser, error) { return zlib.NewReader(reader) })
	case "br":
		return decompress(body, func(reader io.Reader) (io.ReadCloser, error) {
			return io.NopCloser(brotli.NewReader(reader)), nil
		})
	default:
		return body
	}
}

// decompress reads a compressed body, never more than InspectLimitBytes of it; anything that fails
// gives the raw bytes back.
func decompress(body []byte, open func(reader io.Reader) (io.ReadCloser, error)) []byte {
	reader, err := open(bytes.NewReader(body))
	if err != nil {
		return body
	}
	defer reader.Close()
	plain, err := io.ReadAll(io.LimitReader(reader, InspectLimitBytes+1))
	if err != nil {
		return body
	}
	if len(plain) > InspectLimitBytes {
		return body
	}
	return plain
}

// UpstreamCall is one request upstream.
type UpstreamCall struct {
	URL     *url.URL
	Method  string
	Headers http.Header
	Body    []byte
	Env     ProxyEnv
	// Direct: loopback peers and the worker are dialled directly and never through a proxy.
	Direct bool
	// IdleMs is the silence budget of the call; 0 is the default ten minutes.
	IdleMs int64
}

// UpstreamFailure is how one upstream request failed: the errno-style code, and whether the
// failure came after the answer's head had already gone out.
type UpstreamFailure struct {
	Code         string
	AfterHeaders bool
}

// Replacement is what the client gets instead of an upstream answer the caller chose to rewrite.
type Replacement struct {
	Status  int
	Headers http.Header
	Body    string
}

// UpstreamHooks are the calls SendUpstream reports through.
type UpstreamHooks struct {
	// Answered runs with each answer as it arrives.
	Answered func(answer *http.Response)
	// Rewrite runs with each straight answer before it is piped: return a reader to pipe the
	// answer through first — a rewrite of the bytes as they pass — or nil to pipe it as it came.
	// Never called when Inspect held the answer back.
	Rewrite func(answer *http.Response) io.Reader
	Failed  func(failure UpstreamFailure)
	// Finished runs when the answer has been sent.
	Finished func(answer *http.Response)
	// Inspect runs with each answer before anything is sent: return a judge to hold the (short)
	// answer back and decide on its whole body, nil to stream it at once. The judge returns a
	// replacement, or false to send the answer as it came. An answer over InspectLimitBytes is
	// sent as it came without the judge ever running.
	Inspect func(answer *http.Response) func(body []byte) (Replacement, bool)
	// Oversize runs when a held answer outgrew the inspect limit and was released without its
	// judge ever running — the caller's one notice that the judge (and anything it was to
	// record) is skipped for this answer.
	Oversize func(answer *http.Response)
}

// failureCode is the errno-style code a failure reports — Node's errno vocabulary, which the
// router's logs and health events carry (upstream_errno.go holds the errno tests).
func failureCode(err error) string {
	switch {
	case errors.Is(err, os.ErrDeadlineExceeded), errors.Is(err, context.DeadlineExceeded):
		return "ETIMEDOUT"
	case errors.Is(err, context.Canceled):
		// The request was aborted: the client had gone, and the call was destroyed with it.
		return "ECONNRESET"
	case resetErrno(err):
		return "ECONNRESET"
	case pipeErrno(err):
		return "EPIPE"
	case refusedErrno(err):
		return "ECONNREFUSED"
	default:
		return "EUPSTREAM"
	}
}

// staleSocket decides the stale-socket retry: how net/http hands the caller a keep-alive
// socket the upstream had already closed when the request was written on it — a reset, a broken
// pipe, or the clean EOF of a close that raced the request (a reused socket failing before any
// answer byte reads as ECONNRESET, "socket hang up", in every one of these cases). The
// transport's "server closed idle connection" is its own name for the same event; the sentinel
// is unexported, so its stable message is the only handle on it. err is never nil at the call
// site.
func staleSocket(code string, err error) bool {
	if code == "ECONNRESET" || code == "EPIPE" {
		return true
	}
	if errors.Is(err, io.EOF) {
		return true
	}
	return err.Error() == "http: server closed idle connection"
}

// writeHead sends the head with headers already prepared for the client.
func writeHead(res *Response, status int, headers http.Header) {
	for name, values := range headers {
		res.Header()[name] = values
	}
	res.WriteHeader(status)
}

// concatChunks joins buffered chunks into one body.
func concatChunks(chunks [][]byte) []byte {
	size := 0
	for _, chunk := range chunks {
		size += len(chunk)
	}
	body := make([]byte, 0, size)
	for _, chunk := range chunks {
		body = append(body, chunk...)
	}
	return body
}

// SendUpstream sends one request and pipes the answer into res, byte for byte except where Rewrite
// rewrites the passing bytes. A connection error on a reused keep-alive socket, before any answer
// byte, is retried once on a fresh connection — a heuristic that is usually right (the upstream
// closed the idle socket before the request arrived) but cannot be proven from the error alone,
// and in the rare case the upstream had already read the request the retry executes it a second
// time (an accepted risk; dropping the retry would surface an
// idle-socket reset to Claude Code instead). The transport's own retry covers only requests it
// considers replayable (GETs and the like); a POST /v1/messages is not one, so the retry lives
// here. Every other failure is reported once through Failed; after the headers went out an
// event-stream answer ends with Anthropic's terminal error event and any other client stream is
// destroyed, so it ends instead of hanging. The client going away aborts the upstream call.
func SendUpstream(ctx context.Context, call UpstreamCall, res *Response, hooks UpstreamHooks) {
	settled := false
	// Whether the answer's bytes so far end between two events, so a terminal event never joins a
	// cut one.
	atBoundary := true
	// The answer's own content-type, kept for the failed ending below (a written head is not
	// readable back).
	contentType := ""
	fail := func(code string, afterHeaders bool) {
		if settled {
			return
		}
		settled = true
		if afterHeaders {
			endFailed(res, contentType, atBoundary, "upstream connection failed ("+code+")")
		}
		if hooks.Failed != nil {
			hooks.Failed(UpstreamFailure{Code: code, AfterHeaders: afterHeaders})
		}
		res.Cut()
	}

	idle := idleTimeout
	if call.IdleMs != 0 {
		idle = time.Duration(call.IdleMs) * time.Millisecond
	}
	callCtx, cancel := context.WithCancel(withIdleBudget(ctx, idle))
	// The dialer watches this cancellable context through a value (see abortSignalKey).
	callCtx = context.WithValue(callCtx, abortSignalKey{}, callCtx)
	defer cancel()
	// The idle budget ends a call whose upstream stays silent; a stream that keeps talking is never
	// cut, so it is silence and never a total duration, and the timer stops once the head arrives.
	var timedOut atomic.Bool
	timer := time.AfterFunc(idle, func() {
		timedOut.Store(true)
		cancel()
	})
	defer timer.Stop()

	// attempt sends the request once, on the pooled client or on a fresh one (no pooling) for a
	// retry, so it can never be handed the same dead socket again. reused is taken off the
	// connection the client handed this attempt: true when it was a pooled keep-alive socket.
	attempt := func(fresh bool) (*http.Response, bool, error) {
		attemptTransport := directTransport
		if !call.Direct {
			attemptTransport = AgentFor(call.URL, call.Env, fresh)
		}
		var reused atomic.Bool
		traceCtx := httptrace.WithClientTrace(callCtx, &httptrace.ClientTrace{
			GotConn: func(info httptrace.GotConnInfo) { reused.Store(info.Reused) },
		})
		upstream, err := http.NewRequestWithContext(traceCtx, call.Method, call.URL.String(), bytes.NewReader(call.Body))
		if err != nil {
			return nil, false, err
		}
		upstream.Header = call.Headers
		if host := upstream.Header.Get("Host"); host != "" {
			upstream.Host = host
		}
		// The body's own length is the request's; a copied Content-Length header would fight it.
		upstream.Header.Del("Content-Length")
		upstream.Header.Del("Host")
		answer, err := attemptTransport.RoundTrip(upstream)
		return answer, reused.Load(), err
	}

	answer, reused, err := attempt(false)
	timer.Stop()
	if err != nil {
		code := failureCode(err)
		if timedOut.Load() {
			code = "ETIMEDOUT"
		}
		// A stale pooled socket fails its request before any answer byte; the request goes out once
		// more on a connection of its own. A call the client (or the idle budget) already ended is
		// never retried: nobody waits for the answer.
		if !res.HeadersSent() && reused && callCtx.Err() == nil && staleSocket(code, err) {
			answer, _, err = attempt(true)
			if err != nil {
				code = failureCode(err)
				if timedOut.Load() {
					code = "ETIMEDOUT"
				}
			}
		}
		if err != nil {
			fail(code, res.HeadersSent())
			return
		}
	}
	defer answer.Body.Close()

	var judge func([]byte) (Replacement, bool)
	if hooks.Inspect != nil {
		judge = hooks.Inspect(answer)
	}
	if hooks.Answered != nil {
		hooks.Answered(answer)
	}
	contentType = answer.Header.Get("Content-Type")

	reader := io.Reader(answer.Body)
	decided := false
	if judge == nil {
		writeHead(res, answer.StatusCode, ResponseHeaders(answer.Header))
		if hooks.Rewrite != nil {
			if rewritten := hooks.Rewrite(answer); rewritten != nil {
				reader = rewritten
			}
		}
	} else {
		// A held-back answer is decided (and sent) before Finished hears of it.
		var chunks [][]byte
		size := 0
		release := false
		buffer := make([]byte, 32*1024)
		for {
			n, readErr := answer.Body.Read(buffer)
			if n > 0 {
				chunk := append([]byte(nil), buffer[:n]...)
				atBoundary = n >= 2 && chunk[n-2] == '\n' && chunk[n-1] == '\n'
				chunks = append(chunks, chunk)
				size += n
				if size > InspectLimitBytes {
					release = true
				}
			}
			if readErr == io.EOF || release {
				break
			}
			if readErr != nil {
				fail("EABORTED", res.HeadersSent())
				return
			}
		}
		if release {
			if hooks.Oversize != nil {
				hooks.Oversize(answer)
			}
			writeHead(res, answer.StatusCode, ResponseHeaders(answer.Header))
			for _, chunk := range chunks {
				if _, err := res.Write(chunk); err != nil {
					// The client is gone: nothing more is worth sending.
					return
				}
			}
		} else {
			decided = true
			if !res.Destroyed() {
				body := concatChunks(chunks)
				if replacement, ok := judge(body); ok {
					writeHead(res, replacement.Status, replacement.Headers)
					res.End([]byte(replacement.Body))
				} else {
					writeHead(res, answer.StatusCode, ResponseHeaders(answer.Header))
					res.End(body)
				}
			}
		}
	}
	if !decided {
		buffer := make([]byte, 32*1024)
		for {
			n, readErr := reader.Read(buffer)
			if n > 0 {
				chunk := buffer[:n]
				atBoundary = n >= 2 && chunk[n-2] == '\n' && chunk[n-1] == '\n'
				if _, writeErr := res.Write(chunk); writeErr != nil {
					// The client went away mid-answer (Esc in Claude Code): stop the upstream
					// request too, and say nothing — nobody waits for this answer.
					cancel()
					return
				}
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				fail("EABORTED", res.HeadersSent())
				return
			}
		}
	}
	settled = true
	if hooks.Finished != nil {
		hooks.Finished(answer)
	}
}

// endFailed ends a response whose headers already went out and whose upstream then failed: a
// text/event-stream answer gets Anthropic's terminal error event, so the client reads a typed end
// instead of a cut socket; any other answer is destroyed. The rewrite's unread bytes are
// dropped (the caller stops reading it), so nothing of the cut answer passes the error event.
func endFailed(res *Response, contentType string, atBoundary bool, message string) {
	if !res.HeadersSent() || res.Destroyed() || res.WritableEnded() {
		res.MarkDestroyed()
		return
	}
	if strings.Contains(contentType, "text/event-stream") {
		prefix := ""
		// A stream cut inside an event closes that event first, so the error event always arrives
		// whole and on its own.
		if !atBoundary {
			prefix = "\n\n"
		}
		_, _ = res.Write([]byte(prefix + "event: error\ndata: " + anthropicErrorJSON("api_error", message) + "\n\n"))
		res.End(nil)
		return
	}
	res.MarkDestroyed()
}
