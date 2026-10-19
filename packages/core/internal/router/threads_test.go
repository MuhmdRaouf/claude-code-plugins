// The message-threads beta: a provider-bound request carrying it is refused with the 400 Claude
// Code reads as "beta rejected", so it drops threading and resends the whole conversation;
// Claude and peer traffic pass untouched.
package router

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// postBetaBody posts one exact body to /v1/messages?beta=true, each given anthropic-beta value
// on its own header line, as a client repeating the header would.
func postBetaBody(t *testing.T, port int, body string, beta []string) answer {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/v1/messages?beta=true", port), strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	for _, value := range beta {
		request.Header.Add("Anthropic-Beta", value)
	}
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
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
	return answer{status: response.StatusCode, header: response.Header, body: string(text)}
}

func TestThreadsBeta(t *testing.T) {
	t.Parallel()
	request := func(values ...string) *http.Request {
		req, err := http.NewRequest(http.MethodPost, "http://127.0.0.1/v1/messages", nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, value := range values {
			req.Header.Add("Anthropic-Beta", value)
		}
		return req
	}

	t.Run("collects every message-threads token across header lines and commas, trimmed", func(t *testing.T) {
		t.Parallel()
		got := threadsBeta(request("claude-code-20250219,message-threads-2026-08-12", " prompt-2026-01-01, message-threads-2027-01-01 "))
		if len(got) != 2 || got[0] != "message-threads-2026-08-12" || got[1] != "message-threads-2027-01-01" {
			t.Errorf("tokens = %q", got)
		}
	})

	t.Run("is nil when no token starts with message-threads-", func(t *testing.T) {
		t.Parallel()
		if got := threadsBeta(request("claude-code-20250219,oauth-2025-04-20")); got != nil {
			t.Errorf("tokens = %q, want nil", got)
		}
		if got := threadsBeta(request()); got != nil {
			t.Errorf("tokens = %q, want nil", got)
		}
	})

	t.Run("matches the lowercase form and keeps the spelling the request carried", func(t *testing.T) {
		t.Parallel()
		got := threadsBeta(request("Message-Threads-2026-08-12"))
		if len(got) != 1 || got[0] != "Message-Threads-2026-08-12" {
			t.Errorf("tokens = %q", got)
		}
	})
}

func TestMessageThreadsRefusal(t *testing.T) {
	t.Parallel()
	threadsBody := `{"model":"glm-5.3","thread":{"type":"continue","id":"t1"},"messages":[{"role":"user","content":"hi"}]}`

	t.Run("refuses a provider request carrying the message-threads beta with the 400 Claude Code reads as beta rejected, before anything reaches the provider", func(t *testing.T) {
		t.Parallel()
		port, anthropicSeen, providerSeen, logs := newRouterRig(t, rigOptions{key: "k"})
		got := postBetaBody(t, port, threadsBody, []string{"claude-code-20250219,message-threads-2026-08-12"})
		if got.status != 400 {
			t.Fatalf("status = %d, want 400", got.status)
		}
		var body struct {
			Type  string `json:"type"`
			Error struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(got.body), &body); err != nil {
			t.Fatal(err)
		}
		if body.Type != "error" || body.Error.Type != "invalid_request_error" {
			t.Errorf("error shape = %q / %q", body.Type, body.Error.Type)
		}
		if !strings.Contains(body.Error.Message, "message-threads-2026-08-12") {
			t.Errorf("message %q does not name the beta value", body.Error.Message)
		}
		if !strings.Contains(body.Error.Message, "anthropic-beta") {
			t.Errorf("message %q does not name the header", body.Error.Message)
		}
		if providerSeen.len() != 0 {
			t.Error("the request reached the provider")
		}
		if anthropicSeen.len() != 0 {
			t.Error("the request reached Anthropic")
		}
		if !strings.Contains(logs.joined(), "→ refused: message threads") {
			t.Errorf("logs = %q", logs.joined())
		}
	})

	t.Run("decides on the header alone: a thread of another type is refused too", func(t *testing.T) {
		t.Parallel()
		port, _, providerSeen, _ := newRouterRig(t, rigOptions{key: "k"})
		got := postBetaBody(t, port, `{"model":"glm-5.3","thread":{"type":"create"},"messages":[]}`, []string{"claude-code-20250219,message-threads-2026-08-12"})
		if got.status != 400 {
			t.Fatalf("status = %d, want 400", got.status)
		}
		if providerSeen.len() != 0 {
			t.Error("the request reached the provider")
		}
	})

	t.Run("forwards a provider request whose beta header holds no message-threads token", func(t *testing.T) {
		t.Parallel()
		port, anthropicSeen, providerSeen, _ := newRouterRig(t, rigOptions{key: "k"})
		got, err := postAnswer(port, "glm-5.3", map[string]string{"Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20"})
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 200 {
			t.Fatalf("status = %d", got.status)
		}
		if anthropicSeen.len() != 0 {
			t.Error("the request reached Anthropic")
		}
		seen := providerSeen.list()
		if len(seen) != 1 {
			t.Fatalf("the provider saw %d requests", len(seen))
		}
		if gotHeader := seen[0].headers.Get("Anthropic-Beta"); gotHeader != "claude-code-20250219,oauth-2025-04-20" {
			t.Errorf("anthropic-beta = %q", gotHeader)
		}
	})

	t.Run("forwards a claude request that carries the message-threads beta to Anthropic unchanged", func(t *testing.T) {
		t.Parallel()
		port, anthropicSeen, providerSeen, _ := newRouterRig(t, rigOptions{key: "k"})
		got, err := postAnswer(port, "claude-opus-5-5", map[string]string{"Anthropic-Beta": "claude-code-20250219,message-threads-2026-08-12"})
		if err != nil {
			t.Fatal(err)
		}
		if got.status != 200 {
			t.Fatalf("status = %d", got.status)
		}
		if providerSeen.len() != 0 {
			t.Error("the request reached the provider")
		}
		seen := anthropicSeen.list()
		if len(seen) != 1 {
			t.Fatalf("Anthropic saw %d requests", len(seen))
		}
		if gotHeader := seen[0].headers.Get("Anthropic-Beta"); gotHeader != "claude-code-20250219,message-threads-2026-08-12" {
			t.Errorf("anthropic-beta = %q", gotHeader)
		}
	})

	t.Run("reads the token on the second anthropic-beta header line", func(t *testing.T) {
		t.Parallel()
		port, _, providerSeen, _ := newRouterRig(t, rigOptions{key: "k"})
		got := postBetaBody(t, port, threadsBody, []string{"claude-code-20250219", "message-threads-2027-01-01"})
		if got.status != 400 {
			t.Fatalf("status = %d, want 400", got.status)
		}
		var body struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(got.body), &body); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(body.Error.Message, "message-threads-2027-01-01") {
			t.Errorf("message = %q", body.Error.Message)
		}
		if providerSeen.len() != 0 {
			t.Error("the request reached the provider")
		}
	})

	t.Run("names every message-threads token the header carried, a future one included", func(t *testing.T) {
		t.Parallel()
		port, _, _, _ := newRouterRig(t, rigOptions{key: "k"})
		got := postBetaBody(t, port, threadsBody, []string{"message-threads-2026-08-12", "message-threads-2027-01-01"})
		if got.status != 400 {
			t.Fatalf("status = %d, want 400", got.status)
		}
		var body struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(got.body), &body); err != nil {
			t.Fatal(err)
		}
		want := "Unexpected value(s) `message-threads-2026-08-12`, `message-threads-2027-01-01` for the `anthropic-beta` header"
		if !strings.Contains(body.Error.Message, want) {
			t.Errorf("message = %q, want it to contain %q", body.Error.Message, want)
		}
	})

	t.Run("records the refusal on the route event as a 400 refused with its reason", func(t *testing.T) {
		t.Parallel()
		events := &eventLog{}
		port, _, _, _ := newRouterRig(t, rigOptions{key: "k", events: events})
		got := postBetaBody(t, port, threadsBody, []string{"claude-code-20250219,message-threads-2026-08-12"})
		if got.status != 400 {
			t.Fatalf("status = %d, want 400", got.status)
		}
		if !until(func() bool { return len(events.all()) == 1 }) {
			t.Fatalf("events = %v", events.all())
		}
		route := events.routes()[0]
		if route.Event != domain.EventRoute || route.Route != "refused" || route.Status != 400 {
			t.Errorf("event = %+v", route)
		}
		if route.Error == nil || *route.Error != "message threads beta" {
			t.Errorf("error = %v", route.Error)
		}
	})
}
