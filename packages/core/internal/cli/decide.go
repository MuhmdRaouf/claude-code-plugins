package cli

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/render"
)

// decideShortSha is how much of a landing commit's sha the report names.
const decideShortSha = 12

// decideStoppable are the states `stop` may act on.
var decideStoppable = map[domain.JobState]bool{
	domain.JobStateQueued:    true,
	domain.JobStateRunning:   true,
	domain.JobStateVerifying: true,
}

// AcceptCommand is `accept`: land the reviewed work.
type AcceptCommand struct{}

var _ Command = AcceptCommand{}

func (AcceptCommand) Name() string { return "accept" }
func (AcceptCommand) Synopsis() []string {
	return []string{"accept <id> [--no-commit] [--force] [--no-verify] [--json]"}
}
func (AcceptCommand) Options() map[string]OptionSpec {
	return map[string]OptionSpec{
		"no-commit": {Type: OptionTypeBoolean},
		"force":     {Type: OptionTypeBoolean},
		"no-verify": {Type: OptionTypeBoolean},
	}
}
func (AcceptCommand) Hidden() bool { return false }

func (AcceptCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	positionals := call.Positionals()
	if len(positionals) == 0 {
		return call.Usage("accept needs a job id"), nil
	}
	mode := app.AcceptModeCommit
	if call.Flag("no-commit") {
		mode = app.AcceptModeNoCommit
	}
	accepted, err := app.Accept(ctx, call.Deps(), positionals[0], app.AcceptOptions{
		Mode:   mode,
		Force:  call.Flag("force"),
		Verify: !call.Flag("no-verify"),
	})
	if err != nil {
		return acceptFailed(call, err), nil
	}
	if call.Flag("json") {
		_ = call.JSON(accepted)
	} else {
		call.Deps().Out.Line(acceptLine(call.Deps().Provider, accepted))
	}
	return ExitOK, nil
}

// acceptLine says where the accepted work landed.
func acceptLine(provider domain.Provider, job domain.Job) string {
	head := provider.Name + " job " + job.ID + " accepted"
	if job.Brief.Mode != domain.ModeEdit {
		return head + " (" + string(job.Brief.Mode) + ": nothing to merge)"
	}
	commit := "(none)"
	if job.Decision != nil && job.Decision.Commit != nil {
		commit = *job.Decision.Commit
	}
	if commit == "(none)" {
		return head + ": applied to the working tree of " + job.Workspace.RepoRoot + ", not committed"
	}
	short := commit
	if len(short) > decideShortSha {
		short = short[:decideShortSha]
	}
	return head + ": commit " + short + " on the current branch of " + job.Workspace.RepoRoot
}

// acceptFailed reports a landing that did not happen. Git failures name the way forward: nothing
// was applied, so the job still awaits review.
func acceptFailed(call Invocation, err error) ExitCode {
	deps := call.Deps()
	provider := deps.Provider
	var appErr *app.AppError
	isApp := errors.As(err, &appErr)
	message := provider.Name + ": " + err.Error()
	code := ExitUnexpected
	if isApp {
		message = provider.Name + ": " + DescribeError(provider, appErr)
		code = ExitFor(appErr)
	}
	var gitErr *ports.GitError
	if isApp && appErr.Kind == app.AppErrorGit {
		gitErr = appErr.GitError
	}
	hasGit := gitErr != nil
	switch {
	case isApp && appErr.Kind == app.AppErrorLandConflict:
		deps.Out.Error(message + ": " + render.ConflictStep(provider))
	case isApp && appErr.Kind == app.AppErrorLandVerifyFailed:
		deps.Out.Error(message + ": nothing was applied. " + provider.Slash +
			"review returns the job with the failing output as feedback.")
		for _, line := range strings.Split(appErr.Tail, "\n") {
			deps.Out.Error("  " + line)
		}
	case isApp && appErr.Kind != app.AppErrorGit:
		deps.Out.Error(message)
	case hasGit && gitErr.Kind == ports.GitErrorConflict:
		deps.Out.Error(message + ": " + render.ConflictStep(provider))
	case hasGit && gitErr.Kind == ports.GitErrorDirty:
		deps.Out.Error(message + ": nothing was applied. Commit or stash them, then accept again.")
	case hasGit && gitErr.Kind == ports.GitErrorGitFailed && strings.HasPrefix(gitErr.Command, "git commit"):
		deps.Out.Error(message)
		deps.Out.Error(provider.Name + ": the job still awaits review. Fix what the commit hook reports, then accept it again.")
	default:
		deps.Out.Error(message)
	}
	return code
}

// ReturnCommand is `return`: send the job back with feedback.
type ReturnCommand struct{}

var _ Command = ReturnCommand{}

func (ReturnCommand) Name() string       { return "return" }
func (ReturnCommand) Synopsis() []string { return []string{"return <id> <feedback…> [--json]"} }
func (ReturnCommand) Options() map[string]OptionSpec {
	return map[string]OptionSpec{}
}
func (ReturnCommand) Hidden() bool { return false }

func (ReturnCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	positionals := call.Positionals()
	if len(positionals) == 0 {
		return call.Usage("return needs a job id"), nil
	}
	if strings.TrimSpace(strings.Join(positionals[1:], "")) == "" {
		return call.Usage("return needs feedback for the worker"), nil
	}
	deps := call.Deps()
	job, err := app.ReturnForFix(ctx, deps, positionals[0], strings.Join(positionals[1:], " "))
	if err != nil {
		return appFail(call, err)
	}
	deps.Process.SpawnDriver(job.ID)
	if call.Flag("json") {
		_ = call.JSON(job)
	} else {
		deps.Out.Line(deps.Provider.Name + " job " + job.ID + " returned with feedback: attempt " +
			strconv.Itoa(len(job.Attempts)) + " runs detached. " + deps.Provider.Slash + "review " + job.ID +
			" once it awaits review again.")
	}
	return ExitOK, nil
}

// DiscardCommand is `discard`: drop the job and its work.
type DiscardCommand struct{}

var _ Command = DiscardCommand{}

func (DiscardCommand) Name() string       { return "discard" }
func (DiscardCommand) Synopsis() []string { return []string{"discard <id> [--reason <text>] [--json]"} }
func (DiscardCommand) Options() map[string]OptionSpec {
	return map[string]OptionSpec{"reason": {Type: OptionTypeString}}
}
func (DiscardCommand) Hidden() bool { return false }

func (DiscardCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	positionals := call.Positionals()
	if len(positionals) == 0 {
		return call.Usage("discard needs a job id"), nil
	}
	var reason *string
	if text := call.Text("reason"); text != nil {
		trimmed := strings.TrimSpace(*text)
		if trimmed != "" {
			reason = &trimmed
		}
	}
	deps := call.Deps()
	job, err := app.Discard(ctx, deps, positionals[0], reason)
	if err != nil {
		return appFail(call, err)
	}
	if call.Flag("json") {
		_ = call.JSON(job)
	} else {
		line := deps.Provider.Name + " job " + job.ID + " discarded"
		if reason != nil {
			line += ": " + *reason
		}
		deps.Out.Line(line)
	}
	return ExitOK, nil
}

// StopCommand is `stop`: stop a running job (or every stoppable one with --all).
type StopCommand struct{}

var _ Command = StopCommand{}

func (StopCommand) Name() string       { return "stop" }
func (StopCommand) Synopsis() []string { return []string{"stop <id|--all> [--json]"} }
func (StopCommand) Options() map[string]OptionSpec {
	return map[string]OptionSpec{"all": {Type: OptionTypeBoolean}}
}
func (StopCommand) Hidden() bool { return false }

func (StopCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	ids := call.Positionals()
	if call.Flag("all") {
		ids = stoppableIDs(ctx, call)
	}
	if len(ids) == 0 && !call.Flag("all") {
		return call.Usage("stop needs a job id or --all"), nil
	}
	deps := call.Deps()
	stopped, code := stopAll(ctx, call, ids)
	if call.Flag("json") {
		_ = call.JSON(stopped)
	} else if len(ids) == 0 {
		deps.Out.Line(deps.Provider.Name + ": no queued or running job to stop")
	} else {
		for _, job := range stopped {
			deps.Out.Line(stoppedLine(deps.Provider, job))
		}
	}
	return code, nil
}

// stopAll stops each job in turn; a failure is reported and the rest still stop. The first
// failure sets the exit code.
func stopAll(ctx context.Context, call Invocation, ids []string) ([]domain.Job, ExitCode) {
	stopped := make([]domain.Job, 0, len(ids))
	code := ExitOK
	for _, id := range ids {
		job, err := app.Stop(ctx, call.Deps(), id)
		if err != nil {
			if failed := stopFailure(call, err); code == ExitOK {
				code = failed
			}
			continue
		}
		stopped = append(stopped, job)
	}
	return stopped, code
}

// stopFailure reports one stop that did not happen and returns its exit code.
func stopFailure(call Invocation, err error) ExitCode {
	var appErr *app.AppError
	if errors.As(err, &appErr) {
		return FailWith(call.Deps(), appErr)
	}
	call.Deps().Out.Error(call.Deps().Provider.Name + ": unexpected error: " + err.Error())
	return ExitUnexpected
}

// stoppableIDs is every job of this repository still waiting to run or be verified.
func stoppableIDs(ctx context.Context, call Invocation) []string {
	filter := ports.ListFilter{}
	if root, ok := RepoOf(ctx, call.Deps(), call.Cwd()); ok {
		filter.RepoRoot = root
	}
	ids := []string{}
	for _, job := range call.Deps().Store.List(ctx, filter) {
		if decideStoppable[job.State] {
			ids = append(ids, job.ID)
		}
	}
	return ids
}

// stoppedLine says what stopping left the job as.
func stoppedLine(provider domain.Provider, job domain.Job) string {
	if job.State == domain.JobStateAwaitingReview {
		return provider.Name + " job " + job.ID + " stopped: awaiting review"
	}
	return provider.Name + " job " + job.ID + ": stopping; it will wait for your review as \"stopped\""
}
