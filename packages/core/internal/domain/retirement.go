// When a retired router exits. A router retires when its plugin is removed (setup --remove, an uninstall or a disable):
// Claude Code sessions read ANTHROPIC_BASE_URL once at start, so every session already open keeps sending to the
// router until it exits. The router therefore stays up, as a passthrough, while any `claude` process that started
// before the retirement still runs, and never longer than 7 days. Pure: the process list comes in as data.
package domain

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// RetiredMaxMs is the longest a retired router stays up, whatever runs: 7 days.
const RetiredMaxMs int64 = 7 * 24 * 60 * 60_000

// RetiredCheckMs is how often a retired router looks at the process list: 30 s.
const RetiredCheckMs int64 = 30_000

// ProcessStart is one running process: its pid, its start time (epoch ms, to the second) and its command line.
type ProcessStart struct {
	Pid       int64
	StartedAt int64
	Command   string
}

// RetiredExitInput is what retiredExit decides on.
type RetiredExitInput struct {
	RetiredAt int64
	Now       int64
	// Processes is the running processes, or nil when the list could not be read (then only the cap ends the wait).
	Processes *[]ProcessStart
	MaxMs     *int64
}

// RetiredAction is retiredExit's answer: stay up, or exit now.
type RetiredAction string

const (
	RetiredActionStay RetiredAction = "stay"
	RetiredActionExit RetiredAction = "exit"
)

// IsClaudeCode reports whether a command line is a Claude Code session: its program is named `claude` (the native
// install, or the npm bin), or it runs the npm package's entry point under node or bun. The command line, not the
// process name: Linux names a Node process's main thread `MainThread`. The desktop app's `Claude` never matches.
func IsClaudeCode(commandLine string) bool {
	fields := commandFields(commandLine)
	if len(fields) == 0 {
		return false
	}
	if commandBase(fields[0]) == "claude" {
		return true
	}
	for _, arg := range fields[1:] {
		if npmCliPattern.MatchString(arg) {
			return true
		}
	}
	return false
}

var npmCliPattern = regexp.MustCompile(`/@anthropic-ai/claude-code/cli\.m?js$`)

// commandFields splits a trimmed command line on JavaScript's whitespace (split(/\s+/)): a line of
// only whitespace yields no fields, and the empty string leaves the program at "".
func commandFields(line string) []string {
	return strings.FieldsFunc(line, isJsSpace)
}

func commandBase(program string) string {
	if i := strings.LastIndexByte(program, '/'); i >= 0 {
		return program[i+1:]
	}
	return program
}

// ClaudeFromBefore reports whether a `claude` executable started at or before the retirement still runs. `ps` reports
// start times to the second, so a session started in the same second as the retirement counts as older: the router
// waits for it.
func ClaudeFromBefore(processes []ProcessStart, retiredAt int64) bool {
	retiredSecond := floorToSecond(retiredAt)
	for _, process := range processes {
		if IsClaudeCode(process.Command) && process.StartedAt <= retiredSecond {
			return true
		}
	}
	return false
}

// floorToSecond is Math.floor(ms / 1000) * 1000, flooring (not truncating) towards negative infinity.
func floorToSecond(ms int64) int64 {
	seconds := ms / 1000
	if ms%1000 != 0 && ms < 0 {
		seconds--
	}
	return seconds * 1000
}

// RetiredExit is "exit" once the cap has passed, or once no `claude` process from before the retirement is left.
func RetiredExit(input RetiredExitInput) RetiredAction {
	maxMs := RetiredMaxMs
	if input.MaxMs != nil {
		maxMs = *input.MaxMs
	}
	if input.Now-input.RetiredAt >= maxMs {
		return RetiredActionExit
	}
	if input.Processes == nil {
		return RetiredActionStay
	}
	if ClaudeFromBefore(*input.Processes, input.RetiredAt) {
		return RetiredActionStay
	}
	return RetiredActionExit
}

var retiredMonths = []string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}

// psLine matches `<pid> <weekday> <month> <day> <hh>:<mm>:<ss> <year> <command>`, as `ps -axo pid=,lstart=,args=`
// prints it under LC_ALL=C on macOS and Linux (ASCII whitespace only).
var psLine = regexp.MustCompile(
	`^\s*(\d+)\s+[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+?)\s*$`)

// ParseProcessList is the processes in `ps -axo pid=,lstart=,args=` output, start times read as local time; other
// lines are skipped.
func ParseProcessList(stdout string) []ProcessStart {
	var processes []ProcessStart
	for _, line := range strings.Split(stdout, "\n") {
		match := psLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		monthIndex := slices.Index(retiredMonths, match[2])
		pid, err := strconv.ParseInt(match[1], 10, 64)
		if monthIndex < 0 || err != nil {
			continue
		}
		year, _ := strconv.Atoi(match[7])
		day, _ := strconv.Atoi(match[3])
		hours, _ := strconv.Atoi(match[4])
		minutes, _ := strconv.Atoi(match[5])
		seconds, _ := strconv.Atoi(match[6])
		startedAt := time.Date(year, time.Month(monthIndex+1), day, hours, minutes, seconds, 0, time.Local).UnixMilli()
		processes = append(processes, ProcessStart{Pid: pid, StartedAt: startedAt, Command: match[8]})
	}
	return processes
}
