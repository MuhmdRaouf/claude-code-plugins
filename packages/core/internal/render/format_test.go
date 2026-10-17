package render

import (
	"math"
	"reflect"
	"slices"
	"strconv"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// jsNumber is ECMAScript's Number::toString: exactly what a JS template literal interpolates and
// what JSON.stringify writes for a number. The table pins every branch: plain notation between
// 1e-6 and 1e21, exponent notation outside, shortest round-trip digits, no leading zeros in the
// exponent and a "+" on positive exponents.
func TestJSNumber(t *testing.T) {
	// The additions and divisions below run through variables: Go constant-folds untyped
	// constants exactly and rounds once, where JS rounds every operation.
	tenth := 0.1
	cases := []struct {
		in   float64
		want string
	}{
		{0, "0"},
		{0.004, "0.004"},
		{0.005, "0.005"},
		{1.005, "1.005"},
		{1234567.891, "1234567.891"},
		{-1, "-1"},
		{1e21, "1e+21"},
		{1e-7, "1e-7"},
		{1e-6, "0.000001"},
		{1e-5, "0.00001"},
		{tenth + 0.2, "0.30000000000000004"},
		{1e15, "1000000000000000"},
		{999999, "999999"},
		{100, "100"},
		{1200, "1200"},
		{310, "310"},
		{2.5, "2.5"},
		{-1.5, "-1.5"},
		{100000.0 / 1000, "100"},
		{512000.0 / 1000, "512"},
		{100000.0 / 1000000, "0.1"},
		{1234567.0 / 1000000, "1.234567"},
		{math.NaN(), "NaN"},
		{math.Inf(1), "Infinity"},
		{math.Inf(-1), "-Infinity"},
	}
	for _, c := range cases {
		if got := jsNumber(c.in); got != c.want {
			t.Errorf("jsNumber(%s): got %q, want %q", strconv.FormatFloat(c.in, 'g', -1, 64), got, c.want)
		}
	}
	if got := jsNumber(math.Copysign(0, -1)); got != "0" {
		t.Errorf("jsNumber(-0): got %q, want %q", got, "0")
	}
}

// jsToFixed is ECMAScript's Number.prototype.toFixed: the exact binary value rounded to the
// requested decimals, ties away from zero (V8 negates first), the sign kept even on "-0.00", and
// the plain Number::toString form from 1e21 up.
func TestJSToFixed(t *testing.T) {
	cases := []struct {
		in     float64
		digits int
		want   string
	}{
		{0, 2, "0.00"},
		{0.004, 2, "0.00"},
		{0.005, 2, "0.01"},
		{1.005, 2, "1.00"},
		{1234567.891, 2, "1234567.89"},
		{1234567.891, 4, "1234567.8910"},
		{1234567.891, 1, "1234567.9"},
		{-1, 2, "-1.00"},
		{1e21, 2, "1e+21"},
		{-1e21, 2, "-1e+21"},
		{1e20, 2, "100000000000000000000.00"},
		{1e-7, 2, "0.00"},
		{9.999, 1, "10.0"},
		{0.05, 1, "0.1"},
		{0.15, 1, "0.1"},
		{0.35, 1, "0.3"},
		{2.675, 2, "2.67"},
		{2.5, 0, "3"},
		{-2.5, 0, "-3"},
		{-0.004, 2, "-0.00"},
		{0.0123, 4, "0.0123"},
		{3.456, 2, "3.46"},
		{42.13, 1, "42.1"},
		{0.1, 1, "0.1"},
		{1e15, 1, "1000000000000000.0"},
		{math.NaN(), 2, "NaN"},
		{math.Inf(1), 2, "Infinity"},
		{math.Inf(-1), 2, "-Infinity"},
	}
	for _, c := range cases {
		if got := jsToFixed(c.in, c.digits); got != c.want {
			t.Errorf("jsToFixed(%v, %d): got %q, want %q", c.in, c.digits, got, c.want)
		}
	}
	if got := jsToFixed(math.Copysign(0, -1), 2); got != "0.00" {
		t.Errorf("jsToFixed(-0, 2): got %q, want %q", got, "0.00")
	}
}

// jsRound is Math.round: the nearest integer with halves toward positive infinity.
func TestJSRound(t *testing.T) {
	rate := 1.6666
	cases := []struct {
		in   float64
		want float64
	}{
		{0.4, 0},
		{0.5, 1},
		{2.5, 3},
		{-0.5, 0},
		{-1.5, -1},
		{166.66, 167},
		{rate * 100, 167},
	}
	for _, c := range cases {
		if got := jsRound(c.in); got != c.want {
			t.Errorf("jsRound(%v): got %v, want %v", c.in, got, c.want)
		}
	}
}

// utf16Slice is JS slice over UTF-16 code units: negative indexes count from the end, indexes
// clamp to the string, and a cut splitting a surrogate pair leaves the lone half, which decodes
// to U+FFFD.
func TestUTF16Slice(t *testing.T) {
	const s = "a😀b" // UTF-16 units: 'a', D83D, DE00, 'b'
	cases := []struct {
		start, end int64
		want       string
	}{
		{0, 4, s},
		{0, 1, "a"},
		{1, 3, "😀"},
		{0, 2, "a�"},
		{3, 4, "b"},
		{0, -1, "a😀"},
		{-2, -1, "�"},
		{0, 0, ""},
		{2, 1, ""},
		{5, 9, ""},
		{0, 99, s},
		{-99, 1, "a"},
	}
	for _, c := range cases {
		if got := utf16Slice(s, c.start, c.end); got != c.want {
			t.Errorf("utf16Slice(%d, %d): got %q, want %q", c.start, c.end, got, c.want)
		}
	}
}

func TestAgoGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "ago") {
		input := inputOf[struct {
			FromISO string `json:"fromIso"`
			Now     int64  `json:"now"`
		}](t, row)
		checkString(t, i, Ago(input.FromISO, input.Now), row.Output)
	}
}

func TestDurationGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "duration") {
		input := inputOf[struct {
			MS float64 `json:"ms"`
		}](t, row)
		checkString(t, i, Duration(input.MS), row.Output)
	}
}

func TestCountGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "count") {
		input := inputOf[struct {
			N float64 `json:"n"`
		}](t, row)
		checkString(t, i, Count(input.N), row.Output)
	}
}

func TestUsdGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "usd") {
		input := inputOf[struct {
			Amount float64 `json:"amount"`
		}](t, row)
		checkString(t, i, Usd(input.Amount), row.Output)
	}
}

func TestPercentGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "percent") {
		input := inputOf[struct {
			Rate *float64 `json:"rate"`
		}](t, row)
		checkString(t, i, Percent(input.Rate), row.Output)
	}
}

func TestPluralGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "plural") {
		input := inputOf[struct {
			N     int64   `json:"n"`
			Noun  string  `json:"noun"`
			Nouns *string `json:"nouns"`
		}](t, row)
		if input.Nouns == nil {
			checkString(t, i, Plural(input.N, input.Noun), row.Output)
			continue
		}
		checkString(t, i, Plural(input.N, input.Noun, *input.Nouns), row.Output)
	}
}

func TestOneLineGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "oneline") {
		input := inputOf[struct {
			Text string `json:"text"`
			Max  int64  `json:"max"`
		}](t, row)
		checkString(t, i, OneLine(input.Text, input.Max), row.Output)
	}
}

func TestTableGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "table") {
		input := inputOf[struct {
			Rows [][]string `json:"rows"`
		}](t, row)
		want := outputOf[[]string](t, row.Output)
		if got := Table(input.Rows); !slices.Equal(got, want) {
			t.Errorf("row %d:\ngot  %q\nwant %q", i, got, want)
		}
	}
}

func TestModelIDGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "modelid") {
		input := inputOf[jobInput](t, row)
		checkString(t, i, ModelID(providerOf(t, input.Provider), input.Job), row.Output)
	}
}

func TestLastAttemptGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "lastattempt") {
		input := inputOf[struct {
			Job domain.Job `json:"job"`
		}](t, row)
		got := LastAttempt(input.Job)
		want := outputOf[*domain.Attempt](t, row.Output)
		switch {
		case got == nil && want == nil:
		case got == nil || want == nil:
			t.Errorf("row %d: got %v, want %v", i, got, want)
		default:
			if !reflect.DeepEqual(*got, *want) {
				t.Errorf("row %d:\ngot  %#v\nwant %#v", i, *got, *want)
			}
		}
	}
}

func TestVerdictOfGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "verdictof") {
		input := inputOf[struct {
			Job domain.Job `json:"job"`
		}](t, row)
		checkString(t, i, VerdictOf(input.Job), row.Output)
	}
}

func TestOutcomeTextGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "outcometext") {
		input := inputOf[struct {
			Outcome domain.WorkerOutcome `json:"outcome"`
		}](t, row)
		checkString(t, i, OutcomeText(input.Outcome), row.Output)
	}
}

func TestProgressTextGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "progresstext") {
		input := inputOf[struct {
			Progress domain.Progress `json:"progress"`
		}](t, row)
		checkString(t, i, ProgressText(input.Progress), row.Output)
	}
}
