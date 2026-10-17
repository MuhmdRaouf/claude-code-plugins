package domain

import (
	"fmt"
	"math"
	"strings"
	"testing"
)

const durationHint = "use a positive whole number of milliseconds or h/m/s units like 90s, 15m, 2h, 1h30m"

// parseDuration's cases and exact messages; number inputs render the way JS String(number)
// does.
func TestParseDuration(t *testing.T) {
	t.Run("parses 90s, 15m, 2h and compound 1h30m into milliseconds", func(t *testing.T) {
		cases := []struct {
			text string
			ms   int64
		}{
			{"90s", 90_000},
			{"15m", 900_000},
			{"2h", 7_200_000},
			{"1h30m", 5_400_000},
			{"1h0m5s", 3_605_000},
			{"2m30s", 150_000},
			{" 45m ", 2_700_000},
			{"12h", 43_200_000},
			{"100m", 6_000_000},
		}
		for _, tc := range cases {
			ms, err := ParseDuration(tc.text)
			if err != nil || ms != tc.ms {
				t.Fatalf("parseDuration(%q) = (%d, %v), want %d", tc.text, ms, err, tc.ms)
			}
		}
	})

	t.Run("passes through a positive integer number of milliseconds", func(t *testing.T) {
		cases := []struct {
			input any
			ms    int64
		}{
			{1, 1},
			{5000, 5000},
			{"5000", 5000},
			// The YAML decoder can hand over an int64 as well as an int.
			{int64(60000), 60000},
			// A float that is a whole safe number of milliseconds parses too.
			{float64(2500), 2500},
			{float64(9007199254740991), 9007199254740991},
		}
		for _, tc := range cases {
			ms, err := ParseDuration(tc.input)
			if err != nil || ms != tc.ms {
				t.Fatalf("parseDuration(%#v) = (%d, %v), want %d", tc.input, ms, err, tc.ms)
			}
		}
	})

	t.Run("rejects empty, zero, negative, fractional units and unknown suffixes with a message", func(t *testing.T) {
		cases := []struct {
			name  string
			input any
			// The text the message quotes: JS String(input) for numbers.
			quoted string
		}{
			{"empty string", "", ""},
			{"spaces", "   ", "   "},
			{"zero string", "0", "0"},
			{"zero number", 0, "0"},
			{"0s", "0s", "0s"},
			{"0h0m", "0h0m", "0h0m"},
			{"negative number", -5, "-5"},
			{"-5m", "-5m", "-5m"},
			{"fractional number", 1.5, "1.5"},
			{"1.5h", "1.5h", "1.5h"},
			{"5d", "5d", "5d"},
			{"10ms", "10ms", "10ms"},
			{"m", "m", "m"},
			{"30m1h", "30m1h", "30m1h"},
			{"1 h", "1 h", "1 h"},
			{"Infinity", "Infinity", "Infinity"},
			{"1e3", "1e3", "1e3"},
			{"+5000", "+5000", "+5000"},
			{"0x10", "0x10", "0x10"},
			{"NaN", math.NaN(), "NaN"},
			{"a number too large for a safe integer", 1e21, "1e+21"},
			{"a milliseconds count too large for an int64", "99999999999999999999", "99999999999999999999"},
			{"a unit count that overflows a float, as JS gives Infinity", strings.Repeat("9", 400) + "h", strings.Repeat("9", 400) + "h"},
			{"a value that is neither string nor number", true, "true"},
		}
		for _, tc := range cases {
			ms, err := ParseDuration(tc.input)
			want := fmt.Sprintf("invalid duration %q: %s", tc.quoted, durationHint)
			if err == nil || err.Error() != want || ms != 0 {
				t.Fatalf("%s: parseDuration(%#v) = (%d, %v), want error %q", tc.name, tc.input, ms, err, want)
			}
		}
	})
}
