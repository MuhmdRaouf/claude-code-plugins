package authpage

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// The key check, its real fetch against an httptest server.

func TestCheckKey(t *testing.T) {
	provider := testkit.ReferenceProvider
	cases := []struct {
		name   string
		status int
		ok     bool
		err    error
		want   ports.KeyVerdict
	}{
		{"a 401 is refused", 401, false, nil, ports.KeyVerdictRefused},
		{"a 403 is refused", 403, false, nil, ports.KeyVerdictRefused},
		{"a 429 is limited", 429, false, nil, ports.KeyVerdictLimited},
		{"a 402 is limited", 402, false, nil, ports.KeyVerdictLimited},
		{"a 2xx is accepted", 200, true, nil, ports.KeyVerdictAccepted},
		{"a 500 is unknown", 500, false, nil, ports.KeyVerdictUnknown},
		{"a failed request is unknown", 0, false, errors.New("network down"), ports.KeyVerdictUnknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var request FetchRequest
			fetch := func(ctx context.Context, r FetchRequest) (FetchResponse, error) {
				request = r
				if c.err != nil {
					return FetchResponse{}, c.err
				}
				return FetchResponse{Status: c.status, OK: c.ok}, nil
			}
			verdict := CheckKey(context.Background(), provider, testkit.TEST_KEY, fetch)
			if verdict != c.want {
				t.Errorf("verdict = %q, want %q", verdict, c.want)
			}
			if request.URL != "https://api.z.ai/api/anthropic/v1/messages" {
				t.Errorf("url = %q", request.URL)
			}
			if request.Method != "POST" {
				t.Errorf("method = %q, want POST", request.Method)
			}
			if request.Headers["authorization"] != "Bearer "+testkit.TEST_KEY {
				t.Errorf("the key does not travel in the Authorization header alone")
			}
			if request.Headers["anthropic-version"] != "2023-06-01" {
				t.Errorf("anthropic-version = %q", request.Headers["anthropic-version"])
			}
			wantBody := `{"model":"glm-5.3-flash","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}`
			if string(request.Body) != wantBody {
				t.Errorf("body = %s, want %s", request.Body, wantBody)
			}
		})
	}

	t.Run("a base URL with trailing slashes gets exactly one /v1/messages", func(t *testing.T) {
		padded := provider
		padded.BaseURL = "https://api.z.ai/api/anthropic///"
		var seen string
		fetch := func(ctx context.Context, r FetchRequest) (FetchResponse, error) {
			seen = r.URL
			return FetchResponse{Status: 200, OK: true}, nil
		}
		CheckKey(context.Background(), padded, testkit.TEST_KEY, fetch)
		if seen != "https://api.z.ai/api/anthropic/v1/messages" {
			t.Errorf("url = %q", seen)
		}
	})
}

func TestHTTPFetch(t *testing.T) {
	t.Run("posts the request and answers with the status, even on a 4xx", func(t *testing.T) {
		var gotMethod, gotAuth, gotBody string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotMethod = r.Method
			gotAuth = r.Header.Get("Authorization")
			body, _ := io.ReadAll(r.Body)
			gotBody = string(body)
			w.WriteHeader(401)
		}))
		defer server.Close()
		response, err := HTTPFetch(context.Background(), FetchRequest{
			Method: "POST",
			URL:    server.URL + "/v1/messages",
			Headers: map[string]string{
				"authorization":     "Bearer " + testkit.TEST_KEY,
				"anthropic-version": "2023-06-01",
				"content-type":      "application/json",
			},
			Body: []byte(`{"ping":true}`),
		})
		if err != nil {
			t.Fatalf("fetch: %v", err)
		}
		if response.Status != 401 || response.OK {
			t.Errorf("response = %+v, want the 401 as an answer", response)
		}
		if gotMethod != "POST" || gotAuth != "Bearer "+testkit.TEST_KEY || gotBody != `{"ping":true}` {
			t.Errorf("the request arrived as %s %q %q", gotMethod, gotAuth, gotBody)
		}
	})

	t.Run("a redirect is an error, a dead server is an error", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/elsewhere", http.StatusFound)
		}))
		defer server.Close()
		if _, err := HTTPFetch(context.Background(), FetchRequest{Method: "POST", URL: server.URL}); err == nil {
			t.Error("a redirect was followed instead of refused")
		}
		dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		deadURL := dead.URL
		dead.Close()
		if _, err := HTTPFetch(context.Background(), FetchRequest{Method: "POST", URL: deadURL}); err == nil {
			t.Error("a dead server was not an error")
		}
	})

	t.Run("an unparsable URL is an error, so the check reads unknown", func(t *testing.T) {
		provider := testkit.ReferenceProvider
		provider.BaseURL = "http://[::1"
		if verdict := CheckKey(context.Background(), provider, testkit.TEST_KEY, nil); verdict != ports.KeyVerdictUnknown {
			t.Errorf("verdict = %q, want unknown", verdict)
		}
		if !strings.Contains(provider.BaseURL, "[") {
			t.Error("the provider was mutated")
		}
	})
}
