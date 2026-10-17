package shared

import (
	"encoding/json"
	"math"
	"testing"
)

// The omp, pi and zcode worker tests cover the field helpers through whole runs; these direct
// tests cover the helpers themselves.

func TestAsRecord(t *testing.T) {
	record := map[string]any{"a": 1.0}
	if got := AsRecord(record); len(got) != 1 || got["a"] != 1.0 {
		t.Errorf("AsRecord(record) = %v, want the record itself", got)
	}
	for _, value := range []any{nil, "x", 1.0, true, []any{1}} {
		if got := AsRecord(value); got != nil {
			t.Errorf("AsRecord(%#v) = %v, want an empty record", value, got)
		}
	}
}

func TestAsString(t *testing.T) {
	if got, ok := AsString("ready"); got != "ready" || !ok {
		t.Errorf(`AsString("ready") = (%q, %v), want ("ready", true)`, got, ok)
	}
	for _, value := range []any{nil, 1.0, true, map[string]any{}, []any{}} {
		if got, ok := AsString(value); ok {
			t.Errorf("AsString(%#v) = (%q, %v), want ok false", value, got, ok)
		}
	}
}

func TestAsCount(t *testing.T) {
	cases := []struct {
		value any
		want  float64
	}{
		{value: 2.0, want: 2},
		{value: 0.5, want: 0.5},
		{value: 0.0, want: 0},
		{value: math.Inf(1), want: 0},
		{value: math.Inf(-1), want: 0},
		{value: math.NaN(), want: 0},
		{value: "2", want: 0},
		{value: nil, want: 0},
		{value: true, want: 0},
	}
	for _, c := range cases {
		if got := AsCount(c.value); got != c.want {
			t.Errorf("AsCount(%#v) = %v, want %v", c.value, got, c.want)
		}
	}
}

func TestTextOf(t *testing.T) {
	t.Run("joins the text of the message's text parts", func(t *testing.T) {
		content := []any{
			map[string]any{"type": "text", "text": "a"},
			map[string]any{"type": "other"},
			map[string]any{"type": "text", "text": "b"},
			"scalar",
			nil,
		}
		if got := TextOf(content); got != "ab" {
			t.Errorf("TextOf() = %q, want %q", got, "ab")
		}
	})
	for _, content := range []any{nil, "text", map[string]any{"text": "a"}, []any{}, 1.0} {
		if got := TextOf(content); got != "" {
			t.Errorf("TextOf(%#v) = %q, want %q", content, got, "")
		}
	}
}

func TestFirstStringValue(t *testing.T) {
	cases := []struct {
		name   string
		args   string
		want   string
		wantOK bool
	}{
		{name: "the first value in written order", args: `{"cwd":"/tmp","command":"git status"}`, want: "/tmp", wantOK: true},
		{name: "skips non-string values", args: `{"count":2,"path":"x"}`, want: "x", wantOK: true},
		{name: "no string values", args: `{"count":2,"ok":true}`, wantOK: false},
		{name: "empty object", args: `{}`, wantOK: false},
		{name: "not an object", args: `["a","b"]`, wantOK: false},
		{name: "not JSON", args: `{broken`, wantOK: false},
		{name: "null", args: `null`, wantOK: false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := FirstStringValue(json.RawMessage(c.args))
			if got != c.want || ok != c.wantOK {
				t.Errorf("FirstStringValue(%s) = (%q, %v), want (%q, %v)", c.args, got, ok, c.want, c.wantOK)
			}
		})
	}
}
