package domain

import "testing"

func TestMarshalCompactJSON(t *testing.T) {
	t.Run("writes one line without HTML escaping", func(t *testing.T) {
		value := struct {
			Markup  string `json:"markup"`
			Unicode string `json:"unicode"`
			Nested  []any  `json:"nested"`
		}{
			Markup:  "<script>&</script>",
			Unicode: "héllo — 世界 \U0001f680",
			Nested:  []any{[]any{1, 2, 3}, map[string]any{"four": 4.5}},
		}
		got, err := MarshalCompactJSON(value)
		if err != nil {
			t.Fatalf("MarshalCompactJSON error: %v", err)
		}
		want := `{"markup":"<script>&</script>","unicode":"héllo — 世界 ` + "\U0001f680" + `","nested":[[1,2,3],{"four":4.5}]}`
		if string(got) != want {
			t.Fatalf("MarshalCompactJSON =\n%q\nwant\n%q", got, want)
		}
	})

	// The two separators as characters, written to stay raw in the output like JSON.stringify
	// does; the literals are the six ASCII characters backslash + "u2028" / "u2029".
	t.Run("writes U+2028 and U+2029 raw and keeps literal backslash-u2028 text", func(t *testing.T) {
		ls, ps := string(rune(0x2028)), string(rune(0x2029))
		value := struct {
			LineSep string `json:"lineSep"`
			Literal string `json:"literal"`
			Mixed   string `json:"mixed"`
		}{
			LineSep: "a" + ls + "b" + ps + "c",
			Literal: "d" + `\` + "u2028e",
			Mixed:   "f" + `\` + "u2029g" + ls + "h",
		}
		got, err := MarshalCompactJSON(value)
		if err != nil {
			t.Fatalf("MarshalCompactJSON error: %v", err)
		}
		want := `{"lineSep":"a` + ls + `b` + ps + `c",` +
			`"literal":"d\\u2028e",` +
			`"mixed":"f\\u2029g` + ls + `h"}`
		if string(got) != want {
			t.Fatalf("MarshalCompactJSON =\n%q\nwant\n%q", got, want)
		}
	})

	t.Run("reports a value that cannot be encoded", func(t *testing.T) {
		if _, err := MarshalCompactJSON(struct{ C chan int }{}); err == nil {
			t.Fatal("MarshalCompactJSON of a chan field = nil error, want the encoding error")
		}
	})
}

func TestMarshalIndentJSON(t *testing.T) {
	// State files must stay byte-identical to JavaScript's JSON.stringify(v, null, 2) output.
	t.Run("writes U+2028 and U+2029 raw and keeps literal backslash-u2028 text", func(t *testing.T) {
		ls, ps := string(rune(0x2028)), string(rune(0x2029))
		value := struct {
			LineSep string `json:"lineSep"`
			Literal string `json:"literal"`
			Mixed   string `json:"mixed"`
		}{
			LineSep: "a" + ls + "b" + ps + "c",
			Literal: "d" + `\` + "u2028e",
			Mixed:   "f" + `\` + "u2029g" + ls + "h",
		}
		got, err := MarshalIndentJSON(value)
		if err != nil {
			t.Fatalf("MarshalIndentJSON error: %v", err)
		}
		want := "{\n" +
			"  \"lineSep\": \"a" + ls + "b" + ps + "c\",\n" +
			"  \"literal\": \"d\\\\u2028e\",\n" +
			"  \"mixed\": \"f\\\\u2029g" + ls + "h\"\n" +
			"}\n"
		if string(got) != want {
			t.Fatalf("MarshalIndentJSON =\n%q\nwant\n%q", got, want)
		}
	})

	t.Run("reports a value that cannot be encoded", func(t *testing.T) {
		if _, err := MarshalIndentJSON(struct{ C chan int }{}); err == nil {
			t.Fatal("MarshalIndentJSON of a chan field = nil error, want the encoding error")
		}
	})
}
