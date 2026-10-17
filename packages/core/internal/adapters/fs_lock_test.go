package adapters

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
)

// The lock files: the store-level lock cases live in fs_store_test.go, the semaphore and
// limiter tests exercise waitLock alongside, and this file holds the direct cases of every
// branch.

// writeLockFile seeds a lock file with text.
func writeLockFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatalf("seed %s: %v", path, err)
	}
}

// holderOf returns the pid a held-lock error names, failing when err is not one.
func holderOf(t *testing.T, err error) int64 {
	t.Helper()
	var held *HeldError
	if !errors.As(err, &held) {
		t.Fatalf("error %v is not a held lock", err)
	}
	return held.HolderPid
}

// noTmpLeft fails when an exclusive create left its temp file behind.
func noTmpLeft(t *testing.T, path string) {
	t.Helper()
	left, err := filepath.Glob(path + ".*.tmp")
	if err != nil {
		t.Fatalf("glob %s.*.tmp: %v", path, err)
	}
	if len(left) != 0 {
		t.Fatalf("temp files left behind: %v", left)
	}
}

func readLockText(t *testing.T, path string) string {
	t.Helper()
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(text)
}

func TestTryLock(t *testing.T) {
	t.Run("garbage in a lock file counts as nobody holding it", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "x.lock")
		writeLockFile(t, path, "not a pid")
		release, err := TryLock(t.Context(), path, 101, func(int64) bool { return true })
		if err != nil {
			t.Fatalf("tryLock: %v", err)
		}
		if text := readLockText(t, path); text != "101\n" {
			t.Fatalf("lock file = %q, want %q", text, "101\n")
		}
		if err := release(t.Context()); err != nil {
			t.Fatalf("release: %v", err)
		}
	})

	t.Run("a reclaim guard left by a dead reclaimer is cleared; a live one defers the reclaim", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "x.lock")
		alive := map[int64]bool{101: true, 303: true}
		isAlive := func(pid int64) bool { return alive[pid] }
		writeLockFile(t, path, "202\n")
		writeLockFile(t, path+".reclaim", "303\n")

		if _, err := TryLock(t.Context(), path, 101, isAlive); holderOf(t, err) != 202 {
			t.Fatalf("tryLock behind a live guard: holder pid = %d, want 202", holderOf(t, err))
		}
		delete(alive, 303)
		release, err := TryLock(t.Context(), path, 101, isAlive)
		if err != nil {
			t.Fatalf("tryLock after the guard's holder died: %v", err)
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("readdir %s: %v", dir, err)
		}
		if len(entries) != 1 || entries[0].Name() != "x.lock" {
			names := make([]string, 0, len(entries))
			for _, entry := range entries {
				names = append(names, entry.Name())
			}
			t.Fatalf("dir holds %v, want [x.lock]", names)
		}
		if err := release(t.Context()); err != nil {
			t.Fatalf("release: %v", err)
		}
	})

	t.Run("reports holder 0 after exhausting every attempt behind a guard nobody clears", func(t *testing.T) {
		// Garbage in the lock, a live guard holder: the reclaim defers on all five attempts, and
		// the file still holds nothing anybody wrote.
		dir := t.TempDir()
		path := filepath.Join(dir, "x.lock")
		writeLockFile(t, path, "not a pid\n")
		writeLockFile(t, path+".reclaim", "303\n")
		isAlive := func(pid int64) bool { return pid == 303 }

		if _, err := TryLock(t.Context(), path, 101, isAlive); holderOf(t, err) != 0 {
			t.Fatalf("tryLock holder pid = %d, want 0", holderOf(t, err))
		}
	})

	t.Run("reports the write error when the lock's directory is missing", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "nodir", "x.lock")
		if _, err := TryLock(t.Context(), path, 101, func(int64) bool { return true }); err == nil {
			t.Fatal("tryLock into a missing directory succeeded")
		}
	})

	t.Run("reports a lock file it cannot read", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root bypasses permission bits")
		}
		path := filepath.Join(t.TempDir(), "x.lock")
		writeLockFile(t, path, "202\n")
		if err := os.Chmod(path, 0o000); err != nil {
			t.Fatalf("chmod %s: %v", path, err)
		}
		if _, err := TryLock(t.Context(), path, 101, func(int64) bool { return false }); err == nil {
			t.Fatal("tryLock on an unreadable lock file succeeded")
		}
	})

	t.Run("reports a reclaim guard it cannot read", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root bypasses permission bits")
		}
		dir := t.TempDir()
		path := filepath.Join(dir, "x.lock")
		writeLockFile(t, path, "202\n")
		writeLockFile(t, path+".reclaim", "303\n")
		if err := os.Chmod(path+".reclaim", 0o000); err != nil {
			t.Fatalf("chmod the guard: %v", err)
		}
		if _, err := TryLock(t.Context(), path, 101, func(int64) bool { return false }); err == nil {
			t.Fatal("tryLock behind an unreadable guard succeeded")
		}
	})

	t.Run("reclaims a dead holder and releases only our own lock", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "x.lock")
		alive := map[int64]bool{101: true}
		isAlive := func(pid int64) bool { return alive[pid] }

		first, err := TryLock(t.Context(), path, 101, isAlive)
		if err != nil {
			t.Fatalf("first tryLock: %v", err)
		}
		alive[101] = false // the holder dies without releasing
		second, err := TryLock(t.Context(), path, 202, isAlive)
		if err != nil {
			t.Fatalf("second tryLock: %v", err)
		}
		// The dead holder's late release must not free the new holder's lock.
		if err := first(t.Context()); err != nil {
			t.Fatalf("late release: %v", err)
		}
		if text := readLockText(t, path); text != "202\n" {
			t.Fatalf("lock file = %q, want %q", text, "202\n")
		}
		if err := second(t.Context()); err != nil {
			t.Fatalf("release: %v", err)
		}
		if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("release left the lock behind (stat err %v)", err)
		}
		// A repeated release is a no-op.
		if err := second(t.Context()); err != nil {
			t.Fatalf("repeated release: %v", err)
		}
	})
}

func TestCreateExclusive(t *testing.T) {
	t.Run("creates the file with its text only when it did not exist", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "x")
		created, err := CreateExclusive(t.Context(), path, "101\n")
		if err != nil {
			t.Fatalf("createExclusive: %v", err)
		}
		if !created {
			t.Fatal("createExclusive = false, want true")
		}
		if text := readLockText(t, path); text != "101\n" {
			t.Fatalf("file = %q, want %q", text, "101\n")
		}
		noTmpLeft(t, path)

		created, err = CreateExclusive(t.Context(), path, "202\n")
		if err != nil {
			t.Fatalf("second createExclusive: %v", err)
		}
		if created {
			t.Fatal("second createExclusive = true, want false")
		}
		if text := readLockText(t, path); text != "101\n" {
			t.Fatalf("file = %q, want the first write %q", text, "101\n")
		}
		noTmpLeft(t, path)
	})

	t.Run("reports the write error for a missing parent directory", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "nodir", "x")
		if _, err := CreateExclusive(t.Context(), path, "t"); err == nil {
			t.Fatal("createExclusive into a missing directory succeeded")
		}
	})

	t.Run("reports a link error that is not EEXIST", func(t *testing.T) {
		// An empty newpath matches nothing, so link(2) fails with ENOENT rather than EEXIST.
		dir := t.TempDir()
		oldWd, err := os.Getwd()
		if err != nil {
			t.Fatalf("getwd: %v", err)
		}
		if err := os.Chdir(dir); err != nil {
			t.Fatalf("chdir %s: %v", dir, err)
		}
		defer func() {
			if err := os.Chdir(oldWd); err != nil {
				t.Fatalf("chdir back %s: %v", oldWd, err)
			}
		}()
		created, err := CreateExclusive(t.Context(), "", "t")
		if err == nil {
			t.Fatal("createExclusive with an empty path succeeded")
		}
		if created {
			t.Fatal("createExclusive = true alongside an error")
		}
		noTmpLeft(t, "x")
	})
}

func TestHeldError(t *testing.T) {
	t.Run("names the holder pid", func(t *testing.T) {
		if got := (&HeldError{HolderPid: 202}).Error(); got != "lock held by pid 202" {
			t.Fatalf("held error = %q, want %q", got, "lock held by pid 202")
		}
	})
}

func TestReclaim(t *testing.T) {
	t.Run("reports a guard it cannot create", func(t *testing.T) {
		// The lock's directory is gone, so the guard beside it cannot be written.
		path := filepath.Join(t.TempDir(), "nodir", "x.lock")
		if err := reclaim(t.Context(), path, true, 202, 101, func(int64) bool { return false }); err == nil {
			t.Fatal("reclaim beside a missing directory succeeded")
		}
	})
}

func TestDeleteIfHeldBy(t *testing.T) {
	t.Run("removes a garbage lock for a garbage stale holder", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "x.lock")
		writeLockFile(t, path, "not a pid")
		if err := deleteIfHeldBy(t.Context(), path, false, 0); err != nil {
			t.Fatalf("deleteIfHeldBy: %v", err)
		}
		if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("the garbage lock stayed (stat err %v)", err)
		}
	})

	t.Run("removes the lock only for the stale pid it read", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "x.lock")
		writeLockFile(t, path, "202\n")
		if err := deleteIfHeldBy(t.Context(), path, true, 101); err != nil {
			t.Fatalf("deleteIfHeldBy: %v", err)
		}
		if text := readLockText(t, path); text != "202\n" {
			t.Fatalf("lock file = %q, want it to stand", text)
		}
		if err := deleteIfHeldBy(t.Context(), path, true, 202); err != nil {
			t.Fatalf("deleteIfHeldBy for the matching pid: %v", err)
		}
		if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("the matching lock stayed (stat err %v)", err)
		}
	})

	t.Run("keeps a missing lock", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "x.lock")
		if err := deleteIfHeldBy(t.Context(), path, true, 202); err != nil {
			t.Fatalf("deleteIfHeldBy on a missing lock: %v", err)
		}
	})

	t.Run("reports a lock it cannot read", func(t *testing.T) {
		if err := deleteIfHeldBy(t.Context(), t.TempDir(), false, 0); err == nil {
			t.Fatal("deleteIfHeldBy on a directory succeeded")
		}
	})
}

func TestReleaseLockFile(t *testing.T) {
	t.Run("reports a lock it cannot read", func(t *testing.T) {
		if err := release(t.Context(), t.TempDir(), 101); err == nil {
			t.Fatal("release on a directory succeeded")
		}
	})
}

func TestRemoveForce(t *testing.T) {
	t.Run("tolerates a missing file and reports the rest", func(t *testing.T) {
		dir := t.TempDir()
		if err := removeForce(filepath.Join(dir, "gone")); err != nil {
			t.Fatalf("removeForce of a missing file: %v", err)
		}
		full := filepath.Join(dir, "full")
		if err := os.Mkdir(full, 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", full, err)
		}
		if err := os.WriteFile(filepath.Join(full, "child"), []byte("x"), 0o600); err != nil {
			t.Fatalf("seed the child: %v", err)
		}
		if err := removeForce(full); err == nil {
			t.Fatal("removeForce of a non-empty directory succeeded")
		}
	})
}

// retryBusy retries the answers retryable names (EBUSY); these cases inject them directly.
func TestRetryBusy(t *testing.T) {
	t.Run("runs a first-try success once", func(t *testing.T) {
		calls := 0
		if err := retryBusy(func() error { calls++; return nil }); err != nil {
			t.Fatalf("retryBusy: %v", err)
		}
		if calls != 1 {
			t.Fatalf("calls = %d, want 1", calls)
		}
	})

	t.Run("retries a busy answer until it clears", func(t *testing.T) {
		calls := 0
		err := retryBusy(func() error {
			calls++
			if calls <= 3 {
				return syscall.EBUSY
			}
			return nil
		})
		if err != nil {
			t.Fatalf("retryBusy: %v", err)
		}
		if calls != 4 {
			t.Fatalf("calls = %d, want 4", calls)
		}
	})

	t.Run("gives up after the bound and returns the last error", func(t *testing.T) {
		calls := 0
		err := retryBusy(func() error {
			calls++
			return syscall.EBUSY
		})
		if fsutil.ErrnoCode(err) != "EBUSY" {
			t.Fatalf("retryBusy = %v, want the last EBUSY", err)
		}
		if calls != removeForceAttempts+1 {
			t.Fatalf("calls = %d, want %d", calls, removeForceAttempts+1)
		}
	})

	t.Run("does not retry another error", func(t *testing.T) {
		calls := 0
		err := retryBusy(func() error {
			calls++
			return syscall.EACCES
		})
		if fsutil.ErrnoCode(err) != "EACCES" {
			t.Fatalf("retryBusy = %v, want the EACCES error", err)
		}
		if calls != 1 {
			t.Fatalf("calls = %d, want 1", calls)
		}
	})
}

func TestReadHolder(t *testing.T) {
	t.Run("is absent for a missing file", func(t *testing.T) {
		pid, found, held, err := ReadHolder(t.Context(), filepath.Join(t.TempDir(), "absent.lock"))
		if err != nil || found || held || pid != 0 {
			t.Fatalf("readHolder = %d/%t/%t/%v, want 0/false/false/nil", pid, found, held, err)
		}
	})

	t.Run("is held by the pid inside", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "x.lock")
		writeLockFile(t, path, "202\n")
		pid, found, held, err := ReadHolder(t.Context(), path)
		if err != nil || !found || !held || pid != 202 {
			t.Fatalf("readHolder = %d/%t/%t/%v, want 202/true/true/nil", pid, found, held, err)
		}
	})

	t.Run("is unheld for content nobody wrote", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "x.lock")
		writeLockFile(t, path, "not a pid")
		pid, found, held, err := ReadHolder(t.Context(), path)
		if err != nil || !found || held || pid != 0 {
			t.Fatalf("readHolder = %d/%t/%t/%v, want 0/true/false/nil", pid, found, held, err)
		}
	})

	t.Run("reports a read error other than a missing file", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root bypasses permission bits")
		}
		path := filepath.Join(t.TempDir(), "x.lock")
		writeLockFile(t, path, "202\n")
		if err := os.Chmod(path, 0o000); err != nil {
			t.Fatalf("chmod %s: %v", path, err)
		}
		if _, _, _, err := ReadHolder(t.Context(), path); err == nil {
			t.Fatal("readHolder of a 0000 file succeeded")
		}
	})
}

func TestWaitLock(t *testing.T) {
	t.Run("returns the holder once the timeout passes", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "x.lock")
		writeLockFile(t, path, "202\n")
		isAlive := func(pid int64) bool { return pid == 202 }

		start := time.Now()
		if _, err := WaitLock(t.Context(), path, 101, isAlive, 25); holderOf(t, err) != 202 {
			t.Fatalf("waitLock holder pid = %d, want 202", holderOf(t, err))
		}
		if elapsed := time.Since(start); elapsed < 25*time.Millisecond {
			t.Fatalf("waitLock returned after %s, before its 25ms timeout", elapsed)
		}
	})

	t.Run("takes the lock once the holder dies", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "x.lock")
		writeLockFile(t, path, "202\n")
		calls := 0
		isAlive := func(pid int64) bool {
			if pid != 202 {
				return true
			}
			calls++
			return calls == 1 // alive on the first look only
		}

		release, err := WaitLock(t.Context(), path, 101, isAlive, 5_000)
		if err != nil {
			t.Fatalf("waitLock: %v", err)
		}
		if text := readLockText(t, path); text != "101\n" {
			t.Fatalf("lock file = %q, want %q", text, "101\n")
		}
		if err := release(t.Context()); err != nil {
			t.Fatalf("release: %v", err)
		}
		if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("release left the lock behind (stat err %v)", err)
		}
	})

	t.Run("acquires a free lock at once", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "x.lock")
		release, err := WaitLock(t.Context(), path, 101, func(int64) bool { return true }, 25)
		if err != nil {
			t.Fatalf("waitLock: %v", err)
		}
		if text := readLockText(t, path); text != "101\n" {
			t.Fatalf("lock file = %q, want %q", text, "101\n")
		}
		if err := release(context.Background()); err != nil {
			t.Fatalf("release: %v", err)
		}
	})
}
