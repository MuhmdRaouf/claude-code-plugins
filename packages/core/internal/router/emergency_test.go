// The emergency passthrough in process: its cases and inputs; RunEmergency's own wiring gets its
// case here too, with the process exit injected.
package router

import (
	"bytes"
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
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// freeRouterPort is a loopback port nothing holds.
func freeRouterPort(t *testing.T) int {
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

// postBody posts one JSON body to the path and returns status and body.
func postBody(t *testing.T, base, path, body string, header map[string]string) (int, string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range header {
		request.Header.Set(name, value)
	}
	answer, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer answer.Body.Close()
	text, err := io.ReadAll(answer.Body)
	if err != nil {
		t.Fatal(err)
	}
	return answer.StatusCode, string(text)
}

func TestStartEmergency(t *testing.T) {
	t.Parallel()
	t.Run("answers its health, pipes Claude to Anthropic, refuses provider models, and hands over with the token", func(t *testing.T) {
		anthropicBytes := "anthropic bytes"
		anthropic := serveAnthropic(t, anthropicBytes)
		port := freeRouterPort(t)
		done := make(chan struct{}, 4)
		listener, err := StartEmergency(t.Context(), EmergencyOptions{
			Name:       "acme",
			Display:    "Acme Models",
			HealthPath: "/acme-router/health",
			Claim:      domain.ModelClaim{Prefixes: []string{"big-"}},
			Port:       port,
			Anthropic:  anthropic,
			Env:        ProxyEnv{},
			Token:      "secret",
			Done:       func() { done <- struct{}{} },
		})
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()
		base := fmt.Sprintf("http://127.0.0.1:%d", port)

		health, err := http.Get(base + "/acme-router/health")
		if err != nil {
			t.Fatal(err)
		}
		healthBody, _ := io.ReadAll(health.Body)
		health.Body.Close()
		if want := `{"ok":true,"mode":"emergency","name":"acme","provider":"Acme Models"}`; string(healthBody) != want {
			t.Fatalf("health = %s, want %s", healthBody, want)
		}

		if status, body := postBody(t, base, "/v1/messages", `{"model":"claude-x"}`, nil); status != 200 || body != anthropicBytes {
			t.Fatalf("a claude model: %d %q, want 200 %q", status, body, anthropicBytes)
		}
		status, body := postBody(t, base, "/v1/messages", `{"model":"big-1"}`, nil)
		if status != 503 || !strings.Contains(body, "in emergency passthrough") {
			t.Fatalf("a provider model: %d %q, want 503 naming the emergency passthrough", status, body)
		}

		// A request naming another host is refused before anything else (DNS rebinding).
		wrongHost, err := http.NewRequest(http.MethodGet, base+"/x", nil)
		if err != nil {
			t.Fatal(err)
		}
		wrongHost.Host = "evil"
		answer, err := http.DefaultTransport.RoundTrip(wrongHost)
		if err != nil {
			t.Fatal(err)
		}
		answer.Body.Close()
		if answer.StatusCode != 421 {
			t.Fatalf("a wrong Host answered %d, want 421", answer.StatusCode)
		}

		if status, _ := postBody(t, base, "/acme-router/health/handover", "", nil); status != 403 {
			t.Fatalf("a handover without the token answered %d, want 403", status)
		}
		status, body = postBody(t, base, "/acme-router/health/handover", "",
			map[string]string{TokenHeader: "secret"})
		if status != 200 || body != `{"ok":true}` {
			t.Fatalf("a handover with the token: %d %q, want 200 {\"ok\":true}", status, body)
		}
		// The drain finishes in milliseconds alone; 15 s only bounds a drain that never ends
		// under full-module load.
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Fatal("the handover never drained to done")
		}
	})

	t.Run("is refused by the emergency passthrough, and a foreign id goes to Anthropic", func(t *testing.T) {
		// The emergency case: the 503s, the foreign 200s, and every request is a fallback
		// Radar hears about.
		anthropic := serveAnthropic(t, "anthropic")
		port := freeRouterPort(t)
		var events []domain.RouterHealthEvent
		listener, err := StartEmergency(t.Context(), EmergencyOptions{
			Name:       "zai",
			Display:    "Z.ai GLM",
			HealthPath: "/zai-router/health",
			Claim:      domain.ModelClaim{Prefixes: []string{"glm-"}},
			Port:       port,
			Anthropic:  anthropic,
			Env:        ProxyEnv{},
			Token:      "t",
			Events: func(event domain.SpoolEvent) {
				if health, ok := event.(domain.RouterHealthEvent); ok {
					events = append(events, health)
				}
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()
		base := fmt.Sprintf("http://127.0.0.1:%d", port)

		if status, _ := postBody(t, base, "/v1/messages", `{"model":"glm-5.3"}`, nil); status != 503 {
			t.Fatalf("the provider model answered %d, want 503", status)
		}
		if status, body := postBody(t, base, "/v1/messages", `{"model":"claude-sonnet-5-5"}`, nil); status != 200 || body != "anthropic" {
			t.Fatalf("a foreign id: %d %q, want 200 anthropic", status, body)
		}
		want := []string{"glm-5.3", "claude-sonnet-5-5"}
		if len(events) != 2 {
			t.Fatalf("spool events = %+v, want one per request", events)
		}
		for i, event := range events {
			if event.Kind != domain.HealthEventKind || event.Plugin != "zai" ||
				event.Event != domain.HealthFallback || event.Reason != "emergency passthrough" ||
				event.Model == nil || *event.Model != want[i] {
				t.Fatalf("event %d = %+v, want a zai fallback for %s", i, event, want[i])
			}
		}
	})
}

func TestRunEmergency(t *testing.T) {
	t.Parallel()
	t.Run("serves from the environment's settings until a handover exits the process", func(t *testing.T) {
		anthropic := serveAnthropic(t, "anthropic")
		root := t.TempDir()
		if err := os.MkdirAll(filepath.Join(root, "router"), 0o700); err != nil {
			t.Fatal(err)
		}
		port := freeRouterPort(t)
		env := domain.EnvLookup{
			"CHAOS_STATE_DIR":            root,
			"CHAOS_ROUTER_PORT":          strconv.Itoa(port),
			"CHAOS_ROUTER_ANTHROPIC_URL": anthropic.String(),
			"CHAOS_ROUTER_TOKEN":         "secret",
			"RADAR_HOME":                 filepath.Join(root, "radar"),
		}
		exited := make(chan int, 1)
		served := make(chan error, 1)
		go func() {
			served <- RunEmergency(EmergencyProvider{
				Name:       "chaos",
				Display:    "Chaos Models",
				EnvPrefix:  "CHAOS",
				HealthPath: "/chaos-router/health",
				Port:       1,
				Claim:      domain.ModelClaim{Prefixes: []string{"chaos-"}},
			}, env, func(code int) { exited <- code })
		}()

		base := fmt.Sprintf("http://127.0.0.1:%d", port)
		awaitHTTP(t, base+"/chaos-router/health", `{"ok":true,"mode":"emergency","name":"chaos","provider":"Chaos Models"}`)

		if status, _ := postBody(t, base, "/v1/messages", `{"model":"claude-x"}`, nil); status != 200 {
			t.Fatalf("a claude model answered %d, want 200", status)
		}

		if status, _ := postBody(t, base, "/chaos-router/health/handover", "",
			map[string]string{TokenHeader: "secret"}); status != 200 {
			t.Fatalf("the handover answered %d, want 200", status)
		}
		// The same drain as above: done closes handed, which exits the process.
		select {
		case code := <-exited:
			if code != 0 {
				t.Fatalf("the process exit code = %d, want 0", code)
			}
		case <-time.After(15 * time.Second):
			t.Fatal("the handover never exited the process")
		}
		if err := <-served; err != nil {
			t.Fatalf("runEmergency: %v", err)
		}
		if _, err := os.Stat(filepath.Join(root, "router", "router.log")); err != nil {
			t.Fatalf("the router log was never written: %v", err)
		}
	})

	t.Run("takes the provider's port when the env names none", func(t *testing.T) {
		root := t.TempDir()
		if err := os.MkdirAll(filepath.Join(root, "router"), 0o700); err != nil {
			t.Fatal(err)
		}
		port := freeRouterPort(t)
		env := domain.EnvLookup{"CHAOS_STATE_DIR": root}
		exited := make(chan int, 1)
		served := make(chan error, 1)
		go func() {
			served <- RunEmergency(EmergencyProvider{
				Name:       "chaos",
				Display:    "Chaos Models",
				EnvPrefix:  "CHAOS",
				HealthPath: "/chaos-router/health",
				Port:       port,
				Claim:      domain.ModelClaim{},
			}, env, func(code int) { exited <- code })
		}()

		awaitHTTP(t, fmt.Sprintf("http://127.0.0.1:%d", port)+"/chaos-router/health", "")

		if status, _ := postBody(t, fmt.Sprintf("http://127.0.0.1:%d", port), "/chaos-router/health/handover", "",
			map[string]string{TokenHeader: ""}); status != 200 {
			t.Fatalf("the handover answered %d, want 200 (an empty token matches an unset one)", status)
		}
		if code := <-exited; code != 0 {
			t.Fatalf("the process exit code = %d, want 0", code)
		}
		if err := <-served; err != nil {
			t.Fatalf("runEmergency: %v", err)
		}
	})

	t.Run("a SIGTERM exits the process too", func(t *testing.T) {
		root := t.TempDir()
		if err := os.MkdirAll(filepath.Join(root, "router"), 0o700); err != nil {
			t.Fatal(err)
		}
		port := freeRouterPort(t)
		exited := make(chan int, 1)
		served := make(chan error, 1)
		go func() {
			served <- RunEmergency(EmergencyProvider{
				Name:       "chaos",
				Display:    "Chaos Models",
				EnvPrefix:  "CHAOS",
				HealthPath: "/chaos-router/health",
				Port:       port,
			}, domain.EnvLookup{"CHAOS_STATE_DIR": root}, func(code int) { exited <- code })
		}()

		awaitHTTP(t, fmt.Sprintf("http://127.0.0.1:%d", port)+"/chaos-router/health", "")
		// The handler is registered before the server starts, so the health answer means it is
		// ours; the test binary has no other SIGTERM disposition.
		terminateSelf(t)
		if code := <-exited; code != 0 {
			t.Fatalf("the process exit code = %d, want 0", code)
		}
		if err := <-served; err != nil {
			t.Fatalf("runEmergency: %v", err)
		}
	})

	t.Run("an Anthropic URL that does not parse fails the start", func(t *testing.T) {
		err := RunEmergency(EmergencyProvider{
			Name: "chaos", Display: "Chaos", EnvPrefix: "CHAOS", HealthPath: "/h",
		}, domain.EnvLookup{"CHAOS_STATE_DIR": t.TempDir(), "CHAOS_ROUTER_ANTHROPIC_URL": "http://[::1"}, nil)
		if err == nil {
			t.Fatal("runEmergency accepted an unparsable Anthropic URL")
		}
	})
}

// portFromEnv: `Number(env[name]) || fallback`.
func TestPortFromEnv(t *testing.T) {
	t.Parallel()
	for name, tc := range map[string]struct {
		env  domain.EnvLookup
		want int
	}{
		"unset":         {domain.EnvLookup{}, 18787},
		"empty":         {domain.EnvLookup{"P": ""}, 18787},
		"not a number":  {domain.EnvLookup{"P": "abc"}, 18787},
		"zero":          {domain.EnvLookup{"P": "0"}, 18787},
		"a real port":   {domain.EnvLookup{"P": "18799"}, 18799},
		"a padded port": {domain.EnvLookup{"P": " 18799 "}, 18799},
	} {
		if got := portFromEnv(tc.env, "P", 18787); got != tc.want {
			t.Fatalf("%s: portFromEnv = %d, want %d", name, got, tc.want)
		}
	}
}

// serveAnthropic is a fake Anthropic answering every request with body.
func serveAnthropic(t *testing.T, body string) *url.URL {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

// awaitHTTP polls a GET until it answers 200 (and the body matches when want is not empty).
func awaitHTTP(t *testing.T, rawURL, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		answer, err := http.Get(rawURL)
		if err == nil {
			body, _ := io.ReadAll(answer.Body)
			answer.Body.Close()
			if answer.StatusCode == 200 && (want == "" || string(body) == want) {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("GET %s never answered %q", rawURL, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A streamed answer through the emergency pipe: the bytes reach the client as the upstream sends
// them, not buffered to the end (the router's one streaming promise).
func TestStartEmergencyStreams(t *testing.T) {
	t.Parallel()
	upstream := make(chan struct{})
	anthropicServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		flusher := w.(http.Flusher)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("first "))
		flusher.Flush()
		<-upstream
		_, _ = w.Write([]byte("second"))
	}))
	defer anthropicServer.Close()
	anthropic, err := url.Parse(anthropicServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	port := freeRouterPort(t)
	listener, err := StartEmergency(t.Context(), EmergencyOptions{
		Name:       "acme",
		Display:    "Acme Models",
		HealthPath: "/acme-router/health",
		Port:       port,
		Anthropic:  anthropic,
		Env:        ProxyEnv{},
		Token:      "t",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	request, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d", port)+"/v1/messages",
		strings.NewReader(`{"model":"claude-x"}`))
	if err != nil {
		t.Fatal(err)
	}
	answer, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer answer.Body.Close()
	first := make([]byte, 6)
	if _, err := io.ReadFull(answer.Body, first); err != nil {
		t.Fatal(err)
	}
	if string(first) != "first " {
		t.Fatalf("the first bytes = %q, want %q", first, "first ")
	}
	close(upstream)
	rest, err := io.ReadAll(answer.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(rest, []byte("second")) {
		t.Fatalf("the rest = %q, want %q", rest, "second")
	}
}
