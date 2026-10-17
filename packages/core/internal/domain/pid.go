package domain

import (
	"strconv"
	"strings"
)

// jsMaxSafeInteger is JavaScript's Number.isSafeInteger bound (2^53-1): pids and durations read
// from files and front matter are JavaScript doubles, and a wider value would not read back
// exactly.
const jsMaxSafeInteger = 9_007_199_254_740_991

// ParsePid reads a process id from a pid or lock file: digits only, and never 0 or 1 (0 would
// signal our own group, 1 is init, which no lock of ours is ever held by).
func ParsePid(text string) (int64, bool) {
	trimmed := strings.TrimSpace(text)
	if !onlyDigits(trimmed) {
		return 0, false
	}
	pid, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil {
		return 0, false
	}
	if pid > 1 && pid <= jsMaxSafeInteger {
		return pid, true
	}
	return 0, false
}

func onlyDigits(text string) bool {
	if text == "" {
		return false
	}
	for _, r := range text {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
