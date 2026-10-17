// A refused key or an empty balance on a provider route reaches Claude Code as a non-retryable
// 400 that says what to run or where to top up, never as the 401 it would read as its own login
// failing or the 429 it would retry for minutes. Anthropic's and a peer's answers are never
// touched. The refusals' cases, inputs and expected outputs come from refusal.go and
// router.go.
package router

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

func TestRefusalOfBalanceAnswers(t *testing.T) {
	t.Parallel()
	// Each provider's documented out-of-balance answer.
	cases := []struct {
		name   string
		status int
		body   string
	}{
		{"Z.ai 1113", 429, `{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}`},
		{"Z.ai 1113 as a number", 429, `{"error":{"code":1113,"message":"x"}}`},
		{"Z.ai 1316", 429, `{"error":{"code":"1316","message":"Usage limit reached for the past 5 hours."}}`},
		{"Z.ai 1317", 429, `{"error":{"code":"1317","message":"Usage limit reached for the past 7 days."}}`},
		{"Moonshot exceeded_current_quota_error", 429, `{"error":{"type":"exceeded_current_quota_error","message":"Your account is suspended, please check billing"}}`},
		{"DeepSeek 402", 402, `{"error":{"message":"Insufficient Balance","type":"unknown_error"}}`},
		{"MiniMax 1008", 500, `{"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}`},
		{"DashScope Arrearage", 400, `{"error":{"code":"Arrearage","message":"Access denied, please make sure your account is in good standing."}}`},
		{"DashScope isv.OUT_OF_SERVICE", 400, `{"code":"isv.OUT_OF_SERVICE","message":"service paused"}`},
		{"the wording alone", 403, `{"error":{"message":"insufficient balance"}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name+" is out of balance", func(t *testing.T) {
			refusal, ok := RefusalOf(tc.status, []byte(tc.body))
			if !ok || refusal != RefusalBalance {
				t.Errorf("RefusalOf(%d, %s) = %v, %v", tc.status, tc.body, refusal, ok)
			}
		})
	}
}

func TestRefusalOfKeys(t *testing.T) {
	t.Parallel()
	t.Run("reads a 401 or 403 as a refused key, and every other answer as not a refusal", func(t *testing.T) {
		if refusal, ok := RefusalOf(401, []byte(`{"error":{"code":"1000","message":"Authentication Failed"}}`)); !ok || refusal != RefusalKey {
			t.Errorf("401 = %v, %v", refusal, ok)
		}
		if refusal, ok := RefusalOf(403, []byte("forbidden")); !ok || refusal != RefusalKey {
			t.Errorf("403 = %v, %v", refusal, ok)
		}
		if refusal, ok := RefusalOf(402, []byte("not json")); !ok || refusal != RefusalBalance {
			t.Errorf("402 = %v, %v", refusal, ok)
		}
		// A plain rate limit (Z.ai 1302, Moonshot rate_limit_reached_error) stays a retryable 429.
		if _, ok := RefusalOf(429, []byte(`{"error":{"code":"1302","message":"rate limit"}}`)); ok {
			t.Error("Z.ai 1302 must not be a refusal")
		}
		if _, ok := RefusalOf(429, []byte(`{"error":{"type":"rate_limit_reached_error","message":"slow down"}}`)); ok {
			t.Error("rate_limit_reached_error must not be a refusal")
		}
		if _, ok := RefusalOf(400, []byte(`{"error":{"type":"invalid_request_error","message":"bad"}}`)); ok {
			t.Error("an invalid request must not be a refusal")
		}
		if _, ok := RefusalOf(500, []byte("<html>")); ok {
			t.Error("a 500 must not be a refusal")
		}
		if _, ok := RefusalOf(500, []byte("[1113]")); ok {
			t.Error("a bare array must not be a refusal")
		}
		if _, ok := RefusalOf(200, []byte(`{"error":{"code":"1113"}}`)); ok {
			t.Error("a success must not be a refusal")
		}
	})
}

// answeringState is one fake upstream's mutable answer, swapped between requests.
type answeringState struct {
	mu       sync.Mutex
	status   int
	body     string
	typ      string
	encoding string
	// cutoff: the answer's head and a first chunk go out, then the socket dies before the body
	// ends.
	cutoff   bool
	requests int
}

func (s *answeringState) set(status int, body string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status = status
	s.body = body
}

func (s *answeringState) snapshot() (int, string, string, string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status, s.body, s.typ, s.encoding, s.cutoff
}

func (s *answeringState) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requests
}

// answeringUpstream is an upstream that answers every request with the status and body it is set
// to, gzipping when an encoding is set.
func answeringUpstream(t *testing.T) (*answeringState, *url.URL) {
	t.Helper()
	state := &answeringState{status: 200, body: `{"ok":true}`, typ: "application/json"}
	port := serve(t, func(w http.ResponseWriter, req *http.Request) {
		_, _ = io.Copy(io.Discard, req.Body)
		state.mu.Lock()
		state.requests++
		status, body, typ, encoding, cutoff := state.status, state.body, state.typ, state.encoding, state.cutoff
		state.mu.Unlock()
		if cutoff {
			// The answer's headers and a first chunk go out, then the socket dies before the body
			// ends.
			conn, _, err := http.NewResponseController(w).Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			_, _ = conn.Write([]byte("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"error\":"))
			time.Sleep(20 * time.Millisecond)
			_ = conn.Close()
			return
		}
		res := NewResponse(w)
		res.Header().Set("Content-Type", typ)
		payload := []byte(body)
		if encoding != "" {
			res.Header().Set("Content-Encoding", encoding)
			var compressed bytes.Buffer
			writer := gzip.NewWriter(&compressed)
			_, _ = writer.Write(payload)
			_ = writer.Close()
			payload = compressed.Bytes()
		}
		res.WriteHeader(status)
		res.End(payload)
	}, nil)
	return state, mustURL(t, fmt.Sprintf("http://127.0.0.1:%d", port))
}

// refusalRig builds a router over three answering upstreams, keyed "the-key", with the kimi peer
// configured.
type refusalRig struct {
	provider  *answeringState
	anthropic *answeringState
	peer      *answeringState
	logs      *lineLog
	events    *eventLog
	port      int
}

func newRefusalRig(t *testing.T) *refusalRig {
	t.Helper()
	provider, providerURL := answeringUpstream(t)
	anthropic, anthropicURL := answeringUpstream(t)
	peer, peerURL := answeringUpstream(t)
	logs := &lineLog{}
	events := &eventLog{}
	port := reservePort(t)
	server := CreateRouter(RouterOptions{
		Provider:    routerProvider,
		Port:        port,
		Anthropic:   anthropicURL,
		ProviderURL: providerURL,
		Key:         func(context.Context) (string, error) { return "the-key", nil },
		Log:         logs.add,
		Peers: func(model string) (PeerTarget, bool) {
			if strings.HasPrefix(model, "kimi-") {
				port, _ := strconv.ParseInt(peerURL.Port(), 10, 64)
				return PeerTarget{Name: "kimi", Port: port}, true
			}
			return PeerTarget{}, false
		},
		Events: events.record,
	})
	serveRouter(t, server, port)
	return &refusalRig{provider: provider, anthropic: anthropic, peer: peer, logs: logs, events: events, port: port}
}

// post is the rig's POST helper: status, the x-should-retry header and the whole body.
func (r *refusalRig) post(t *testing.T, model string) (int, string, string) {
	t.Helper()
	got, err := postAnswer(r.port, model, nil)
	if err != nil {
		t.Fatal(err)
	}
	return got.status, got.header.Get("X-Should-Retry"), got.body
}

// refusalMessage reads an error body's message.
func refusalBodyMessage(t *testing.T, body string) string {
	t.Helper()
	var parsed struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("parse %q: %v", body, err)
	}
	return parsed.Error.Message
}

// refusalRaw reads a provider-bound POST raw: a client that decompresses nothing would hide the
// answer's own bytes.
func refusalRaw(t *testing.T, port int, model string) (int, string, []byte) {
	t.Helper()
	body, err := json.Marshal(map[string]any{"model": model, "messages": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/v1/messages", port), strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{
		Timeout:   30 * time.Second,
		Transport: &http.Transport{DisableKeepAlives: true, DisableCompression: true},
	}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	text, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, response.Header.Get("Content-Encoding"), text
}

// gzipped is body gzip-compressed once, for byte-for-byte comparisons.
func gzipped(t *testing.T, body string) []byte {
	t.Helper()
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return compressed.Bytes()
}

func TestRouterOnAProviderRoute(t *testing.T) {
	t.Parallel()
	t.Run("answers the provider's 401 and 403 with a non-retryable 400 that names setup, never the upstream's text", func(t *testing.T) {
		r := newRefusalRig(t)
		for _, status := range []int{401, 403} {
			r.provider.set(status, `{"error":{"code":"1000","message":"bad key the-key"}}`)
			code, retry, body := r.post(t, "glm-5.3")
			if code != 400 {
				t.Fatalf("status = %d, want 400", code)
			}
			if retry != "false" {
				t.Errorf("x-should-retry = %q", retry)
			}
			if strings.Contains(body, "the-key") {
				t.Errorf("the body quotes the key: %s", body)
			}
			want := `{"type":"error","error":{"type":"invalid_request_error","message":"Z.ai GLM key refused or missing: ` +
				`run /zai:setup (Z.ai GLM answered HTTP ` + fmt.Sprintf("%d", status) + `). Claude models are not affected."}}`
			if body != want {
				t.Errorf("body = %s", body)
			}
		}
		if !containsLine(r.logs.list(), "→ provider 401 answered 400 (key refused)") {
			t.Errorf("logs = %v", r.logs.list())
		}
	})

	t.Run("answers an out-of-balance 429 at once with a non-retryable 400 naming the top-up page", func(t *testing.T) {
		r := newRefusalRig(t)
		r.provider.set(429, `{"error":{"code":"1113","message":"Insufficient balance"}}`)
		code, retry, body := r.post(t, "glm-5.3-flash")
		if code != 400 {
			t.Fatalf("status = %d, want 400", code)
		}
		if retry != "false" {
			t.Errorf("x-should-retry = %q", retry)
		}
		want := "Z.ai GLM says this key has no balance or quota left (Z.ai GLM answered HTTP 429): " +
			"top up at https://z.ai/manage-apikey/billing, then retry. Claude models are not affected."
		if got := refusalBodyMessage(t, body); got != want {
			t.Errorf("message = %q", got)
		}
	})

	t.Run("passes every other provider error through as it came: a plain rate limit stays a retryable 429", func(t *testing.T) {
		r := newRefusalRig(t)
		r.provider.set(429, `{"error":{"code":"1302","message":"rate limit"}}`)
		code, retry, body := r.post(t, "glm-5.3")
		if code != 429 || retry != "" || body != `{"error":{"code":"1302","message":"rate limit"}}` {
			t.Errorf("answer = %d %q %q", code, retry, body)
		}
		r.provider.set(500, "upstream broke")
		code, retry, body = r.post(t, "glm-5.3")
		if code != 500 || retry != "" || body != "upstream broke" {
			t.Errorf("answer = %d %q %q", code, retry, body)
		}
	})

	t.Run("blanks the key out of any other provider error that quotes it, status and type kept", func(t *testing.T) {
		r := newRefusalRig(t)
		r.provider.mu.Lock()
		r.provider.status = 500
		r.provider.typ = "text/plain"
		r.provider.body = "bearer the-key is not valid here; the-key again"
		r.provider.mu.Unlock()
		code, retry, body := r.post(t, "glm-5.3")
		if code != 500 || retry != "" || body != "bearer [key redacted] is not valid here; [key redacted] again" {
			t.Errorf("answer = %d %q %q", code, retry, body)
		}
		if !containsLine(r.logs.list(), "→ provider 500 answered 500 (key redacted)") {
			t.Errorf("logs = %v", r.logs.list())
		}
	})

	t.Run("answers a held-back error the provider cuts off midway with a 502, never a half-sent body", func(t *testing.T) {
		r := newRefusalRig(t)
		r.provider.mu.Lock()
		r.provider.status = 401
		r.provider.body = "cut"
		r.provider.cutoff = true
		r.provider.mu.Unlock()
		code, _, body := r.post(t, "glm-5.3")
		if code != 502 {
			t.Fatalf("status = %d, want 502", code)
		}
		if message := refusalBodyMessage(t, body); !strings.Contains(message, "provider unreachable") {
			t.Errorf("message = %q", message)
		}
	})

	t.Run("sends an error body over the inspection limit through unchanged, even a 401", func(t *testing.T) {
		r := newRefusalRig(t)
		r.provider.set(401, strings.Repeat("x", InspectLimitBytes*2))
		code, _, body := r.post(t, "glm-5.3")
		if code != 401 {
			t.Fatalf("status = %d, want 401", code)
		}
		if body != strings.Repeat("x", InspectLimitBytes*2) {
			t.Errorf("body length = %d", len(body))
		}
	})
}

// containsLine reports whether one log line contains the text.
func containsLine(lines []string, text string) bool {
	for _, line := range lines {
		if strings.Contains(line, text) {
			return true
		}
	}
	return false
}

func TestCompressedProviderAnswer(t *testing.T) {
	t.Parallel()
	t.Run("reads a gzipped out-of-balance 429 the same as a plain one", func(t *testing.T) {
		r := newRefusalRig(t)
		r.provider.mu.Lock()
		r.provider.status = 429
		r.provider.encoding = "gzip"
		r.provider.body = `{"error":{"code":"1113","message":"Insufficient balance"}}`
		r.provider.mu.Unlock()
		code, retry, body := r.post(t, "glm-5.3-flash")
		if code != 400 {
			t.Fatalf("status = %d, want 400", code)
		}
		if retry != "false" {
			t.Errorf("x-should-retry = %q", retry)
		}
		want := "Z.ai GLM says this key has no balance or quota left (Z.ai GLM answered HTTP 429): " +
			"top up at https://z.ai/manage-apikey/billing, then retry. Claude models are not affected."
		if got := refusalBodyMessage(t, body); got != want {
			t.Errorf("message = %q", got)
		}
		if !containsLine(r.logs.list(), "→ provider 429 answered 400 (out of balance)") {
			t.Errorf("logs = %v", r.logs.list())
		}
	})

	t.Run("blanks the key out of a gzipped error that quotes it, and answers plain bytes", func(t *testing.T) {
		r := newRefusalRig(t)
		r.provider.mu.Lock()
		r.provider.status = 500
		r.provider.typ = "text/plain"
		r.provider.encoding = "gzip"
		r.provider.body = "bearer the-key is not valid here"
		r.provider.mu.Unlock()
		code, encoding, body := refusalRaw(t, r.port, "glm-5.3")
		if code != 500 {
			t.Fatalf("status = %d", code)
		}
		// The replacement is the router's own plain body, so it no longer claims the provider's
		// encoding.
		if encoding != "" {
			t.Errorf("encoding = %q", encoding)
		}
		if string(body) != "bearer [key redacted] is not valid here" {
			t.Errorf("body = %q", body)
		}
		if !containsLine(r.logs.list(), "→ provider 500 answered 500 (key redacted)") {
			t.Errorf("logs = %v", r.logs.list())
		}
	})

	t.Run("reads a gzipped error's reason for its route event and log line", func(t *testing.T) {
		r := newRefusalRig(t)
		r.provider.mu.Lock()
		r.provider.status = 400
		r.provider.encoding = "gzip"
		r.provider.body = `{"error":{"code":"1210","message":"API key not valid"}}`
		r.provider.mu.Unlock()
		code, encoding, body := refusalRaw(t, r.port, "glm-5.3")
		// Not a refusal, and the key is not quoted: the gzip bytes go through exactly as they came.
		if code != 400 || encoding != "gzip" {
			t.Fatalf("answer = %d %q", code, encoding)
		}
		if !bytes.Equal(body, gzipped(t, `{"error":{"code":"1210","message":"API key not valid"}}`)) {
			t.Errorf("body = %d bytes", len(body))
		}
		waitForEvents(t, r.events, 1)
		if !containsLine(r.logs.list(), "→ provider 400 (1210: API key not valid)") {
			t.Errorf("logs = %v", r.logs.list())
		}
		route := r.events.routes()[0]
		if route.Event != domain.EventRoute || route.Status != 400 {
			t.Errorf("event = %+v", route)
		}
		if route.Error == nil || *route.Error != "1210: API key not valid" {
			t.Errorf("error = %v", route.Error)
		}
	})

	t.Run("passes a gzipped answer that is neither a refusal nor key-quoting through byte for byte", func(t *testing.T) {
		r := newRefusalRig(t)
		r.provider.mu.Lock()
		r.provider.status = 429
		r.provider.encoding = "gzip"
		r.provider.body = `{"error":{"code":"1302","message":"rate limit"}}`
		r.provider.mu.Unlock()
		code, encoding, body := refusalRaw(t, r.port, "glm-5.3")
		if code != 429 || encoding != "gzip" {
			t.Fatalf("answer = %d %q", code, encoding)
		}
		if !bytes.Equal(body, gzipped(t, `{"error":{"code":"1302","message":"rate limit"}}`)) {
			t.Errorf("body = %d bytes", len(body))
		}
	})
}

func TestRouterOnClaudeAndPeerRoutes(t *testing.T) {
	t.Parallel()
	t.Run("never alters Anthropic's or a peer's answers, a 401 or an out-of-balance 429 included", func(t *testing.T) {
		r := newRefusalRig(t)
		answers := []struct {
			status int
			body   string
		}{
			{401, `{"type":"error","error":{"type":"authentication_error","message":"OAuth token expired"}}`},
			{429, `{"error":{"code":"1113","message":"Insufficient balance"}}`},
			{402, `{"error":{"message":"Insufficient Balance"}}`},
		}
		for _, upstream := range []*answeringState{r.anthropic, r.peer} {
			for _, want := range answers {
				upstream.set(want.status, want.body)
				model := "claude-sonnet-5-5"
				if upstream == r.peer {
					model = "kimi-k3"
				}
				code, retry, body := r.post(t, model)
				if code != want.status || retry != "" || body != want.body {
					t.Errorf("answer = %d %q %q, want %d %q", code, retry, body, want.status, want.body)
				}
			}
		}
	})
}
