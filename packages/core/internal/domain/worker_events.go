package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"unicode/utf16"
)

// WorkerEventKind is which wire event a worker event is.
type WorkerEventKind string

const (
	WorkerEventInit          WorkerEventKind = "init"
	WorkerEventSession       WorkerEventKind = "session"
	WorkerEventError         WorkerEventKind = "error"
	WorkerEventAPIRetry      WorkerEventKind = "api_retry"
	WorkerEventAssistantText WorkerEventKind = "assistant_text"
	WorkerEventTextDelta     WorkerEventKind = "text_delta"
	WorkerEventToolUse       WorkerEventKind = "tool_use"
	WorkerEventToolResult    WorkerEventKind = "tool_result"
	WorkerEventResult        WorkerEventKind = "result"
	WorkerEventOther         WorkerEventKind = "other"
)

// ResultUsage is a result event's token counts: Usage without the fields the result event
// carries outside its usage object.
type ResultUsage struct {
	InputTokens      int64 `json:"inputTokens"`
	OutputTokens     int64 `json:"outputTokens"`
	CacheReadTokens  int64 `json:"cacheReadTokens"`
	CacheWriteTokens int64 `json:"cacheWriteTokens"`
}

// WorkerEvent is what every worker's stream comes down to: each adapter reads its own wire (Claude
// Code's stream-json, omp's RPC frames) into these events, and the core folds them into progress
// and the attempt's outcome. A wire event the core does not track is kept as `other`.
type WorkerEvent struct {
	Kind WorkerEventKind `json:"type"`
	// init, session: the session the event names.
	SessionID string `json:"sessionId,omitempty"`
	// init: the model the worker runs on; result: the model a delegation tool reported running
	// on, in its own naming, absent when it reports none.
	Model *string `json:"model,omitempty"`
	// error: the failure the worker itself reported.
	Message string `json:"message,omitempty"`
	// error, api_retry: the HTTP status, null when the failure had none.
	Status *int64 `json:"status,omitempty"`
	// api_retry.
	Attempt    int64 `json:"attempt,omitempty"`
	MaxRetries int64 `json:"maxRetries,omitempty"`
	// assistant_text, text_delta; result: the result text.
	Text string `json:"text,omitempty"`
	// tool_use.
	Name    string `json:"name,omitempty"`
	Summary string `json:"summary,omitempty"`
	// tool_result: the tool call failed.
	IsError bool `json:"isError,omitempty"`
	// result: the report the worker returned, as raw JSON bytes so its key order survives
	// (re-encoding through a decoded map would reorder them). Nil is null.
	StructuredOutput json.RawMessage `json:"structuredOutput,omitempty"`
	Turns            int64           `json:"turns,omitempty"`
	DurationMs       int64           `json:"durationMs,omitempty"`
	CostUSD          float64         `json:"costUsd,omitempty"`
	Usage            ResultUsage     `json:"usage,omitempty"`
	// result: HTTP status of the failed API call (api_error_status), null when absent.
	APIErrorStatus *int64 `json:"apiErrorStatus,omitempty"`
	// other: the raw wire line.
	Raw string `json:"raw,omitempty"`
}

// MarshalJSON writes only the fields the event's variant carries, in the order the wire format
// pins them.
func (e WorkerEvent) MarshalJSON() ([]byte, error) {
	switch e.Kind {
	case WorkerEventInit:
		return marshalWorkerEvent(struct {
			Kind      WorkerEventKind `json:"type"`
			SessionID string          `json:"sessionId"`
			Model     *string         `json:"model"`
		}{e.Kind, e.SessionID, e.Model})
	case WorkerEventSession:
		return marshalWorkerEvent(struct {
			Kind      WorkerEventKind `json:"type"`
			SessionID string          `json:"sessionId"`
		}{e.Kind, e.SessionID})
	case WorkerEventError:
		return marshalWorkerEvent(struct {
			Kind    WorkerEventKind `json:"type"`
			Message string          `json:"message"`
			Status  *int64          `json:"status"`
		}{e.Kind, e.Message, e.Status})
	case WorkerEventAPIRetry:
		return marshalWorkerEvent(struct {
			Kind       WorkerEventKind `json:"type"`
			Attempt    int64           `json:"attempt"`
			MaxRetries int64           `json:"maxRetries"`
			Status     *int64          `json:"status"`
		}{e.Kind, e.Attempt, e.MaxRetries, e.Status})
	case WorkerEventAssistantText, WorkerEventTextDelta:
		return marshalWorkerEvent(struct {
			Kind WorkerEventKind `json:"type"`
			Text string          `json:"text"`
		}{e.Kind, e.Text})
	case WorkerEventToolUse:
		return marshalWorkerEvent(struct {
			Kind    WorkerEventKind `json:"type"`
			Name    string          `json:"name"`
			Summary string          `json:"summary"`
		}{e.Kind, e.Name, e.Summary})
	case WorkerEventToolResult:
		return marshalWorkerEvent(struct {
			Kind    WorkerEventKind `json:"type"`
			IsError bool            `json:"isError"`
		}{e.Kind, e.IsError})
	case WorkerEventResult:
		return marshalWorkerEvent(struct {
			Kind             WorkerEventKind `json:"type"`
			IsError          bool            `json:"isError"`
			Text             string          `json:"text"`
			StructuredOutput json.RawMessage `json:"structuredOutput"`
			Turns            int64           `json:"turns"`
			DurationMs       int64           `json:"durationMs"`
			CostUSD          float64         `json:"costUsd"`
			Usage            ResultUsage     `json:"usage"`
			APIErrorStatus   *int64          `json:"apiErrorStatus"`
			Model            *string         `json:"model,omitempty"`
		}{e.Kind, e.IsError, e.Text, e.StructuredOutput, e.Turns, e.DurationMs, e.CostUSD, e.Usage, e.APIErrorStatus, e.Model})
	case WorkerEventOther:
		return marshalWorkerEvent(struct {
			Kind WorkerEventKind `json:"type"`
			Raw  string          `json:"raw"`
		}{e.Kind, e.Raw})
	}
	return nil, fmt.Errorf("worker event: unknown kind %q", e.Kind)
}

// UnmarshalJSON reads the variant the Kind field names; any other field of the union is absent.
// Nothing here validates that the variant's own fields are present: the wire shape is the
// writer's, read as JSON.parse leaves it.
func (e *WorkerEvent) UnmarshalJSON(data []byte) error {
	var wire struct {
		Type             string          `json:"type"`
		SessionID        *string         `json:"sessionId"`
		Model            *string         `json:"model"`
		Message          *string         `json:"message"`
		Status           *int64          `json:"status"`
		Attempt          *int64          `json:"attempt"`
		MaxRetries       *int64          `json:"maxRetries"`
		Text             *string         `json:"text"`
		Name             *string         `json:"name"`
		Summary          *string         `json:"summary"`
		IsError          *bool           `json:"isError"`
		StructuredOutput json.RawMessage `json:"structuredOutput"`
		Turns            *int64          `json:"turns"`
		DurationMs       *int64          `json:"durationMs"`
		CostUsd          *float64        `json:"costUsd"`
		Usage            *ResultUsage    `json:"usage"`
		APIErrorStatus   *int64          `json:"apiErrorStatus"`
		Raw              *string         `json:"raw"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	kind := WorkerEventKind(wire.Type)
	switch kind {
	case WorkerEventInit, WorkerEventSession, WorkerEventError, WorkerEventAPIRetry,
		WorkerEventAssistantText, WorkerEventTextDelta, WorkerEventToolUse, WorkerEventToolResult,
		WorkerEventResult, WorkerEventOther:
	default:
		return fmt.Errorf("worker event: unknown kind %q", kind)
	}
	event := WorkerEvent{Kind: kind}
	event.SessionID = stringOrEmpty(wire.SessionID)
	event.Model = wire.Model
	event.Message = stringOrEmpty(wire.Message)
	event.Status = wire.Status
	if wire.Attempt != nil {
		event.Attempt = *wire.Attempt
	}
	if wire.MaxRetries != nil {
		event.MaxRetries = *wire.MaxRetries
	}
	event.Text = stringOrEmpty(wire.Text)
	event.Name = stringOrEmpty(wire.Name)
	event.Summary = stringOrEmpty(wire.Summary)
	if wire.IsError != nil {
		event.IsError = *wire.IsError
	}
	event.StructuredOutput = rawOrNull(wire.StructuredOutput)
	if wire.Turns != nil {
		event.Turns = *wire.Turns
	}
	if wire.DurationMs != nil {
		event.DurationMs = *wire.DurationMs
	}
	if wire.CostUsd != nil {
		event.CostUSD = *wire.CostUsd
	}
	if wire.Usage != nil {
		event.Usage = *wire.Usage
	}
	event.APIErrorStatus = wire.APIErrorStatus
	event.Raw = stringOrEmpty(wire.Raw)
	*e = event
	return nil
}

func stringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// rawOrNull normalizes a read raw value: absent and JSON null are both no report.
func rawOrNull(raw json.RawMessage) json.RawMessage {
	if bytes.Equal(raw, []byte("null")) {
		return nil
	}
	return raw
}

// marshalWorkerEvent encodes a wire event the way JSON.stringify does: `<`, `>` and `&` alone,
// U+2028 and U+2029 raw.
func marshalWorkerEvent(value any) ([]byte, error) {
	return MarshalCompactJSON(value)
}

// ProgressPhase is where a running attempt is.
type ProgressPhase string

const (
	ProgressPhaseStarting    ProgressPhase = "starting"
	ProgressPhaseThinking    ProgressPhase = "thinking"
	ProgressPhaseTool        ProgressPhase = "tool"
	ProgressPhaseWriting     ProgressPhase = "writing"
	ProgressPhaseRateLimited ProgressPhase = "rate_limited"
	ProgressPhaseDone        ProgressPhase = "done"
)

// Progress is the live view rendered by `show --follow` and the board.
type Progress struct {
	SessionID *string       `json:"sessionId,omitempty"`
	Phase     ProgressPhase `json:"phase"`
	Turns     int64         `json:"turns"`
	// The tool the attempt is in, when it is in one.
	LastTool *string `json:"lastTool,omitempty"`
	// Last ~500 chars of assistant text (deltas accumulated, reset per message).
	LastText         string `json:"lastText"`
	RateLimitRetries int64  `json:"rateLimitRetries"`
	ToolCalls        int64  `json:"toolCalls"`
	ToolErrors       int64  `json:"toolErrors"`
}

// INITIAL_PROGRESS is where every attempt starts. Treat it as read-only.
var INITIAL_PROGRESS = Progress{Phase: ProgressPhaseStarting}

// Z.ai answers its 1302 "rate limit reached" with HTTP 429; other retried statuses are not budget
// pressure.
const rateLimitStatus = 429

// lastTextChars caps Progress.LastText.
const lastTextChars = 500

// lastChars keeps the last 500 UTF-16 code units, the unit JS slice counts; a surrogate pair the
// cut splits leaves what utf16.Decode makes of the lone half (U+FFFD), which is what Node writes
// out.
func lastChars(text string) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= lastTextChars {
		return text
	}
	return string(utf16.Decode(units[len(units)-lastTextChars:]))
}

// ReduceProgress folds one worker event into the live view.
func ReduceProgress(progress Progress, event WorkerEvent) Progress {
	switch event.Kind {
	case WorkerEventInit:
		progress.SessionID = &event.SessionID
		progress.Phase = ProgressPhaseThinking
		return progress
	case WorkerEventSession:
		// An engine-keyed session: the id the engine assigned, replacing the caller's placeholder.
		progress.SessionID = &event.SessionID
		return progress
	case WorkerEventError:
		// The worker's own report of a failed call; the fold learns nothing until a result or exit
		// says more.
		return progress
	case WorkerEventAPIRetry:
		if event.Status == nil || *event.Status != rateLimitStatus {
			return progress
		}
		progress.Phase = ProgressPhaseRateLimited
		progress.RateLimitRetries++
		return progress
	case WorkerEventTextDelta:
		// Deltas only accumulate within the message being written; the first delta after anything
		// else starts afresh.
		sofar := ""
		if progress.Phase == ProgressPhaseWriting {
			sofar = progress.LastText
		}
		progress.Phase = ProgressPhaseWriting
		progress.LastText = lastChars(sofar + event.Text)
		return progress
	case WorkerEventAssistantText:
		progress.Phase = ProgressPhaseThinking
		progress.LastText = lastChars(event.Text)
		return progress
	case WorkerEventToolUse:
		progress.Phase = ProgressPhaseTool
		if event.Summary == "" {
			progress.LastTool = &event.Name
		} else {
			tool := event.Name + " " + event.Summary
			progress.LastTool = &tool
		}
		progress.ToolCalls++
		return progress
	case WorkerEventToolResult:
		progress.Phase = ProgressPhaseThinking
		if event.IsError {
			progress.ToolErrors++
		}
		return progress
	case WorkerEventResult:
		progress.Phase = ProgressPhaseDone
		progress.Turns = event.Turns
		return progress
	default:
		return progress
	}
}

// WorkerExit is how the worker process ended, as the process layer reports it.
type WorkerExit struct {
	// Null when a signal killed the worker.
	Code *int64
	// The signal's name, null when the worker exited on its own.
	Signal     *string
	StderrTail string
}

// ForcedEnd is an end the process layer imposed on the worker: a timeout or a stop.
type ForcedEnd string

const (
	ForcedTimeout ForcedEnd = "timeout"
	ForcedStopped ForcedEnd = "stopped"
)

// WorkerResult is the fold of a finished worker attempt.
type WorkerResult struct {
	Outcome WorkerOutcome
	Usage   Usage
	// The report the worker returned, raw so its key order survives; nil is null.
	Report    json.RawMessage
	SessionID *string
}

// Claude Code renders API failures as "API Error: Request rejected (429) · …"; older versions
// carry the status only in that text, so it is the fallback when the result has no
// api_error_status.
var httpErrorStatus = regexp.MustCompile(`\(([45]\d\d)\)`)

func apiError(result WorkerEvent) WorkerOutcome {
	status := result.APIErrorStatus
	if status == nil {
		if match := httpErrorStatus.FindStringSubmatch(result.Text); match != nil {
			// The pattern captures exactly three digits, so the parse cannot fail.
			if parsed, err := strconv.ParseInt(match[1], 10, 64); err == nil {
				status = &parsed
			}
		}
	}
	outcome := WorkerOutcome{Kind: WorkerOutcomeAPIError, Message: result.Text, Status: status}
	// Z.ai 1113/1316/1317, Moonshot's exceeded_current_quota_error, DeepSeek's 402, MiniMax 1008,
	// DashScope Arrearage.
	if OutOfBalanceText(status, result.Text) {
		quota := true
		outcome.Quota = &quota
	}
	return outcome
}

func isRateLimitRetry(event WorkerEvent) bool {
	// Only api_retry events carry a status, so dropping the type test changes nothing at run time
	// (an equivalent mutant).
	return event.Kind == WorkerEventAPIRetry && event.Status != nil && *event.Status == rateLimitStatus
}

func outcomeOf(result *WorkerEvent, exit WorkerExit, forced *ForcedEnd) WorkerOutcome {
	if forced != nil {
		kind := WorkerOutcomeTimeout
		if *forced == ForcedStopped {
			kind = WorkerOutcomeStopped
		}
		return WorkerOutcome{Kind: kind}
	}
	// Even a clean exit without a result event is a crash: every finished run ends with one.
	if result == nil {
		return WorkerOutcome{Kind: WorkerOutcomeCrashed, ExitCode: exit.Code, Signal: exit.Signal, StderrTail: exit.StderrTail}
	}
	if result.IsError {
		return apiError(*result)
	}
	return WorkerOutcome{Kind: WorkerOutcomeCompleted}
}

// FinalizeWorker folds a finished attempt: the last `result` event decides completed vs api_error
// (is_error, message from `text`, status from `api_error_status`, else from the text); no result
// event is a crash, whatever the exit code; the process layer passes timeout/stopped directly.
// Usage sums tokens from the result event and counts 429 api_retry events.
func FinalizeWorker(events []WorkerEvent, exit WorkerExit, forced *ForcedEnd) WorkerResult {
	var result, session, init *WorkerEvent
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Kind == WorkerEventResult {
			result = &events[i]
			break
		}
	}
	for i := range events {
		// An engine-keyed session announces its id as a `session` event, which beats the init
		// line's caller key.
		if events[i].Kind == WorkerEventSession && session == nil {
			session = &events[i]
		}
		if events[i].Kind == WorkerEventInit && init == nil {
			init = &events[i]
		}
	}
	var sessionID *string
	switch {
	case session != nil:
		sessionID = &session.SessionID
	case init != nil:
		sessionID = &init.SessionID
	}
	usage := Usage{RateLimitRetries: countRateLimitRetries(events)}
	var report json.RawMessage
	if result != nil {
		usage.Turns = result.Turns
		usage.InputTokens = result.Usage.InputTokens
		usage.OutputTokens = result.Usage.OutputTokens
		usage.CacheReadTokens = result.Usage.CacheReadTokens
		usage.CacheWriteTokens = result.Usage.CacheWriteTokens
		usage.CostUSD = result.CostUSD
		usage.DurationMs = result.DurationMs
		usage.Model = result.Model
		report = result.StructuredOutput
	}
	return WorkerResult{
		SessionID: sessionID,
		Outcome:   outcomeOf(result, exit, forced),
		Usage:     usage,
		Report:    report,
	}
}

func countRateLimitRetries(events []WorkerEvent) int64 {
	var count int64
	for _, event := range events {
		if isRateLimitRetry(event) {
			count++
		}
	}
	return count
}
