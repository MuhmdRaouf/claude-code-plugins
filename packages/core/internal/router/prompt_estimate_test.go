// The prompt estimate's cases, inputs and expected outputs.
package router

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

func TestPromptKey(t *testing.T) {
	t.Parallel()
	t.Run("is 16 hex characters and stable for the same system and first message", func(t *testing.T) {
		first := json.RawMessage(`{"role":"user","content":"hi"}`)
		key := PromptKey("You delegate work.", first)
		if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(key) {
			t.Fatalf("promptKey = %q, want 16 hex characters", key)
		}
		if PromptKey("You delegate work.", first) != key {
			t.Fatal("promptKey is not stable for the same system and first message")
		}
	})

	t.Run("moves when the system or the first message moves", func(t *testing.T) {
		if PromptKey("a", "m") == PromptKey("b", "m") {
			t.Fatal("the key ignored a moved system")
		}
		if PromptKey("a", "m") == PromptKey("a", "n") {
			t.Fatal("the key ignored a moved first message")
		}
	})

	t.Run("reads only the first 4096 characters of each part", func(t *testing.T) {
		edge := strings.Repeat("x", 4096)
		// Differences past the cut are invisible: the head is the identity, not the whole transcript.
		if PromptKey(edge+"A", "m") != PromptKey(edge+"B", "m") {
			t.Fatal("the key read past the first 4096 characters")
		}
		if PromptKey("a", "m") == PromptKey("b", "m") {
			t.Fatal("the head alone stopped telling conversations apart")
		}
	})

	// The exact hash keys for the same parts: the cut at UTF-16 code units, the lone surrogate
	// it can leave, and the raw U+2028 included.
	t.Run("hashes the exact bytes for the edge-case parts", func(t *testing.T) {
		emoji := strings.Repeat("\U0001F600", 2048)
		cases := []struct {
			name         string
			system       any
			firstMessage any
			want         string
		}{
			{"a plain pair", "You delegate work.", json.RawMessage(`{"role":"user","content":"hi"}`), "0b7de24774564d9f"},
			{"a moved system", "a", "m", "d120c14b4ed3fed1"},
			{"a cut at a plain edge", strings.Repeat("x", 4096) + "A", "m", "03f5326a2ca7fd19"},
			{"a cut inside a surrogate pair", emoji + "A", "m", "12d145cdd3687830"},
			{"a line separator kept raw", "a b", "m", "87dc2175e89cddcd"},
			{"a missing system", nil, "m", "7eb1920948e18570"},
			{"a decoded field that was absent", json.RawMessage(nil), "m", "7eb1920948e18570"},
			{"a nested message", "s", json.RawMessage(`{"role":"user","content":[{"type":"text","text":"hi & <bye>"}]}`), "41a7306e45e362f5"},
		}
		for _, testCase := range cases {
			if got := PromptKey(testCase.system, testCase.firstMessage); got != testCase.want {
				t.Errorf("%s: promptKey = %s, want %s", testCase.name, got, testCase.want)
			}
		}
	})
}

func TestEstimatePrompt(t *testing.T) {
	t.Parallel()
	t.Run("takes a quarter token per byte for a conversation never seen", func(t *testing.T) {
		estimates := NewPromptEstimator()
		if got := estimates.EstimatePrompt("no-such-conversation", 8192); got != 2048 {
			t.Fatalf("estimatePrompt(8192) = %d, want 2048", got)
		}
		if got := estimates.EstimatePrompt("no-such-conversation", 7); got != 2 {
			t.Fatalf("estimatePrompt(7) = %d, want 2", got)
		}
	})

	t.Run("grows from what the last turn of the same conversation really cost", func(t *testing.T) {
		estimates := NewPromptEstimator()
		key := PromptKey("s-grown", "m")
		estimates.RecordPrompt(key, domain.RouteUsage{
			"input_tokens":                1000.0,
			"cache_read_input_tokens":     50.0,
			"cache_creation_input_tokens": 3.0,
		}, 8000)
		if got := estimates.EstimatePrompt(key, 12000); got != 2053 {
			t.Fatalf("estimatePrompt(12000) = %d, want 2053", got)
		}
	})

	t.Run("never goes down when the next body is shorter", func(t *testing.T) {
		estimates := NewPromptEstimator()
		key := PromptKey("s-shorter", "m")
		estimates.RecordPrompt(key, domain.RouteUsage{"input_tokens": 900.0}, 8000)
		if got := estimates.EstimatePrompt(key, 4000); got != 900 {
			t.Fatalf("estimatePrompt(4000) = %d, want 900", got)
		}
	})

	t.Run("ignores a final usage that still reports no prompt size", func(t *testing.T) {
		estimates := NewPromptEstimator()
		key := PromptKey("s-zero", "m")
		estimates.RecordPrompt(key, domain.RouteUsage{"input_tokens": 0.0, "output_tokens": 30.0}, 8000)
		if got := estimates.EstimatePrompt(key, 8000); got != 2000 {
			t.Fatalf("estimatePrompt(8000) = %d, want 2000", got)
		}
	})

	t.Run("forgets the oldest conversation past 500", func(t *testing.T) {
		estimates := NewPromptEstimator()
		evicted := PromptKey("s-oldest", "m")
		estimates.RecordPrompt(evicted, domain.RouteUsage{"input_tokens": 999999.0}, 0)
		for i := 0; i < 500; i++ {
			estimates.RecordPrompt(
				PromptKey(fmt.Sprintf("s-flood-%d", i), "m"),
				domain.RouteUsage{"input_tokens": 1000000.0 + float64(i)},
				0,
			)
		}
		// The flooded-out conversation estimates like a stranger again; the newest one is still known.
		if got := estimates.EstimatePrompt(evicted, 4000); got != 1000 {
			t.Fatalf("estimatePrompt(evicted) = %d, want 1000", got)
		}
		if got := estimates.EstimatePrompt(PromptKey("s-flood-499", "m"), 0); got != 1000499 {
			t.Fatalf("estimatePrompt(newest) = %d, want 1000499", got)
		}
	})
}

// The extra cases cover the branches recordPrompt guards: a stream with no final usage, and a
// usage whose input is not a number, remember nothing.
func TestRecordPrompt(t *testing.T) {
	t.Parallel()
	t.Run("records nothing without a final usage or with no number in it", func(t *testing.T) {
		estimates := NewPromptEstimator()
		key := PromptKey("s-none", "m")
		estimates.RecordPrompt(key, nil, 8000)
		estimates.RecordPrompt(key, domain.RouteUsage{"input_tokens": "1000"}, 8000)
		if got := estimates.EstimatePrompt(key, 8000); got != 2000 {
			t.Fatalf("estimatePrompt(8000) = %d, want the stranger's 2000", got)
		}
		if _, known := estimates.turns[key]; known {
			t.Fatal("a numberless usage was remembered")
		}
	})

	t.Run("reads the counters however the caller decoded them", func(t *testing.T) {
		estimates := NewPromptEstimator()
		asInt := PromptKey("s-int", "m")
		estimates.RecordPrompt(asInt, domain.RouteUsage{"input_tokens": 4000}, 0)
		if got := estimates.EstimatePrompt(asInt, 0); got != 4000 {
			t.Fatalf("estimatePrompt(int counters) = %d, want 4000", got)
		}
		asInt64 := PromptKey("s-int64", "m")
		estimates.RecordPrompt(asInt64, domain.RouteUsage{"input_tokens": int64(2000)}, 0)
		if got := estimates.EstimatePrompt(asInt64, 0); got != 2000 {
			t.Fatalf("estimatePrompt(int64 counters) = %d, want 2000", got)
		}
	})
}
