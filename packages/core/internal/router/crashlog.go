// The router's own records: a crash log (`<state>/router-crash.log`, one JSON line per crash or
// supervision event, the last 1 MiB kept) and the rotating `router.log`. Never a header or a body.
// Every write is best effort: a full disk, a missing directory or a read-only file costs the line,
// never the request.
package router

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"runtime/debug"
	"sync"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// LogFs is the file operations the logs use; tests inject failing ones to prove nothing propagates.
// Each operation reports its own failure instead of throwing: the logs swallow them all the same.
type LogFs interface {
	Append(path string, text string) error
	Size(path string) (int64, error)
	Read(path string) ([]byte, error)
	Write(path string, data []byte) error
	Rename(from string, to string) error
}

// DiskFs is the file operations on the real disk. It appends only where the directory already
// exists: a router whose state was removed (an uninstall) must not bring the directory back by
// logging.
var DiskFs LogFs = diskFs{}

type diskFs struct{}

func (diskFs) Append(path, text string) error {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = file.WriteString(text)
	return errors.Join(err, file.Close())
}

func (diskFs) Size(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

func (diskFs) Read(path string) ([]byte, error) {
	return os.ReadFile(path)
}

func (diskFs) Write(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, err = file.Write(data)
	return errors.Join(err, file.Close())
}

func (diskFs) Rename(from, to string) error {
	return os.Rename(from, to)
}

// CrashLogLimit is the crash log's kept size: the last bytes only.
const CrashLogLimit int64 = 1024 * 1024

// LogRole is who wrote a crash-log line.
type LogRole string

const (
	RoleFront     LogRole = "front"
	RoleWorker    LogRole = "worker"
	RoleEmergency LogRole = "emergency"
)

// CrashEntry is one crash-log line's own fields; a nil pointer is a field the line omits, the way
// JSON.stringify drops an undefined.
type CrashEntry struct {
	Role    LogRole `json:"role"`
	Version string  `json:"version"`
	Event   *string `json:"event,omitempty"`
	Error   *string `json:"error,omitempty"`
	Stack   *string `json:"stack,omitempty"`
}

// crashLine is the line as written: when and who first, then the entry, the order
// `{ts, pid, ...entry}` writes.
type crashLine struct {
	Ts  string `json:"ts"`
	Pid int    `json:"pid"`
	CrashEntry
}

// isoNow is new Date().toISOString(): UTC, millisecond precision.
func isoNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// LogCrash appends one line, then trims the file to its last limit bytes (cut at a line start).
// Never reports a failure: a crash log that cannot be written must not become the next crash. A nil
// fs is DiskFs and a zero limit is CrashLogLimit.
func LogCrash(stateRoot string, entry CrashEntry, fs LogFs, limit int64) {
	if fs == nil {
		fs = DiskFs
	}
	if limit == 0 {
		limit = CrashLogLimit
	}
	path := domain.NewStateLayout(stateRoot).CrashLog
	line := crashLine{Ts: isoNow(), Pid: os.Getpid(), CrashEntry: entry}
	if err := fs.Append(path, marshalCompact(line)+"\n"); err != nil {
		return
	}
	size, err := fs.Size(path)
	if err != nil || size <= limit {
		return
	}
	data, err := fs.Read(path)
	if err != nil {
		return
	}
	tail := data[len(data)-int(limit):]
	start := bytes.IndexByte(tail, 10) + 1
	_ = fs.Write(path, tail[start:])
}

// InstallCrashHandlers logs an uncaught exception or unhandled rejection, then exits 1, so the
// supervisor (or the next hook) replaces the process with a clean one. Node hands both to
// process-wide listeners; Go hands a panic only to a recover in the panicking goroutine, so what
// comes back is the one closure the caller defers that recover to, told the event's name and the
// recovered value. A nil exit is os.Exit.
func InstallCrashHandlers(role LogRole, stateRoot, version string, exit func(code int), fs LogFs) func(event string, reason any) {
	if exit == nil {
		exit = os.Exit
	}
	if fs == nil {
		fs = DiskFs
	}
	return func(event string, reason any) {
		entry := CrashEntry{Role: role, Version: version, Event: &event}
		if err, ok := reason.(error); ok {
			message := err.Error()
			entry.Error = &message
			// The stack is the goroutine the failure surfaced in.
			stack := string(debug.Stack())
			entry.Stack = &stack
		} else {
			message := fmt.Sprint(reason)
			entry.Error = &message
		}
		LogCrash(stateRoot, entry, fs, 0)
		exit(1)
	}
}

// RouterLogLimit is the rotating router log's size limit.
const RouterLogLimit int64 = 4 * 1024 * 1024

// RotatingLog is a line logger appending to path, rotated to `<path>.1` once it passes limit bytes.
// Never reports a failure: a full disk costs the line, nothing else. A nil fs is DiskFs and a zero
// limit is RouterLogLimit.
func RotatingLog(path string, fs LogFs, limit int64) func(line string) {
	if fs == nil {
		fs = DiskFs
	}
	if limit == 0 {
		limit = RouterLogLimit
	}
	written := int64(0)
	if size, err := fs.Size(path); err == nil {
		written = size
	}
	var mu sync.Mutex
	return func(line string) {
		mu.Lock()
		defer mu.Unlock()
		text := isoNow() + " " + line + "\n"
		// The trim counts the file's bytes against the text's UTF-16 length; ASCII logs never
		// differ.
		if written+utf16Len(text) > limit {
			_ = fs.Rename(path, path+".1")
			written = 0
		}
		_ = fs.Append(path, text)
		written += utf16Len(text)
	}
}
