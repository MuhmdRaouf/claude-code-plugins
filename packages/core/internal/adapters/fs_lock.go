package adapters

import (
	"context"
	crand "crypto/rand"
	"errors"
	"fmt"
	"io/fs"
	"math/rand/v2"
	"os"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// Lock files: an atomic create that names its holder, the reclaim of a dead holder's lock, and
// the wait that polls one.

// Release frees a lock TryLock or WaitLock acquired; it releases only the caller's own lock, so a
// late or repeated release never frees someone else's.
type Release func(ctx context.Context) error

// IsAlive reports whether pid names a live process (EPERM: alive, someone else's).
type IsAlive func(pid int64) bool

// HeldError is TryLock's and WaitLock's failure: the pid that holds the lock, 0 when the file
// holds nothing anybody wrote.
type HeldError struct {
	HolderPid int64
}

func (e *HeldError) Error() string {
	return fmt.Sprintf("lock held by pid %d", e.HolderPid)
}

// reclaimAttempts is how often TryLock re-reads a lock it found stale before reporting it held.
const reclaimAttempts = 5

// CreateExclusive creates path containing text, atomically: the file appears complete or not at
// all, and only if it did not exist (link(2) fails with EEXIST), so a reader never sees it
// half-written.
func CreateExclusive(ctx context.Context, path, text string) (bool, error) {
	tmp := fmt.Sprintf("%s.%s.tmp", path, crand.Text())
	writeErr := writeTempExclusive(tmp, text)
	var linkErr error
	if writeErr == nil {
		linkErr = retryBusy(func() error { return os.Link(tmp, path) })
	}
	removeErr := removeForce(tmp)
	switch {
	case writeErr != nil:
		return false, writeErr
	case linkErr != nil && fsutil.ErrnoCode(linkErr) != "EEXIST":
		return false, linkErr
	case removeErr != nil:
		return false, removeErr
	}
	return linkErr == nil, nil
}

// writeTempExclusive writes text to a file that must not exist yet: O_CREATE|O_EXCL, mode 0666
// under the umask.
func writeTempExclusive(tmp, text string) error {
	var file *os.File
	openErr := retryBusy(func() error {
		var err error
		file, err = os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
		return err
	})
	if openErr != nil {
		return openErr
	}
	_, err := file.WriteString(text)
	return errors.Join(err, file.Close())
}

// CreateHolding is CreateExclusive holding pid: a lock file a reader never sees without its
// holder.
func CreateHolding(ctx context.Context, path string, pid int64) (bool, error) {
	return CreateExclusive(ctx, path, fmt.Sprintf("%d\n", pid))
}

// ReadHolder reads who holds the lock file: found is false when there is no file, and held is
// false when its content is not a pid our code wrote — never written by us, so nobody holds it. A
// read error other than a missing file is returned.
func ReadHolder(ctx context.Context, path string) (pid int64, found, held bool, err error) {
	var text []byte
	err = retryBusy(func() error {
		var readErr error
		text, readErr = os.ReadFile(path)
		return readErr
	})
	if err != nil {
		if fsutil.ErrnoCode(err) == "ENOENT" {
			return 0, false, false, nil
		}
		return 0, false, false, err
	}
	pid, held = domain.ParsePid(string(text))
	return pid, true, held, nil
}

// isStale: a holder nobody can name, or one that is dead.
func isStale(held bool, pid int64, isAlive IsAlive) bool {
	return !held || !isAlive(pid)
}

// reclaim deletes path if it is still held by stale. Deleting is a check-then-act, so reclaimers
// serialise on a guard file: without it, a reclaimer that read the stale pid could delete the
// fresh lock another reclaimer created meanwhile. A guard left by a reclaimer that died is
// cleared for the next round.
func reclaim(ctx context.Context, path string, staleHeld bool, stalePid int64, pid int64, isAlive IsAlive) error {
	guard := path + ".reclaim"
	created, err := CreateHolding(ctx, guard, pid)
	if err != nil {
		return err
	}
	if !created {
		guardPid, guardFound, guardHeld, err := ReadHolder(ctx, guard)
		if err != nil {
			return err
		}
		if guardFound && isStale(guardHeld, guardPid, isAlive) {
			return removeForce(guard)
		}
		return nil
	}
	err = deleteIfHeldBy(ctx, path, staleHeld, stalePid)
	// The guard goes whether or not the delete worked, and its failure outranks the delete's.
	if cleanupErr := removeForce(guard); err == nil {
		err = cleanupErr
	}
	return err
}

// deleteIfHeldBy removes the lock only while it still names the same holder the reclaimer read:
// garbage matches garbage, a pid matches itself, and anything else — including no file at all —
// matches nothing.
func deleteIfHeldBy(ctx context.Context, path string, staleHeld bool, stalePid int64) error {
	pid, found, held, err := ReadHolder(ctx, path)
	if err != nil {
		return err
	}
	same := found && ((!held && !staleHeld) || (held && staleHeld && pid == stalePid))
	if same {
		return removeForce(path)
	}
	return nil
}

// release releases only our own lock, so a late or repeated release never frees someone else's.
func release(ctx context.Context, path string, pid int64) error {
	holder, found, held, err := ReadHolder(ctx, path)
	if err != nil {
		return err
	}
	if found && held && holder == pid {
		return removeForce(path)
	}
	return nil
}

// TryLock takes an exclusive lock file holding pid; a lock whose holder is dead is reclaimed.
func TryLock(ctx context.Context, path string, pid int64, isAlive IsAlive) (Release, error) {
	for attempt := 1; attempt <= reclaimAttempts; attempt++ {
		created, err := CreateHolding(ctx, path, pid)
		if err != nil {
			return nil, err
		}
		if created {
			return func(ctx context.Context) error { return release(ctx, path, pid) }, nil
		}
		holder, found, held, err := ReadHolder(ctx, path)
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}
		if held && isAlive(holder) {
			return nil, &HeldError{HolderPid: holder}
		}
		if err := reclaim(ctx, path, held, holder, pid, isAlive); err != nil {
			return nil, err
		}
		pause(ctx, time.Duration(attempt)*time.Millisecond)
	}
	holder, _, held, err := ReadHolder(ctx, path)
	if err != nil {
		return nil, err
	}
	if held {
		return nil, &HeldError{HolderPid: holder}
	}
	return nil, &HeldError{HolderPid: 0}
}

// WaitLock is TryLock retried with a short jittered pause until timeoutMs: for locks that are
// only ever held briefly.
func WaitLock(ctx context.Context, path string, pid int64, isAlive IsAlive, timeoutMs int64) (Release, error) {
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	for {
		lock, err := TryLock(ctx, path, pid, isAlive)
		if err == nil || !time.Now().Before(deadline) {
			return lock, err
		}
		pause(ctx, time.Duration(2+rand.Float64()*8)*time.Millisecond)
	}
}

// retryBusy runs op until it succeeds, answering anything but a retryable error at once and
// retrying one a bounded number of times (retryable names the answers it waits out).
func retryBusy(op func() error) error {
	for attempt := 0; ; attempt++ {
		err := op()
		if err == nil {
			return nil
		}
		if !retryable(err) || attempt >= removeForceAttempts {
			return err
		}
		time.Sleep(removeForcePause)
	}
}

// removeForce is rm(path, { force: true }): a missing file is fine, any other failure is an
// error. A busy answer is retried past the collision, so a lock or slot file is retired rather
// than left naming a holder nobody can reclaim.
func removeForce(path string) error {
	return retryBusy(func() error {
		err := os.Remove(path)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	})
}

// removeForceAttempts × removeForcePause bounds every retry — the delete's and the opens',
// reads' and links' alike: processes hold these files for microseconds, so a second of trying is
// beyond any honest collision.
const (
	removeForceAttempts = 40
	removeForcePause    = 25 * time.Millisecond
)

// pause sleeps for d, cut short when ctx is done: cancellation only shortens the wait, never
// skips the round it ends.
func pause(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
