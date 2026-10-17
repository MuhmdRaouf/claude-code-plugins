package domain

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode/utf16"
)

// salientKeys are the input keys that best say what a tool call is about, in order of preference (Claude Code's
// built-in tools).
var salientKeys = []string{
	"file_path",
	"notebook_path",
	"command",
	"pattern",
	"path",
	"url",
	"query",
	"description",
	"prompt",
	"skill",
}

const maxSummaryChars = 80

// SummarizeToolInput returns one short line describing a tool call's input, for progress displays. The input rides as
// raw JSON bytes so the fallback keeps the key order the request wrote, which a decoded map would lose.
func SummarizeToolInput(input json.RawMessage) string {
	var object map[string]any
	if err := json.Unmarshal(input, &object); err == nil {
		if salient, ok := salientValue(object); ok {
			return summaryOneLine(salient)
		}
		if len(object) == 0 {
			return ""
		}
		return summaryOneLine(summaryCompact(input))
	}
	var array []any
	if err := json.Unmarshal(input, &array); err == nil {
		// An array has no salient key, so it falls to its compact JSON.
		if len(array) == 0 {
			return ""
		}
		return summaryOneLine(summaryCompact(input))
	}
	return ""
}

func salientValue(input map[string]any) (string, bool) {
	for _, key := range salientKeys {
		if value, ok := input[key].(string); ok {
			return value, true
		}
	}
	return "", false
}

// summaryCompact is JSON.stringify on the raw bytes: whitespace out, key order and escaping kept.
func summaryCompact(raw json.RawMessage) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return ""
	}
	return buf.String()
}

// summaryOneLine flattens JS whitespace runs to one space, trims, and caps the line at maxSummaryChars UTF-16 code
// units with an ellipsis, exactly JS's flat.slice(0, 79) + "…": a surrogate pair the cut splits leaves a lone
// surrogate, which utf16.Decode turns into U+FFFD — what Node writes for it.
func summaryOneLine(text string) string {
	flat := summaryFlattenSpace(text)
	units := utf16.Encode([]rune(flat))
	if len(units) <= maxSummaryChars {
		return flat
	}
	return string(utf16.Decode(units[:maxSummaryChars-1])) + "…"
}

func summaryFlattenSpace(text string) string {
	var b strings.Builder
	inSpace := false
	for _, r := range text {
		if isJsSpace(r) {
			inSpace = true
			continue
		}
		if inSpace && b.Len() > 0 {
			b.WriteByte(' ')
		}
		inSpace = false
		b.WriteRune(r)
	}
	return b.String()
}
