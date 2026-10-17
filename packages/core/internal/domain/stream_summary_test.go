package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSummarizeToolInput(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"the most salient key wins", `{"pattern":"p","file_path":"/tmp/a b.go"}`, "/tmp/a b.go"},
		{"a salient key must hold a string", `{"file_path":123,"command":"run it"}`, "run it"},
		{"an empty salient string still counts", `{"file_path":""}`, ""},
		{"no salient key falls to compact JSON in insertion order", `{"z":1,"a":2,"m":3}`, `{"z":1,"a":2,"m":3}`},
		{"compact JSON keeps nested order", `{"input":{"z":1,"a":2}}`, `{"input":{"z":1,"a":2}}`},
		{"whitespace in the raw JSON is compacted", `{ "b" : 2 }`, `{"b":2}`},
		{"an empty object summarizes to nothing", `{}`, ""},
		{"an array falls to its compact JSON", `[1,2]`, "[1,2]"},
		{"an empty array summarizes to nothing", `[]`, ""},
		{"a scalar is not an object", `42`, ""},
		{"a string is not an object", `"hello"`, ""},
		{"null is not an object", `null`, ""},
		{"missing input is nothing", ``, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SummarizeToolInput(json.RawMessage(tc.input)); got != tc.want {
				t.Fatalf("SummarizeToolInput(%s) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestSummarizeToolInputOneLine(t *testing.T) {
	quoteForSummary := func(value string) string {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("marshal command: %v", err)
		}
		return string(encoded)
	}
	commandOf := func(value string) json.RawMessage {
		return json.RawMessage(`{"command":` + quoteForSummary(value) + `}`)
	}

	t.Run("flattens whitespace and trims", func(t *testing.T) {
		got := SummarizeToolInput(commandOf("a\n\t b  "))
		if want := "a b"; got != want {
			t.Fatalf("SummarizeToolInput() = %q, want %q", got, want)
		}
	})
	t.Run("keeps a line of at most 80 units as it is", func(t *testing.T) {
		if got, want := SummarizeToolInput(commandOf(strings.Repeat("y", 80))), strings.Repeat("y", 80); got != want {
			t.Fatalf("SummarizeToolInput() = %q, want %q", got, want)
		}
	})
	t.Run("truncates a longer line to 79 chars and an ellipsis", func(t *testing.T) {
		got := SummarizeToolInput(commandOf(strings.Repeat("a", 100)))
		if want := strings.Repeat("a", 79) + "…"; got != want {
			t.Fatalf("SummarizeToolInput() = %q, want 79 a's and an ellipsis", got)
		}
	})
	t.Run("cuts at UTF-16 code units: an astral char straddling the cut becomes U+FFFD", func(t *testing.T) {
		// 78 x's then two emoji: 78+4 UTF-16 units, and the cut at 79 lands inside the first pair. Node writes the
		// lone high surrogate it leaves as U+FFFD, so the line ends x*78 EF BF BD E2 80 A6.
		got := SummarizeToolInput(commandOf(strings.Repeat("x", 78) + "\U0001F600\U0001F600"))
		if want := strings.Repeat("x", 78) + "�…"; got != want {
			t.Fatalf("SummarizeToolInput() = % x, want % x", got, want)
		}
	})
	t.Run("cuts at UTF-16 code units: a pair starting past the cut is dropped whole", func(t *testing.T) {
		// 79 y's then one emoji: 79+2 UTF-16 units, and the cut at 79 ends before the pair.
		got := SummarizeToolInput(commandOf(strings.Repeat("y", 79) + "\U0001F600"))
		if want := strings.Repeat("y", 79) + "…"; got != want {
			t.Fatalf("SummarizeToolInput() = % x, want % x", got, want)
		}
	})
	t.Run("a line of exactly 80 UTF-16 units stays as it is", func(t *testing.T) {
		got := SummarizeToolInput(commandOf(strings.Repeat("x", 78) + "\U0001F600"))
		if want := strings.Repeat("x", 78) + "\U0001F600"; got != want {
			t.Fatalf("SummarizeToolInput() = % x, want % x", got, want)
		}
	})

	t.Run("bytes that are not JSON compact to nothing", func(t *testing.T) {
		if got := summaryCompact(json.RawMessage("{bad")); got != "" {
			t.Fatalf("summaryCompact(not JSON) = %q, want %q", got, "")
		}
	})

	t.Run("JS whitespace flattens, other Unicode spaces included", func(t *testing.T) {
		got := SummarizeToolInput(commandOf("a b　c\v"))
		if want := "a b c"; got != want {
			t.Fatalf("SummarizeToolInput() = %q, want %q", got, want)
		}
	})
}
