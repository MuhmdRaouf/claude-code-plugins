package ports_test

import (
	"context"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// This file pins the surface: a tiny implementer of every interface, so a signature change
// breaks the build here first.

type fakeClock struct{ now int64 }

func (c fakeClock) Now() int64 { return c.now }
func (c fakeClock) Iso() string {
	return "2026-10-13T00:00:00.000Z"
}
func (c fakeClock) Sleep(ctx context.Context, ms int64) error { return ctx.Err() }

var _ ports.Clock = fakeClock{}

type fakeIds struct{}

func (fakeIds) JobID() string     { return "job-1" }
func (fakeIds) SessionID() string { return "session-1" }

var _ ports.Ids = fakeIds{}

type fakeOutput struct{ lines []string }

func (o *fakeOutput) Line(text string)  { o.lines = append(o.lines, text) }
func (o *fakeOutput) Error(text string) { o.lines = append(o.lines, text) }

var _ ports.Output = &fakeOutput{}

type fakeProcess struct{}

func (fakeProcess) IsAlive(pid int64) bool { return pid > 1 }
func (fakeProcess) TerminateGroup(ctx context.Context, pid int64, graceMs int64) error {
	return nil
}
func (fakeProcess) SpawnDriver(jobID string) int64 { return 4242 }

var _ ports.ProcessControl = fakeProcess{}

type fakeGit struct{ root string }

func (g fakeGit) Root(ctx context.Context, cwd string) (string, error) { return g.root, nil }
func (fakeGit) Resolve(ctx context.Context, repo string, ref string) (string, error) {
	return "sha", nil
}
func (fakeGit) CurrentBranch(ctx context.Context, repo string) (string, error) {
	return "main", nil
}
func (fakeGit) AddWorktree(ctx context.Context, repo, path, branch, baseSha string) error {
	return nil
}
func (fakeGit) RemoveWorktree(ctx context.Context, repo, path, branch string) error {
	return nil
}
func (fakeGit) Changes(ctx context.Context, dir, baseSha string) (domain.ChangeSet, error) {
	return domain.ChangeSet{}, nil
}
func (fakeGit) StatusFingerprint(ctx context.Context, dir string) (string, error) {
	return "fingerprint", nil
}
func (fakeGit) Diff(ctx context.Context, dir, baseSha string, opts ports.DiffOptions) (string, error) {
	return "", nil
}
func (fakeGit) CommitAll(ctx context.Context, dir, message string, opts ports.CommitOptions) (string, error) {
	return "sha", nil
}
func (fakeGit) Trailer(ctx context.Context, repo string) (ports.TrailerSetting, error) {
	return ports.TrailerSettingWorkedBy, nil
}
func (fakeGit) IsAncestor(ctx context.Context, repo, ancestor, descendant string) (bool, error) {
	return true, nil
}
func (fakeGit) RebaseJobBranch(ctx context.Context, worktree, onto string, regenerate []string) error {
	return nil
}
func (fakeGit) AmendAll(ctx context.Context, dir string, opts ports.CommitOptions) (string, error) {
	return "sha", nil
}
func (fakeGit) AddDetachedWorktree(ctx context.Context, repo, path, sha string) error {
	return nil
}
func (fakeGit) RemoveDetachedWorktree(ctx context.Context, repo, path string) error {
	return nil
}
func (fakeGit) FastForward(ctx context.Context, repo, sha, expectedTip string) (ports.FastForwardOutcome, error) {
	return ports.FastForwardLanded, nil
}
func (fakeGit) ApplyToWorkingTree(ctx context.Context, repo, worktree, baseSha string) error {
	return nil
}

var _ ports.Git = fakeGit{}

type fakeGateRunner struct{}

func (fakeGateRunner) Run(ctx context.Context, cwd string, gate domain.Gate, passEnv map[string]string, logPath string) domain.GateResult {
	return domain.GateResult{Run: gate.Run}
}

var _ ports.GateRunner = fakeGateRunner{}

type fakeJobStore struct{ job domain.Job }

func (s fakeJobStore) Create(ctx context.Context, job domain.Job) (domain.Job, error) {
	return job, nil
}
func (s fakeJobStore) Get(ctx context.Context, id string) (domain.Job, error) {
	return s.job, nil
}
func (s fakeJobStore) Find(ctx context.Context, idOrPrefix string) (domain.Job, error) {
	return s.job, nil
}
func (s fakeJobStore) Update(ctx context.Context, job domain.Job) (domain.Job, error) {
	return job, nil
}
func (s fakeJobStore) List(ctx context.Context, filter ports.ListFilter) []domain.Job {
	return []domain.Job{s.job}
}
func (s fakeJobStore) Paths(id string) domain.JobPaths { return domain.JobPaths{} }
func (s fakeJobStore) Lock(ctx context.Context, id string, pid int64) (func(), error) {
	return func() {}, nil
}

var _ ports.JobStore = fakeJobStore{}

type fakeSemaphore struct{}

func (fakeSemaphore) Acquire(ctx context.Context, holder ports.SemaphoreHolder) (func(), error) {
	return func() {}, ctx.Err()
}
func (fakeSemaphore) Held(ctx context.Context) []ports.HeldSlot {
	return []ports.HeldSlot{{JobID: "job-1", Pid: 42}}
}

var _ ports.Semaphore = fakeSemaphore{}

type fakeLimiter struct{}

func (fakeLimiter) Capacity(ctx context.Context, now int64) int { return 1 }
func (fakeLimiter) Limit(ctx context.Context, now int64) ports.LimiterLevels {
	return ports.LimiterLevels{Cap: 1, Max: 16}
}
func (fakeLimiter) RateLimited(ctx context.Context, now int64, options ports.RateLimitOptions) error {
	return nil
}
func (fakeLimiter) SaveMax(ctx context.Context, max int, now int64) error { return nil }

var _ ports.LimiterStore = fakeLimiter{}

type fakeJobFiles struct{}

func (fakeJobFiles) WriteBrief(ctx context.Context, paths domain.JobPaths, text string) error {
	return nil
}
func (fakeJobFiles) RequestStop(ctx context.Context, paths domain.JobPaths) error  { return nil }
func (fakeJobFiles) StopRequested(ctx context.Context, paths domain.JobPaths) bool { return false }
func (fakeJobFiles) ClearStop(ctx context.Context, paths domain.JobPaths) error    { return nil }
func (fakeJobFiles) WriteProgress(ctx context.Context, paths domain.JobPaths, attempt int64, progress domain.Progress) error {
	return nil
}
func (fakeJobFiles) ReadProgress(ctx context.Context, paths domain.JobPaths, attempt int64) *domain.Progress {
	return nil
}
func (fakeJobFiles) ReadText(ctx context.Context, path string) (string, error) {
	return "", nil
}
func (fakeJobFiles) DriverPid(ctx context.Context, paths domain.JobPaths) (int64, bool) {
	return 42, true
}
func (fakeJobFiles) EnginePid(paths domain.JobPaths) (int64, bool) { return 0, false }
func (fakeJobFiles) ClearEnginePid(paths domain.JobPaths)          {}
func (fakeJobFiles) CheckoutIds() []string                         { return nil }
func (fakeJobFiles) CheckoutRepo(checkout string) (string, bool)   { return "", false }
func (fakeJobFiles) Exists(path string) bool                       { return false }
func (fakeJobFiles) RemoveTree(path string)                        {}

var _ ports.JobFiles = fakeJobFiles{}

type fakeEngineConfigs struct{}

func (fakeEngineConfigs) Read() domain.EngineConfig {
	return domain.EngineConfig{Engines: map[domain.EngineTool]domain.EngineSetting{}}
}
func (fakeEngineConfigs) Write(config domain.EngineConfig) {}

var _ ports.EngineConfigStore = fakeEngineConfigs{}

type fakeSpool struct{}

func (fakeSpool) Events(now int64, days int) []domain.SpoolEvent { return nil }

var _ ports.RouteSpool = fakeSpool{}

type fakeKeyStore struct{}

func (fakeKeyStore) Kind() ports.KeyStoreKind           { return ports.KeyStoreFile }
func (fakeKeyStore) Label() string                      { return "~/.zai/key" }
func (fakeKeyStore) Available(ctx context.Context) bool { return true }
func (fakeKeyStore) Get(ctx context.Context) (string, bool) {
	return "", false
}
func (fakeKeyStore) Set(ctx context.Context, key string) error { return nil }
func (fakeKeyStore) Remove(ctx context.Context) error          { return nil }

var _ ports.KeyStore = fakeKeyStore{}

type fakeKeyEntry struct{}

func (fakeKeyEntry) Store(ctx context.Context) ports.KeyStore { return fakeKeyStore{} }
func (fakeKeyEntry) Check(ctx context.Context, key string) ports.KeyVerdict {
	return ports.KeyVerdictAccepted
}
func (fakeKeyEntry) OpenPage(ctx context.Context) (string, error) {
	return "http://127.0.0.1:18787/key", nil
}
func (fakeKeyEntry) PageOpen(ctx context.Context, url string) bool { return false }
func (fakeKeyEntry) RemoveFromFile(ctx context.Context, value string) bool {
	return false
}

var _ ports.KeyEntry = fakeKeyEntry{}

type fakeRun struct{ events chan domain.WorkerEvent }

func (r fakeRun) Events() <-chan domain.WorkerEvent { return r.events }
func (fakeRun) Wait() ports.WorkerExit              { return ports.WorkerExit{} }
func (fakeRun) Interrupt(ctx context.Context, reason ports.InterruptReason) error {
	return nil
}

var _ ports.WorkerRun = fakeRun{}

type fakeWorker struct{}

func (fakeWorker) Caps() ports.WorkerCapabilities {
	return ports.WorkerCapabilities{
		WorkerTerms: domain.WorkerTerms{Efforts: []string{"high"}},
		Name:        ports.WorkerNameClaudeHeadless,
		SessionKey:  ports.SessionKeyCaller,
	}
}
func (fakeWorker) Preflight(ctx context.Context) error { return nil }
func (fakeWorker) Start(ctx context.Context, spec ports.WorkerSpec) (ports.WorkerRun, error) {
	return fakeRun{events: make(chan domain.WorkerEvent)}, nil
}
func (fakeWorker) ParseLine(line string) []domain.WorkerEvent { return nil }
func (fakeWorker) Dispose(ctx context.Context) error          { return nil }

var _ ports.Worker = fakeWorker{}

func TestGitErrorMessage(t *testing.T) {
	cases := []struct {
		name string
		err  ports.GitError
		want string
	}{
		{
			"not_a_repo",
			ports.GitError{Kind: ports.GitErrorNotARepo, Path: "/tmp/nowhere"},
			"not a git repository: /tmp/nowhere",
		},
		{
			"bad_ref",
			ports.GitError{Kind: ports.GitErrorBadRef, Ref: "nope"},
			"unknown git ref: nope",
		},
		{
			"conflict",
			ports.GitError{Kind: ports.GitErrorConflict, Paths: []string{"a.go", "b.go"}},
			"conflict in a.go, b.go",
		},
		{
			"dirty",
			ports.GitError{Kind: ports.GitErrorDirty, Paths: []string{"c.go"}},
			"uncommitted changes in the way: c.go",
		},
		{
			"git_failed",
			ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git rebase", Stderr: "boom"},
			"git rebase: boom",
		},
		{
			"unknown kind",
			ports.GitError{Kind: ports.GitErrorKind("weird")},
			"git error: weird",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.err.Error(); got != c.want {
				t.Errorf("Error() = %q, want %q", got, c.want)
			}
		})
	}
}

func TestStoreErrorMessage(t *testing.T) {
	cases := []struct {
		name string
		err  ports.StoreError
		want string
	}{
		{
			"not_found",
			ports.StoreError{Kind: ports.StoreErrorNotFound, ID: "abc"},
			`no job matches "abc"`,
		},
		{
			"version_conflict",
			ports.StoreError{Kind: ports.StoreErrorVersionConflict, ID: "abc", Expected: 3, Actual: 4},
			"job abc changed meanwhile: version 3 expected, 4 stored",
		},
		{
			"locked",
			ports.StoreError{Kind: ports.StoreErrorLocked, ID: "abc", HolderPid: 4242},
			"job abc is held by the driver with pid 4242",
		},
		{
			"io",
			ports.StoreError{Kind: ports.StoreErrorIO, Message: "disk on fire"},
			"state store: disk on fire",
		},
		{
			"unknown kind",
			ports.StoreError{Kind: ports.StoreErrorKind("weird")},
			"store error: weird",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.err.Error(); got != c.want {
				t.Errorf("Error() = %q, want %q", got, c.want)
			}
		})
	}
}

func TestWorkerErrorMessage(t *testing.T) {
	cases := []struct {
		name string
		err  ports.WorkerError
		want string
	}{
		{
			"no_key",
			ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no key in the keychain"},
			"no key in the keychain",
		},
		{
			"insecure_key_file",
			ports.WorkerError{Kind: ports.WorkerErrorInsecureKeyFile, Label: "the key file", Path: "~/.zai/key", Mode: "0644"},
			"the key file ~/.zai/key has mode 0644: run chmod 600 on it",
		},
		{
			"spawn_failed",
			ports.WorkerError{Kind: ports.WorkerErrorSpawnFailed, Message: "ENOENT"},
			"cannot start the worker: ENOENT",
		},
		{
			"protocol",
			ports.WorkerError{Kind: ports.WorkerErrorProtocol, Message: "no handshake"},
			"the worker does not speak the expected protocol: no handshake",
		},
		{
			"unsupported",
			ports.WorkerError{Kind: ports.WorkerErrorUnsupported, Message: "budget"},
			"the worker cannot do this: budget",
		},
		{
			"unknown kind",
			ports.WorkerError{Kind: ports.WorkerErrorKind("weird")},
			"worker error: weird",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.err.Error(); got != c.want {
				t.Errorf("Error() = %q, want %q", got, c.want)
			}
		})
	}
}
