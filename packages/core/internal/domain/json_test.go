package domain

import (
	"fmt"
	"reflect"
	"testing"
)

// jsonNumberObject is the check a caller runs on a decoded value: an object whose n is a number.
func jsonNumberObject(value any) bool {
	obj, ok := value.(map[string]any)
	if !ok {
		return false
	}
	_, ok = obj["n"].(float64)
	return ok
}

func TestParseJson(t *testing.T) {
	t.Run("returns the value when it parses and matches", func(t *testing.T) {
		value, err := ParseJSON(`{"n":1}`)
		if err != nil {
			t.Fatalf("parseJson error: %v", err)
		}
		if !jsonNumberObject(value) {
			t.Fatalf("parseJson(`{\"n\":1}`) = %#v, which does not match the shape", value)
		}
		want := map[string]any{"n": float64(1)}
		if !reflect.DeepEqual(value, want) {
			t.Fatalf("parseJson(`{\"n\":1}`) = %#v, want %#v", value, want)
		}
	})

	for _, text := range []string{"", "{ torn", `{"n":"one"}`, "null", "[]"} {
		t.Run(fmt.Sprintf("is undefined for %q", text), func(t *testing.T) {
			value, err := ParseJSON(text)
			if err == nil && jsonNumberObject(value) {
				t.Fatalf("parseJson(%q) = %#v, want undefined", text, value)
			}
		})
	}
}
