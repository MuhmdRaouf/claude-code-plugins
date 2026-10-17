package shared

import (
	"encoding/json"
	"strings"
	"unicode"
)

// ParseJsonLine is the line as a JSON object, or nil for anything else: blank, unparseable, an
// array or a scalar.
func ParseJsonLine(line string) map[string]any {
	trimmed := trimJS(line)
	if trimmed == "" {
		return nil
	}
	var value any
	if err := json.Unmarshal([]byte(trimmed), &value); err != nil {
		return nil
	}
	object, _ := value.(map[string]any)
	return object
}

// trimJS cuts JS whitespace (String.prototype.trim's set) from both ends: Go's TrimSpace also cuts
// U+0085 and leaves U+FEFF, the other way round from JS.
func trimJS(line string) string {
	return strings.TrimFunc(line, isJSSpace)
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u2028', '\u2029', '\ufeff':
		return true
	}
	return unicode.Is(unicode.Zs, r)
}
