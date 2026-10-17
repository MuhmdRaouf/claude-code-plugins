package domain

import (
	"encoding/json"
	"fmt"
	"regexp"
)

// JobState is where a job is in its lifecycle.
type JobState string

const (
	JobStateQueued         JobState = "queued"
	JobStateRunning        JobState = "running"
	JobStateVerifying      JobState = "verifying"
	JobStateAwaitingReview JobState = "awaiting_review"
	JobStateAccepted       JobState = "accepted"
	JobStateDiscarded      JobState = "discarded"
)

// AttemptKind is which run of the worker an attempt is.
type AttemptKind string

const (
	AttemptKindInitial    AttemptKind = "initial"
	AttemptKindAutoFix    AttemptKind = "auto_fix"
	AttemptKindReviewFix  AttemptKind = "review_fix"
	AttemptKindInfraRetry AttemptKind = "infra_retry"
)

// WorkerOutcomeKind is how a worker attempt ended.
type WorkerOutcomeKind string

const (
	WorkerOutcomeCompleted WorkerOutcomeKind = "completed"
	WorkerOutcomeAPIError  WorkerOutcomeKind = "api_error"
	WorkerOutcomeTimeout   WorkerOutcomeKind = "timeout"
	WorkerOutcomeCrashed   WorkerOutcomeKind = "crashed"
	WorkerOutcomeStopped   WorkerOutcomeKind = "stopped"
)

// WorkerOutcome is how a worker attempt ended. Kind picks the variant; job.json carries only that
// variant's fields, so a null exitCode or signal survives a round trip.
type WorkerOutcome struct {
	Kind WorkerOutcomeKind `json:"kind"`
	// api_error: the provider's error text.
	Message string `json:"message,omitempty"`
	// api_error: the HTTP status the provider answered, when it answered one.
	Status *int64 `json:"status,omitempty"`
	// api_error: the provider says the account has no balance or quota left: no retry can succeed
	// until the user tops up.
	Quota *bool `json:"quota,omitempty"`
	// crashed: null when a signal killed the worker.
	ExitCode *int64 `json:"exitCode"`
	// crashed: the signal's name, null when the worker exited on its own.
	Signal *string `json:"signal"`
	// crashed: last lines of the worker's stderr, bounded.
	StderrTail string `json:"stderrTail,omitempty"`
}

// MarshalJSON writes only the fields the outcome's variant carries, in the order job.json pins.
func (o WorkerOutcome) MarshalJSON() ([]byte, error) {
	switch o.Kind {
	case WorkerOutcomeCompleted, WorkerOutcomeTimeout, WorkerOutcomeStopped:
		return json.Marshal(struct {
			Kind WorkerOutcomeKind `json:"kind"`
		}{o.Kind})
	case WorkerOutcomeAPIError:
		return json.Marshal(struct {
			Kind    WorkerOutcomeKind `json:"kind"`
			Message string            `json:"message"`
			Status  *int64            `json:"status,omitempty"`
			Quota   *bool             `json:"quota,omitempty"`
		}{o.Kind, o.Message, o.Status, o.Quota})
	case WorkerOutcomeCrashed:
		return json.Marshal(struct {
			Kind       WorkerOutcomeKind `json:"kind"`
			ExitCode   *int64            `json:"exitCode"`
			Signal     *string           `json:"signal"`
			StderrTail string            `json:"stderrTail"`
		}{o.Kind, o.ExitCode, o.Signal, o.StderrTail})
	}
	return nil, fmt.Errorf("worker outcome: unknown kind %q", o.Kind)
}

// UnmarshalJSON reads the variant the Kind field names; any other field of the union is absent.
func (o *WorkerOutcome) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	var kind WorkerOutcomeKind
	if raw, ok := fields["kind"]; ok {
		if err := json.Unmarshal(raw, &kind); err != nil {
			return err
		}
	}
	outcome := WorkerOutcome{Kind: kind}
	switch kind {
	case WorkerOutcomeCompleted, WorkerOutcomeTimeout, WorkerOutcomeStopped:
		*o = outcome
		return nil
	case WorkerOutcomeAPIError:
		if raw, ok := fields["message"]; ok {
			if err := json.Unmarshal(raw, &outcome.Message); err != nil {
				return err
			}
		}
		if raw, ok := fields["status"]; ok {
			if err := json.Unmarshal(raw, &outcome.Status); err != nil {
				return err
			}
		}
		if raw, ok := fields["quota"]; ok {
			if err := json.Unmarshal(raw, &outcome.Quota); err != nil {
				return err
			}
		}
	case WorkerOutcomeCrashed:
		if raw, ok := fields["exitCode"]; ok {
			if err := json.Unmarshal(raw, &outcome.ExitCode); err != nil {
				return err
			}
		}
		if raw, ok := fields["signal"]; ok {
			if err := json.Unmarshal(raw, &outcome.Signal); err != nil {
				return err
			}
		}
		if raw, ok := fields["stderrTail"]; ok {
			if err := json.Unmarshal(raw, &outcome.StderrTail); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("worker outcome: unknown kind %q", kind)
	}
	*o = outcome
	return nil
}

// Usage is what a worker run consumed, as the worker reported it.
type Usage struct {
	Turns            int64   `json:"turns"`
	InputTokens      int64   `json:"inputTokens"`
	OutputTokens     int64   `json:"outputTokens"`
	CacheReadTokens  int64   `json:"cacheReadTokens"`
	CacheWriteTokens int64   `json:"cacheWriteTokens"`
	CostUSD          float64 `json:"costUsd"`
	RateLimitRetries int64   `json:"rateLimitRetries"`
	DurationMs       int64   `json:"durationMs"`
	// A delegation engine's attempts only: the model the tool reported running on, in the tool's
	// own naming (it runs on its own setup's default, so this is the only place the job learns
	// which).
	Model *string `json:"model,omitempty"`
}

// GateResult is one gate command the plugin ran after the worker.
type GateResult struct {
	Run string `json:"run"`
	// Null when a signal killed the gate.
	ExitCode   *int64 `json:"exitCode"`
	TimedOut   bool   `json:"timedOut"`
	DurationMs int64  `json:"durationMs"`
	// Last lines of combined stdout/stderr, bounded.
	Tail string `json:"tail"`
}

// ChangeSet is every path a run touched.
type ChangeSet struct {
	Added    []string `json:"added"`
	Modified []string `json:"modified"`
	Deleted  []string `json:"deleted"`
	// Renames are recorded as delete(from) + add(to) by the git adapter.
	Untracked []string `json:"untracked"`
}

// ScopeCheck is a change set checked against the brief's scope and forbid globs.
type ScopeCheck struct {
	OutOfScope []string `json:"outOfScope"`
	Forbidden  []string `json:"forbidden"`
	// exec/readonly: the repository must not change at all.
	RepoChanged bool `json:"repoChanged"`
}

// ReportCheck is a worker report checked against the brief's report contract.
type ReportCheck struct {
	Present  bool     `json:"present"`
	Valid    bool     `json:"valid"`
	Problems []string `json:"problems"`
}

// Verification is everything the plugin measured about one attempt.
type Verification struct {
	Gates   []GateResult `json:"gates"`
	Changes ChangeSet    `json:"changes"`
	Scope   ScopeCheck   `json:"scope"`
	Report  ReportCheck  `json:"report"`
}

// Verdict is what the verification of one attempt concluded.
type Verdict string

const (
	VerdictPass           Verdict = "pass"
	VerdictGateFail       Verdict = "gate_fail"
	VerdictScopeViolation Verdict = "scope_violation"
	VerdictReportInvalid  Verdict = "report_invalid"
	VerdictWorkerError    Verdict = "worker_error"
	VerdictQuota          Verdict = "quota"
	VerdictTimeout        Verdict = "timeout"
	VerdictStopped        Verdict = "stopped"
)

// Attempt is one run of the worker on a job.
type Attempt struct {
	N      int64       `json:"n"`
	Kind   AttemptKind `json:"kind"`
	Prompt string      `json:"prompt"`
	// Reviewer feedback that triggered a review_fix attempt.
	Feedback  *string        `json:"feedback,omitempty"`
	SessionID string         `json:"sessionId"`
	StartedAt string         `json:"startedAt"`
	EndedAt   *string        `json:"endedAt,omitempty"`
	Outcome   *WorkerOutcome `json:"outcome,omitempty"`
	Usage     *Usage         `json:"usage,omitempty"`
	// The report the worker returned, as the raw JSON job.json carries: re-encoding it through a
	// decoded map would reorder its keys.
	Report       json.RawMessage `json:"report,omitempty"`
	Verification *Verification   `json:"verification,omitempty"`
	Verdict      *Verdict        `json:"verdict,omitempty"`
}

// Workspace is where a job's checkout and artifacts live.
type Workspace struct {
	RepoRoot string `json:"repoRoot"`
	BaseSha  string `json:"baseSha"`
	// Edit mode only.
	Worktree     *string `json:"worktree,omitempty"`
	Branch       *string `json:"branch,omitempty"`
	ArtifactsDir string  `json:"artifactsDir"`
}

// DecisionKind is how review ended.
type DecisionKind string

const (
	DecisionAccepted  DecisionKind = "accepted"
	DecisionDiscarded DecisionKind = "discarded"
)

// Decision is how a job's review ended: accepted (landing made a commit) or discarded.
type Decision struct {
	Kind DecisionKind `json:"kind"`
	At   string       `json:"at"`
	// Accepted: the commit the landing made, when it made one.
	Commit *string `json:"commit,omitempty"`
	// Discarded: why.
	Reason *string `json:"reason,omitempty"`
}

// Origin is the Claude Code session that submitted a job.
type Origin struct {
	SessionID string `json:"sessionId"`
}

// Job is the on-disk job.json: one brief a driver works through attempts until review decides it.
type Job struct {
	ID        string    `json:"id"`
	Brief     Brief     `json:"brief"`
	State     JobState  `json:"state"`
	Workspace Workspace `json:"workspace"`
	Attempts  []Attempt `json:"attempts"`
	CreatedAt string    `json:"createdAt"`
	UpdatedAt string    `json:"updatedAt"`
	Decision  *Decision `json:"decision,omitempty"`
	// The Claude Code session that submitted the job (from CLAUDE_CODE_SESSION_ID), absent when it
	// was submitted outside Claude Code.
	Origin *Origin `json:"origin,omitempty"`
	// Optimistic-concurrency counter, bumped by every store write.
	Version int64 `json:"version"`
}

// sessionIDPattern matches a session id as CLAUDE_CODE_SESSION_ID carries it: 8-4-4-4-12 hex.
var sessionIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// JobOrigin is the origin a submitted job records for its CLAUDE_CODE_SESSION_ID value, or nil
// when the value is missing or not a session id: the job was submitted outside Claude Code.
func JobOrigin(sessionID any) *Origin {
	text, ok := sessionID.(string)
	if !ok || !sessionIDPattern.MatchString(text) {
		return nil
	}
	return &Origin{SessionID: text}
}

// StoredOrigin reads a stored `origin` that is well formed; anything else (an older or foreign
// job.json) reads as no origin.
func StoredOrigin(value any) *Origin {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return JobOrigin(object["sessionId"])
}
