package domain

import (
	"bytes"
	"encoding/json"
)

// MarshalCompactJSON encodes v the way JavaScript's JSON.stringify does: one line, no indentation,
// `<`, `>` and `&` alone, and U+2028 and U+2029 raw.
func MarshalCompactJSON(v any) ([]byte, error) {
	return marshalJSON(v, "")
}

// MarshalIndentJSON encodes v the way state files are written: JavaScript's
// JSON.stringify(v, null, 2) plus a trailing newline, without HTML escaping.
func MarshalIndentJSON(v any) ([]byte, error) {
	return marshalJSON(v, "  ")
}

// marshalJSON is the one encoder both exported helpers share. The indent is "" for compact output
// and the state files' two spaces otherwise, which ends the output with the newline the state
// files carry.
func marshalJSON(v any, indent string) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if indent != "" {
		encoder.SetIndent("", indent)
	}
	if err := encoder.Encode(v); err != nil {
		return nil, err
	}
	if indent == "" {
		// Compact output is one line: drop the newline Encode appends.
		return unescapeLineSeps(bytes.TrimSuffix(buf.Bytes(), []byte("\n"))), nil
	}
	return unescapeLineSeps(buf.Bytes()), nil
}

// unescapeLineSeps rewrites the U+2028 and U+2029 escapes encoding/json always emits (even with
// HTML escaping off) into the raw characters JSON.stringify writes; state files and spool lines
// stay byte-identical to what a JavaScript writer produces, which their readers parse. The text
// "u2028" behind an even run of backslashes stays: those backslashes escape each other, so it is
// the literal source text, not an escape.
func unescapeLineSeps(data []byte) []byte {
	out := make([]byte, 0, len(data))
	for i := 0; i < len(data); i++ {
		if data[i] == '\\' && i+5 < len(data) && data[i+1] == 'u' && data[i+2] == '2' &&
			data[i+3] == '0' && data[i+4] == '2' && (data[i+5] == '8' || data[i+5] == '9') &&
			backslashRun(data, i)%2 == 1 {
			if data[i+5] == '8' {
				out = append(out, 0xE2, 0x80, 0xA8) // U+2028 LINE SEPARATOR
			} else {
				out = append(out, 0xE2, 0x80, 0xA9) // U+2029 PARAGRAPH SEPARATOR
			}
			i += 5
			continue
		}
		out = append(out, data[i])
	}
	return out
}

// backslashRun counts the consecutive backslashes ending at at.
func backslashRun(data []byte, at int) int {
	run := 0
	for j := at; j >= 0 && data[j] == '\\'; j-- {
		run++
	}
	return run
}
