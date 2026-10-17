// Package render holds the text renderers: plain ASCII layout, no colour, no ISO timestamps.
// Every number prints the way JavaScript prints it, byte for byte: jsNumber, jsToFixed and
// jsRound are ECMAScript's own number algorithms.
package render

import (
	"math"
	"math/big"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

// age is the coarse age: now, 5m, 3h, 2d. A date Date.parse cannot read yields "NaNd", the NaN
// a JavaScript template prints.
func age(fromISO string, now int64) string {
	parsed, ok := parseISO(fromISO)
	if !ok {
		return "NaNd"
	}
	ms := now - parsed.UnixMilli()
	if ms < 0 {
		ms = 0
	}
	if ms < minute {
		return "now"
	}
	if ms < hour {
		return strconv.FormatInt(ms/minute, 10) + "m"
	}
	if ms < day {
		return strconv.FormatInt(ms/hour, 10) + "h"
	}
	return strconv.FormatInt(ms/day, 10) + "d"
}

// parseISO reads the ISO shapes Date.parse meets here: a full timestamp with or without
// milliseconds and an offset, or a bare date.
func parseISO(value string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339, "2006-01-02"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

// Ago is the age as prose: "just now" or "5m ago / 3h ago / 2d ago".
func Ago(fromISO string, now int64) string {
	text := age(fromISO, now)
	if text == "now" {
		return "just now"
	}
	return text + " ago"
}

// Duration renders 1.2s, 42s, 3m05s, 1h02m.
func Duration(ms float64) string {
	if ms < 10_000 {
		return jsToFixed(ms/1000, 1) + "s"
	}
	s := jsRound(ms / 1000)
	if s < 60 {
		return jsNumber(s) + "s"
	}
	if s < 3600 {
		return jsNumber(math.Floor(s/60)) + "m" + pad2(math.Mod(s, 60)) + "s"
	}
	return jsNumber(math.Floor(s/3600)) + "h" + pad2(math.Floor(math.Mod(s, 3600)/60)) + "m"
}

// pad2 is String(n).padStart(2, "0").
func pad2(n float64) string {
	text := jsNumber(n)
	if len(text) < 2 {
		return "0" + text
	}
	return text
}

// Count renders 310, 4.2k, 1.2M.
func Count(n float64) string {
	if n < 1000 {
		return jsNumber(n)
	}
	if n < 1_000_000 {
		return jsToFixed(n/1000, 1) + "k"
	}
	return jsToFixed(n/1_000_000, 1) + "M"
}

// Usd renders an amount as dollars, two decimals from 1 up and four below.
func Usd(amount float64) string {
	digits := 4
	if amount >= 1 {
		digits = 2
	}
	return "$" + jsToFixed(amount, digits)
}

// Percent renders a rate as a whole percent, or n/a for no rate. The explicit conversion keeps
// the product out of jsRound's +0.5, so the two round separately as Math.round(x*100) does in JS.
func Percent(rate *float64) string {
	if rate == nil {
		return "n/a"
	}
	return jsNumber(jsRound(float64(*rate*100))) + "%"
}

// Plural renders "1 attempt" / "2 attempts"; nouns overrides the plural form.
func Plural(n int64, noun string, nouns ...string) string {
	pluralForm := noun + "s"
	if len(nouns) > 0 {
		pluralForm = nouns[0]
	}
	if n == 1 {
		return strconv.FormatInt(n, 10) + " " + noun
	}
	return strconv.FormatInt(n, 10) + " " + pluralForm
}

// jsSpace is one char of JS `\s`: Go's space set minus NEL, plus the BOM.
func jsSpace(r rune) bool {
	return r == 0xFEFF || (unicode.IsSpace(r) && r != 0x85)
}

// OneLine collapses whitespace to single spaces and cuts to max UTF-16 code units. A max of 0
// cuts one char, as slice(0, -1) does in JS.
func OneLine(text string, max int64) string {
	var flat strings.Builder
	space := false
	for _, r := range text {
		if jsSpace(r) {
			space = true
			continue
		}
		if space && flat.Len() > 0 {
			flat.WriteByte(' ')
		}
		space = false
		flat.WriteRune(r)
	}
	collapsed := strings.TrimFunc(flat.String(), jsSpace)
	if int64(utf16Len(collapsed)) <= max {
		return collapsed
	}
	return utf16Slice(collapsed, 0, max-1) + "…"
}

// Table pads columns to their widest cell, two spaces apart; the last column is not padded.
func Table(rows [][]string) []string {
	widths := []int{}
	for _, row := range rows {
		for i, cell := range row {
			for len(widths) <= i {
				widths = append(widths, 0)
			}
			if w := utf16Len(cell); w > widths[i] {
				widths[i] = w
			}
		}
	}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		cells := make([]string, len(row))
		for i, cell := range row {
			if i == len(row)-1 {
				cells[i] = cell
				continue
			}
			width := 0
			if i < len(widths) {
				width = widths[i]
			}
			cells[i] = padEndUTF16(cell, width)
		}
		out = append(out, strings.TrimRightFunc(strings.Join(cells, "  "), jsSpace))
	}
	return out
}

// padEndUTF16 pads a cell with spaces to width, counting UTF-16 code units as JS padEnd does.
func padEndUTF16(cell string, width int) string {
	pad := width - utf16Len(cell)
	if pad <= 0 {
		return cell
	}
	return cell + strings.Repeat(" ", pad)
}

// utf16Len is the string's length in UTF-16 code units, the unit JS length counts.
func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

// utf16Slice is JS String.prototype.slice over UTF-16 code units; negative indexes count from the
// end. A cut splitting a surrogate pair leaves what utf16.Decode makes of the lone half (U+FFFD):
// a lone surrogate has no other written form.
func utf16Slice(s string, start, end int64) string {
	units := utf16.Encode([]rune(s))
	length := int64(len(units))
	if start < 0 {
		start += length
		if start < 0 {
			start = 0
		}
	}
	if start > length {
		start = length
	}
	if end < 0 {
		end += length
		if end < 0 {
			end = 0
		}
	}
	if end > length {
		end = length
	}
	if start >= end {
		return ""
	}
	return string(utf16.Decode(units[start:end]))
}

// ModelID is the model a job's brief names, from the provider's catalog.
func ModelID(provider domain.Provider, job domain.Job) string {
	return provider.Catalog[job.Brief.Model].ID
}

// LastAttempt is the job's latest attempt, or nil when it has none.
func LastAttempt(job domain.Job) *domain.Attempt {
	if len(job.Attempts) == 0 {
		return nil
	}
	return &job.Attempts[len(job.Attempts)-1]
}

// VerdictOf is the latest attempt's verdict, or "no verdict".
func VerdictOf(job domain.Job) string {
	last := LastAttempt(job)
	if last == nil || last.Verdict == nil {
		return "no verdict"
	}
	return string(*last.Verdict)
}

// OutcomeText is the worker's outcome when it did not simply complete.
func OutcomeText(outcome domain.WorkerOutcome) string {
	switch outcome.Kind {
	case domain.WorkerOutcomeCompleted:
		return "completed"
	case domain.WorkerOutcomeAPIError:
		prefix := "API error"
		if outcome.Quota != nil && *outcome.Quota {
			prefix = "out of balance or quota"
		}
		status := ""
		if outcome.Status != nil {
			status = " (" + strconv.FormatInt(*outcome.Status, 10) + ")"
		}
		return prefix + status + ": " + OneLine(outcome.Message, 200)
	case domain.WorkerOutcomeCrashed:
		how := "signal "
		if outcome.Signal == nil {
			code := "?"
			if outcome.ExitCode != nil {
				code = strconv.FormatInt(*outcome.ExitCode, 10)
			}
			how = "exit " + code
		} else {
			how += *outcome.Signal
		}
		text := "crashed (" + how + ")"
		if tail := OneLine(outcome.StderrTail, 200); tail != "" {
			text += ": " + tail
		}
		return text
	case domain.WorkerOutcomeTimeout:
		return "timed out"
	default:
		return "stopped on request"
	}
}

// ProgressText is one line of live progress: what the worker is doing, tool calls, rate limiting.
func ProgressText(progress domain.Progress) string {
	doing := strings.Replace(string(progress.Phase), "_", " ", 1)
	if progress.Phase == domain.ProgressPhaseTool && progress.LastTool != nil {
		doing = "tool " + *progress.LastTool
	}
	parts := []string{doing}
	if progress.ToolCalls != 0 {
		text := Plural(progress.ToolCalls, "tool call")
		if progress.ToolErrors != 0 {
			text += " (" + strconv.FormatInt(progress.ToolErrors, 10) + " failed)"
		}
		parts = append(parts, text)
	}
	if progress.RateLimitRetries != 0 {
		parts = append(parts, Plural(progress.RateLimitRetries, "rate-limit retry", "rate-limit retries"))
	}
	return strings.Join(parts, " · ")
}

// jsNumber formats a float64 exactly as ECMAScript's Number::toString does — what a JS template
// literal interpolates: the shortest decimal that round-trips, plain notation for 1e-6 ≤ |x| < 1e21,
// exponent notation outside, and a "+" with no leading zeros in a positive exponent.
func jsNumber(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if f == 0 {
		return "0"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	// The shortest round-trip digits and base-10 exponent, read off Go's own shortest e-form.
	e := strconv.FormatFloat(f, 'e', -1, 64)
	negative := strings.HasPrefix(e, "-")
	e = strings.TrimPrefix(e, "-")
	mantissa, exponent, _ := strings.Cut(e, "e")
	exp, _ := strconv.Atoi(exponent)
	digits := strings.Replace(mantissa, ".", "", 1)
	k := len(digits)
	n := exp + 1

	var out strings.Builder
	if negative {
		out.WriteString("-")
	}
	switch {
	case k <= n && n <= 21:
		out.WriteString(digits)
		out.WriteString(strings.Repeat("0", n-k))
	case 0 < n && n <= 21:
		out.WriteString(digits[:n])
		out.WriteString(".")
		out.WriteString(digits[n:])
	case -6 < n && n <= 0:
		out.WriteString("0.")
		out.WriteString(strings.Repeat("0", -n))
		out.WriteString(digits)
	default:
		out.WriteByte(digits[0])
		if k > 1 {
			out.WriteString(".")
			out.WriteString(digits[1:])
		}
		out.WriteString("e")
		if n-1 >= 0 {
			out.WriteString("+")
		} else {
			out.WriteString("-")
		}
		out.WriteString(strconv.Itoa(abs(n - 1)))
	}
	return out.String()
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// jsToFixed formats a float64 exactly as ECMAScript's Number.prototype.toFixed: the exact binary
// value rounded to digits decimals with ties away from zero (V8 negates first, so -2.5 fixes to
// -3), the sign kept even on a zero result ("-0.00"), and the plain jsNumber form from 1e21 up,
// where toFixed stops fixing.
func jsToFixed(f float64, digits int) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	if f >= 1e21 || f <= -1e21 {
		return jsNumber(f)
	}
	negative := f < 0
	rat := new(big.Rat).SetFloat64(f)
	scaled := new(big.Int).Mul(new(big.Int).Abs(rat.Num()), pow10(digits))
	quotient, remainder := new(big.Int).QuoRem(scaled, rat.Denom(), new(big.Int))
	// Ties away from zero: |x|·10^digits is exactly halfway (2·remainder = denominator) rounds up.
	if new(big.Int).Lsh(remainder, 1).Cmp(rat.Denom()) >= 0 {
		quotient.Add(quotient, big.NewInt(1))
	}
	text := quotient.String()
	if len(text) <= digits {
		text = strings.Repeat("0", digits-len(text)+1) + text
	}
	out := text[:len(text)-digits]
	if digits > 0 {
		out += "." + text[len(text)-digits:]
	}
	if negative {
		return "-" + out
	}
	return out
}

// pow10 is 10^digits, for the toFixed shift.
func pow10(digits int) *big.Int {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)
}

// jsRound is Math.round: the nearest integer, halves toward positive infinity.
func jsRound(f float64) float64 {
	return math.Floor(f + 0.5)
}
