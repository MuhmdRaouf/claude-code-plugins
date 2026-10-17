package domain

import "strings"

// Paragraphs joins parts as paragraphs separated by one blank line, ending in exactly one
// newline.
func Paragraphs(parts []string) string {
	trimmed := make([]string, len(parts))
	for i, part := range parts {
		trimmed[i] = strings.TrimRight(part, "\n")
	}
	return strings.Join(trimmed, "\n\n") + "\n"
}

// Lines joins content as lines with a trailing newline.
func Lines(content []string) string {
	return strings.Join(content, "\n") + "\n"
}
