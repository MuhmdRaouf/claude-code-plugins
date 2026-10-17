package adapters

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// Sequential ids for the golden-transcript suite: one session's ids count 261006-000001,
// 261006-000002, ... across every command of the session. A subprocess CLI gets a fresh process per
// command, so the counters live in the state root, shared by every invocation and its detached
// drivers. Production never sets the pin and keeps CreateIds.

// sequentialIdsFile holds {"jobs":n,"sessions":n} under the state root.
const sequentialIdsFile = "sequential-ids.json"

// sequentialIdsLock is the mkdir lock two concurrent allocations take turns on.
const sequentialIdsLock = "sequential-ids.lock"

// sequentialIdsStealMs is how long a stuck lock is waited out before it is taken away: only a
// crashed holder can leave it behind, and one session's drivers never overlap allocations.
const sequentialIdsStealMs = 500

// CreateSequentialIDs counts ids in root, one file shared by every process of the session. The
// date prefix of a job id follows clock, so a pinned clock keeps it fixed too.
func CreateSequentialIDs(root string, clock ports.Clock) ports.Ids {
	return sequentialIds{root: root, clock: clock}
}

type sequentialIds struct {
	root  string
	clock ports.Clock
}

func (s sequentialIds) JobID() string {
	n := s.next("jobs")
	date := time.UnixMilli(s.clock.Now()).UTC().Format("060102")
	return fmt.Sprintf("%s-%06d", date, n)
}

func (s sequentialIds) SessionID() string {
	n := s.next("sessions")
	return fmt.Sprintf("00000000-0000-4000-8000-%012d", n)
}

// sequentialCounters is the shared file's content.
type sequentialCounters struct {
	Jobs     int64 `json:"jobs"`
	Sessions int64 `json:"sessions"`
}

// next increments counter under the lock and returns its new value. The file is rig state a test
// reads back through, so an I/O failure is a programmer error: panic, the way a broken clock would
// be.
func (s sequentialIds) next(counter string) int64 {
	lock := filepath.Join(s.root, sequentialIdsLock)
	s.takeLock(lock)
	defer os.Remove(lock)

	path := filepath.Join(s.root, sequentialIdsFile)
	var counters sequentialCounters
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &counters)
	}
	var value int64
	if counter == "jobs" {
		counters.Jobs++
		value = counters.Jobs
	} else {
		counters.Sessions++
		value = counters.Sessions
	}
	raw, err := json.Marshal(counters)
	if err != nil {
		panic(err)
	}
	if _, err := fsutil.WriteFileAtomic(context.Background(), path, raw,
		fsutil.WriteOptions{Mode: fsutil.Perm(0o600)}); err != nil {
		panic(err)
	}
	return value
}

// takeLock owns lock: mkdir, the one create that cannot succeed twice. A holder that died with the
// lock is waited out and dispossessed rather than deadlocking the session.
func (s sequentialIds) takeLock(lock string) {
	deadline := time.Now().Add(time.Duration(sequentialIdsStealMs) * time.Millisecond)
	for {
		if err := os.Mkdir(lock, 0o700); err == nil {
			return
		}
		if time.Now().After(deadline) {
			_ = os.RemoveAll(lock)
			_ = os.Mkdir(lock, 0o700)
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
}
