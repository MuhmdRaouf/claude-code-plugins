package domain

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// eventFixtureEvents reads a recorded run's events: what the claude worker read from its
// stream-json fixtures (testdata/events).
func eventFixtureEvents(t *testing.T, name string) []WorkerEvent {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "events", name))
	if err != nil {
		t.Fatalf("read event fixture %s: %v", name, err)
	}
	var events []WorkerEvent
	for _, line := range strings.Split(string(raw), "\n") {
		if line == "" {
			continue
		}
		var event WorkerEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("%s: decode %s: %v", name, line, err)
		}
		events = append(events, event)
	}
	return events
}

// resultEvent is a small successful result to override per call.
func resultEvent() WorkerEvent {
	return WorkerEvent{Kind: WorkerEventResult, Turns: 1, DurationMs: 10}
}

// cleanExit is a clean exit: code 0, no signal, no stderr.
func cleanExit() WorkerExit {
	return WorkerExit{Code: i64Ptr(0)}
}

// The pointer fields (sessionId, lastTool, status, …) compare by what they point at.
func equalProgress(a, b Progress) bool     { return reflect.DeepEqual(a, b) }
func equalOutcome(a, b WorkerOutcome) bool { return reflect.DeepEqual(a, b) }
func equalUsage(a, b Usage) bool           { return reflect.DeepEqual(a, b) }

func TestReduceProgress(t *testing.T) {
	t.Run("INITIAL_PROGRESS is starting, with no text, no session and zero counters", func(t *testing.T) {
		if !equalProgress(INITIAL_PROGRESS, Progress{Phase: ProgressPhaseStarting}) {
			t.Errorf("INITIAL_PROGRESS is %+v, want a starting progress with everything else zero", INITIAL_PROGRESS)
		}
	})

	t.Run("init sets sessionId and phase thinking", func(t *testing.T) {
		progress := ReduceProgress(INITIAL_PROGRESS, WorkerEvent{Kind: WorkerEventInit, SessionID: "s-1", Model: strPtr("glm-5.3")})

		want := INITIAL_PROGRESS
		want.SessionID = strPtr("s-1")
		want.Phase = ProgressPhaseThinking
		if !equalProgress(progress, want) {
			t.Errorf("got %+v, want %+v", progress, want)
		}
	})

	t.Run("session sets sessionId and nothing else — an engine-keyed id replacing the caller's placeholder", func(t *testing.T) {
		thinking := INITIAL_PROGRESS
		thinking.SessionID = strPtr("caller-key")
		thinking.Phase = ProgressPhaseThinking
		thinking.Turns = 3

		progress := ReduceProgress(thinking, WorkerEvent{Kind: WorkerEventSession, SessionID: "engine-id-1"})

		want := thinking
		want.SessionID = strPtr("engine-id-1")
		if !equalProgress(progress, want) {
			t.Errorf("got %+v, want %+v", progress, want)
		}
	})

	t.Run("error leaves progress unchanged (same object): the worker's own report of a failed call", func(t *testing.T) {
		thinking := INITIAL_PROGRESS
		thinking.Phase = ProgressPhaseThinking
		thinking.LastText = "x"

		if got := ReduceProgress(thinking, WorkerEvent{Kind: WorkerEventError, Message: "provider 529", Status: i64Ptr(529)}); !equalProgress(got, thinking) {
			t.Errorf("got %+v, want the same progress %+v", got, thinking)
		}
	})
	t.Run("api_retry with status 429 sets phase rate_limited and increments rateLimitRetries", func(t *testing.T) {
		thinking := INITIAL_PROGRESS
		thinking.Phase = ProgressPhaseThinking
		thinking.RateLimitRetries = 2

		progress := ReduceProgress(thinking, WorkerEvent{Kind: WorkerEventAPIRetry, Attempt: 3, MaxRetries: 10, Status: i64Ptr(429)})

		want := thinking
		want.Phase = ProgressPhaseRateLimited
		want.RateLimitRetries = 3
		if !equalProgress(progress, want) {
			t.Errorf("got %+v, want %+v", progress, want)
		}
	})

	t.Run("api_retry for anything but 429 (overload, network) is not rate-limit pressure: progress unchanged", func(t *testing.T) {
		thinking := INITIAL_PROGRESS
		thinking.Phase = ProgressPhaseThinking

		if got := ReduceProgress(thinking, WorkerEvent{Kind: WorkerEventAPIRetry, Attempt: 1, MaxRetries: 10, Status: i64Ptr(529)}); !equalProgress(got, thinking) {
			t.Errorf("529: got %+v, want the same progress %+v", got, thinking)
		}
		if got := ReduceProgress(thinking, WorkerEvent{Kind: WorkerEventAPIRetry, Attempt: 1, MaxRetries: 10}); !equalProgress(got, thinking) {
			t.Errorf("no status: got %+v, want the same progress %+v", got, thinking)
		}
	})
	t.Run("text_delta accumulates lastText, capped to the last 500 chars; assistant_text replaces it", func(t *testing.T) {
		thinking := INITIAL_PROGRESS
		thinking.Phase = ProgressPhaseThinking
		delta := func(text string) WorkerEvent {
			return WorkerEvent{Kind: WorkerEventTextDelta, Text: text}
		}

		started := ReduceProgress(thinking, delta("Hello, "))
		continued := ReduceProgress(started, delta("world"))
		long := ReduceProgress(continued, delta(strings.Repeat("y", 600)))
		completed := ReduceProgress(long, WorkerEvent{Kind: WorkerEventAssistantText, Text: "Hello, world"})

		wantStarted := thinking
		wantStarted.Phase = ProgressPhaseWriting
		wantStarted.LastText = "Hello, "
		if !equalProgress(started, wantStarted) {
			t.Errorf("started: got %+v, want %+v", started, wantStarted)
		}
		if continued.LastText != "Hello, world" {
			t.Errorf("continued lastText: got %q, want %q", continued.LastText, "Hello, world")
		}
		if long.LastText != strings.Repeat("y", 500) {
			t.Errorf("long lastText length: got %d, want 500", len(long.LastText))
		}
		wantCompleted := long
		wantCompleted.Phase = ProgressPhaseThinking
		wantCompleted.LastText = "Hello, world"
		if !equalProgress(completed, wantCompleted) {
			t.Errorf("completed: got %+v, want %+v", completed, wantCompleted)
		}
		// The cap counts UTF-16 code units and cuts like JS slice: here the window starts on the
		// low half of a pair, and the lone surrogate reads as U+FFFD — what Node writes out.
		split := ReduceProgress(INITIAL_PROGRESS, delta("😀"+strings.Repeat("y", 499)))
		if want := "�" + strings.Repeat("y", 499); split.LastText != want {
			t.Errorf("split emoji: got %q, want %q", split.LastText, want)
		}
		if got := utf16Len(split.LastText); got != 500 {
			t.Errorf("split emoji length: got %d UTF-16 units, want 500", got)
		}
	})

	t.Run("assistant_text keeps only the last 500 chars of a long message", func(t *testing.T) {
		progress := ReduceProgress(INITIAL_PROGRESS, WorkerEvent{
			Kind: WorkerEventAssistantText,
			Text: strings.Repeat("a", 10) + strings.Repeat("b", 500),
		})

		if progress.LastText != strings.Repeat("b", 500) {
			t.Errorf("lastText length: got %d, want 500", len(progress.LastText))
		}
	})

	t.Run("the first text_delta of a new message resets lastText (deltas accumulate per message)", func(t *testing.T) {
		afterMessage := INITIAL_PROGRESS
		afterMessage.Phase = ProgressPhaseThinking
		afterMessage.LastText = "previous message"

		progress := ReduceProgress(afterMessage, WorkerEvent{Kind: WorkerEventTextDelta, Text: "Next"})

		want := afterMessage
		want.Phase = ProgressPhaseWriting
		want.LastText = "Next"
		if !equalProgress(progress, want) {
			t.Errorf("got %+v, want %+v", progress, want)
		}
	})
	t.Run("tool_use sets phase tool, lastTool, increments toolCalls; tool_result with error increments toolErrors", func(t *testing.T) {
		writing := INITIAL_PROGRESS
		writing.Phase = ProgressPhaseWriting
		writing.ToolCalls = 1
		writing.ToolErrors = 1

		calling := ReduceProgress(writing, WorkerEvent{Kind: WorkerEventToolUse, Name: "Bash", Summary: "npm test"})
		failed := ReduceProgress(calling, WorkerEvent{Kind: WorkerEventToolResult, IsError: true})
		succeeded := ReduceProgress(failed, WorkerEvent{Kind: WorkerEventToolResult})

		wantCalling := writing
		wantCalling.Phase = ProgressPhaseTool
		wantCalling.LastTool = strPtr("Bash npm test")
		wantCalling.ToolCalls = 2
		if !equalProgress(calling, wantCalling) {
			t.Errorf("calling: got %+v, want %+v", calling, wantCalling)
		}
		wantFailed := calling
		wantFailed.Phase = ProgressPhaseThinking
		wantFailed.ToolErrors = 2
		if !equalProgress(failed, wantFailed) {
			t.Errorf("failed: got %+v, want %+v", failed, wantFailed)
		}
		if !equalProgress(succeeded, failed) {
			t.Errorf("succeeded: got %+v, want the same progress %+v", succeeded, failed)
		}
	})

	t.Run("lastTool is the bare tool name when the input has nothing to summarize", func(t *testing.T) {
		progress := ReduceProgress(INITIAL_PROGRESS, WorkerEvent{Kind: WorkerEventToolUse, Name: "TodoWrite"})

		if progress.LastTool == nil || *progress.LastTool != "TodoWrite" {
			t.Errorf("lastTool: got %v, want TodoWrite", progress.LastTool)
		}
	})
	t.Run("result sets phase done and turns", func(t *testing.T) {
		thinking := INITIAL_PROGRESS
		thinking.Phase = ProgressPhaseThinking

		progress := ReduceProgress(thinking, WorkerEvent{
			Kind:    WorkerEventResult,
			Text:    "done",
			Turns:   7,
			CostUSD: 0.5,
			Usage:   ResultUsage{InputTokens: 1, OutputTokens: 2, CacheReadTokens: 3, CacheWriteTokens: 4},
		})

		want := thinking
		want.Phase = ProgressPhaseDone
		want.Turns = 7
		if !equalProgress(progress, want) {
			t.Errorf("got %+v, want %+v", progress, want)
		}
	})
	t.Run("other events leave progress unchanged (same object)", func(t *testing.T) {
		thinking := INITIAL_PROGRESS
		thinking.Phase = ProgressPhaseThinking
		thinking.LastText = "x"

		if got := ReduceProgress(thinking, WorkerEvent{Kind: WorkerEventOther, Raw: `{"type": "system", "subtype": "status"}`}); !equalProgress(got, thinking) {
			t.Errorf("got %+v, want the same progress %+v", got, thinking)
		}
		// A Kind outside the known ones changes nothing either.
		if got := ReduceProgress(thinking, WorkerEvent{Kind: "bogus"}); !equalProgress(got, thinking) {
			t.Errorf("unknown kind: got %+v, want the same progress %+v", got, thinking)
		}
	})
}

func TestFinalizeWorker(t *testing.T) {
	t.Run("result with is_error false → completed, report = structured_output", func(t *testing.T) {
		finished := FinalizeWorker(eventFixtureEvents(t, "success-edit.jsonl"), cleanExit(), nil)

		if want := (WorkerOutcome{Kind: WorkerOutcomeCompleted}); !equalOutcome(finished.Outcome, want) {
			t.Errorf("outcome: got %+v, want %+v", finished.Outcome, want)
		}
		wantReport := `{"summary":"Fixed the off-by-one in range()","files":[{"path":"src/range.ts","why":"end bound was exclusive"}],"root_cause":"loop used < instead of <=","tests_added":[],"open_items":[]}`
		if got := compactRaw(t, finished.Report); got != wantReport {
			t.Errorf("report: got %s, want %s", got, wantReport)
		}
	})
	t.Run("result with is_error true → api_error with the result text; status 429 when the text contains (429)", func(t *testing.T) {
		limited := "API Error: Request rejected (429) · [1302][Rate limit reached for requests]"
		plain := "API Error: Connection error."

		rateLimitedEvent := resultEvent()
		rateLimitedEvent.IsError = true
		rateLimitedEvent.Text = limited
		otherEvent := resultEvent()
		otherEvent.IsError = true
		otherEvent.Text = plain

		rateLimited := FinalizeWorker([]WorkerEvent{rateLimitedEvent}, cleanExit(), nil)
		other := FinalizeWorker([]WorkerEvent{otherEvent}, cleanExit(), nil)

		wantLimited := WorkerOutcome{Kind: WorkerOutcomeAPIError, Message: limited, Status: i64Ptr(429)}
		if !equalOutcome(rateLimited.Outcome, wantLimited) {
			t.Errorf("rate limited: got %+v, want %+v", rateLimited.Outcome, wantLimited)
		}
		wantOther := WorkerOutcome{Kind: WorkerOutcomeAPIError, Message: plain}
		if !equalOutcome(other.Outcome, wantOther) {
			t.Errorf("other: got %+v, want %+v", other.Outcome, wantOther)
		}
	})

	for _, row := range []struct {
		name   string
		text   string
		status int64
	}{
		{"Z.ai 1113", `API Error: 429 {"error":{"code":"1113","message":"Insufficient balance or no resource package"}}`, 429},
		{"Z.ai 1316", `API Error: 429 {"error":{"code":"1316","message":"usage cap reached"}}`, 429},
		{"Moonshot", `API Error: 429 {"error":{"type":"exceeded_current_quota_error","message":"Your account is suspended"}}`, 429},
		{"DeepSeek", "API Error: 402 Insufficient Balance", 402},
		{"MiniMax 1008", `API Error: 500 {"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}`, 500},
		{"DashScope", `API Error: 400 {"code":"Arrearage","message":"Access denied"}`, 400},
	} {
		t.Run("a provider's out-of-balance answer ("+row.name+") is a quota api_error", func(t *testing.T) {
			event := resultEvent()
			event.IsError = true
			event.Text = row.text
			event.APIErrorStatus = i64Ptr(row.status)

			run := FinalizeWorker([]WorkerEvent{event}, cleanExit(), nil)

			want := WorkerOutcome{Kind: WorkerOutcomeAPIError, Message: row.text, Status: i64Ptr(row.status), Quota: boolPtr(true)}
			if !equalOutcome(run.Outcome, want) {
				t.Errorf("outcome: got %+v, want %+v", run.Outcome, want)
			}
		})
	}

	t.Run("a rate limit is not out of balance, nor is a code that only looks like one in prose", func(t *testing.T) {
		limited := "API Error: Request rejected (429) · [1302][Rate limit reached for requests]"
		prose := "API Error: 500 the request id 1113 failed"

		limitedEvent := resultEvent()
		limitedEvent.IsError = true
		limitedEvent.Text = limited
		proseEvent := resultEvent()
		proseEvent.IsError = true
		proseEvent.Text = prose

		if outcome := FinalizeWorker([]WorkerEvent{limitedEvent}, cleanExit(), nil).Outcome; outcome.Quota != nil {
			t.Errorf("limited: got quota %v, want none", *outcome.Quota)
		}
		if outcome := FinalizeWorker([]WorkerEvent{proseEvent}, cleanExit(), nil).Outcome; outcome.Quota != nil {
			t.Errorf("prose: got quota %v, want none", *outcome.Quota)
		}
	})

	t.Run("an api_error with no status found carries no status key at all", func(t *testing.T) {
		event := resultEvent()
		event.IsError = true
		event.Text = "API Error: Connection error."

		failed := FinalizeWorker([]WorkerEvent{event}, cleanExit(), nil)

		want := WorkerOutcome{Kind: WorkerOutcomeAPIError, Message: "API Error: Connection error."}
		if !equalOutcome(failed.Outcome, want) {
			t.Errorf("outcome: got %+v, want %+v", failed.Outcome, want)
		}
	})
	t.Run("prefers the result's apiErrorStatus over a status found in the text", func(t *testing.T) {
		text := "API Error: Request rejected (429) · upstream said (503)"

		liveEvent := resultEvent()
		liveEvent.IsError = true
		liveEvent.Text = text
		liveEvent.APIErrorStatus = i64Ptr(529)
		fromTextEvent := resultEvent()
		fromTextEvent.IsError = true
		fromTextEvent.Text = text

		live := FinalizeWorker([]WorkerEvent{liveEvent}, cleanExit(), nil)
		fromText := FinalizeWorker([]WorkerEvent{fromTextEvent}, cleanExit(), nil)

		wantLive := WorkerOutcome{Kind: WorkerOutcomeAPIError, Message: text, Status: i64Ptr(529)}
		if !equalOutcome(live.Outcome, wantLive) {
			t.Errorf("live: got %+v, want %+v", live.Outcome, wantLive)
		}
		wantFromText := WorkerOutcome{Kind: WorkerOutcomeAPIError, Message: text, Status: i64Ptr(429)}
		if !equalOutcome(fromText.Outcome, wantFromText) {
			t.Errorf("from text: got %+v, want %+v", fromText.Outcome, wantFromText)
		}
	})
	t.Run("the rate-limited-429 fixture → api_error status 429 with rateLimitRetries 10", func(t *testing.T) {
		exit := cleanExit()
		exit.Code = i64Ptr(1)

		finished := FinalizeWorker(eventFixtureEvents(t, "rate-limited-429.jsonl"), exit, nil)

		want := WorkerOutcome{
			Kind: WorkerOutcomeAPIError,
			Message: "API Error: Request rejected (429) · [1302][Rate limit reached for requests]" +
				"[202610060644290fbcd9bc36024c65]",
			Status: i64Ptr(429),
		}
		if !equalOutcome(finished.Outcome, want) {
			t.Errorf("outcome: got %+v, want %+v", finished.Outcome, want)
		}
		if finished.Usage.RateLimitRetries != 10 {
			t.Errorf("rateLimitRetries: got %d, want 10", finished.Usage.RateLimitRetries)
		}
	})
	t.Run("forced timeout/stopped wins over any result", func(t *testing.T) {
		completed := eventFixtureEvents(t, "success-edit.jsonl")
		killed := WorkerExit{Signal: strPtr("SIGTERM")}
		timeout := ForcedTimeout
		stopped := ForcedStopped

		if got := FinalizeWorker(completed, killed, &timeout).Outcome; !equalOutcome(got, WorkerOutcome{Kind: WorkerOutcomeTimeout}) {
			t.Errorf("timeout: got %+v, want a timeout outcome", got)
		}
		if got := FinalizeWorker(completed, killed, &stopped).Outcome; !equalOutcome(got, WorkerOutcome{Kind: WorkerOutcomeStopped}) {
			t.Errorf("stopped: got %+v, want a stopped outcome", got)
		}
		if got := FinalizeWorker(nil, killed, &stopped).Outcome; !equalOutcome(got, WorkerOutcome{Kind: WorkerOutcomeStopped}) {
			t.Errorf("stopped with no events: got %+v, want a stopped outcome", got)
		}
	})
	t.Run("no result event and non-zero exit → crashed with code, signal and stderr tail", func(t *testing.T) {
		exit := WorkerExit{Code: i64Ptr(137), Signal: strPtr("SIGKILL"), StderrTail: "FATAL ERROR: heap out of memory"}

		finished := FinalizeWorker(eventFixtureEvents(t, "crash-no-result.jsonl"), exit, nil)

		want := WorkerOutcome{
			Kind:       WorkerOutcomeCrashed,
			ExitCode:   i64Ptr(137),
			Signal:     strPtr("SIGKILL"),
			StderrTail: "FATAL ERROR: heap out of memory",
		}
		if !equalOutcome(finished.Outcome, want) {
			t.Errorf("outcome: got %+v, want %+v", finished.Outcome, want)
		}
		if finished.Report != nil {
			t.Errorf("report: got %s, want nil", finished.Report)
		}
	})
	t.Run("no result event and exit 0 → crashed (a run must end with a result)", func(t *testing.T) {
		finished := FinalizeWorker(eventFixtureEvents(t, "crash-no-result.jsonl"), cleanExit(), nil)

		want := WorkerOutcome{Kind: WorkerOutcomeCrashed, ExitCode: i64Ptr(0)}
		if !equalOutcome(finished.Outcome, want) {
			t.Errorf("outcome: got %+v, want %+v", finished.Outcome, want)
		}
	})
	t.Run("usage sums tokens from the last result and counts api_retry events", func(t *testing.T) {
		// Only 429s count: rateLimitRetries feeds the AIMD limiter, and an overloaded (529) or
		// network retry is not pressure on the shared Z.ai request budget.
		retry := func(status *int64) WorkerEvent {
			return WorkerEvent{Kind: WorkerEventAPIRetry, Attempt: 1, MaxRetries: 10, Status: status}
		}
		first := resultEvent()
		first.Usage = ResultUsage{InputTokens: 9, OutputTokens: 9, CacheReadTokens: 9, CacheWriteTokens: 9}
		last := resultEvent()
		last.Turns = 4
		last.DurationMs = 5000
		last.CostUSD = 0.25
		last.Usage = ResultUsage{InputTokens: 100, OutputTokens: 20, CacheReadTokens: 300, CacheWriteTokens: 40}
		events := []WorkerEvent{
			retry(i64Ptr(429)),
			first,
			retry(i64Ptr(529)),
			retry(nil),
			retry(i64Ptr(429)),
			last,
		}

		usage := FinalizeWorker(events, cleanExit(), nil).Usage

		want := Usage{
			Turns:            4,
			InputTokens:      100,
			OutputTokens:     20,
			CacheReadTokens:  300,
			CacheWriteTokens: 40,
			CostUSD:          0.25,
			RateLimitRetries: 2,
			DurationMs:       5000,
		}
		if !equalUsage(usage, want) {
			t.Errorf("usage: got %+v, want %+v", usage, want)
		}
	})

	t.Run("usage is all zeros but the retry count when no result arrived", func(t *testing.T) {
		events := []WorkerEvent{{Kind: WorkerEventAPIRetry, Attempt: 1, MaxRetries: 10, Status: i64Ptr(429)}}

		usage := FinalizeWorker(events, cleanExit(), nil).Usage

		want := Usage{RateLimitRetries: 1}
		if !equalUsage(usage, want) {
			t.Errorf("usage: got %+v, want %+v", usage, want)
		}
	})
	t.Run("sessionId comes from init, and the first session event beats it — an engine-keyed session announces its own id", func(t *testing.T) {
		withInit := FinalizeWorker(eventFixtureEvents(t, "success-edit.jsonl"), cleanExit(), nil)
		withoutInit := FinalizeWorker([]WorkerEvent{resultEvent()}, cleanExit(), nil)
		engineKeyed := FinalizeWorker([]WorkerEvent{
			{Kind: WorkerEventInit, SessionID: "caller-key", Model: strPtr("glm-5.3")},
			{Kind: WorkerEventSession, SessionID: "engine-id-1"},
			{Kind: WorkerEventSession, SessionID: "engine-id-2"},
			resultEvent(),
		}, cleanExit(), nil)
		sessionOnly := FinalizeWorker([]WorkerEvent{
			{Kind: WorkerEventSession, SessionID: "engine-id-1"},
			resultEvent(),
		}, cleanExit(), nil)

		if withInit.SessionID == nil || *withInit.SessionID != "11111111-1111-4111-8111-111111111111" {
			t.Errorf("withInit sessionId: got %v, want the init line's", withInit.SessionID)
		}
		if withoutInit.SessionID != nil {
			t.Errorf("withoutInit sessionId: got %v, want none", *withoutInit.SessionID)
		}
		if engineKeyed.SessionID == nil || *engineKeyed.SessionID != "engine-id-1" {
			t.Errorf("engineKeyed sessionId: got %v, want engine-id-1", engineKeyed.SessionID)
		}
		if sessionOnly.SessionID == nil || *sessionOnly.SessionID != "engine-id-1" {
			t.Errorf("sessionOnly sessionId: got %v, want engine-id-1", sessionOnly.SessionID)
		}
	})
}
