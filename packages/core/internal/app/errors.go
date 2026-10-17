package app

import (
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// AppErrorKind is which use-case failure happened; each kind carries the fields its own cases read.
type AppErrorKind string

const (
	AppErrorBrief           AppErrorKind = "brief"
	AppErrorBriefUnreadable AppErrorKind = "brief_unreadable"
	AppErrorMissingEnv      AppErrorKind = "missing_env"
	AppErrorWrongState      AppErrorKind = "wrong_state"
	AppErrorLifecycle       AppErrorKind = "lifecycle"
	AppErrorGit             AppErrorKind = "git"
	AppErrorStore           AppErrorKind = "store"
	AppErrorWorker          AppErrorKind = "worker"
	AppErrorEmptyFeedback   AppErrorKind = "empty_feedback"
	// Accept without force on a job whose last verdict is not pass.
	AppErrorNotPass AppErrorKind = "not_pass"
	// Accept could not rebase the job branch onto the branch tip; nothing was applied.
	AppErrorLandConflict AppErrorKind = "land_conflict"
	// Accept could not verify the exact commit to land in a fresh checkout; nothing was applied.
	AppErrorLandVerifyFailed AppErrorKind = "land_verify_failed"
	// The job asks for a delegation engine its setup command has not enabled.
	AppErrorEngineNotEnabled AppErrorKind = "engine_not_enabled"
)

// AppError is a use-case failure. Kind picks the variant; only that variant's fields are set. The
// one-line texts live in the CLI's error rendering, not here.
type AppError struct {
	Kind AppErrorKind
	// Brief: every field error, all at once.
	BriefErrors []domain.BriefError
	// BriefUnreadable.
	Path    string
	Message string
	// MissingEnv: the names that are not set.
	Names []string
	// WrongState: the job, the state it is in, and the ones the step needed.
	ID      string
	State   domain.JobState
	Allowed []domain.JobState
	// Lifecycle: the state and the event that state does not accept.
	LifecycleError domain.LifecycleError
	// Git, Store, Worker: the port's own error.
	GitError    *ports.GitError
	StoreError  *ports.StoreError
	WorkerError *ports.WorkerError
	// NotPass: the job and its last verdict (nil: no verdict at all).
	Verdict *domain.Verdict
	// LandConflict: the paths in conflict.
	Paths []string
	// LandVerifyFailed: the command that failed and its output's tail.
	Command string
	Tail    string
	// EngineNotEnabled: the engine the job asked for.
	Engine domain.EngineTool
}

func (e *AppError) Error() string { return string(e.Kind) }

// DescribeWorkerError is one line for a worker that could not start; the key itself never appears.
func DescribeWorkerError(provider domain.Provider, err ports.WorkerError) string {
	switch err.Kind {
	case ports.WorkerErrorNoKey:
		return err.Message
	case ports.WorkerErrorInsecureKeyFile:
		return err.Label + " " + err.Path + " has mode " + err.Mode + ": run chmod 600 on it"
	case ports.WorkerErrorSpawnFailed:
		return "cannot start " + provider.WorkerLabel + ": " + err.Message
	case ports.WorkerErrorProtocol:
		return provider.WorkerLabel + " does not speak the expected protocol: " + err.Message
	case ports.WorkerErrorUnsupported:
		return provider.WorkerLabel + " cannot do this: " + err.Message
	}
	return provider.WorkerLabel + " error: " + string(err.Kind)
}

// DescribeGitError is one line for a git failure.
func DescribeGitError(err ports.GitError) string {
	switch err.Kind {
	case ports.GitErrorNotARepo:
		return "not a git repository: " + err.Path
	case ports.GitErrorBadRef:
		return "unknown git ref: " + err.Ref
	case ports.GitErrorConflict:
		return "conflict in " + strings.Join(err.Paths, ", ")
	case ports.GitErrorDirty:
		return "uncommitted changes in the way: " + strings.Join(err.Paths, ", ")
	case ports.GitErrorGitFailed:
		return err.Command + ": " + err.Stderr
	}
	return "git error: " + string(err.Kind)
}
