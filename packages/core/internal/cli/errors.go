package cli

import (
	"strconv"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// DescribeBriefError is one line for one way a brief document failed.
func DescribeBriefError(err domain.BriefError) string {
	switch err.Kind {
	case domain.BriefErrorNoFrontMatter:
		return "no YAML front matter (start the file with ---)"
	case domain.BriefErrorYaml:
		return "YAML: " + err.Message
	case domain.BriefErrorField:
		return err.Field + ": " + err.Message
	case domain.BriefErrorEmptyBody:
		return "the body (the task) is empty"
	}
	return "brief error: " + string(err.Kind)
}

func describeStoreError(provider domain.Provider, err ports.StoreError) string {
	switch err.Kind {
	case ports.StoreErrorNotFound:
		return "no " + provider.Name + " job matches \"" + err.ID + "\" (" + provider.Slash + "board lists them)"
	case ports.StoreErrorLocked:
		return "job " + err.ID + " is held by the driver with pid " + strconv.FormatInt(err.HolderPid, 10)
	case ports.StoreErrorVersionConflict:
		return "job " + err.ID + " changed meanwhile; run the command again"
	case ports.StoreErrorIO:
		return "state store: " + err.Message
	}
	return "state store error: " + string(err.Kind)
}

// DescribeError is one line, no prefix.
func DescribeError(provider domain.Provider, err *app.AppError) string {
	switch err.Kind {
	case app.AppErrorBrief:
		lines := make([]string, 0, len(err.BriefErrors))
		for _, brief := range err.BriefErrors {
			lines = append(lines, DescribeBriefError(brief))
		}
		return "invalid brief: " + strings.Join(lines, "; ")
	case app.AppErrorBriefUnreadable:
		return "cannot read " + err.Path + ": " + err.Message
	case app.AppErrorMissingEnv:
		return "the brief's env names are not set in this environment: " + strings.Join(err.Names, ", ")
	case app.AppErrorWrongState:
		allowed := make([]string, 0, len(err.Allowed))
		for _, state := range err.Allowed {
			allowed = append(allowed, stateNoun(string(state)))
		}
		return "job " + err.ID + " " + stateWords(string(err.State)) + "; this only works on a job that " + orList(allowed)
	case app.AppErrorLifecycle:
		return "the job " + stateWords(string(err.LifecycleError.From)) + ", so it cannot be " + eventWords(string(err.LifecycleError.Event))
	case app.AppErrorGit:
		return app.DescribeGitError(*err.GitError)
	case app.AppErrorStore:
		return describeStoreError(provider, *err.StoreError)
	case app.AppErrorWorker:
		return app.DescribeWorkerError(provider, *err.WorkerError)
	case app.AppErrorEmptyFeedback:
		return "the feedback must not be empty"
	case app.AppErrorNotPass:
		verdict := "none"
		if err.Verdict != nil {
			verdict = string(*err.Verdict)
		}
		return "job " + err.ID + " has verdict " + verdict + ", not pass: accept --force to accept it anyway"
	case app.AppErrorLandConflict:
		return "conflict in " + strings.Join(err.Paths, ", ")
	case app.AppErrorLandVerifyFailed:
		return "verification in a fresh checkout failed: " + err.Command
	case app.AppErrorEngineNotEnabled:
		engine := string(err.Engine)
		return "the " + engine + " engine is not enabled: run " + provider.Slash + "setup:" + engine + " first"
	}
	return "app error: " + string(err.Kind)
}

func orList(items []string) string {
	if len(items) <= 1 {
		return strings.Join(items, "")
	}
	return strings.Join(items[:len(items)-1], ", ") + " or " + items[len(items)-1]
}

// ExitFor is the exit code an AppError ends the CLI with.
func ExitFor(err *app.AppError) ExitCode {
	switch err.Kind {
	case app.AppErrorStore:
		if err.StoreError.Kind == ports.StoreErrorNotFound {
			return ExitNotFound
		}
		return ExitUnexpected
	case app.AppErrorGit:
		if err.GitError.Kind == ports.GitErrorConflict || err.GitError.Kind == ports.GitErrorDirty {
			return ExitConflict
		}
		return ExitUnexpected
	case app.AppErrorLandConflict, app.AppErrorLandVerifyFailed:
		return ExitConflict
	case app.AppErrorNotPass:
		return ExitNotPass
	case app.AppErrorEngineNotEnabled:
		return ExitNotReady
	case app.AppErrorBrief, app.AppErrorBriefUnreadable, app.AppErrorMissingEnv, app.AppErrorEmptyFeedback, app.AppErrorWrongState:
		return ExitUsage
	case app.AppErrorLifecycle, app.AppErrorWorker:
		return ExitUnexpected
	}
	return ExitUnexpected
}

// stateWordsTable is each job state in words: "job X <words>".
var stateWordsTable = map[string]string{
	string(domain.JobStateQueued):         "is queued",
	string(domain.JobStateRunning):        "is running",
	string(domain.JobStateVerifying):      "is being verified",
	string(domain.JobStateAwaitingReview): "awaits review",
	string(domain.JobStateAccepted):       "was already accepted",
	string(domain.JobStateDiscarded):      "was already discarded",
}

func stateWords(state string) string {
	if words, ok := stateWordsTable[state]; ok {
		return words
	}
	return "is " + strings.Replace(state, "_", " ", 1)
}

// stateNoun is "a job that <noun>": the same table without "was already".
func stateNoun(state string) string {
	return strings.Replace(stateWords(state), "was already ", "was ", 1)
}

// eventWordsTable is what each lifecycle event does to a job, as "cannot be <words>".
var eventWordsTable = map[string]string{
	string(domain.EventSlotAcquired): "started",
	string(domain.EventWorkerExited): "finished",
	string(domain.EventVerified):     "verified",
	string(domain.EventRetry):        "retried",
	string(domain.EventReturned):     "returned",
	string(domain.EventAccepted):     "accepted",
	string(domain.EventDiscarded):    "discarded",
	string(domain.EventStopped):      "stopped",
}

func eventWords(event string) string {
	if words, ok := eventWordsTable[event]; ok {
		return words
	}
	return strings.Replace(event, "_", " ", 1)
}
