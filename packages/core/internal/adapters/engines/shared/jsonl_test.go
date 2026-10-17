package shared

import (
	"reflect"
	"testing"
)

func TestParseJsonLine(t *testing.T) {
	t.Run("parses a line into its object, whitespace and all", func(t *testing.T) {
		got := ParseJsonLine(`  {"type": "ready", "protocolVersion": 2} `)
		want := map[string]any{"type": "ready", "protocolVersion": float64(2)}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("ParseJsonLine() = %v, want %v", got, want)
		}
	})

	t.Run("returns undefined for blank, broken, array, scalar and null lines", func(t *testing.T) {
		for _, line := range []string{"", "   ", "{broken", "[1, 2]", `"text line"`, "null"} {
			if got := ParseJsonLine(line); got != nil {
				t.Errorf("ParseJsonLine(%q) = %v, want nil", line, got)
			}
		}
	})
}
