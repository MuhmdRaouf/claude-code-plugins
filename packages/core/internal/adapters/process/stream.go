// A model worker's process: headless Claude Code, omp, pi or opencode. Each runs in its own process
// group (so a stop reaches every tool it started) with piped stdio, its stdout read line by line, the
// end of its stderr kept for the crash report, and a wall clock after which the whole group is
// terminated.
package process

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
)

const (
	// stderrTailChars keeps the end of stderr, where crash reasons are.
	stderrTailChars = 4_000
	// pipeDrop: grandchildren can hold stdout and stderr open after the leader exits; past this the
	// pipes are dropped.
	pipeDrop = 500 * time.Millisecond
	// defaultGraceMs: between a failed soft stop and SIGTERM, and between SIGTERM and SIGKILL, when the
	// caller gives no grace.
	defaultGraceMs = 5_000
	// maxTimerMs caps the timeout timer at 2^31-1 ms: a caller cannot ask for more.
	maxTimerMs = int64(1<<31 - 1)
)

// ForcedReason is the first interrupt reason, when the run did not end on its own.
type ForcedReason string

const (
	ForcedTimeout ForcedReason = "timeout"
	ForcedStopped ForcedReason = "stopped"
)

// StreamCommand is how a worker is started.
type StreamCommand struct {
	Command string
	Args    []string
	Cwd     string
	Env     []string
	// Stdin is written whole, then stdin is closed (headless Claude Code reads its prompt this way).
	// Without it stdin stays open for Write and EndInput (the RPC engines).
	Stdin *string
	// LogPath is where raw stdout is appended byte for byte; the exit resolves only once it is flushed
	// and closed.
	LogPath *string
	// TimeoutMs is the wall clock after which the run is interrupted with reason "timeout"; absent when
	// the caller owns the deadline.
	TimeoutMs *int64
	// GraceMs is between the soft stop failing and SIGTERM, and between SIGTERM and SIGKILL.
	GraceMs *int64
	// MaxLineBytes is the longest acceptable stdout line (default one MiB, omp's frame limit); past it
	// the process is killed, not buffered. math.MaxInt64 means no limit.
	MaxLineBytes *int64
	// IsBenignStderr names startup stderr that is not trouble (omp's "Still starting after Ns"): still
	// reported, never kept in the tail.
	IsBenignStderr func(line string) bool
	// Soft is the process's own stop request (omp's RPC abort); raced against exit and the grace window
	// before the group dies. It runs on its own goroutine.
	Soft func(reason ForcedReason)
	// ReapGroupOnExit terminates the rest of the group once the leader exits on its own (Claude Code's
	// background shells, opencode's server child). Off by default: omp and pi want their grandchildren
	// left alone. Signalling -pid after the leader is gone is safe here because the group id cannot be
	// reused while a member of the group still lives.
	ReapGroupOnExit bool
}

// ProcessExit is how the process ended.
type ProcessExit struct {
	Code *int
	// Signal is the signal's Node spelling; empty when the process exited on its own.
	Signal string
	// StderrTail is the last stderr lines, benign startup notices left out.
	StderrTail string
	// Forced is the first interrupt reason; empty when the run ended on its own.
	Forced ForcedReason
}

// StderrListener hears every stderr line; benign ones are startup progress, not trouble.
type StderrListener func(line string, benign bool)

// StreamingProcess is a started worker.
type StreamingProcess struct {
	Pid   int64
	Lines <-chan string
	Exit  <-chan ProcessExit

	ctx          context.Context
	defaultGrace int64
	soft         func(reason ForcedReason)
	stdin        *os.File
	stdout       *os.File
	stderr       *os.File
	mu           sync.Mutex
	inputOpen    bool
	reaped       bool
	forced       ForcedReason
	// killed is the signal one of our own stops ended the leader with: the exit reads it where
	// the wait status cannot say.
	killed   string
	termCh   chan struct{}
	timer    *time.Timer
	exitedCh chan struct{}
}

// StartStreaming starts the command in its own process group. Start failures (a missing binary, a bad
// cwd, a log that cannot be opened) are an error value, not a panic.
func StartStreaming(ctx context.Context, cmd StreamCommand, onStderr StderrListener) (*StreamingProcess, error) {
	var logFile *os.File
	if cmd.LogPath != nil {
		file, err := openLog(*cmd.LogPath)
		if err != nil {
			return nil, err
		}
		logFile = file
	}
	// The pipes are os.Files so the child holds them directly: Wait then reaps the leader without
	// waiting for the pipes, and a grandchild inheriting one keeps it open past the leader's exit.
	var pipes [3][2]*os.File // stdin, stdout, stderr
	for i := range pipes {
		readEnd, writeEnd, err := os.Pipe()
		if err != nil {
			for j := 0; j < i; j++ {
				pipes[j][0].Close()
				pipes[j][1].Close()
			}
			closeLog(logFile)
			return nil, err
		}
		pipes[i] = [2]*os.File{readEnd, writeEnd}
	}
	stdinR, stdinW := pipes[0][0], pipes[0][1]
	stdoutR, stdoutW := pipes[1][0], pipes[1][1]
	stderrR, stderrW := pipes[2][0], pipes[2][1]
	child := exec.Command(cmd.Command, cmd.Args...)
	child.Dir = cmd.Cwd
	child.Env = cmd.Env
	child.SysProcAttr = groupLeaderAttr()
	child.Stdin = stdinR
	child.Stdout = stdoutW
	child.Stderr = stderrW
	if err := child.Start(); err != nil {
		for _, ends := range pipes {
			ends[0].Close()
			ends[1].Close()
		}
		closeLog(logFile)
		return nil, spawnError(cmd.Command, err)
	}
	// The parent keeps only its own ends; the child holds the others.
	stdinR.Close()
	stdoutW.Close()
	stderrW.Close()

	var grace int64 = defaultGraceMs
	if cmd.GraceMs != nil {
		grace = *cmd.GraceMs
	}
	queue := CreateQueue[string]()
	exitCh := make(chan ProcessExit, 1)
	p := &StreamingProcess{
		Pid:          int64(child.Process.Pid),
		Lines:        queue.Items(),
		Exit:         exitCh,
		ctx:          ctx,
		defaultGrace: grace,
		soft:         cmd.Soft,
		stdin:        stdinW,
		stdout:       stdoutR,
		stderr:       stderrR,
		inputOpen:    cmd.Stdin == nil,
		exitedCh:     make(chan struct{}),
	}
	if cmd.Stdin != nil {
		// A child that exits without reading its input fails this write with EPIPE; its exit tells the
		// real story.
		_, _ = stdinW.WriteString(*cmd.Stdin)
		stdinW.Close()
		p.stdin = nil
	}
	maxLineBytes := DefaultMaxLineBytes
	if cmd.MaxLineBytes != nil {
		maxLineBytes = *cmd.MaxLineBytes
	}
	stdoutDone := make(chan struct{})
	stderrDone := make(chan struct{})
	tailCh := make(chan string, 1)
	go p.readStdout(stdoutR, logFile, queue, maxLineBytes, stdoutDone)
	go readStderr(stderrR, cmd.IsBenignStderr, onStderr, stderrDone, tailCh)
	if cmd.TimeoutMs != nil {
		ms := min(*cmd.TimeoutMs, maxTimerMs)
		p.timer = time.AfterFunc(time.Duration(ms)*time.Millisecond, func() {
			p.Interrupt(ctx, ForcedTimeout)
		})
	}
	go p.supervise(child, cmd, logFile, stdoutDone, stderrDone, tailCh, exitCh)
	return p, nil
}

// Write writes one line to stdin; false once stdin is closed.
func (p *StreamingProcess) Write(line string) bool {
	p.mu.Lock()
	file := p.stdin
	open := p.inputOpen && file != nil
	p.mu.Unlock()
	if !open {
		return false
	}
	if _, err := file.WriteString(line + "\n"); err != nil {
		// The child closed its stdin: its exit tells the story.
		p.EndInput()
		return false
	}
	return true
}

// EndInput closes stdin: an RPC engine then drains, disposes its session and exits 0.
func (p *StreamingProcess) EndInput() {
	p.mu.Lock()
	p.inputOpen = false
	file := p.stdin
	p.stdin = nil
	p.mu.Unlock()
	if file != nil {
		file.Close()
	}
}

// Signal signals the process group; a no-op once the leader has exited, because the kernel may have
// reused its pid. It reports whether the group was signalled.
func (p *StreamingProcess) Signal(signal syscall.Signal) bool {
	p.mu.Lock()
	reaped := p.reaped
	p.mu.Unlock()
	if reaped {
		return false
	}
	if signal != 0 {
		return p.signalGroup(signal)
	}
	return SignalGroup(p.Pid, signal)
}

// signalGroup stops the group with a real signal and remembers the one that ended the leader,
// which the exit reads back where the wait status cannot say.
func (p *StreamingProcess) signalGroup(signal syscall.Signal) bool {
	delivered, ended := stopGroup(p.Pid, signal)
	if ended != "" {
		p.recordKilled(ended)
	}
	return delivered
}

// recordKilled notes the signal one of our own stops ended the leader with; "" clears nothing.
func (p *StreamingProcess) recordKilled(signal string) {
	if signal == "" {
		return
	}
	p.mu.Lock()
	p.killed = signal
	p.mu.Unlock()
}

// killedSignal is the recorded stop signal, "" when none of ours ended the leader.
func (p *StreamingProcess) killedSignal() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.killed
}

// Interrupt runs the soft stop first (when there is one), then terminates the group; the exit reports
// the forced reason unless an earlier interrupt already set one.
func (p *StreamingProcess) Interrupt(ctx context.Context, reason ForcedReason, graceMs ...int64) {
	p.mu.Lock()
	if p.forced == "" {
		p.forced = reason
	}
	p.mu.Unlock()
	grace := p.defaultGrace
	if len(graceMs) > 0 {
		grace = graceMs[0]
	}
	// The soft stop is best effort: whatever it does, the group is terminated once it settles or the
	// grace runs out.
	if p.soft != nil {
		softDone := make(chan struct{})
		go func() {
			defer close(softDone)
			p.soft(reason)
		}()
		timer := time.NewTimer(time.Duration(grace) * time.Millisecond)
		select {
		case <-softDone:
		case <-p.exitedCh:
		case <-timer.C:
		}
		timer.Stop()
	}
	<-p.beginTermination(ctx, grace)
}

// supervise waits the leader out, drops the pipes grandchildren may hold, settles any group
// termination, flushes the log and hands the exit over.
func (p *StreamingProcess) supervise(
	child *exec.Cmd,
	cmd StreamCommand,
	logFile *os.File,
	stdoutDone, stderrDone <-chan struct{},
	tailCh <-chan string,
	exitCh chan<- ProcessExit,
) {
	_ = child.Wait()
	// Past the leader's exit the kernel has reaped it and its pid is free for reuse, so signalling it
	// must stop.
	p.mu.Lock()
	p.reaped = true
	p.mu.Unlock()
	close(p.exitedCh)
	// The run did end on its own, so the exit stays unforced even when the rest of the group is
	// terminated here.
	if cmd.ReapGroupOnExit {
		p.beginTermination(p.ctx, p.defaultGrace)
	}
	// Grandchildren can still hold the pipes open after the leader exits; they are dropped, not chased
	// — the group is only ever terminated on request (interrupt, or the opt-in above), never because the
	// leader happened to exit.
	drop := time.AfterFunc(pipeDrop, p.dropPipes)
	<-stdoutDone
	<-stderrDone
	drop.Stop()
	// A group termination under way (an interrupt, the reap above) settles first: nothing the run
	// started is left.
	if term := p.termination(); term != nil {
		<-term
	}
	p.EndInput()
	closeLog(logFile)
	code, signal := exitResult(child.ProcessState)
	code, signal = applyKilled(p.killedSignal(), code, signal)
	p.mu.Lock()
	forced := p.forced
	p.mu.Unlock()
	if p.timer != nil {
		p.timer.Stop()
	}
	exitCh <- ProcessExit{Code: code, Signal: signal, StderrTail: <-tailCh, Forced: forced}
}

// dropPipes closes the parent's read ends, ending the line readers a grandchild is holding open.
func (p *StreamingProcess) dropPipes() {
	p.stdout.Close()
	p.stderr.Close()
}

// readStdout splits the leader's stdout into lines, logging the raw bytes, until EOF, a dropped pipe
// or the line budget.
func (p *StreamingProcess) readStdout(reader *os.File, logFile *os.File, queue *Queue[string], maxLineBytes int64, done chan<- struct{}) {
	defer close(done)
	var source io.Reader = reader
	if logFile != nil {
		source = io.TeeReader(reader, logFile)
	}
	// A peer that streams past the line budget with no newline is broken; kill it, do not buffer it.
	EachLine(source, func(line string, _ bool) { queue.Push(line) }, queue.Close,
		func() { p.signalGroup(syscall.SIGKILL) }, maxLineBytes)
}

// readStderr keeps the end of stderr as written, benign lines left out; the exit reads the tail once
// the pipes are closed.
func readStderr(reader *os.File, isBenign func(string) bool, onStderr StderrListener, done chan<- struct{}, tail chan<- string) {
	defer close(done)
	tailText := ""
	EachLine(reader, func(line string, complete bool) {
		benign := isBenign != nil && isBenign(line)
		if !benign {
			tailText = utf16Suffix(tailText+line+newlineIf(complete), stderrTailChars)
		}
		if onStderr != nil {
			onStderr(line, benign)
		}
	}, func() {}, nil, DefaultMaxLineBytes)
	tail <- tailText
}

func newlineIf(complete bool) string {
	if complete {
		return "\n"
	}
	return ""
}

// utf16Suffix keeps the last n UTF-16 code units, the units JS's String.prototype.slice counts: a
// surrogate pair the cut splits leaves a lone surrogate, which utf16.Decode turns into U+FFFD — what
// Node writes for it.
func utf16Suffix(text string, n int) string {
	units := utf16.Encode([]rune(text))
	if len(units) > n {
		units = units[len(units)-n:]
	}
	return string(utf16.Decode(units))
}

// beginTermination starts the group's termination once (the first grace is the one that applies) and
// returns its completion.
func (p *StreamingProcess) beginTermination(ctx context.Context, grace int64) <-chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.termCh == nil {
		done := make(chan struct{})
		p.termCh = done
		go func() {
			defer close(done)
			p.recordKilled(TerminateGroup(ctx, p.Pid, grace))
		}()
	}
	return p.termCh
}

// termination is the group termination under way, or nil when none was started.
func (p *StreamingProcess) termination() <-chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.termCh
}

func openLog(path string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("cannot open log %s: %v", path, err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("cannot open log %s: %v", path, err)
	}
	return file, nil
}

func closeLog(log *os.File) {
	if log != nil {
		_ = log.Close()
	}
}
