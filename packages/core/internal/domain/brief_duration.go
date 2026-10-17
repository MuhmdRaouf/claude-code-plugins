package domain

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

var durationUnits = regexp.MustCompile(`^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$`)
var durationMilliseconds = regexp.MustCompile(`^\d+$`)

const (
	msPerHour   = 3_600_000
	msPerMinute = 60_000
	msPerSecond = 1_000
)

// DurationError is the message a bad duration fails with, word for word as the CLI prints it.
type DurationError string

func (e DurationError) Error() string { return string(e) }

// ParseDuration parses "90s", "15m", "2h", "1h30m" or a bare number of milliseconds. A JS
// `number` input is milliseconds; the YAML decoder hands over a string, an int or a float64.
func ParseDuration(text any) (int64, error) {
	switch value := text.(type) {
	case string:
		return parseDurationText(value)
	case int:
		return positiveDurationMs(int64(value), strconv.Itoa(value))
	case int64:
		return positiveDurationMs(value, strconv.FormatInt(value, 10))
	case float64:
		return positiveFloatMs(value, formatDurationNumber(value))
	default:
		return 0, invalidDuration(fmt.Sprint(text))
	}
}

func parseDurationText(text string) (int64, error) {
	trimmed := strings.TrimSpace(text)
	if durationMilliseconds.MatchString(trimmed) {
		ms, err := strconv.ParseInt(trimmed, 10, 64)
		if err != nil {
			return 0, invalidDuration(text)
		}
		return positiveDurationMs(ms, text)
	}
	match := durationUnits.FindStringSubmatch(trimmed)
	if match == nil {
		return 0, invalidDuration(text)
	}
	// Summed in float64: groups that fit a digit string can still overflow int64 when scaled.
	ms := durationGroupMs(match[1], msPerHour) +
		durationGroupMs(match[2], msPerMinute) +
		durationGroupMs(match[3], msPerSecond)
	return positiveFloatMs(ms, text)
}

// durationGroupMs scales one h/m/s group. A digit string that overflows a float becomes +Inf,
// as JS Number() gives Infinity; both then fail positiveFloatMs's safe-integer check.
func durationGroupMs(group string, scale float64) float64 {
	if group == "" {
		return 0
	}
	digits, err := strconv.ParseFloat(group, 64)
	if err != nil {
		return math.Inf(1)
	}
	return digits * scale
}

func positiveDurationMs(ms int64, text string) (int64, error) {
	if ms > 0 && ms <= jsMaxSafeInteger {
		return ms, nil
	}
	return 0, invalidDuration(text)
}

func positiveFloatMs(ms float64, text string) (int64, error) {
	if ms > 0 && ms <= jsMaxSafeInteger && ms == math.Trunc(ms) {
		return int64(ms), nil
	}
	return 0, invalidDuration(text)
}

// formatDurationNumber renders a number the way JS String(number) does, for the error message.
func formatDurationNumber(value float64) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if value == math.Trunc(value) && math.Abs(value) < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	return strconv.FormatFloat(value, 'g', -1, 64)
}

func invalidDuration(text string) error {
	return DurationError(`invalid duration "` + text + `": use a positive whole number of milliseconds or h/m/s units like 90s, 15m, 2h, 1h30m`)
}
