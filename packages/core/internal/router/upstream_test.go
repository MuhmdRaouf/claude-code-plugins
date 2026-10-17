package router

import (
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
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/andybalholm/brotli"
)

// until waits until check holds (at most two seconds), for the asynchronous ends of a connection.
func until(check func() bool) bool {
	for i := 0; i < 200 && !check(); i++ {
		time.Sleep(10 * time.Millisecond)
	}
	return check()
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("url.Parse(%q): %v", raw, err)
	}
	return parsed
}

// serve starts one loopback HTTP server; the cleanup closes it and its connections.
func serve(t *testing.T, handler http.HandlerFunc, setup func(server *http.Server)) int {
	t.Helper()
	server := &http.Server{Handler: handler}
	if setup != nil {
		setup(server)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go server.Serve(listener)
	t.Cleanup(func() {

		server.Close()
	})
	return listener.Addr().(*net.TCPAddr).Port
}

type requestOptions struct {
	method  string
	path    string
	body    string
	headers map[string]string
}

type clientAnswer struct {
	status int
	body   string
	header http.Header
}

// doRequest sends one POST to /v1/messages?beta=true unless told otherwise, on a connection of
// its own.
func doRequest(port int, options requestOptions) (clientAnswer, error) {
	method := options.method
	if method == "" {
		method = http.MethodPost
	}
	path := options.path
	if path == "" {
		path = "/v1/messages?beta=true"
	}
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	defer client.CloseIdleConnections()
	request, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), strings.NewReader(options.body))
	if err != nil {
		return clientAnswer{}, err
	}
	for name, value := range options.headers {
		request.Header.Set(name, value)
	}
	response, err := client.Do(request)
	if err != nil {
		return clientAnswer{}, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return clientAnswer{}, err
	}
	return clientAnswer{status: response.StatusCode, body: string(body), header: response.Header}, nil
}

// relayServer is a local server whose every request is sent upstream by SendUpstream, recording
// the failures and the finished statuses.
type relayServer struct {
	port     int
	mu       sync.Mutex
	failures []UpstreamFailure
	finished []int
}

type relayExtra struct {
	idleMs int64
	direct bool
}

func relay(t *testing.T, target func(req *http.Request) *url.URL, env ProxyEnv, extra relayExtra) *relayServer {
	t.Helper()
	rs := &relayServer{}
	rs.port = serve(t, func(w http.ResponseWriter, req *http.Request) {
		body, err := ReadBody(req, BodyLimitBytes)
		if err != nil {
			return
		}
		res := NewResponse(w)
		upstream := target(req)
		SendUpstream(req.Context(), UpstreamCall{
			URL:     upstream,
			Method:  req.Method,
			Headers: ForwardHeaders(req.Header, upstream, len(body)),
			Body:    body,
			Env:     env,
			Direct:  extra.direct,
			IdleMs:  extra.idleMs,
		}, res, UpstreamHooks{
			Failed: func(failure UpstreamFailure) {
				rs.mu.Lock()
				rs.failures = append(rs.failures, failure)
				rs.mu.Unlock()
				if !failure.AfterHeaders {
					AnthropicError(res, 502, "api_error", failure.Code)
				}
			},
			Finished: func(answer *http.Response) {
				rs.mu.Lock()
				rs.finished = append(rs.finished, answer.StatusCode)
				rs.mu.Unlock()
			},
		})
	}, nil)
	return rs
}

func (rs *relayServer) failureList() []UpstreamFailure {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return append([]UpstreamFailure(nil), rs.failures...)
}

func (rs *relayServer) finishedList() []int {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return append([]int(nil), rs.finished...)
}

func TestPathsAndHeaders(t *testing.T) {
	t.Parallel()
	t.Run("accepts exactly one leading slash, so a request path can never change the upstream host", func(t *testing.T) {
		if path, ok := SafePath("/v1/messages?beta=true"); !ok || path != "/v1/messages?beta=true" {
			t.Errorf("SafePath(/v1/messages?beta=true) = %q, %v", path, ok)
		}
		for _, path := range []string{"//evil.example/x", "http://evil.example/x"} {
			if _, ok := SafePath(path); ok {
				t.Errorf("SafePath(%q) must be refused", path)
			}
		}
		if _, ok := SafePath(""); ok {
			t.Error("SafePath(undefined) must be refused")
		}
	})

	t.Run("builds the upstream URL from the target's origin and path prefix plus the request path", func(t *testing.T) {
		built, err := UpstreamURL(mustURL(t, "https://api.z.ai/api/anthropic/"), "/v1/messages?x=1")
		if err != nil {
			t.Fatalf("UpstreamURL: %v", err)
		}
		if built.String() != "https://api.z.ai/api/anthropic/v1/messages?x=1" {
			t.Errorf("UpstreamURL = %q", built.String())
		}
		built, err = UpstreamURL(mustURL(t, "https://api.anthropic.com"), "/v1/messages")
		if err != nil {
			t.Fatalf("UpstreamURL: %v", err)
		}
		if built.String() != "https://api.anthropic.com/v1/messages" {
			t.Errorf("UpstreamURL = %q", built.String())
		}
	})

	t.Run("reads the model of a JSON body, and nothing from anything else", func(t *testing.T) {
		cases := []struct {
			body string
			want string
		}{
			{`{"model":"claude-x"}`, "claude-x"},
			{`{"model":7}`, ""},
			{"not json", ""},
			{"null", ""},
		}
		for _, tc := range cases {
			if got := RequestModel([]byte(tc.body)); got != tc.want {
				t.Errorf("RequestModel(%q) = %q, want %q", tc.body, got, tc.want)
			}
		}
	})

	t.Run("drops the connection's own headers on the way in and on the way out", func(t *testing.T) {
		forwarded := ForwardHeaders(http.Header{
			"connection": {"keep-alive"},
			"keep-alive": {"timeout=5"},
			"x-api-key":  {"k"},
			"host":       {"127.0.0.1:1"},
			"te":         {"x"},
		}, mustURL(t, "https://api.anthropic.com"), 3)
		wantForwarded := http.Header{"X-Api-Key": {"k"}, "Host": {"api.anthropic.com"}, "Content-Length": {"3"}}
		if !reflect.DeepEqual(forwarded, wantForwarded) {
			t.Errorf("ForwardHeaders = %v, want %v", forwarded, wantForwarded)
		}
		// Framing belongs to each hop too: a held-back answer is re-sent in one piece, and its
		// length is its own.
		for _, incoming := range []http.Header{
			{"connection": {"close"}, "keep-alive": {"x"}, "content-type": {"a"}},
			{"transfer-encoding": {"chunked"}, "content-type": {"a"}},
		} {
			if got := ResponseHeaders(incoming); !reflect.DeepEqual(got, http.Header{"Content-Type": {"a"}}) {
				t.Errorf("ResponseHeaders(%v) = %v", incoming, got)
			}
		}
	})
}

func TestBodies(t *testing.T) {
	t.Parallel()
	t.Run("reads a body under the limit and reports one over it", func(t *testing.T) {
		type result struct {
			body  []byte
			large bool
		}
		var seen []result
		port := serve(t, func(w http.ResponseWriter, req *http.Request) {
			body, err := ReadBody(req, 8)
			if errors.Is(err, ErrBodyTooLarge) {
				seen = append(seen, result{large: true})
			} else if err != nil {
				t.Errorf("ReadBody: %v", err)
			} else {
				seen = append(seen, result{body: body})
			}
		}, nil)
		if _, err := doRequest(port, requestOptions{body: "1234"}); err != nil {
			t.Fatalf("request: %v", err)
		}
		if _, err := doRequest(port, requestOptions{body: "123456789012"}); err != nil {
			t.Fatalf("request: %v", err)
		}
		if len(seen) != 2 || string(seen[0].body) != "1234" || !seen[1].large {
			t.Errorf("seen = %+v, want [1234, too-large]", seen)
		}
	})

	t.Run("answers an Anthropic-shaped error, and destroys a response whose headers already went out", func(t *testing.T) {
		port := serve(t, func(w http.ResponseWriter, req *http.Request) {
			res := NewResponse(w)
			res.WriteHeader(200)
			res.Write([]byte("started"))
			AnthropicError(res, 500, "api_error", "late")
		}, nil)
		if _, err := doRequest(port, requestOptions{}); err == nil {
			t.Error("the destroyed response must fail the request")
		}
	})
}

func TestProxyEnvironment(t *testing.T) {
	t.Parallel()
	t.Run("exempts loopback from a proxy: NO_PROXY and no_proxy gain 127.0.0.1 and localhost, only when a proxy is set", func(t *testing.T) {
		if got := ExemptLoopback(map[string]string{"HOME": "/h"}); !reflect.DeepEqual(got, map[string]string{"HOME": "/h"}) {
			t.Errorf("ExemptLoopback without a proxy = %v", got)
		}
		if got := ExemptLoopback(map[string]string{"HTTPS_PROXY": " "}); !reflect.DeepEqual(got, map[string]string{"HTTPS_PROXY": " "}) {
			t.Errorf("ExemptLoopback with a blank proxy = %v", got)
		}
		if got := ExemptLoopback(map[string]string{"https_proxy": "http://p:1"}); !reflect.DeepEqual(got, map[string]string{
			"https_proxy": "http://p:1",
			"NO_PROXY":    "127.0.0.1,localhost",
			"no_proxy":    "127.0.0.1,localhost",
		}) {
			t.Errorf("ExemptLoopback = %v", got)
		}
		if got := ExemptLoopback(map[string]string{"HTTP_PROXY": "http://p:1", "No_Proxy": "corp, localhost"}); !reflect.DeepEqual(got, map[string]string{
			"HTTP_PROXY": "http://p:1",
			"NO_PROXY":   "corp,localhost,127.0.0.1",
			"no_proxy":   "corp,localhost,127.0.0.1",
		}) {
			t.Errorf("ExemptLoopback = %v", got)
		}
		// Lowercase wins, as in NoProxy.
		got := ExemptLoopback(map[string]string{"HTTP_PROXY": "http://p:1", "no_proxy": "a", "NO_PROXY": "b"})
		if got["NO_PROXY"] != "a,127.0.0.1,localhost" {
			t.Errorf("NO_PROXY = %q", got["NO_PROXY"])
		}
		if got := ExemptLoopback(map[string]string{"HTTP_PROXY": "http://p:1", "NO_PROXY": "corp"}); !reflect.DeepEqual(got, map[string]string{
			"HTTP_PROXY": "http://p:1",
			"NO_PROXY":   "corp,127.0.0.1,localhost",
			"no_proxy":   "corp,127.0.0.1,localhost",
		}) {
			t.Errorf("ExemptLoopback = %v", got)
		}
		// Two oddly spelled no_proxy keys: the first in sorted order wins.
		got = ExemptLoopback(map[string]string{"HTTP_PROXY": "http://p:1", "No_Proxy": "a", "NO_proxY": "b"})
		if got["NO_PROXY"] != "b,127.0.0.1,localhost" {
			t.Errorf("NO_PROXY = %q", got["NO_PROXY"])
		}
	})

	t.Run("knows which runtimes proxy from the environment by themselves: Bun before 1.4", func(t *testing.T) {
		cases := []struct {
			bun  string
			want bool
		}{
			{"", false},
			{"1.3.14", true},
			{"0.9.0", true},
			{"1.4.0", false},
			{"2.0.0", false},
			{"1", true},
			{"0", true},
			{"x.2", false},
			{"1.x", false},
		}
		for _, tc := range cases {
			if got := BunProxiesItself(tc.bun); got != tc.want {
				t.Errorf("BunProxiesItself(%q) = %v, want %v", tc.bun, got, tc.want)
			}
		}
	})

	t.Run("honours NO_PROXY: everything, a host, a domain suffix in its three spellings, a port", func(t *testing.T) {
		cases := []struct {
			host string
			port string
			env  ProxyEnv
			want bool
		}{
			{"api.anthropic.com", "443", ProxyEnv{}, false},
			{"api.anthropic.com", "443", ProxyEnv{"NO_PROXY": "*"}, true},
			{"api.anthropic.com", "443", ProxyEnv{"no_proxy": "api.anthropic.com"}, true},
			{"api.anthropic.com", "443", ProxyEnv{"NO_PROXY": ".anthropic.com"}, true},
			{"api.anthropic.com", "443", ProxyEnv{"NO_PROXY": "*.anthropic.com"}, true},
			{"api.anthropic.com", "443", ProxyEnv{"NO_PROXY": "anthropic.com"}, true},
			{"api.anthropic.com", "443", ProxyEnv{"NO_PROXY": "anthropic.com:8443"}, false},
			{"api.anthropic.com", "443", ProxyEnv{"NO_PROXY": "other.com, ,api.anthropic.com:443"}, true},
			{"api.anthropic.com", "443", ProxyEnv{"NO_PROXY": "anthropic.com:443:9"}, true},
			{"notanthropic.com", "443", ProxyEnv{"NO_PROXY": "anthropic.com"}, false},
		}
		for _, tc := range cases {
			if got := NoProxy(tc.host, tc.port, tc.env); got != tc.want {
				t.Errorf("NoProxy(%q, %q, %v) = %v, want %v", tc.host, tc.port, tc.env, got, tc.want)
			}
		}
	})

	t.Run("picks HTTPS_PROXY or HTTP_PROXY by the target's scheme, in either case, lowercase first", func(t *testing.T) {
		https := mustURL(t, "https://api.anthropic.com/v1")
		plain := mustURL(t, "http://127.0.0.1:9/x")
		if proxy, ok := ProxyFor(https, ProxyEnv{}); ok {
			t.Errorf("ProxyFor(no env) = %v", proxy)
		}
		cases := []struct {
			target *url.URL
			env    ProxyEnv
			want   string
		}{
			{https, ProxyEnv{"HTTPS_PROXY": "http://proxy:3128"}, "http://proxy:3128"},
			{https, ProxyEnv{"https_proxy": "proxy:1", "HTTPS_PROXY": "http://other:2"}, "http://proxy:1"},
			{plain, ProxyEnv{"HTTP_PROXY": "http://proxy:3128", "HTTPS_PROXY": "http://no:1"}, "http://proxy:3128"},
			{mustURL(t, "http://plain.example/y"), ProxyEnv{"HTTP_PROXY": "proxy:1"}, "http://proxy:1"},
		}
		for _, tc := range cases {
			proxy, ok := ProxyFor(tc.target, tc.env)
			if !ok || proxy.String() != tc.want {
				t.Errorf("ProxyFor(%v, %v) = %v, %v, want %q", tc.target, tc.env, proxy, ok, tc.want)
			}
		}
		for _, env := range []ProxyEnv{
			{"HTTPS_PROXY": "  "},
			{"HTTPS_PROXY": "http://[bad"},
			{"HTTPS_PROXY": "http://proxy:1", "NO_PROXY": "anthropic.com"},
		} {
			if proxy, ok := ProxyFor(https, env); ok {
				t.Errorf("ProxyFor(%v) = %v, want none", env, proxy)
			}
		}
	})

	t.Run("keeps one pooled agent per route and makes a fresh one for a retry", func(t *testing.T) {
		target := mustURL(t, "http://127.0.0.1:1")
		if AgentFor(target, ProxyEnv{}, false) != AgentFor(target, ProxyEnv{}, false) {
			t.Error("the pooled agent of one route must be the same")
		}
		if AgentFor(target, ProxyEnv{}, true) == AgentFor(target, ProxyEnv{}, false) {
			t.Error("a fresh agent must differ from the pooled one")
		}
		if AgentFor(mustURL(t, "https://example.com"), ProxyEnv{}, false) == AgentFor(target, ProxyEnv{}, false) {
			t.Error("agents of different routes must differ")
		}
	})

	t.Run("tunnels through the proxy with CONNECT, with credentials when the proxy URL carries them", func(t *testing.T) {
		upstream := serve(t, func(w http.ResponseWriter, req *http.Request) {
			io.Copy(io.Discard, req.Body)
			fmt.Fprintf(w, "upstream saw %s", req.RequestURI)
		}, nil)
		type connect struct {
			url  string
			auth string
		}
		var mu sync.Mutex
		var connects []connect
		proxy := serve(t, func(w http.ResponseWriter, req *http.Request) {
			if req.Method != http.MethodConnect {
				io.WriteString(w, "not a forward proxy")
				return
			}
			mu.Lock()
			connects = append(connects, connect{url: req.RequestURI, auth: req.Header.Get("Proxy-Authorization")})
			mu.Unlock()
			client, _, err := http.NewResponseController(w).Hijack()
			if err != nil {
				return
			}
			host, port, err := net.SplitHostPort(req.RequestURI)
			if err != nil {
				client.Close()
				return
			}
			target, err := net.Dial("tcp", net.JoinHostPort(host, port))
			if err != nil {
				client.Close()
				return
			}
			if _, err := client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
				client.Close()
				target.Close()
				return
			}
			go func() {
				io.Copy(target, client)
				client.Close()
				target.Close()
			}()
			go func() {
				io.Copy(client, target)
				client.Close()
				target.Close()
			}()
		}, nil)
		viaProxy := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d%s", upstream, req.RequestURI))
		}, ProxyEnv{"HTTP_PROXY": fmt.Sprintf("http://user:p%%40ss@127.0.0.1:%d", proxy)}, relayExtra{})
		answer, err := doRequest(viaProxy.port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.body != "upstream saw /v1/messages?beta=true" {
			t.Errorf("body = %q", answer.body)
		}
		mu.Lock()
		defer mu.Unlock()
		want := []connect{{
			url:  fmt.Sprintf("127.0.0.1:%d", upstream),
			auth: "Basic " + base64.StdEncoding.EncodeToString([]byte("user:p@ss")),
		}}
		if !reflect.DeepEqual(connects, want) {
			t.Errorf("connects = %+v, want %+v", connects, want)
		}
	})

	t.Run("reports a proxy that refuses the tunnel", func(t *testing.T) {
		proxy := serve(t, func(w http.ResponseWriter, req *http.Request) {
			w.WriteHeader(403)
		}, nil)
		viaProxy := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, "http://127.0.0.1:9/x")
		}, ProxyEnv{"HTTP_PROXY": fmt.Sprintf("http://127.0.0.1:%d", proxy)}, relayExtra{})
		answer, err := doRequest(viaProxy.port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.status != 502 {
			t.Errorf("status = %d, want 502", answer.status)
		}
		if len(viaProxy.failureList()) != 1 {
			t.Errorf("failures = %+v, want one", viaProxy.failureList())
		}
	})

	t.Run("gives up on a proxy that accepts the connection but never answers CONNECT", func(t *testing.T) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		t.Cleanup(func() { listener.Close() })
		go func() {
			for {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				go io.Copy(io.Discard, conn)
			}
		}()
		viaProxy := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, "http://127.0.0.1:9/x")
		}, ProxyEnv{"HTTP_PROXY": fmt.Sprintf("http://127.0.0.1:%d", listener.Addr().(*net.TCPAddr).Port)}, relayExtra{idleMs: 150})
		answer, err := doRequest(viaProxy.port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.status != 502 {
			t.Errorf("status = %d, want 502", answer.status)
		}
		// The CONNECT's own idle budget ended it: the call's idle timeout cannot (no socket
		// belongs to it yet).
		if failures := viaProxy.failureList(); !reflect.DeepEqual(failures, []UpstreamFailure{{Code: "ETIMEDOUT"}}) {
			t.Errorf("failures = %+v, want one ETIMEDOUT", failures)
		}
	})

	t.Run("aborts the CONNECT a hung proxy never answers when the client goes away", func(t *testing.T) {
		var asked atomic.Int64
		var closed atomic.Bool
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		t.Cleanup(func() { listener.Close() })
		go func() {
			for {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				asked.Add(1)
				go func(conn net.Conn) {
					io.Copy(io.Discard, conn)
					closed.Store(true)
				}(conn)
			}
		}()
		viaProxy := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, "http://127.0.0.1:9/x")
		}, ProxyEnv{"HTTP_PROXY": fmt.Sprintf("http://127.0.0.1:%d", listener.Addr().(*net.TCPAddr).Port)}, relayExtra{})
		socket, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", viaProxy.port))
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		if _, err := socket.Write([]byte("POST /x HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 2\r\n\r\n{}")); err != nil {
			t.Fatalf("write: %v", err)
		}
		if !until(func() bool { return asked.Load() > 0 }) {
			t.Fatal("the proxy never saw the CONNECT")
		}
		socket.Close()
		if !until(closed.Load) {
			t.Error("the CONNECT must close when the client goes away")
		}
	})

	t.Run("leaves the proxying to Node when NODE_USE_ENV_PROXY=1", func(t *testing.T) {
		var mu sync.Mutex
		var forwarded []string
		proxy := serve(t, func(w http.ResponseWriter, req *http.Request) {
			mu.Lock()
			forwarded = append(forwarded, req.URL.String())
			mu.Unlock()
			io.Copy(io.Discard, req.Body)
			io.WriteString(w, "via node's proxy")
		}, nil)
		viaNode := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, "http://127.0.0.1:9/x")
		}, ProxyEnv{"NODE_USE_ENV_PROXY": "1", "HTTP_PROXY": fmt.Sprintf("http://127.0.0.1:%d", proxy)}, relayExtra{})
		answer, err := doRequest(viaNode.port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.body != "via node's proxy" {
			t.Errorf("body = %q", answer.body)
		}
		mu.Lock()
		defer mu.Unlock()
		if !reflect.DeepEqual(forwarded, []string{"http://127.0.0.1:9/x"}) {
			t.Errorf("forwarded = %v", forwarded)
		}
	})
}

// countingListener counts accepted connections.
type countingListener struct {
	net.Listener
	accepted atomic.Int64
}

func (l *countingListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err == nil {
		l.accepted.Add(1)
	}
	return conn, err
}

// trackedServer answers /stream with a stream that never ends and everything else at once,
// tracked.
type trackedServer struct {
	tracker *Connections
	client  *http.Client
	mu      sync.Mutex
	closes  []int
	get     func(path string) (*http.Response, error)
	opened  func() int
}

func tracked(t *testing.T, sawRequest chan struct{}) *trackedServer {
	t.Helper()
	ts := &trackedServer{}
	ts.tracker = TrackConnections(func(open int) {
		ts.mu.Lock()
		defer ts.mu.Unlock()
		ts.closes = append(ts.closes, open)
	})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/stream" {
			w.WriteHeader(200)
			w.Write([]byte("first\n"))
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			<-req.Context().Done()
			return
		}
		if sawRequest != nil {
			select {
			case sawRequest <- struct{}{}:
			default:
			}
		}
		w.Write([]byte("ok"))
	})}
	ts.tracker.Watch(server)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	counting := &countingListener{Listener: listener}
	go server.Serve(counting)
	t.Cleanup(func() {
		ts.tracker.CloseAll()
		server.Close()
	})
	port := listener.Addr().(*net.TCPAddr).Port
	ts.client = &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{}}
	ts.get = func(path string) (*http.Response, error) {
		request, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), nil)
		if err != nil {
			return nil, err
		}
		return ts.client.Do(request)
	}
	ts.opened = func() int { return int(counting.accepted.Load()) }
	return ts
}

func (ts *trackedServer) closeList() []int {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	return append([]int(nil), ts.closes...)
}

func TestConnectionTracking(t *testing.T) {
	t.Parallel()
	t.Run("drain closes an idle keep-alive socket at once and a busy one as soon as its response is done", func(t *testing.T) {
		ts := tracked(t, nil)
		answer, err := ts.get("/")
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		io.Copy(io.Discard, answer.Body)
		answer.Body.Close()
		if !until(func() bool { return ts.tracker.Size() == 1 }) {
			t.Fatal("the socket must be tracked")
		}
		ts.tracker.Drain()
		if !until(func() bool { return ts.tracker.Size() == 0 }) {
			t.Fatal("drain must close the idle socket")
		}
		if closes := ts.closeList(); !reflect.DeepEqual(closes, []int{0}) {
			t.Errorf("closes = %v, want [0]", closes)
		}
	})

	t.Run("drain leaves a streaming response open; closeAll ends it", func(t *testing.T) {
		ts := tracked(t, nil)
		answer, err := ts.get("/stream")
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		var ended atomic.Bool
		go func() {
			io.Copy(io.Discard, answer.Body)
			answer.Body.Close()
			ended.Store(true)
		}()
		ts.tracker.Drain()
		time.Sleep(50 * time.Millisecond)
		if ended.Load() {
			t.Error("drain must leave the streaming response open")
		}
		if ts.tracker.Size() != 1 {
			t.Errorf("size = %d, want 1", ts.tracker.Size())
		}
		ts.tracker.CloseAll()
		if !until(ended.Load) {
			t.Error("closeAll must end the streaming response")
		}
	})

	t.Run("a busy socket that finishes while draining closes right after its response", func(t *testing.T) {
		sawRequest := make(chan struct{}, 1)
		ts := tracked(t, sawRequest)
		type outcome struct {
			answer *http.Response
			err    error
		}
		done := make(chan outcome, 1)
		go func() {
			answer, err := ts.get("/")
			done <- outcome{answer: answer, err: err}
		}()
		<-sawRequest
		ts.tracker.Drain()
		result := <-done
		if result.err != nil {
			t.Fatalf("get: %v", result.err)
		}
		body, err := io.ReadAll(result.answer.Body)
		result.answer.Body.Close()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if string(body) != "ok" {
			t.Errorf("body = %q, want ok", body)
		}
		if !until(func() bool { return ts.tracker.Size() == 0 }) {
			t.Fatal("the socket must close right after its response")
		}
		if ts.opened() != 1 {
			t.Errorf("opened %d connections, want 1", ts.opened())
		}
	})
}

// cutUpstream writes a partial answer, then destroys the connection the answer was going out on.
func cutUpstream(headers map[string]string, writes []string, wait time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		io.Copy(io.Discard, req.Body)
		for name, value := range headers {
			w.Header().Set(name, value)
		}
		w.WriteHeader(200)
		flusher, _ := w.(http.Flusher)
		for _, write := range writes {
			w.Write([]byte(write))
			if flusher != nil {
				flusher.Flush()
			}
		}
		time.Sleep(wait)
		panic(http.ErrAbortHandler)
	}
}

// edgyKeepAlive answers the first request by hand on a hijacked keep-alive socket, then watches
// that socket: the moment the client's pooled reuse writes its next request on it, the socket ends
// exactly as the upstream's idle-timeout close races the reuse — a reset with `reset`, a clean
// close without. Every later request is answered normally, on a connection of its own. The
// forced race is deterministic: no timer decides when the close lands; the request's own bytes do.
func edgyKeepAlive(t *testing.T, reset bool) (*atomic.Int64, int) {
	t.Helper()
	var served atomic.Int64
	port := serve(t, func(w http.ResponseWriter, req *http.Request) {
		io.Copy(io.Discard, req.Body)
		if served.Add(1) == 1 {
			conn, _, err := http.NewResponseController(w).Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			// A proper keep-alive answer: the client pools the socket the moment this body ends.
			_, _ = conn.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nanswer 1"))
			go func() {
				buffer := make([]byte, 1)
				// One byte of the reused request is enough: the request was written on the socket.
				_, _ = conn.Read(buffer)
				if reset {
					if tcp, ok := conn.(*net.TCPConn); ok {
						_ = tcp.SetLinger(0)
					}
				}
				_ = conn.Close()
			}()
			return
		}
		_, _ = w.Write([]byte("answer 2"))
	}, nil)
	return &served, port
}

func TestOneRequestUpstream(t *testing.T) {
	t.Parallel()
	t.Run("retries once on a fresh socket when a reused one turns out closed before any answer", func(t *testing.T) {
		var served atomic.Int64
		upstream := serve(t, func(w http.ResponseWriter, req *http.Request) {
			io.Copy(io.Discard, req.Body)
			n := served.Add(1)
			conn, _, err := http.NewResponseController(w).Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			// The upstream answers, then closes its idle keep-alive socket right after: the
			// next reuse finds it dead.
			body := fmt.Sprintf("answer %d", n)
			head := fmt.Sprintf("HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n", len(body))
			conn.Write([]byte(head + body))
			time.Sleep(time.Millisecond)
			conn.Close()
		}, nil)
		rs := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", upstream))
		}, ProxyEnv{}, relayExtra{})
		answer, err := doRequest(rs.port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.body != "answer 1" {
			t.Errorf("body = %q, want answer 1", answer.body)
		}
		time.Sleep(20 * time.Millisecond)
		answer, err = doRequest(rs.port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.status != 200 {
			t.Errorf("status = %d, want 200", answer.status)
		}
		if served.Load() != 2 {
			t.Errorf("served %d requests, want 2", served.Load())
		}
		if failures := rs.failureList(); len(failures) != 0 {
			t.Errorf("failures = %+v, want none", failures)
		}
	})

	t.Run("retries once on a fresh connection when the upstream resets the pooled socket as the request is written", func(t *testing.T) {
		served, port := edgyKeepAlive(t, true)
		rs := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", port))
		}, ProxyEnv{}, relayExtra{})
		if answer, err := doRequest(rs.port, requestOptions{body: "{}"}); err != nil || answer.body != "answer 1" {
			t.Fatalf("first request = %q %v, want answer 1", answer.body, err)
		}
		answer, err := doRequest(rs.port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("second request: %v", err)
		}
		if answer.status != 200 || answer.body != "answer 2" {
			t.Errorf("second request = %d %q, want 200 answer 2", answer.status, answer.body)
		}
		if served.Load() != 2 {
			t.Errorf("served %d requests, want 2", served.Load())
		}
		if failures := rs.failureList(); len(failures) != 0 {
			t.Errorf("failures = %+v, want none", failures)
		}
	})

	t.Run("retries once when the pooled socket ends cleanly, with an EOF, as the request is written", func(t *testing.T) {
		served, port := edgyKeepAlive(t, false)
		rs := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", port))
		}, ProxyEnv{}, relayExtra{})
		if answer, err := doRequest(rs.port, requestOptions{body: "{}"}); err != nil || answer.body != "answer 1" {
			t.Fatalf("first request = %q %v, want answer 1", answer.body, err)
		}
		answer, err := doRequest(rs.port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("second request: %v", err)
		}
		if answer.status != 200 || answer.body != "answer 2" {
			t.Errorf("second request = %d %q, want 200 answer 2", answer.status, answer.body)
		}
		if served.Load() != 2 {
			t.Errorf("served %d requests, want 2", served.Load())
		}
		if failures := rs.failureList(); len(failures) != 0 {
			t.Errorf("failures = %+v, want none", failures)
		}
	})

	t.Run("reports the failure when the retried connection fails too, and retries no further", func(t *testing.T) {
		var served atomic.Int64
		port := serve(t, func(w http.ResponseWriter, req *http.Request) {
			io.Copy(io.Discard, req.Body)
			n := served.Add(1)
			conn, _, err := http.NewResponseController(w).Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			if n == 1 {
				// A proper keep-alive answer, then the watched socket: the pooled reuse is reset
				// the moment its request is written.
				_, _ = conn.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nanswer 1"))
				go func() {
					buffer := make([]byte, 1)
					_, _ = conn.Read(buffer)
					if tcp, ok := conn.(*net.TCPConn); ok {
						_ = tcp.SetLinger(0)
					}
					_ = conn.Close()
				}()
				return
			}
			// Every connection of the retry's own resets it without an answer.
			if tcp, ok := conn.(*net.TCPConn); ok {
				_ = tcp.SetLinger(0)
			}
			_ = conn.Close()
		}, nil)
		rs := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", port))
		}, ProxyEnv{}, relayExtra{})
		if answer, err := doRequest(rs.port, requestOptions{body: "{}"}); err != nil || answer.body != "answer 1" {
			t.Fatalf("first request = %q %v, want answer 1", answer.body, err)
		}
		answer, err := doRequest(rs.port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("second request: %v", err)
		}
		if answer.status != 502 {
			t.Errorf("status = %d, want 502", answer.status)
		}
		failures := rs.failureList()
		if len(failures) != 1 || failures[0].Code != "ECONNRESET" && failures[0].Code != "EPIPE" {
			t.Fatalf("failures = %+v, want exactly one ECONNRESET or EPIPE", failures)
		}
		if served.Load() != 2 {
			t.Errorf("served %d requests, want 2: one stale reuse and one reset retry, no more", served.Load())
		}
	})

	t.Run("does not retry a reset on a socket the pool had not used before", func(t *testing.T) {
		var served atomic.Int64
		upstream := serve(t, func(w http.ResponseWriter, req *http.Request) {
			io.Copy(io.Discard, req.Body)
			served.Add(1)
			conn, _, err := http.NewResponseController(w).Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			// The request was written and read; the socket dies without an answer, as a fresh one
			// the upstream refuses to serve.
			if tcp, ok := conn.(*net.TCPConn); ok {
				_ = tcp.SetLinger(0)
			}
			conn.Close()
		}, nil)
		rs := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", upstream))
		}, ProxyEnv{}, relayExtra{})
		answer, err := doRequest(rs.port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.status != 502 {
			t.Errorf("status = %d, want 502", answer.status)
		}
		failures := rs.failureList()
		if len(failures) != 1 {
			t.Fatalf("failures = %+v, want exactly one", failures)
		}
		if failures[0].Code != "ECONNRESET" && failures[0].Code != "EPIPE" {
			t.Errorf("failure code = %q, want ECONNRESET or EPIPE", failures[0].Code)
		}
		if served.Load() != 1 {
			t.Errorf("served %d requests, want 1: a fresh socket is never retried", served.Load())
		}
	})

	t.Run("gives up on an upstream that stays silent (an idle timeout, not a total one)", func(t *testing.T) {
		upstream := serve(t, func(w http.ResponseWriter, req *http.Request) {
			<-req.Context().Done()
		}, nil)
		rs := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", upstream))
		}, ProxyEnv{}, relayExtra{idleMs: 100})
		answer, err := doRequest(rs.port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.status != 502 {
			t.Errorf("status = %d, want 502", answer.status)
		}
		if failures := rs.failureList(); !reflect.DeepEqual(failures, []UpstreamFailure{{Code: "ETIMEDOUT"}}) {
			t.Errorf("failures = %+v, want one ETIMEDOUT", failures)
		}
	})

	t.Run("ends the client's answer when the upstream's stops mid-body, instead of leaving it open", func(t *testing.T) {
		upstream := serve(t, cutUpstream(map[string]string{"Content-Length": "100"}, []string{"partial"}, 20*time.Millisecond), nil)
		rs := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", upstream))
		}, ProxyEnv{}, relayExtra{})
		if _, err := doRequest(rs.port, requestOptions{body: "{}"}); err == nil {
			t.Error("the cut answer must fail the request")
		}
		time.Sleep(20 * time.Millisecond)
		if failures := rs.failureList(); !reflect.DeepEqual(failures, []UpstreamFailure{{Code: "EABORTED", AfterHeaders: true}}) {
			t.Errorf("failures = %+v, want one EABORTED after the headers", failures)
		}
	})

	t.Run("ends a cut event-stream answer with a terminal SSE error event instead of destroying it", func(t *testing.T) {
		upstream := serve(t, cutUpstream(map[string]string{"Content-Type": "text/event-stream"}, []string{
			"event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
			"event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n\n",
		}, 20*time.Millisecond), nil)
		rs := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", upstream))
		}, ProxyEnv{}, relayExtra{})
		answer, err := doRequest(rs.port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		// The bytes that made it out are exactly the upstream's, closed by the one terminal event.
		want := "event: message_start\ndata: {\"type\":\"message_start\"}\n\n" +
			"event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n\n" +
			"event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"upstream connection failed (EABORTED)\"}}\n\n"
		if answer.body != want {
			t.Errorf("body = %q, want %q", answer.body, want)
		}
		time.Sleep(20 * time.Millisecond)
		if failures := rs.failureList(); !reflect.DeepEqual(failures, []UpstreamFailure{{Code: "EABORTED", AfterHeaders: true}}) {
			t.Errorf("failures = %+v, want one EABORTED after the headers", failures)
		}
	})

	t.Run("closes an event the cut split before it writes the terminal error event", func(t *testing.T) {
		upstream := serve(t, cutUpstream(map[string]string{"Content-Type": "text/event-stream"}, []string{
			"event: content_block_delta\ndata: {\"type\":\"conte",
		}, 20*time.Millisecond), nil)
		rs := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", upstream))
		}, ProxyEnv{}, relayExtra{})
		answer, err := doRequest(rs.port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		want := "event: content_block_delta\ndata: {\"type\":\"conte\n\n" +
			"event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"upstream connection failed (EABORTED)\"}}\n\n"
		if answer.body != want {
			t.Errorf("body = %q, want %q", answer.body, want)
		}
	})

	t.Run("aborts the upstream request when the client goes away", func(t *testing.T) {
		var closed atomic.Bool
		upstream := serve(t, func(w http.ResponseWriter, req *http.Request) {
			io.Copy(io.Discard, req.Body)
			<-req.Context().Done()
			closed.Store(true)
		}, nil)
		rs := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", upstream))
		}, ProxyEnv{}, relayExtra{direct: true})
		socket, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", rs.port))
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		if _, err := socket.Write([]byte("POST /x HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 2\r\n\r\n{}")); err != nil {
			t.Fatalf("write: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
		socket.Close()
		if !until(closed.Load) {
			t.Error("the upstream request must abort when the client goes away")
		}
	})

	t.Run("pipes the answer through, status and body, and says when it finished", func(t *testing.T) {
		upstream := serve(t, func(w http.ResponseWriter, req *http.Request) {
			io.Copy(io.Discard, req.Body)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Connection", "close")
			w.WriteHeader(201)
			w.Write([]byte(`{"done":true}`))
		}, nil)
		rs := relay(t, func(req *http.Request) *url.URL {
			return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", upstream))
		}, ProxyEnv{}, relayExtra{})
		answer, err := doRequest(rs.port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.status != 201 || answer.body != `{"done":true}` {
			t.Errorf("answer = %d %q", answer.status, answer.body)
		}
		time.Sleep(10 * time.Millisecond)
		if finished := rs.finishedList(); !reflect.DeepEqual(finished, []int{201}) {
			t.Errorf("finished = %v, want [201]", finished)
		}
	})
}

// logLines collects the passthrough's log lines.
type logLines struct {
	mu    sync.Mutex
	lines []string
}

func (l *logLines) add(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, line)
}

func (l *logLines) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.lines...)
}

func passthroughServer(t *testing.T, anthropic *url.URL, logs *logLines) int {
	t.Helper()
	options := PassthroughOptions{
		Name:      "acme",
		Display:   "Acme Models",
		Claim:     domain.ModelClaim{Prefixes: []string{"big-"}},
		Anthropic: anthropic,
		Env:       ProxyEnv{},
		State:     "degraded after repeated crashes",
		IdleMs:    1000,
		Log:       logs.add,
	}
	return serve(t, func(w http.ResponseWriter, req *http.Request) {
		body, err := ReadBody(req, BodyLimitBytes)
		if err != nil {
			return
		}
		PassThrough(options, req, NewResponse(w), body)
	}, nil)
}

func TestThePassthrough(t *testing.T) {
	t.Parallel()
	t.Run("pipes Claude's requests to Anthropic exactly: method, path, query, headers, body, status, stream", func(t *testing.T) {
		type seen struct {
			method string
			url    string
			header http.Header
			body   string
		}
		var mu sync.Mutex
		var requests []seen
		anthropic := serve(t, func(w http.ResponseWriter, req *http.Request) {
			body, _ := io.ReadAll(req.Body)
			mu.Lock()
			requests = append(requests, seen{method: req.Method, url: req.RequestURI, header: req.Header.Clone(), body: string(body)})
			mu.Unlock()
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(207)
			w.Write([]byte("data: 1\n\n"))
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			time.Sleep(10 * time.Millisecond)
			w.Write([]byte("data: 2\n\n"))
		}, nil)
		logs := &logLines{}
		port := passthroughServer(t, mustURL(t, fmt.Sprintf("http://127.0.0.1:%d", anthropic)), logs)
		body := `{"model":"claude-x","stream":true}`
		answer, err := doRequest(port, requestOptions{method: http.MethodPut, body: body, headers: map[string]string{
			"authorization": "Bearer caller",
			"x-api-key":     "caller-key",
			"content-type":  "application/json",
		}})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.status != 207 || answer.body != "data: 1\n\ndata: 2\n\n" {
			t.Errorf("answer = %d %q", answer.status, answer.body)
		}
		mu.Lock()
		defer mu.Unlock()
		if len(requests) != 1 {
			t.Fatalf("anthropic saw %d requests, want 1", len(requests))
		}
		first := requests[0]
		if first.method != http.MethodPut || first.url != "/v1/messages?beta=true" || first.body != body {
			t.Errorf("seen = %s %s %q", first.method, first.url, first.body)
		}
		if first.header.Get("Authorization") != "Bearer caller" || first.header.Get("X-Api-Key") != "caller-key" {
			t.Errorf("headers = %v", first.header)
		}
	})

	t.Run("treats a body that does not parse, or names no model, as Anthropic's", func(t *testing.T) {
		anthropic := serve(t, func(w http.ResponseWriter, req *http.Request) {
			io.Copy(io.Discard, req.Body)
			io.WriteString(w, "anthropic")
		}, nil)
		port := passthroughServer(t, mustURL(t, fmt.Sprintf("http://127.0.0.1:%d", anthropic)), &logLines{})
		for _, body := range []string{"not json", "{}"} {
			answer, err := doRequest(port, requestOptions{body: body})
			if err != nil {
				t.Fatalf("request(%q): %v", body, err)
			}
			if answer.body != "anthropic" {
				t.Errorf("body after %q = %q", body, answer.body)
			}
		}
	})

	t.Run("answers a provider-model request 503 with what to run, and a bad path 400", func(t *testing.T) {
		logs := &logLines{}
		port := passthroughServer(t, mustURL(t, "http://127.0.0.1:9"), logs)
		provider, err := doRequest(port, requestOptions{body: `{"model":"big-9"}`})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if provider.status != 503 {
			t.Errorf("status = %d, want 503", provider.status)
		}
		var got struct {
			Type  string `json:"type"`
			Error struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(provider.body), &got); err != nil {
			t.Fatalf("parse: %v", err)
		}
		wantMessage := DegradedMessage("acme", "Acme Models", "degraded after repeated crashes")
		if got.Type != "error" || got.Error.Type != "api_error" || got.Error.Message != wantMessage {
			t.Errorf("body = %s", provider.body)
		}
		if wantMessage != "Acme Models router degraded after repeated crashes; Claude models still work. Run /acme:setup." {
			t.Errorf("DegradedMessage = %q", wantMessage)
		}
		if DegradedMessage("acme", "Acme Models", "x") != "Acme Models router x; Claude models still work. Run /acme:setup." {
			t.Error("DegradedMessage(x) is wrong")
		}
		if lines := logs.snapshot(); !reflect.DeepEqual(lines, []string{
			"POST /v1/messages?beta=true model=big-9 → refused (degraded after repeated crashes)",
		}) {
			t.Errorf("logs = %q", lines)
		}
		if bad, err := doRequest(port, requestOptions{path: "//evil/x", body: "{}"}); err != nil || bad.status != 400 {
			t.Errorf("bad path: %v %d", err, bad.status)
		}
	})

	t.Run("answers a 502 when Anthropic cannot be reached", func(t *testing.T) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		gone := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {})}
		go gone.Serve(listener)
		t.Cleanup(func() { gone.Close() })
		logs := &logLines{}
		port := passthroughServer(t, mustURL(t, fmt.Sprintf("http://127.0.0.1:%d", listener.Addr().(*net.TCPAddr).Port)), logs)
		gone.Close()
		time.Sleep(20 * time.Millisecond)
		answer, err := doRequest(port, requestOptions{body: `{"model":"claude-x"}`})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.status != 502 {
			t.Errorf("status = %d, want 502", answer.status)
		}
		if lines := logs.snapshot(); len(lines) != 1 || !strings.HasPrefix(lines[0], "POST /v1/messages?beta=true model=claude-x → anthropic error ") {
			t.Errorf("logs = %q", lines)
		}
	})
}

func TestInspect(t *testing.T) {
	t.Parallel()
	// inspected is a relay whose answers go through an inspect judge.
	inspected := func(t *testing.T, inspect func(*http.Response) func([]byte) (Replacement, bool)) int {
		t.Helper()
		upstream := serve(t, func(w http.ResponseWriter, req *http.Request) {
			io.Copy(io.Discard, req.Body)
			w.Write([]byte("hello refuse"))
		}, nil)
		return serve(t, func(w http.ResponseWriter, req *http.Request) {
			body, err := ReadBody(req, BodyLimitBytes)
			if err != nil {
				return
			}
			res := NewResponse(w)
			target := mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", upstream))
			SendUpstream(req.Context(), UpstreamCall{
				URL:     target,
				Method:  req.Method,
				Headers: ForwardHeaders(req.Header, target, len(body)),
				Body:    body,
				Env:     ProxyEnv{},
			}, res, UpstreamHooks{
				Inspect: inspect,
				Failed: func(failure UpstreamFailure) {
					if !failure.AfterHeaders {
						AnthropicError(res, 502, "api_error", failure.Code)
					}
				},
			})
		}, nil)
	}
	t.Run("holds a short answer back and sends its judge's replacement", func(t *testing.T) {
		var ran atomic.Bool
		port := inspected(t, func(answer *http.Response) func([]byte) (Replacement, bool) {
			return func(body []byte) (Replacement, bool) {
				ran.Store(true)
				if string(body) == "hello refuse" {
					return Replacement{
						Status:  418,
						Headers: http.Header{"X-Test": {"1"}},
						Body:    "rewritten",
					}, true
				}
				return Replacement{}, false
			}
		})
		answer, err := doRequest(port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.status != 418 || answer.body != "rewritten" || answer.header.Get("X-Test") != "1" {
			t.Errorf("answer = %d %q %v", answer.status, answer.body, answer.header)
		}
		if !ran.Load() {
			t.Error("the judge must have run")
		}
	})
	t.Run("sends the answer as it came when its judge returns none", func(t *testing.T) {
		port := inspected(t, func(answer *http.Response) func([]byte) (Replacement, bool) {
			return func([]byte) (Replacement, bool) { return Replacement{}, false }
		})
		answer, err := doRequest(port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.status != 200 || answer.body != "hello refuse" {
			t.Errorf("answer = %d %q", answer.status, answer.body)
		}
	})
}

func TestInspectOversize(t *testing.T) {
	t.Parallel()
	judgeRan := &atomic.Bool{}
	oversizeCalled := &atomic.Bool{}
	upstream := serve(t, func(w http.ResponseWriter, req *http.Request) {
		io.Copy(io.Discard, req.Body)
		w.Write(bytes.Repeat([]byte("x"), 70*1024))
	}, nil)
	port := serve(t, func(w http.ResponseWriter, req *http.Request) {
		body, err := ReadBody(req, BodyLimitBytes)
		if err != nil {
			return
		}
		res := NewResponse(w)
		target := mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", upstream))
		SendUpstream(req.Context(), UpstreamCall{
			URL:     target,
			Method:  req.Method,
			Headers: ForwardHeaders(req.Header, target, len(body)),
			Body:    body,
			Env:     ProxyEnv{},
		}, res, UpstreamHooks{
			Inspect: func(answer *http.Response) func([]byte) (Replacement, bool) {
				return func([]byte) (Replacement, bool) {
					judgeRan.Store(true)
					return Replacement{Status: 500, Body: "judged"}, true
				}
			},
			Oversize: func(*http.Response) { oversizeCalled.Store(true) },
			Failed: func(failure UpstreamFailure) {
				if !failure.AfterHeaders {
					AnthropicError(res, 502, "api_error", failure.Code)
				}
			},
		})
	}, nil)
	answer, err := doRequest(port, requestOptions{body: "{}"})
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if answer.status != 200 || len(answer.body) != 70*1024 {
		t.Errorf("answer = %d, %d bytes", answer.status, len(answer.body))
	}
	if judgeRan.Load() || !oversizeCalled.Load() {
		t.Errorf("judge ran: %v, oversize called: %v", judgeRan.Load(), oversizeCalled.Load())
	}
}

func TestInspectGzipped(t *testing.T) {
	t.Parallel()
	judgeSaw := &atomic.Value{}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	writer.Write([]byte("gz refuse"))
	writer.Close()
	upstream := serve(t, func(w http.ResponseWriter, req *http.Request) {
		io.Copy(io.Discard, req.Body)
		w.Header().Set("Content-Encoding", "gzip")
		w.Write(compressed.Bytes())
	}, nil)
	port := serve(t, func(w http.ResponseWriter, req *http.Request) {
		body, err := ReadBody(req, BodyLimitBytes)
		if err != nil {
			return
		}
		res := NewResponse(w)
		target := mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", upstream))
		SendUpstream(req.Context(), UpstreamCall{
			URL:     target,
			Method:  req.Method,
			Headers: ForwardHeaders(req.Header, target, len(body)),
			Body:    body,
			Env:     ProxyEnv{},
		}, res, UpstreamHooks{
			Inspect: func(answer *http.Response) func([]byte) (Replacement, bool) {
				return func(body []byte) (Replacement, bool) {
					plain := InspectBody(body, answer.Header.Get("Content-Encoding"))
					judgeSaw.Store(string(plain))
					return Replacement{Status: 418, Body: string(plain)}, true
				}
			},
			Failed: func(failure UpstreamFailure) {
				if !failure.AfterHeaders {
					AnthropicError(res, 502, "api_error", failure.Code)
				}
			},
		})
	}, nil)
	answer, err := doRequest(port, requestOptions{body: "{}"})
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if answer.status != 418 || answer.body != "gz refuse" {
		t.Errorf("answer = %d %q", answer.status, answer.body)
	}
	if got, _ := judgeSaw.Load().(string); got != "gz refuse" {
		t.Errorf("the judge saw %q", got)
	}
}

func TestInspectBrotli(t *testing.T) {
	t.Parallel()
	// A provider answer compressed with brotli is inspected through, its text read exactly like
	// gzip's.
	judgeSaw := &atomic.Value{}
	plain := `{"error":{"code":"1113","message":"Insufficient balance or no resource package"}}`
	var brotlied bytes.Buffer
	brotliWriter := brotli.NewWriter(&brotlied)
	brotliWriter.Write([]byte(plain))
	brotliWriter.Close()
	upstream := serve(t, func(w http.ResponseWriter, req *http.Request) {
		io.Copy(io.Discard, req.Body)
		w.Header().Set("Content-Encoding", "br")
		w.WriteHeader(429)
		w.Write(brotlied.Bytes())
	}, nil)
	port := serve(t, func(w http.ResponseWriter, req *http.Request) {
		body, err := ReadBody(req, BodyLimitBytes)
		if err != nil {
			return
		}
		res := NewResponse(w)
		target := mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", upstream))
		SendUpstream(req.Context(), UpstreamCall{
			URL:     target,
			Method:  req.Method,
			Headers: ForwardHeaders(req.Header, target, len(body)),
			Body:    body,
			Env:     ProxyEnv{},
		}, res, UpstreamHooks{
			Inspect: func(answer *http.Response) func([]byte) (Replacement, bool) {
				if !MayRefuse(answer.StatusCode) {
					t.Errorf("MayRefuse(%d) must hold before the answer is read", answer.StatusCode)
				}
				return func(body []byte) (Replacement, bool) {
					text := InspectBody(body, answer.Header.Get("Content-Encoding"))
					judgeSaw.Store(string(text))
					return Replacement{Status: 400, Body: "read: " + string(text)}, true
				}
			},
			Failed: func(failure UpstreamFailure) {
				if !failure.AfterHeaders {
					AnthropicError(res, 502, "api_error", failure.Code)
				}
			},
		})
	}, nil)
	answer, err := doRequest(port, requestOptions{body: "{}"})
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if answer.status != 400 || answer.body != "read: "+plain {
		t.Errorf("answer = %d %q", answer.status, answer.body)
	}
	if got, _ := judgeSaw.Load().(string); got != plain {
		t.Errorf("the judge saw %q, want the decompressed JSON error body", got)
	}
}

// upperReader uppercases the bytes that pass through it (a rewrite of the passing bytes).
type upperReader struct{ reader io.Reader }

func (u upperReader) Read(p []byte) (int, error) {
	n, err := u.reader.Read(p)
	for i := 0; i < n; i++ {
		if p[i] >= 'a' && p[i] <= 'z' {
			p[i] -= 'a' - 'A'
		}
	}
	return n, err
}

func TestSendUpstreamRewrite(t *testing.T) {
	t.Parallel()
	t.Run("rewrite rewrites the bytes as they pass", func(t *testing.T) {
		upstream := serve(t, func(w http.ResponseWriter, req *http.Request) {
			io.Copy(io.Discard, req.Body)
			w.Write([]byte("stream of words"))
		}, nil)
		port := serve(t, func(w http.ResponseWriter, req *http.Request) {
			body, err := ReadBody(req, BodyLimitBytes)
			if err != nil {
				return
			}
			res := NewResponse(w)
			target := mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/x", upstream))
			SendUpstream(req.Context(), UpstreamCall{
				URL:     target,
				Method:  req.Method,
				Headers: ForwardHeaders(req.Header, target, len(body)),
				Body:    body,
				Env:     ProxyEnv{},
			}, res, UpstreamHooks{
				Rewrite: func(answer *http.Response) io.Reader { return upperReader{answer.Body} },
				Failed:  func(UpstreamFailure) {},
			})
		}, nil)
		answer, err := doRequest(port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.body != "STREAM OF WORDS" {
			t.Errorf("body = %q", answer.body)
		}
	})
}

func TestInspectBody(t *testing.T) {
	t.Parallel()
	t.Run("returns the answer's own bytes for any encoding it cannot read", func(t *testing.T) {
		plain := []byte("plain answer")
		for _, encoding := range []string{"", "identity", "unknown"} {
			if got := InspectBody(plain, encoding); !bytes.Equal(got, plain) {
				t.Errorf("InspectBody(%q) = %q", encoding, got)
			}
		}
	})
	t.Run("reads a gzipped, deflated or brotli answer through", func(t *testing.T) {
		plain := []byte("the answer the provider compressed")
		var gzipped bytes.Buffer
		gzipWriter := gzip.NewWriter(&gzipped)
		gzipWriter.Write(plain)
		gzipWriter.Close()
		if got := InspectBody(gzipped.Bytes(), "gzip"); !bytes.Equal(got, plain) {
			t.Errorf("gzip: %q", got)
		}
		var deflated bytes.Buffer
		zlibWriter := zlib.NewWriter(&deflated)
		zlibWriter.Write(plain)
		zlibWriter.Close()
		if got := InspectBody(deflated.Bytes(), "deflate"); !bytes.Equal(got, plain) {
			t.Errorf("deflate: %q", got)
		}
		if got := InspectBody(gzipped.Bytes(), "GZIP "); !bytes.Equal(got, plain) {
			t.Errorf("uppercase encoding: %q", got)
		}
	})
	t.Run("gives the raw bytes back when the encoding fails or outgrows the limit", func(t *testing.T) {
		if got := InspectBody([]byte("not gzip"), "gzip"); string(got) != "not gzip" {
			t.Errorf("broken gzip: %q", got)
		}
		var brotlied bytes.Buffer
		brotliWriter := brotli.NewWriter(&brotlied)
		brotliWriter.Write([]byte(`{"error":{"message":"insufficient balance"}}`))
		brotliWriter.Close()
		if got := InspectBody(brotlied.Bytes(), "br"); string(got) != `{"error":{"message":"insufficient balance"}}` {
			t.Errorf("br: %q", got)
		}
		var truncated bytes.Buffer
		truncating := gzip.NewWriter(&truncated)
		truncating.Write(bytes.Repeat([]byte("y"), 4096))
		truncating.Close()
		cut := truncated.Bytes()[:len(truncated.Bytes())-4]
		if got := InspectBody(cut, "gzip"); !bytes.Equal(got, cut) {
			t.Error("a gzip stream that breaks mid-body must go back raw")
		}
		var gzipped bytes.Buffer
		gzipWriter := gzip.NewWriter(&gzipped)
		gzipWriter.Write(bytes.Repeat([]byte("x"), InspectLimitBytes+1024))
		gzipWriter.Close()
		if got := InspectBody(gzipped.Bytes(), "gzip"); !bytes.Equal(got, gzipped.Bytes()) {
			t.Error("an answer that decompresses past the limit must go back raw")
		}
	})
}

func TestRefusal(t *testing.T) {
	t.Parallel()
	t.Run("may refuse reads every error and nothing else", func(t *testing.T) {
		cases := []struct {
			status int
			want   bool
		}{{200, false}, {302, false}, {399, false}, {400, true}, {401, true}, {500, true}}
		for _, tc := range cases {
			if got := MayRefuse(tc.status); got != tc.want {
				t.Errorf("MayRefuse(%d) = %v", tc.status, got)
			}
		}
	})
	t.Run("tells a refused key from an empty balance from any other error", func(t *testing.T) {
		cases := []struct {
			status int
			body   string
			want   Refusal
			refuse bool
		}{
			{200, `{}`, "", false},
			{404, `{"error":"nope"}`, "", false},
			{429, "not json", "", false},
			{401, "", RefusalKey, true},
			{403, `{"error":"forbidden"}`, RefusalKey, true},
			{402, `{}`, RefusalBalance, true},
			{429, `{"error":{"code":"1113","message":"Insufficient balance or no resource package"}}`, RefusalBalance, true},
		}
		for _, tc := range cases {
			got, ok := RefusalOf(tc.status, []byte(tc.body))
			if ok != tc.refuse || got != tc.want {
				t.Errorf("RefusalOf(%d, %q) = %v, %v", tc.status, tc.body, got, ok)
			}
		}
	})
	provider := RefusalNames{Display: "Acme Models", Slash: "/acme:", BillingURL: "https://billing.example"}
	t.Run("answers a refusal with a 400 that is not retried", func(t *testing.T) {
		answer := RefusalAnswer(provider, RefusalKey, "401")
		if answer.Status != 400 {
			t.Errorf("status = %d", answer.Status)
		}
		wantHeaders := http.Header{"Content-Type": {"application/json"}, "X-Should-Retry": {"false"}}
		if !reflect.DeepEqual(answer.Headers, wantHeaders) {
			t.Errorf("headers = %v", answer.Headers)
		}
		wantBody := `{"type":"error","error":{"type":"invalid_request_error","message":"Acme Models key refused or missing: run /acme:setup (401). Claude models are not affected."}}`
		if answer.Body != wantBody {
			t.Errorf("body = %s", answer.Body)
		}
		answer = RefusalAnswer(provider, RefusalBalance, "429 1113")
		wantBalance := `{"type":"error","error":{"type":"invalid_request_error","message":"Acme Models says this key has no balance or quota left (429 1113): top up at https://billing.example, then retry. Claude models are not affected."}}`
		if answer.Body != wantBalance {
			t.Errorf("body = %s", answer.Body)
		}
	})
	t.Run("answers a stopped budget in the refusal's shape", func(t *testing.T) {
		answer := BudgetAnswer("Radar budget stopped")
		if answer.Status != 400 || answer.Headers.Get("X-Should-Retry") != "false" {
			t.Errorf("answer = %+v", answer)
		}
		if !strings.Contains(answer.Body, "Radar budget stopped") {
			t.Errorf("body = %s", answer.Body)
		}
	})
	t.Run("answers a request on a retired router", func(t *testing.T) {
		answer := RemovedAnswer("Acme Models")
		if answer.Status != 400 {
			t.Errorf("status = %d", answer.Status)
		}
		want := `{"type":"error","error":{"type":"invalid_request_error","message":"Acme Models was removed: restart Claude Code to stop using its router"}}`
		if answer.Body != want {
			t.Errorf("body = %s", answer.Body)
		}
	})
}

func TestReceive(t *testing.T) {
	t.Parallel()
	t.Run("hands an under-limit body to then, answers 413 over it and 400 on a bad path", func(t *testing.T) {
		var got []byte
		port := serve(t, func(w http.ResponseWriter, req *http.Request) {
			res := NewResponse(w)
			Receive(req, res, "acme", 8, func(body []byte) {
				got = body
				res.Write([]byte("then"))
			})
		}, nil)
		answer, err := doRequest(port, requestOptions{body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if answer.body != "then" || string(got) != "{}" {
			t.Errorf("answer = %q, then got %q", answer.body, got)
		}
		tooLarge, err := doRequest(port, requestOptions{body: "123456789012"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if tooLarge.status != 413 {
			t.Errorf("status = %d, want 413", tooLarge.status)
		}
		var error13 struct {
			Type  string `json:"type"`
			Error struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(tooLarge.body), &error13); err != nil {
			t.Fatalf("parse: %v", err)
		}
		if error13.Error.Type != "request_too_large" || error13.Error.Message != "acme router: request body over 64 MiB" {
			t.Errorf("body = %s", tooLarge.body)
		}
		badPath, err := doRequest(port, requestOptions{path: "//evil/x", body: "{}"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if badPath.status != 400 {
			t.Errorf("status = %d, want 400", badPath.status)
		}
		if !strings.Contains(badPath.body, "acme router: bad request path") {
			t.Errorf("body = %s", badPath.body)
		}
	})
}

func TestRefuseHost(t *testing.T) {
	t.Parallel()
	t.Run("lets a request that names one of the ports as 127.0.0.1 or localhost through", func(t *testing.T) {
		for _, host := range []string{"127.0.0.1:18787", "localhost:18788"} {
			request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:1/x", nil)
			request.Host = host
			recorder := httptest.NewRecorder()
			if RefuseHost(request, NewResponse(recorder), "zai", []int{18787, 18788}) {
				t.Errorf("Host %q must pass", host)
			}
			if recorder.Body.Len() != 0 {
				t.Errorf("Host %q was answered", host)
			}
		}
	})
	t.Run("answers 421 for any other Host", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:1/x", nil)
		request.Host = "evil.example:1"
		recorder := httptest.NewRecorder()
		if !RefuseHost(request, NewResponse(recorder), "zai", []int{18787}) {
			t.Fatal("the request must be refused")
		}
		if recorder.Code != 421 {
			t.Errorf("code = %d, want 421", recorder.Code)
		}
		if want := `{"type":"error","error":{"type":"invalid_request_error","message":"zai router: wrong Host"}}`; recorder.Body.String() != want {
			t.Errorf("body = %s, want %s", recorder.Body.String(), want)
		}
	})
}

func TestWatchClient(t *testing.T) {
	t.Parallel()
	t.Run("turns true once the client has left, a close before the call included", func(t *testing.T) {
		sawGone := make(chan bool, 1)
		port := serve(t, func(w http.ResponseWriter, req *http.Request) {
			io.Copy(io.Discard, req.Body)
			gone := WatchClient(req)
			until(gone)
			select {
			case sawGone <- gone():
			default:
			}
		}, nil)
		ctx, cancel := context.WithCancel(context.Background())
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/x", port), strings.NewReader("{}"))
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
		done := make(chan error, 1)
		go func() {
			response, err := client.Do(request)
			if err == nil {
				io.Copy(io.Discard, response.Body)
				response.Body.Close()
			}
			done <- err
		}()
		time.Sleep(50 * time.Millisecond)
		cancel()
		select {
		case gone := <-sawGone:
			if !gone {
				t.Error("gone() must be true after the client left")
			}
		case <-time.After(2 * time.Second):
			t.Fatal("the client's close was never seen")
		}
		<-done
	})
}

func TestHarden(t *testing.T) {
	t.Parallel()
	server := Harden(&http.Server{})
	if server.IdleTimeout != 120*time.Second {
		t.Errorf("IdleTimeout = %v", server.IdleTimeout)
	}
	if server.ReadHeaderTimeout != 125*time.Second {
		t.Errorf("ReadHeaderTimeout = %v", server.ReadHeaderTimeout)
	}
	if server.ReadTimeout != 0 || server.WriteTimeout != 0 {
		t.Error("no total timeouts may be set")
	}
}

func TestResponseGuards(t *testing.T) {
	t.Parallel()
	t.Run("sends the head once", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		res := NewResponse(recorder)
		res.WriteHeader(200)
		res.WriteHeader(500)
		if recorder.Code != 200 {
			t.Errorf("code = %d, want 200", recorder.Code)
		}
	})
	t.Run("destroying an ended answer does nothing", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		res := NewResponse(recorder)
		res.WriteHeader(200)
		res.End([]byte("done"))
		res.Destroy()
		if res.Destroyed() {
			t.Error("an ended answer is not destroyed")
		}
		if recorder.Body.String() != "done" {
			t.Errorf("body = %q", recorder.Body.String())
		}
	})
}

func TestTrackConnectionsDefaults(t *testing.T) {
	t.Parallel()
	// A nil closed callback is allowed; sockets still track and report nothing.
	tracker := TrackConnections(nil)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Write([]byte("ok"))
	})}
	tracker.Watch(server)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	answer, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", listener.Addr().(*net.TCPAddr).Port))
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	io.Copy(io.Discard, answer.Body)
	answer.Body.Close()
	if !until(func() bool { return tracker.Size() >= 1 }) {
		t.Fatal("the socket must be tracked")
	}
}

// abandonBody sends a request whose body is cut short, then closes the connection.
func abandonBody(t *testing.T, port int) {
	t.Helper()
	socket, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if _, err := socket.Write([]byte("POST /x HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 10\r\n\r\nshort")); err != nil {
		t.Fatalf("write: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	socket.Close()
}

func TestBodyErrors(t *testing.T) {
	t.Parallel()
	t.Run("a body that errors mid-stream is reported, never forwarded", func(t *testing.T) {
		var readErr atomic.Value
		port := serve(t, func(w http.ResponseWriter, req *http.Request) {
			_, err := ReadBody(req, 100)
			readErr.Store(err)
		}, nil)
		abandonBody(t, port)
		if !until(func() bool { return readErr.Load() != nil }) {
			t.Fatal("the cut body must be reported")
		}
		err, _ := readErr.Load().(error)
		if err == nil || errors.Is(err, ErrBodyTooLarge) {
			t.Errorf("ReadBody: %v, want a stream error", err)
		}
	})
	t.Run("Receive destroys the response of a request whose body errors", func(t *testing.T) {
		var ran atomic.Bool
		port := serve(t, func(w http.ResponseWriter, req *http.Request) {
			Receive(req, NewResponse(w), "acme", 100, func([]byte) {
				ran.Store(true)
			})
		}, nil)
		abandonBody(t, port)
		time.Sleep(100 * time.Millisecond)
		if ran.Load() {
			t.Error("then must not run for a request whose body errors")
		}
	})
}

func TestTunnelDialer(t *testing.T) {
	t.Parallel()
	t.Run("returns the tunnelled connection, early bytes first", func(t *testing.T) {
		var connectLine atomic.Value
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		t.Cleanup(func() { listener.Close() })
		go func() {
			for {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				go func(conn net.Conn) {
					defer conn.Close()
					head := make([]byte, 0, 512)
					buffer := make([]byte, 256)
					for !bytes.HasSuffix(head, []byte("\r\n\r\n")) {
						n, err := conn.Read(buffer)
						if err != nil {
							return
						}
						head = append(head, buffer[:n]...)
					}
					connectLine.Store(string(head))
					if _, err := conn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\nEARLY")); err != nil {
						return
					}
					io.Copy(conn, conn)
				}(conn)
			}
		}()
		dial := tunnel(mustURL(t, fmt.Sprintf("http://user:pw@127.0.0.1:%d", listener.Addr().(*net.TCPAddr).Port)))
		conn, err := dial(context.Background(), "tcp", "127.0.0.1:1")
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer conn.Close()
		early := make([]byte, 5)
		if _, err := io.ReadFull(conn, early); err != nil || string(early) != "EARLY" {
			t.Fatalf("early bytes: %q %v", early, err)
		}
		if _, err := conn.Write([]byte("ping")); err != nil {
			t.Fatalf("write: %v", err)
		}
		echo := make([]byte, 4)
		if _, err := io.ReadFull(conn, echo); err != nil || string(echo) != "ping" {
			t.Fatalf("echo: %q %v", echo, err)
		}
		line, _ := connectLine.Load().(string)
		want := "CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n" +
			"Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("user:pw")) + "\r\n\r\n"
		if line != want {
			t.Errorf("CONNECT = %q, want %q", line, want)
		}
		// An IPv6 authority is bracketed back to itself, and an addr that does not split goes out
		// as it came.
		for _, addr := range []string{"[::1]:80", "::1:80"} {
			conn, err := dial(context.Background(), "tcp", addr)
			if err != nil {
				t.Fatalf("dial(%q): %v", addr, err)
			}
			conn.Close()
			line, _ := connectLine.Load().(string)
			if !strings.HasPrefix(line, "CONNECT "+addr+" ") {
				t.Errorf("CONNECT = %q, want authority %q", line, addr)
			}
		}
	})
	t.Run("dials a portless proxy on port 80", func(t *testing.T) {
		if got := proxyAddress(mustURL(t, "http://proxy.internal")); got != "proxy.internal:80" {
			t.Errorf("proxyAddress = %q", got)
		}
		if got := proxyAddress(mustURL(t, "http://proxy.internal:3128")); got != "proxy.internal:3128" {
			t.Errorf("proxyAddress = %q", got)
		}
	})
	t.Run("reports a proxy that goes away before answering", func(t *testing.T) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		t.Cleanup(func() { listener.Close() })
		go func() {
			for {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				conn.Close()
			}
		}()
		dial := tunnel(mustURL(t, fmt.Sprintf("http://127.0.0.1:%d", listener.Addr().(*net.TCPAddr).Port)))
		if conn, err := dial(context.Background(), "tcp", "127.0.0.1:1"); err == nil {
			conn.Close()
			t.Error("a proxy that hangs up must fail the dial")
		}
	})
	t.Run("reports a proxy that cannot be dialled", func(t *testing.T) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		port := listener.Addr().(*net.TCPAddr).Port
		listener.Close()
		dial := tunnel(mustURL(t, fmt.Sprintf("http://127.0.0.1:%d", port)))
		if conn, err := dial(context.Background(), "tcp", "127.0.0.1:1"); err == nil {
			conn.Close()
			t.Error("an unreachable proxy must fail the dial")
		}
	})
}

func TestFailureCode(t *testing.T) {
	t.Parallel()
	cases := []struct {
		err  error
		want string
	}{
		{fmt.Errorf("write tcp: %w", os.ErrDeadlineExceeded), "ETIMEDOUT"},
		{fmt.Errorf("read tcp: %w", syscall.ECONNRESET), "ECONNRESET"},
		{fmt.Errorf("await: %w", context.DeadlineExceeded), "ETIMEDOUT"},
		{fmt.Errorf("aborted: %w", context.Canceled), "ECONNRESET"},
		{fmt.Errorf("write tcp: %w", syscall.EPIPE), "EPIPE"},
		{fmt.Errorf("dial tcp: %w", syscall.ECONNREFUSED), "ECONNREFUSED"},
		{fmt.Errorf("proxy CONNECT x answered 403"), "EUPSTREAM"},
	}
	for _, tc := range cases {
		if got := failureCode(tc.err); got != tc.want {
			t.Errorf("failureCode(%v) = %q, want %q", tc.err, got, tc.want)
		}
	}
}

func TestStaleSocket(t *testing.T) {
	t.Parallel()
	cases := []struct {
		code string
		err  error
		want bool
	}{
		{"ECONNRESET", fmt.Errorf("read tcp: %w", syscall.ECONNRESET), true},
		{"EPIPE", fmt.Errorf("write tcp: %w", syscall.EPIPE), true},
		{"EUPSTREAM", io.EOF, true},
		// The transport's own name for a read that found the socket closed on a reused connection.
		{"EUPSTREAM", fmt.Errorf("net/http: Transport failed to read from server: %w", io.EOF), true},
		{"EUPSTREAM", errors.New("http: server closed idle connection"), true},
		{"ETIMEDOUT", fmt.Errorf("read tcp: %w", os.ErrDeadlineExceeded), false},
		{"ECONNREFUSED", fmt.Errorf("dial tcp: %w", syscall.ECONNREFUSED), false},
		{"EUPSTREAM", errors.New("malformed HTTP response"), false},
	}
	for _, tc := range cases {
		if got := staleSocket(tc.code, tc.err); got != tc.want {
			t.Errorf("staleSocket(%q, %v) = %v, want %v", tc.code, tc.err, got, tc.want)
		}
	}
}

func TestEndFailed(t *testing.T) {
	t.Parallel()
	t.Run("marks a response whose head never went out destroyed", func(t *testing.T) {
		res := NewResponse(httptest.NewRecorder())
		endFailed(res, "", true, "boom")
		if !res.Destroyed() {
			t.Error("the response must be marked destroyed")
		}
	})
	t.Run("leaves an ended response alone", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		res := NewResponse(recorder)
		res.WriteHeader(200)
		res.End([]byte("done"))
		endFailed(res, "text/event-stream", false, "boom")
		if res.Destroyed() {
			t.Error("an ended response is not destroyed")
		}
		if recorder.Body.String() != "done" {
			t.Errorf("body = %q", recorder.Body.String())
		}
	})
}

func TestDialerDefaults(t *testing.T) {
	t.Parallel()
	if got := idleBudget(context.Background()); got != idleTimeout {
		t.Errorf("idleBudget() = %v, want %v", got, idleTimeout)
	}
	plain := context.Background()
	if abortSignal(plain) != plain {
		t.Error("a dial context without an abort signal is its own signal")
	}
}
func TestTunnelWriteTimeout(t *testing.T) {
	t.Parallel()
	t.Run("gives up writing a CONNECT a proxy never takes in", func(t *testing.T) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		t.Cleanup(func() { listener.Close() })
		var held []net.Conn
		var mu sync.Mutex
		go func() {
			for {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				// A proxy that holds the connection but never reads a byte of the CONNECT.
				mu.Lock()
				held = append(held, conn)
				mu.Unlock()
			}
		}()
		t.Cleanup(func() {
			mu.Lock()
			defer mu.Unlock()
			for _, conn := range held {
				conn.Close()
			}
		})
		// The CONNECT is larger than any socket buffer, so the write cannot finish; the idle
		// budget ends it.
		credentials := strings.Repeat("u", 16<<20)
		dial := tunnel(mustURL(t, fmt.Sprintf("http://%s:@127.0.0.1:%d", credentials, listener.Addr().(*net.TCPAddr).Port)))
		started := time.Now()
		conn, err := dial(withIdleBudget(context.Background(), 200*time.Millisecond), "tcp", "127.0.0.1:1")
		if err == nil {
			conn.Close()
			t.Fatal("a CONNECT the proxy never takes in must fail")
		}
		if elapsed := time.Since(started); elapsed < 150*time.Millisecond {
			t.Errorf("gave up after %v, want the idle budget", elapsed)
		}
		if code := failureCode(err); code != "ETIMEDOUT" {
			t.Errorf("failureCode = %q, want ETIMEDOUT", code)
		}
	})
}

func TestSortStrings(t *testing.T) {
	t.Parallel()
	values := []string{"corp", "No_Proxy", "NO_proxY", "127.0.0.1"}
	sortStrings(values)
	want := []string{"127.0.0.1", "NO_proxY", "No_Proxy", "corp"}
	if !reflect.DeepEqual(values, want) {
		t.Errorf("sortStrings = %v, want %v", values, want)
	}
}
