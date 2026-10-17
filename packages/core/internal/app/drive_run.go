package app

import (
	"context"
	"errors"
	"slices"
	"sync/atomic"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// progressEveryMs is how often progress reaches progress.json while the worker streams.
const progressEveryMs = 2_000

// rateLimited is the HTTP status that means budget pressure, whatever the wire carries it.
const rateLimited = 429

// AttemptRun is the attempt as it ran: outcome, usage, report, endedAt, and the session/prompt
// actually used.
type AttemptRun struct {
	Attempt domain.Attempt
	Outcome domain.WorkerOutcome
	// Failure is set when the worker could not be started at all (retrying will not help).
	Failure *AppError
}

// RunAttempt runs the worker for attempt. A fix attempt whose session cannot be resumed is re-run
// once in a new session with the prompt made self-contained.
func RunAttempt(ctx context.Context, deps Deps, job domain.Job, attempt domain.Attempt, stop *StopWatch) (AttemptRun, error) {
	contract, err := ReportContract(ctx, deps.Files, job.Brief.Report)
	if err != nil {
		return notStarted(deps, attempt, err.Error(), &AppError{
			Kind: AppErrorBrief,
			BriefErrors: []domain.BriefError{
				{Kind: domain.BriefErrorField, Field: "report", Message: err.Error()},
			},
		}), nil
	}
	resume := ResumesSession(attempt)
	// A worker with no session of its own (sessionKey "none") cannot resume anything: run the fix
	// attempt as a self-contained fresh session instead of asking for a resume it must refuse.
	if resume && deps.Worker.Caps().SessionKey == ports.SessionKeyNone {
		fresh := selfContained(deps, job, attempt)
		run, err := runSession(ctx, deps, job, fresh, contract, stop, false)
		if err != nil {
			return AttemptRun{}, err
		}
		return finished(deps, fresh, run), nil
	}
	first, err := runSession(ctx, deps, job, attempt, contract, stop, resume)
	if err != nil {
		return AttemptRun{}, err
	}
	if !(resume && first.startFailure == nil && first.sessionMissing) {
		return finished(deps, attempt, first), nil
	}
	fresh := selfContained(deps, job, attempt)
	second, err := runSession(ctx, deps, job, fresh, contract, stop, false)
	if err != nil {
		return AttemptRun{}, err
	}
	return finished(deps, fresh, second), nil
}

// selfContained is the attempt re-run in a new session: the prompt retells everything the lost
// session knew, under a fresh key.
func selfContained(deps Deps, job domain.Job, attempt domain.Attempt) domain.Attempt {
	fresh := attempt
	fresh.Prompt = domain.SelfContainedPrompt(
		job.Brief,
		job.Attempts[:attempt.N-1],
		attempt.Prompt,
		job.Workspace.ArtifactsDir,
		deps.Provider,
	)
	fresh.SessionID = deps.Ids.SessionID()
	return fresh
}

// sessionRun is a session's result, and whether the worker found no session to resume; a start
// failure instead of a result when the worker could not start at all.
type sessionRun struct {
	startFailure   *ports.WorkerError
	result         domain.WorkerResult
	sessionMissing bool
}

// finished is the attempt as it ran one session.
func finished(deps Deps, attempt domain.Attempt, run sessionRun) AttemptRun {
	if run.startFailure != nil {
		return notStarted(deps, attempt, DescribeWorkerError(deps.Provider, *run.startFailure),
			&AppError{Kind: AppErrorWorker, WorkerError: run.startFailure})
	}
	stored := attempt
	if run.result.SessionID != nil {
		stored.SessionID = *run.result.SessionID
	}
	endedAt := deps.Clock.Iso()
	stored.EndedAt = &endedAt
	stored.Outcome = &run.result.Outcome
	stored.Usage = &run.result.Usage
	stored.Report = run.result.Report
	return AttemptRun{Attempt: stored, Outcome: run.result.Outcome}
}

// notStarted is the attempt the worker never ran: crashed on the failure's own message.
func notStarted(deps Deps, attempt domain.Attempt, message string, failure *AppError) AttemptRun {
	outcome := domain.WorkerOutcome{Kind: domain.WorkerOutcomeCrashed, ExitCode: nil, Signal: nil, StderrTail: message}
	stored := attempt
	endedAt := deps.Clock.Iso()
	stored.EndedAt = &endedAt
	stored.Outcome = &outcome
	return AttemptRun{Attempt: stored, Outcome: outcome, Failure: failure}
}

// runSession starts the worker on the attempt's spec, folds its stream and waits for its exit.
func runSession(ctx context.Context, deps Deps, job domain.Job, attempt domain.Attempt,
	contract ports.ReportContract, stop *StopWatch, resume bool) (sessionRun, error) {
	started, err := deps.Worker.Start(ctx, workerSpec(deps, job, attempt, contract, resume))
	if err != nil {
		workerErr := asWorkerError(err)
		if workerErr == nil {
			return sessionRun{}, err
		}
		return sessionRun{startFailure: workerErr}, nil
	}
	run := started
	// However the worker ends after a stop request, the attempt was stopped.
	var requested atomic.Bool
	detached := make(chan struct{})
	interrupt := func() {
		requested.Store(true)
		// The interrupt asks the worker to stop itself; its own failure is not the run's.
		_ = run.Interrupt(context.WithoutCancel(ctx), ports.InterruptStopped)
	}
	if stop.Ctx.Err() != nil {
		interrupt()
	} else {
		go func() {
			select {
			case <-stop.Ctx.Done():
				interrupt()
			case <-detached:
			}
		}()
	}
	defer close(detached)
	kept, err := follow(ctx, deps, job, attempt.N, run)
	if err != nil {
		return sessionRun{}, err
	}
	exit := run.Wait()
	forced := exit.Forced
	if requested.Load() {
		stopped := domain.ForcedStopped
		forced = &stopped
	}
	result := domain.FinalizeWorker(kept, domain.WorkerExit{
		Code: exit.Code, Signal: exit.Signal, StderrTail: exit.StderrTail,
	}, forced)
	return sessionRun{result: result, sessionMissing: exit.SessionMissing}, nil
}

// follow folds the stream into progress (persisted at most every 2 s, and once at the end),
// reports every 429 retry to the limiter, and keeps only the events FinalizeWorker reads (a long
// run streams many thousands of deltas). An engine-keyed session's `session` event is kept too:
// its id is the one a later attempt resumes.
func follow(ctx context.Context, deps Deps, job domain.Job, n int64, run ports.WorkerRun) ([]domain.WorkerEvent, error) {
	paths := deps.Store.Paths(job.ID)
	kept := []domain.WorkerEvent{}
	progress := domain.INITIAL_PROGRESS
	engineSessions := deps.Worker.Caps().SessionKey == ports.SessionKeyEngine
	var savedAt int64
	saved := false
	for event := range run.Events() {
		progress = domain.ReduceProgress(progress, event)
		switch {
		case event.Kind == domain.WorkerEventInit,
			event.Kind == domain.WorkerEventAPIRetry,
			event.Kind == domain.WorkerEventResult,
			event.Kind == domain.WorkerEventSession && engineSessions:
			kept = append(kept, event)
		}
		if event.Kind == domain.WorkerEventAPIRetry && event.Status != nil && *event.Status == rateLimited {
			if err := deps.Limiter.RateLimited(ctx, deps.Clock.Now(), ports.RateLimitOptions{}); err != nil {
				return nil, err
			}
		}
		if !saved || deps.Clock.Now()-savedAt >= progressEveryMs {
			saved, savedAt = true, deps.Clock.Now()
			if err := deps.Files.WriteProgress(ctx, paths, n, progress); err != nil {
				return nil, err
			}
		}
	}
	if err := deps.Files.WriteProgress(ctx, paths, n, progress); err != nil {
		return nil, err
	}
	return kept, nil
}

// workerSpec is everything the adapter needs to start one run of the worker.
func workerSpec(deps Deps, job domain.Job, attempt domain.Attempt, contract ports.ReportContract, resume bool) ports.WorkerSpec {
	brief, workspace := job.Brief, job.Workspace
	spec := ports.WorkerSpec{
		Cwd:     WorkspaceDir(job),
		Model:   deps.Provider.Catalog[brief.Model],
		Access:  accessOf(brief.Mode),
		Prompt:  attempt.Prompt,
		Session: ports.WorkerSession{Kind: ports.SessionKindNew, Key: attempt.SessionID},
		Report:  contract,
		AddDirs: brief.AddDirs,
		// Honoured only when Caps().Budget; the spec carries it either way.
		BudgetUSD: brief.BudgetUSD,
		PassEnv:   PassEnv(deps, job),
		TimeoutMs: brief.TimeoutMs,
		LogPath:   deps.Store.Paths(job.ID).AttemptLog(int(attempt.N)),
	}
	if brief.Effort != nil {
		spec.Effort = brief.Effort
	}
	if resume {
		spec.Session.Kind = ports.SessionKindResume
	}
	// exec writes its outputs to the artifacts dir, outside the repository it runs in.
	if brief.Mode == domain.ModeExec {
		spec.AddDirs = append(slices.Clone(brief.AddDirs), workspace.ArtifactsDir)
	}
	return spec
}

// accessOf is what the worker may do to the workspace: brief mode edit → write, exec → exec,
// readonly → readonly.
func accessOf(mode domain.Mode) ports.Access {
	switch mode {
	case domain.ModeExec:
		return ports.AccessExec
	case domain.ModeReadonly:
		return ports.AccessReadonly
	default:
		return ports.AccessWrite
	}
}

// WorkspaceDir is where the worker and the gates run: the job's worktree (edit) or the repository
// itself.
func WorkspaceDir(job domain.Job) string {
	if job.Workspace.Worktree != nil {
		return *job.Workspace.Worktree
	}
	return job.Workspace.RepoRoot
}

// PassEnv is the brief's env names with their values from the orchestrator's environment (never
// persisted), plus the provider's artifacts variable.
func PassEnv(deps Deps, job domain.Job) map[string]string {
	named := make(map[string]string, len(job.Brief.Env)+1)
	for _, name := range job.Brief.Env {
		if value, ok := deps.Env[name]; ok {
			named[name] = value
		}
	}
	named[deps.Provider.ArtifactsEnv] = job.Workspace.ArtifactsDir
	return named
}

// asWorkerError pulls the worker error out of a Worker failure; nil when it is not one.
func asWorkerError(err error) *ports.WorkerError {
	var workerErr *ports.WorkerError
	if errors.As(err, &workerErr) {
		return workerErr
	}
	return nil
}
