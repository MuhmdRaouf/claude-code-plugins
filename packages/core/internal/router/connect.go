// The front's HTTPS proxy mode: Claude Code keeps its base URL at api.anthropic.com and points
// HTTPS_PROXY at the front, so `claude rc` (Remote Control) works with routing on. A CONNECT is
// accepted as a proxy accepts one: api.anthropic.com is decrypted with the local CA and routed
// exactly as base-URL mode routes a request, every other host is tunnelled blind with its TLS
// untouched, and a tunnel this machine must not open is refused. The proxy exists to keep Claude
// Code working, never to look at anyone's traffic: only api.anthropic.com is ever decrypted.
package router

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/localca"
)

// connect serves one CONNECT. Browsers cannot send CONNECT, so the front's Host check (a
// DNS-rebinding guard for pages a browser could reach) does not apply to it: the authority names
// the tunnel's target, not this front. Any port on a remote host is tunnelled blind; only
// api.anthropic.com:443 is decrypted, with the local CA.
func (f *Front) connect(w http.ResponseWriter, req *http.Request) {
	host, port, err := net.SplitHostPort(req.RequestURI)
	if err != nil {
		f.connectRefused(w, "a CONNECT names host:port")
		return
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		f.connectRefused(w, "a CONNECT names host:port")
		return
	}
	// A tunnel to this machine would reach the front's own port, the worker ports and every other
	// loopback listener from wherever Claude Code runs; the proxy is not a door into the host.
	lower := strings.ToLower(host)
	if ip := net.ParseIP(host); (ip != nil && isLocalIP(ip)) || lower == "localhost" || strings.HasSuffix(lower, ".localhost") {
		f.connectRefused(w, "a CONNECT may not name this machine")
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		f.connectRefused(w, "the connection cannot be tunnelled")
		return
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return
	}
	if _, err := conn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n")); err != nil {
		conn.Close()
		return
	}
	client := &bufferedConn{Conn: conn, front: rw.Reader}
	// Only api.anthropic.com on its real port is decrypted; the same name on any other port is a
	// blind tunnel like every other host.
	if f.options.CADir != "" && number == 443 && strings.EqualFold(host, localca.Host) {
		if _, err := f.leafFor(); err == nil {
			f.serveDecrypted(client)
			return
		}
		// The CA is unusable; the reason is in the log. Passing through blind keeps Claude Code
		// working (no routing for these requests) where refusing would cut it off.
	}
	f.blindTunnel(req.Context(), client, net.JoinHostPort(host, port))
}

// connectRefused answers a CONNECT with the Anthropic error shape, so a client that inspects the
// failure reads a message instead of a parse error.
func (f *Front) connectRefused(w http.ResponseWriter, why string) {
	AnthropicError(NewResponse(w), 403, "permission_error", f.options.Name+" router: CONNECT refused ("+why+")")
}

// blindTunnel pipes an established CONNECT socket to its target both ways, both sides closed once
// either ends. The bytes are never read here: the client's TLS handshake is with the target.
func (f *Front) blindTunnel(ctx context.Context, client net.Conn, addr string) {
	target, err := f.tunnelDial(ctx, "tcp", addr)
	if err != nil {
		client.Close()
		return
	}
	go func() {
		_, _ = io.Copy(target, client)
		target.Close()
	}()
	_, _ = io.Copy(client, target)
	client.Close()
}

// tunnelDial opens the blind tunnel's socket: the front's hook when one is set, else the user's
// own proxy when the environment applies one to the target, else a direct dial.
func (f *Front) tunnelDial(ctx context.Context, network, addr string) (net.Conn, error) {
	if f.options.Dial != nil {
		return f.options.Dial(ctx, network, addr)
	}
	target := &url.URL{Scheme: "https", Host: addr}
	if proxy, ok := ProxyFor(target, f.options.Env); ok {
		return tunnel(proxy)(ctx, network, addr)
	}
	// A name can resolve to this machine as well as a literal can name it: the check runs again on
	// the address the dial actually reaches.
	dialer := net.Dialer{Timeout: 10 * time.Second, Control: refuseLocalDial}
	return dialer.DialContext(ctx, network, addr)
}

// isLocalIP reports an address on this machine or its link: loopback, unspecified or link-local.
func isLocalIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast()
}

// refuseLocalDial is the blind tunnel's dial control: it refuses a resolved address isLocalIP names.
func refuseLocalDial(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	if ip := net.ParseIP(host); ip == nil || isLocalIP(ip) {
		return fmt.Errorf("tunnel to %s refused: it is this machine", address)
	}
	return nil
}

// serveDecrypted answers the client's TLS handshake with the local CA's leaf and serves the
// requests it carries.
func (f *Front) serveDecrypted(client net.Conn) {
	config := &tls.Config{
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return f.leafFor() },
		NextProtos:     []string{"http/1.1"},
		MinVersion:     tls.VersionTLS12,
	}
	server := Harden(&http.Server{Handler: http.HandlerFunc(f.intercept)})
	_ = server.Serve(&oneConnListener{conn: tls.Server(client, config)})
}

// oneConnListener serves exactly the connection it was built with, then ends the server: a
// CONNECT carries one conversation, and the server's goroutine must not wait for a second.
type oneConnListener struct {
	conn     net.Conn
	accepted bool
}

func (l *oneConnListener) Accept() (net.Conn, error) {
	if l.accepted {
		return nil, net.ErrClosed
	}
	l.accepted = true
	return l.conn, nil
}

func (l *oneConnListener) Close() error   { return nil }
func (l *oneConnListener) Addr() net.Addr { return l.conn.LocalAddr() }

// intercept serves one request that arrived through a decrypted CONNECT: a model request runs the
// very pipeline base-URL mode runs, and every other request reaches Anthropic exactly as it came —
// Remote Control's settings, policy and event calls, and its streams and upgrades with them.
func (f *Front) intercept(w http.ResponseWriter, req *http.Request) {
	if req.Method == http.MethodPost && (req.URL.Path == "/v1/messages" || req.URL.Path == "/v1/messages/count_tokens") {
		res := NewResponse(w)
		Receive(req, res, f.options.Name, f.knobs.BodyLimit, func(body []byte) {
			f.route(req, res, body, false)
		})
		return
	}
	f.anthropicProxy().ServeHTTP(w, req)
}

// anthropicProxy is the pass-through half of proxy mode: the request goes to Anthropic with its
// host rewritten to the target's and nothing else changed, its stream flushed as it arrives and
// its upgrade relayed both ways.
func (f *Front) anthropicProxy() *httputil.ReverseProxy {
	target := f.options.Anthropic
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = target.Scheme
			pr.Out.URL.Host = target.Host
			pr.Out.URL.Path = strings.TrimSuffix(target.Path, "/") + pr.Out.URL.Path
			pr.Out.Host = target.Host
		},
		FlushInterval: -1,
		Transport:     AgentFor(target, f.options.Env, false),
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			AnthropicError(NewResponse(w), 502, "api_error", f.options.Name+" router: anthropic unreachable")
		},
	}
}

// leafFor is the certificate CONNECT api.anthropic.com is answered with: the local CA's leaf,
// cached on the front and re-signed only once its life has less than a day left.
func (f *Front) leafFor() (*tls.Certificate, error) {
	now := time.UnixMilli(f.now())
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.leaf != nil && f.leafNotAfter.Sub(now) > 24*time.Hour {
		return f.leaf, nil
	}
	ca, err := f.caFor(now)
	if err != nil {
		return nil, err
	}
	leaf, err := ca.Leaf(localca.Host, now)
	if err != nil {
		return nil, err
	}
	f.leaf, f.leafNotAfter = leaf, leaf.Leaf.NotAfter
	return leaf, nil
}

// caFor is the front's local CA, loaded once and kept. A load that failed is kept too and retried
// after a minute, and one line per failure episode goes to the router log — not one per request.
// Called with f.mu held.
func (f *Front) caFor(now time.Time) (*localca.CA, error) {
	if f.ca != nil {
		return f.ca, nil
	}
	if f.caErr != nil && now.Sub(f.caAt) < time.Minute {
		return nil, f.caErr
	}
	ca, err := localca.LoadOrCreate(context.Background(), f.options.CADir, now)
	if err != nil {
		if !f.caLogged {
			f.caLogged = true
			f.note(fmt.Sprintf("local CA unusable (%v); CONNECT api.anthropic.com passes through as a blind tunnel", err))
		}
		f.caErr, f.caAt = err, now
		return nil, err
	}
	f.ca, f.caErr, f.caLogged = ca, nil, false
	return ca, nil
}
