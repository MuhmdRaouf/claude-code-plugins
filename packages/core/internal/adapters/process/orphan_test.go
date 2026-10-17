package process

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// nodeBin is a launcher binary path; only its path matters to the messages.
const nodeBin = "/usr/bin/node"

func launchReply(mutate ...func(*LaunchReply)) LaunchReply {
	status := 0
	reply := LaunchReply{Status: &status, Stdout: "4242"}
	for _, m := range mutate {
		m(&reply)
	}
	return reply
}

func TestLaunchedPid(t *testing.T) {
	t.Run("a clean exit with a decimal pid on stdout is that pid (surrounding whitespace ignored)", func(t *testing.T) {
		for _, stdout := range []string{"4242", " 4242\n"} {
			pid, err := LaunchedPid(nodeBin, launchReply(func(r *LaunchReply) { r.Stdout = stdout }))
			if err != nil || pid != 4242 {
				t.Fatalf("launchedPid(%q) = (%d, %v), want (4242, nil)", stdout, pid, err)
			}
		}
	})

	t.Run("a launcher that could not run at all names the command and the cause", func(t *testing.T) {
		reply := launchReply(func(r *LaunchReply) {
			r.Err = errors.New("spawnSync ENOENT")
			r.Status = nil
			r.Stdout = ""
		})
		_, err := LaunchedPid(nodeBin, reply)
		if err == nil || err.Error() != "cannot start "+nodeBin+": spawnSync ENOENT" {
			t.Fatalf("error = %v, want cannot start "+nodeBin+": spawnSync ENOENT", err)
		}
	})

	t.Run("a failing launcher reports its stderr, or a generic line when it said nothing (killed by timeout)", func(t *testing.T) {
		failing := launchReply(func(r *LaunchReply) {
			status := 1
			r.Status = &status
			r.Stdout = ""
			r.Stderr = "cannot start /x\n"
		})
		if _, err := LaunchedPid(nodeBin, failing); err == nil || err.Error() != "cannot start /x" {
			t.Fatalf("error = %v, want cannot start /x", err)
		}
		killed := launchReply(func(r *LaunchReply) {
			r.Status = nil
			r.Stdout = ""
		})
		if _, err := LaunchedPid(nodeBin, killed); err == nil || err.Error() != "cannot start "+nodeBin {
			t.Fatalf("error = %v, want cannot start "+nodeBin, err)
		}
	})

	t.Run("a clean exit without a usable pid is an error, never a pid that would signal the wrong group", func(t *testing.T) {
		for _, stdout := range []string{"", "abc", "-5", "0", "1", "12.5", "1e3", "99999999999999999999", "42 43"} {
			reply := launchReply(func(r *LaunchReply) { r.Stdout = stdout })
			pid, err := LaunchedPid(nodeBin, reply)
			if err == nil || err.Error() != "cannot start "+nodeBin+": no pid" || pid != 0 {
				t.Fatalf("launchedPid(%q) = (%d, %v), want the no-pid error", stdout, pid, err)
			}
		}
	})
}

func TestSpawnOrphan(t *testing.T) {
	t.Run("starts an orphaned group leader with stdio on the log", func(t *testing.T) {
		t.Setenv(childModeEnv, "three-lines")
		log := filepath.Join(t.TempDir(), "jobs", "driver.log")
		pid, err := SpawnOrphan(selfExe(t), nil, log)
		if err != nil {
			t.Fatalf("spawnOrphan: %v", err)
		}
		if pid <= 1 {
			t.Fatalf("pid = %d, want one above 1", pid)
		}
		// The orphan is nobody's child once the launcher exits, so its pid says nothing about its
		// output; the log itself is what to wait for.
		var content []byte
		waitFor(t, func() bool {
			content, err = os.ReadFile(log)
			return err == nil && string(content) == "one\ntwo\nthree"
		})
		if string(content) != "one\ntwo\nthree" {
			t.Fatalf("log = %q, want one\ntwo\nthree", content)
		}
	})

	t.Run("refuses a log path under a file", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "file")
		if err := os.WriteFile(file, []byte(""), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := SpawnOrphan(selfExe(t), nil, filepath.Join(file, "out.log")); err == nil {
			t.Fatal("error = nil, want the mkdir failure")
		}
	})

	t.Run("refuses a log path that is a directory", func(t *testing.T) {
		if _, err := SpawnOrphan(selfExe(t), nil, t.TempDir()); err == nil {
			t.Fatal("error = nil, want the open failure")
		}
	})

	t.Run("names the command when it cannot start", func(t *testing.T) {
		_, err := SpawnOrphan("/nonexistent/orphan-binary", nil, filepath.Join(t.TempDir(), "out.log"))
		if err == nil || !strings.Contains(err.Error(), "cannot start") {
			t.Fatalf("error = %v, want it to say cannot start", err)
		}
	})
}

func waitFor(t *testing.T, probe func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !probe() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met within 10s")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSpawnOrphanDetaches(t *testing.T) {
	t.Run("returns while the orphan still runs, and the orphan stops answering once it ends", func(t *testing.T) {
		log := filepath.Join(t.TempDir(), "driver.log")
		started := time.Now()
		pid, err := SpawnOrphan("/bin/sh", []string{"-c", "sleep 30"}, log)
		if err != nil {
			t.Fatalf("spawnOrphan: %v", err)
		}
		if waited := time.Since(started); waited > 5*time.Second {
			t.Fatalf("spawnOrphan blocked for %v: it must return as soon as the orphan starts", waited)
		}
		if !IsAlive(pid) {
			t.Fatalf("orphan %d is not alive right after the start", pid)
		}
		if err := syscall.Kill(int(pid), syscall.SIGKILL); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(5 * time.Second)
		for IsAlive(pid) {
			if time.Now().After(deadline) {
				t.Fatalf("orphan %d still answers the liveness probe after it was killed: it was never reaped", pid)
			}
			time.Sleep(20 * time.Millisecond)
		}
	})
}
