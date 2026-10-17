// The prompt capture: one spool event per distinct prompt a request carried — its `system` and
// `tools`, never a header, a key or a message.
package router

import (
	"compress/gzip"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// captureSeen is one request a capture upstream saw.
type captureSeen struct {
	headers http.Header
	body    string
}

// captureUpstream records what it got, answers with the headers it is told, and streams one event.
func captureUpstream(t *testing.T, seen *[]captureSeen, headers map[string]string) *url.URL {
	t.Helper()
	port := serve(t, func(w http.ResponseWriter, req *http.Request) {
		body, err := ReadBody(req, BodyLimitBytes)
		if err != nil {
			return
		}
		res := NewResponse(w)
		*seen = append(*seen, captureSeen{headers: req.Header, body: string(body)})
		res.Header().Set("Content-Type", "text/event-stream")
		for name, value := range headers {
			res.Header().Set(name, value)
		}
		res.WriteHeader(200)
		res.End([]byte(`data: {"type":"message_start"}` + "\n\n"))
	}, nil)
	return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d", port))
}

// captureRig builds a rig with one recording upstream on both routes, collecting its spool
// events.
func captureRig(t *testing.T, headers map[string]string) (int, *eventLog, *[]captureSeen) {
	t.Helper()
	events := &eventLog{}
	seen := &[]captureSeen{}
	target := captureUpstream(t, seen, headers)
	port := reservePort(t)
	server := CreateRouter(RouterOptions{
		Provider:    routerProvider,
		Port:        port,
		Anthropic:   target,
		ProviderURL: target,
		Key:         func(context.Context) (string, error) { return "k", nil },
		Log:         func(string) {},
		Events:      events.record,
	})
	serveRouter(t, server, port)
	return port, events, seen
}

// capturePost posts one body and answers its status.
func capturePost(t *testing.T, port int, body string) int {
	t.Helper()
	got, err := postRawBody(port, "/v1/messages", body, map[string]string{"Content-Type": "application/json"})
	if err != nil {
		t.Fatal(err)
	}
	return got.status
}

// settle waits for the capture events the router writes after the requests are on their way.
func settle(t *testing.T, events *eventLog, captures int) {
	t.Helper()
	if !until(func() bool { return len(events.captures()) >= captures }) {
		t.Fatalf("captures = %+v", events.captures())
	}
}

// gunzip decodes a capture event's gz payload.
func gunzip(t *testing.T, encoded string) string {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := gzip.NewReader(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return string(plain)
}

const captureTool = `{"name":"Bash","description":"Run a shell command",` +
	`"input_schema":{"type":"object","properties":{"command":{"type":"string"}}}}`

const captureBody = `{"model":"glm-5.3","system":"you are a capture fixture","tools":[` + captureTool + `],"messages":[]}`

func TestPromptCapture(t *testing.T) {
	t.Parallel()
	t.Run("captures a prompt once for two identical requests, both route events naming the same hash", func(t *testing.T) {
		port, events, _ := captureRig(t, nil)
		capturePost(t, port, captureBody)
		capturePost(t, port, captureBody)
		settle(t, events, 1)
		captures := events.captures()
		if len(captures) != 1 {
			t.Fatalf("captures = %d", len(captures))
		}
		want := `{"system":"you are a capture fixture","tools":[` + captureTool + `]}`
		if got := gunzip(t, captures[0].Gz); got != want {
			t.Errorf("captured = %s", got)
		}
		routes := events.routes()
		if len(routes) != 2 {
			t.Fatalf("routes = %d", len(routes))
		}
		for _, route := range routes {
			if route.PromptHash == nil || *route.PromptHash != captures[0].PromptHash {
				t.Errorf("route hash = %v, want %s", route.PromptHash, captures[0].PromptHash)
			}
		}
		if hash, ok := PromptHashOf(parseBodyNode([]byte(captureBody))); !ok || hash != captures[0].PromptHash {
			t.Errorf("hash = %q %v", hash, ok)
		}
	})

	t.Run("captures a different prompt again, its own hash beside it", func(t *testing.T) {
		port, events, _ := captureRig(t, nil)
		capturePost(t, port, captureBody)
		capturePost(t, port, `{"model":"glm-5.3","system":"another fixture","messages":[]}`)
		settle(t, events, 2)
		captures := events.captures()
		if len(captures) != 2 {
			t.Fatalf("captures = %d", len(captures))
		}
		if captures[0].PromptHash == captures[1].PromptHash {
			t.Error("two prompts share one hash")
		}
	})

	t.Run("forwards the client's bytes untouched while it captures", func(t *testing.T) {
		port, events, seen := captureRig(t, nil)
		if code := capturePost(t, port, captureBody); code != 200 {
			t.Fatalf("status = %d", code)
		}
		if len(*seen) != 1 || (*seen)[0].body != captureBody {
			t.Errorf("the upstream got %+v", *seen)
		}
		settle(t, events, 1)
		// The capture read the body without reordering it: the hash still matches the client's own
		// content.
		if captures := events.captures(); len(captures) != 1 {
			t.Errorf("captures = %d", len(captures))
		}
	})

	t.Run("records only the allow-listed response headers, however many the upstream sent", func(t *testing.T) {
		port, events, _ := captureRig(t, map[string]string{
			"Request-Id":                             "req_01",
			"Retry-After":                            "12",
			"Anthropic-Ratelimit-Requests-Remaining": "9",
			"X-Ratelimit-Limit-Tokens":               "1000",
			"Set-Cookie":                             "sid=sekrit; HttpOnly",
			"Authorization":                          "Bearer sekrit",
			"X-Should-Not-Appear":                    "no",
		})
		capturePost(t, port, captureBody)
		settle(t, events, 1)
		waitForEvents(t, events, 1)
		routes := events.routes()
		if len(routes) != 1 || routes[0].Headers == nil {
			t.Fatalf("routes = %+v", routes)
		}
		want := map[string]string{
			"request-id":                             "req_01",
			"retry-after":                            "12",
			"anthropic-ratelimit-requests-remaining": "9",
			"x-ratelimit-limit-tokens":               "1000",
			"content-type":                           "text/event-stream",
		}
		if !sameStringMap(*routes[0].Headers, want) {
			t.Errorf("headers = %v", *routes[0].Headers)
		}
		if text := string(mustJSON(t, events.all())); strings.Contains(text, "sekrit") || strings.Contains(text, "should-not-appear") {
			t.Error("the spool carries a header that is not allow-listed")
		}
	})

	t.Run("carries no hash and writes no capture for a request without system or tools", func(t *testing.T) {
		port, events, _ := captureRig(t, nil)
		capturePost(t, port, `{"model":"glm-5.3","messages":[]}`)
		time.Sleep(20 * time.Millisecond)
		if captures := events.captures(); len(captures) != 0 {
			t.Errorf("captures = %d", len(captures))
		}
		routes := events.routes()
		if len(routes) != 1 || routes[0].PromptHash != nil {
			t.Fatalf("routes = %+v", routes)
		}
		// The answer's headers still ride, but only the allow-listed ones (here, content-type
		// alone).
		want := map[string]string{"content-type": "text/event-stream"}
		if routes[0].Headers == nil || !sameStringMap(*routes[0].Headers, want) {
			t.Errorf("headers = %v", routes[0].Headers)
		}
	})

	t.Run("hashes the same content the same way whatever key order it arrived in", func(t *testing.T) {
		one := `{"model":"glm-5.3","system":"s","tools":[` + captureTool + `]}`
		flippedTool := `{"input_schema":{"type":"object","properties":{"command":{"type":"string"}}},` +
			`"description":"Run a shell command","name":"Bash"}`
		flipped := `{"model":"glm-5.3","tools":[` + flippedTool + `],"system":"s"}`
		first, ok := PromptHashOf(parseBodyNode([]byte(one)))
		if !ok {
			t.Fatal("no hash for a body with system and tools")
		}
		second, ok := PromptHashOf(parseBodyNode([]byte(flipped)))
		if !ok || first != second {
			t.Errorf("hashes = %q, %q (%v)", first, second, ok)
		}
		// A body with neither field hashes to nothing at all.
		if _, ok := PromptHashOf(parseBodyNode([]byte(`{"model":"glm-5.3"}`))); ok {
			t.Error("a body without system or tools hashed")
		}
		if _, ok := PromptHashOf(nil); ok {
			t.Error("no body hashed")
		}
	})
}

// sameStringMap compares two string maps by content.
func sameStringMap(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for key, value := range a {
		if b[key] != value {
			return false
		}
	}
	return true
}
