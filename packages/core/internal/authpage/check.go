// One minimal request with a candidate key: the provider's ping tier, one output token. Only the
// status matters; the key travels in the Authorization header and nowhere else, and no error text
// from the request is ever kept.
package authpage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// checkTimeoutMs bounds the one request.
const checkTimeoutMs = 20_000

// FetchRequest is the one request the key check makes.
type FetchRequest struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    []byte
}

// FetchResponse is the only part of the answer the check reads.
type FetchResponse struct {
	Status int
	OK     bool
}

// FetchFunc performs one HTTP request the way fetch does: it follows no redirect and answers
// with the status even on a 4xx or 5xx; an error is a network-level failure. A nil fetch is
// HTTPFetch.
type FetchFunc func(ctx context.Context, request FetchRequest) (FetchResponse, error)

// HTTPFetch is the default FetchFunc: one POST, no redirects, a 20 s timeout.
func HTTPFetch(ctx context.Context, request FetchRequest) (FetchResponse, error) {
	client := &http.Client{
		Timeout: checkTimeoutMs * time.Millisecond,
		// A redirect rejects the request, and no answer is read.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("the key check follows no redirect")
		},
	}
	req, err := http.NewRequestWithContext(ctx, request.Method, request.URL, bytes.NewReader(request.Body))
	if err != nil {
		return FetchResponse{}, err
	}
	for name, value := range request.Headers {
		req.Header.Set(name, value)
	}
	response, err := client.Do(req)
	if err != nil {
		return FetchResponse{}, err
	}
	_, _ = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	return FetchResponse{
		Status: response.StatusCode,
		OK:     response.StatusCode >= 200 && response.StatusCode <= 299,
	}, nil
}

type checkMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type checkBody struct {
	Model     string         `json:"model"`
	MaxTokens int            `json:"max_tokens"`
	Messages  []checkMessage `json:"messages"`
}

// newCheckBody is the one-request body, a struct of strings and ints: it cannot fail to encode,
// and json.Marshal would only replace an invalid UTF-8 byte, which the provider's own ids never
// carry.
func newCheckBody(provider domain.Provider) []byte {
	encoded, _ := json.Marshal(checkBody{
		Model:     provider.Catalog[provider.PingTier].ID,
		MaxTokens: 1,
		Messages:  []checkMessage{{Role: "user", Content: "ping"}},
	})
	return encoded
}

// CheckKey makes one minimal provider request with a candidate key. accepted: the provider
// answered 2xx. limited: 429 or 402 (rate limit or empty balance: the key itself is good).
// refused: 401 or 403. unknown: anything else (network, 5xx); a failed request is unknown, and
// no error text from it is ever kept.
func CheckKey(ctx context.Context, provider domain.Provider, key string, fetch FetchFunc) ports.KeyVerdict {
	if fetch == nil {
		fetch = HTTPFetch
	}
	response, err := fetch(ctx, FetchRequest{
		Method: "POST",
		URL:    strings.TrimRight(provider.BaseURL, "/") + "/v1/messages",
		Headers: map[string]string{
			"authorization":     "Bearer " + key,
			"anthropic-version": "2023-06-01",
			"content-type":      "application/json",
		},
		Body: newCheckBody(provider),
	})
	if err != nil {
		return ports.KeyVerdictUnknown
	}
	switch response.Status {
	case 401, 403:
		return ports.KeyVerdictRefused
	case 429, 402:
		return ports.KeyVerdictLimited
	}
	if response.OK {
		return ports.KeyVerdictAccepted
	}
	return ports.KeyVerdictUnknown
}
