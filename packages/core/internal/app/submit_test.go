package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// The world the submit, queries, follow, attempts and exclusive tests run in: the merged testkit
// fakes wired into Deps, with the job sidecars as real files under a temp root (the brief, the
// attempt logs the tests write themselves, the progress snapshot, the driver lock the MemoryStore
// writes), the fs adapter wired the same way.

// testFiles is the fs job files for these tests: real sidecar files under the state root, so a
// job's files land where the use cases look for them.
type testFiles struct{}

var _ ports.JobFiles = (*testFiles)(nil)

func newTestFiles() *testFiles { return &testFiles{} }

func (f *testFiles) WriteBrief(ctx context.Context, paths domain.JobPaths, text string) error {
	if err := os.MkdirAll(paths.Artifacts, 0o755); err != nil {
		return err
	}
	return os.WriteFile(paths.Brief, []byte(text), 0o644)
}

func (f *testFiles) RequestStop(ctx context.Context, paths domain.JobPaths) error {
	return os.WriteFile(paths.Stop, nil, 0o644)
}

func (f *testFiles) StopRequested(ctx context.Context, paths domain.JobPaths) bool {
	_, err := os.ReadFile(paths.Stop)
	return err == nil
}

// ClearStop retries for up to a second, as the real adapter does: a delete can collide with
// the stop watcher's read holding the file open.
func (f *testFiles) ClearStop(ctx context.Context, paths domain.JobPaths) error {
	var err error
	for range 40 {
		if err = os.Remove(paths.Stop); err == nil || os.IsNotExist(err) {
			return nil
		}
		time.Sleep(25 * time.Millisecond)
	}
	return err
}

func (f *testFiles) WriteProgress(ctx context.Context, paths domain.JobPaths, attempt int64, progress domain.Progress) error {
	// Plain numbers and strings; the marshal cannot fail.
	data, _ := json.Marshal(struct {
		Attempt  int64           `json:"attempt"`
		Progress domain.Progress `json:"progress"`
	}{attempt, progress})
	return os.WriteFile(paths.Progress, append(data, '\n'), 0o644)
}

func (f *testFiles) ReadProgress(ctx context.Context, paths domain.JobPaths, attempt int64) *domain.Progress {
	text, err := os.ReadFile(paths.Progress)
	if err != nil {
		return nil
	}
	var snapshot struct {
		Attempt  int64           `json:"attempt"`
		Progress domain.Progress `json:"progress"`
	}
	if json.Unmarshal(text, &snapshot) != nil || snapshot.Attempt != attempt {
		return nil
	}
	return &snapshot.Progress
}

func (f *testFiles) ReadText(ctx context.Context, path string) (string, error) {
	text, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(text), nil
}

func (f *testFiles) DriverPid(ctx context.Context, paths domain.JobPaths) (int64, bool) {
	text, err := os.ReadFile(paths.DriverLock)
	if err != nil {
		return 0, false
	}
	return domain.ParsePid(string(text))
}

func (f *testFiles) EnginePid(paths domain.JobPaths) (int64, bool) {
	text, err := os.ReadFile(paths.EnginePid)
	if err != nil {
		return 0, false
	}
	return domain.ParsePid(string(text))
}

func (f *testFiles) ClearEnginePid(paths domain.JobPaths) {
	_ = os.Remove(paths.EnginePid)
}

func (f *testFiles) CheckoutIds() []string { return nil }

func (f *testFiles) CheckoutRepo(checkout string) (string, bool) { return "", false }

func (f *testFiles) Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (f *testFiles) RemoveTree(path string) { _ = os.RemoveAll(path) }

// aliveProcess adds pids to (and removes them from) the alive set the process fake answers, and
// records the grace each termination was given.
type aliveProcess struct {
	*fakes.FakeProcess
	mu     sync.Mutex
	extra  map[int64]bool
	graces []int64
}

func newAliveProcess() *aliveProcess {
	return &aliveProcess{FakeProcess: fakes.NewFakeProcess(), extra: map[int64]bool{}}
}

func (p *aliveProcess) IsAlive(pid int64) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.extra[pid] || p.FakeProcess.IsAlive(pid)
}

// TerminateGroup records the grace it was given, then terminates as the fake does.
func (p *aliveProcess) TerminateGroup(ctx context.Context, pid int64, graceMs int64) error {
	p.mu.Lock()
	p.graces = append(p.graces, graceMs)
	p.mu.Unlock()
	return p.FakeProcess.TerminateGroup(ctx, pid, graceMs)
}

// MarkAlive counts pid as a live process.
func (p *aliveProcess) MarkAlive(pid int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.extra[pid] = true
}

// MarkDead counts pid as a dead one, as a driver that died mid-job.
func (p *aliveProcess) MarkDead(pid int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.extra, pid)
}

// gracesOf is every termination's grace, in order.
func (p *aliveProcess) gracesOf() []int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]int64{}, p.graces...)
}

// noSpool answers no routed events, as the spool reader does where nothing spooled.
type noSpool struct{}

func (noSpool) Events(now int64, days int) []domain.SpoolEvent { return nil }

// appWorld is the fakes behind a Deps, each one reachable for a test to script.
type appWorld struct {
	deps    Deps
	root    string
	store   *fakes.MemoryStore
	git     *fakes.FakeGit
	files   *testFiles
	engines *fakeEngineConfigStore
	worker  *fakes.ScriptedWorker
	limiter *fakes.FakeLimiter
	clock   *fakes.ManualClock
	ids     *fakes.FakeIds
	process *aliveProcess
	out     *fakes.RecordingOutput
}

// newWorld is a Deps over fresh fakes rooted in a temp dir, the worker completing a valid change
// report, HOME under the root so nothing touches the developer's own.
func newWorld(t *testing.T, env map[string]string) (Deps, *appWorld) {
	t.Helper()
	root := t.TempDir()
	process := newAliveProcess()
	world := &appWorld{
		root:    root,
		store:   fakes.NewMemoryStore(root),
		git:     fakes.NewFakeGit(),
		files:   newTestFiles(),
		engines: &fakeEngineConfigStore{},
		worker:  fakes.NewScriptedWorker(t, process.FakeProcess, fakes.Completes()),
		limiter: fakes.NewFakeLimiter(),
		clock:   fakes.NewManualClock(),
		ids:     fakes.NewFakeIds(),
		process: process,
		out:     &fakes.RecordingOutput{},
	}
	fullEnv := map[string]string{"HOME": filepath.Join(root, "home")}
	for name, value := range env {
		fullEnv[name] = value
	}
	world.deps = Deps{
		Worker:       world.worker,
		Git:          world.git,
		Gates:        fakes.NewFakeGates(),
		Store:        world.store,
		Files:        world.files,
		EngineConfig: world.engines,
		Spool:        noSpool{},
		Semaphore:    fakes.NewFakeSemaphore(),
		Limiter:      world.limiter,
		Clock:        world.clock,
		Ids:          world.ids,
		Process:      world.process,
		Out:          world.out,
		Host:         HostInfo{StateRoot: root},
		BundlePath:   filepath.Join(root, "plugin", "dist", "zai.js"),
		Provider:     testkit.ReferenceProvider,
		Env:          fullEnv,
		Config:       Config{Limiter: domain.DEFAULT_LIMITER, Prompt: domain.DefaultLimits, StopGraceMs: 100},
	}
	return world.deps, world
}

// submitBrief is a brief document: front matter around a body.
func submitBrief(front string, body ...string) string {
	text := "Rename `foo` to `bar`.\n"
	if len(body) > 0 {
		text = body[0]
	}
	return "---\n" + front + "\n---\n" + text
}

const editBrief = "---\ntitle: Rename foo\ngates: [npm test]\n---\nRename `foo` to `bar`.\n"

func TestSubmit(t *testing.T) {
	ctx := context.Background()

	t.Run("edit: creates worktree zai/<id> at the resolved base sha and persists a queued job", func(t *testing.T) {
		deps, w := newWorld(t, nil)

		submitted, err := Submit(ctx, deps, SubmitInput{
			Text:       editBrief,
			SourcePath: strPtr("/repo/briefs/rename.md"),
			Cwd:        "/repo/src",
		})
		if err != nil {
			t.Fatal(err)
		}

		id := "261006-job001"
		worktree := filepath.Join(w.root, "worktrees", id)
		if calls := w.git.Called("addWorktree"); !reflect.DeepEqual(calls, [][]any{
			{"/repo", worktree, "zai/" + id, fakes.BASE_SHA},
		}) {
			t.Errorf("addWorktree calls = %v, want the worktree at the base sha", calls)
		}
		stored, err := w.store.Get(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(submitted, stored) {
			t.Errorf("submitted = %+v, want the stored job %+v", submitted, stored)
		}
		if stored.ID != id || stored.State != domain.JobStateQueued ||
			len(stored.Attempts) != 0 || stored.Version != 1 ||
			stored.CreatedAt != "2026-10-06T00:00:00.000Z" || stored.UpdatedAt != "2026-10-06T00:00:00.000Z" {
			t.Errorf("stored job = %+v, want the queued job at version 1", stored)
		}
		if brief := stored.Brief; brief.Title != "Rename foo" || brief.Mode != domain.ModeEdit ||
			brief.Model != domain.ModelTierMain || brief.Cwd != "/repo" || brief.Base != "HEAD" {
			t.Errorf("brief = %+v, want the parsed edit brief", brief)
		}
		if ws := stored.Workspace; ws.RepoRoot != "/repo" || ws.BaseSha != fakes.BASE_SHA ||
			ws.Worktree == nil || *ws.Worktree != worktree ||
			ws.Branch == nil || *ws.Branch != "zai/"+id ||
			ws.ArtifactsDir != filepath.Join(w.root, "jobs", id, "artifacts") {
			t.Errorf("workspace = %+v, want the worktree and the artifacts dir", ws)
		}
		if _, err := os.Stat(filepath.Join(w.root, "jobs", id, "artifacts")); err != nil {
			t.Errorf("the artifacts dir should exist: %v", err)
		}
		text, err := os.ReadFile(filepath.Join(w.root, "jobs", id, "brief.md"))
		if err != nil || string(text) != editBrief {
			t.Errorf("brief.md = %q (%v), want the brief as submitted", text, err)
		}
	})

	t.Run("exec/readonly: no worktree; workspace has repoRoot, baseSha and artifactsDir", func(t *testing.T) {
		deps, w := newWorld(t, nil)

		exec, err := Submit(ctx, deps, SubmitInput{Text: submitBrief("title: Sweep\nmode: exec"), Cwd: "/repo"})
		if err != nil {
			t.Fatal(err)
		}
		readonly, err := Submit(ctx, deps, SubmitInput{Text: submitBrief("title: Read\nmode: readonly"), Cwd: "/repo"})
		if err != nil {
			t.Fatal(err)
		}

		if calls := w.git.Called("addWorktree"); len(calls) != 0 {
			t.Errorf("addWorktree calls = %v, want none", calls)
		}
		if ws := exec.Workspace; ws.RepoRoot != "/repo" || ws.BaseSha != fakes.BASE_SHA ||
			ws.Worktree != nil || ws.Branch != nil ||
			ws.ArtifactsDir != filepath.Join(w.root, "jobs", "261006-job001", "artifacts") {
			t.Errorf("exec workspace = %+v, want no worktree", ws)
		}
		if readonly.Brief.Mode != domain.ModeReadonly {
			t.Errorf("readonly mode = %s, want readonly", readonly.Brief.Mode)
		}
		if readonly.Workspace.Worktree != nil {
			t.Errorf("readonly workspace = %+v, want no worktree", readonly.Workspace)
		}
	})

	t.Run("records the submitting Claude Code session as the job's origin", func(t *testing.T) {
		sessionID := "F81D4FAE-7DEC-41D0-A765-00A0C91E6BF6"
		deps, _ := newWorld(t, map[string]string{"CLAUDE_CODE_SESSION_ID": sessionID})

		submitted, err := Submit(ctx, deps, SubmitInput{Text: editBrief, Cwd: "/repo"})
		if err != nil {
			t.Fatal(err)
		}

		if submitted.Origin == nil || submitted.Origin.SessionID != sessionID {
			t.Errorf("origin = %+v, want the session %s", submitted.Origin, sessionID)
		}
	})

	t.Run("no origin when CLAUDE_CODE_SESSION_ID is missing, empty or not a UUID", func(t *testing.T) {
		for name, value := range map[string]string{
			"missing":         "",
			"empty":           "",
			"not a session":   "not-a-session",
			"one digit short": "f81d4fae-7dec-41d0-a765-00a0c91e6bf",
			"no dashes":       "f81d4fae7dec41d0a76500a0c91e6bf6",
		} {
			t.Run(name, func(t *testing.T) {
				env := map[string]string{}
				if name != "missing" {
					env["CLAUDE_CODE_SESSION_ID"] = value
				}
				deps, _ := newWorld(t, env)

				submitted, err := Submit(ctx, deps, SubmitInput{Text: editBrief, Cwd: "/repo"})
				if err != nil {
					t.Fatal(err)
				}
				if submitted.Origin != nil {
					t.Errorf("origin = %+v, want none", submitted.Origin)
				}
			})
		}
	})

	t.Run("brief errors → brief error, nothing created", func(t *testing.T) {
		deps, w := newWorld(t, nil)

		_, err := Submit(ctx, deps, SubmitInput{Text: submitBrief("mode: edit", "   \n"), Cwd: "/repo"})

		want := &AppError{Kind: AppErrorBrief, BriefErrors: []domain.BriefError{
			{Kind: domain.BriefErrorField, Field: "title", Message: "required"},
			{Kind: domain.BriefErrorEmptyBody},
		}}
		var appErr *AppError
		if !errors.As(err, &appErr) {
			t.Fatalf("Submit() error = %v, want a brief AppError", err)
		}
		if !reflect.DeepEqual(appErr, want) {
			t.Errorf("error = %+v, want %+v", appErr, want)
		}
		if jobs := w.store.List(ctx, ports.ListFilter{}); len(jobs) != 0 {
			t.Errorf("jobs = %d, want none", len(jobs))
		}
		if calls := w.git.Called("addWorktree"); len(calls) != 0 {
			t.Errorf("addWorktree calls = %v, want none", calls)
		}
	})

	t.Run("missing env names → missing_env listing all of them, nothing created", func(t *testing.T) {
		deps, w := newWorld(t, map[string]string{"NPM_TOKEN": "secret", "EMPTY": ""})

		_, err := Submit(ctx, deps, SubmitInput{
			Text: submitBrief("title: Needs env\nenv: [NPM_TOKEN, EMPTY, GH_TOKEN, AWS_PROFILE]"),
			Cwd:  "/repo",
		})

		want := &AppError{Kind: AppErrorMissingEnv, Names: []string{"GH_TOKEN", "AWS_PROFILE"}}
		var appErr *AppError
		if !errors.As(err, &appErr) || !reflect.DeepEqual(appErr, want) {
			t.Fatalf("Submit() error = %+v, want %+v", err, want)
		}
		if jobs := w.store.List(ctx, ports.ListFilter{}); len(jobs) != 0 {
			t.Errorf("jobs = %d, want none", len(jobs))
		}
	})

	t.Run("applies --flash / --mode overrides before mode-dependent defaults", func(t *testing.T) {
		deps, _ := newWorld(t, nil)

		flashExec, err := Submit(ctx, deps, SubmitInput{
			Text:      submitBrief("title: Sweep\nmodel: glm"),
			Cwd:       "/repo",
			Overrides: &BriefOverrides{Model: strPtr(domain.ModelTierFlash), Mode: strPtr(domain.ModeExec)},
		})
		if err != nil {
			t.Fatal(err)
		}
		readonly, err := Submit(ctx, deps, SubmitInput{
			Text:      submitBrief("title: Look\nmode: edit"),
			Cwd:       "/repo",
			Overrides: &BriefOverrides{Mode: strPtr(domain.ModeReadonly)},
		})
		if err != nil {
			t.Fatal(err)
		}

		if brief := flashExec.Brief; brief.Model != domain.ModelTierFlash || brief.Mode != domain.ModeExec ||
			len(brief.Scope) != 0 ||
			brief.Report != (domain.Report{Kind: domain.ReportKindBuiltin, Name: domain.BuiltinReportSweep}) {
			t.Errorf("flash exec brief = %+v, want the exec defaults on the flash tier", brief)
		}
		if brief := readonly.Brief; brief.Model != domain.ModelTierFlash || brief.Mode != domain.ModeReadonly ||
			brief.Report != (domain.Report{Kind: domain.ReportKindBuiltin, Name: domain.BuiltinReportNotes}) {
			t.Errorf("readonly brief = %+v, want the readonly defaults on the flash tier", brief)
		}
	})

	t.Run("store failure after worktree creation removes the worktree again", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		w.store.FailCreate = &ports.StoreError{Kind: ports.StoreErrorIO, Message: "disk full"}

		_, err := Submit(ctx, deps, SubmitInput{Text: editBrief, Cwd: "/repo"})

		want := &AppError{Kind: AppErrorStore, StoreError: &ports.StoreError{
			Kind: ports.StoreErrorIO, Message: "disk full",
		}}
		var appErr *AppError
		if !errors.As(err, &appErr) || !reflect.DeepEqual(appErr, want) {
			t.Fatalf("Submit() error = %+v, want the store failure", err)
		}
		id := "261006-job001"
		if calls := w.git.Called("removeWorktree"); !reflect.DeepEqual(calls, [][]any{
			{"/repo", filepath.Join(w.root, "worktrees", id), "zai/" + id},
		}) {
			t.Errorf("removeWorktree calls = %v, want the worktree removed again", calls)
		}
	})

	t.Run("outside a repository, or with an unknown base, fails with the git error before creating anything", func(t *testing.T) {
		deps, w := newWorld(t, nil)

		_, outside := Submit(ctx, deps, SubmitInput{Text: editBrief, Cwd: "/elsewhere"})
		_, badBase := Submit(ctx, deps, SubmitInput{Text: submitBrief("title: Old\nbase: missing"), Cwd: "/repo"})

		wantOutside := &AppError{Kind: AppErrorGit, GitError: &ports.GitError{
			Kind: ports.GitErrorNotARepo, Path: "/elsewhere",
		}}
		wantBase := &AppError{Kind: AppErrorGit, GitError: &ports.GitError{
			Kind: ports.GitErrorBadRef, Ref: "missing",
		}}
		var appErr *AppError
		if !errors.As(outside, &appErr) || !reflect.DeepEqual(appErr, wantOutside) {
			t.Errorf("outside error = %+v, want not_a_repo /elsewhere", outside)
		}
		if !errors.As(badBase, &appErr) || !reflect.DeepEqual(appErr, wantBase) {
			t.Errorf("bad base error = %+v, want bad_ref missing", badBase)
		}
		if jobs := w.store.List(ctx, ports.ListFilter{}); len(jobs) != 0 {
			t.Errorf("jobs = %d, want none", len(jobs))
		}
		if calls := w.git.Called("addWorktree"); len(calls) != 0 {
			t.Errorf("addWorktree calls = %v, want none", calls)
		}
	})

	t.Run("a worktree that cannot be created fails the submit with nothing persisted", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		w.git.AddWorktreeErr = &ports.GitError{
			Kind: ports.GitErrorGitFailed, Command: "git worktree add", Stderr: "exists",
		}

		_, err := Submit(ctx, deps, SubmitInput{Text: editBrief, Cwd: "/repo"})

		want := &AppError{Kind: AppErrorGit, GitError: &ports.GitError{
			Kind: ports.GitErrorGitFailed, Command: "git worktree add", Stderr: "exists",
		}}
		var appErr *AppError
		if !errors.As(err, &appErr) || !reflect.DeepEqual(appErr, want) {
			t.Fatalf("Submit() error = %+v, want the git failure", err)
		}
		if jobs := w.store.List(ctx, ports.ListFilter{}); len(jobs) != 0 {
			t.Errorf("jobs = %d, want none", len(jobs))
		}
	})

	t.Run("a configured default engine the brief does not name is written in like any other override", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		omp := domain.EngineOmp
		config := enabledConfig()
		config.DefaultEngine = &omp
		w.engines.config = config

		submitted, err := Submit(ctx, deps, SubmitInput{Text: submitBrief("title: On omp"), Cwd: "/repo"})
		if err != nil {
			t.Fatal(err)
		}

		if submitted.Brief.Engine == nil || *submitted.Brief.Engine != domain.EngineToolOmp {
			t.Errorf("engine = %v, want the configured default omp", submitted.Brief.Engine)
		}
	})

	t.Run("a report schema file must exist and hold a JSON object", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		schema := filepath.Join(w.root, "schema.json")
		if err := os.WriteFile(schema, []byte(`{"type": "object"}`), 0o644); err != nil {
			t.Fatal(err)
		}
		notObject := filepath.Join(w.root, "list.json")
		if err := os.WriteFile(notObject, []byte("[1]"), 0o644); err != nil {
			t.Fatal(err)
		}

		if _, err := Submit(ctx, deps, SubmitInput{
			Text: submitBrief("title: Custom\nreport: " + schema), Cwd: "/repo",
		}); err != nil {
			t.Errorf("a schema file holding an object should pass: %v", err)
		}
		_, missing := Submit(ctx, deps, SubmitInput{
			Text: submitBrief(fmt.Sprintf("title: Custom\nreport: %s", filepath.Join(w.root, "nope.json"))),
			Cwd:  "/repo",
		})
		_, wrong := Submit(ctx, deps, SubmitInput{
			Text: submitBrief("title: Custom\nreport: " + notObject), Cwd: "/repo",
		})

		var appErr *AppError
		if !errors.As(missing, &appErr) || appErr.Kind != AppErrorBrief ||
			len(appErr.BriefErrors) != 1 || appErr.BriefErrors[0].Kind != domain.BriefErrorField ||
			appErr.BriefErrors[0].Field != "report" {
			t.Errorf("missing schema error = %+v, want a brief report field error", missing)
		}
		want := &AppError{Kind: AppErrorBrief, BriefErrors: []domain.BriefError{{
			Kind: domain.BriefErrorField, Field: "report",
			Message: notObject + " must hold a JSON schema object",
		}}}
		if !errors.As(wrong, &appErr) || !reflect.DeepEqual(appErr, want) {
			t.Errorf("non-object schema error = %+v, want the object rule", wrong)
		}
	})
}
