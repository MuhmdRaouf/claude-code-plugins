package domain

// JobEventType is what happened to a job.
type JobEventType string

const (
	EventSlotAcquired JobEventType = "slot_acquired"
	EventWorkerExited JobEventType = "worker_exited"
	EventVerified     JobEventType = "verified"
	EventRetry        JobEventType = "retry"
	EventReturned     JobEventType = "returned"
	EventAccepted     JobEventType = "accepted"
	EventDiscarded    JobEventType = "discarded"
	EventStopped      JobEventType = "stopped"
)

// JobEvent is what moves a job between states.
type JobEvent struct {
	Type JobEventType `json:"type"`
	// Retry: which kind of attempt runs next (auto_fix or infra_retry).
	RetryKind AttemptKind `json:"kind,omitempty"`
	// Returned: the reviewer's feedback.
	Feedback string `json:"feedback,omitempty"`
}

// LifecycleErrorKind names the one way a state machine step can fail.
type LifecycleErrorKind string

const IllegalTransition LifecycleErrorKind = "illegal_transition"

// LifecycleError names the state and the event that state does not accept.
type LifecycleError struct {
	Kind  LifecycleErrorKind
	From  JobState
	Event JobEventType
}

func (e LifecycleError) Error() string { return string(e.Kind) }

// transitions is the state machine's table: total over (state × event), every pair either moves
// or is an explicit illegal_transition.
var transitions = map[JobState]map[JobEventType]JobState{
	JobStateQueued: {
		EventSlotAcquired: JobStateRunning,
		EventDiscarded:    JobStateDiscarded,
		EventStopped:      JobStateAwaitingReview,
	},
	JobStateRunning: {
		EventWorkerExited: JobStateVerifying,
		EventDiscarded:    JobStateDiscarded,
		EventStopped:      JobStateAwaitingReview,
	},
	JobStateVerifying: {
		EventVerified:  JobStateAwaitingReview,
		EventRetry:     JobStateRunning,
		EventDiscarded: JobStateDiscarded,
		EventStopped:   JobStateAwaitingReview,
	},
	JobStateAwaitingReview: {
		EventReturned:  JobStateQueued,
		EventAccepted:  JobStateAccepted,
		EventDiscarded: JobStateDiscarded,
	},
	JobStateAccepted:  {},
	JobStateDiscarded: {},
}

// NextState applies one event to a state: the move it makes, or an illegal_transition naming the
// state and the event.
func NextState(from JobState, event JobEvent) (JobState, error) {
	to, ok := transitions[from][event.Type]
	if !ok {
		return "", LifecycleError{Kind: IllegalTransition, From: from, Event: event.Type}
	}
	return to, nil
}

// AfterVerificationKind is what the driver does once an attempt is verified.
type AfterVerificationKind string

const (
	AfterVerificationAutoFix     AfterVerificationKind = "auto_fix"
	AfterVerificationInfraRetry  AfterVerificationKind = "infra_retry"
	AfterVerificationAwaitReview AfterVerificationKind = "await_review"
)

// retryPolicy maps a verdict to the attempt kind it triggers and the brief budget that bounds it;
// nil for verdicts that never retry.
type retryPolicy struct {
	kind      AttemptKind
	fixBudget bool // true counts brief.retries.fix, false brief.retries.infra
	after     AfterVerificationKind
}

var autoFixPolicy = retryPolicy{
	kind:      AttemptKindAutoFix,
	fixBudget: true,
	after:     AfterVerificationAutoFix,
}

var infraRetryPolicy = retryPolicy{
	kind:      AttemptKindInfraRetry,
	fixBudget: false,
	after:     AfterVerificationInfraRetry,
}

var retryFor = map[Verdict]*retryPolicy{
	VerdictGateFail:       &autoFixPolicy,
	VerdictScopeViolation: &autoFixPolicy,
	VerdictReportInvalid:  &autoFixPolicy,
	VerdictWorkerError:    &infraRetryPolicy,
	// Out of balance or quota: every retry would fail the same way until the user tops up.
	VerdictTimeout: &infraRetryPolicy,
}

// AfterVerification is what the driver does once an attempt is verified. pass → await_review.
// gate_fail/scope_violation/report_invalid → auto_fix while fix attempts used < brief.retries.fix.
// worker_error/timeout → infra_retry while infra attempts used < brief.retries.infra. quota and
// stopped → await_review. Budget counts only attempts of the matching kind since the last
// review_fix (a reviewer's return grants a fresh budget).
func AfterVerification(job Job, verdict Verdict) AfterVerificationKind {
	policy := retryFor[verdict]
	if policy == nil {
		return AfterVerificationAwaitReview
	}
	budget := job.Brief.Retries.Infra
	if policy.fixBudget {
		budget = job.Brief.Retries.Fix
	}
	if attemptsUsed(job.Attempts, policy.kind) < budget {
		return policy.after
	}
	return AfterVerificationAwaitReview
}

// attemptsUsed counts attempts of the kind since the last review_fix: a reviewer's return grants a
// fresh budget.
func attemptsUsed(attempts []Attempt, kind AttemptKind) int64 {
	lastReturn := -1
	for i, attempt := range attempts {
		if attempt.Kind == AttemptKindReviewFix {
			lastReturn = i
		}
	}
	var used int64
	for _, attempt := range attempts[lastReturn+1:] {
		if attempt.Kind == kind {
			used++
		}
	}
	return used
}

// IsTerminal reports whether a state accepts no event at all: accepted and discarded.
func IsTerminal(state JobState) bool {
	return state == JobStateAccepted || state == JobStateDiscarded
}
