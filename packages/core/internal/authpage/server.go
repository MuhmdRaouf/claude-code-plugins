// The one-time key page: 127.0.0.1 on an OS-chosen port, at /<token> only. Every request must
// name the exact host (DNS rebinding), every POST the exact origin, the form content type, a
// small body and the form's CSRF value. The key is checked with one request, stored, and the
// server exits; it also exits after 10 minutes or 5 failed tries. Nothing here logs: not
// requests, not bodies, not the key.
package authpage

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/keystore"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// pageTimeoutMs ends a page nobody finishes on.
const pageTimeoutMs = 10 * 60_000

// maxTriesDefault is how many failed submissions end the page.
const maxTriesDefault = 5

// MaxBodyBytes is the largest form body read; anything over is refused unread.
const MaxBodyBytes = 4096

// formType is the one content type a POST may carry.
const formType = "application/x-www-form-urlencoded"

// headerTimeoutMs and requestTimeoutMs are the two phases a slow or stalled client may not
// exceed (Node's headersTimeout and requestTimeout).
const headerTimeoutMs = 10_000

const requestTimeoutMs = 30_000

// KeyCheck makes one minimal provider request with a candidate key; a returned error counts as
// unknown.
type KeyCheck func(ctx context.Context, key string) (ports.KeyVerdict, error)

// KeySave stores an accepted key; its error says why the store refused it, never the key itself.
type KeySave func(ctx context.Context, key string) error

// AuthPageOptions shape StartAuthPage.
type AuthPageOptions struct {
	// Plugin is the plugin, as the page's version line names it ("zai-plugin-cc"); Version is
	// its version when known.
	Plugin  string
	Version *string
	Display string
	// KeysURL is the provider's API-key page, linked from the page's first step.
	KeysURL string
	// BillingURL is where the provider takes a top-up, named when it knows the key but will not
	// serve it yet.
	BillingURL string
	// StoreLabel is where the key will live, named on the page.
	StoreLabel string
	Check      KeyCheck
	Save       KeySave
	TimeoutMs  *int64
	MaxTries   *int
}

// AuthOutcome is how the page ended.
type AuthOutcome string

const (
	// AuthOutcomeSaved: a key was checked and stored.
	AuthOutcomeSaved AuthOutcome = "saved"
	// AuthOutcomeTimeout: nobody finished in time.
	AuthOutcomeTimeout AuthOutcome = "timeout"
	// AuthOutcomeRefused: too many failed tries.
	AuthOutcomeRefused AuthOutcome = "refused"
	// AuthOutcomeClosed: the user closed the page.
	AuthOutcomeClosed AuthOutcome = "closed"
)

// AuthPage is the running one-time page.
type AuthPage struct {
	// URL is http://127.0.0.1:<port>/<token>: the token is the only secret in it.
	URL string
	// Done carries the outcome exactly once.
	Done <-chan AuthOutcome

	page *pageServer
}

// Close ends the page now (outcome closed).
func (p *AuthPage) Close() {
	p.page.finish(AuthOutcomeClosed)
}

// secret is the page's URL token and CSRF value: 32 random bytes as base64url.
func secret() string {
	return base64.RawURLEncoding.EncodeToString(randomBytes(32))
}

// nonce is a per-response CSP nonce: 16 random bytes as base64.
func nonce() string {
	return base64.StdEncoding.EncodeToString(randomBytes(16))
}

// randomBytes is crypto/rand's answer; Read never returns an error and always fills the buffer
// (it crashes the program itself on the legacy systems where its source can fail).
func randomBytes(size int) []byte {
	buf := make([]byte, size)
	_, _ = rand.Read(buf)
	return buf
}

// sameSecret is a constant-time comparison of two secrets of any shape.
func sameSecret(given string, expected string) bool {
	a, b := []byte(given), []byte(expected)
	return len(a) == len(b) && subtle.ConstantTimeCompare(a, b) == 1
}

// referrerPolicy: same-origin, not no-referrer: under no-referrer Chrome sends `Origin: null` on
// the form's own POST, which the exact-Origin rule must refuse. same-origin still sends nothing
// to any other site.
const referrerPolicy = "same-origin"

// securityHeaders are the headers every response carries; the nonce opens the CSP for that one
// response's inline style and script.
func securityHeaders(pageNonce string) map[string]string {
	return map[string]string{
		"Content-Security-Policy": `default-src 'none'; style-src 'nonce-` + pageNonce +
			`'; script-src 'nonce-` + pageNonce +
			`'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
		"Referrer-Policy":        referrerPolicy,
		"Cache-Control":          "no-store",
		"X-Content-Type-Options": "nosniff",
	}
}

// pageServer is the page's own state behind its http.Server.
type pageServer struct {
	options  AuthPageOptions
	base     PageBase
	token    string
	csrf     string
	port     int
	maxTries int64
	server   *http.Server
	timer    *time.Timer

	mu       sync.Mutex
	busy     bool
	tries    int64
	finished bool
	sockets  map[net.Conn]struct{}
	// pending carries the outcome a terminal response will settle once its connection has
	// flushed; closing the server inside the handler could truncate that response.
	pending map[net.Conn]AuthOutcome
	done    chan AuthOutcome
}

// StartAuthPage starts the one-time page on 127.0.0.1 and an OS-chosen port.
func StartAuthPage(options AuthPageOptions) (*AuthPage, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	server := &pageServer{
		options: options,
		base: PageBase{
			Plugin:     options.Plugin,
			Version:    options.Version,
			Display:    options.Display,
			StoreLabel: options.StoreLabel,
			KeysURL:    options.KeysURL,
			BillingURL: options.BillingURL,
		},
		token:    secret(),
		csrf:     secret(),
		port:     port,
		maxTries: maxTriesDefault,
		sockets:  map[net.Conn]struct{}{},
		pending:  map[net.Conn]AuthOutcome{},
		done:     make(chan AuthOutcome, 1),
	}
	if options.MaxTries != nil {
		server.maxTries = int64(*options.MaxTries)
	}
	server.server = &http.Server{
		Handler: http.HandlerFunc(server.handle),
		// Node's headersTimeout bounds the head, requestTimeout the whole request.
		ReadHeaderTimeout: headerTimeoutMs * time.Millisecond,
		ReadTimeout:       requestTimeoutMs * time.Millisecond,
		ConnContext:       server.withConn,
		ConnState:         server.connState,
	}
	timeout := int64(pageTimeoutMs)
	if options.TimeoutMs != nil {
		timeout = *options.TimeoutMs
	}
	// The timer's handle goes in under the page's mutex: its own goroutine reads it in finish,
	// and a timeout short enough to fire mid-setup must meet a set field, not race one.
	timer := time.AfterFunc(time.Duration(timeout)*time.Millisecond, func() { server.finish(AuthOutcomeTimeout) })
	server.mu.Lock()
	server.timer = timer
	server.mu.Unlock()
	go func() { _ = server.server.Serve(newPageListener(listener)) }()
	return &AuthPage{
		URL:  "http://127.0.0.1:" + strconv.Itoa(port) + "/" + server.token,
		Done: server.done,
		page: server,
	}, nil
}

type connKey struct{}

// withConn carries the connection in each request's context, so the response that ends the page
// can wait for its own connection to settle.
func (s *pageServer) withConn(ctx context.Context, conn net.Conn) context.Context {
	return context.WithValue(ctx, connKey{}, conn)
}

// connState tracks the sockets and fires the pending outcome once its response has left the
// building: Go moves a connection to StateIdle only after the last byte went out, and a closed
// connection carries no response left to truncate.
func (s *pageServer) connState(conn net.Conn, state http.ConnState) {
	s.mu.Lock()
	if state == http.StateClosed {
		delete(s.sockets, conn)
	} else {
		s.sockets[conn] = struct{}{}
	}
	outcome, ok := s.pending[conn]
	if ok {
		delete(s.pending, conn)
	}
	settled := ok && (state == http.StateIdle || state == http.StateClosed)
	s.mu.Unlock()
	if settled {
		s.finish(outcome)
	}
}

// handle is every request the page answers.
func (s *pageServer) handle(w http.ResponseWriter, r *http.Request) {
	method, status := s.admit(r)
	if method == "GET" {
		s.page(w, r, PageState{Kind: PageStateForm, CSRF: s.csrf}, nil)
		return
	}
	if method != "POST" {
		s.refuse(w, status)
		return
	}
	body, ok := readBody(r, MaxBodyBytes)
	if !ok {
		s.refuse(w, 413)
		return
	}
	form, _ := url.ParseQuery(body)
	if !sameSecret(form.Get("csrf"), s.csrf) {
		s.refuse(w, 403)
		return
	}
	s.submitAlone(w, r, strings.TrimSpace(form.Get("key")))
}

// admit is "GET" or "POST" for a request that may go on, else the refusal's status. Exact Host
// (no DNS rebinding), exact path, and for a POST the page's own Origin and the form content type.
func (s *pageServer) admit(r *http.Request) (string, int) {
	host := "127.0.0.1:" + strconv.Itoa(s.port)
	if s.isFinished() || r.Host != host || !sameSecret(r.RequestURI, "/"+s.token) {
		return "", 404
	}
	if r.Method == "GET" {
		return "GET", 0
	}
	if r.Method != "POST" {
		return "", 404
	}
	if r.Header.Get("Origin") != "http://"+host {
		return "", 403
	}
	kind := r.Header.Get("Content-Type")
	kind, _, _ = strings.Cut(kind, ";")
	if strings.ToLower(strings.TrimSpace(kind)) != formType {
		return "", 415
	}
	return "POST", 0
}

// refuse is an empty-bodied refusal; the connection closes so an oversized upload is not read on.
func (s *pageServer) refuse(w http.ResponseWriter, status int) {
	header := w.Header()
	for name, value := range securityHeaders(nonce()) {
		header.Set(name, value)
	}
	header.Set("Content-Length", "0")
	header.Set("Connection", "close")
	w.WriteHeader(status)
}

// page renders one state; after, when set, ends the page once the response has flushed.
func (s *pageServer) page(w http.ResponseWriter, r *http.Request, state PageState, after *AuthOutcome) {
	pageNonce := nonce()
	body := RenderPage(PageView{PageBase: s.base, State: state}, pageNonce)
	header := w.Header()
	for name, value := range securityHeaders(pageNonce) {
		header.Set(name, value)
	}
	header.Set("Content-Type", "text/html; charset=utf-8")
	header.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, body)
	if after != nil {
		conn, _ := r.Context().Value(connKey{}).(net.Conn)
		s.mu.Lock()
		s.pending[conn] = *after
		s.mu.Unlock()
	}
}

// submitAlone takes one submission at a time: a second one while a key is being checked is
// turned away.
func (s *pageServer) submitAlone(w http.ResponseWriter, r *http.Request, key string) {
	s.mu.Lock()
	if s.busy || s.finished {
		s.mu.Unlock()
		s.refuse(w, 409)
		return
	}
	s.busy = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.busy = false
		s.mu.Unlock()
	}()
	s.submit(w, r, key)
}

func (s *pageServer) submit(w http.ResponseWriter, r *http.Request, key string) {
	tried := s.attempt(r.Context(), key)
	if tried.saved {
		saved := AuthOutcomeSaved
		s.page(w, r, PageState{Kind: PageStateSaved, Limited: tried.limited}, &saved)
		return
	}
	s.mu.Lock()
	s.tries++
	last := s.tries >= s.maxTries
	s.mu.Unlock()
	if last {
		refused := AuthOutcomeRefused
		text := tried.text + " That was the last try: run setup again in Claude Code for a new page."
		s.page(w, r, PageState{Kind: PageStateEnded, Text: text}, &refused)
		return
	}
	s.page(w, r, PageState{Kind: PageStateForm, CSRF: s.csrf, Error: strPtr(tried.text + " Try again.")}, nil)
}

// attemptResult says whether the key was stored, and what to tell the user when not (never the
// key).
type attemptResult struct {
	saved   bool
	limited bool
	text    string
}

// attempt checks one key and stores it when the provider takes it.
func (s *pageServer) attempt(ctx context.Context, key string) attemptResult {
	if !keystore.IsValidKey(key) {
		return attemptResult{text: "That does not look like an API key (16-512 letters, digits, '.', '_' or '-')."}
	}
	verdict, err := s.options.Check(ctx, key)
	if err != nil {
		verdict = ports.KeyVerdictUnknown
	}
	if verdict == ports.KeyVerdictRefused {
		return attemptResult{text: "That key was refused."}
	}
	if verdict == ports.KeyVerdictUnknown {
		return attemptResult{text: "The key could not be checked right now."}
	}
	if err := s.options.Save(ctx, key); err != nil {
		return attemptResult{text: "The key was accepted but could not be saved in " + s.options.StoreLabel + "."}
	}
	return attemptResult{saved: true, limited: verdict == ports.KeyVerdictLimited}
}

// isFinished reports whether the page already ended.
func (s *pageServer) isFinished() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.finished
}

// finish settles the page once, whatever came first: the timer, a saved or refused submission,
// or a close. Every socket goes with it (Node's server.close plus closeAllConnections): the
// listener first, so nothing new arrives, then even the stalled and idle connections.
func (s *pageServer) finish(outcome AuthOutcome) {
	s.mu.Lock()
	if s.finished {
		s.mu.Unlock()
		return
	}
	s.finished = true
	timer := s.timer
	sockets := make([]net.Conn, 0, len(s.sockets))
	for conn := range s.sockets {
		sockets = append(sockets, conn)
	}
	s.mu.Unlock()
	if timer != nil {
		timer.Stop()
	}
	_ = s.server.Close()
	for _, conn := range sockets {
		conn.Close()
	}
	s.done <- outcome
}

// readBody is the request body when it fits in max bytes, else false (and the rest is not read).
func readBody(r *http.Request, max int64) (string, bool) {
	if r.ContentLength > max {
		return "", false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		return "", false
	}
	if int64(len(body)) > max {
		return "", false
	}
	return string(body), true
}

// requestLineLimit bounds the request line the page's listener reads before deciding a
// connection speaks HTTP.
const requestLineLimit = 8192

// requestLineShape is an HTTP request line: a method token, a target and a version.
var requestLineShape = regexp.MustCompile("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+ \\S+ HTTP/\\d+(?:\\.\\d+)?$")

// pageListener guards the page's port: a connection whose first line is not an HTTP request
// line is closed with nothing written, which Go's http.Server would otherwise answer with an
// automatic 400.
type pageListener struct {
	net.Listener
}

func newPageListener(inner net.Listener) net.Listener {
	return pageListener{Listener: inner}
}

func (l pageListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		prefix, ok := readRequestLine(conn)
		if !ok {
			conn.Close()
			continue
		}
		return &prefixConn{Conn: conn, prefix: prefix}, nil
	}
}

// readRequestLine reads up to the first line break and reports whether it is an HTTP request
// line; the deadline is the head's, and the read end stays untouched past it.
func readRequestLine(conn net.Conn) ([]byte, bool) {
	_ = conn.SetReadDeadline(time.Now().Add(headerTimeoutMs * time.Millisecond))
	defer func() { _ = conn.SetReadDeadline(time.Time{}) }()
	var buffer []byte
	chunk := make([]byte, 1024)
	for {
		n, err := conn.Read(chunk)
		buffer = append(buffer, chunk[:n]...)
		if line, _, found := bytes.Cut(buffer, []byte("\n")); found {
			return buffer, requestLineShape.MatchString(strings.TrimSuffix(string(line), "\r"))
		}
		if err != nil {
			return nil, false
		}
		if len(buffer) > requestLineLimit {
			return nil, false
		}
	}
}

// prefixConn replays the peeked bytes before the connection's own stream.
type prefixConn struct {
	net.Conn
	prefix []byte
}

func (c *prefixConn) Read(p []byte) (int, error) {
	if len(c.prefix) > 0 {
		n := copy(p, c.prefix)
		c.prefix = c.prefix[n:]
		return n, nil
	}
	return c.Conn.Read(p)
}
