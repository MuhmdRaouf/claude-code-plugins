package adapters

import (
	"context"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// The shell gates: `sh -c <command>` in its own process group, with ENV_ALLOWLIST + passEnv, the
// full output in the gate log, and the last 60 lines / 8000 chars kept as the tail.

const (
	// hostTailLines is how many lines of the tail a GateResult keeps.
	hostTailLines = 60
	// hostTailChars is how many UTF-16 chars of the tail a GateResult keeps.
	hostTailChars = 8000
	// SIGTERM first; whatever is still alive this long after a timeout gets SIGKILL.
	hostKillGraceMs = 2000
	// After the shell exits, how long a stray holder of its pipes may delay the result.
	hostDrainMs = 1000
)

// LastLines is the last count lines of text (a trailing newline does not start an extra line).
// Lines are counted in UTF-16 code units, the units JS strings are made of.
func LastLines(text string, count int) string {
	return string(utf16.Decode(hostLastLines(utf16.Encode([]rune(text)), count)))
}

// hostLastLines is LastLines over UTF-16 code units.
func hostLastLines(text []uint16, count int) []uint16 {
	start := len(text)
	if len(text) > 0 && text[len(text)-1] == '\n' {
		start--
	}
	for line := 0; line < count; line++ {
		if start <= 0 {
			return text
		}
		newline := -1
		for i := start - 1; i >= 0; i-- {
			if text[i] == '\n' {
				newline = i
				break
			}
		}
		if newline < 0 {
			return text
		}
		start = newline
	}
	return text[start+1:]
}

// hostGateTail is the rolling window over combined output: enough to cut the final tail from,
// never the whole output in memory.
type hostGateTail struct{ units []uint16 }

func (t *hostGateTail) push(text string) {
	t.units = append(t.units, utf16.Encode([]rune(text))...)
	if len(t.units) > 2*hostTailChars {
		t.units = t.units[len(t.units)-hostTailChars:]
	}
}

func (t *hostGateTail) value() string {
	window := t.units
	if len(window) > hostTailChars {
		window = window[len(window)-hostTailChars:]
	}
	return string(utf16.Decode(hostLastLines(window, hostTailLines)))
}

// hostGateEnv is ENV_ALLOWLIST from the process environment plus passEnv.
func hostGateEnv(passEnv map[string]string) []string {
	parent := domain.EnvLookup{}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		parent[name] = value
	}
	merged := PickAllowlisted(parent)
	for name, value := range passEnv {
		merged[name] = value
	}
	names := make([]string, 0, len(merged))
	for name := range merged {
		names = append(names, name)
	}
	sort.Strings(names)
	env := make([]string, 0, len(names))
	for _, name := range names {
		env = append(env, name+"="+merged[name])
	}
	return env
}

// hostGateShell is the gate's command: `sh -c <run>`, on every platform — the gate commands are
// sh syntax (the regenerate commands, the POSIX predicates), which cmd cannot parse.
func hostGateShell(run string) (string, []string) { return "sh", []string{"-c", run} }

// hostGateExit is how a gate ended: the shell's exit code (nil when a signal killed it), whether
// the timeout fired, and the spawn failure when there was one.
type hostGateExit struct {
	code     *int64
	timedOut bool
}

// CreateShellGates returns provider's gate runner. Gates run as `sh -c` in their own process
// group with ENV_ALLOWLIST + passEnv; the full output goes to the gate log, and the tail kept in
// GateResult is the last 60 lines / 8000 chars. A gate that cannot start says so under provider's
// name.
func CreateShellGates(provider string) ports.GateRunner {
	return hostShellGates{provider: provider}
}

type hostShellGates struct{ provider string }

func (g hostShellGates) Run(_ context.Context, cwd string, gate domain.Gate, passEnv map[string]string, logPath string) domain.GateResult {
	started := time.Now()
	// An unwritable log must not fail the gate; the tail still reaches the result.
	_ = os.MkdirAll(filepath.Dir(logPath), 0o755)
	log, _ := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	tail := &hostGateTail{}

	name, args := hostGateShell(gate.Run)
	result := func(code *int64, timedOut bool) domain.GateResult {
		if log != nil {
			log.Close()
		}
		if timedOut {
			code = nil
		}
		return domain.GateResult{
			Run:        gate.Run,
			ExitCode:   code,
			TimedOut:   timedOut,
			DurationMs: int64(math.Round(float64(time.Since(started).Nanoseconds()) / 1e6)),
			Tail:       tail.value(),
		}
	}

	child := exec.Command(name, args...)
	child.Dir = cwd
	child.Env = hostGateEnv(passEnv)
	child.SysProcAttr = hostGateAttr()
	readEnd, writeEnd, err := os.Pipe()
	if err != nil {
		return result(hostSpawnFailed(g.provider, name, err, log, tail), false)
	}
	// One pipe for both streams: the log and the tail see combined output in write order.
	child.Stdout = writeEnd
	child.Stderr = writeEnd
	if startErr := child.Start(); startErr != nil {
		readEnd.Close()
		writeEnd.Close()
		return result(hostSpawnFailed(g.provider, name, startErr, log, tail), false)
	}
	// The parent keeps only its read end; the child holds its own copy of the write end.
	writeEnd.Close()

	exit := hostAwaitGate(child, readEnd, gate.TimeoutMs, log, tail)
	return result(exit.code, exit.timedOut)
}

// hostSpawnFailed writes the spawn failure into the log and the tail, and is the null exit code
// a failed spawn resolves with.
func hostSpawnFailed(provider, command string, err error, log *os.File, tail *hostGateTail) *int64 {
	reason := err.Error()
	if code := fsutil.ErrnoCode(err); code != "" {
		reason = "spawn " + command + " " + code
	}
	message := provider + ": could not start gate: " + reason + "\n"
	if log != nil {
		_, _ = log.WriteString(message)
	}
	tail.push(message)
	return nil
}

// hostAwaitGate resolves once the shell has exited and its output is drained. On timeout the group
// gets SIGTERM, then SIGKILL after the grace period; after a normal exit, leftovers of the group
// (background jobs) are killed too. Node's exit event always precedes close, so the exit is waited
// first and the drain window only bounds the pipes afterwards.
func hostAwaitGate(child *exec.Cmd, readEnd *os.File, timeoutMs int64, log *os.File, tail *hostGateTail) hostGateExit {
	readerDone := make(chan struct{})
	go hostReadGate(readEnd, log, tail, readerDone)

	stop := make(chan struct{})
	var timedOut atomic.Bool
	pid := int64(child.Process.Pid)
	go func() {
		timer := time.NewTimer(time.Duration(timeoutMs) * time.Millisecond)
		defer timer.Stop()
		select {
		case <-timer.C:
			timedOut.Store(true)
			process.SignalGroup(pid, syscall.SIGTERM)
			kill := time.NewTimer(time.Duration(hostKillGraceMs) * time.Millisecond)
			defer kill.Stop()
			select {
			case <-kill.C:
				process.SignalGroup(pid, syscall.SIGKILL)
			case <-stop:
			}
		case <-stop:
		}
	}()

	waitDone := make(chan *int64, 1)
	go func() {
		_ = child.Wait()
		waitDone <- hostExitCode(child)
	}()

	code := <-waitDone
	// The leader is gone; whatever it left in its group goes with it. Signalling -pid stays safe
	// while any group member lives, and ESRCH is the already-gone answer.
	process.SignalGroup(pid, syscall.SIGKILL)
	drain := time.NewTimer(time.Duration(hostDrainMs) * time.Millisecond)
	select {
	case <-readerDone:
	case <-drain.C:
		readEnd.Close()
		<-readerDone
	}
	drain.Stop()
	close(stop)
	return hostGateExit{code: code, timedOut: timedOut.Load()}
}

// hostReadGate writes the gate's combined output to the log and keeps the tail window, decoding
// UTF-8 so that bytes of a rune split across reads wait for the rest.
func hostReadGate(readEnd *os.File, log *os.File, tail *hostGateTail, done chan<- struct{}) {
	defer close(done)
	defer readEnd.Close()
	var pending []byte
	buf := make([]byte, 32*1024)
	for {
		n, err := readEnd.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if log != nil {
				_, _ = log.Write(chunk)
			}
			pending = append(pending, chunk...)
			complete, rest := hostCompleteRunes(pending)
			if len(complete) > 0 {
				tail.push(string(complete))
			}
			pending = append(pending[:0], rest...)
		}
		if err != nil {
			return
		}
	}
}

// hostCompleteRunes splits data into its leading complete runes and the trailing bytes that may
// start one; the tail never flushes an incomplete rune.
func hostCompleteRunes(data []byte) ([]byte, []byte) {
	i := 0
	for i < len(data) {
		r, size := utf8.DecodeRune(data[i:])
		if r == utf8.RuneError && size <= 1 {
			break
		}
		i += size
	}
	return data[:i], data[i:]
}

// hostExitCode is the waited shell's exit code, nil when a signal killed it.
func hostExitCode(child *exec.Cmd) *int64 {
	if code := child.ProcessState.ExitCode(); code >= 0 {
		value := int64(code)
		return &value
	}
	return nil
}

// hostGateAttr puts the gate at the head of its own process group, so the timeout and the exit
// sweep reach every job it started.
func hostGateAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }
