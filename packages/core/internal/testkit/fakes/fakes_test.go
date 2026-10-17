package fakes

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// Direct tests of the support fakes: each fake's main behaviour, plus the wire's byte shape
// against domain.WorkerEvent's own JSON.

func i64ptr(value int64) *int64 { return &value }

func strptr(value string) *string { return &value }

// aSpec is one run of the worker against a log under a temp dir.
func aSpec(logPath string) ports.WorkerSpec {
	return ports.WorkerSpec{
		Cwd:     "/repo",
		Model:   domain.ModelRef{Tier: domain.ModelTierMain, ID: "glm-5.3", Label: "GLM 5.3"},
		Access:  ports.AccessWrite,
		Prompt:  "Rename `foo` to `bar` everywhere.",
		Session: ports.WorkerSession{Kind: ports.SessionKindNew, Key: "s-1"},
		LogPath: logPath,
	}
}

// drain reads a run's events until its stream ends.
func drain(t *testing.T, run ports.WorkerRun) []domain.WorkerEvent {
	t.Helper()
	var events []domain.WorkerEvent
	for event := range run.Events() {
		events = append(events, event)
	}
	return events
}

func TestMemoryStore(t *testing.T) {
	ctx := context.Background()
	t.Run("stores and reads a job back", func(t *testing.T) {
		store := NewMemoryStore(t.TempDir())
		if _, err := store.Get(ctx, "j1"); err == nil {
			t.Fatal("get of an unknown job should fail")
		}
		put := store.Put(testkit.AJob())
		if put.ID != "j1" {
			t.Errorf("put returned %q", put.ID)
		}
		job, err := store.Get(ctx, "j1")
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		if job.State != domain.JobStateQueued {
			t.Errorf("state = %q", job.State)
		}
		found, err := store.Find(ctx, "j")
		if err != nil {
			t.Fatalf("find by prefix: %v", err)
		}
		if found.ID != "j1" {
			t.Errorf("find returned %q", found.ID)
		}
	})

	t.Run("find needs a unique prefix", func(t *testing.T) {
		store := NewMemoryStore(t.TempDir())
		store.Put(testkit.AJob())
		store.Put(testkit.AJob(func(job *domain.Job) { job.ID = "j10" }))
		_, err := store.Find(ctx, "j1x")
		var storeErr *ports.StoreError
		if !errors.As(err, &storeErr) || storeErr.Kind != ports.StoreErrorNotFound {
			t.Fatalf("unknown prefix: %v", err)
		}
		// "j1" is still an exact id, not a prefix.
		if found, err := store.Find(ctx, "j1"); err != nil || found.ID != "j1" {
			t.Fatalf("exact id through find: %v", err)
		}
		// An ambiguous prefix ("j" matches both) and an empty prefix read as not found.
		for _, prefix := range []string{"j", ""} {
			if _, err := store.Find(ctx, prefix); err == nil {
				t.Errorf("prefix %q should not resolve", prefix)
			}
		}
	})

	t.Run("create bumps the version and refuses a second create", func(t *testing.T) {
		store := NewMemoryStore(t.TempDir())
		created, err := store.Create(ctx, testkit.AJob())
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		if created.Version != 1 {
			t.Errorf("version = %d", created.Version)
		}
		if _, err := store.Create(ctx, testkit.AJob()); err == nil {
			t.Fatal("creating the same id twice should fail")
		}
		if _, err := os.Stat(store.Paths("j1").Dir); err != nil {
			t.Errorf("the job directory should exist: %v", err)
		}
	})

	t.Run("failCreate fails the next create once", func(t *testing.T) {
		store := NewMemoryStore(t.TempDir())
		store.FailCreate = &ports.StoreError{Kind: ports.StoreErrorIO, Message: "disk full"}
		if _, err := store.Create(ctx, testkit.AJob()); err == nil || store.FailCreate != nil {
			t.Fatalf("the scripted failure should fire once: %v", store.FailCreate)
		}
		if _, err := store.Create(ctx, testkit.AJob()); err != nil {
			t.Fatalf("the next create should pass: %v", err)
		}
	})

	t.Run("update requires the current version", func(t *testing.T) {
		store := NewMemoryStore(t.TempDir())
		created, err := store.Create(ctx, testkit.AJob())
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		seen := []string{}
		store.BeforeUpdate = func(job domain.Job) { seen = append(seen, job.ID) }
		stale := created
		stale.Version = 0
		_, err = store.Update(ctx, stale)
		var conflict *ports.StoreError
		if !errors.As(err, &conflict) || conflict.Kind != ports.StoreErrorVersionConflict ||
			conflict.Expected != 0 || conflict.Actual != 1 {
			t.Fatalf("stale update: %v", err)
		}
		running := created
		running.State = domain.JobStateRunning
		updated, err := store.Update(ctx, running)
		if err != nil {
			t.Fatalf("update: %v", err)
		}
		if updated.Version != 2 || updated.State != domain.JobStateRunning {
			t.Errorf("updated = %+v", updated)
		}
		missing := created
		missing.ID = "nope"
		if _, err := store.Update(ctx, missing); err == nil {
			t.Fatal("updating an unknown job should fail")
		}
		if strings.Join(seen, ",") != "j1,j1,nope" {
			t.Errorf("beforeUpdate saw %v", seen)
		}
	})

	t.Run("lists newest first, then by id", func(t *testing.T) {
		store := NewMemoryStore(t.TempDir())
		store.Put(testkit.AJob(func(job *domain.Job) {
			job.ID = "j1"
			job.CreatedAt = "2026-10-06T00:00:01.000Z"
			job.Workspace.RepoRoot = "/repo"
		}))
		store.Put(testkit.AJob(func(job *domain.Job) {
			job.ID = "j2"
			job.CreatedAt = "2026-10-06T00:00:02.000Z"
		}))
		store.Put(testkit.AJob(func(job *domain.Job) {
			job.ID = "j9"
			job.CreatedAt = "2026-10-06T00:00:02.000Z"
			job.Workspace.RepoRoot = "/other"
		}))
		var ids []string
		for _, job := range store.List(ctx, ports.ListFilter{}) {
			ids = append(ids, job.ID)
		}
		if strings.Join(ids, ",") != "j9,j2,j1" {
			t.Errorf("ids = %v", ids)
		}
		ids = nil
		for _, job := range store.List(ctx, ports.ListFilter{RepoRoot: "/repo"}) {
			ids = append(ids, job.ID)
		}
		if strings.Join(ids, ",") != "j2,j1" {
			t.Errorf("filtered ids = %v", ids)
		}
	})

	t.Run("lock is exclusive and released", func(t *testing.T) {
		store := NewMemoryStore(t.TempDir())
		store.Put(testkit.AJob())
		if _, err := store.Lock(ctx, "missing", 1); err == nil {
			t.Fatal("locking an unknown job should fail")
		}
		release, err := store.Lock(ctx, "j1", 111)
		if err != nil {
			t.Fatalf("lock: %v", err)
		}
		_, err = store.Lock(ctx, "j1", 222)
		var locked *ports.StoreError
		if !errors.As(err, &locked) || locked.Kind != ports.StoreErrorLocked || locked.HolderPid != 111 {
			t.Fatalf("second lock: %v", err)
		}
		if _, err := os.Stat(store.Paths("j1").DriverLock); err != nil {
			t.Errorf("the lock file should exist while held: %v", err)
		}
		release()
		if _, err := os.Stat(store.Paths("j1").DriverLock); err == nil {
			t.Error("the lock file should be gone after release")
		}
		if _, err := store.Lock(ctx, "j1", 222); err != nil {
			t.Fatalf("lock after release: %v", err)
		}
	})

	t.Run("holdLock simulates another driver", func(t *testing.T) {
		store := NewMemoryStore(t.TempDir())
		store.Put(testkit.AJob())
		store.HoldLock("j1", 4242)
		raw, err := os.ReadFile(store.Paths("j1").DriverLock)
		if err != nil {
			t.Fatalf("read the lock file: %v", err)
		}
		if string(raw) != "4242\n" {
			t.Errorf("lock file = %q", raw)
		}
		_, err = store.Lock(ctx, "j1", 111)
		var locked *ports.StoreError
		if !errors.As(err, &locked) || locked.HolderPid != 4242 {
			t.Fatalf("lock against the holder: %v", err)
		}
	})

	t.Run("states collapse consecutive repeats", func(t *testing.T) {
		store := NewMemoryStore(t.TempDir())
		job, _ := store.Create(ctx, testkit.AJob())
		for i := 0; i < 3; i++ {
			job.State = domain.JobStateRunning
			job, _ = store.Update(ctx, job)
		}
		job.State = domain.JobStateAwaitingReview
		if _, err := store.Update(ctx, job); err != nil {
			t.Fatalf("update: %v", err)
		}
		if got := strings.Join(store.States("j1"), ","); got != "queued,running,awaiting_review" {
			t.Errorf("states = %q", got)
		}
		if len(store.States("other")) != 0 {
			t.Errorf("another job's states = %v", store.States("other"))
		}
	})

	t.Run("a stale release holds nothing", func(t *testing.T) {
		store := NewMemoryStore(t.TempDir())
		store.Put(testkit.AJob())
		release, _ := store.Lock(ctx, "j1", 111)
		store.HoldLock("j1", 999)
		release()
		if _, err := store.Lock(ctx, "j1", 222); err == nil {
			t.Fatal("the stale release should not have freed the new holder's lock")
		}
	})

	t.Run("filesystem failures panic", func(t *testing.T) {
		t.Run("a job dir under a file", func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "file")
			os.WriteFile(file, []byte("x"), 0o644)
			store := NewMemoryStore(filepath.Join(file, "jobs"))
			defer mustPanic(t, "put under a file")
			store.Put(testkit.AJob())
		})
		t.Run("a lock file that is a directory", func(t *testing.T) {
			store := NewMemoryStore(t.TempDir())
			if err := os.MkdirAll(store.Paths("j1").DriverLock, 0o755); err != nil {
				t.Fatalf("mkdir: %v", err)
			}
			defer mustPanic(t, "holdLock onto a directory")
			store.HoldLock("j1", 111)
		})
	})
}

// mustPanic fails the test unless the deferred call it guards panics.
func mustPanic(t *testing.T, what string) {
	t.Helper()
	if recover() == nil {
		t.Errorf("%s should have panicked", what)
	}
}

func TestWire(t *testing.T) {
	t.Run("init announces the session and the model", func(t *testing.T) {
		line := Wire.Init("s-1")
		if strings.Contains(line, "\n") {
			t.Errorf("a wire line is one line: %q", line)
		}
		events := ParseEventLine(line)
		if len(events) != 1 || events[0].Kind != domain.WorkerEventInit ||
			events[0].SessionID != "s-1" || events[0].Model == nil || *events[0].Model != "glm-5.3" {
			t.Fatalf("init line %s parsed to %+v", line, events)
		}
		if other := Wire.Init("s-1", "glm-5.3-flash"); other == line {
			t.Error("the model should be overridable")
		}
	})

	t.Run("text carries the message", func(t *testing.T) {
		events := ParseEventLine(Wire.Text("working"))
		if len(events) != 1 || events[0].Kind != domain.WorkerEventAssistantText || events[0].Text != "working" {
			t.Fatalf("%+v", events)
		}
	})

	t.Run("tool summarizes with the input's first string value", func(t *testing.T) {
		line := Wire.Tool("Bash", ToolArg{Key: "command", Value: "npm test"}, ToolArg{Key: "timeout", Value: 30})
		events := ParseEventLine(line)
		if len(events) != 1 || events[0].Kind != domain.WorkerEventToolUse ||
			events[0].Name != "Bash" || events[0].Summary != "npm test" {
			t.Fatalf("%+v", events)
		}
		if summary := ParseEventLine(Wire.Tool("Bash", ToolArg{Key: "n", Value: 3}))[0].Summary; summary != "" {
			t.Errorf("no string value should read as an empty summary, got %q", summary)
		}
	})

	t.Run("retry carries the status and the attempt", func(t *testing.T) {
		events := ParseEventLine(Wire.Retry(i64ptr(429)))
		if len(events) != 1 || events[0].Kind != domain.WorkerEventAPIRetry || events[0].Attempt != 1 ||
			events[0].MaxRetries != 10 || events[0].Status == nil || *events[0].Status != 429 {
			t.Fatalf("%+v", events)
		}
		events = ParseEventLine(Wire.Retry(nil, 2))
		if events[0].Attempt != 2 || events[0].Status != nil {
			t.Fatalf("%+v", events)
		}
		if !strings.Contains(Wire.Retry(nil, 2), `"status":null`) {
			t.Errorf("a missing status is written as null: %s", Wire.Retry(nil, 2))
		}
	})

	t.Run("result carries the run's account", func(t *testing.T) {
		events := ParseEventLine(Wire.Result())
		if len(events) != 1 {
			t.Fatalf("%d events", len(events))
		}
		result := events[0]
		if result.Kind != domain.WorkerEventResult || result.IsError || result.Text != "done" ||
			result.StructuredOutput != nil || result.Turns != 2 || result.DurationMs != 1500 ||
			result.CostUSD != 0.01 || result.Usage != (domain.ResultUsage{
			InputTokens: 100, OutputTokens: 20, CacheReadTokens: 50, CacheWriteTokens: 10,
		}) || result.APIErrorStatus != nil {
			t.Fatalf("%+v", result)
		}
		events = ParseEventLine(Wire.Result(ResultFields{
			Report:  json.RawMessage(`{"summary":"done"}`),
			IsError: true,
			Text:    "API Error: 401 bad key",
		}))
		result = events[0]
		if !result.IsError || result.Text != "API Error: 401 bad key" ||
			string(result.StructuredOutput) != `{"summary":"done"}` {
			t.Fatalf("%+v", result)
		}
	})
}

func TestParseEventLine(t *testing.T) {
	t.Run("an event the wire cannot encode panics", func(t *testing.T) {
		defer mustPanic(t, "encoding an unknown kind")
		wireLine(domain.WorkerEvent{Kind: "banana"})
	})

	for name, line := range map[string]string{
		"torn":       "{torn",
		"blank":      "",
		"spaces":     "   ",
		"a number":   "5",
		"a string":   `"text"`,
		"null":       "null",
		"no type":    `{"sessionId":"s-1"}`,
		"wrong type": `{"type":5}`,
	} {
		if events := ParseEventLine(line); len(events) != 0 {
			t.Errorf("%s: %q parsed to %d events", name, line, len(events))
		}
	}
	// A type the core does not track still parses, the way JSON.parse leaves it.
	events := ParseEventLine(`{"type":"banana"}`)
	if len(events) != 1 || string(events[0].Kind) != "banana" {
		t.Errorf("banana = %+v", events)
	}
}

func TestEventDialect(t *testing.T) {
	if !reflect.DeepEqual(EVENT_DIALECT.Caps, testkit.ReferenceCaps) {
		t.Error("the dialect should carry the reference caps")
	}
	if EVENT_DIALECT.Init("s-1", "glm-5.3") != Wire.Init("s-1") {
		t.Error("the dialect's init should be the wire's")
	}
	if EVENT_DIALECT.SessionMissing(ports.WorkerSession{Kind: ports.SessionKindResume, Key: "s-1"}, "") {
		t.Error("the reference dialect never loses a session by itself")
	}
	if _, err := os.Stat(filepath.Join(EVENT_DIALECT.Fixtures, "success-edit.jsonl")); err != nil {
		t.Errorf("fixtures dir %s: %v", EVENT_DIALECT.Fixtures, err)
	}
	if EVENT_FIXTURES != EVENT_DIALECT.Fixtures {
		t.Error("EVENT_FIXTURES should be the dialect's fixtures dir")
	}
	// The fixtures are the recorded runs under the module's testdata.
	if got, want := EVENT_FIXTURES, filepath.Join(testkit.ModuleRoot(t), "testdata", "events"); got != want {
		t.Errorf("EVENT_FIXTURES = %s, want %s", got, want)
	}
}

func TestValidChangeReport(t *testing.T) {
	check := domain.CheckReport(VALID_CHANGE_REPORT, domain.ReportContract{
		Kind: domain.ReportContractBuiltin,
		Name: domain.BuiltinReportChange,
	})
	if !check.Present || !check.Valid || len(check.Problems) != 0 {
		t.Fatalf("the valid change report should pass: %+v", check)
	}
	script := Completes()
	if len(script.Lines) != 2 {
		t.Fatalf("completes streams %d lines", len(script.Lines))
	}
	result := ParseEventLine(script.Lines[1])[0]
	if string(result.StructuredOutput) != string(VALID_CHANGE_REPORT) {
		t.Errorf("completes reports %s", result.StructuredOutput)
	}
	override := json.RawMessage(`{"summary":"other"}`)
	if string(ParseEventLine(Completes(override).Lines[1])[0].StructuredOutput) != `{"summary":"other"}` {
		t.Error("the override should reach the result line")
	}
}

func TestScriptedWorker(t *testing.T) {
	ctx := context.Background()
	t.Run("streams its script and completes", func(t *testing.T) {
		processes := NewFakeProcess()
		worker := NewScriptedWorker(t, processes, Completes())
		logPath := filepath.Join(t.TempDir(), "attempt-1.jsonl")
		run, err := worker.Start(ctx, aSpec(logPath))
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		events := drain(t, run)
		if len(events) != 3 || events[0].Kind != domain.WorkerEventInit ||
			events[1].Kind != domain.WorkerEventAssistantText || events[2].Kind != domain.WorkerEventResult {
			t.Fatalf("events = %+v", events)
		}
		if events[0].SessionID != "s-1" {
			t.Errorf("the init line announces the spec's session, got %q", events[0].SessionID)
		}
		exit := run.Wait()
		if exit.Code == nil || *exit.Code != 0 || exit.Signal != nil || exit.Forced != nil || exit.SessionMissing {
			t.Fatalf("exit = %+v", exit)
		}
		want := strings.Join([]string{
			Wire.Init("s-1"),
			Wire.Text("working"),
			Wire.Result(ResultFields{Report: VALID_CHANGE_REPORT}),
		}, "\n") + "\n"
		raw, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatalf("read the attempt log: %v", err)
		}
		if string(raw) != want {
			t.Errorf("log = %q, want %q", raw, want)
		}
		if len(worker.Specs()) != 1 || worker.Specs()[0].Session.Key != "s-1" ||
			worker.Specs()[0].Model.ID != "glm-5.3" {
			t.Errorf("specs = %+v", worker.Specs())
		}
	})

	t.Run("plays a fixture instead of lines", func(t *testing.T) {
		worker := NewScriptedWorker(t, NewFakeProcess(), WorkerScript{Fixture: "success-edit.jsonl"})
		logPath := filepath.Join(t.TempDir(), "attempt-1.jsonl")
		run, err := worker.Start(ctx, aSpec(logPath))
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		events := drain(t, run)
		if len(events) < 2 || events[0].Kind != domain.WorkerEventOther ||
			events[1].Kind != domain.WorkerEventInit ||
			events[1].SessionID != "11111111-1111-4111-8111-111111111111" {
			t.Fatalf("the fixture's first events = %+v", events[:2])
		}
		fixture, err := os.ReadFile(filepath.Join(EVENT_FIXTURES, "success-edit.jsonl"))
		if err != nil {
			t.Fatalf("read the fixture: %v", err)
		}
		raw, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatalf("read the attempt log: %v", err)
		}
		if string(raw) != string(fixture)+"\n" {
			t.Errorf("the log should replay the fixture")
		}
	})

	t.Run("hangs until terminated", func(t *testing.T) {
		processes := NewFakeProcess()
		worker := NewScriptedWorker(t, processes, WorkerScript{Lines: []string{Wire.Text("working")}, Hang: true})
		run, err := worker.Start(ctx, aSpec(filepath.Join(t.TempDir(), "attempt-1.jsonl")))
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		if event := <-run.Events(); event.Kind != domain.WorkerEventInit {
			t.Fatalf("first event = %+v", event)
		}
		if event := <-run.Events(); event.Text != "working" {
			t.Fatalf("second event = %+v", event)
		}
		if err := run.Interrupt(ctx, ports.InterruptStopped); err != nil {
			t.Fatalf("interrupt: %v", err)
		}
		exit := run.Wait()
		if exit.Code != nil || exit.Signal == nil || *exit.Signal != "SIGTERM" || exit.Forced != nil {
			t.Fatalf("exit = %+v", exit)
		}
		if _, open := <-run.Events(); open {
			t.Error("the events channel should close once terminated")
		}
		if len(processes.Terminated()) != 1 {
			t.Errorf("terminated = %v", processes.Terminated())
		}
		// A second terminate is the same end again; it must not blow up.
		if err := run.Interrupt(ctx, ports.InterruptStopped); err != nil {
			t.Fatalf("second interrupt: %v", err)
		}
		if exit := run.Wait(); exit.Signal == nil || *exit.Signal != "SIGTERM" {
			t.Fatalf("exit after the second terminate = %+v", exit)
		}
	})

	t.Run("reports a start error and consumes the script", func(t *testing.T) {
		worker := NewScriptedWorker(
			t,
			NewFakeProcess(),
			WorkerScript{StartError: &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no key"}},
			Completes(),
		)
		_, err := worker.Start(ctx, aSpec("x.log"))
		var workerErr *ports.WorkerError
		if !errors.As(err, &workerErr) || workerErr.Kind != ports.WorkerErrorNoKey {
			t.Fatalf("start: %v", err)
		}
		run, err := worker.Start(ctx, aSpec("x.log"))
		if err != nil {
			t.Fatalf("the second script should play: %v", err)
		}
		if events := drain(t, run); len(events) != 3 {
			t.Errorf("events = %+v", events)
		}
		if len(worker.Specs()) != 2 {
			t.Errorf("a failed start still records its spec: %d", len(worker.Specs()))
		}
	})

	t.Run("reuses the last script and panics without one", func(t *testing.T) {
		worker := NewScriptedWorker(t, NewFakeProcess(), Completes())
		for i := 0; i < 2; i++ {
			run, err := worker.Start(ctx, aSpec(filepath.Join(t.TempDir(), "attempt-1.jsonl")))
			if err != nil {
				t.Fatalf("start %d: %v", i, err)
			}
			if events := drain(t, run); len(events) != 3 {
				t.Errorf("start %d streamed %+v", i, events)
			}
		}
		empty := NewScriptedWorker(t, NewFakeProcess())
		defer func() {
			if recover() == nil {
				t.Error("starting without a script should panic")
			}
		}()
		_, _ = empty.Start(ctx, aSpec("x.log"))
	})

	t.Run("bare streams no init line", func(t *testing.T) {
		worker := NewScriptedWorker(t, NewFakeProcess(), WorkerScript{Bare: true})
		logPath := filepath.Join(t.TempDir(), "attempt-1.jsonl")
		run, err := worker.Start(ctx, aSpec(logPath))
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		if events := drain(t, run); len(events) != 0 {
			t.Errorf("events = %+v", events)
		}
		if raw, err := os.ReadFile(logPath); err == nil && len(raw) != 0 {
			t.Errorf("the bare script logs nothing, got %q", raw)
		}
	})

	t.Run("exit overrides the default end", func(t *testing.T) {
		forced := domain.ForcedStopped
		worker := NewScriptedWorker(t, NewFakeProcess(), WorkerScript{
			Exit: &ports.WorkerExit{
				Code:       i64ptr(1),
				Signal:     strptr("SIGKILL"),
				StderrTail: "boom",
				Forced:     &forced,
			},
		})
		run, err := worker.Start(ctx, aSpec(filepath.Join(t.TempDir(), "a.log")))
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		drain(t, run)
		exit := run.Wait()
		if exit.Code == nil || *exit.Code != 1 || exit.StderrTail != "boom" ||
			exit.Signal == nil || *exit.Signal != "SIGKILL" ||
			exit.Forced == nil || *exit.Forced != domain.ForcedStopped {
			t.Fatalf("exit = %+v", exit)
		}
		// An override that leaves a field unset keeps the default for it.
		worker = NewScriptedWorker(t, NewFakeProcess(), WorkerScript{Exit: &ports.WorkerExit{StderrTail: "boom"}})
		run, err = worker.Start(ctx, aSpec(filepath.Join(t.TempDir(), "a.log")))
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		drain(t, run)
		if exit := run.Wait(); exit.Code == nil || *exit.Code != 0 || exit.Signal != nil || exit.Forced != nil {
			t.Fatalf("exit = %+v", exit)
		}
	})

	t.Run("a missing fixture panics", func(t *testing.T) {
		worker := NewScriptedWorker(t, NewFakeProcess(), WorkerScript{Fixture: "no-such-fixture.jsonl"})
		defer mustPanic(t, "playing a missing fixture")
		_, _ = worker.Start(ctx, aSpec("a.log"))
	})

	t.Run("a log path that cannot be written panics", func(t *testing.T) {
		defer mustPanic(t, "appending to a directory")
		appendLine(t.TempDir(), "{}")
	})

	t.Run("a script can report a missing session", func(t *testing.T) {
		worker := NewScriptedWorker(t, NewFakeProcess(), WorkerScript{
			Bare: true,
			Exit: &ports.WorkerExit{Code: i64ptr(1), SessionMissing: true},
		})
		run, err := worker.Start(ctx, aSpec(filepath.Join(t.TempDir(), "a.log")))
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		drain(t, run)
		if exit := run.Wait(); !exit.SessionMissing {
			t.Fatalf("exit = %+v", exit)
		}
	})

	t.Run("a dialect tells a missing session its own way", func(t *testing.T) {
		dialect := EVENT_DIALECT
		dialect.SessionMissing = func(session ports.WorkerSession, stderrTail string) bool {
			return session.Kind == ports.SessionKindResume
		}
		worker := NewScriptedWorkerInDialect(dialect, t, NewFakeProcess(), Completes())
		spec := aSpec(filepath.Join(t.TempDir(), "a.log"))
		spec.Session = ports.WorkerSession{Kind: ports.SessionKindResume, Key: "s-1"}
		run, err := worker.Start(ctx, spec)
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		drain(t, run)
		if exit := run.Wait(); !exit.SessionMissing {
			t.Fatalf("exit = %+v", exit)
		}
	})

	t.Run("onStart runs with the spec", func(t *testing.T) {
		var got ports.WorkerSpec
		// The log's temp dir comes first, so the fake's Stop runs before its removal.
		spec := aSpec(filepath.Join(t.TempDir(), "a.log"))
		worker := NewScriptedWorker(t, NewFakeProcess(), WorkerScript{
			OnStart: func(spec ports.WorkerSpec) { got = spec },
		})
		if _, err := worker.Start(ctx, spec); err != nil {
			t.Fatalf("start: %v", err)
		}
		if got.Session.Key != "s-1" {
			t.Errorf("onStart saw %+v", got)
		}
	})

	t.Run("no line lands after the test's cleanups", func(t *testing.T) {
		// The first line's parse is held, so the second line's write can only happen once this
		// test's cleanups have run (CI 38492804518: TempDir RemoveAll cleanup hit a directory
		// a late line had recreated). The fake must have dropped the line by then.
		delayed := EVENT_DIALECT
		delayed.ParseLine = func(line string) []domain.WorkerEvent {
			time.Sleep(120 * time.Millisecond)
			return ParseEventLine(line)
		}
		var dir string
		t.Cleanup(func() {
			// Registered before the TempDir, so it runs after the TempDir's own cleanup (LIFO).
			deadline := time.Now().Add(200 * time.Millisecond)
			for {
				if _, err := os.Stat(dir); err == nil {
					t.Errorf("the log directory %s was recreated after its cleanup", dir)
					return
				}
				if !time.Now().Before(deadline) {
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
		})
		dir = t.TempDir()
		worker := NewScriptedWorkerInDialect(delayed, t, NewFakeProcess(), WorkerScript{
			Bare:  true,
			Lines: []string{"{torn", Wire.Text("two")},
		})
		logPath := filepath.Join(dir, "attempt-1.jsonl")
		if _, err := worker.Start(ctx, aSpec(logPath)); err != nil {
			t.Fatalf("start: %v", err)
		}
		// The first line is on disk, so the goroutine sits in (or just before) the held parse.
		if err := testkit.Until(t, func() bool {
			raw, err := os.ReadFile(logPath)
			return err == nil && strings.Contains(string(raw), "{torn")
		}, testkit.UntilOptions{Message: "the first line never landed"}); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("caps, preflight, parseLine and dispose follow the dialect", func(t *testing.T) {
		worker := NewScriptedWorker(t, NewFakeProcess(), Completes())
		if !reflect.DeepEqual(worker.Caps(), testkit.ReferenceCaps) {
			t.Error("caps should come from the dialect")
		}
		if err := worker.Preflight(ctx); err != nil {
			t.Errorf("preflight: %v", err)
		}
		if events := worker.ParseLine(Wire.Text("x")); len(events) != 1 {
			t.Errorf("parseLine = %+v", events)
		}
		if err := worker.Dispose(ctx); err != nil {
			t.Errorf("dispose: %v", err)
		}
		if err := worker.Dispose(ctx); err != nil {
			t.Errorf("dispose: %v", err)
		}
		if worker.Disposed() != 2 {
			t.Errorf("disposed = %d", worker.Disposed())
		}
	})
}

func TestFakeGit(t *testing.T) {
	ctx := context.Background()
	t.Run("root answers for /repo only", func(t *testing.T) {
		git := NewFakeGit()
		for _, cwd := range []string{"/repo", "/repo/sub"} {
			if root, err := git.Root(ctx, cwd); err != nil || root != "/repo" {
				t.Errorf("root(%s) = %q, %v", cwd, root, err)
			}
		}
		_, err := git.Root(ctx, "/elsewhere")
		var gitErr *ports.GitError
		if !errors.As(err, &gitErr) || gitErr.Kind != ports.GitErrorNotARepo || gitErr.Path != "/elsewhere" {
			t.Fatalf("root elsewhere: %v", err)
		}
		if len(git.Called("root")) != 3 {
			t.Errorf("root calls = %v", git.Called("root"))
		}
	})

	t.Run("resolve answers HEAD from the worktree", func(t *testing.T) {
		git := NewFakeGit()
		if sha, err := git.Resolve(ctx, "/repo", "HEAD"); err != nil || sha != BASE_SHA {
			t.Errorf("repo HEAD = %q, %v", sha, err)
		}
		git.WorktreeHead = "w" + strings.Repeat("t", 39)
		if sha, err := git.Resolve(ctx, "/state/worktrees/j1", "HEAD"); err != nil || sha != git.WorktreeHead {
			t.Errorf("worktree HEAD = %q, %v", sha, err)
		}
		_, err := git.Resolve(ctx, "/repo", "missing")
		var gitErr *ports.GitError
		if !errors.As(err, &gitErr) || gitErr.Kind != ports.GitErrorBadRef || gitErr.Ref != "missing" {
			t.Fatalf("bad ref: %v", err)
		}
	})

	t.Run("commits move the worktree head", func(t *testing.T) {
		git := NewFakeGit()
		sha, err := git.CommitAll(ctx, "/wt", "done", ports.CommitOptions{Verify: true})
		if err != nil || sha != COMMIT_SHA || git.WorktreeHead != COMMIT_SHA {
			t.Fatalf("commitAll = %q, %v, head %q", sha, err, git.WorktreeHead)
		}
		git.CommitErr = &ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git commit", Stderr: "hook failed"}
		git.WorktreeHead = BASE_SHA
		if _, err := git.CommitAll(ctx, "/wt", "again", ports.CommitOptions{}); err == nil {
			t.Fatal("a scripted commit failure should fail")
		}
		if git.WorktreeHead != BASE_SHA {
			t.Errorf("a failed commit should not move the head: %q", git.WorktreeHead)
		}
		if _, err := git.AmendAll(ctx, "/wt", ports.CommitOptions{}); err != nil || git.WorktreeHead != COMMIT_SHA {
			t.Errorf("amendAll head = %q, %v", git.WorktreeHead, err)
		}
	})

	t.Run("status fingerprints shift then repeat", func(t *testing.T) {
		git := NewFakeGit()
		if fp, _ := git.StatusFingerprint(ctx, "/repo"); fp != "fp-0" {
			t.Errorf("default fingerprint = %q", fp)
		}
		git.Fingerprints = []string{"a", "b"}
		for _, want := range []string{"a", "b", "b"} {
			if fp, _ := git.StatusFingerprint(ctx, "/repo"); fp != want {
				t.Errorf("fingerprint = %q, want %q", fp, want)
			}
		}
		git.Fingerprints = nil
		if fp, _ := git.StatusFingerprint(ctx, "/repo"); fp != "fp-0" {
			t.Errorf("empty fingerprints should read fp-0, got %q", fp)
		}
	})

	t.Run("diff, changes, branch and the landing answers", func(t *testing.T) {
		git := NewFakeGit()
		git.ChangeSet = testkit.AChangeSet(func(changes *domain.ChangeSet) {
			changes.Modified = []string{"src/a.ts"}
		})
		changes, err := git.Changes(ctx, "/wt", BASE_SHA)
		if err != nil || len(changes.Modified) != 1 {
			t.Fatalf("changes = %+v, %v", changes, err)
		}
		if args := git.Called("changes"); len(args) != 1 || args[0][0] != "/wt" || args[0][1] != BASE_SHA {
			t.Errorf("changes args = %v", args)
		}
		if text, _ := git.Diff(ctx, "/wt", BASE_SHA, ports.DiffOptions{}); text != git.DiffText {
			t.Errorf("diff text = %q", text)
		}
		if stat, _ := git.Diff(ctx, "/wt", BASE_SHA, ports.DiffOptions{Stat: true}); stat != git.DiffStat {
			t.Errorf("diff stat = %q", stat)
		}
		if branch, _ := git.CurrentBranch(ctx, "/repo"); branch != "main" {
			t.Errorf("branch = %q", branch)
		}
		if trailer, _ := git.Trailer(ctx, "/repo"); trailer != ports.TrailerSettingWorkedBy {
			t.Errorf("trailer = %q", trailer)
		}
		if ok, _ := git.IsAncestor(ctx, "/repo", BASE_SHA, COMMIT_SHA); !ok {
			t.Error("isAncestor should default to true")
		}
		if outcome, _ := git.FastForward(ctx, "/repo", COMMIT_SHA, BASE_SHA); outcome != ports.FastForwardLanded {
			t.Errorf("fastForward = %q", outcome)
		}
		for _, call := range []struct {
			name string
			run  func() error
		}{
			{"addWorktree", func() error {
				return git.AddWorktree(ctx, "/repo", "/wt", "zai/j1", BASE_SHA)
			}},
			{"removeWorktree", func() error {
				return git.RemoveWorktree(ctx, "/repo", "/wt", "zai/j1")
			}},
			{"rebaseJobBranch", func() error {
				return git.RebaseJobBranch(ctx, "/wt", BASE_SHA, []string{"pnpm-lock.yaml"})
			}},
			{"addDetachedWorktree", func() error {
				return git.AddDetachedWorktree(ctx, "/repo", "/co", COMMIT_SHA)
			}},
			{"removeDetachedWorktree", func() error {
				return git.RemoveDetachedWorktree(ctx, "/repo", "/co")
			}},
			{"applyToWorkingTree", func() error {
				return git.ApplyToWorkingTree(ctx, "/repo", "/wt", BASE_SHA)
			}},
		} {
			if err := call.run(); err != nil {
				t.Errorf("%s: %v", call.name, err)
			}
			if len(git.Called(call.name)) != 1 {
				t.Errorf("%s was not recorded", call.name)
			}
		}
	})
}

func TestFakeGates(t *testing.T) {
	ctx := context.Background()
	gate := domain.Gate{Run: "npm test", TimeoutMs: 60_000}
	t.Run("unlisted commands pass", func(t *testing.T) {
		gates := NewFakeGates()
		result := gates.Run(ctx, "/wt", gate, map[string]string{"ZAI_ARTIFACTS": "/a"}, "/log/gate.log")
		if result.Run != "npm test" || result.ExitCode == nil || *result.ExitCode != 0 ||
			result.TimedOut || result.DurationMs != 10 || result.Tail != "" {
			t.Fatalf("result = %+v", result)
		}
		if len(gates.Calls) != 1 || gates.Calls[0].Cwd != "/wt" ||
			gates.Calls[0].PassEnv["ZAI_ARTIFACTS"] != "/a" || gates.Calls[0].LogPath != "/log/gate.log" {
			t.Errorf("calls = %+v", gates.Calls)
		}
	})

	t.Run("failOnce fails once then passes", func(t *testing.T) {
		gates := NewFakeGates()
		gates.FailOnce("npm test")
		gates.FailOnce("lint", "eslint: 2 errors")
		first := gates.Run(ctx, "/wt", gate, nil, "")
		if first.ExitCode == nil || *first.ExitCode != 1 || first.Tail != "1 failing test" {
			t.Fatalf("first = %+v", first)
		}
		if lint := gates.Run(ctx, "/wt", domain.Gate{Run: "lint"}, nil, ""); lint.Tail != "eslint: 2 errors" {
			t.Fatalf("a custom tail = %q", lint.Tail)
		}
		second := gates.Run(ctx, "/wt", gate, nil, "")
		if second.ExitCode == nil || *second.ExitCode != 0 {
			t.Fatalf("second = %+v", second)
		}
		third := gates.Run(ctx, "/wt", gate, nil, "")
		if third.ExitCode == nil || *third.ExitCode != 0 {
			t.Fatalf("the last answer repeats: %+v", third)
		}
	})

	t.Run("a queued answer carries its tail and timeout", func(t *testing.T) {
		gates := NewFakeGates()
		gates.Results["lint"] = []GateAnswer{{ExitCode: i64ptr(2), TimedOut: true, Tail: "killed"}}
		result := gates.Run(ctx, "/wt", domain.Gate{Run: "lint"}, nil, "")
		if result.ExitCode == nil || *result.ExitCode != 2 || !result.TimedOut || result.Tail != "killed" {
			t.Fatalf("result = %+v", result)
		}
	})
}

func TestFakeLimiter(t *testing.T) {
	ctx := context.Background()
	t.Run("capacity and limit report the levels", func(t *testing.T) {
		limiter := NewFakeLimiter()
		if capacity := limiter.Capacity(ctx, 0); capacity != 4 {
			t.Errorf("capacity = %d", capacity)
		}
		levels := limiter.Limit(ctx, 0)
		if levels.Cap != 4 || levels.Max != domain.DEFAULT_LIMITER.DefaultMax {
			t.Errorf("levels = %+v", levels)
		}
	})

	t.Run("rate limits are recorded and tagged", func(t *testing.T) {
		limiter := NewFakeLimiter()
		if err := limiter.RateLimited(ctx, 10, ports.RateLimitOptions{}); err != nil {
			t.Fatalf("rateLimited: %v", err)
		}
		if err := limiter.RateLimited(ctx, 11, ports.RateLimitOptions{EndedAttempt: true}); err != nil {
			t.Fatalf("rateLimited: %v", err)
		}
		if got := limiter.RateLimitedAt(); len(got) != 2 || got[0] != 10 || got[1] != 11 {
			t.Errorf("rateLimitedAt = %v", got)
		}
		if got := limiter.EndedAttempts(); len(got) != 1 || got[0] != 11 {
			t.Errorf("endedAttempts = %v", got)
		}
	})

	t.Run("saveMax clamps the cap down only", func(t *testing.T) {
		limiter := NewFakeLimiter()
		if err := limiter.SaveMax(ctx, 2, 0); err != nil {
			t.Fatalf("saveMax: %v", err)
		}
		if limiter.SavedMax == nil || *limiter.SavedMax != 2 {
			t.Errorf("savedMax = %v", limiter.SavedMax)
		}
		levels := limiter.Limit(ctx, 0)
		if levels.Cap != 2 || levels.Max != 2 {
			t.Errorf("levels = %+v", levels)
		}
		if err := limiter.SaveMax(ctx, 32, 0); err != nil {
			t.Fatalf("saveMax: %v", err)
		}
		if levels = limiter.Limit(ctx, 0); levels.Cap != 2 || levels.Max != 32 {
			t.Errorf("saveMax never lifts the cap: %+v", levels)
		}
	})
}

func TestFakeSemaphore(t *testing.T) {
	ctx := context.Background()
	t.Run("acquire records the holder and release reports it", func(t *testing.T) {
		semaphore := NewFakeSemaphore()
		release, err := semaphore.Acquire(ctx, ports.SemaphoreHolder{
			JobID: "j1", Pid: 111, Priority: domain.PriorityNormal,
		})
		if err != nil {
			t.Fatalf("acquire: %v", err)
		}
		if got := semaphore.Acquired(); len(got) != 1 || got[0] != "j1" {
			t.Errorf("acquired = %v", got)
		}
		holders := semaphore.Holders()
		if len(holders) != 1 || holders[0].Pid != 111 || holders[0].Priority != domain.PriorityNormal {
			t.Errorf("holders = %+v", holders)
		}
		if held := semaphore.Held(ctx); held != nil {
			t.Errorf("held = %+v", held)
		}
		release()
		if got := semaphore.Released(); len(got) != 1 || got[0] != "j1" {
			t.Errorf("released = %v", got)
		}
	})

	t.Run("a blocked acquire waits and fails with its context", func(t *testing.T) {
		semaphore := NewFakeSemaphore()
		semaphore.SetBlocked(true)
		blockedCtx, cancel := context.WithCancel(ctx)
		acquired := make(chan error, 1)
		go func() {
			_, err := semaphore.Acquire(blockedCtx, ports.SemaphoreHolder{JobID: "j1", Pid: 111})
			acquired <- err
		}()
		if err := testkit.Until(t, func() bool { return semaphore.Waiting() == 1 }, testkit.UntilOptions{}); err != nil {
			t.Fatalf("the acquire should wait: %v", err)
		}
		cancel()
		if err := <-acquired; !errors.Is(err, context.Canceled) {
			t.Fatalf("blocked acquire = %v", err)
		}
		if semaphore.Waiting() != 0 {
			t.Errorf("waiting = %d", semaphore.Waiting())
		}
		if got := semaphore.Acquired(); len(got) != 0 {
			t.Errorf("a give-up acquire holds nothing: %v", got)
		}
	})
}

func TestManualClock(t *testing.T) {
	t.Run("starts at T0 and formats ISO", func(t *testing.T) {
		clock := NewManualClock()
		if clock.Now() != T0 {
			t.Errorf("now = %d", clock.Now())
		}
		if T0 != 1791244800000 {
			t.Errorf("T0 = %d", T0)
		}
		if got := clock.Iso(); got != "2026-10-06T00:00:00.000Z" {
			t.Errorf("iso = %q", got)
		}
	})

	t.Run("advance moves now", func(t *testing.T) {
		clock := NewManualClock()
		clock.Advance(1500)
		if clock.Now() != T0+1500 || clock.Iso() != "2026-10-06T00:00:01.500Z" {
			t.Errorf("now = %d, iso = %q", clock.Now(), clock.Iso())
		}
	})

	t.Run("sleep advances and yields", func(t *testing.T) {
		clock := NewManualClock()
		if err := clock.Sleep(context.Background(), 60_000); err != nil {
			t.Fatalf("sleep: %v", err)
		}
		if clock.Now() != T0+60_000 {
			t.Errorf("now = %d", clock.Now())
		}
	})

	t.Run("sleep on a cancelled context errors without moving", func(t *testing.T) {
		clock := NewManualClock()
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := clock.Sleep(ctx, 60_000); !errors.Is(err, context.Canceled) {
			t.Fatalf("sleep = %v", err)
		}
		if clock.Now() != T0 {
			t.Errorf("now = %d", clock.Now())
		}
	})
}

func TestFakeIds(t *testing.T) {
	ids := NewFakeIds()
	if got := ids.JobID(); got != "261006-job001" {
		t.Errorf("jobID = %q", got)
	}
	if got := ids.JobID(); got != "261006-job002" {
		t.Errorf("jobID = %q", got)
	}
	if got := ids.SessionID(); got != "00000000-0000-4000-8000-000000000001" {
		t.Errorf("sessionID = %q", got)
	}
	if got := ids.SessionID(); got != "00000000-0000-4000-8000-000000000002" {
		t.Errorf("sessionID = %q", got)
	}
}

func TestFakeProcess(t *testing.T) {
	ctx := context.Background()
	t.Run("the test process counts as alive", func(t *testing.T) {
		processes := NewFakeProcess()
		if !processes.IsAlive(int64(os.Getpid())) {
			t.Error("the fake starts with the test process alive")
		}
		if processes.IsAlive(4242) {
			t.Error("an unknown pid is not alive")
		}
	})

	t.Run("terminateGroup records and fires onTerminate", func(t *testing.T) {
		processes := NewFakeProcess()
		fired := make(chan struct{})
		processes.setOnTerminate(4242, func() { close(fired) })
		if err := processes.TerminateGroup(ctx, 4242, 5000); err != nil {
			t.Fatalf("terminateGroup: %v", err)
		}
		if got := processes.Terminated(); len(got) != 1 || got[0] != 4242 {
			t.Errorf("terminated = %v", got)
		}
		if processes.IsAlive(4242) {
			t.Error("a terminated pid is not alive")
		}
		select {
		case <-fired:
		default:
			t.Error("the onTerminate callback should have fired")
		}
	})

	t.Run("setAlive changes what isAlive says, as a spawned driver's life", func(t *testing.T) {
		processes := NewFakeProcess()
		processes.SetAlive(70_001, true)
		if !processes.IsAlive(70_001) {
			t.Error("a pid set alive is alive")
		}
		processes.SetAlive(70_001, false)
		if processes.IsAlive(70_001) {
			t.Error("a pid set dead is not alive")
		}
	})

	t.Run("spawnDriver returns sequential pids and reports spawns", func(t *testing.T) {
		processes := NewFakeProcess()
		var spawned []string
		processes.SetOnSpawn(func(jobID string) { spawned = append(spawned, jobID) })
		if pid := processes.SpawnDriver("261006-job001"); pid != 70_001 {
			t.Errorf("pid = %d", pid)
		}
		if pid := processes.SpawnDriver("261006-job002"); pid != 70_002 {
			t.Errorf("pid = %d", pid)
		}
		if got := processes.Spawned(); strings.Join(got, ",") != "261006-job001,261006-job002" {
			t.Errorf("spawned = %v", got)
		}
		if strings.Join(spawned, ",") != "261006-job001,261006-job002" {
			t.Errorf("onSpawn saw %v", spawned)
		}
	})
}

func TestRecordingOutput(t *testing.T) {
	var out RecordingOutput
	out.Line("one")
	out.Line("two")
	out.Error("boom")
	if out.Text() != "one\ntwo" {
		t.Errorf("text = %q", out.Text())
	}
	if strings.Join(out.Errors, ",") != "boom" {
		t.Errorf("errors = %v", out.Errors)
	}
}

func TestJobPathsUnder(t *testing.T) {
	root := t.TempDir()
	if got, want := JobPathsUnder(root, "j1"), domain.NewStateLayout(root).Job("j1"); got != want {
		t.Errorf("paths = %+v, want %+v", got, want)
	}
}

func TestModuleRootWalk(t *testing.T) {
	// Outside any module the walk gives up, so a misplaced test fails loudly instead of reading a
	// random directory as the fixtures dir.
	t.Chdir("/")
	defer mustPanic(t, "walking from outside a module")
	moduleRoot()
}
