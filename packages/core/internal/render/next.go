package render

import (
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// NextStep is the reviewer's next step for one job, chosen from its verdict and mode. It names
// the `/<p>:review` slash command (there is no CLI on PATH), never `accept --force` first, never
// accept for a job that crashed or has nothing to merge, and never "ask the worker to rebase":
// the worker may not commit or switch branches, so a conflict means discard and run the brief
// again.
func NextStep(provider domain.Provider, job domain.Job) string {
	review := provider.Slash + "review " + job.ID
	if job.State == domain.JobStateAccepted || job.State == domain.JobStateDiscarded {
		return "nothing left to do: the job was " + string(job.State) + "."
	}
	if job.State != domain.JobStateAwaitingReview {
		return "it is " + strings.Replace(string(job.State), "_", " ", 1) + "; " + provider.Slash +
			"board shows it until it awaits review."
	}
	// The verdict union is closed; a missing verdict reads as no verdict rather than crashing
	// the render.
	last := LastAttempt(job)
	if last == nil || last.Verdict == nil {
		return review + " to return it to try again, or discard it."
	}
	changes := job.Brief.Mode == domain.ModeEdit
	switch *last.Verdict {
	case domain.VerdictPass:
		if changes {
			return review + " to read the diff and accept it, or return it with feedback."
		}
		return "the answer is in the report (a " + string(job.Brief.Mode) + " job: nothing to merge); " + review +
			" closes it or returns it with a follow-up."
	case domain.VerdictWorkerError, domain.VerdictTimeout:
		why := strings.Replace(string(*last.Verdict), "_", " ", 1)
		if last.Outcome != nil {
			why = OutcomeText(*last.Outcome)
		}
		return "the worker never finished (" + why + "): nothing to accept. Fix the cause, then " + review +
			" to return it to try again, or discard it."
	case domain.VerdictQuota:
		return provider.Display + " says the account has no balance or quota left, so it was not retried: top up at " +
			provider.BillingURL + ", then " + review + " to return it to try again, or discard it."
	case domain.VerdictStopped:
		return "it was stopped before it finished: " + review + " to return it with feedback, or discard it."
	case domain.VerdictGateFail, domain.VerdictScopeViolation, domain.VerdictReportInvalid:
		return review + " to return it with the failing output as feedback, or discard it."
	}
	return review + " to return it to try again, or discard it."
}

// ConflictStep is what to do after an accept hit a merge conflict: the worker cannot rebase, so
// the brief runs again.
func ConflictStep(provider domain.Provider) string {
	return "nothing was applied. The worker cannot rebase (it never commits or switches branches): discard the job " +
		"with " + provider.Slash + "review and run the brief again on the current branch, or merge the job's branch by hand."
}
