package domain

import "testing"

// The expected fences, checked byte for byte.
func TestFenced(t *testing.T) {
	cases := []struct {
		name    string
		content string
		info    string
		want    string
	}{
		{"no backticks inside", "plain text", "", "```\nplain text\n```"},
		{"a single backtick still fits a three-backtick fence", "has ` one", "", "```\nhas ` one\n```"},
		{"a three-backtick run lengthens the fence", "has ``` three", "js", "````js\nhas ``` three\n````"},
		{"a five-backtick run lengthens the fence past it", "has ````` five", "", "``````\nhas ````` five\n``````"},
		{"content ending in a newline is not doubled", "ends with newline\n", "ts", "```ts\nends with newline\n```"},
		{"empty content", "", "", "```\n\n```"},
		{"backticks mid-text", "a\n\n`b`", "md", "```md\na\n\n`b`\n```"},
		{"a lone backtick-run content", "``", "", "```\n``\n```"},
		{"a multi-line info string", "x", "rust\ninfo", "```rust\ninfo\nx\n```"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Fenced(tc.content, tc.info); got != tc.want {
				t.Fatalf("fenced(%q, %q) = %q, want %q", tc.content, tc.info, got, tc.want)
			}
		})
	}
}
