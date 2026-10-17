// Package shared holds the helpers every delegation engine bridge (omp, pi, opencode, zcode)
// works through: the loosely typed JSON the engines send, the environment a delegation tool
// starts with, the RPC attempt logs, and the report-turn loop.
package shared

import (
	"encoding/json"
	"math"
	"strings"
)

// AsRecord reads value as a JSON object: the object itself, or an empty record for anything else
// (a missing or mistyped field reads as empty, never fails).
func AsRecord(value any) map[string]any {
	if record, ok := value.(map[string]any); ok {
		return record
	}
	return nil
}

// AsString reads value as a string; ok is false for every other type.
func AsString(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok
}

// AsCount reads value as a finite number, 0 for anything else. The count is the JS number the
// engines send (an attempt index as well as a cost in dollars), so it stays a float64.
func AsCount(value any) float64 {
	if count, ok := value.(float64); ok && !math.IsInf(count, 0) && !math.IsNaN(count) {
		return count
	}
	return 0
}

// TextOf is the text of a message's text parts (omp and pi split one assistant message into parts).
func TextOf(content any) string {
	parts, ok := content.([]any)
	if !ok {
		return ""
	}
	var text strings.Builder
	for _, part := range parts {
		if partText, ok := AsString(AsRecord(part)["text"]); ok {
			text.WriteString(partText)
		}
	}
	return text.String()
}

// FirstStringValue is the first string value in a tool call's arguments: the engine's own summary
// of what the call is about. The arguments ride as the JSON bytes the engine sent, so "first" is
// the first key in the order the engine wrote them (a decoded Go map has no order).
func FirstStringValue(args json.RawMessage) (string, bool) {
	var first string
	found := false
	walkObject(args, func(key string, value json.RawMessage) bool {
		if text, ok := unquoteString(value); ok {
			first, found = text, true
			return false
		}
		return true
	})
	return first, found
}
