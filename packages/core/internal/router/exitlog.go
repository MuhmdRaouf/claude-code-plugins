// The router's exit record: every exit a router process can see leaves one line in router.log and
// one marker (`<state>/router.exit`) naming the pid of the process that left the line. The next
// front start reads the pid record beside it — a holder that is gone while no marker vouches for
// it is a death nobody could log (SIGKILL, the OS killing the process, a power loss), and the
// next start names it, so no router ever disappears from the log without a trace. Every write is
// best effort, like every log write: a full disk costs the line, never the router.
package router

import (
	"context"
	"fmt"
	"os"
	"strconv"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// writeExitMark records pid as the process whose exit left its line in router.log.
func writeExitMark(ctx context.Context, stateRoot string, pid int64) {
	_, _ = fsutil.WriteFileAtomic(ctx, domain.NewStateLayout(stateRoot).RouterExit,
		[]byte(strconv.FormatInt(pid, 10)+"\n"), fsutil.WriteOptions{})
}

// markLoggedExit marks this process's exit as logged, but only while a pid record exists: the
// marker is read against one, so a state root without a record (an uninstall's cleanup removed
// it, a stop dropped it) never gets a leftover marker nothing sweeps.
func markLoggedExit(stateRoot string) {
	if !existsFile(domain.NewStateLayout(stateRoot).RouterPid) {
		return
	}
	writeExitMark(context.Background(), stateRoot, int64(os.Getpid()))
}

// exitMarkPid is the pid the marker vouches for, when it names one.
func exitMarkPid(stateRoot string) (int64, bool) {
	return pidNamedBy(domain.NewStateLayout(stateRoot).RouterExit)
}

// noteUnloggedDeath is the next front start's verdict on the record the last router left: the
// holder is gone and the marker does not vouch for it, so no line could be written for its exit —
// one line names it. A holder that still runs keeps its exit to itself (a handover's draining
// front writes its line when it ends), and a marker that matches stays for the start after that.
func noteUnloggedDeath(ctx context.Context, stateRoot string, log func(line string)) {
	layout := domain.NewStateLayout(stateRoot)
	record, ok := ReadPidFile(ctx, stateRoot)
	if !ok {
		// Nothing names a previous router, so nothing can vouch for one; the marker is spent.
		_ = os.Remove(layout.RouterExit)
		return
	}
	if process.IsAlive(record.Pid) {
		return
	}
	if marked, has := exitMarkPid(stateRoot); !has || marked != record.Pid {
		who := "front"
		if record.Mode == PidModeEmergency {
			who = "emergency passthrough"
		}
		log(fmt.Sprintf("router: the previous %s %d ended without an exit line (killed by SIGKILL or the OS)", who, record.Pid))
	}
}

// exitOnPanic is the front's and the emergency's panic path: beside the crash log entry the crash
// handler writes, one router.log line and the logged-exit marker, so a panic counts as a death
// the process itself saw — unlike SIGKILL, which only the next start can name. The returned
// closure is deferred around the panicking code.
func exitOnPanic(who string, crash func(string, any), log func(string), stateRoot string) func() {
	return func() {
		if reason := recover(); reason != nil {
			log(fmt.Sprintf("%s: panic: %v", who, reason))
			markLoggedExit(stateRoot)
			crash("uncaught", reason)
		}
	}
}
