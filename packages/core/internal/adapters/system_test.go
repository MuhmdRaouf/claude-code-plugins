package adapters

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// createSystemClock, createIds and createProcessControl. The tests drive sh children through
// the process package's seams (StartStreaming, SpawnOrphan), which sets the group and session
// attributes portably.

// hostIsoShape is new Date().toISOString()'s shape.
var hostIsoShape = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

func TestCreateSystemClock(t *testing.T) {
	t.Run("now and iso read the wall clock", func(t *testing.T) {
		clock := CreateSystemClock()

		before := time.Now().UnixMilli()
		now := clock.Now()
		iso := clock.Iso()
		after := time.Now().UnixMilli()

		if now < before || now > after {
			t.Fatalf("now = %d, want it within %d..%d", now, before, after)
		}
		if !hostIsoShape.MatchString(iso) {
			t.Fatalf("iso = %q, want the toISOString shape", iso)
		}
		parsed, err := time.Parse(time.RFC3339, iso)
		if err != nil {
			t.Fatalf("iso = %q does not parse: %v", iso, err)
		}
		if ms := parsed.UnixMilli(); ms < before || ms > after {
			t.Fatalf("iso = %q is %d ms, want it within %d..%d", iso, ms, before, after)
		}
	})

	t.Run("sleep waits at least ms and rejects with AbortError when aborted", func(t *testing.T) {
		clock := CreateSystemClock()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		started := time.Now()
		if err := clock.Sleep(ctx, 30); err != nil {
			t.Fatalf("sleep(30): %v", err)
		}
		if waited := time.Since(started); waited < 29*time.Millisecond {
			t.Fatalf("sleep(30) waited %v", waited)
		}

		aborted := make(chan error, 1)
		go func() { aborted <- clock.Sleep(ctx, 60_000) }()
		cancel()
		select {
		case err := <-aborted:
			if err == nil {
				t.Fatal("the aborted sleep resolved nil, want the context's error")
			}
		case <-time.After(10 * time.Second):
			t.Fatal("the aborted sleep never resolved")
		}
	})
}

func TestCreateIds(t *testing.T) {
	t.Run("jobId is the UTC yymmdd date, a dash and 6 lowercase Crockford base32 chars; ids are unique", func(t *testing.T) {
		ids := CreateIds()
		day := func(now time.Time) string { return now.UTC().Format("060102") }
		shape := regexp.MustCompile(`^\d{6}-[0-9a-hjkmnp-tv-z]{6}$`)

		before := day(time.Now())
		jobIDs := make([]string, 200)
		for i := range jobIDs {
			jobIDs[i] = ids.JobID()
		}
		after := day(time.Now())

		seen := make(map[string]bool, len(jobIDs))
		for _, id := range jobIDs {
			if !shape.MatchString(id) {
				t.Fatalf("jobId = %q, want yymmdd- and 6 Crockford base32 chars", id)
			}
			if prefix := id[:6]; prefix != before && prefix != after {
				t.Fatalf("jobId = %q starts with neither %s nor %s", id, before, after)
			}
			seen[id] = true
		}
		if len(seen) != len(jobIDs) {
			t.Fatalf("%d of %d jobIds are unique, want all of them", len(seen), len(jobIDs))
		}
	})

	t.Run("sessionId is a fresh RFC 4122 v4 UUID (what claude --session-id accepts)", func(t *testing.T) {
		ids := CreateIds()
		shape := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

		sessions := []string{ids.SessionID(), ids.SessionID()}
		for _, id := range sessions {
			if !shape.MatchString(id) {
				t.Fatalf("sessionId = %q, want an RFC 4122 v4 UUID", id)
			}
		}
		if sessions[0] == sessions[1] {
			t.Fatal("two sessionIds are the same")
		}
	})
}

// hostStartGroup starts a detached group leader (a sh that starts one grandchild in its group and
// reports both pids to a file), both optionally ignoring SIGTERM. The leader runs through
// StartStreaming so its exit status names the signal that ended it.
func hostStartGroup(t *testing.T, ignoreTerm bool) (int64, []int64, <-chan process.ProcessExit) {
	t.Helper()
	pidsFile := filepath.Join(t.TempDir(), "pids")
	prefix, grandchild := "", "sleep 30"
	if ignoreTerm {
		// An ignored disposition is inherited: the leader's trap covers the group's answer to
		// SIGTERM; the grandchild traps again so it survives on its own too.
		prefix, grandchild = "trap '' TERM; ", `sh -c 'trap "" TERM; sleep 30'`
	}
	script := prefix + grandchild + ` & echo "$$ $!" > "$PIDS_FILE"; sleep 30`

	leader, err := process.StartStreaming(context.Background(), process.StreamCommand{
		Command: "/bin/sh",
		Args:    []string{"-c", script},
		Env:     append(os.Environ(), "PIDS_FILE="+pidsFile),
	}, nil)
	if err != nil {
		t.Fatalf("start the group leader: %v", err)
	}
	t.Cleanup(func() {
		// The sweep runs only while the leader is unreaped: once its pid is free again the machine's
		// wrapping pid counter can hand it to a different process group, and a group kill by that pid
		// would reach the new group. A passing subtest has already ended its group; the members' own
		// sleeps bound anything a failing one leaves behind.
		_ = leader.Signal(syscall.SIGKILL)
	})

	var content string
	if err := testkit.Until(t, func() bool {
		data, err := os.ReadFile(pidsFile)
		content = string(data)
		return err == nil && strings.TrimSpace(content) != ""
	}, testkit.UntilOptions{Message: "the group did not report its pids"}); err != nil {
		t.Fatal(err)
	}
	fields := strings.Fields(content)
	if len(fields) != 2 {
		t.Fatalf("pids file holds %q, want two pids", content)
	}
	pids := make([]int64, 0, 2)
	for _, field := range fields {
		pid, err := strconv.ParseInt(field, 10, 64)
		if err != nil {
			t.Fatalf("pids file holds %q, not two pids: %v", content, err)
		}
		pids = append(pids, pid)
	}
	if pids[0] != leader.Pid {
		t.Fatalf("pids file names leader %d, want %d", pids[0], leader.Pid)
	}
	return leader.Pid, pids, leader.Exit
}

func TestCreateProcessControl(t *testing.T) {
	unused := CreateProcessControl("/unused/plugin-core", "zai", func(string) string {
		return "/unused/log"
	})

	t.Run("isAlive: true for a running process (even one we may not signal), false once it has exited", func(t *testing.T) {
		dead := testkit.DeadPid(t)

		if !unused.IsAlive(int64(os.Getpid())) {
			t.Fatal("our own pid is not alive")
		}
		if !unused.IsAlive(1) {
			t.Fatal("pid 1 is not alive")
		}
		if unused.IsAlive(int64(dead)) {
			t.Fatalf("pid %d is alive after its exit", dead)
		}
	})

	t.Run("isAlive: false for values that do not name one process (0 and negatives address groups, kill(-1) everyone)", func(t *testing.T) {
		for _, pid := range []int64{0, -1, -int64(os.Getpid())} {
			if unused.IsAlive(pid) {
				t.Fatalf("isAlive(%d) = true, want false", pid)
			}
		}
	})

	t.Run("terminateGroup: SIGTERM reaches the leader and its grandchildren; returns once the group is gone", func(t *testing.T) {
		pid, pids, exit := hostStartGroup(t, false)

		if err := unused.TerminateGroup(context.Background(), pid, 5_000); err != nil {
			t.Fatalf("terminateGroup: %v", err)
		}
		// sh either dies of the SIGTERM itself or, when its `sleep` child dies first, exits 128+15: both are
		// the group's SIGTERM reaching the leader.
		if ended := <-exit; !(ended.Signal == "SIGTERM" && ended.Code == nil) && !(ended.Code != nil && *ended.Code == 143) {
			t.Fatalf("the leader ended with %+v, want SIGTERM (or sh's 143)", ended)
		}
		for _, member := range pids {
			if err := testkit.Until(t, func() bool { return !unused.IsAlive(member) },
				testkit.UntilOptions{TimeoutMs: 5000, Message: fmt.Sprintf("pid %d still alive", member)}); err != nil {
				t.Fatal(err)
			}
		}
	})

	t.Run("terminateGroup: a group that ignores SIGTERM gets SIGKILL after graceMs", func(t *testing.T) {
		pid, pids, exit := hostStartGroup(t, true)

		started := time.Now()
		if err := unused.TerminateGroup(context.Background(), pid, 300); err != nil {
			t.Fatalf("terminateGroup: %v", err)
		}
		took := time.Since(started)

		if ended := <-exit; ended.Code != nil || ended.Signal != "SIGKILL" {
			t.Fatalf("the leader ended with %+v, want SIGKILL and no exit code", ended)
		}
		if took < 290*time.Millisecond {
			t.Fatalf("terminateGroup took %v with grace 300ms, want the SIGKILL after the grace", took)
		}
		for _, member := range pids {
			if err := testkit.Until(t, func() bool { return !unused.IsAlive(member) },
				testkit.UntilOptions{TimeoutMs: 5000, Message: fmt.Sprintf("pid %d still alive", member)}); err != nil {
				t.Fatal(err)
			}
		}
	})

	t.Run("terminateGroup: never signals for 0, 1, negatives, non-integers or its own pid (kill(-0)/kill(-1) hit others)", func(t *testing.T) {
		// Proven by surviving: a signal to 1, -1 or our own group would end this test process.
		for _, pid := range []int64{0, 1, -42, int64(os.Getpid())} {
			started := time.Now()
			if err := unused.TerminateGroup(context.Background(), pid, 10); err != nil {
				t.Fatalf("terminateGroup(%d): %v", pid, err)
			}
			if took := time.Since(started); took > 5*time.Second {
				t.Fatalf("terminateGroup(%d) took %v, want no wait", pid, took)
			}
		}
		if !process.IsAlive(int64(os.Getpid())) {
			t.Fatal("terminateGroup signalled this process")
		}
	})

	t.Run("spawnDriver: starts `<command> <provider> cli drive <id>` as its own group leader with stdout and stderr in the log", func(t *testing.T) {
		dir := t.TempDir()
		driver := filepath.Join(dir, "driver")
		script := `#!/bin/sh
echo "argv: $1 $2 $3 $4"
echo "pid: $$"
echo "pgid: $(ps -o pgid= -p $$ | tr -d ' \n')"
echo "driver stderr" >&2
`
		if err := os.WriteFile(driver, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		logPath := func(jobID string) string { return filepath.Join(dir, "jobs", jobID, "driver.log") }
		control := CreateProcessControl(driver, "zai", logPath)

		pid := control.SpawnDriver("261006-abc123")
		// The driver writes its log after it starts; wait for its last line before reading the whole log.
		if err := testkit.Until(t, func() bool {
			log, err := os.ReadFile(logPath("261006-abc123"))
			return err == nil && strings.Contains(string(log), "driver stderr\n")
		}, testkit.UntilOptions{Message: "the driver did not finish writing its log"}); err != nil {
			t.Fatal(err)
		}

		log, err := os.ReadFile(logPath("261006-abc123"))
		if err != nil {
			t.Fatalf("read the driver log: %v", err)
		}
		text := string(log)
		for _, want := range []string{
			"argv: zai cli drive 261006-abc123\n",
			fmt.Sprintf("pid: %d\n", pid),
			fmt.Sprintf("pgid: %d\n", pid),
			"driver stderr\n",
		} {
			if !strings.Contains(text, want) {
				t.Fatalf("driver log = %q, want it to hold %q", text, want)
			}
		}
		// The last log line is written just before the driver exits, and PID 1 reaps the orphan
		// only some time after that: poll for its death instead of checking once.
		if err := testkit.Until(t, func() bool { return !control.IsAlive(pid) },
			testkit.UntilOptions{TimeoutMs: 5000, Message: fmt.Sprintf("driver %d is alive after its script ran out", pid)}); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("spawnDriver: the driver is an orphan, outside the caller's process tree, and still leads its own group", func(t *testing.T) {
		dir := t.TempDir()
		bundle := filepath.Join(dir, "hold.sh")
		if err := os.WriteFile(bundle, []byte("#!/bin/sh\nsleep 5\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		control := CreateProcessControl(bundle, "zai", func(jobID string) string {
			return filepath.Join(dir, jobID+".log")
		})
		spawned := make(chan int64, 1)
		go func() { spawned <- control.SpawnDriver("261006-abc123") }()

		// The driver is found in the process table by its command line: the interpreter runs the
		// bundle (`/bin/sh <bundle> zai cli drive <id>`, own group leader). The short-lived launcher
		// carries the same bundle and drive words but stays in the caller's group, and this test's
		// own shell may quote its source, so the leader check tells them apart.
		var pid, pgid, sess int64
		if err := testkit.Until(t, func() bool {
			ps, err := exec.Command("ps", "-axo", "pid=,pgid=,sess=,args=").Output()
			if err != nil {
				return false
			}
			for _, line := range strings.Split(string(ps), "\n") {
				if !strings.Contains(line, bundle) || !strings.Contains(line, " cli drive 261006-abc123") {
					continue
				}
				if n, _ := fmt.Sscanf(line, "%d %d %d", &pid, &pgid, &sess); n != 3 || pid != pgid {
					continue
				}
				return true
			}
			return false
		}, testkit.UntilOptions{TimeoutMs: 20_000, Message: "the driver never appeared in the process table"}); err != nil {
			t.Fatal(err)
		}
		// macOS ps reports sess 0 for every process, so the session is not observable; the group
		// and parent a sweep respects are:
		ownPgid := hostPsNumber(t, "-o", "pgid=", "-p", strconv.Itoa(os.Getpid()))

		if pgid != pid {
			t.Fatalf("driver %d leads pgid %d (sess %d), want its own", pid, pgid, sess)
		}
		if ownPgid == pgid {
			t.Fatalf("driver %d sits in the caller's process group %d", pid, pgid)
		}

		// The launcher exits at once, so the driver's parent is never the caller: a tree-kill of
		// the caller (Claude Code cleaning up a background shell) must not find it.
		driverPpid := hostPsNumber(t, "-o", "ppid=", "-p", strconv.FormatInt(pid, 10))
		if driverPpid == int64(os.Getpid()) {
			t.Fatalf("driver %d is the caller's own child (ppid %d)", pid, driverPpid)
		}

		// The pid came from a ps scan: terminate only while it still runs the bundle this test
		// wrote under its own temp dir, so a pid the kernel handed to another process is skipped
		// (the driver's own sleep ends it and SpawnDriver returns either way).
		if testkit.PidMatches(pid, bundle, 0) {
			process.TerminateGroup(context.Background(), pid, 500)
		}
		select {
		case got := <-spawned:
			if got != pid {
				t.Fatalf("spawnDriver returned pid %d, the process table said %d", got, pid)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("spawnDriver did not return after its driver was terminated")
		}
	})

	t.Run("spawnDriver: throws when the runtime cannot be started instead of returning a bogus pid", func(t *testing.T) {
		dir := t.TempDir()
		missing := filepath.Join(dir, "no-such-node")
		control := CreateProcessControl(missing, "zai", func(string) string {
			return filepath.Join(dir, "log")
		})

		panicked := false
		var message string
		func() {
			defer func() {
				if r := recover(); r != nil {
					panicked = true
					if err, ok := r.(error); ok {
						message = err.Error()
					} else {
						message = fmt.Sprint(r)
					}
				}
			}()
			control.SpawnDriver("261006-abc123")
		}()
		if !panicked {
			t.Fatal("spawnDriver returned instead of throwing")
		}
		if want := "cannot start " + missing; !strings.HasPrefix(message, want) {
			t.Fatalf("spawnDriver threw %q, want it to start with %q", message, want)
		}
	})
}

// hostPsNumber reads one number out of ps with the given display arguments. A wait can lose its
// child under the churn the tests cause (ECHILD), so a failed ps is retried, not trusted.
func hostPsNumber(t *testing.T, args ...string) int64 {
	t.Helper()
	for attempt := 0; ; attempt++ {
		ps, err := exec.Command("ps", args...).Output()
		if err == nil {
			number, err := strconv.ParseInt(strings.TrimSpace(string(ps)), 10, 64)
			if err != nil {
				t.Fatalf("ps %s said %q, not a number: %v", strings.Join(args, " "), ps, err)
			}
			return number
		}
		if attempt >= 2 {
			t.Fatalf("ps %s: %v", strings.Join(args, " "), err)
		}
		time.Sleep(100 * time.Millisecond)
	}
}
