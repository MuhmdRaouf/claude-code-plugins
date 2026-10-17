package domain

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

var retirementRetiredAt = time.Date(2026, time.October, 8, 12, 0, 0, 400*int(time.Millisecond), time.Local).UnixMilli()

func retirementAt(offsetMs int64) int64 {
	return retirementRetiredAt + offsetMs
}

func retirementClaude(startedAt int64, command ...string) ProcessStart {
	commandLine := "claude"
	if len(command) > 0 {
		commandLine = command[0]
	}
	return ProcessStart{Pid: 1, StartedAt: startedAt, Command: commandLine}
}

func retirementProcesses(list ...ProcessStart) *[]ProcessStart {
	return &list
}

func retirementMaxMs(ms int64) *int64 {
	return &ms
}

func TestWhichProcessesAreClaudeCodeSessions(t *testing.T) {
	t.Run("matches the claude program, by any path, with its arguments", func(t *testing.T) {
		for _, commandLine := range []string{
			"claude",
			"/Users/me/.local/bin/claude --resume abc",
			"claude -p hello world",
		} {
			if !IsClaudeCode(commandLine) {
				t.Fatalf("IsClaudeCode(%q) = false, want true", commandLine)
			}
		}
	})

	t.Run("matches the npm package run under node or bun, whatever Linux names the process", func(t *testing.T) {
		for _, commandLine := range []string{
			"node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
			"/opt/bun/bin/bun /home/me/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.mjs",
		} {
			if !IsClaudeCode(commandLine) {
				t.Fatalf("IsClaudeCode(%q) = false, want true", commandLine)
			}
		}
	})

	t.Run("ignores the desktop app, look-alikes and programs that only mention claude", func(t *testing.T) {
		for _, commandLine := range []string{
			"/Applications/Claude.app/Contents/MacOS/Claude",
			"claude-helper",
			"grep claude",
			"node /srv/zai-router.js",
			"",
		} {
			if IsClaudeCode(commandLine) {
				t.Fatalf("IsClaudeCode(%q) = true, want false", commandLine)
			}
		}
	})
}

func TestWhenARetiredRouterExits(t *testing.T) {
	t.Run("stays while a claude process from before the retirement runs", func(t *testing.T) {
		input := RetiredExitInput{
			RetiredAt: retirementRetiredAt,
			Now:       retirementAt(60_000),
			Processes: retirementProcesses(retirementClaude(retirementAt(-3_600_000))),
		}
		if got := RetiredExit(input); got != RetiredActionStay {
			t.Fatalf("RetiredExit(%+v) = %q, want stay", input, got)
		}
		input = RetiredExitInput{
			RetiredAt: retirementRetiredAt,
			Now:       retirementAt(60_000),
			Processes: retirementProcesses(retirementClaude(retirementAt(-1000), "/Users/me/.local/bin/claude")),
		}
		if got := RetiredExit(input); got != RetiredActionStay {
			t.Fatalf("RetiredExit(%+v) = %q, want stay", input, got)
		}
	})

	t.Run("exits once only newer claude processes, or other programs, are left", func(t *testing.T) {
		input := RetiredExitInput{
			RetiredAt: retirementRetiredAt,
			Now:       retirementAt(60_000),
			Processes: retirementProcesses(),
		}
		if got := RetiredExit(input); got != RetiredActionExit {
			t.Fatalf("RetiredExit(%+v) = %q, want exit", input, got)
		}
		input = RetiredExitInput{
			RetiredAt: retirementRetiredAt,
			Now:       retirementAt(60_000),
			Processes: retirementProcesses(
				retirementClaude(retirementAt(5000)),
				retirementClaude(retirementAt(-5000), "Claude"),
				retirementClaude(retirementAt(-5000), "claude-helper"),
			),
		}
		if got := RetiredExit(input); got != RetiredActionExit {
			t.Fatalf("RetiredExit(%+v) = %q, want exit", input, got)
		}
	})

	t.Run("counts a claude started in the retirement's own second as older: ps reports whole seconds", func(t *testing.T) {
		sameSecond := retirementRetiredAt / 1000 * 1000
		if !ClaudeFromBefore([]ProcessStart{retirementClaude(sameSecond)}, retirementRetiredAt) {
			t.Fatal("ClaudeFromBefore(same second) = false, want true")
		}
		if ClaudeFromBefore([]ProcessStart{retirementClaude(sameSecond + 1000)}, retirementRetiredAt) {
			t.Fatal("ClaudeFromBefore(next second) = true, want false")
		}
	})

	t.Run("stays when the process list cannot be read, until the 7-day cap", func(t *testing.T) {
		unreadable := RetiredExitInput{RetiredAt: retirementRetiredAt, Now: retirementAt(60_000)}
		if got := RetiredExit(unreadable); got != RetiredActionStay {
			t.Fatalf("RetiredExit(%+v) = %q, want stay", unreadable, got)
		}
		beforeCap := RetiredExitInput{RetiredAt: retirementRetiredAt, Now: retirementAt(RetiredMaxMs - 1)}
		if got := RetiredExit(beforeCap); got != RetiredActionStay {
			t.Fatalf("RetiredExit(%+v) = %q, want stay", beforeCap, got)
		}
		atCap := RetiredExitInput{RetiredAt: retirementRetiredAt, Now: retirementAt(RetiredMaxMs)}
		if got := RetiredExit(atCap); got != RetiredActionExit {
			t.Fatalf("RetiredExit(%+v) = %q, want exit", atCap, got)
		}
		claudeAtCap := RetiredExitInput{
			RetiredAt: retirementRetiredAt,
			Now:       retirementAt(RetiredMaxMs),
			Processes: retirementProcesses(retirementClaude(retirementAt(-1000))),
		}
		if got := RetiredExit(claudeAtCap); got != RetiredActionExit {
			t.Fatalf("RetiredExit(%+v) = %q, want exit", claudeAtCap, got)
		}
		shortCap := RetiredExitInput{
			RetiredAt: retirementRetiredAt,
			Now:       retirementAt(100),
			Processes: retirementProcesses(retirementClaude(retirementAt(-1000))),
			MaxMs:     retirementMaxMs(100),
		}
		if got := RetiredExit(shortCap); got != RetiredActionExit {
			t.Fatalf("RetiredExit(%+v) = %q, want exit", shortCap, got)
		}
	})
}

// floorToSecond is Math.floor(ms / 1000) * 1000: it floors towards negative infinity, not towards zero.
func TestFloorToSecond(t *testing.T) {
	cases := []struct {
		ms   int64
		want int64
	}{
		{1791450000400, 1791450000000},
		{1791450000000, 1791450000000},
		{1500, 1000},
		{-1500, -2000},
		{-1000, -1000},
		{0, 0},
	}
	for _, tc := range cases {
		if got := floorToSecond(tc.ms); got != tc.want {
			t.Errorf("floorToSecond(%d) = %d, want %d", tc.ms, got, tc.want)
		}
	}
}

func TestReadingPs(t *testing.T) {
	t.Run("parses pid, local start time and the command, keeping spaces in a path", func(t *testing.T) {
		out := strings.Join([]string{
			" 3023 Thu Oct  8 16:28:43 2026     claude",
			"81812 Wed Oct  7 21:20:40 2026     /Applications/Some App.app/Contents/MacOS/Claude",
			"",
			"garbage line",
			"   12 Thu Foo  8 16:28:43 2026 x",
		}, "\n")
		got := ParseProcessList(out)
		want := []ProcessStart{
			{
				Pid:       3023,
				StartedAt: time.Date(2026, time.October, 8, 16, 28, 43, 0, time.Local).UnixMilli(),
				Command:   "claude",
			},
			{
				Pid:       81812,
				StartedAt: time.Date(2026, time.October, 7, 21, 20, 40, 0, time.Local).UnixMilli(),
				Command:   "/Applications/Some App.app/Contents/MacOS/Claude",
			},
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("ParseProcessList() = %#v, want %#v", got, want)
		}
	})
}
