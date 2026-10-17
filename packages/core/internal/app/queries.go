package app

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// The board and usage queries: read-only views over the store, with the live state folded in from
// the files the drivers write.

// BoardRow is one job on the board.
type BoardRow struct {
	Job domain.Job `json:"job"`
	// Progress of the running attempt, folded from its log or the driver's snapshot.
	Progress *domain.Progress `json:"progress,omitempty"`
	// Live says a live process holds the driver lock.
	Live bool `json:"live"`
}

// Scope narrows a listing to one repository unless All.
type Scope struct {
	// RepoRoot lists only that repository's jobs.
	RepoRoot *string
	All      bool
}

// jobsIn is the store's listing for a scope.
func jobsIn(ctx context.Context, deps Deps, scope Scope) []domain.Job {
	if scope.All || scope.RepoRoot == nil {
		return deps.Store.List(ctx, ports.ListFilter{})
	}
	return deps.Store.List(ctx, ports.ListFilter{RepoRoot: *scope.RepoRoot})
}

// Board is the jobs (repo-filtered unless all), newest first; progress folded from the latest
// attempt log for running jobs. A job whose state is running/verifying but whose driver is dead is
// reported Live=false (the board shows it as stale).
func Board(ctx context.Context, deps Deps, opts Scope) []BoardRow {
	jobs := jobsIn(ctx, deps, opts)
	rows := make([]BoardRow, 0, len(jobs))
	for _, job := range jobs {
		rows = append(rows, rowOf(ctx, deps, job))
	}
	return rows
}

// JobRow is one job's board row, found by id or unique prefix.
func JobRow(ctx context.Context, deps Deps, id string) (BoardRow, error) {
	found, err := deps.Store.Find(ctx, id)
	if err != nil {
		return BoardRow{}, storeLookupError(err)
	}
	return rowOf(ctx, deps, found), nil
}

// rowOf is the job's row: liveness from the driver lock, progress for a running attempt.
func rowOf(ctx context.Context, deps Deps, job domain.Job) BoardRow {
	pid, held := deps.Files.DriverPid(ctx, deps.Store.Paths(job.ID))
	live := held && deps.Process.IsAlive(pid)
	row := BoardRow{Job: job, Live: live}
	if job.State == domain.JobStateRunning {
		row.Progress = runningProgress(ctx, deps, job)
	}
	return row
}

// runningProgress is the driver's snapshot when it has one for the running attempt, else the
// attempt's log folded.
func runningProgress(ctx context.Context, deps Deps, job domain.Job) *domain.Progress {
	n := int64(len(job.Attempts))
	paths := deps.Store.Paths(job.ID)
	if snapshot := deps.Files.ReadProgress(ctx, paths, n); snapshot != nil {
		return snapshot
	}
	return foldAttemptLog(ctx, deps, paths.AttemptLog(int(n)), DepsForJob(deps, job).Worker)
}

// ReviewPacket is everything the reviewer needs; the diff comes on request, bounded to
// MaxDiffChars with a truncation marker.
type ReviewPacket struct {
	Job domain.Job `json:"job"`
	// The diffstat of the undecided worktree, always present for an edit job.
	DiffStat *string `json:"diffStat,omitempty"`
	// The full diff, only on request.
	Diff *string `json:"diff,omitempty"`
}

// ReviewOptions shapes the review packet.
type ReviewOptions struct {
	Diff         bool
	MaxDiffChars int64
}

// ReviewPacketOf is one job's review packet, found by id or unique prefix. Only an undecided edit
// job still has a worktree to diff.
func ReviewPacketOf(ctx context.Context, deps Deps, id string, opts ReviewOptions) (ReviewPacket, error) {
	found, err := deps.Store.Find(ctx, id)
	if err != nil {
		return ReviewPacket{}, storeLookupError(err)
	}
	job := found
	if job.Workspace.Worktree == nil || job.State == domain.JobStateAccepted ||
		job.State == domain.JobStateDiscarded {
		return ReviewPacket{Job: job}, nil
	}
	stat, err := deps.Git.Diff(ctx, *job.Workspace.Worktree, job.Workspace.BaseSha, ports.DiffOptions{Stat: true})
	if err != nil {
		return ReviewPacket{}, &AppError{Kind: AppErrorGit, GitError: asGitError(err)}
	}
	if !opts.Diff {
		return ReviewPacket{Job: job, DiffStat: &stat}, nil
	}
	diff, err := deps.Git.Diff(ctx, *job.Workspace.Worktree, job.Workspace.BaseSha, ports.DiffOptions{})
	if err != nil {
		return ReviewPacket{}, &AppError{Kind: AppErrorGit, GitError: asGitError(err)}
	}
	boundedDiff := bounded(diff, opts.MaxDiffChars)
	return ReviewPacket{Job: job, DiffStat: &stat, Diff: &boundedDiff}, nil
}

// bounded cuts the diff to max UTF-16 code units — the unit JS length and slice count — with a
// marker saying how much is left out.
func bounded(text string, max int64) string {
	units := utf16.Encode([]rune(text))
	if int64(len(units)) <= max {
		return text
	}
	cut := string(utf16.Decode(units[:max]))
	return cut + "\n[diff truncated: " +
		strconv.FormatInt(int64(len(units))-max, 10) + " more characters]\n"
}

// Usage is the claude engine's per-tier ledger; jobs on a delegation engine are EngineUsage's.
func Usage(ctx context.Context, deps Deps, opts Scope) []domain.TierUsage {
	jobs := jobsIn(ctx, deps, opts)
	claude := make([]domain.Job, 0, len(jobs))
	for _, job := range jobs {
		if JobEngine(job) == domain.EngineClaude {
			claude = append(claude, job)
		}
	}
	return domain.SummarizeUsage(claude)
}

// EngineUsage is per delegation engine: its jobs and what their attempts used.
func EngineUsage(ctx context.Context, deps Deps, opts Scope) []domain.EngineUsage {
	return domain.SummarizeEngines(jobsIn(ctx, deps, opts))
}

// foldAttemptLog is progress folded from an attempt's raw log, read by the worker that wrote it;
// nil when there is no log yet.
func foldAttemptLog(ctx context.Context, deps Deps, path string, worker ports.Worker) *domain.Progress {
	text, err := deps.Files.ReadText(ctx, path)
	if err != nil {
		return nil
	}
	progress := domain.INITIAL_PROGRESS
	for _, line := range strings.Split(text, "\n") {
		for _, event := range worker.ParseLine(line) {
			progress = domain.ReduceProgress(progress, event)
		}
	}
	return &progress
}

// storeLookupError is a failed id lookup: the store's own error wrapped for the CLI, or the
// error as it was (a store that fails outside its contract is an unexpected failure, never a
// mislabelled store error).
func storeLookupError(err error) error {
	if storeErr := asStoreError(err); storeErr != nil {
		return &AppError{Kind: AppErrorStore, StoreError: storeErr}
	}
	return err
}

// asGitError pulls the git error out of a Git failure; nil when it is not one.
func asGitError(err error) *ports.GitError {
	var gitErr *ports.GitError
	if errors.As(err, &gitErr) {
		return gitErr
	}
	return nil
}
