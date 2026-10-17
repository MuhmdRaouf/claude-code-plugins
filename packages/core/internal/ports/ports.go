// Ports: the only way app/ touches the world. Adapters implement them; tests use the fakes in
// testkit. Expected failures are error values the caller matches; adapters never decide policy.
package ports

import (
	"context"
	"strconv"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// ── git ─────────────────────────────────────────────────────────────────────────────────────

// GitErrorKind is how a git operation failed.
type GitErrorKind string

const (
	GitErrorNotARepo GitErrorKind = "not_a_repo"
	GitErrorBadRef   GitErrorKind = "bad_ref"
	// A rebase or landing found conflicts it must not settle itself.
	GitErrorConflict GitErrorKind = "conflict"
	// Uncommitted changes stand in the operation's way.
	GitErrorDirty     GitErrorKind = "dirty"
	GitErrorGitFailed GitErrorKind = "git_failed"
)

// GitError is a git failure the core reports, with what it was working on.
type GitError struct {
	Kind GitErrorKind
	// NotARepo: the directory that is not a repository.
	Path string
	// BadRef: the ref git could not resolve.
	Ref string
	// Conflict, Dirty: the paths in the way.
	Paths []string
	// GitFailed: the command line and git's own stderr.
	Command string
	Stderr  string
}

// Error returns the one-line description, the same words the app layer gives each kind.
func (e *GitError) Error() string {
	switch e.Kind {
	case GitErrorNotARepo:
		return "not a git repository: " + e.Path
	case GitErrorBadRef:
		return "unknown git ref: " + e.Ref
	case GitErrorConflict:
		return "conflict in " + strings.Join(e.Paths, ", ")
	case GitErrorDirty:
		return "uncommitted changes in the way: " + strings.Join(e.Paths, ", ")
	case GitErrorGitFailed:
		return e.Command + ": " + e.Stderr
	}
	return "git error: " + string(e.Kind)
}

// Git is the git the core drives: worktrees, snapshots and landings. Adapters implement it with
// the git CLI.
type Git interface {
	Root(ctx context.Context, cwd string) (string, error)
	Resolve(ctx context.Context, repo string, ref string) (string, error)
	CurrentBranch(ctx context.Context, repo string) (string, error)
	AddWorktree(ctx context.Context, repo, path, branch, baseSha string) error
	RemoveWorktree(ctx context.Context, repo, path, branch string) error
	// Changes in dir relative to baseSha, including untracked files (renames as delete+add).
	Changes(ctx context.Context, dir, baseSha string) (domain.ChangeSet, error)
	// `git status --porcelain=v1 -z` fingerprint, for exec/readonly unchanged checks.
	StatusFingerprint(ctx context.Context, dir string) (string, error)
	Diff(ctx context.Context, dir, baseSha string, opts DiffOptions) (string, error)
	// CommitAll stages everything in the worktree and commits on its branch. It returns the commit
	// sha. The repository's commit hooks run unless Verify is false; a failing hook is
	// GitErrorGitFailed carrying the hook's output.
	CommitAll(ctx context.Context, dir, message string, opts CommitOptions) (string, error)
	// The repository's `<provider>.trailer` setting: worked-by (the default) or none.
	Trailer(ctx context.Context, repo string) (TrailerSetting, error)
	IsAncestor(ctx context.Context, repo, ancestor, descendant string) (bool, error)
	// RebaseJobBranch rebases the job branch checked out in worktree onto onto. Conflicts
	// confined to the regenerate globs are settled by taking onto's side (the file is recreated
	// before landing anyway); any other conflict aborts the rebase and reports the unmerged paths,
	// leaving the branch exactly as it was.
	RebaseJobBranch(ctx context.Context, worktree, onto string, regenerate []string) error
	// AmendAll stages everything in dir and amends it into HEAD; it returns the amended commit's
	// sha.
	AmendAll(ctx context.Context, dir string, opts CommitOptions) (string, error)
	// AddDetachedWorktree makes a detached temporary checkout of sha at path, for verifying a
	// commit exactly as it lands.
	AddDetachedWorktree(ctx context.Context, repo, path, sha string) error
	RemoveDetachedWorktree(ctx context.Context, repo, path string) error
	// FastForward runs `git merge --ff-only <sha>` in repo, but only onto the tip the caller last
	// saw: Moved when it changed meanwhile, Dirty when uncommitted files overlap the change set.
	FastForward(ctx context.Context, repo, sha, expectedTip string) (FastForwardOutcome, error)
	// ApplyToWorkingTree applies the worktree's change set to repo's working tree without
	// committing (3-way).
	ApplyToWorkingTree(ctx context.Context, repo, worktree, baseSha string) error
}

// DiffOptions shapes a diff: Stat asks for the diffstat instead of the patch.
type DiffOptions struct {
	Stat bool
}

// CommitOptions shapes a commit: the repository's commit hooks run unless Verify is false.
type CommitOptions struct {
	Verify bool
}

// TrailerSetting is the repository's `<provider>.trailer` setting.
type TrailerSetting string

const (
	TrailerSettingWorkedBy TrailerSetting = "worked-by"
	TrailerSettingNone     TrailerSetting = "none"
)

// FastForwardOutcome is how a fast-forward landing went.
type FastForwardOutcome string

const (
	// The sha was merged.
	FastForwardLanded FastForwardOutcome = "landed"
	// The tip moved meanwhile; nothing was merged.
	FastForwardMoved FastForwardOutcome = "moved"
)

// ── gates ───────────────────────────────────────────────────────────────────────────────────

// GateRunner runs the brief's gate commands. A gate that fails is a GateResult, not an error:
// the verdict, not the runner, decides what it means.
type GateRunner interface {
	// Run runs `sh -c <run>` in cwd with a minimal env (+ passEnv), bounded output tail, kill on
	// timeout.
	Run(ctx context.Context, cwd string, gate domain.Gate, passEnv map[string]string, logPath string) domain.GateResult
}

// ── storage ─────────────────────────────────────────────────────────────────────────────────

// StoreErrorKind is how a job-store operation failed.
type StoreErrorKind string

const (
	StoreErrorNotFound StoreErrorKind = "not_found"
	// Another writer stored a new version first.
	StoreErrorVersionConflict StoreErrorKind = "version_conflict"
	// The job's driver lock is held by another live process.
	StoreErrorLocked StoreErrorKind = "locked"
	StoreErrorIO     StoreErrorKind = "io"
)

// StoreError is a job-store failure the core reports.
type StoreError struct {
	Kind StoreErrorKind
	// NotFound, VersionConflict, Locked: the job the store was working on.
	ID string
	// VersionConflict: the version the writer expected and the one actually stored.
	Expected int64
	Actual   int64
	// Locked: the pid of the driver holding the lock.
	HolderPid int64
	// IO: the filesystem's own message.
	Message string
}

// Error returns the one-line description, the same words the app layer gives each kind.
func (e *StoreError) Error() string {
	switch e.Kind {
	case StoreErrorNotFound:
		return "no job matches " + strconv.Quote(e.ID)
	case StoreErrorVersionConflict:
		return "job " + e.ID + " changed meanwhile: version " +
			strconv.FormatInt(e.Expected, 10) + " expected, " + strconv.FormatInt(e.Actual, 10) + " stored"
	case StoreErrorLocked:
		return "job " + e.ID + " is held by the driver with pid " + strconv.FormatInt(e.HolderPid, 10)
	case StoreErrorIO:
		return "state store: " + e.Message
	}
	return "store error: " + string(e.Kind)
}

// JobStore is the job records under a state root, with optimistic concurrency and the driver
// lock.
type JobStore interface {
	Create(ctx context.Context, job domain.Job) (domain.Job, error)
	Get(ctx context.Context, id string) (domain.Job, error)
	// Find resolves a unique id prefix too.
	Find(ctx context.Context, idOrPrefix string) (domain.Job, error)
	// Update writes only if the stored version equals job's; it returns the job with Version+1.
	Update(ctx context.Context, job domain.Job) (domain.Job, error)
	List(ctx context.Context, filter ListFilter) []domain.Job
	Paths(id string) domain.JobPaths
	// Lock takes the exclusive driver lock (atomic create, stale-pid reclaim) and returns the
	// release function.
	Lock(ctx context.Context, id string, pid int64) (func(), error)
}

// ListFilter narrows a job listing; its zero value lists every job.
type ListFilter struct {
	// Only jobs whose workspace root is this repository.
	RepoRoot string
}

// Semaphore is the slot queue jobs wait in before a worker starts.
type Semaphore interface {
	// Acquire enqueues the holder at its priority and waits until fewer than the capacity slots
	// are held and no older ticket of a higher priority does; it returns the release function.
	// Its error is only a cancelled context: an acquire that gives up holds nothing.
	Acquire(ctx context.Context, holder SemaphoreHolder) (func(), error)
	Held(ctx context.Context) []HeldSlot
}

// SemaphoreHolder is a job waiting for a worker slot.
type SemaphoreHolder struct {
	JobID    string
	Pid      int64
	Priority domain.Priority
}

// HeldSlot is one held worker slot: which job's driver holds it and on which process.
type HeldSlot struct {
	JobID string
	Pid   int64
}

// LimiterStore is the shared AIMD state (file-backed, locked read-modify-write).
type LimiterStore interface {
	// Capacity is the current cap, ticking it up after a quiet period (call only while waiting
	// for a slot).
	Capacity(ctx context.Context, now int64) int
	// Limit is the cap and the ceiling it grows back towards, without ticking.
	Limit(ctx context.Context, now int64) LimiterLevels
	RateLimited(ctx context.Context, now int64, options RateLimitOptions) error
	// SaveMax persists the ceiling, clamping the cap down to it but never up.
	SaveMax(ctx context.Context, max int, now int64) error
}

// LimiterLevels is the limiter's current cap and the ceiling it grows back towards.
type LimiterLevels struct {
	Cap int
	Max int
}

// RateLimitOptions shapes one rate-limit notice; its zero value is a plain notice.
type RateLimitOptions struct {
	// True when the attempt that hit the limit had already ended.
	EndedAttempt bool
}

// JobFiles is the files a job keeps beside its record and the ones it names (its report schema):
// the stop request, the driver's progress snapshot, the driver lock's holder, the engine's
// process group, the brief, the attempt logs as text, and the accepts' leftover checkouts. Bound
// to one state root.
type JobFiles interface {
	// WriteBrief writes the brief as submitted, with the job's (empty) artifacts directory beside
	// it.
	WriteBrief(ctx context.Context, paths domain.JobPaths, text string) error
	RequestStop(ctx context.Context, paths domain.JobPaths) error
	StopRequested(ctx context.Context, paths domain.JobPaths) bool
	ClearStop(ctx context.Context, paths domain.JobPaths) error
	WriteProgress(ctx context.Context, paths domain.JobPaths, attempt int64, progress domain.Progress) error
	// ReadProgress is the driver's latest snapshot for attempt; nil when there is none or it
	// belongs to another attempt.
	ReadProgress(ctx context.Context, paths domain.JobPaths, attempt int64) *domain.Progress
	// ReadText is a file's text (an attempt log, a report schema), or an error whose message says
	// why it cannot be read.
	ReadText(ctx context.Context, path string) (string, error)
	// DriverPid is the pid in the driver lock file, if one is held.
	DriverPid(ctx context.Context, paths domain.JobPaths) (int64, bool)
	// EnginePid is the running engine's group leader, if the job has one.
	EnginePid(paths domain.JobPaths) (int64, bool)
	ClearEnginePid(paths domain.JobPaths)
	// CheckoutIds is the job ids that have an accept checkout on disk.
	CheckoutIds() []string
	// CheckoutRepo is the repository a detached checkout belongs to, read from its `.git` file.
	CheckoutRepo(checkout string) (string, bool)
	Exists(path string) bool
	// RemoveTree removes a directory tree; a missing one is fine.
	RemoveTree(path string)
}

// EngineConfigStore says which delegation engines are enabled and who watches each (the state
// root's engines.json).
type EngineConfigStore interface {
	Read() domain.EngineConfig
	Write(config domain.EngineConfig)
}

// RouteSpool is what the routers wrote to Radar's spool over the last days calendar days up to
// now.
type RouteSpool interface {
	Events(now int64, days int) []domain.SpoolEvent
}

// ── small things ────────────────────────────────────────────────────────────────────────────

// Clock is the time the core sees, so tests can move it.
type Clock interface {
	Now() int64
	Iso() string
	// Sleep waits for ms to pass, returning the context's error when it is cancelled first.
	Sleep(ctx context.Context, ms int64) error
}

// Ids makes the ids jobs and their sessions are filed under.
type Ids interface {
	JobID() string
	SessionID() string
}

// ProcessControl is the process handling the core may do outside its own tree.
type ProcessControl interface {
	IsAlive(pid int64) bool
	// TerminateGroup SIGTERMs the process group, SIGKILLing it after graceMs.
	TerminateGroup(ctx context.Context, pid int64, graceMs int64) error
	// SpawnDriver starts the CLI's `drive <id>` as an orphaned process-group leader (outside the
	// caller's process tree); it returns its pid.
	SpawnDriver(jobID string) int64
}

// Output is where a command's text goes.
type Output interface {
	Line(text string)
	Error(text string)
}
