// The router's cases, inputs and expected outputs. The helpers: a recording upstream that
// streams two events, a router rigged on a reserved port, and the raw-socket client that sees
// the answer's own bytes.
package router

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// routerProvider is the reference provider: zai's names, as the shared suites assert them.
var routerProvider = domain.DefineProvider(domain.ProviderSpec{
	Name:         "zai",
	Display:      "Z.ai GLM",
	Slash:        "/zai:",
	AgentPrefix:  "zai:",
	BranchPrefix: "zai/",
	Harness:      "zai",
	ArtifactsEnv: "ZAI_ARTIFACTS",
	EnvPrefix:    "ZAI",
	Catalog: map[domain.ModelTier]domain.ModelRef{
		domain.ModelTierMain: {
			Tier:            domain.ModelTierMain,
			ID:              "glm-5.3",
			Label:           "GLM 5.3",
			MaxOutputTokens: i64PtrLocal(131072),
		},
		domain.ModelTierFlash: {
			Tier:            domain.ModelTierFlash,
			ID:              "glm-5.3-flash",
			Label:           "GLM 5.3 Flash",
			MaxOutputTokens: i64PtrLocal(131072),
		},
	},
	TierNames:  map[domain.ModelTier]string{domain.ModelTierMain: "glm", domain.ModelTierFlash: "flash"},
	PingTier:   domain.ModelTierFlash,
	BaseURL:    "https://api.z.ai/api/anthropic",
	Auth:       domain.AuthBearer,
	KeyEnv:     []string{"ZAI_API_KEY"},
	BillingURL: "https://z.ai/manage-apikey/billing",
	// Z.ai's probe: the web_search server tool answers 500 on glm-5.3-flash and works on glm-5.3.
	WebSearchModel: strPtrLocal("glm-5.3"),
	Router: domain.ProviderRouter{
		Port:          18787,
		Label:         "dev.muhmdraouf.zai-router",
		HealthPath:    "/zai-router/health",
		ModelPrefixes: []string{"glm-"},
	},
})

func strPtrLocal(text string) *string { return &text }

func i64PtrLocal(value int64) *int64 { return &value }

// seenRequest is one request a fake upstream saw.
type seenRequest struct {
	path    string
	headers http.Header
	body    string
}

// seenList records requests concurrently.
type seenList struct {
	mu    sync.Mutex
	items []seenRequest
}

func (s *seenList) record(path string, headers http.Header, body string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items = append(s.items, seenRequest{path: path, headers: headers, body: body})
}

func (s *seenList) list() []seenRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]seenRequest(nil), s.items...)
}

func (s *seenList) len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.items)
}

// lineLog records log lines concurrently.
type lineLog struct {
	mu    sync.Mutex
	lines []string
}

func (l *lineLog) add(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, line)
}

func (l *lineLog) list() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.lines...)
}

func (l *lineLog) joined() string {
	return strings.Join(l.list(), "\n")
}

// eventLog records spool events concurrently; the shared collector of all four test files.
type eventLog struct {
	mu     sync.Mutex
	events []domain.SpoolEvent
}

func (l *eventLog) record(event domain.SpoolEvent) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, event)
}

func (l *eventLog) all() []domain.SpoolEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]domain.SpoolEvent(nil), l.events...)
}

func (l *eventLog) routes() []domain.RouteEvent {
	var routes []domain.RouteEvent
	for _, event := range l.all() {
		if route, ok := event.(domain.RouteEvent); ok {
			routes = append(routes, route)
		}
	}
	return routes
}

func (l *eventLog) captures() []domain.CaptureEvent {
	var captures []domain.CaptureEvent
	for _, event := range l.all() {
		if capture, ok := event.(domain.CaptureEvent); ok {
			captures = append(captures, capture)
		}
	}
	return captures
}

func (l *eventLog) healths() []domain.RouterHealthEvent {
	var healths []domain.RouterHealthEvent
	for _, event := range l.all() {
		if health, ok := event.(domain.RouterHealthEvent); ok {
			healths = append(healths, health)
		}
	}
	return healths
}

// answer is one client answer: status, headers and whole body.
type answer struct {
	status int
	header http.Header
	body   string
}

// postAnswer sends one POST: JSON to /v1/messages?beta=true, the caller's OAuth bearer and any
// extra headers.
func postAnswer(port int, model string, extra map[string]string) (answer, error) {
	body, err := json.Marshal(map[string]any{"model": model, "messages": []any{}})
	if err != nil {
		return answer{}, err
	}
	headers := map[string]string{"Content-Type": "application/json", "Authorization": "Bearer anthropic-oauth"}
	for name, value := range extra {
		headers[name] = value
	}
	return postRawBody(port, "/v1/messages?beta=true", string(body), headers)
}

// postRawBody posts one exact body with one header set on a connection of its own.
func postRawBody(port int, path, body string, headers map[string]string) (answer, error) {
	return doBody(http.MethodPost, port, path, body, headers)
}

// getBody reads one path with GET, as the health checks do.
func getBody(port int, path string) (answer, error) {
	return doBody(http.MethodGet, port, path, "", nil)
}

func doBody(method string, port int, path, body string, headers map[string]string) (answer, error) {
	request, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), strings.NewReader(body))
	if err != nil {
		return answer{}, err
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return answer{}, err
	}
	defer response.Body.Close()
	text, err := io.ReadAll(response.Body)
	if err != nil {
		return answer{}, err
	}
	return answer{status: response.StatusCode, header: response.Header, body: string(text)}, nil
}

// reservePort takes a loopback port nothing else will take while the test runs, then leaves it
// free.
func reservePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

// serveRouter listens the router server on its port and closes it with the test.
func serveRouter(t *testing.T, server *http.Server, port int) {
	t.Helper()
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
}

// recordingUpstream is a fake upstream that records what it got and answers with its name,
// streamed in two chunks 20 ms apart.
func recordingUpstream(t *testing.T, name, prefix string, seen *seenList) *url.URL {
	t.Helper()
	port := serve(t, func(w http.ResponseWriter, req *http.Request) {
		body, err := ReadBody(req, BodyLimitBytes)
		if err != nil {
			return
		}
		res := NewResponse(w)
		seen.record(pathOf(req), req.Header, string(body))
		res.Header().Set("Content-Type", "text/event-stream")
		res.WriteHeader(200)
		res.Write([]byte("data: " + name + "-1\n\n"))
		time.Sleep(20 * time.Millisecond)
		res.End([]byte("data: " + name + "-2\n\n"))
	}, nil)
	return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, prefix))
}

// pathOf is the request's path with its query.
func pathOf(req *http.Request) string {
	if req.URL.RawQuery != "" {
		return req.URL.Path + "?" + req.URL.RawQuery
	}
	return req.URL.Path
}

// rigOptions is everything a test changes about the rig, plus the pieces its inline variants
// replace.
type rigOptions struct {
	key          string
	dead         *url.URL
	provider     *domain.Provider
	peers        func(model string) (PeerTarget, bool)
	events       *eventLog
	token        string
	keyLookup    func(ctx context.Context) (string, error)
	bodyLimit    int64
	keyTimeoutMs int64
	onUpstream   func(req *http.Request)
}

// newRouterRig builds the rig: a provider router on a reserved port, pointed at two recording
// upstreams (or one dead target).
func newRouterRig(t *testing.T, options rigOptions) (int, *seenList, *seenList, *lineLog) {
	t.Helper()
	anthropicSeen := &seenList{}
	providerSeen := &seenList{}
	logs := &lineLog{}
	anthropic := options.dead
	providerURL := options.dead
	if anthropic == nil {
		anthropic = recordingUpstream(t, "anthropic", "", anthropicSeen)
	}
	if providerURL == nil {
		providerURL = recordingUpstream(t, "provider", "/api/anthropic", providerSeen)
	}
	provider := routerProvider
	if options.provider != nil {
		provider = *options.provider
	}
	key := options.keyLookup
	if key == nil {
		key = func(context.Context) (string, error) { return options.key, nil }
	}
	port := reservePort(t)
	server := CreateRouter(RouterOptions{
		Provider:     provider,
		Port:         port,
		Anthropic:    anthropic,
		ProviderURL:  providerURL,
		Key:          key,
		Log:          logs.add,
		Peers:        options.peers,
		Events:       eventsCallback(options.events),
		Token:        options.token,
		BodyLimit:    options.bodyLimit,
		KeyTimeoutMs: options.keyTimeoutMs,
		OnUpstream:   options.onUpstream,
	})
	if server == nil {
		t.Fatal("CreateRouter returned no server")
	}
	serveRouter(t, server, port)
	return port, anthropicSeen, providerSeen, logs
}

// eventsCallback adapts the collector to the options' callback shape; nil when nobody listens.
func eventsCallback(events *eventLog) func(domain.SpoolEvent) {
	if events == nil {
		return nil
	}
	return events.record
}

func TestRouting(t *testing.T) {
	t.Parallel()
	// A raw provider-bound POST whose body arrives exactly as built, so untouched bytes are
	// assertable.
	postBody := func(port int, body string) answer {
		got, err := postRawBody(port, "/v1/messages", body, map[string]string{
			"Content-Type": "application/json",
			"Host":         fmt.Sprintf("127.0.0.1:%d", port),
		})
		if err != nil {
			t.Fatalf("postBody: %v", err)
		}
		return got
	}

	t.Run("sends the provider's own models to it with its key in place of the caller's credentials", func(t *testing.T) {
		port, anthropicSeen, providerSeen, _ := newRouterRig(t, rigOptions{key: "provider-secret"})
		got, err := postAnswer(port, "glm-5.3-flash", map[string]string{"X-Api-Key": "anthropic-key"})
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 200 {
			t.Fatalf("status = %d", got.status)
		}
		if got.body != "data: provider-1\n\ndata: provider-2\n\n" {
			t.Errorf("body = %q", got.body)
		}
		if anthropicSeen.len() != 0 {
			t.Error("the request reached Anthropic")
		}
		seen := providerSeen.list()
		if len(seen) != 1 {
			t.Fatalf("the provider saw %d requests", len(seen))
		}
		if seen[0].path != "/api/anthropic/v1/messages?beta=true" {
			t.Errorf("path = %q", seen[0].path)
		}
		if gotHeader := seen[0].headers.Get("Authorization"); gotHeader != "Bearer provider-secret" {
			t.Errorf("authorization = %q", gotHeader)
		}
		if gotHeader := seen[0].headers.Get("X-Api-Key"); gotHeader != "" {
			t.Errorf("x-api-key = %q, want none", gotHeader)
		}
		var body struct {
			Model string `json:"model"`
		}
		if err := json.Unmarshal([]byte(seen[0].body), &body); err != nil {
			t.Fatal(err)
		}
		if body.Model != "glm-5.3-flash" {
			t.Errorf("model = %q", body.Model)
		}
	})

	t.Run("sends every other model to Anthropic with the caller's headers untouched", func(t *testing.T) {
		port, anthropicSeen, providerSeen, _ := newRouterRig(t, rigOptions{key: "provider-secret"})
		got, err := postAnswer(port, "claude-opus-5-5", map[string]string{"Anthropic-Beta": "x"})
		if err != nil {
			t.Fatal(err)
		}
		if got.body != "data: anthropic-1\n\ndata: anthropic-2\n\n" {
			t.Errorf("body = %q", got.body)
		}
		if providerSeen.len() != 0 {
			t.Error("the request reached the provider")
		}
		seen := anthropicSeen.list()
		if len(seen) != 1 {
			t.Fatalf("Anthropic saw %d requests", len(seen))
		}
		if seen[0].path != "/v1/messages?beta=true" {
			t.Errorf("path = %q", seen[0].path)
		}
		if gotHeader := seen[0].headers.Get("Authorization"); gotHeader != "Bearer anthropic-oauth" {
			t.Errorf("authorization = %q", gotHeader)
		}
		if gotHeader := seen[0].headers.Get("Anthropic-Beta"); gotHeader != "x" {
			t.Errorf("anthropic-beta = %q", gotHeader)
		}
	})

	t.Run("claims an exact catalog id even without a matching prefix, so a renamed model still routes", func(t *testing.T) {
		provider := routerProvider
		provider.Catalog = map[domain.ModelTier]domain.ModelRef{
			domain.ModelTierMain:  {Tier: domain.ModelTierMain, ID: "totally-unprefixed", Label: "Unprefixed"},
			domain.ModelTierFlash: provider.Catalog[domain.ModelTierFlash],
		}
		claim := provider.ModelClaim()
		if !domain.Claims(claim, "totally-unprefixed") {
			t.Error("the exact catalog id must be claimed")
		}
		if !domain.Claims(claim, "glm-5.3") {
			t.Error("glm-5.3 must stay claimed by prefix")
		}
		if domain.Claims(claim, "claude-haiku-4-5") {
			t.Error("claude-haiku-4-5 must not be claimed")
		}
	})

	t.Run("answers the provider's model without a key with a non-retryable 400 naming setup, never a 401", func(t *testing.T) {
		port, _, providerSeen, _ := newRouterRig(t, rigOptions{})
		glm, err := postAnswer(port, "glm-5.3", nil)
		if err != nil {
			t.Fatal(err)
		}
		if glm.status != 400 {
			t.Fatalf("status = %d, want 400", glm.status)
		}
		if retry := glm.header.Get("X-Should-Retry"); retry != "false" {
			t.Errorf("x-should-retry = %q", retry)
		}
		want := `{"type":"error","error":{"type":"invalid_request_error","message":` +
			`"Z.ai GLM key refused or missing: run /zai:setup (no key is set). Claude models are not affected."}}`
		if glm.body != want {
			t.Errorf("body = %s", glm.body)
		}
		claude, err := postAnswer(port, "claude-sonnet-5-5", nil)
		if err != nil {
			t.Fatal(err)
		}
		if claude.status != 200 {
			t.Errorf("claude status = %d", claude.status)
		}
		if providerSeen.len() != 0 {
			t.Error("the provider saw a request")
		}
	})

	t.Run("refuses a request whose Host is not this machine's router", func(t *testing.T) {
		port, anthropicSeen, _, _ := newRouterRig(t, rigOptions{key: "k"})
		client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
		defer client.CloseIdleConnections()
		request, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/v1/messages", port), strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		request.Host = "evil.example"
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		if response.StatusCode != 421 {
			t.Errorf("status = %d, want 421", response.StatusCode)
		}
		if anthropicSeen.len() != 0 {
			t.Error("the request reached Anthropic")
		}
	})

	t.Run("serves its health check and logs one line per request without credentials", func(t *testing.T) {
		port, _, _, logs := newRouterRig(t, rigOptions{key: "provider-secret"})
		health, err := getBody(port, routerProvider.Router.HealthPath)
		if err != nil {
			t.Fatal(err)
		}
		if health.status != 200 {
			t.Fatalf("health status = %d", health.status)
		}
		if _, err := postAnswer(port, "glm-5.3", nil); err != nil {
			t.Fatal(err)
		}
		lines := logs.list()
		if len(lines) != 1 {
			t.Fatalf("logs = %v", lines)
		}
		if !regexp.MustCompile(`POST /api/anthropic/v1/messages model=glm-5\.3 → provider 200`).MatchString(lines[0]) {
			t.Errorf("log = %q", lines[0])
		}
		if regexp.MustCompile(`secret|oauth`).MatchString(strings.Join(lines, ",")) {
			t.Errorf("a log line carries credentials: %v", lines)
		}
	})

	deadUpstream := func(t *testing.T) *url.URL {
		t.Helper()
		port := reservePort(t)
		return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d", port))
	}

	t.Run("answers an Anthropic-style 502 when the upstream is unreachable", func(t *testing.T) {
		port, _, _, logs := newRouterRig(t, rigOptions{key: "k", dead: deadUpstream(t)})
		got, err := postAnswer(port, "claude-opus-5-5", nil)
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 502 {
			t.Fatalf("status = %d", got.status)
		}
		var body struct {
			Error struct {
				Type string `json:"type"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(got.body), &body); err != nil {
			t.Fatal(err)
		}
		if body.Error.Type != "api_error" {
			t.Errorf("error.type = %q", body.Error.Type)
		}
		if !regexp.MustCompile(`→ anthropic error ECONNREFUSED`).MatchString(logs.list()[0]) {
			t.Errorf("log = %q", logs.list()[0])
		}
	})

	t.Run("records the connection failure's errno as the route event's reason", func(t *testing.T) {
		events := &eventLog{}
		port, _, _, _ := newRouterRig(t, rigOptions{key: "k", dead: deadUpstream(t), events: events})
		got, err := postAnswer(port, "claude-opus-5-5", nil)
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 502 {
			t.Fatalf("status = %d", got.status)
		}
		if !until(func() bool { return len(events.all()) == 1 }) {
			t.Fatalf("events = %v", events.all())
		}
		route := events.routes()[0]
		if route.Event != domain.EventRoute || route.Route != "anthropic" || route.Status != 502 {
			t.Errorf("event = %+v", route)
		}
		if route.Error == nil || *route.Error != "connection failed (ECONNREFUSED)" {
			t.Errorf("error = %v", route.Error)
		}
	})

	t.Run("records why it refused a second peer hop on that route event too", func(t *testing.T) {
		peerSeen := &seenList{}
		peerURL := recordingUpstream(t, "kimi", "", peerSeen)
		events := &eventLog{}
		peers := func(model string) (PeerTarget, bool) {
			if strings.HasPrefix(model, "kimi-") {
				return PeerTarget{Name: "kimi", Port: portOfURL64(peerURL.Port())}, true
			}
			return PeerTarget{}, false
		}
		port, _, _, _ := newRouterRig(t, rigOptions{key: "k", peers: peers, events: events})
		got, err := postAnswer(port, "kimi-k3", map[string]string{PeerHop: "1"})
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 508 {
			t.Fatalf("status = %d, want 508", got.status)
		}
		if !until(func() bool { return len(events.all()) == 1 }) {
			t.Fatalf("events = %v", events.all())
		}
		route := events.routes()[0]
		if route.Event != domain.EventRoute || route.Route != "refused" || route.Status != 508 {
			t.Errorf("event = %+v", route)
		}
		if route.Error == nil || *route.Error != "refusing to forward a request twice" {
			t.Errorf("error = %v", route.Error)
		}
	})

	t.Run("refuses an http upstream that is not loopback, on either route", func(t *testing.T) {
		dead := mustURL(t, "http://10.9.8.7:1")
		port, _, _, logs := newRouterRig(t, rigOptions{key: "k", dead: dead})
		anthropic, err := postAnswer(port, "claude-opus-5-5", nil)
		if err != nil {
			t.Fatal(err)
		}
		provider, err := postAnswer(port, "glm-5.3", nil)
		if err != nil {
			t.Fatal(err)
		}
		if anthropic.status != 502 || provider.status != 502 {
			t.Fatalf("statuses = %d, %d", anthropic.status, provider.status)
		}
		var body struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(anthropic.body), &body); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(body.Error.Message, "must be https unless it is loopback (10.9.8.7:1)") {
			t.Errorf("message = %q", body.Error.Message)
		}
		refused := 0
		for _, line := range logs.list() {
			if strings.Contains(line, "refused") {
				refused++
			}
		}
		if refused != 2 {
			t.Errorf("refused lines = %d, want 2 (%v)", refused, logs.list())
		}
	})

	t.Run("strips the provider's rejected fields from provider-bound bodies only, wherever they sit", func(t *testing.T) {
		stripping := routerProvider
		stripping.Strip = []string{"cache_control"}
		port, anthropicSeen, providerSeen, _ := newRouterRig(t, rigOptions{key: "k", provider: &stripping})
		body := `{"model":"glm-5.3","metadata":{"cache_control":{"type":"ephemeral"}},"messages":[` +
			`{"role":"user","content":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"}}]},` +
			`{"role":"assistant","content":[{"type":"text","text":"ho","cache_control":{"type":"ephemeral"}}]}]}`
		if _, err := postRawBody(port, "/v1/messages", body, map[string]string{
			"Content-Type": "application/json", "Host": fmt.Sprintf("127.0.0.1:%d", port),
		}); err != nil {
			t.Fatal(err)
		}
		var claudeBody map[string]any
		if err := json.Unmarshal([]byte(body), &claudeBody); err != nil {
			t.Fatal(err)
		}
		claudeBody["model"] = "claude-opus-5-5"
		requeued, err := json.Marshal(claudeBody)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := postRawBody(port, "/v1/messages", string(requeued), map[string]string{
			"Content-Type": "application/json", "Host": fmt.Sprintf("127.0.0.1:%d", port),
		}); err != nil {
			t.Fatal(err)
		}
		var providerSent map[string]any
		if err := json.Unmarshal([]byte(providerSeen.list()[0].body), &providerSent); err != nil {
			t.Fatal(err)
		}
		want := map[string]any{
			"model":    "glm-5.3",
			"metadata": map[string]any{},
			"messages": []any{
				map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "hi"}}},
				map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "ho"}}},
			},
		}
		if !reflect.DeepEqual(providerSent, want) {
			t.Errorf("the provider got %+v", providerSent)
		}
		// Anthropic-bound: forwarded unchanged, cache_control and all.
		var anthropicSent map[string]any
		if err := json.Unmarshal([]byte(anthropicSeen.list()[0].body), &anthropicSent); err != nil {
			t.Fatal(err)
		}
		sent := anthropicSent["messages"].([]any)[0].(map[string]any)["content"].([]any)[0].(map[string]any)
		if !reflect.DeepEqual(sent["cache_control"], map[string]any{"type": "ephemeral"}) {
			t.Errorf("anthropic got %+v", anthropicSent)
		}
	})

	t.Run("clamps max_tokens above the model's cap and forwards anything else as the request carried it", func(t *testing.T) {
		port, _, providerSeen, _ := newRouterRig(t, rigOptions{key: "provider-secret"})
		postBody(port, `{"model":"glm-5.3-flash","max_tokens":131073,"messages":[]}`)
		below := `{"model":"glm-5.3-flash","max_tokens":1024,"messages":[]}`
		postBody(port, below)
		missing := `{"model":"glm-5.3-flash","messages":[]}`
		postBody(port, missing)
		// A model the catalog names only by prefix declares no cap, so its max_tokens stays as it came.
		prefixed := `{"model":"glm-9.9-preview","max_tokens":999999,"messages":[]}`
		postBody(port, prefixed)
		seen := providerSeen.list()
		var clamped struct {
			MaxTokens int64 `json:"max_tokens"`
		}
		if err := json.Unmarshal([]byte(seen[0].body), &clamped); err != nil {
			t.Fatal(err)
		}
		if clamped.MaxTokens != 131072 {
			t.Errorf("max_tokens = %d", clamped.MaxTokens)
		}
		// Below the cap, without max_tokens, and without a declared cap: the caller's bytes, not a
		// re-serialisation.
		if seen[1].body != below || seen[2].body != missing || seen[3].body != prefixed {
			t.Errorf("bodies = %v", seen)
		}
	})

	t.Run("serves a web_search tool with the provider's web search model, whatever model was asked", func(t *testing.T) {
		port, _, providerSeen, logs := newRouterRig(t, rigOptions{key: "provider-secret"})
		tool := `[{"type":"web_search_20250305","name":"web_search"}]`
		postBody(port, `{"model":"glm-5.3-flash","messages":[],"tools":`+tool+`}`)
		serving := `{"model":"glm-5.3","messages":[],"tools":` + tool + `}`
		postBody(port, serving)
		without := `{"model":"glm-5.3-flash","messages":[]}`
		postBody(port, without)
		postBody(port, `{"model":"glm-5.3-flash","messages":[],"tools":[{"name":"Bash"}]}`)
		seen := providerSeen.list()
		var sent struct {
			Model string `json:"model"`
		}
		if err := json.Unmarshal([]byte(seen[0].body), &sent); err != nil {
			t.Fatal(err)
		}
		if sent.Model != "glm-5.3" {
			t.Errorf("model = %q", sent.Model)
		}
		served := 0
		for _, line := range logs.list() {
			if strings.Contains(line, "web_search tool served by glm-5.3") {
				served++
			}
		}
		if served != 1 {
			t.Errorf("web_search lines = %d (%v)", served, logs.list())
		}
		// The model that serves the tool, a request without any tool, and a regular tool all go
		// where they were asked.
		if seen[1].body != serving || seen[2].body != without {
			t.Errorf("bodies = %v", seen)
		}
		if err := json.Unmarshal([]byte(seen[3].body), &sent); err != nil {
			t.Fatal(err)
		}
		if sent.Model != "glm-5.3-flash" {
			t.Errorf("model = %q", sent.Model)
		}
	})

	t.Run("forwards Claude traffic byte for byte, a web_search tool and an oversized max_tokens included", func(t *testing.T) {
		port, anthropicSeen, providerSeen, logs := newRouterRig(t, rigOptions{key: "provider-secret"})
		body := `{"model":"claude-opus-5-5","max_tokens":999999,"messages":[],` +
			`"tools":[{"type":"web_search_20250305","name":"web_search"}]}`
		got := postBody(port, body)
		if got.status != 200 {
			t.Fatalf("status = %d", got.status)
		}
		if providerSeen.len() != 0 {
			t.Error("the provider saw a claude-* request")
		}
		if seen := anthropicSeen.list(); len(seen) != 1 || seen[0].body != body {
			t.Errorf("anthropic got %v", seen)
		}
		if strings.Contains(logs.joined(), "web_search") {
			t.Errorf("a log line names web_search: %v", logs.list())
		}
	})
}

func TestRouterHelpers(t *testing.T) {
	t.Parallel()
	t.Run("reads the model from a JSON body and treats anything else as no model", func(t *testing.T) {
		if got := RequestModel([]byte(`{"model":"glm-5.3"}`)); got != "glm-5.3" {
			t.Errorf("RequestModel = %q", got)
		}
		if got := RequestModel([]byte("not json")); got != "" {
			t.Errorf("RequestModel(not json) = %q", got)
		}
		if got := RequestModel([]byte(`{"model":5}`)); got != "" {
			t.Errorf("RequestModel(5) = %q", got)
		}
	})

	t.Run("drops hop-by-hop headers and sets host and length for the upstream", func(t *testing.T) {
		incoming := http.Header{}
		incoming.Set("Connection", "keep-alive")
		incoming.Set("Transfer-Encoding", "chunked")
		incoming.Set("Host", "127.0.0.1:1")
		incoming.Set("Accept", "x")
		out := UpstreamHeaders(incoming, mustURL(t, "https://api.z.ai/api/anthropic"), 7, "")
		want := http.Header{"Accept": {"x"}, "Host": {"api.z.ai"}, "Content-Length": {"7"}}
		if !reflect.DeepEqual(out, want) {
			t.Errorf("headers = %v, want %v", out, want)
		}
	})

	t.Run("strips rejected fields recursively and keeps bytes without them as they were", func(t *testing.T) {
		body := []byte(`{"context_management":true,"messages":[{"cache_control":{},"role":"user"},` +
			`{"cache_control":{},"role":"assistant"}],"nested":{"cache_control":{}}}`)
		var stripped map[string]any
		if err := json.Unmarshal(StripRejected(body, []string{"cache_control", "context_management"}), &stripped); err != nil {
			t.Fatal(err)
		}
		want := map[string]any{
			"messages": []any{map[string]any{"role": "user"}, map[string]any{"role": "assistant"}},
			"nested":   map[string]any{},
		}
		if !reflect.DeepEqual(stripped, want) {
			t.Errorf("stripped = %+v", stripped)
		}
		// A provider that rejects nothing, a body without the field, and a non-JSON body all pass
		// through unchanged.
		if got := StripRejected(body, nil); !bytes.Equal(got, body) {
			t.Errorf("no fields: %q", got)
		}
		if got := StripRejected([]byte(`{"model":"glm-5.3"}`), []string{"cache_control"}); string(got) != `{"model":"glm-5.3"}` {
			t.Errorf("without the field: %q", got)
		}
		if got := StripRejected([]byte("not json"), []string{"cache_control"}); string(got) != "not json" {
			t.Errorf("not json: %q", got)
		}
	})

	t.Run("knows the loopback hosts an http upstream may be", func(t *testing.T) {
		for host, want := range map[string]bool{
			"127.0.0.1": true, "127.9.9.9": true, "localhost": true, "::1": true,
			"10.0.0.1": false, "api.z.ai": false,
		} {
			if got := domain.IsLoopback(host); got != want {
				t.Errorf("IsLoopback(%q) = %v", host, got)
			}
		}
	})

	t.Run("parses usage out of a JSON body's top level, out of SSE split across chunks, and out of nothing", func(t *testing.T) {
		jsonTracker := NewUsageTracker("application/json", "")
		jsonTracker.Push([]byte(`{"usage":{"input_tok`))
		jsonTracker.Push([]byte(`ens":5},"rest":"sekrit"}`))
		if got := jsonTracker.Usage(); !reflect.DeepEqual(map[string]any(got), map[string]any{"input_tokens": float64(5)}) {
			t.Errorf("json usage = %v", got)
		}

		sse := NewUsageTracker("text/event-stream; charset=utf-8", "")
		sse.Push([]byte("data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input"))
		sse.Push([]byte("_tokens\":2}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"out"))
		sse.Push([]byte("put_tokens\":9}}\n\n"))
		if got := sse.Usage(); !reflect.DeepEqual(map[string]any(got), map[string]any{"input_tokens": float64(2), "output_tokens": float64(9)}) {
			t.Errorf("sse usage = %v", got)
		}

		if got := NewUsageTracker("", "").Usage(); got != nil {
			t.Errorf("no content type: %v", got)
		}
		if got := NewUsageTracker("text/plain", "").Usage(); got != nil {
			t.Errorf("text/plain: %v", got)
		}

		broken := NewUsageTracker("application/json", "")
		broken.Push([]byte("not json"))
		if got := broken.Usage(); got != nil {
			t.Errorf("broken json: %v", got)
		}

		noisy := NewUsageTracker("text/event-stream", "")
		noisy.Push([]byte("data: oops\n: keepalive\ndata: 7\n\n"))
		if got := noisy.Usage(); got != nil {
			t.Errorf("noisy sse: %v", got)
		}
	})

	t.Run("reads a provider error's reason: the known shapes, one line, capped, credentials redacted", func(t *testing.T) {
		reason := func(body string, key string) string {
			got, ok := UpstreamErrorReason([]byte(body), key)
			if !ok {
				return ""
			}
			return got
		}
		if got := reason(`{"error":{"type":"invalid_request_error","message":"messages: field required"}}`, ""); got != "invalid_request_error: messages: field required" {
			t.Errorf("anthropic shape: %q", got)
		}
		if got := reason(`{"error":{"code":"1210","message":"API key not valid"}}`, ""); got != "1210: API key not valid" {
			t.Errorf("code shape: %q", got)
		}
		if got := reason(`{"code":"1302","msg":"conversation does not exist"}`, ""); got != "1302: conversation does not exist" {
			t.Errorf("code/msg shape: %q", got)
		}
		// Anything else — not JSON, or JSON without a known shape — is the text itself; newlines and
		// runs of whitespace collapse into one line.
		if got := reason("<html>\n  Bad\trequest  </html>", ""); got != "<html> Bad request </html>" {
			t.Errorf("plain text: %q", got)
		}
		if got := reason(`{"nothing":"here"}`, ""); got != `{"nothing":"here"}` {
			t.Errorf("unknown json: %q", got)
		}
		// A credential-shaped run never survives, however the message spells it.
		if got := reason(`{"code":"407","msg":"key `+strings.Repeat("a", 32)+` quota exhausted"}`, ""); got != "407: key … quota exhausted" {
			t.Errorf("redacted run: %q", got)
		}
		if got := reason(`{"error":{"type":"e","message":"`+strings.Repeat("x", 400)+`"}}`, ""); got != "e: …" {
			t.Errorf("redacted message: %q", got)
		}
		// The route's own key is redacted even when it is too short to look like a token.
		if got := reason(`{"code":"1","msg":"bad key short-key-123"}`, "short-key-123"); got != "1: bad key …" {
			t.Errorf("own key: %q", got)
		}
		// At most 300 characters are kept (of the first 2048 bytes read).
		long := `{"error":{"type":"e","message":"` + strings.Repeat("abcdef ", 60) + `trailing"}}`
		want := ("e: " + strings.Repeat("abcdef ", 60) + "trailing")[:300]
		if got := reason(long, ""); got != want {
			t.Errorf("capped = %q (%d chars)", got, len(got))
		}
		if _, ok := UpstreamErrorReason([]byte(""), ""); ok {
			t.Error("an empty body has no reason")
		}
	})
}

func TestPeerForwarding(t *testing.T) {
	t.Parallel()
	kimiPeer := func(port int64) func(string) (PeerTarget, bool) {
		return func(model string) (PeerTarget, bool) {
			if strings.HasPrefix(model, "kimi-") {
				return PeerTarget{Name: "kimi", Port: port}, true
			}
			return PeerTarget{}, false
		}
	}

	t.Run("sends another plugin's models to its router unchanged, stamped with the hop header", func(t *testing.T) {
		peerSeen := &seenList{}
		peerURL := recordingUpstream(t, "kimi", "", peerSeen)
		port, anthropicSeen, providerSeen, _ := newRouterRig(t, rigOptions{
			key: "provider-secret", peers: kimiPeer(portOfURL64(peerURL.Port())),
		})
		got, err := postAnswer(port, "kimi-k3", map[string]string{"Anthropic-Beta": "x"})
		if err != nil {
			t.Fatal(err)
		}
		if got.body != "data: kimi-1\n\ndata: kimi-2\n\n" {
			t.Errorf("body = %q", got.body)
		}
		if providerSeen.len() != 0 || anthropicSeen.len() != 0 {
			t.Error("the request reached another upstream")
		}
		seen := peerSeen.list()
		if len(seen) != 1 {
			t.Fatalf("the peer saw %d requests", len(seen))
		}
		if seen[0].path != "/v1/messages?beta=true" {
			t.Errorf("path = %q", seen[0].path)
		}
		if gotHeader := seen[0].headers.Get("Authorization"); gotHeader != "Bearer anthropic-oauth" {
			t.Errorf("authorization = %q", gotHeader)
		}
		if gotHeader := seen[0].headers.Get(PeerHop); gotHeader != "1" {
			t.Errorf("hop header = %q", gotHeader)
		}
		var body struct {
			Model string `json:"model"`
		}
		if err := json.Unmarshal([]byte(seen[0].body), &body); err != nil {
			t.Fatal(err)
		}
		if body.Model != "kimi-k3" {
			t.Errorf("model = %q", body.Model)
		}
	})

	t.Run("serves its own provider's model when another plugin's router forwarded it, without the hop header", func(t *testing.T) {
		port, _, providerSeen, _ := newRouterRig(t, rigOptions{key: "k"})
		got, err := postAnswer(port, "glm-5.3", map[string]string{PeerHop: "1"})
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 200 {
			t.Fatalf("status = %d", got.status)
		}
		if got.body != "data: provider-1\n\ndata: provider-2\n\n" {
			t.Errorf("body = %q", got.body)
		}
		seen := providerSeen.list()
		if len(seen) != 1 {
			t.Fatalf("the provider saw %d requests", len(seen))
		}
		if hop := seen[0].headers.Get(PeerHop); hop != "" {
			t.Errorf("hop header = %q", hop)
		}
		if gotHeader := seen[0].headers.Get("Authorization"); gotHeader != "Bearer k" {
			t.Errorf("authorization = %q", gotHeader)
		}
	})

	t.Run("refuses to forward a request twice: another plugin's model that already hopped gets a 508", func(t *testing.T) {
		peerSeen := &seenList{}
		peerURL := recordingUpstream(t, "kimi", "", peerSeen)
		port, anthropicSeen, providerSeen, _ := newRouterRig(t, rigOptions{
			key: "k", peers: kimiPeer(portOfURL64(peerURL.Port())),
		})
		got, err := postAnswer(port, "kimi-k3", map[string]string{PeerHop: "1"})
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 508 {
			t.Fatalf("status = %d, want 508", got.status)
		}
		if providerSeen.len() != 0 || anthropicSeen.len() != 0 || peerSeen.len() != 0 {
			t.Error("a refused request reached an upstream")
		}
		var body struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(got.body), &body); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(body.Error.Message, "forward") {
			t.Errorf("message = %q", body.Error.Message)
		}
	})

	t.Run("refuses to forward a request twice: an Anthropic model that already hopped gets a 508", func(t *testing.T) {
		peerSeen := &seenList{}
		peerURL := recordingUpstream(t, "kimi", "", peerSeen)
		port, anthropicSeen, providerSeen, _ := newRouterRig(t, rigOptions{
			key: "k", peers: kimiPeer(portOfURL64(peerURL.Port())),
		})
		got, err := postAnswer(port, "claude-sonnet-5-5", map[string]string{PeerHop: "1"})
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 508 {
			t.Fatalf("status = %d, want 508", got.status)
		}
		if providerSeen.len() != 0 || anthropicSeen.len() != 0 || peerSeen.len() != 0 {
			t.Error("a refused request reached an upstream")
		}
		var body struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(got.body), &body); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(body.Error.Message, "forward") {
			t.Errorf("message = %q", body.Error.Message)
		}
	})

	t.Run("answers an Anthropic-style 502 naming the plugin and its setup when the peer is down", func(t *testing.T) {
		deadPeerPort := reservePort(t)
		port, _, _, _ := newRouterRig(t, rigOptions{key: "k", peers: kimiPeer(int64(deadPeerPort))})
		got, err := postAnswer(port, "kimi-k3", nil)
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 502 {
			t.Fatalf("status = %d", got.status)
		}
		var body struct {
			Error struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(got.body), &body); err != nil {
			t.Fatal(err)
		}
		if body.Error.Type != "api_error" {
			t.Errorf("error.type = %q", body.Error.Type)
		}
		if !strings.Contains(body.Error.Message, "kimi plugin's router is down") ||
			!strings.Contains(body.Error.Message, "/kimi:setup") {
			t.Errorf("message = %q", body.Error.Message)
		}
	})

	t.Run("still sends claude-* models to Anthropic when a peer is configured", func(t *testing.T) {
		peerSeen := &seenList{}
		peerURL := recordingUpstream(t, "kimi", "", peerSeen)
		port, anthropicSeen, _, _ := newRouterRig(t, rigOptions{
			key: "k", peers: kimiPeer(portOfURL64(peerURL.Port())),
		})
		if _, err := postAnswer(port, "claude-sonnet-5-5", nil); err != nil {
			t.Fatal(err)
		}
		if peerSeen.len() != 0 {
			t.Error("the peer saw a claude-* request")
		}
		if anthropicSeen.len() != 1 {
			t.Errorf("Anthropic saw %d requests", anthropicSeen.len())
		}
	})
}

// usageRig builds a router pointed at the usage upstream on both routes, recording its route
// events.
func usageRig(t *testing.T, kind string) (int, *eventLog, *url.URL) {
	t.Helper()
	events := &eventLog{}
	anthropic := usageUpstream(t, kind, &seenList{})
	providerURL := usageUpstream(t, kind, &seenList{})
	port := reservePort(t)
	server := CreateRouter(RouterOptions{
		Provider:    routerProvider,
		Port:        port,
		Anthropic:   anthropic,
		ProviderURL: providerURL,
		Key:         func(context.Context) (string, error) { return "k", nil },
		Log:         func(string) {},
		Events:      events.record,
	})
	serveRouter(t, server, port)
	return port, events, anthropic
}

// usageUpstream is an upstream whose answers carry usage: JSON at the top level, the same JSON
// gzipped, or SSE in message_start and message_delta.
func usageUpstream(t *testing.T, kind string, seen *seenList) *url.URL {
	t.Helper()
	port := serve(t, func(w http.ResponseWriter, req *http.Request) {
		body, err := ReadBody(req, BodyLimitBytes)
		if err != nil {
			return
		}
		res := NewResponse(w)
		seen.record(pathOf(req), req.Header, string(body))
		switch kind {
		case "json":
			res.Header().Set("Content-Type", "application/json")
			res.WriteHeader(200)
			res.End([]byte(`{"usage":{"input_tokens":3,"output_tokens":4}}`))
		case "gzip":
			var compressed bytes.Buffer
			writer := gzip.NewWriter(&compressed)
			_, _ = writer.Write([]byte(`{"usage":{"input_tokens":3,"output_tokens":4}}`))
			_ = writer.Close()
			res.Header().Set("Content-Type", "application/json")
			res.Header().Set("Content-Encoding", "gzip")
			res.WriteHeader(200)
			res.End(compressed.Bytes())
		default:
			res.Header().Set("Content-Type", "text/event-stream")
			res.WriteHeader(200)
			res.Write([]byte(`data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}` + "\n\n"))
			res.Write([]byte(`data: {"type":"content_block_delta","delta":{"text":"sekrit answer"}}` + "\n\n"))
			res.End([]byte(`data: {"type":"message_delta","delta":{"stop":"end"},"usage":{"output_tokens":7}}` + "\n\n"))
		}
	}, nil)
	return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d", port))
}

// rawAnswer is a provider-bound POST read raw: a client that decompresses nothing would hide the
// answer's own bytes.
func rawAnswer(t *testing.T, port int, model string) (int, string, string) {
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
	return response.StatusCode, response.Header.Get("Content-Encoding"), string(text)
}

func TestRouteEvents(t *testing.T) {
	t.Parallel()
	t.Run("records an SSE answer's usage from message_start and the final message_delta, and the session id", func(t *testing.T) {
		port, events, anthropic := usageRig(t, "sse")
		if _, err := postAnswer(port, "claude-sonnet-5-5", map[string]string{"X-Claude-Code-Session-Id": "sess-1"}); err != nil {
			t.Fatal(err)
		}
		waitForEvents(t, events, 1)
		route := events.routes()[0]
		if route.Event != domain.EventRoute || route.Plugin != "zai" || route.Model != "claude-sonnet-5-5" ||
			route.Route != "anthropic" || route.Status != 200 {
			t.Errorf("event = %+v", route)
		}
		if route.SessionID == nil || *route.SessionID != "sess-1" {
			t.Errorf("session id = %v", route.SessionID)
		}
		want := domain.RouteUsage{"input_tokens": float64(10), "output_tokens": float64(7)}
		if route.Usage == nil || !reflect.DeepEqual(*route.Usage, want) {
			t.Errorf("usage = %v", route.Usage)
		}
		if route.Upstream != anthropic.Host {
			t.Errorf("upstream = %q", route.Upstream)
		}
		if route.LatencyMs < 0 {
			t.Errorf("latency = %d", route.LatencyMs)
		}
		// Metadata only: the answer's text never reaches the spool.
		if text := string(mustJSON(t, events.all())); strings.Contains(text, "sekrit") {
			t.Error("the spool carries the answer's text")
		}
	})

	t.Run("records a JSON answer's top-level usage, and nothing else of the body", func(t *testing.T) {
		port, events, _ := usageRig(t, "json")
		if _, err := postAnswer(port, "glm-5.3", nil); err != nil {
			t.Fatal(err)
		}
		waitForEvents(t, events, 1)
		route := events.routes()[0]
		if route.Event != domain.EventRoute || route.Plugin != "zai" || route.Model != "glm-5.3" ||
			route.Route != "provider" || route.Status != 200 {
			t.Errorf("event = %+v", route)
		}
		want := domain.RouteUsage{"input_tokens": float64(3), "output_tokens": float64(4)}
		if route.Usage == nil || !reflect.DeepEqual(*route.Usage, want) {
			t.Errorf("usage = %v", route.Usage)
		}
		if route.SessionID != nil {
			t.Errorf("session id = %v", *route.SessionID)
		}
	})

	t.Run("records a gzipped JSON answer's usage, and the client still gets the identical gzip bytes", func(t *testing.T) {
		port, events, _ := usageRig(t, "gzip")
		status, encoding, body := rawAnswer(t, port, "glm-5.3")
		if status != 200 {
			t.Fatalf("status = %d", status)
		}
		if encoding != "gzip" {
			t.Fatalf("encoding = %q", encoding)
		}
		reader, err := gzip.NewReader(strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		plain, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		if string(plain) != `{"usage":{"input_tokens":3,"output_tokens":4}}` {
			t.Errorf("gunzipped = %q", plain)
		}
		waitForEvents(t, events, 1)
		route := events.routes()[0]
		want := domain.RouteUsage{"input_tokens": float64(3), "output_tokens": float64(4)}
		if route.Route != "provider" || route.Status != 200 || route.Usage == nil || !reflect.DeepEqual(*route.Usage, want) {
			t.Errorf("event = %+v", route)
		}
	})

	t.Run("answers a JSON answer over the usage cap whole, and its route event carries no usage", func(t *testing.T) {
		body := `{"usage":{"input_tokens":3,"output_tokens":4},"pad":"` + strings.Repeat("x", 128*1024) + `"}`
		port, events, _ := answeringRig(t, 200, body, answeringTargetProvider, "application/json")
		got, err := postAnswer(port, "glm-5.3", nil)
		if err != nil {
			t.Fatal(err)
		}
		// The answer is not held back or cut: the client reads every byte of it.
		if got.status != 200 || got.body != body {
			t.Fatalf("answer = %d, %d bytes (want %d)", got.status, len(got.body), len(body))
		}
		waitForEvents(t, events, 1)
		route := events.routes()[0]
		if route.Event != domain.EventRoute || route.Route != "provider" || route.Status != 200 {
			t.Errorf("event = %+v", route)
		}
		if route.Usage != nil {
			t.Errorf("usage = %v", *route.Usage)
		}
	})

	t.Run("records a subagent's agent and parent-agent ids beside the session id, and none for a bare request", func(t *testing.T) {
		port, events, _ := usageRig(t, "json")
		if _, err := postAnswer(port, "glm-5.3", map[string]string{
			"X-Claude-Code-Session-Id":      "sess-7",
			"X-Claude-Code-Agent-Id":        "agent-9",
			"X-Claude-Code-Parent-Agent-Id": "agent-2",
		}); err != nil {
			t.Fatal(err)
		}
		waitForEvents(t, events, 1)
		route := events.routes()[0]
		if route.SessionID == nil || *route.SessionID != "sess-7" ||
			route.AgentID == nil || *route.AgentID != "agent-9" ||
			route.ParentAgentID == nil || *route.ParentAgentID != "agent-2" {
			t.Errorf("ids = %v %v %v", route.SessionID, route.AgentID, route.ParentAgentID)
		}

		barePort, bareEvents, _ := usageRig(t, "sse")
		if _, err := postAnswer(barePort, "claude-sonnet-5-5", map[string]string{
			"X-Claude-Code-Session-Id": "sess-1",
		}); err != nil {
			t.Fatal(err)
		}
		waitForEvents(t, bareEvents, 1)
		bare := bareEvents.routes()[0]
		if bare.SessionID == nil || *bare.SessionID != "sess-1" {
			t.Errorf("session id = %v", bare.SessionID)
		}
		if bare.AgentID != nil || bare.ParentAgentID != nil {
			t.Errorf("agent ids = %v %v", bare.AgentID, bare.ParentAgentID)
		}
		// No other header ever reaches the spool.
		if text := string(mustJSON(t, bareEvents.all())); strings.Contains(text, "authorization") {
			t.Error("the spool carries a header value")
		}
	})

	t.Run("records a 502 for an unreachable upstream, and no usage when the answer carries none", func(t *testing.T) {
		deadPort := reservePort(t)
		dead := mustURL(t, fmt.Sprintf("http://127.0.0.1:%d", deadPort))
		events := &eventLog{}
		port := reservePort(t)
		server := CreateRouter(RouterOptions{
			Provider:    routerProvider,
			Port:        port,
			Anthropic:   dead,
			ProviderURL: dead,
			Key:         func(context.Context) (string, error) { return "k", nil },
			Log:         func(string) {},
			Events:      events.record,
		})
		serveRouter(t, server, port)
		got, err := postAnswer(port, "claude-sonnet-5-5", nil)
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 502 {
			t.Fatalf("status = %d", got.status)
		}
		waitForEvents(t, events, 1)
		route := events.routes()[0]
		if route.Event != domain.EventRoute || route.Route != "anthropic" || route.Status != 502 {
			t.Errorf("event = %+v", route)
		}
		if route.Usage != nil {
			t.Errorf("usage = %v", *route.Usage)
		}
	})
}

// waitForEvents waits until the collector holds count events, then returns.
func waitForEvents(t *testing.T, events *eventLog, count int) {
	t.Helper()
	if !until(func() bool { return len(events.all()) >= count }) {
		t.Fatalf("events = %+v", events.all())
	}
}

// mustJSON marshals or fails the test.
func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// answeringTarget names which of the rig's two sides answers with the fixed answer.
type answeringTarget int

const (
	answeringTargetProvider answeringTarget = iota
	answeringTargetAnthropic
)

// fixedUpstream answers every request with the status and body it is set to.
func fixedUpstream(t *testing.T, status int, contentType, body string, seen *seenList) *url.URL {
	t.Helper()
	port := serve(t, func(w http.ResponseWriter, req *http.Request) {
		read, err := ReadBody(req, BodyLimitBytes)
		if err != nil {
			return
		}
		res := NewResponse(w)
		seen.record(pathOf(req), req.Header, string(read))
		res.Header().Set("Content-Type", contentType)
		res.WriteHeader(status)
		res.End([]byte(body))
	}, nil)
	return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d", port))
}

// answeringRig builds a rig where the provider (or Anthropic) side answers every request with one
// fixed answer, recording its route events and its log lines.
func answeringRig(t *testing.T, status int, body string, target answeringTarget, contentType string) (int, *eventLog, *lineLog) {
	t.Helper()
	events := &eventLog{}
	logs := &lineLog{}
	fixed := fixedUpstream(t, status, contentType, body, &seenList{})
	anthropic := fixed
	providerURL := fixed
	if target == answeringTargetAnthropic {
		anthropic = fixed
		providerURL = recordingUpstream(t, "provider", "/api/anthropic", &seenList{})
	} else if target == answeringTargetProvider {
		anthropic = recordingUpstream(t, "anthropic", "", &seenList{})
		providerURL = fixed
	}
	port := reservePort(t)
	server := CreateRouter(RouterOptions{
		Provider:    routerProvider,
		Port:        port,
		Anthropic:   anthropic,
		ProviderURL: providerURL,
		Key:         func(context.Context) (string, error) { return "provider-secret", nil },
		Log:         logs.add,
		Events:      events.record,
	})
	serveRouter(t, server, port)
	return port, events, logs
}

func TestWhyAProviderRequestFailed(t *testing.T) {
	t.Parallel()
	token := "sk-zai-9f2c88d4a1b34e6f8d7c5b3a2e1f0d9c8b7a6f5e"

	t.Run("records a Z.ai-shaped 400's reason on the route event and the log line, credentials redacted", func(t *testing.T) {
		body := `{"error":{"code":"1210","message":"API key not valid: ` + token + `\n regenerate  it in the dashboard"}}`
		port, events, logs := answeringRig(t, 400, body, answeringTargetProvider, "application/json")
		got, err := postAnswer(port, "glm-5.3", nil)
		if err != nil {
			t.Fatal(err)
		}
		// Not a refusal, and the key is not quoted: the answer goes through exactly as it came.
		if got.status != 400 || got.body != body {
			t.Fatalf("answer = %d %q", got.status, got.body)
		}
		waitForEvents(t, events, 1)
		route := events.routes()[0]
		if route.Route != "provider" || route.Status != 400 {
			t.Errorf("event = %+v", route)
		}
		if route.Error == nil || *route.Error != "1210: API key not valid: … regenerate it in the dashboard" {
			t.Errorf("error = %v", route.Error)
		}
		lines := logs.list()
		want := regexp.MustCompile(`^POST /v1/messages model=glm-5\.3 → provider 400 \(1210: API key not valid: … regenerate it in the dashboard\)$`)
		if len(lines) != 1 || !want.MatchString(lines[0]) {
			t.Errorf("logs = %v", lines)
		}
		// Neither the spool nor the log ever carries the token.
		if text := string(mustJSON(t, events.all())); strings.Contains(text, token) {
			t.Error("the spool carries the token")
		}
		if strings.Contains(strings.Join(lines, ","), token) {
			t.Error("a log line carries the token")
		}
	})

	t.Run("records nothing new for a claude-* 400: the event carries no error and the log line stays plain", func(t *testing.T) {
		body := `{"error":{"type":"invalid_request_error","message":"messages: field required near ` + token + `"}}`
		port, events, logs := answeringRig(t, 400, body, answeringTargetAnthropic, "application/json")
		got, err := postAnswer(port, "claude-opus-5-5", nil)
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 400 || got.body != body {
			t.Fatalf("answer = %d %q", got.status, got.body)
		}
		waitForEvents(t, events, 1)
		route := events.routes()[0]
		if route.Route != "anthropic" || route.Status != 400 || route.Error != nil {
			t.Errorf("event = %+v", route)
		}
		lines := logs.list()
		if len(lines) != 1 || !regexp.MustCompile(`→ anthropic 400$`).MatchString(lines[0]) {
			t.Errorf("logs = %v", lines)
		}
	})

	t.Run("leaves a 200 stream untouched byte for byte, with no error on its event or its log line", func(t *testing.T) {
		payload := `data: {"type":"message_start"}` + "\n\n" + `data: {"type":"message_delta"}` + "\n\n"
		port, events, logs := answeringRig(t, 200, payload, answeringTargetProvider, "text/event-stream")
		got, err := postAnswer(port, "glm-5.3", nil)
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 200 || got.body != payload {
			t.Fatalf("answer = %d %q", got.status, got.body)
		}
		waitForEvents(t, events, 1)
		route := events.routes()[0]
		if route.Route != "provider" || route.Status != 200 || route.Error != nil {
			t.Errorf("event = %+v", route)
		}
		lines := logs.list()
		if len(lines) != 1 || !regexp.MustCompile(`→ provider 200$`).MatchString(lines[0]) {
			t.Errorf("logs = %v", lines)
		}
	})
}

// promptStream is the stream a Z.ai-shaped upstream sends: the prompt only in message_start, the
// real numbers in message_delta.
func promptStream(start string) string {
	return `data: {"type":"message_start","message":{"id":"msg_1","usage":` + start + `}}` + "\n\n" +
		`data: {"type":"content_block_delta","delta":{"text":"hi"}}` + "\n\n" +
		`data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":153,"output_tokens":30,"cache_read_input_tokens":0}}` + "\n\n"
}

// sseUpstream answers every request with exactly these bytes, optionally split mid-first-line.
func sseUpstream(t *testing.T, payload string, seen *seenList, splitAt int) *url.URL {
	t.Helper()
	port := serve(t, func(w http.ResponseWriter, req *http.Request) {
		body, err := ReadBody(req, BodyLimitBytes)
		if err != nil {
			return
		}
		res := NewResponse(w)
		seen.record(pathOf(req), req.Header, string(body))
		res.Header().Set("Content-Type", "text/event-stream")
		res.WriteHeader(200)
		if splitAt < 0 {
			res.End([]byte(payload))
			return
		}
		res.Write([]byte(payload[:splitAt]))
		time.Sleep(5 * time.Millisecond)
		res.End([]byte(payload[splitAt:]))
	}, nil)
	return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d", port))
}

// promptRig builds a rig where both upstreams answer every request with exactly payload,
// recording route events.
func promptRig(t *testing.T, payload string, splitAt int) (int, *eventLog) {
	t.Helper()
	events := &eventLog{}
	anthropic := sseUpstream(t, payload, &seenList{}, -1)
	providerURL := sseUpstream(t, payload, &seenList{}, splitAt)
	port := reservePort(t)
	server := CreateRouter(RouterOptions{
		Provider:    routerProvider,
		Port:        port,
		Anthropic:   anthropic,
		ProviderURL: providerURL,
		Key:         func(context.Context) (string, error) { return "k", nil },
		Log:         func(string) {},
		Events:      events.record,
	})
	serveRouter(t, server, port)
	return port, events
}

// firstEvent parses the first `data:` line of an SSE answer.
func firstEvent(t *testing.T, text string) map[string]any {
	t.Helper()
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "data:") {
			var event map[string]any
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data:")), &event); err != nil {
				t.Fatal(err)
			}
			return event
		}
	}
	t.Fatalf("no data line in %q", text)
	return nil
}

func TestPromptUsage(t *testing.T) {
	t.Parallel()
	t.Run("rewrites a provider stream's zero message_start usage to the conversation's estimated prompt", func(t *testing.T) {
		payload := promptStream(`{"input_tokens":0,"output_tokens":0}`)
		// The message_start's JSON straddles two chunks: the rewriter holds until the line is whole.
		splitAt := strings.Index(payload, "input_tokens")
		port, _ := promptRig(t, payload, splitAt)
		body := `{"model":"glm-5.3","system":"you are a prompt-usage fixture","messages":[{"role":"user","content":"first turn"}]}`
		got, err := postRawBody(port, "/v1/messages", body, map[string]string{
			"Content-Type": "application/json", "Authorization": "Bearer anthropic-oauth",
		})
		if err != nil {
			t.Fatal(err)
		}
		usage := firstEvent(t, got.body)["message"].(map[string]any)["usage"].(map[string]any)
		if input := usage["input_tokens"]; input != float64(math.Round(float64(len(body))/4)) {
			t.Errorf("input_tokens = %v", input)
		}
		if usage["cache_read_input_tokens"] != float64(0) || usage["cache_creation_input_tokens"] != float64(0) {
			t.Errorf("cache fields = %v", usage)
		}
		// The later events stay the provider's own bytes: the real numbers still close the stream.
		delta := ""
		for _, line := range strings.Split(got.body, "\n") {
			if strings.Contains(line, "message_delta") {
				delta = line
			}
		}
		if delta != `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":153,"output_tokens":30,"cache_read_input_tokens":0}}` {
			t.Errorf("delta line = %q", delta)
		}
	})

	t.Run("estimates the next turn of a conversation from what its last turn really cost", func(t *testing.T) {
		port, events := promptRig(t, promptStream(`{"input_tokens":0,"output_tokens":0}`), -1)
		first := `{"model":"glm-5.3","system":"you are a prompt-usage fixture two","messages":[{"role":"user","content":"first turn"}]}`
		if _, err := postRawBody(port, "/v1/messages", first, map[string]string{
			"Content-Type": "application/json", "Authorization": "Bearer anthropic-oauth",
		}); err != nil {
			t.Fatal(err)
		}
		followUp := `{"model":"glm-5.3","system":"you are a prompt-usage fixture two","messages":[` +
			`{"role":"user","content":"first turn"},{"role":"assistant","content":"done"}]}`
		got, err := postRawBody(port, "/v1/messages", followUp, map[string]string{
			"Content-Type": "application/json", "Authorization": "Bearer anthropic-oauth",
		})
		if err != nil {
			t.Fatal(err)
		}
		// The first turn really cost 153 prompt tokens (its final message_delta), and the body grew
		// by its tail.
		usage := firstEvent(t, got.body)["message"].(map[string]any)["usage"].(map[string]any)
		want := math.Round(153 + float64(len(followUp)-len(first))/4)
		if usage["input_tokens"] != want {
			t.Errorf("input_tokens = %v, want %v", usage["input_tokens"], want)
		}
		if usage["cache_read_input_tokens"] != float64(0) {
			t.Errorf("cache_read = %v", usage["cache_read_input_tokens"])
		}
		waitForEvents(t, events, 2)
		// Usage tracking saw the raw stream, so the route events keep the provider's exact numbers.
		last := events.routes()[len(events.routes())-1]
		wantUsage := domain.RouteUsage{"input_tokens": float64(153), "output_tokens": float64(30), "cache_read_input_tokens": float64(0)}
		if last.Route != "provider" || last.Usage == nil || !reflect.DeepEqual(*last.Usage, wantUsage) {
			t.Errorf("event = %+v", last)
		}
	})

	t.Run("leaves a claude-* stream byte for byte as the upstream sent it", func(t *testing.T) {
		start := `{"input_tokens":0,"output_tokens":0}`
		payload := promptStream(start)
		port, events := promptRig(t, payload, -1)
		got, err := postRawBody(port, "/v1/messages", `{"model":"claude-sonnet-5-5","messages":[]}`, map[string]string{
			"Content-Type": "application/json", "Authorization": "Bearer anthropic-oauth",
		})
		if err != nil {
			t.Fatal(err)
		}
		if got.body != payload {
			t.Errorf("body = %q", got.body)
		}
		waitForEvents(t, events, 1)
		if route := events.routes()[0]; route.Route != "anthropic" {
			t.Errorf("route = %q", route.Route)
		}
	})

	t.Run("leaves a message_start that already carries a real prompt size exactly as it came", func(t *testing.T) {
		start := `{"input_tokens":152000,"cache_read_input_tokens":9000,"output_tokens":1}`
		payload := promptStream(start)
		port, _ := promptRig(t, payload, -1)
		got, err := postRawBody(port, "/v1/messages", `{"model":"glm-5.3","messages":[]}`, map[string]string{
			"Content-Type": "application/json", "Authorization": "Bearer anthropic-oauth",
		})
		if err != nil {
			t.Fatal(err)
		}
		if got.body != payload {
			t.Errorf("body = %q", got.body)
		}
	})
}

func TestWorkerHardening(t *testing.T) {
	t.Parallel()
	// bare builds a router on port 0 (any Host), sharing one upstream for both routes.
	bare := func(t *testing.T, options RouterOptions) (int, *seenList, *http.Server) {
		t.Helper()
		anthropicSeen := &seenList{}
		anthropic := recordingUpstream(t, "anthropic", "", anthropicSeen)
		base := RouterOptions{
			Provider:    routerProvider,
			Port:        0,
			Anthropic:   anthropic,
			ProviderURL: anthropic,
			Key:         func(context.Context) (string, error) { return "k", nil },
			Log:         func(string) {},
		}
		if options.Key != nil {
			base.Key = options.Key
		}
		base.KeyTimeoutMs = options.KeyTimeoutMs
		base.BodyLimit = options.BodyLimit
		base.Token = options.Token
		base.OnUpstream = options.OnUpstream
		server := CreateRouter(base)
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		go func() { _ = server.Serve(listener) }()
		t.Cleanup(func() { _ = server.Close() })
		return listener.Addr().(*net.TCPAddr).Port, anthropicSeen, server
	}
	postBare := func(t *testing.T, port int, body, path string, headers map[string]string) answer {
		t.Helper()
		if path == "" {
			path = "/v1/messages"
		}
		got, err := postRawBody(port, path, body, headers)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}

	t.Run("answers a provider request 503 when the key lookup hangs, and claude-* never waits for it", func(t *testing.T) {
		// a claude-* request that waited for the key would take the whole timeout; one second
		// keeps that apart from a plain request on a loaded runner
		port, _, _ := bare(t, RouterOptions{
			Key:          func(ctx context.Context) (string, error) { <-ctx.Done(); return "", ctx.Err() },
			KeyTimeoutMs: 1000,
		})
		started := time.Now()
		if got := postBare(t, port, `{"model":"claude-x"}`, "", nil); got.status != 200 {
			t.Fatalf("claude status = %d", got.status)
		}
		if elapsed := time.Since(started); elapsed >= time.Second {
			t.Errorf("claude-* waited %v for the key lookup", elapsed)
		}
		glm := postBare(t, port, `{"model":"glm-5.3"}`, "", nil)
		if glm.status != 503 {
			t.Fatalf("glm status = %d, want 503", glm.status)
		}
		var body struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(glm.body), &body); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(body.Error.Message, "timed out") {
			t.Errorf("message = %q", body.Error.Message)
		}
	})

	t.Run("treats a key lookup that throws as no key", func(t *testing.T) {
		port, _, _ := bare(t, RouterOptions{
			Key: func(context.Context) (string, error) { return "", fmt.Errorf("keychain locked") },
		})
		glm := postBare(t, port, `{"model":"glm-5.3"}`, "", nil)
		if glm.status != 400 {
			t.Fatalf("status = %d, want 400", glm.status)
		}
		var body struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(glm.body), &body); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(body.Error.Message, "run /zai:setup") {
			t.Errorf("message = %q", body.Error.Message)
		}
	})

	t.Run("refuses a body over the limit with an Anthropic-shaped 413, and a path that would change the host", func(t *testing.T) {
		port, anthropicSeen, _ := bare(t, RouterOptions{BodyLimit: 16})
		big := postBare(t, port, `{"model":"claude-x","pad":"`+strings.Repeat("x", 64)+`"}`, "", nil)
		if big.status != 413 {
			t.Fatalf("status = %d, want 413", big.status)
		}
		if got := postBare(t, port, `{"model":"claude-x"}`, "//evil.example/x", nil); got.status != 400 {
			t.Fatalf("status = %d, want 400", got.status)
		}
		if anthropicSeen.len() != 0 {
			t.Error("a refused request reached the upstream")
		}
	})

	t.Run("tells the front (when it asked) just before a request goes upstream, and drops the front's request id", func(t *testing.T) {
		var ackedMu sync.Mutex
		var acked []string
		port, anthropicSeen, _ := bare(t, RouterOptions{
			OnUpstream: func(req *http.Request) {
				ackedMu.Lock()
				defer ackedMu.Unlock()
				acked = append(acked, req.Header.Get(RequestID))
			},
		})
		got, err := postRawBody(port, "/v1/messages", `{"model":"claude-x"}`, map[string]string{RequestID: "r1"})
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 200 {
			t.Fatalf("status = %d", got.status)
		}
		ackedMu.Lock()
		defer ackedMu.Unlock()
		if !reflect.DeepEqual(acked, []string{"r1"}) {
			t.Errorf("acked = %v", acked)
		}
		if seen := anthropicSeen.list(); len(seen) != 1 || seen[0].headers.Get(RequestID) != "" {
			t.Errorf("the upstream saw the request id: %v", seen)
		}
	})

	t.Run("answers its health with its name, so nothing else's 200 passes for it", func(t *testing.T) {
		port, _, _ := bare(t, RouterOptions{})
		health, err := getBody(port, routerProvider.Router.HealthPath)
		if err != nil {
			t.Fatal(err)
		}
		if health.body != `{"ok":true,"name":"zai","provider":"Z.ai GLM"}` {
			t.Errorf("health = %q", health.body)
		}
	})

	t.Run("refuses the data path without the front's token, and strips the token before anything goes upstream", func(t *testing.T) {
		port, anthropicSeen, _ := bare(t, RouterOptions{Token: "hop-secret"})
		refused := postBare(t, port, `{"model":"glm-5.3"}`, "", nil)
		if refused.status != 403 {
			t.Fatalf("status = %d, want 403", refused.status)
		}
		if refused.body != `{"type":"error","error":{"type":"permission_error","message":"zai router: data path refused"}}` {
			t.Errorf("body = %s", refused.body)
		}
		wrong := postBare(t, port, `{"model":"glm-5.3"}`, "", map[string]string{TokenHeader: "nope"})
		if wrong.status != 403 {
			t.Fatalf("status = %d, want 403", wrong.status)
		}
		if anthropicSeen.len() != 0 {
			t.Error("a refused request reached the upstream")
		}
		// Health stays open, and a request that carries the token is forwarded — the token itself
		// never is.
		if health, err := getBody(port, routerProvider.Router.HealthPath); err != nil || health.status != 200 {
			t.Errorf("health = %v %v", health.status, err)
		}
		allowed := postBare(t, port, `{"model":"claude-x"}`, "", map[string]string{TokenHeader: "hop-secret"})
		if allowed.status != 200 {
			t.Fatalf("status = %d", allowed.status)
		}
		if seen := anthropicSeen.list(); len(seen) != 1 || seen[0].headers.Get(TokenHeader) != "" {
			t.Errorf("the upstream saw the token: %v", seen)
		}
	})

	t.Run("does not forward a request whose client left while the key was being read", func(t *testing.T) {
		port, anthropicSeen, _ := bare(t, RouterOptions{
			Key: func(ctx context.Context) (string, error) {
				select {
				case <-time.After(200 * time.Millisecond):
					return "k", nil
				case <-ctx.Done():
					return "", ctx.Err()
				}
			},
		})
		socket, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Fatal(err)
		}
		body := `{"model":"glm-5.3"}`
		request := "POST /v1/messages HTTP/1.1\r\nhost: 127.0.0.1:" + strconv.Itoa(port) +
			"\r\ncontent-length: " + strconv.Itoa(len(body)) + "\r\n\r\n" + body
		if _, err := socket.Write([]byte(request)); err != nil {
			t.Fatal(err)
		}
		time.Sleep(50 * time.Millisecond)
		_ = socket.Close()
		// The key arrives long after the client left: nothing goes upstream for the dead request.
		time.Sleep(250 * time.Millisecond)
		if anthropicSeen.len() != 0 {
			t.Error("a dead client's request went upstream")
		}
	})
}

// portOfURL64 is a URL port as the peer registry's int64.
func portOfURL64(port string) int64 {
	parsed, err := strconv.ParseInt(port, 10, 64)
	if err != nil {
		panic(err)
	}
	return parsed
}

// TestRouterInternals covers the ordered-JSON value and the small helpers the
// through-the-router cases reach only partly, tested here directly.
func TestRouterInternals(t *testing.T) {
	t.Parallel()
	roundTrip := func(text string) string {
		t.Helper()
		node := parseBodyNode([]byte(text))
		if node == nil {
			t.Fatalf("parseBodyNode(%q) = nil", text)
		}
		return marshalNode(node)
	}

	t.Run("round-trips a body's own bytes: scalars, escapes and order kept", func(t *testing.T) {
		for _, text := range []string{
			`{}`,
			`{"a":null,"b":true,"c":false,"d":1.5,"e":[null,true,1,"x"]}`,
			// JSON.stringify escapes only ", \ and the C0 controls; <, >, & stay raw, where Go's
			// encoder would escape them.
			`{"s":"a\"b\\c<d>&"}`,
			`{"z":1,"a":2,"m":{"deep":[[1],{"k":"v"}]}}`,
		} {
			if got := roundTrip(text); got != text {
				t.Errorf("round-trip = %q, want %q", got, text)
			}
		}
	})

	t.Run("parses the way JSON.parse does: duplicates overwrite in place, garbage is nothing", func(t *testing.T) {
		if got := roundTrip(`{"a":1,"a":2}`); got != `{"a":2}` {
			t.Errorf("duplicate keys: %q", got)
		}
		for _, text := range []string{"not json", `{} trailing`, ``} {
			if node := parseBodyNode([]byte(text)); node != nil {
				t.Errorf("parseBodyNode(%q) = %+v", text, node)
			}
		}
	})

	t.Run("modelIn reads a string model and nothing else", func(t *testing.T) {
		if got := modelIn(parseBodyNode([]byte(`{"model":"glm-5.3"}`))); got != "glm-5.3" {
			t.Errorf("modelIn = %q", got)
		}
		if got := modelIn(parseBodyNode([]byte(`{"model":5}`))); got != "" {
			t.Errorf("modelIn(5) = %q", got)
		}
		if got := modelIn(parseBodyNode([]byte(`[1]`))); got != "" {
			t.Errorf("modelIn(array) = %q", got)
		}
		if got := modelIn(nil); got != "" {
			t.Errorf("modelIn(nil) = %q", got)
		}
	})

	t.Run("set keeps a key's position and del is a no-op on what is not there", func(t *testing.T) {
		node := parseBodyNode([]byte(`{"model":"a","b":1}`))
		node.set("model", newTextNode("z"))
		node.set("added", newTextNode("n"))
		node.del("missing")
		if got := marshalNode(node); got != `{"model":"z","b":1,"added":"n"}` {
			t.Errorf("edited = %q", got)
		}
	})

	t.Run("the capture memo drops the oldest past its cap", func(t *testing.T) {
		memo := newCaptureMemo()
		for i := 0; i < captureMemoMax; i++ {
			if !memo.first(fmt.Sprintf("hash-%d", i)) {
				t.Fatalf("hash-%d was not first", i)
			}
		}
		if !memo.first("newest") {
			t.Fatal("a fresh hash must be first")
		}
		// The oldest dropped, so it reads as new again.
		if !memo.first("hash-0") {
			t.Fatal("the oldest hash must have dropped")
		}
	})

	t.Run("providerBody passes an unparsable body and a stripped model through untouched", func(t *testing.T) {
		stripping := routerProvider
		stripping.Strip = []string{"model"}
		w := &routerWorker{opts: RouterOptions{Provider: stripping}, provider: stripping}
		req, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:1/v1/messages", nil)
		if err != nil {
			t.Fatal(err)
		}
		original := []byte(`{"model":"glm-5.3","messages":[]}`)
		body, model := providerBody(w, original, parseBodyNode(original), "glm-5.3", req)
		if model != "glm-5.3" {
			t.Errorf("a stripped model must not rename the route: %q", model)
		}
		if string(body) == string(original) {
			t.Error("the stripped body must be re-serialised")
		}
		notJSON := []byte("not json")
		if body, model = providerBody(w, notJSON, parseBodyNode(notJSON), "glm-5.3", req); string(body) != "not json" || model != "glm-5.3" {
			t.Errorf("a non-JSON body = %q, %q", body, model)
		}
	})

	t.Run("requestPath falls back to the URL when the server saw no raw URI", func(t *testing.T) {
		req, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:1/v1/messages?x=1", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.RequestURI = ""
		if got := requestPath(req); got != "/v1/messages?x=1" {
			t.Errorf("requestPath = %q", got)
		}
	})

	t.Run("the rewriter gives up past its limit and passes a failing read through", func(t *testing.T) {
		estimator := NewPromptEstimator()
		hint := PromptHint{Key: "k", BodyChars: 4}
		// One line with no message_start, longer than the limit: everything goes out as it came.
		held := bytes.Repeat([]byte("x"), promptRewriteLimitBytes+1)
		head := rewriteHead(nil, held, hint, estimator)
		if !head.decided {
			t.Fatal("an over-limit hold must give up")
		}
		failing := &failingReader{err: fmt.Errorf("cut")}
		rewriter := &promptRewriter{source: failing, prompt: hint, estimator: estimator}
		if _, err := rewriter.Read(make([]byte, 8)); err == nil {
			t.Error("a failing source must fail the read")
		}
	})

	t.Run("the usage tap closes the body it wraps", func(t *testing.T) {
		closer := &countingCloser{}
		tap := &bodyTap{source: closer, push: func([]byte) {}}
		if err := tap.Close(); err != nil {
			t.Fatal(err)
		}
		if closer.closed != 1 {
			t.Errorf("closed = %d", closer.closed)
		}
	})

	t.Run("a missing key function reads as no key", func(t *testing.T) {
		_, w := createRouter(RouterOptions{}, nil)
		if _, outcome := keyWithin(context.Background(), w); outcome != keyNone {
			t.Errorf("outcome = %v", outcome)
		}
	})

	t.Run("a message_start without an input_tokens counter is left as it came", func(t *testing.T) {
		payload := promptStream(`{"output_tokens":0}`)
		port, _ := promptRig(t, payload, -1)
		got, err := postRawBody(port, "/v1/messages", `{"model":"glm-5.3","system":"s","messages":[]}`, map[string]string{
			"Content-Type": "application/json", "Authorization": "Bearer anthropic-oauth",
		})
		if err != nil {
			t.Fatal(err)
		}
		if got.body != payload {
			t.Errorf("body = %q", got.body)
		}
	})

	t.Run("node lookups on what is not an object read as nothing", func(t *testing.T) {
		var missing *jsonNode
		if missing.has("k") || missing.get("k") != nil {
			t.Error("a nil node carries nothing")
		}
		if array := parseBodyNode([]byte(`[1]`)); array.has("k") || array.get("k") != nil {
			t.Error("an array carries no keys")
		}
		node := &jsonNode{kind: jsonObject}
		node.set("k", newTextNode("v"))
		if !node.has("k") || marshalNode(node) != `{"k":"v"}` {
			t.Errorf("a zero-value object takes a set: %q", marshalNode(node))
		}
		var nilNode *jsonNode
		nilNode.del("k")
	})

	t.Run("a body cut mid-parse is no body at all", func(t *testing.T) {
		for _, text := range []string{`{"a":`, `["a",`} {
			if node := parseBodyNode([]byte(text)); node != nil {
				t.Errorf("parseBodyNode(%q) = %+v", text, node)
			}
		}
	})

	t.Run("escapes the controls JSON.stringify escapes, and only those", func(t *testing.T) {
		source := "{\"s\":\"a\\b\\f\\n\\r\\t\\u0001\\u001f<>&\"}"
		if got := roundTrip(source); got != source {
			t.Errorf("round-trip = %q", got)
		}
	})

	t.Run("no allow-listed headers means no headers field", func(t *testing.T) {
		if got := CapturedHeaders(http.Header{"X-Other": {"v"}}); got != nil {
			t.Errorf("CapturedHeaders = %v", got)
		}
	})

	t.Run("the hash canonicalises every scalar shape", func(t *testing.T) {
		body := `{"system":{"a":null,"b":true,"c":false,"d":1.5,"e":[null,false,2,"x"]},"tools":[]}`
		if _, ok := PromptHashOf(parseBodyNode([]byte(body))); !ok {
			t.Fatal("a body with system and tools must hash")
		}
	})

	t.Run("an error object that says nothing falls back to its text", func(t *testing.T) {
		if got, ok := UpstreamErrorReason([]byte(`{"error":{}}`), ""); !ok || got != `{"error":{}}` {
			t.Errorf("reason = %q %v", got, ok)
		}
		if got, ok := UpstreamErrorReason([]byte(`{"msg":"conversation gone"}`), ""); !ok || got != "conversation gone" {
			t.Errorf("a message alone = %q %v", got, ok)
		}
	})

	t.Run("a stream that ends before any message_start goes out as it came", func(t *testing.T) {
		// The last line is partial (no trailing newline): it is held until the stream ends, then
		// flushed as it came.
		payload := "data: {\"type\":\"content_block_delta\"}\n\n: keepalive"
		port, _ := promptRig(t, payload, -1)
		got, err := postRawBody(port, "/v1/messages", `{"model":"glm-5.3","system":"s","messages":[]}`, map[string]string{
			"Content-Type": "application/json", "Authorization": "Bearer anthropic-oauth",
		})
		if err != nil {
			t.Fatal(err)
		}
		if got.body != payload {
			t.Errorf("body = %q", got.body)
		}
	})

	t.Run("the rewriter hands its bytes out one at a time", func(t *testing.T) {
		payload := promptStream(`{"input_tokens":0,"output_tokens":0}`)
		estimator := NewPromptEstimator()
		hint := PromptHint{Key: "k", BodyChars: 8}
		rewriter := &promptRewriter{source: io.MultiReader(
			strings.NewReader(payload[:20]), strings.NewReader(payload[20:])),
			prompt: hint, estimator: estimator}
		var out []byte
		one := make([]byte, 1)
		for {
			n, err := rewriter.Read(one)
			out = append(out, one[:n]...)
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
		}
		if len(out) == 0 {
			t.Fatal("the rewriter gave nothing out")
		}
		if !strings.Contains(string(out), `"input_tokens":2`) {
			t.Errorf("the rewritten start must carry the estimate: %q", out)
		}
	})

	t.Run("a request path that does not parse as an upstream URL is answered, never dropped", func(t *testing.T) {
		// Go's server answers a malformed escape itself, so the branch is driven directly.
		req, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:1/x", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.RequestURI = "/%zz"
		recorder := httptest.NewRecorder()
		w := &routerWorker{opts: RouterOptions{Provider: routerProvider}, provider: routerProvider}
		w.dispatch(req, NewResponse(recorder), []byte(`{}`), "claude-x", "anthropic",
			mustURL(t, "http://127.0.0.1:1"), nil, nil, "", nil)
		if recorder.Code != 502 {
			t.Errorf("status = %d, want 502", recorder.Code)
		}
	})
}

// failingReader always fails.
type failingReader struct {
	err error
}

func (r *failingReader) Read([]byte) (int, error) { return 0, r.err }

// countingCloser counts its closes.
type countingCloser struct {
	closed int
}

func (c *countingCloser) Read([]byte) (int, error) { return 0, io.EOF }

func (c *countingCloser) Close() error {
	c.closed++
	return nil
}
