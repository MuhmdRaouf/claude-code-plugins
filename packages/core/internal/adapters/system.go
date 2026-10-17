package adapters

import (
	"context"
	crand "crypto/rand"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// The system adapters: the wall clock, the id makers and the process handling outside the caller's
// own tree.

// CreateSystemClock is the clock the core sees: the wall clock, in the shapes Date.now() and
// toISOString() gave.
func CreateSystemClock() ports.Clock { return hostClock{} }

type hostClock struct{}

func (hostClock) Now() int64 { return time.Now().UnixMilli() }

func (hostClock) Iso() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00") }

// CreateFixedClock is the pinned clock the golden-transcript suite runs the CLI under: every date
// the session prints is one instant, so a subprocess CLI and its detached drivers all agree on
// "now". Sleep stays real: only what is printed is pinned.
func CreateFixedClock(nowMS int64) ports.Clock { return fixedClock{nowMS: nowMS} }

type fixedClock struct {
	hostClock
	nowMS int64
}

func (c fixedClock) Now() int64 { return c.nowMS }

func (c fixedClock) Iso() string {
	return time.UnixMilli(c.nowMS).UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

func (hostClock) Sleep(ctx context.Context, ms int64) error {
	timer := time.NewTimer(time.Duration(ms) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		// Cancellation is the sleep's only failure: the context's error goes back as is.
		return ctx.Err()
	}
}

// hostBase32 is Crockford base32, lowercase: no i/l/o/u, so ids survive being read aloud or
// retyped.
const hostBase32 = "0123456789abcdefghjkmnpqrstvwxyz"

// CreateIds makes the ids jobs and their sessions are filed under: jobId `yymmdd-` + 6 base32
// chars (sortable, short, prefix-resolvable), sessionId an RFC 4122 v4 UUID.
func CreateIds() ports.Ids { return hostIds{} }

type hostIds struct{}

func (hostIds) JobID() string {
	return time.Now().UTC().Format("060102") + "-" + hostRandomBase32(6)
}

func (hostIds) SessionID() string { return hostUUIDv4() }

func hostRandomBase32(length int) string {
	buf := make([]byte, length)
	// crypto/rand only fails when the machine is out of entropy sources to draw on; node's
	// randomInt had no failure path either.
	_, _ = crand.Read(buf)
	out := make([]byte, length)
	for i, b := range buf {
		// 256 is a multiple of 32, so the byte maps onto the alphabet without bias.
		out[i] = hostBase32[b%byte(len(hostBase32))]
	}
	return string(out)
}

// hostUUIDv4 is a fresh RFC 4122 v4 UUID, what `claude --session-id` accepts.
func hostUUIDv4() string {
	var b [16]byte
	_, _ = crand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	const digits = "0123456789abcdef"
	out := make([]byte, 0, 36)
	for i, v := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			out = append(out, '-')
		}
		out = append(out, digits[v>>4], digits[v&0x0f])
	}
	return string(out)
}

// CreateProcessControl is the process handling the core may do outside its own tree. command is
// what runs the driver — the binary itself (os.Executable()), which nothing reads ambiently, so
// the caller passes it in. The driver is the binary re-run through its own entry interface,
// `<provider> cli drive <id>`.
func CreateProcessControl(command string, provider string, logPath func(jobID string) string) ports.ProcessControl {
	return &hostProcessControl{command: command, provider: provider, logPath: logPath}
}

// hostProcessControl stops can signal the driver and its worker together, and no tree-kill of the
// caller reaches the driver (see SpawnOrphan).
type hostProcessControl struct {
	command  string
	provider string
	logPath  func(jobID string) string
}

func (c *hostProcessControl) IsAlive(pid int64) bool { return process.IsAlive(pid) }

func (c *hostProcessControl) TerminateGroup(ctx context.Context, pid int64, graceMs int64) error {
	process.TerminateGroup(ctx, pid, graceMs)
	return nil
}

func (c *hostProcessControl) SpawnDriver(jobID string) int64 {
	pid, err := process.SpawnOrphan(c.command, []string{c.provider, "cli", "drive", jobID}, c.logPath(jobID))
	if err != nil {
		// A failed start panics rather than returning a pid that names no process.
		panic(err)
	}
	return pid
}
