package adapters

import (
	"bufio"
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// The fs job store, the fs semaphore and the fs limiter. The multi-process cases re-execute
// this test binary in a child mode (runStoreChild); the fs-lock cases live in fs_lock_test.go,
// and the errno helpers in fsutil_test.go.

const (
	storeChildModeEnv = "ADP_STORE_TEST_CHILD"
	storeChildRootEnv = "ADP_STORE_TEST_ROOT"
	storeChildIDEnv   = "ADP_STORE_TEST_ID"
)

func TestMain(m *testing.M) {
	// The orphan launcher SpawnOrphan re-runs this test binary as (see process.OrphanLaunch).
	if len(os.Args) > 1 && os.Args[1] == "--orphan-launch" {
		os.Exit(process.OrphanLaunch(os.Args[2:]))
	}
	if mode := os.Getenv(storeChildModeEnv); mode != "" {
		runStoreChild(mode)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// runStoreChild is the store child the suite spawns: one mode per case, configured through
// the environment, reporting JSON lines on stdout.
func runStoreChild(mode string) {
	ctx := context.Background()
	root := os.Getenv(storeChildRootEnv)
	id := os.Getenv(storeChildIDEnv)
	report := func(value any) {
		data, err := json.Marshal(value)
		if err != nil {
			os.Exit(1)
		}
		fmt.Println(string(data))
	}
	switch mode {
	case "crash-on-rename":
		// The writer dies (SIGKILL, no cleanup) at the instant it would rename its fsynced tmp
		// file over job.json: the store's write is the lock, the fsynced tmp, then the rename.
		store := CreateFsStore(root, process.IsAlive)
		current, err := store.Get(ctx, id)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		file := filepath.Join(root, "jobs", id, "job.json")
		lock, err := WaitLock(ctx, file+".lock", int64(os.Getpid()), process.IsAlive, writeLockTimeoutMs)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		defer func() { _ = lock(ctx) }()
		current.State = domain.JobStateRunning
		current.Version++
		data, err := fsutil.MarshalJSON(current)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		tmp := fmt.Sprintf("%s.tmp-%d-%s", file, os.Getpid(), crand.Text())
		handle, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if _, err := handle.Write(data); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := errors.Join(handle.Sync(), handle.Close()); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		self, err := os.FindProcess(os.Getpid())
		if err == nil {
			err = self.Kill() // SIGKILL on unix: no deferred cleanup runs, like a crash
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		select {}
	case "busy-writer":
		store := CreateFsStore(root, process.IsAlive)
		big := strings.Repeat("x", 2_000_000)
		for n := int64(0); ; n++ {
			current, err := store.Get(ctx, id)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			current.Attempts = []domain.Attempt{{
				N: n, Kind: domain.AttemptKindInitial, Prompt: big + fmt.Sprint(n),
				SessionID: "s", StartedAt: "t",
			}}
			if _, err := store.Update(ctx, current); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			if n == 0 {
				fmt.Println("ready")
			}
		}
	case "driver-lock-race":
		store := CreateFsStore(root, process.IsAlive)
		childStartTogether(root)
		lock, err := store.Lock(ctx, id, int64(os.Getpid()))
		if err != nil {
			var storeErr *ports.StoreError
			if errors.As(err, &storeErr) {
				report(map[string]any{"kind": string(storeErr.Kind), "holderPid": storeErr.HolderPid})
			} else {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		}
		report(map[string]any{"won": os.Getpid()})
		time.Sleep(time.Second)
		lock()
	case "share-cap":
		sleep := func(ctx context.Context, ms int64) error {
			timer := time.NewTimer(time.Duration(1+rand.Int64N(3)) * time.Millisecond)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				return nil
			}
		}
		semaphore := CreateFsSemaphore(root,
			func(context.Context) (int, error) { return 2, nil },
			process.IsAlive, sleep, func() int64 { return time.Now().UnixMilli() })
		childStartTogether(root)
		events := filepath.Join(root, "events.log")
		pid := os.Getpid()
		for round := 0; round < 6; round++ {
			release, err := semaphore.Acquire(ctx, ports.SemaphoreHolder{
				JobID: "job-" + fmt.Sprint(pid), Pid: int64(pid), Priority: domain.PriorityNormal,
			})
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			appendLine(events, "enter "+fmt.Sprint(pid)+"\n")
			time.Sleep(15 * time.Millisecond)
			appendLine(events, "exit "+fmt.Sprint(pid)+"\n")
			release()
		}
	case "limiter-waves":
		config := domain.LimiterConfig{
			Min: 1, DefaultMax: 4, DecreaseFactor: 0.75,
			WindowMs: 2_000, CooldownMs: 60_000, IncreaseAfterMs: 120_000,
		}
		limiter := CreateFsLimiter(root, config)
		childStartTogether(root)
		if err := limiter.RateLimited(ctx, 1000+rand.Int64N(100), ports.RateLimitOptions{}); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		// Every first-wave event goes in before any second-wave one: interleaved, the quorum's
		// one decrease could land on a second-wave clock and put the whole second wave inside its
		// cooldown.
		if err := os.WriteFile(filepath.Join(root, "second-"+fmt.Sprint(os.Getpid())), nil, 0o600); err != nil {
			os.Exit(1)
		}
		deadline := time.Now().Add(30 * time.Second)
		for !sixSecondMarks(root) {
			if time.Now().After(deadline) {
				os.Exit(3)
			}
			time.Sleep(2 * time.Millisecond)
		}
		if err := limiter.RateLimited(ctx, 70000+rand.Int64N(100), ports.RateLimitOptions{}); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		report(map[string]any{"done": true})
	}
}

// childStartTogether releases every child at once: a "ready" file first, then the shared "go".
func childStartTogether(dir string) {
	if err := os.WriteFile(filepath.Join(dir, "ready-"+fmt.Sprint(os.Getpid())), nil, 0o600); err != nil {
		os.Exit(1)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(dir, "go")); err == nil {
			return
		}
		if time.Now().After(deadline) {
			os.Exit(3)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func sixSecondMarks(root string) bool {
	entries, err := os.ReadDir(root)
	if err != nil {
		return false
	}
	count := 0
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "second-") {
			count++
		}
	}
	return count >= 6
}

func appendLine(path, line string) {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		os.Exit(1)
	}
	defer file.Close()
	if _, err := file.WriteString(line); err != nil {
		os.Exit(1)
	}
}

// storeChildEnv is the whole environment a store child mode needs; GOCOVERDIR comes along when
// the test run itself is covered.
func storeChildEnv(mode, root, id string) []string {
	env := []string{
		storeChildModeEnv + "=" + mode,
		storeChildRootEnv + "=" + root,
		storeChildIDEnv + "=" + id,
	}
	if dir := os.Getenv("GOCOVERDIR"); dir != "" {
		env = append(env, "GOCOVERDIR="+dir)
	}
	return env
}

func selfExe(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	return exe
}

// runTogether spawns n children in one mode, releases them at once (the "go" file in dir) and
// collects what each reported on stdout as JSON lines.
func runTogether(t *testing.T, dir, mode, id string, n int) []map[string]any {
	t.Helper()
	type childProcess struct {
		cmd *exec.Cmd
		out *bytes.Buffer
	}
	children := make([]*childProcess, 0, n)
	for range n {
		cmd := exec.Command(selfExe(t))
		cmd.Env = storeChildEnv(mode, dir, id)
		cmd.Stderr = os.Stderr
		out := &bytes.Buffer{}
		cmd.Stdout = out
		if err := cmd.Start(); err != nil {
			t.Fatalf("start child: %v", err)
		}
		children = append(children, &childProcess{cmd: cmd, out: out})
	}
	// A failed assertion must not leave children waiting for "go" (they would linger).
	t.Cleanup(func() {
		for _, c := range children {
			_ = c.cmd.Process.Kill()
		}
	})
	waitFor(t, 15*time.Second, func() bool {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("readdir %s: %v", dir, err)
		}
		ready := 0
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "ready-") {
				ready++
			}
		}
		return ready >= n
	})
	if err := os.WriteFile(filepath.Join(dir, "go"), nil, 0o600); err != nil {
		t.Fatalf("write go: %v", err)
	}
	var reports []map[string]any
	for _, c := range children {
		if err := c.cmd.Wait(); err != nil {
			t.Fatalf("child %d exited with %v (stderr above)", c.cmd.Process.Pid, err)
		}
		for _, line := range strings.Split(strings.TrimSpace(c.out.String()), "\n") {
			if line == "" {
				continue
			}
			var report map[string]any
			if err := json.Unmarshal([]byte(line), &report); err != nil {
				t.Fatalf("child %d reported %q: %v", c.cmd.Process.Pid, line, err)
			}
			reports = append(reports, report)
		}
	}
	return reports
}

// waitFor polls every 10 ms until ready or the timeout, failing the test on the timeout.
func waitFor(t *testing.T, timeout time.Duration, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for the condition")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// eventually waits for what a waiter reaches only by polling: with two waiters taking turns on
// the mutex, a fixed sleep races a slow round on a loaded machine.
func eventually(t *testing.T, ready func() bool) {
	t.Helper()
	for range 100 {
		if ready() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition never became true")
}

// testJob is one full brief, no attempts yet.
func testJob(id string, overrides ...func(*domain.Job)) domain.Job {
	job := domain.Job{
		ID: id,
		Brief: domain.Brief{
			Title:     "job " + id,
			Body:      "Do the thing.",
			Model:     domain.ModelTierMain,
			Mode:      domain.ModeEdit,
			Cwd:       "/repo",
			Base:      "HEAD",
			Scope:     []string{"**"},
			Forbid:    []string{},
			Gates:     []domain.Gate{{Run: "npm test", TimeoutMs: 600_000}},
			TimeoutMs: 7_200_000,
			Retries:   domain.Retries{Fix: 1, Infra: 2},
			Report:    domain.Report{Kind: domain.ReportKindBuiltin, Name: domain.BuiltinReportChange},
			AddDirs:   []string{},
			Env:       []string{},
			Tags:      []string{},
		},
		State:     domain.JobStateQueued,
		Workspace: domain.Workspace{RepoRoot: "/repo", BaseSha: strings.Repeat("a", 40), ArtifactsDir: "/state/artifacts"},
		Attempts:  []domain.Attempt{},
		CreatedAt: "2026-10-06T10:00:00.000Z",
		UpdatedAt: "2026-10-06T10:00:00.000Z",
		Version:   0,
	}
	for _, override := range overrides {
		override(&job)
	}
	return job
}

// asStoreErr fails unless err is the store's own error, and returns it.
func asStoreErr(t *testing.T, err error) *ports.StoreError {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error, got none")
	}
	var storeErr *ports.StoreError
	if !errors.As(err, &storeErr) {
		t.Fatalf("error %v is not a store error", err)
	}
	return storeErr
}

// storedWithOrigin is a job.json an older or foreign writer left an `origin` of any shape in;
// the embedded field order keeps the store's own order with `origin` last.
type storedWithOrigin struct {
	domain.Job
	Origin any `json:"origin"`
}

func TestFsStore(t *testing.T) {
	t.Run(`reads a job stored with the legacy "glm" tier as main`, func(t *testing.T) {
		root := t.TempDir()
		store := CreateFsStore(root, process.IsAlive)
		original := testJob("261006-legacy")
		if _, err := store.Create(t.Context(), original); err != nil {
			t.Fatalf("create: %v", err)
		}
		file := filepath.Join(root, "jobs", original.ID, "job.json")
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		patched := strings.Replace(string(raw), `"model": "main"`, `"model": "glm"`, 1)
		if patched == string(raw) {
			t.Fatal("the stored brief does not name the main tier")
		}
		if err := os.WriteFile(file, []byte(patched), 0o600); err != nil {
			t.Fatalf("write %s: %v", file, err)
		}
		read, err := store.Get(t.Context(), original.ID)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		if read.Brief.Model != domain.ModelTierMain {
			t.Fatalf("model = %q, want main", read.Brief.Model)
		}
	})

	t.Run("create then get round-trips the job; create twice errors", func(t *testing.T) {
		store := CreateFsStore(t.TempDir(), process.IsAlive)
		original := testJob("261006-abc123")

		created, err := store.Create(t.Context(), original)
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		want := original
		want.Version = 1
		if !reflect.DeepEqual(created, want) {
			t.Fatalf("created = %+v, want %+v", created, want)
		}
		got, err := store.Get(t.Context(), original.ID)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		if !reflect.DeepEqual(got, created) {
			t.Fatalf("get = %+v, want %+v", got, created)
		}
		_, err = store.Create(t.Context(), original)
		storeErr := asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorIO || storeErr.Message != "job 261006-abc123 already exists" {
			t.Fatalf("second create = %+v, want io \"job 261006-abc123 already exists\"", storeErr)
		}
		_, err = store.Get(t.Context(), "261006-zzzzzz")
		storeErr = asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorNotFound || storeErr.ID != "261006-zzzzzz" {
			t.Fatalf("get of a missing job = %+v, want not_found 261006-zzzzzz", storeErr)
		}
	})

	t.Run("a stored origin round-trips; a job without one still reads; a malformed origin is dropped", func(t *testing.T) {
		root := t.TempDir()
		store := CreateFsStore(root, process.IsAlive)
		sessionID := "f81d4fae-7dec-41d0-a765-00a0c91e6bf6"
		withOrigin := testJob("261006-org001", func(j *domain.Job) {
			j.Origin = &domain.Origin{SessionID: sessionID}
		})
		plain := testJob("261006-org002")

		created, err := store.Create(t.Context(), withOrigin)
		if err != nil {
			t.Fatalf("create with origin: %v", err)
		}
		want := withOrigin
		want.Version = 1
		if !reflect.DeepEqual(created, want) {
			t.Fatalf("created = %+v, want %+v", created, want)
		}
		bare, err := store.Create(t.Context(), plain)
		if err != nil {
			t.Fatalf("create plain: %v", err)
		}
		bareWant := plain
		bareWant.Version = 1
		if !reflect.DeepEqual(bare, bareWant) {
			t.Fatalf("created = %+v, want %+v", bare, bareWant)
		}
		readBack, err := store.Get(t.Context(), withOrigin.ID)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		if !reflect.DeepEqual(readBack.Origin, &domain.Origin{SessionID: sessionID}) {
			t.Fatalf("origin = %+v, want session %s", readBack.Origin, sessionID)
		}

		// Written by an older or foreign writer: read without the origin, not an error.
		malformed := []struct {
			id     string
			origin any
		}{
			{"261006-org003", sessionID},
			{"261006-org004", map[string]any{"sessionId": 42}},
			{"261006-org005", map[string]any{"noSession": true}},
			{"261006-org006", nil},
		}
		for _, bad := range malformed {
			if err := os.MkdirAll(filepath.Join(root, "jobs", bad.id), 0o755); err != nil {
				t.Fatalf("mkdir %s: %v", bad.id, err)
			}
			stored := plain
			stored.ID = bad.id
			data, err := json.Marshal(storedWithOrigin{Job: stored, Origin: bad.origin})
			if err != nil {
				t.Fatalf("marshal %s: %v", bad.id, err)
			}
			file := filepath.Join(root, "jobs", bad.id, "job.json")
			if err := os.WriteFile(file, data, 0o600); err != nil {
				t.Fatalf("write %s: %v", file, err)
			}
			read, err := store.Get(t.Context(), bad.id)
			if err != nil {
				t.Fatalf("get %s: %v", bad.id, err)
			}
			want := plain
			want.ID = bad.id
			if !reflect.DeepEqual(read, want) {
				t.Fatalf("get %s = %+v, want %+v", bad.id, read, want)
			}
			if read.Origin != nil {
				t.Fatalf("get %s kept the malformed origin %+v", bad.id, read.Origin)
			}
		}
	})

	t.Run("update with a stale version → version_conflict; with the current version bumps it", func(t *testing.T) {
		store := CreateFsStore(t.TempDir(), process.IsAlive)
		created, err := store.Create(t.Context(), testJob("261006-upd001"))
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		running := created
		running.State = domain.JobStateRunning

		updated, err := store.Update(t.Context(), running)
		if err != nil {
			t.Fatalf("update: %v", err)
		}
		want := running
		want.Version = 2
		if !reflect.DeepEqual(updated, want) {
			t.Fatalf("updated = %+v, want %+v", updated, want)
		}
		stale := created
		stale.State = domain.JobStateDiscarded
		_, err = store.Update(t.Context(), stale)
		storeErr := asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorVersionConflict || storeErr.ID != "261006-upd001" ||
			storeErr.Expected != 1 || storeErr.Actual != 2 {
			t.Fatalf("stale update = %+v, want version_conflict 261006-upd001 1/2", storeErr)
		}
		stored, err := store.Get(t.Context(), "261006-upd001")
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		if !reflect.DeepEqual(stored, updated) {
			t.Fatalf("get = %+v, want %+v", stored, updated)
		}
		_, err = store.Update(t.Context(), testJob("261006-nope00"))
		storeErr = asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorNotFound || storeErr.ID != "261006-nope00" {
			t.Fatalf("update of a missing job = %+v, want not_found 261006-nope00", storeErr)
		}
	})

	t.Run("concurrent updates from the same version: exactly one wins", func(t *testing.T) {
		store := CreateFsStore(t.TempDir(), process.IsAlive)
		created, err := store.Create(t.Context(), testJob("261006-race01"))
		if err != nil {
			t.Fatalf("create: %v", err)
		}

		const writers = 8
		results := make([]error, writers)
		var wg sync.WaitGroup
		for i := range writers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				writer := created
				writer.UpdatedAt = "writer " + fmt.Sprint(i)
				_, results[i] = store.Update(t.Context(), writer)
			}()
		}
		wg.Wait()

		wins := 0
		conflicts := 0
		for _, err := range results {
			if err == nil {
				wins++
				continue
			}
			if storeErr := asStoreErr(t, err); storeErr.Kind == ports.StoreErrorVersionConflict {
				conflicts++
			}
		}
		if wins != 1 || conflicts != writers-1 {
			t.Fatalf("%d wins and %d conflicts, want 1 and %d", wins, conflicts, writers-1)
		}
		stored, err := store.Get(t.Context(), "261006-race01")
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		if stored.Version != 2 {
			t.Fatalf("version = %d, want 2", stored.Version)
		}
	})

	t.Run("writes are atomic: a crash between tmp write and rename never leaves a torn job.json", func(t *testing.T) {
		root := t.TempDir()
		store := CreateFsStore(root, process.IsAlive)
		created, err := store.Create(t.Context(), testJob("261006-crash1"))
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		child := exec.Command(selfExe(t))
		child.Env = storeChildEnv("crash-on-rename", root, "261006-crash1")
		child.Stderr = os.Stderr
		if err := child.Start(); err != nil {
			t.Fatalf("start the writer: %v", err)
		}
		t.Cleanup(func() { _ = child.Process.Kill() })
		if err := child.Wait(); err == nil {
			t.Fatal("the writer exited cleanly, want a SIGKILL")
		}
		if status, ok := child.ProcessState.Sys().(syscall.WaitStatus); !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
			t.Fatalf("the writer exit = %v, want a SIGKILL", child.ProcessState)
		}

		dir := filepath.Join(root, "jobs", "261006-crash1")
		tmps, err := filepath.Glob(filepath.Join(dir, fmt.Sprintf("job.json.tmp-%d-*", child.Process.Pid)))
		if err != nil {
			t.Fatalf("glob: %v", err)
		}
		if len(tmps) != 1 {
			t.Fatalf("tmp files = %v, want the dead writer's one in %s", tmps, dir)
		}
		if _, err := os.Stat(filepath.Join(dir, "job.json.lock")); err != nil {
			t.Fatalf("the dead writer's lock file: %v", err)
		}
		survived, err := store.Get(t.Context(), "261006-crash1")
		if err != nil {
			t.Fatalf("get after the crash: %v", err)
		}
		if !reflect.DeepEqual(survived, created) {
			t.Fatalf("get after the crash = %+v, want %+v", survived, created)
		}
		// The dead writer's write lock is reclaimed and its tmp file never read.
		running := created
		running.State = domain.JobStateRunning
		next, err := store.Update(t.Context(), running)
		if err != nil {
			t.Fatalf("update after the crash: %v", err)
		}
		want := running
		want.Version = 2
		if !reflect.DeepEqual(next, want) {
			t.Fatalf("update after the crash = %+v, want %+v", next, want)
		}
	})

	t.Run("random SIGKILLs of a busy writer never leave job.json unreadable", func(t *testing.T) {
		root := t.TempDir()
		store := CreateFsStore(root, process.IsAlive)
		created, err := store.Create(t.Context(), testJob("261006-crash2"))
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		version := created.Version

		for round := range 6 {
			child := exec.Command(selfExe(t))
			child.Env = storeChildEnv("busy-writer", root, "261006-crash2")
			child.Stderr = os.Stderr
			stdout, err := child.StdoutPipe()
			if err != nil {
				t.Fatalf("stdout pipe: %v", err)
			}
			if err := child.Start(); err != nil {
				t.Fatalf("start the writer: %v", err)
			}
			t.Cleanup(func() { _ = child.Process.Kill() })
			line, err := bufio.NewReader(stdout).ReadString('\n')
			if err != nil || strings.TrimSpace(line) != "ready" {
				_ = child.Wait()
				t.Fatalf("the writer's first line = %q (err %v), want ready", line, err)
			}
			time.Sleep(time.Duration(rand.Float64() * float64(40*time.Millisecond)))
			if err := child.Process.Kill(); err != nil {
				t.Fatalf("kill the writer: %v", err)
			}
			if err := child.Wait(); err == nil {
				t.Fatal("the writer exited cleanly, want a kill")
			}

			survived, err := store.Get(t.Context(), "261006-crash2")
			if err != nil {
				t.Fatalf("round %d: get after the kill: %v", round, err)
			}
			if survived.Version <= version {
				t.Fatalf("round %d: version = %d, want more than %d", round, survived.Version, version)
			}
			next, err := store.Update(t.Context(), survived)
			if err != nil {
				t.Fatalf("round %d: update after the kill: %v", round, err)
			}
			version = next.Version
		}
	})

	t.Run("find resolves a unique prefix; ambiguous or missing prefix → not_found", func(t *testing.T) {
		store := CreateFsStore(t.TempDir(), process.IsAlive)
		for _, id := range []string{"261006-aaa111", "261006-aab222", "261007-ccc333"} {
			if _, err := store.Create(t.Context(), testJob(id)); err != nil {
				t.Fatalf("create %s: %v", id, err)
			}
		}
		idOf := func(prefix string) any {
			found, err := store.Find(t.Context(), prefix)
			if err == nil {
				return found.ID
			}
			return asStoreErr(t, err)
		}
		for _, table := range []struct {
			prefix string
			want   string
		}{
			{"261006-aaa111", "261006-aaa111"},
			{"261006-aab", "261006-aab222"},
			{"261007", "261007-ccc333"},
		} {
			if got := idOf(table.prefix); got != table.want {
				t.Fatalf("find(%q) = %v, want %v", table.prefix, got, table.want)
			}
		}
		for _, prefix := range []string{"261006-aa", "261008", "", "../jobs"} {
			got := idOf(prefix)
			storeErr, ok := got.(*ports.StoreError)
			if !ok || storeErr.Kind != ports.StoreErrorNotFound || storeErr.ID != prefix {
				t.Fatalf("find(%q) = %v, want not_found %q", prefix, got, prefix)
			}
		}
	})

	t.Run("find and list on an empty store find nothing", func(t *testing.T) {
		store := CreateFsStore(filepath.Join(t.TempDir(), "never-created"), process.IsAlive)
		_, err := store.Find(t.Context(), "261006")
		storeErr := asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorNotFound || storeErr.ID != "261006" {
			t.Fatalf("find = %+v, want not_found 261006", storeErr)
		}
		if jobs := store.List(t.Context(), ports.ListFilter{}); len(jobs) != 0 {
			t.Fatalf("list = %d jobs, want none", len(jobs))
		}
	})

	t.Run("list returns jobs newest first, filtered by repoRoot", func(t *testing.T) {
		root := t.TempDir()
		store := CreateFsStore(root, process.IsAlive)
		at := func(id, createdAt, repoRoot string) domain.Job {
			return testJob(id, func(j *domain.Job) {
				j.CreatedAt = createdAt
				j.Workspace = domain.Workspace{
					RepoRoot: repoRoot, BaseSha: strings.Repeat("b", 40), ArtifactsDir: "/a",
				}
			})
		}
		for _, job := range []domain.Job{
			at("261006-old000", "2026-10-06T08:00:00.000Z", "/repo/one"),
			at("261006-new000", "2026-10-06T12:00:00.000Z", "/repo/one"),
			at("261006-mid000", "2026-10-06T10:00:00.000Z", "/repo/two"),
			at("261006-tie000", "2026-10-06T10:00:00.000Z", "/repo/one"),
		} {
			if _, err := store.Create(t.Context(), job); err != nil {
				t.Fatalf("create %s: %v", job.ID, err)
			}
		}
		// Neither a half-created job directory nor a foreign or corrupt file breaks the listing.
		if err := os.MkdirAll(filepath.Join(root, "jobs", "261006-empty0"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.MkdirAll(filepath.Join(root, "jobs", "261006-junk00"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(filepath.Join(root, "jobs", "261006-junk00", "job.json"),
			[]byte(`{"id": "261006-junk00", "trunc`), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		if err := os.WriteFile(filepath.Join(root, "jobs", "README"), []byte("not a job"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}

		ids := func(jobs []domain.Job) []string {
			names := make([]string, 0, len(jobs))
			for _, listed := range jobs {
				names = append(names, listed.ID)
			}
			return names
		}
		if got := ids(store.List(t.Context(), ports.ListFilter{})); !slices.Equal(got,
			[]string{"261006-new000", "261006-tie000", "261006-mid000", "261006-old000"}) {
			t.Fatalf("list = %v", got)
		}
		if got := ids(store.List(t.Context(), ports.ListFilter{RepoRoot: "/repo/one"})); !slices.Equal(got,
			[]string{"261006-new000", "261006-tie000", "261006-old000"}) {
			t.Fatalf("list(/repo/one) = %v", got)
		}
		if jobs := store.List(t.Context(), ports.ListFilter{RepoRoot: "/repo/none"}); len(jobs) != 0 {
			t.Fatalf("list(/repo/none) = %d jobs, want none", len(jobs))
		}
		_, err := store.Get(t.Context(), "261006-junk00")
		storeErr := asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorIO ||
			!strings.Contains(storeErr.Message, "261006-junk00: unreadable job.json") {
			t.Fatalf("get of the junk job = %+v, want io naming 261006-junk00: unreadable job.json", storeErr)
		}
	})

	t.Run("lock is exclusive; a second lock → locked with holder pid; a dead holder is reclaimed; release frees it", func(t *testing.T) {
		alive := newAliveSet(101, 202, 303)
		store := CreateFsStore(t.TempDir(), alive.isAlive)
		if _, err := store.Create(t.Context(), testJob("261006-lock01")); err != nil {
			t.Fatalf("create: %v", err)
		}

		first, err := store.Lock(t.Context(), "261006-lock01", 101)
		if err != nil {
			t.Fatalf("first lock: %v", err)
		}
		_, err = store.Lock(t.Context(), "261006-lock01", 202)
		storeErr := asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorLocked || storeErr.ID != "261006-lock01" || storeErr.HolderPid != 101 {
			t.Fatalf("second lock = %+v, want locked by 101", storeErr)
		}
		_, err = store.Lock(t.Context(), "261006-lock01", 101)
		storeErr = asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorLocked || storeErr.HolderPid != 101 {
			t.Fatalf("the holder's own second lock = %+v, want locked by 101", storeErr)
		}

		alive.kill(101)
		reclaimed, err := store.Lock(t.Context(), "261006-lock01", 202)
		if err != nil {
			t.Fatalf("reclaim: %v", err)
		}
		// The dead holder's late release must not free the new holder's lock.
		first()
		_, err = store.Lock(t.Context(), "261006-lock01", 303)
		storeErr = asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorLocked || storeErr.HolderPid != 202 {
			t.Fatalf("lock after the late release = %+v, want locked by 202", storeErr)
		}

		reclaimed()
		third, err := store.Lock(t.Context(), "261006-lock01", 303)
		if err != nil {
			t.Fatalf("third lock: %v", err)
		}
		third()
		_, err = store.Lock(t.Context(), "261006-nope00", 303)
		storeErr = asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorNotFound || storeErr.ID != "261006-nope00" {
			t.Fatalf("lock of a missing job = %+v, want not_found 261006-nope00", storeErr)
		}
	})

	t.Run("ids that are not plain names are refused rather than turned into paths", func(t *testing.T) {
		store := CreateFsStore(t.TempDir(), process.IsAlive)
		_, err := store.Create(t.Context(), testJob("../escape"))
		storeErr := asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorIO || storeErr.Message != `invalid job id "../escape"` {
			t.Fatalf("create(../escape) = %+v, want io invalid job id", storeErr)
		}
		_, err = store.Get(t.Context(), "../escape")
		storeErr = asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorNotFound || storeErr.ID != "../escape" {
			t.Fatalf("get(../escape) = %+v, want not_found", storeErr)
		}
		_, err = store.Lock(t.Context(), "a/b", 1)
		storeErr = asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorNotFound || storeErr.ID != "a/b" {
			t.Fatalf("lock(a/b) = %+v, want not_found", storeErr)
		}
	})

	t.Run("damaged state is reported as io, not thrown", func(t *testing.T) {
		root := t.TempDir()
		store := CreateFsStore(root, process.IsAlive)
		for _, id := range []string{"261006-dmg001", "261006-dmg002"} {
			if _, err := store.Create(t.Context(), testJob(id)); err != nil {
				t.Fatalf("create %s: %v", id, err)
			}
		}
		dir := func(id string) string { return filepath.Join(root, "jobs", id) }
		if err := os.WriteFile(filepath.Join(dir("261006-dmg001"), "job.json"),
			[]byte(`{"id": "261006-dmg001", "version": "one"}`), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		if err := os.Mkdir(filepath.Join(dir("261006-dmg002"), "driver.lock"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}

		_, err := store.Get(t.Context(), "261006-dmg001")
		storeErr := asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorIO ||
			!strings.Contains(storeErr.Message, "261006-dmg001: unreadable job.json") {
			t.Fatalf("get = %+v, want io naming 261006-dmg001: unreadable job.json", storeErr)
		}
		if _, err := store.Lock(t.Context(), "261006-dmg002", 1); asStoreErr(t, err).Kind != ports.StoreErrorIO {
			t.Fatalf("lock over a directory = %v, want io", err)
		}

		if err := os.Remove(filepath.Join(dir("261006-dmg002"), "job.json")); err != nil {
			t.Fatalf("remove: %v", err)
		}
		if err := os.Mkdir(filepath.Join(dir("261006-dmg002"), "job.json"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if _, err := store.Get(t.Context(), "261006-dmg002"); asStoreErr(t, err).Kind != ports.StoreErrorIO {
			t.Fatalf("get of a directory = %v, want io", err)
		}

		brokenRoot := t.TempDir()
		if err := os.WriteFile(filepath.Join(brokenRoot, "jobs"),
			[]byte("a file where the jobs directory should be"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		if _, err := CreateFsStore(brokenRoot, process.IsAlive).Find(t.Context(), "261006"); asStoreErr(t, err).Kind != ports.StoreErrorIO {
			t.Fatalf("find on a broken root = %v, want io", err)
		}
	})

	t.Run("several processes racing for one driver lock: exactly one wins, the others see its pid", func(t *testing.T) {
		root := t.TempDir()
		store := CreateFsStore(root, process.IsAlive)
		if _, err := store.Create(t.Context(), testJob("261006-race02")); err != nil {
			t.Fatalf("create: %v", err)
		}

		reports := runTogether(t, root, "driver-lock-race", "261006-race02", 6)

		winners := 0
		winner := 0.0
		for _, report := range reports {
			if won, ok := report["won"].(float64); ok {
				winners++
				winner = won
			}
		}
		if winners != 1 {
			t.Fatalf("%d winners, want 1 (reports %v)", winners, reports)
		}
		locked := 0
		for _, report := range reports {
			if report["kind"] == "locked" && report["holderPid"] == winner {
				locked++
			}
		}
		if locked != 5 {
			t.Fatalf("%d children saw the winner's pid, want 5 (reports %v)", locked, reports)
		}
	})
}

// ── the fs semaphore ─────────────────────────────────────────────────────────────────────────

// aliveSet is the fake isAlive, safe for the polling goroutines to read while the test changes
// it.
type aliveSet struct {
	mu  sync.Mutex
	set map[int64]bool
}

func newAliveSet(pids ...int64) *aliveSet {
	set := make(map[int64]bool, len(pids))
	for _, pid := range pids {
		set[pid] = true
	}
	return &aliveSet{set: set}
}

func (a *aliveSet) isAlive(pid int64) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.set[pid]
}

func (a *aliveSet) kill(pid int64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.set, pid)
}

func (a *aliveSet) revive(pid int64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.set[pid] = true
}

// semTest is a semaphore over its own temp dir, on a fake clock (so a test decides which waiter
// queued first).
type semTest struct {
	t    *testing.T
	root string
	sem  ports.Semaphore
	now  atomic.Int64
}

func withSemaphore(t *testing.T, capacity Capacity, isAlive ...IsAlive) *semTest {
	t.Helper()
	alive := func(int64) bool { return true }
	if len(isAlive) > 0 {
		alive = isAlive[0]
	}
	fixture := &semTest{t: t, root: t.TempDir()}
	fixture.now.Store(1_000)
	fixture.sem = CreateFsSemaphore(fixture.root, capacity, alive, fastSleep, fixture.now.Load)
	return fixture
}

// tick moves the fake clock, so the next ticket written queues after the ones before it.
func (f *semTest) tick(ms int64) { f.now.Add(ms) }

func (f *semTest) ticketNames() []string {
	f.t.Helper()
	entries, err := os.ReadDir(filepath.Join(f.root, "slots"))
	if err != nil {
		f.t.Fatalf("readdir slots: %v", err)
	}
	names := []string{}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".ticket") {
			names = append(names, entry.Name())
		}
	}
	slices.Sort(names)
	return names
}

func (f *semTest) held() []ports.HeldSlot {
	f.t.Helper()
	return f.sem.Held(context.Background())
}

// fastSleep keeps tests fast but still yields; it returns the context's error like a real sleep.
func fastSleep(ctx context.Context, ms int64) error {
	timer := time.NewTimer(5 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type acquireOutcome struct {
	release func()
	err     error
}

// trackAcquire watches one acquire: settled tells whether it finished without waiting for it.
func trackAcquire(sem ports.Semaphore, holder ports.SemaphoreHolder, ctx ...context.Context) chan acquireOutcome {
	acquireCtx := context.Background()
	if len(ctx) > 0 {
		acquireCtx = ctx[0]
	}
	out := make(chan acquireOutcome, 1)
	go func() {
		release, err := sem.Acquire(acquireCtx, holder)
		out <- acquireOutcome{release: release, err: err}
	}()
	return out
}

func settled(out chan acquireOutcome) bool { return len(out) > 0 }

func outcome(t *testing.T, out chan acquireOutcome) acquireOutcome {
	t.Helper()
	select {
	case result := <-out:
		return result
	case <-time.After(30 * time.Second):
		t.Fatal("the acquire did not settle")
		return acquireOutcome{}
	}
}

func holder(jobID string, pid int64, priority domain.Priority) ports.SemaphoreHolder {
	return ports.SemaphoreHolder{JobID: jobID, Pid: pid, Priority: priority}
}

func TestFsSemaphore(t *testing.T) {
	t.Run("grants up to capacity holders and blocks the next until a release", func(t *testing.T) {
		f := withSemaphore(t, func(context.Context) (int, error) { return 2, nil })

		first, err := f.sem.Acquire(t.Context(), holder("job-a", 101, domain.PriorityNormal))
		if err != nil {
			t.Fatalf("acquire a: %v", err)
		}
		if _, err := f.sem.Acquire(t.Context(), holder("job-b", 202, domain.PriorityNormal)); err != nil {
			t.Fatalf("acquire b: %v", err)
		}
		third := trackAcquire(f.sem, holder("job-c", 303, domain.PriorityNormal))
		time.Sleep(60 * time.Millisecond)

		if settled(third) {
			t.Fatal("the third acquire settled with both slots held")
		}
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-a", Pid: 101}, {JobID: "job-b", Pid: 202}}) {
			t.Fatalf("held = %v", got)
		}
		first()
		if result := outcome(t, third); result.err != nil {
			t.Fatalf("the third acquire: %v", result.err)
		}
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-b", Pid: 202}, {JobID: "job-c", Pid: 303}}) {
			t.Fatalf("held after the release = %v", got)
		}
	})

	t.Run("re-reads capacity on every poll (a lowered cap blocks new acquisitions, never revokes held slots)", func(t *testing.T) {
		var mu sync.Mutex
		cap := 2
		f := withSemaphore(t, func(context.Context) (int, error) {
			mu.Lock()
			defer mu.Unlock()
			return cap, nil
		})
		first, err := f.sem.Acquire(t.Context(), holder("job-a", 101, domain.PriorityNormal))
		if err != nil {
			t.Fatalf("acquire a: %v", err)
		}
		if _, err := f.sem.Acquire(t.Context(), holder("job-b", 202, domain.PriorityNormal)); err != nil {
			t.Fatalf("acquire b: %v", err)
		}

		mu.Lock()
		cap = 1
		mu.Unlock()
		third := trackAcquire(f.sem, holder("job-c", 303, domain.PriorityNormal))
		first()
		time.Sleep(60 * time.Millisecond)
		if settled(third) {
			t.Fatal("the third acquire settled under a lowered cap")
		}
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-b", Pid: 202}}) {
			t.Fatalf("held = %v", got)
		}

		mu.Lock()
		cap = 3
		mu.Unlock()
		if result := outcome(t, third); result.err != nil {
			t.Fatalf("the third acquire: %v", result.err)
		}
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-b", Pid: 202}, {JobID: "job-c", Pid: 303}}) {
			t.Fatalf("held after the raise = %v", got)
		}
	})

	t.Run("reclaims slots held by dead pids", func(t *testing.T) {
		alive := newAliveSet(101, 202, 303)
		f := withSemaphore(t, func(context.Context) (int, error) { return 2, nil }, alive.isAlive)
		crashed, err := f.sem.Acquire(t.Context(), holder("job-a", 101, domain.PriorityNormal))
		if err != nil {
			t.Fatalf("acquire a: %v", err)
		}
		if _, err := f.sem.Acquire(t.Context(), holder("job-b", 202, domain.PriorityNormal)); err != nil {
			t.Fatalf("acquire b: %v", err)
		}

		alive.kill(101)
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-b", Pid: 202}}) {
			t.Fatalf("held after the crash = %v", got)
		}
		if _, err := f.sem.Acquire(t.Context(), holder("job-c", 303, domain.PriorityNormal)); err != nil {
			t.Fatalf("acquire c: %v", err)
		}
		// job-a is re-driven by a new process while its dead driver's slot file is still there.
		alive.revive(404)
		redriven := trackAcquire(f.sem, holder("job-a", 404, domain.PriorityNormal))
		time.Sleep(60 * time.Millisecond)
		if settled(redriven) {
			t.Fatal("the re-driven job took a second slot")
		}
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-b", Pid: 202}, {JobID: "job-c", Pid: 303}}) {
			t.Fatalf("held = %v", got)
		}
		alive.kill(202)
		if result := outcome(t, redriven); result.err != nil {
			t.Fatalf("the re-driven acquire: %v", result.err)
		}
		// A late release by the dead driver (pid 101) must not free the slot job-a's new driver
		// holds.
		crashed()
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-a", Pid: 404}, {JobID: "job-c", Pid: 303}}) {
			t.Fatalf("held after the late release = %v", got)
		}
	})

	t.Run("a job that already holds a slot waits for it rather than taking a second one", func(t *testing.T) {
		f := withSemaphore(t, func(context.Context) (int, error) { return 5, nil })
		first, err := f.sem.Acquire(t.Context(), holder("job-a", 101, domain.PriorityNormal))
		if err != nil {
			t.Fatalf("acquire a: %v", err)
		}
		again := trackAcquire(f.sem, holder("job-a", 101, domain.PriorityNormal))
		time.Sleep(40 * time.Millisecond)
		if settled(again) {
			t.Fatal("the second acquire of one job settled")
		}
		first()
		if result := outcome(t, again); result.err != nil {
			t.Fatalf("the second acquire: %v", result.err)
		}
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-a", Pid: 101}}) {
			t.Fatalf("held = %v", got)
		}
	})

	t.Run("a freed slot goes to the oldest waiting ticket", func(t *testing.T) {
		f := withSemaphore(t, func(context.Context) (int, error) { return 1, nil })
		only, err := f.sem.Acquire(t.Context(), holder("job-a", 101, domain.PriorityNormal))
		if err != nil {
			t.Fatalf("acquire a: %v", err)
		}
		older := trackAcquire(f.sem, holder("job-b", 202, domain.PriorityNormal))
		time.Sleep(30 * time.Millisecond)
		f.tick(1_000)
		newer := trackAcquire(f.sem, holder("job-c", 303, domain.PriorityNormal))
		eventually(t, func() bool { return len(f.ticketNames()) == 2 })
		if got := f.ticketNames(); !slices.Equal(got, []string{"job-b.ticket", "job-c.ticket"}) {
			t.Fatalf("tickets = %v", got)
		}

		only()
		// job-b taking the slot removes its ticket, and only the winner's round removes one.
		eventually(t, func() bool { return strings.Join(f.ticketNames(), ",") == "job-c.ticket" })
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-b", Pid: 202}}) {
			t.Fatalf("held = %v", got)
		}
		if settled(newer) {
			t.Fatal("the newer waiter settled before its turn")
		}
		if got := f.ticketNames(); !slices.Equal(got, []string{"job-c.ticket"}) {
			t.Fatalf("tickets = %v", got)
		}

		outcome(t, older).release()
		if result := outcome(t, newer); result.err != nil {
			t.Fatalf("the newer acquire: %v", result.err)
		}
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-c", Pid: 303}}) {
			t.Fatalf("held = %v", got)
		}
		if got := f.ticketNames(); len(got) != 0 {
			t.Fatalf("tickets = %v, want none", got)
		}
	})

	t.Run("a freed slot goes to a higher-priority waiter that queued later", func(t *testing.T) {
		f := withSemaphore(t, func(context.Context) (int, error) { return 1, nil })
		only, err := f.sem.Acquire(t.Context(), holder("job-a", 101, domain.PriorityNormal))
		if err != nil {
			t.Fatalf("acquire a: %v", err)
		}
		normal := trackAcquire(f.sem, holder("job-b", 202, domain.PriorityNormal))
		time.Sleep(30 * time.Millisecond)
		f.tick(1_000)
		high := trackAcquire(f.sem, holder("job-c", 303, domain.PriorityHigh))
		// Both tickets must be queued before the release, or the normal waiter would rightly take
		// the free slot.
		eventually(t, func() bool { return len(f.ticketNames()) == 2 })

		only()
		eventually(t, func() bool {
			return slices.ContainsFunc(f.held(), func(slot ports.HeldSlot) bool { return slot.JobID == "job-c" })
		})
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-c", Pid: 303}}) {
			t.Fatalf("held = %v", got)
		}
		if settled(normal) {
			t.Fatal("the normal waiter settled before its turn")
		}

		outcome(t, high).release()
		if result := outcome(t, normal); result.err != nil {
			t.Fatalf("the normal acquire: %v", result.err)
		}
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-b", Pid: 202}}) {
			t.Fatalf("held = %v", got)
		}
	})

	t.Run("a dead waiter's ticket is reclaimed like a dead holder's slot", func(t *testing.T) {
		alive := newAliveSet(101, 303)
		f := withSemaphore(t, func(context.Context) (int, error) { return 1, nil }, alive.isAlive)
		only, err := f.sem.Acquire(t.Context(), holder("job-a", 101, domain.PriorityNormal))
		if err != nil {
			t.Fatalf("acquire a: %v", err)
		}
		slots := filepath.Join(f.root, "slots")
		// A waiter that died while queued (dead pid, older and higher priority than job-c) and one
		// that died mid-write.
		writeTicket := func(name, body string) {
			t.Helper()
			if err := os.WriteFile(filepath.Join(slots, name), []byte(body), 0o600); err != nil {
				t.Fatalf("write %s: %v", name, err)
			}
		}
		writeTicket("job-b.ticket", `{"pid":202,"priority":"high","queuedAt":0}`)
		writeTicket("job-torn.ticket", "{not json")
		// Parsed but not a ticket of ours: nobody's, so reclaimed the same way.
		writeTicket("job-null.ticket", "null")
		writeTicket("job-pid.ticket", `{"pid":-1,"priority":"high","queuedAt":0}`)
		writeTicket("job-prio.ticket", `{"pid":303,"priority":"urgent","queuedAt":0}`)
		writeTicket("job-when.ticket", `{"pid":303,"priority":"high","queuedAt":"soon"}`)
		next := trackAcquire(f.sem, holder("job-c", 303, domain.PriorityNormal))
		time.Sleep(30 * time.Millisecond)

		only()
		if result := outcome(t, next); result.err != nil {
			t.Fatalf("the next acquire: %v", result.err)
		}
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-c", Pid: 303}}) {
			t.Fatalf("held = %v", got)
		}
		if got := f.ticketNames(); len(got) != 0 {
			t.Fatalf("tickets = %v, want none", got)
		}
	})

	t.Run("an aborted acquire rejects, holds nothing and leaves no ticket behind", func(t *testing.T) {
		f := withSemaphore(t, func(context.Context) (int, error) { return 1, nil })
		first, err := f.sem.Acquire(t.Context(), holder("job-a", 101, domain.PriorityNormal))
		if err != nil {
			t.Fatalf("acquire a: %v", err)
		}
		ctx, cancel := context.WithCancel(t.Context())
		waiting := trackAcquire(f.sem, holder("job-b", 202, domain.PriorityNormal), ctx)
		time.Sleep(30 * time.Millisecond)

		cancel()

		if result := outcome(t, waiting); !errors.Is(result.err, context.Canceled) {
			t.Fatalf("the aborted acquire = %v, want context.Canceled", result.err)
		}
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-a", Pid: 101}}) {
			t.Fatalf("held = %v", got)
		}
		if got := f.ticketNames(); len(got) != 0 {
			t.Fatalf("tickets = %v, want none", got)
		}
		first()
		if result := outcome(t, trackAcquire(f.sem, holder("job-c", 303, domain.PriorityNormal), ctx)); !errors.Is(result.err, context.Canceled) {
			t.Fatalf("an acquire on a cancelled context = %v, want context.Canceled", result.err)
		}
		if got := f.held(); len(got) != 0 {
			t.Fatalf("held = %v, want none", got)
		}
		if got := f.ticketNames(); len(got) != 0 {
			t.Fatalf("tickets = %v, want none", got)
		}
	})

	t.Run("an abort that lands while a slot is being taken gives the slot back", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		f := withSemaphore(t, func(context.Context) (int, error) {
			cancel()
			return 1, nil
		})

		if result := outcome(t, trackAcquire(f.sem, holder("job-a", 101, domain.PriorityNormal), ctx)); !errors.Is(result.err, context.Canceled) {
			t.Fatalf("the acquire = %v, want context.Canceled", result.err)
		}
		if got := f.held(); len(got) != 0 {
			t.Fatalf("held = %v, want none", got)
		}
	})

	t.Run("several processes share the cap: never more than capacity holders at once", func(t *testing.T) {
		root := t.TempDir()
		runTogether(t, root, "share-cap", "", 8)

		// "enter" is logged after acquire and "exit" before release, so the log can only
		// under-count real holders.
		eventsText, err := os.ReadFile(filepath.Join(root, "events.log"))
		if err != nil {
			t.Fatalf("read events.log: %v", err)
		}
		events := strings.Split(strings.TrimSpace(string(eventsText)), "\n")
		holders := 0
		most := 0
		enters := 0
		for _, event := range events {
			if event == "" {
				continue
			}
			if strings.HasPrefix(event, "enter") {
				holders++
				enters++
			} else {
				holders--
			}
			most = max(most, holders)
		}
		if enters != 48 {
			t.Fatalf("%d enters, want 48", enters)
		}
		if most != 2 {
			t.Fatalf("most holders at once = %d, want 2", most)
		}
		entries, err := os.ReadDir(filepath.Join(root, "slots"))
		if err != nil {
			t.Fatalf("readdir slots: %v", err)
		}
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".slot") || strings.HasSuffix(entry.Name(), ".ticket") {
				t.Fatalf("the slots dir still holds %s", entry.Name())
			}
		}
	})
}

// ── the fs limiter ───────────────────────────────────────────────────────────────────────────

var limiterTestConfig = domain.LimiterConfig{
	Min: 1, DefaultMax: 4, DecreaseFactor: 0.75,
	WindowMs: 2_000, CooldownMs: 1_000, IncreaseAfterMs: 5_000,
}

func TestFsLimiter(t *testing.T) {
	t.Run("capacity starts at the ceiling; three rate limits in the window drop it; reads tick it back", func(t *testing.T) {
		root := t.TempDir()
		limiter := CreateFsLimiter(root, limiterTestConfig)

		initial := limiter.Capacity(t.Context(), 0)
		if err := limiter.RateLimited(t.Context(), 10, ports.RateLimitOptions{}); err != nil {
			t.Fatalf("rateLimited: %v", err)
		}
		if err := limiter.RateLimited(t.Context(), 11, ports.RateLimitOptions{}); err != nil {
			t.Fatalf("rateLimited: %v", err)
		}
		if err := limiter.RateLimited(t.Context(), 12, ports.RateLimitOptions{}); err != nil {
			t.Fatalf("rateLimited: %v", err)
		}
		dropped := CreateFsLimiter(root, limiterTestConfig).Capacity(t.Context(), 20)
		stillQuiet := limiter.Capacity(t.Context(), 5_011)
		recovered := limiter.Capacity(t.Context(), 5_012)

		if initial != 4 || dropped != 3 || stillQuiet != 3 || recovered != 4 {
			t.Fatalf("capacities = [%d %d %d %d], want [4 3 3 4]", initial, dropped, stillQuiet, recovered)
		}
		state, err := os.ReadFile(filepath.Join(root, "limiter.json"))
		if err != nil {
			t.Fatalf("read limiter.json: %v", err)
		}
		want := `{"cap":4,"max":4,"lastDecreaseAt":12,"quietSince":5012,"rateLimitedAt":[10,11,12]}` + "\n"
		if string(state) != want {
			t.Fatalf("limiter.json = %q, want %q", state, want)
		}
	})

	t.Run("a terminal rate limit drops the cap without waiting for the quorum", func(t *testing.T) {
		limiter := CreateFsLimiter(t.TempDir(), limiterTestConfig)

		if err := limiter.RateLimited(t.Context(), 10, ports.RateLimitOptions{EndedAttempt: true}); err != nil {
			t.Fatalf("rateLimited: %v", err)
		}
		dropped := limiter.Limit(t.Context(), 11)

		if dropped != (ports.LimiterLevels{Cap: 3, Max: 4}) {
			t.Fatalf("limit = %+v, want cap 3 max 4", dropped)
		}
	})

	t.Run("limit reads without ticking, so a quiet minute alone never raises the cap", func(t *testing.T) {
		limiter := CreateFsLimiter(t.TempDir(), limiterTestConfig)
		if err := limiter.RateLimited(t.Context(), 10, ports.RateLimitOptions{EndedAttempt: true}); err != nil {
			t.Fatalf("rateLimited: %v", err)
		}

		if got := limiter.Limit(t.Context(), 1_000_000); got != (ports.LimiterLevels{Cap: 3, Max: 4}) {
			t.Fatalf("limit = %+v, want cap 3 max 4", got)
		}
	})

	t.Run("saveMax persists the ceiling and clamps the cap down to it, never up", func(t *testing.T) {
		root := t.TempDir()
		limiter := CreateFsLimiter(root, limiterTestConfig)

		if err := limiter.SaveMax(t.Context(), 2, 0); err != nil {
			t.Fatalf("saveMax: %v", err)
		}
		raised := limiter.Limit(t.Context(), 1)
		if err := limiter.SaveMax(t.Context(), 8, 2); err != nil {
			t.Fatalf("saveMax: %v", err)
		}
		notRaised := limiter.Limit(t.Context(), 3)
		recovered := CreateFsLimiter(root, limiterTestConfig).Capacity(t.Context(), 5_010)

		if raised != (ports.LimiterLevels{Cap: 2, Max: 2}) || notRaised != (ports.LimiterLevels{Cap: 2, Max: 8}) || recovered != 3 {
			t.Fatalf("levels = [%+v %+v %d], want [2/2 2/8 3]", raised, notRaised, recovered)
		}
	})

	t.Run("an old limiter.json without a ceiling keeps its cap (the config default becomes the ceiling)", func(t *testing.T) {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, "limiter.json"),
			[]byte(`{"cap":2,"lastDecreaseAt":null,"quietSince":0}`), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}

		wider := limiterTestConfig
		wider.DefaultMax = 6
		kept := CreateFsLimiter(root, wider).Capacity(t.Context(), 1)
		if kept != 2 {
			t.Fatalf("capacity = %d, want 2", kept)
		}
		if got := CreateFsLimiter(root, limiterTestConfig).Limit(t.Context(), 2); got.Max != 4 {
			t.Fatalf("max = %d, want 4", got.Max)
		}
	})

	t.Run("a stored cap outside [min, ceiling] is clamped; an unreadable state file starts over", func(t *testing.T) {
		root := t.TempDir()
		high := limiterTestConfig
		high.DefaultMax = 8
		CreateFsLimiter(root, high).Capacity(t.Context(), 0)

		low := limiterTestConfig
		low.DefaultMax = 2
		lowered := CreateFsLimiter(root, low).Capacity(t.Context(), 1)
		if err := os.WriteFile(filepath.Join(root, "limiter.json"), []byte("{ torn"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		restarted := CreateFsLimiter(root, limiterTestConfig).Capacity(t.Context(), 2)

		if lowered != 2 || restarted != 4 {
			t.Fatalf("capacities = [%d %d], want [2 4]", lowered, restarted)
		}
	})

	t.Run("concurrent rateLimited calls from several processes apply one decrease per cooldown", func(t *testing.T) {
		root := t.TempDir()
		reports := runTogether(t, root, "limiter-waves", "", 6)

		if len(reports) != 6 {
			t.Fatalf("%d reports, want 6 (%v)", len(reports), reports)
		}
		stateText, err := os.ReadFile(filepath.Join(root, "limiter.json"))
		if err != nil {
			t.Fatalf("read limiter.json: %v", err)
		}
		var state struct {
			Cap            int64 `json:"cap"`
			Max            int64 `json:"max"`
			LastDecreaseAt int64 `json:"lastDecreaseAt"`
		}
		if err := json.Unmarshal(stateText, &state); err != nil {
			t.Fatalf("parse limiter.json: %v", err)
		}
		if state.Cap != 2 || state.Max != 4 || state.LastDecreaseAt < 70_000 {
			t.Fatalf("state = %+v, want cap 2 max 4 lastDecreaseAt >= 70000", state)
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			t.Fatalf("readdir: %v", err)
		}
		for _, entry := range entries {
			if strings.Contains(entry.Name(), ".tmp") || strings.HasSuffix(entry.Name(), ".lock") {
				t.Fatalf("the root still holds %s", entry.Name())
			}
		}
	})
}

// ── the store golden: the bytes the file format pins ─────────────────────────────────────────

func strPtr(text string) *string { return &text }

func intPtr(value int64) *int64 { return &value }

func boolPtr(value bool) *bool { return &value }

func verdictPtr(verdict domain.Verdict) *domain.Verdict { return &verdict }

// goldenJob is the job the golden round trip carries: every job.json shape a round trip can
// carry (attempts of both kinds, a usage with a model, an origin).
func goldenJob() domain.Job {
	session := "f81d4fae-7dec-41d0-a765-00a0c91e6bf6"
	return testJob("261006-abc123", func(j *domain.Job) {
		j.Attempts = []domain.Attempt{
			{
				N:         0,
				Kind:      domain.AttemptKindInitial,
				Prompt:    "Do the thing.",
				SessionID: "00000000-0000-4000-8000-000000000001",
				StartedAt: "2026-10-06T10:00:01.000Z",
				EndedAt:   strPtr("2026-10-06T10:01:00.000Z"),
				Outcome:   &domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted},
			},
			{
				N:         1,
				Kind:      domain.AttemptKindAutoFix,
				Prompt:    "Fix the failing gate.",
				Feedback:  strPtr("The gate failed. Look at the tail and fix it."),
				SessionID: "00000000-0000-4000-8000-000000000002",
				StartedAt: "2026-10-06T10:01:00.000Z",
				EndedAt:   strPtr("2026-10-06T10:02:00.000Z"),
				Outcome: &domain.WorkerOutcome{
					Kind: domain.WorkerOutcomeAPIError, Message: "Insufficient balance",
					Status: intPtr(429), Quota: boolPtr(true),
				},
				Usage: &domain.Usage{
					Turns: 2, InputTokens: 100, OutputTokens: 50, CacheReadTokens: 10,
					CacheWriteTokens: 5, CostUSD: 0.01, RateLimitRetries: 1, DurationMs: 60_000,
					Model: strPtr("glm-5.3-flash"),
				},
				Verdict: verdictPtr(domain.VerdictQuota),
			},
		}
		j.Origin = &domain.Origin{SessionID: session}
	})
}

// The golden is a fixed fixture: this job created and updated once. The store must write the
// same bytes for the same sequence.
func TestFsStoreMatchesGoldenBytes(t *testing.T) {
	if testing.Short() {
		t.Skip("the golden fixture is skipped in short mode")
	}
	wantCreated, err := os.ReadFile(filepath.Join("..", "..", "testdata", "store", "created.json"))
	if err != nil {
		t.Fatalf("read created.json: %v", err)
	}
	wantUpdated, err := os.ReadFile(filepath.Join("..", "..", "testdata", "store", "updated.json"))
	if err != nil {
		t.Fatalf("read updated.json: %v", err)
	}

	// The store creates the same job with the same bytes.
	root := t.TempDir()
	store := CreateFsStore(root, process.IsAlive)
	job := goldenJob()
	if _, err := store.Create(t.Context(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	created, err := os.ReadFile(filepath.Join(root, "jobs", job.ID, "job.json"))
	if err != nil {
		t.Fatalf("read job.json: %v", err)
	}
	if !bytes.Equal(created, wantCreated) {
		t.Fatalf("the created job.json differs from the golden bytes:\ngot:  %q\nwant: %q", created, wantCreated)
	}

	// The store reads a job.json an earlier release wrote and writes its update with the same
	// bytes.
	other := t.TempDir()
	jobDir := filepath.Join(other, "jobs", job.ID)
	if err := os.MkdirAll(jobDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(jobDir, "job.json"), wantCreated, 0o600); err != nil {
		t.Fatalf("seed job.json: %v", err)
	}
	seededStore := CreateFsStore(other, process.IsAlive)
	read, err := seededStore.Get(t.Context(), job.ID)
	if err != nil {
		t.Fatalf("get the seeded job: %v", err)
	}
	if read.Version != 1 || read.Origin == nil || read.Origin.SessionID != job.Origin.SessionID {
		t.Fatalf("get = version %d origin %+v, want version 1 with the origin", read.Version, read.Origin)
	}
	read.State = domain.JobStateRunning
	updated, err := seededStore.Update(t.Context(), read)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Version != 2 {
		t.Fatalf("version = %d, want 2", updated.Version)
	}
	stored, err := os.ReadFile(filepath.Join(jobDir, "job.json"))
	if err != nil {
		t.Fatalf("read job.json: %v", err)
	}
	if !bytes.Equal(stored, wantUpdated) {
		t.Fatalf("the updated job.json differs from the golden bytes:\ngot:  %q\nwant: %q", stored, wantUpdated)
	}
	if _, err := os.Stat(filepath.Join(jobDir, "job.json.lock")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the write lock stood behind (stat err %v)", err)
	}
}

// ── direct branch tests ───────────────────────────────────────────────────────────────────────

func TestNewestFirst(t *testing.T) {
	for _, table := range []struct {
		name string
		a, b domain.Job
		want int
	}{
		{"the newer job first", domain.Job{CreatedAt: "2"}, domain.Job{CreatedAt: "1"}, -1},
		{"the older job second", domain.Job{CreatedAt: "1"}, domain.Job{CreatedAt: "2"}, 1},
		{"a tie broken by the larger id", domain.Job{CreatedAt: "1", ID: "b"}, domain.Job{CreatedAt: "1", ID: "a"}, -1},
		{"a tie broken the other way", domain.Job{CreatedAt: "1", ID: "a"}, domain.Job{CreatedAt: "1", ID: "b"}, 1},
		{"one job against itself", domain.Job{CreatedAt: "1", ID: "a"}, domain.Job{CreatedAt: "1", ID: "a"}, 0},
	} {
		if got := newestFirst(table.a, table.b); got != table.want {
			t.Fatalf("%s: newestFirst = %d, want %d", table.name, got, table.want)
		}
	}
}

func TestByTurn(t *testing.T) {
	ticket := func(jobID string, priority domain.Priority, queuedAt int64) semTicket {
		return semTicket{JobID: jobID, Pid: intPtr(1), Priority: priority, QueuedAt: queuedAt}
	}
	for _, table := range []struct {
		name string
		a, b semTicket
		want int
	}{
		{"high before normal", ticket("job-b", domain.PriorityNormal, 0), ticket("job-a", domain.PriorityHigh, 9), 1},
		{"normal after high", ticket("job-a", domain.PriorityHigh, 9), ticket("job-b", domain.PriorityNormal, 0), -1},
		{"the older ticket first", ticket("job-b", domain.PriorityNormal, 2), ticket("job-a", domain.PriorityNormal, 1), 1},
		{"the newer ticket second", ticket("job-a", domain.PriorityNormal, 1), ticket("job-b", domain.PriorityNormal, 2), -1},
		{"a tie broken by the smaller id", ticket("job-a", domain.PriorityNormal, 1), ticket("job-b", domain.PriorityNormal, 1), -1},
		{"a tie broken by the larger id", ticket("job-b", domain.PriorityNormal, 1), ticket("job-a", domain.PriorityNormal, 1), 1},
	} {
		if got := byTurn(table.a, table.b); got != table.want {
			t.Fatalf("%s: byTurn = %d, want %d", table.name, got, table.want)
		}
	}
}

func TestFsStoreUnwritableAndForeign(t *testing.T) {
	t.Run("create under a root whose jobs dir is a file is io", func(t *testing.T) {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, "jobs"), []byte("a file"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		if _, err := CreateFsStore(root, process.IsAlive).Create(t.Context(), testJob("261006-nowr01")); asStoreErr(t, err).Kind != ports.StoreErrorIO {
			t.Fatalf("create = %v, want io", err)
		}
		if jobs := CreateFsStore(root, process.IsAlive).List(t.Context(), ports.ListFilter{}); len(jobs) != 0 {
			t.Fatalf("list on a broken root = %d jobs, want none", len(jobs))
		}
	})

	t.Run("a write lock that cannot be taken is io", func(t *testing.T) {
		root := t.TempDir()
		store := CreateFsStore(root, process.IsAlive)
		if _, err := store.Create(t.Context(), testJob("261006-nowr02")); err != nil {
			t.Fatalf("create: %v", err)
		}
		if err := os.Mkdir(filepath.Join(root, "jobs", "261006-nowr02", "job.json.lock"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if _, err := store.Update(t.Context(), testJob("261006-nowr02")); asStoreErr(t, err).Kind != ports.StoreErrorIO {
			t.Fatalf("update behind a lock directory = %v, want io", err)
		}
	})

	t.Run("a stored job whose attempt element is mis-typed is io", func(t *testing.T) {
		root := t.TempDir()
		store := CreateFsStore(root, process.IsAlive)
		if _, err := store.Create(t.Context(), testJob("261006-nowr03")); err != nil {
			t.Fatalf("create: %v", err)
		}
		file := filepath.Join(root, "jobs", "261006-nowr03", "job.json")
		if err := os.WriteFile(file, []byte(`{"id":"261006-nowr03","version":1,"state":"queued",`+
			`"createdAt":"t","updatedAt":"t","brief":{"title":"t"},"workspace":{"repoRoot":"/r"},`+
			`"attempts":[{"n":"one"}]}`), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		if _, err := store.Get(t.Context(), "261006-nowr03"); asStoreErr(t, err).Kind != ports.StoreErrorIO {
			t.Fatalf("get of a mis-typed attempt = %v, want io", err)
		}
	})

	t.Run("a job that cannot marshal is io, never a torn write", func(t *testing.T) {
		store := CreateFsStore(t.TempDir(), process.IsAlive)
		job := testJob("261006-nowr04", func(j *domain.Job) {
			j.Attempts = []domain.Attempt{{
				N: 0, Kind: domain.AttemptKindInitial, Prompt: "p", SessionID: "s", StartedAt: "t",
				Outcome: &domain.WorkerOutcome{Kind: "bogus"},
			}}
		})
		if _, err := store.Create(t.Context(), job); asStoreErr(t, err).Kind != ports.StoreErrorIO {
			t.Fatalf("create of an unmarshalable job = %v, want io", err)
		}
	})

	t.Run("a write lock held by a live writer for good is io naming its pid", func(t *testing.T) {
		root := t.TempDir()
		store := CreateFsStore(root, func(int64) bool { return true })
		if _, err := store.Create(t.Context(), testJob("261006-nowr05")); err != nil {
			t.Fatalf("create: %v", err)
		}
		held, err := TryLock(t.Context(),
			filepath.Join(root, "jobs", "261006-nowr05", "job.json.lock"), 909, func(int64) bool { return true })
		if err != nil {
			t.Fatalf("hold the write lock: %v", err)
		}
		defer held(t.Context())
		_, err = store.Update(t.Context(), testJob("261006-nowr05"))
		storeErr := asStoreErr(t, err)
		if storeErr.Kind != ports.StoreErrorIO ||
			!strings.Contains(storeErr.Message, "write lock still held by pid 909") {
			t.Fatalf("update behind a stuck writer = %+v, want io naming pid 909", storeErr)
		}
	})

	t.Run("paths names the job's files", func(t *testing.T) {
		store := CreateFsStore(filepath.Join(t.TempDir(), "root"), process.IsAlive)
		paths := store.Paths("261006-abc123")
		if paths.Record != filepath.Join(paths.Dir, "job.json") || paths.DriverLock != filepath.Join(paths.Dir, "driver.lock") {
			t.Fatalf("paths = %+v", paths)
		}
	})
}

func TestFsSemaphoreDamagedSlotsDir(t *testing.T) {
	capacityOf := func(cap int) Capacity {
		return func(context.Context) (int, error) { return cap, nil }
	}

	t.Run("held without a slots dir, and over one that is a file", func(t *testing.T) {
		missing := CreateFsSemaphore(filepath.Join(t.TempDir(), "gone"), capacityOf(1), func(int64) bool { return true }, fastSleep, func() int64 { return 0 })
		if got := missing.Held(t.Context()); len(got) != 0 {
			t.Fatalf("held without a slots dir = %v", got)
		}
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, "slots"), []byte("a file"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		blocked := CreateFsSemaphore(root, capacityOf(1), func(int64) bool { return true }, fastSleep, func() int64 { return 0 })
		if got := blocked.Held(t.Context()); len(got) != 0 {
			t.Fatalf("held over a file = %v", got)
		}
		if _, err := blocked.Acquire(t.Context(), holder("job-a", 101, domain.PriorityNormal)); err == nil {
			t.Fatal("acquire over a file succeeded")
		}
	})

	t.Run("a slot or ticket that cannot be read fails the round", func(t *testing.T) {
		for _, name := range []string{"x.slot", "y.ticket"} {
			root := t.TempDir()
			slots := filepath.Join(root, "slots")
			if err := os.MkdirAll(slots, 0o755); err != nil {
				t.Fatalf("mkdir: %v", err)
			}
			if err := os.Mkdir(filepath.Join(slots, name), 0o755); err != nil {
				t.Fatalf("mkdir %s: %v", name, err)
			}
			semaphore := CreateFsSemaphore(root, capacityOf(1), func(int64) bool { return true }, fastSleep, func() int64 { return 0 })
			if _, err := semaphore.Acquire(t.Context(), holder("job-a", 101, domain.PriorityNormal)); err == nil {
				t.Fatalf("acquire beside a %s directory succeeded", name)
			}
		}
	})

	t.Run("a slot or ticket released between the listing and the read is skipped", func(t *testing.T) {
		root := t.TempDir()
		slots := filepath.Join(root, "slots")
		if err := os.MkdirAll(slots, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.Symlink("missing", filepath.Join(slots, "gone.slot")); err != nil {
			t.Fatalf("symlink: %v", err)
		}
		if err := os.Symlink("missing", filepath.Join(slots, "gone.ticket")); err != nil {
			t.Fatalf("symlink: %v", err)
		}
		semaphore := CreateFsSemaphore(root, capacityOf(1), func(int64) bool { return true }, fastSleep, func() int64 { return 0 })
		release, err := semaphore.Acquire(t.Context(), holder("job-a", 101, domain.PriorityNormal))
		if err != nil {
			t.Fatalf("acquire: %v", err)
		}
		if got := semaphore.Held(t.Context()); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-a", Pid: 101}}) {
			t.Fatalf("held = %v", got)
		}
		release()
	})

	t.Run("a capacity that cannot be read fails the acquire and leaves no ticket", func(t *testing.T) {
		root := t.TempDir()
		semaphore := CreateFsSemaphore(root,
			func(context.Context) (int, error) { return 0, errors.New("no budget file") },
			func(int64) bool { return true }, fastSleep, func() int64 { return 0 })
		if _, err := semaphore.Acquire(t.Context(), holder("job-a", 101, domain.PriorityNormal)); err == nil || !strings.Contains(err.Error(), "no budget file") {
			t.Fatalf("acquire = %v, want the capacity error", err)
		}
		entries, err := os.ReadDir(filepath.Join(root, "slots"))
		if err != nil {
			t.Fatalf("readdir: %v", err)
		}
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".ticket") {
				t.Fatalf("the failed acquire left %s behind", entry.Name())
			}
		}
	})

	t.Run("a sleep that fails for its own reason fails the acquire", func(t *testing.T) {
		f := withSemaphore(t, capacityOf(1))
		first, err := f.sem.Acquire(t.Context(), holder("job-a", 101, domain.PriorityNormal))
		if err != nil {
			t.Fatalf("acquire a: %v", err)
		}
		defer first()
		semaphore := CreateFsSemaphore(f.root, capacityOf(1), func(int64) bool { return true },
			func(context.Context, int64) error { return errors.New("clock stuck") },
			func() int64 { return 0 })
		if _, err := semaphore.Acquire(t.Context(), holder("job-b", 202, domain.PriorityNormal)); err == nil || !strings.Contains(err.Error(), "clock stuck") {
			t.Fatalf("acquire = %v, want the sleep error", err)
		}
	})

	t.Run("a round behind a stuck mutex holder retries on the next poll", func(t *testing.T) {
		f := withSemaphore(t, capacityOf(1))
		if err := os.MkdirAll(filepath.Join(f.root, "slots"), 0o755); err != nil {
			t.Fatalf("mkdir slots: %v", err)
		}
		mutex, err := TryLock(t.Context(), filepath.Join(f.root, "slots", ".mutex"), 555, func(int64) bool { return true })
		if err != nil {
			t.Fatalf("hold the mutex: %v", err)
		}
		waiting := trackAcquire(f.sem, holder("job-a", 101, domain.PriorityNormal))
		// The first round's WaitLock times out after its 10 s; the holder then lets go.
		time.Sleep(10_400 * time.Millisecond)
		if settled(waiting) {
			t.Fatal("the acquire settled behind a live mutex holder")
		}
		mutex(t.Context())
		if result := outcome(t, waiting); result.err != nil {
			t.Fatalf("the acquire after the mutex freed: %v", result.err)
		}
		if got := f.held(); !slices.Equal(got, []ports.HeldSlot{{JobID: "job-a", Pid: 101}}) {
			t.Fatalf("held = %v", got)
		}
	})
}

func TestFsLimiterUnwritableState(t *testing.T) {
	t.Run("a root that is a file fails the write", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "limiter-root")
		if err := os.WriteFile(file, []byte("a file"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		if err := CreateFsLimiter(file, limiterTestConfig).RateLimited(t.Context(), 10, ports.RateLimitOptions{}); err == nil {
			t.Fatal("rateLimited under a file root succeeded")
		}
	})

	t.Run("a state file that is a directory fails the write", func(t *testing.T) {
		root := t.TempDir()
		if err := os.Mkdir(filepath.Join(root, "limiter.json"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := CreateFsLimiter(root, limiterTestConfig).SaveMax(t.Context(), 2, 0); err == nil {
			t.Fatal("saveMax over a directory succeeded")
		}
	})

	t.Run("a lastDecreaseAt that is neither null nor a number starts over", func(t *testing.T) {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, "limiter.json"),
			[]byte(`{"cap":2,"lastDecreaseAt":"soon","quietSince":0}`), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		if got := CreateFsLimiter(root, limiterTestConfig).Capacity(t.Context(), 1); got != 4 {
			t.Fatalf("capacity = %d, want the config default 4", got)
		}
	})
}
