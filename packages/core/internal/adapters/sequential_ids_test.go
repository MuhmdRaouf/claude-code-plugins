package adapters

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCreateSequentialIDs(t *testing.T) {
	// The instant the golden session pins: 2026-10-06T12:00:00.000Z.
	clock := CreateFixedClock(1791288000000)

	t.Run("job ids count by the pinned date, session ids by their uuid shape", func(t *testing.T) {
		root := t.TempDir()
		ids := CreateSequentialIDs(root, clock)

		if got := ids.JobID(); got != "261006-000001" {
			t.Errorf("first job id = %q, want 261006-000001", got)
		}
		if got := ids.JobID(); got != "261006-000002" {
			t.Errorf("second job id = %q, want 261006-000002", got)
		}
		if got := ids.SessionID(); got != "00000000-0000-4000-8000-000000000001" {
			t.Errorf("first session id = %q", got)
		}
		if got := ids.SessionID(); got != "00000000-0000-4000-8000-000000000002" {
			t.Errorf("second session id = %q", got)
		}
	})

	t.Run("a fresh wiring over the same root keeps counting, the session's every command one file", func(t *testing.T) {
		root := t.TempDir()
		if got := CreateSequentialIDs(root, clock).JobID(); got != "261006-000001" {
			t.Fatalf("first wiring job id = %q, want 261006-000001", got)
		}
		if got := CreateSequentialIDs(root, clock).JobID(); got != "261006-000002" {
			t.Fatalf("second wiring job id = %q, want 261006-000002", got)
		}
	})

	t.Run("the date prefix follows the clock a live session runs on", func(t *testing.T) {
		ids := CreateSequentialIDs(t.TempDir(), CreateFixedClock(time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC).UnixMilli()))
		if got := ids.JobID(); got != "261105-000001" {
			t.Errorf("job id = %q, want 261105-000001", got)
		}
	})

	t.Run("a lock a crashed holder left behind is waited out, not deadlocked on", func(t *testing.T) {
		root := t.TempDir()
		if err := os.Mkdir(filepath.Join(root, sequentialIdsLock), 0o700); err != nil {
			t.Fatal(err)
		}
		done := make(chan string, 1)
		go func() { done <- CreateSequentialIDs(root, clock).JobID() }()
		select {
		case got := <-done:
			if got != "261006-000001" {
				t.Errorf("job id = %q, want 261006-000001", got)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("the id allocation never came back from behind the stale lock")
		}
		if _, err := os.Stat(filepath.Join(root, sequentialIdsLock)); !os.IsNotExist(err) {
			t.Errorf("the lock dir survives: %v", err)
		}
	})
}

func TestCreateFixedClock(t *testing.T) {
	clock := CreateFixedClock(1791288000000)
	if got := clock.Now(); got != 1791288000000 {
		t.Errorf("now = %d, want the pinned instant", got)
	}
	if got := clock.Iso(); got != "2026-10-06T12:00:00.000Z" {
		t.Errorf("iso = %q, want 2026-10-06T12:00:00.000Z", got)
	}
	// Sleep stays real: only what is printed is pinned.
	if err := clock.Sleep(t.Context(), 0); err != nil {
		t.Errorf("sleep(0) = %v, want nil", err)
	}
}
