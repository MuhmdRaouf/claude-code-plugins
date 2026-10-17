package domain

import "testing"

// The expected texts, byte for byte.
func TestParagraphs(t *testing.T) {
	cases := []struct {
		name  string
		parts []string
		want  string
	}{
		{"joins parts with one blank line", []string{"a", "b"}, "a\n\nb\n"},
		{"strips each part's trailing newlines", []string{"a\n\n", "b\n"}, "a\n\nb\n"},
		{"a single part", []string{"single"}, "single\n"},
		{"no parts", nil, "\n"},
		{"an empty part keeps its blank line", []string{"a\n\n\n", ""}, "a\n\n\n"},
		{"two empty parts", []string{"", ""}, "\n\n\n"},
		{"strips only trailing newlines, not blank lines inside", []string{"trail\n\n\n", "x\n"}, "trail\n\nx\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Paragraphs(tc.parts); got != tc.want {
				t.Fatalf("paragraphs(%q) = %q, want %q", tc.parts, got, tc.want)
			}
		})
	}
}

func TestLines(t *testing.T) {
	cases := []struct {
		name    string
		content []string
		want    string
	}{
		{"joins lines with a trailing newline", []string{"a", "b"}, "a\nb\n"},
		{"a single line", []string{"single"}, "single\n"},
		{"no lines", nil, "\n"},
		{"an empty line stays", []string{"a", "", "c"}, "a\n\nc\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Lines(tc.content); got != tc.want {
				t.Fatalf("lines(%q) = %q, want %q", tc.content, got, tc.want)
			}
		})
	}
}
