package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// streamFixtureLines reads a stream-json fixture as the worker's line reader splits it.
func streamFixtureLines(t *testing.T, name string) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "stream", name))
	if err != nil {
		t.Fatalf("read stream fixture %s: %v", name, err)
	}
	return strings.Split(string(raw), "\n")
}

func streamFixtureLine(t *testing.T, name string, lineNumber int) string {
	t.Helper()
	lines := streamFixtureLines(t, name)
	if lineNumber < 1 || lineNumber > len(lines) {
		t.Fatalf("%s has no line %d", name, lineNumber)
	}
	return lines[lineNumber-1]
}

// streamFixtureNames lists the stream fixtures' .jsonl file names, sorted as ReadDir returns them.
func streamFixtureNames(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join("..", "..", "testdata", "stream"))
	if err != nil {
		t.Fatalf("read the stream fixtures directory: %v", err)
	}
	var names []string
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".jsonl") {
			names = append(names, entry.Name())
		}
	}
	return names
}

// compactRaw renders raw JSON with its whitespace out, so two fragments that differ only in
// spacing compare equal (toEqual's structural equality).
func compactRaw(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	if len(raw) == 0 {
		return ""
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		t.Fatalf("compact %s: %v", raw, err)
	}
	return buf.String()
}

// workerEventsEqual is toEqual on worker events: the structured output compares as parsed JSON,
// not as the bytes either side happens to carry.
func workerEventsEqual(got, want []WorkerEvent) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		left, right := got[i], want[i]
		if compactRawBytes(left.StructuredOutput) != compactRawBytes(right.StructuredOutput) {
			return false
		}
		left.StructuredOutput, right.StructuredOutput = nil, nil
		if !reflect.DeepEqual(left, right) {
			return false
		}
	}
	return true
}

func compactRawBytes(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var buf bytes.Buffer
	if json.Compact(&buf, raw) != nil {
		return string(raw)
	}
	return buf.String()
}

func TestParseStreamLine(t *testing.T) {
	t.Run("system/init → init with session_id and model (fixture rate-limited-429.jsonl line 3)", func(t *testing.T) {
		events, err := ParseStreamLine(streamFixtureLine(t, "rate-limited-429.jsonl", 3))
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		want := []WorkerEvent{{
			Kind:      WorkerEventInit,
			SessionID: "13d60183-de73-441c-ae75-5fc27a410511",
			Model:     strPtr("glm-5.3-flash"),
		}}
		if !reflect.DeepEqual(events, want) {
			t.Errorf("got %+v, want %+v", events, want)
		}
	})
	t.Run("system/api_retry → api_retry with attempt, max_retries and error_status", func(t *testing.T) {
		events, err := ParseStreamLine(streamFixtureLine(t, "rate-limited-429.jsonl", 7))
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		want := []WorkerEvent{{Kind: WorkerEventAPIRetry, Attempt: 3, MaxRetries: 10, Status: i64Ptr(429)}}
		if !reflect.DeepEqual(events, want) {
			t.Errorf("got %+v, want %+v", events, want)
		}
	})
	t.Run("assistant message text blocks → assistant_text; tool_use blocks → tool_use with name and a short input summary", func(t *testing.T) {
		parseOne := func(line string) []WorkerEvent {
			t.Helper()
			events, err := ParseStreamLine(line)
			if err != nil {
				t.Fatalf("parse %s: %v", line, err)
			}
			return events
		}
		text := parseOne(streamFixtureLine(t, "success-edit.jsonl", 9))
		edit := parseOne(streamFixtureLine(t, "success-edit.jsonl", 13))
		bash := parseOne(streamFixtureLine(t, "tool-error.jsonl", 6))

		wantText := []WorkerEvent{{Kind: WorkerEventAssistantText, Text: "I'll fix the off-by-one in src/range.ts."}}
		wantEdit := []WorkerEvent{{Kind: WorkerEventToolUse, Name: "Edit", Summary: "/work/repo/src/range.ts"}}
		wantBash := []WorkerEvent{{Kind: WorkerEventToolUse, Name: "Bash", Summary: "npm test"}}
		if !reflect.DeepEqual(text, wantText) {
			t.Errorf("text: got %+v, want %+v", text, wantText)
		}
		if !reflect.DeepEqual(edit, wantEdit) {
			t.Errorf("edit: got %+v, want %+v", edit, wantEdit)
		}
		if !reflect.DeepEqual(bash, wantBash) {
			t.Errorf("bash: got %+v, want %+v", bash, wantBash)
		}
	})
	t.Run("tool_use summary is the most telling input field on one line, else compact JSON, capped at 80 chars", func(t *testing.T) {
		summaryOf := func(input string) string {
			t.Helper()
			line := fmt.Sprintf(
				`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_x","name":"T","input":%s}]}}`,
				input)
			events, err := ParseStreamLine(line)
			if err != nil {
				t.Fatalf("parse %s: %v", line, err)
			}
			if len(events) != 1 || events[0].Kind != WorkerEventToolUse {
				t.Fatalf("%s: got %+v, want one tool_use event", line, events)
			}
			return events[0].Summary
		}
		rows := []struct {
			input string
			want  string
		}{
			{`{"pattern":"TODO","path":"src"}`, "TODO"},
			{`{"path":"src","glob":"*.ts"}`, "src"},
			{`{"notebook_path":"a.ipynb"}`, "a.ipynb"},
			{`{"url":"https://example.com","prompt":"read"}`, "https://example.com"},
			{`{"query":"zod v4","allowed_domains":[]}`, "zod v4"},
			{`{"description":"Explore","prompt":"find x"}`, "Explore"},
			{`{"prompt":"find x"}`, "find x"},
			{`{"skill":"tdd"}`, "tdd"},
			{`{"command":"npm test\n  && npm run lint"}`, "npm test && npm run lint"},
			{`{"todos":[{"id":1}]}`, `{"todos":[{"id":1}]}`},
			{`{"command":"  npm test\n"}`, "npm test"},
			{`{}`, ""},
			{`"raw"`, ""},
			{`null`, ""},
			{fmt.Sprintf(`{"command":"%s"}`, strings.Repeat("x", 200)), strings.Repeat("x", 79) + "…"},
			{fmt.Sprintf(`{"command":"%s"}`, strings.Repeat("x", 80)), strings.Repeat("x", 80)},
		}
		for _, row := range rows {
			if got := summaryOf(row.input); got != row.want {
				t.Errorf("summaryOf(%s) = %q, want %q", row.input, got, row.want)
			}
		}
	})
	t.Run("a multi-block assistant message keeps every block in order; adjacent text blocks join", func(t *testing.T) {
		line := `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"Running tests."},{"type":"tool_use","id":"toolu_y","name":"Bash","input":{"command":"npm test"}},{"type":"text","text":"Then "},{"type":"text","text":"lint."},{"type":"tool_use","id":"toolu_z","name":"Bash","input":{"command":"npm run lint"}}]}}`
		twoTexts := `{"type":"assistant","message":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}`

		events, err := ParseStreamLine(line)
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		joined, err := ParseStreamLine(twoTexts)
		if err != nil {
			t.Fatalf("parse twoTexts: %v", err)
		}

		want := []WorkerEvent{
			{Kind: WorkerEventAssistantText, Text: "Running tests."},
			{Kind: WorkerEventToolUse, Name: "Bash", Summary: "npm test"},
			{Kind: WorkerEventAssistantText, Text: "Then lint."},
			{Kind: WorkerEventToolUse, Name: "Bash", Summary: "npm run lint"},
		}
		if !reflect.DeepEqual(events, want) {
			t.Errorf("got %+v, want %+v", events, want)
		}
		wantJoined := []WorkerEvent{{Kind: WorkerEventAssistantText, Text: "ab"}}
		if !reflect.DeepEqual(joined, wantJoined) {
			t.Errorf("twoTexts: got %+v, want %+v", joined, wantJoined)
		}
	})
	t.Run("api_retry without an HTTP status (network error) → status null", func(t *testing.T) {
		events, err := ParseStreamLine(`{"type": "system", "subtype": "api_retry", "attempt": 1, "max_retries": 10, "error_status": null}`)
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		want := []WorkerEvent{{Kind: WorkerEventAPIRetry, Attempt: 1, MaxRetries: 10}}
		if !reflect.DeepEqual(events, want) {
			t.Errorf("got %+v, want %+v", events, want)
		}
	})
	t.Run("result with missing accounting fields counts them as 0, a missing text as empty, no api_error_status as null", func(t *testing.T) {
		events, err := ParseStreamLine(`{"type": "result", "subtype": "error_max_turns", "is_error": true, "usage": null}`)
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		want := []WorkerEvent{{
			Kind:    WorkerEventResult,
			IsError: true,
		}}
		if !reflect.DeepEqual(events, want) {
			t.Errorf("got %+v, want %+v", events, want)
		}
	})
	t.Run("result carries the live api_error_status as apiErrorStatus; a non-numeric one reads as null", func(t *testing.T) {
		limited, err := ParseStreamLine(streamFixtureLine(t, "rate-limited-429.jsonl", 16))
		if err != nil {
			t.Fatalf("parse fixture: %v", err)
		}
		odd, err := ParseStreamLine(`{"type": "result", "is_error": true, "api_error_status": "429"}`)
		if err != nil {
			t.Fatalf("parse odd: %v", err)
		}

		if len(limited) != 1 || limited[0].Kind != WorkerEventResult || limited[0].APIErrorStatus == nil || *limited[0].APIErrorStatus != 429 {
			t.Errorf("limited: got %+v, want one result with apiErrorStatus 429", limited)
		}
		if len(odd) != 1 || odd[0].Kind != WorkerEventResult || odd[0].APIErrorStatus != nil {
			t.Errorf("odd: got %+v, want one result with a nil apiErrorStatus", odd)
		}
	})
	t.Run("user messages: tool_result is_error omitted means success; any failed block makes it an error", func(t *testing.T) {
		user := func(content string) string {
			return fmt.Sprintf(`{"type": "user", "message": {"role": "user", "content": %s}}`, content)
		}
		ok, err := ParseStreamLine(user(`[{"type": "tool_result", "tool_use_id": "a", "content": "ok"}]`))
		if err != nil {
			t.Fatalf("parse ok: %v", err)
		}
		boom, err := ParseStreamLine(user(`[{"type": "tool_result", "tool_use_id": "a", "content": "ok", "is_error": false},{"type": "tool_result", "tool_use_id": "b", "content": "boom", "is_error": true}]`))
		if err != nil {
			t.Fatalf("parse boom: %v", err)
		}

		wantOK := []WorkerEvent{{Kind: WorkerEventToolResult}}
		wantBoom := []WorkerEvent{{Kind: WorkerEventToolResult, IsError: true}}
		if !reflect.DeepEqual(ok, wantOK) {
			t.Errorf("ok: got %+v, want %+v", ok, wantOK)
		}
		if !reflect.DeepEqual(boom, wantBoom) {
			t.Errorf("boom: got %+v, want %+v", boom, wantBoom)
		}
	})
	t.Run("user messages without tool_result blocks are other; text beside a tool_result is ignored", func(t *testing.T) {
		user := func(content string) string {
			return fmt.Sprintf(`{"type": "user", "message": {"role": "user", "content": %s}}`, content)
		}
		textOnly := user(`[{"type": "text", "text": "Continue."}]`)
		mixed := user(`[{"type": "text", "text": "note"},{"type": "tool_result", "tool_use_id": "a", "content": "boom", "is_error": true}]`)

		other, err := ParseStreamLine(textOnly)
		if err != nil {
			t.Fatalf("parse textOnly: %v", err)
		}
		result, err := ParseStreamLine(mixed)
		if err != nil {
			t.Fatalf("parse mixed: %v", err)
		}

		wantOther := []WorkerEvent{{Kind: WorkerEventOther, Raw: textOnly}}
		wantResult := []WorkerEvent{{Kind: WorkerEventToolResult, IsError: true}}
		if !reflect.DeepEqual(other, wantOther) {
			t.Errorf("textOnly: got %+v, want %+v", other, wantOther)
		}
		if !reflect.DeepEqual(result, wantResult) {
			t.Errorf("mixed: got %+v, want %+v", result, wantResult)
		}
	})
	t.Run("stream_event content_block_delta text → text_delta", func(t *testing.T) {
		events, err := ParseStreamLine(streamFixtureLine(t, "success-edit.jsonl", 7))
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		want := []WorkerEvent{{Kind: WorkerEventTextDelta, Text: "off-by-one in "}}
		if !reflect.DeepEqual(events, want) {
			t.Errorf("got %+v, want %+v", events, want)
		}
	})
	t.Run("user tool_result blocks → tool_result with is_error", func(t *testing.T) {
		failed, err := ParseStreamLine(streamFixtureLine(t, "tool-error.jsonl", 10))
		if err != nil {
			t.Fatalf("parse failed: %v", err)
		}
		succeeded, err := ParseStreamLine(streamFixtureLine(t, "success-edit.jsonl", 17))
		if err != nil {
			t.Fatalf("parse succeeded: %v", err)
		}

		wantFailed := []WorkerEvent{{Kind: WorkerEventToolResult, IsError: true}}
		wantSucceeded := []WorkerEvent{{Kind: WorkerEventToolResult}}
		if !reflect.DeepEqual(failed, wantFailed) {
			t.Errorf("failed: got %+v, want %+v", failed, wantFailed)
		}
		if !reflect.DeepEqual(succeeded, wantSucceeded) {
			t.Errorf("succeeded: got %+v, want %+v", succeeded, wantSucceeded)
		}
	})
	t.Run("result → result reading is_error independently of subtype (fixture: subtype success + is_error true)", func(t *testing.T) {
		events, err := ParseStreamLine(streamFixtureLine(t, "rate-limited-429.jsonl", 16))
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		if len(events) != 1 || events[0].Kind != WorkerEventResult {
			t.Fatalf("got %+v, want one result event", events)
		}
		result := events[0]
		if !result.IsError {
			t.Error("isError is false, want true (it is independent of subtype)")
		}
		if want := "API Error: Request rejected (429) · [1302][Rate limit reached for requests][202610060644290fbcd9bc36024c65]"; result.Text != want {
			t.Errorf("text: got %q, want %q", result.Text, want)
		}
		if result.StructuredOutput != nil {
			t.Errorf("structuredOutput: got %s, want nil", result.StructuredOutput)
		}
	})
	t.Run("result maps usage tokens (input, output, cache read, cache creation) and total_cost_usd, num_turns, duration_ms", func(t *testing.T) {
		events, err := ParseStreamLine(streamFixtureLine(t, "success-edit.jsonl", 26))
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		if len(events) != 1 || events[0].Kind != WorkerEventResult {
			t.Fatalf("got %+v, want one result event", events)
		}
		result := events[0]
		if result.IsError {
			t.Error("isError is true, want false")
		}
		if want := "Fixed the off-by-one in range()."; result.Text != want {
			t.Errorf("text: got %q, want %q", result.Text, want)
		}
		wantReport := `{"summary":"Fixed the off-by-one in range()","files":[{"path":"src/range.ts","why":"end bound was exclusive"}],"root_cause":"loop used < instead of <=","tests_added":[],"open_items":[]}`
		if got := compactRaw(t, result.StructuredOutput); got != wantReport {
			t.Errorf("structuredOutput: got %s, want %s", got, wantReport)
		}
		if result.Turns != 3 {
			t.Errorf("turns: got %d, want 3", result.Turns)
		}
		if result.DurationMs != 42130 {
			t.Errorf("durationMs: got %d, want 42130", result.DurationMs)
		}
		if result.CostUSD != 0.0123 {
			t.Errorf("costUsd: got %v, want 0.0123", result.CostUSD)
		}
		wantUsage := ResultUsage{InputTokens: 4200, OutputTokens: 310, CacheReadTokens: 2800, CacheWriteTokens: 900}
		if result.Usage != wantUsage {
			t.Errorf("usage: got %+v, want %+v", result.Usage, wantUsage)
		}
		if result.APIErrorStatus != nil {
			t.Errorf("apiErrorStatus: got %d, want nil", *result.APIErrorStatus)
		}
	})
	t.Run("unknown types and hook events → other, never an error", func(t *testing.T) {
		lines := []string{
			streamFixtureLine(t, "rate-limited-429.jsonl", 1),
			streamFixtureLine(t, "rate-limited-429.jsonl", 2),
			streamFixtureLine(t, "rate-limited-429.jsonl", 4),
			streamFixtureLine(t, "success-edit.jsonl", 1),
			streamFixtureLine(t, "success-edit.jsonl", 4),
			`{"type": "rate_limit_event", "rate_limit_info": {"status": "allowed"}}`,
			`{"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "hmm"}]}}`,
			`{"type": "user", "message": {"role": "user", "content": "plain prompt text"}}`,
			`{"type": "result", "subtype": "success"}`,
			`[1, 2]`,
		}
		for _, line := range lines {
			events, err := ParseStreamLine(line)
			if err != nil {
				t.Fatalf("%s: parse: %v", line, err)
			}
			want := []WorkerEvent{{Kind: WorkerEventOther, Raw: line}}
			if !reflect.DeepEqual(events, want) {
				t.Errorf("%s: got %+v, want %+v", line, events, want)
			}
		}
	})
	t.Run("blank line → no events; malformed JSON → error with a short message", func(t *testing.T) {
		truncated := `{"type": "assistant", "message": {"content": [{"type": "text", "text": "` + strings.Repeat("x", 500)

		for _, blank := range []string{"", "  \t\r"} {
			events, err := ParseStreamLine(blank)
			if err != nil {
				t.Fatalf("%q: parse: %v", blank, err)
			}
			if len(events) != 0 {
				t.Errorf("%q: got %+v, want no events", blank, events)
			}
		}
		_, err := ParseStreamLine(truncated)
		if err == nil {
			t.Fatal("malformed JSON parses, want an error")
		}
		if message := err.Error(); !strings.HasPrefix(message, "malformed JSON: ") || len(message) > 120 {
			t.Errorf("error: got %q, want a \"malformed JSON: \" prefix and at most 120 characters", message)
		}
	})
	t.Run("parses every line of every fixture without error", func(t *testing.T) {
		names := streamFixtureNames(t)
		for _, required := range []string{
			"crash-no-result.jsonl",
			"rate-limited-429.jsonl",
			"success-edit.jsonl",
			"tool-error.jsonl",
		} {
			if !slices.Contains(names, required) {
				t.Errorf("the stream fixtures are missing %s (have %v)", required, names)
			}
		}
		for _, name := range names {
			for index, line := range streamFixtureLines(t, name) {
				if line == "" {
					continue
				}
				events, err := ParseStreamLine(line)
				if err != nil {
					t.Errorf("%s line %d: parse: %v", name, index+1, err)
					continue
				}
				if len(events) == 0 {
					t.Errorf("%s line %d: no events, want at least one", name, index+1)
				}
			}
		}
	})
}

func TestSharedEventFixtures(t *testing.T) {
	t.Run("are what parseStreamLine reads from each stream fixture, event for event", func(t *testing.T) {
		names := streamFixtureNames(t)

		eventEntries, err := os.ReadDir(filepath.Join("..", "..", "testdata", "events"))
		if err != nil {
			t.Fatalf("read the event fixtures directory: %v", err)
		}
		var eventNames []string
		for _, entry := range eventEntries {
			if strings.HasSuffix(entry.Name(), ".jsonl") {
				eventNames = append(eventNames, entry.Name())
			}
		}
		if !reflect.DeepEqual(names, eventNames) {
			t.Fatalf("the event fixtures %v do not mirror the stream fixtures %v", eventNames, names)
		}
		for _, name := range names {
			var got []WorkerEvent
			for _, line := range streamFixtureLines(t, name) {
				if line == "" {
					continue
				}
				events, err := ParseStreamLine(line)
				if err != nil {
					t.Fatalf("%s: parse %s: %v", name, line, err)
				}
				got = append(got, events...)
			}
			raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "events", name))
			if err != nil {
				t.Fatalf("read event fixture %s: %v", name, err)
			}
			var want []WorkerEvent
			for _, line := range strings.Split(string(raw), "\n") {
				if line == "" {
					continue
				}
				var event WorkerEvent
				if err := json.Unmarshal([]byte(line), &event); err != nil {
					t.Fatalf("%s: decode %s: %v", name, line, err)
				}
				want = append(want, event)
			}
			if !workerEventsEqual(got, want) {
				t.Errorf("%s: got %d events, want the recorded %d", name, len(got), len(want))
			}
		}
	})
}

// The stream parser names only the keys it reads and degrades to `other` on any shape that no
// longer matches, so new Claude Code versions never break parsing. These rows pin that behaviour
// directly.
func TestParseStreamLineShapeMismatch(t *testing.T) {
	rows := []struct {
		name string
		line string
		want []WorkerEvent
	}{
		{
			"a non-string session_id fails the init schema",
			`{"type": "system", "subtype": "init", "session_id": 42, "model": "m"}`,
			[]WorkerEvent{{Kind: WorkerEventOther, Raw: `{"type": "system", "subtype": "init", "session_id": 42, "model": "m"}`}},
		},
		{
			"a non-number attempt fails the api_retry schema",
			`{"type": "system", "subtype": "api_retry", "attempt": "soon", "max_retries": 10, "error_status": 429}`,
			[]WorkerEvent{{Kind: WorkerEventOther, Raw: `{"type": "system", "subtype": "api_retry", "attempt": "soon", "max_retries": 10, "error_status": 429}`}},
		},
		{
			"a non-number model fails the init schema",
			`{"type": "system", "subtype": "init", "session_id": "s", "model": 5}`,
			[]WorkerEvent{{Kind: WorkerEventOther, Raw: `{"type": "system", "subtype": "init", "session_id": "s", "model": 5}`}},
		},
		{
			"a non-number max_retries fails the api_retry schema",
			`{"type": "system", "subtype": "api_retry", "attempt": 1, "max_retries": "x", "error_status": 429}`,
			[]WorkerEvent{{Kind: WorkerEventOther, Raw: `{"type": "system", "subtype": "api_retry", "attempt": 1, "max_retries": "x", "error_status": 429}`}},
		},
		{
			"a non-number, non-null error_status fails the api_retry schema",
			`{"type": "system", "subtype": "api_retry", "attempt": 1, "max_retries": 2, "error_status": "429"}`,
			[]WorkerEvent{{Kind: WorkerEventOther, Raw: `{"type": "system", "subtype": "api_retry", "attempt": 1, "max_retries": 2, "error_status": "429"}`}},
		},
		{
			"a system line without a subtype matches nothing",
			`{"type": "system"}`,
			[]WorkerEvent{{Kind: WorkerEventOther, Raw: `{"type": "system"}`}},
		},
		{
			"an assistant line without its message fails the schema",
			`{"type": "assistant"}`,
			[]WorkerEvent{{Kind: WorkerEventOther, Raw: `{"type": "assistant"}`}},
		},
		{
			"a stream_event line without its event fails the schema",
			`{"type": "stream_event"}`,
			[]WorkerEvent{{Kind: WorkerEventOther, Raw: `{"type": "stream_event"}`}},
		},
		{
			"a missing error_status is nullish, not a failure",
			`{"type": "system", "subtype": "api_retry", "attempt": 1, "max_retries": 10}`,
			[]WorkerEvent{{Kind: WorkerEventAPIRetry, Attempt: 1, MaxRetries: 10}},
		},
		{
			"blocks that are not objects or carry no payload are skipped",
			`{"type": "assistant", "message": {"content": [5, "str", {"type": "text"}, {"type": "tool_use", "input": {}}, {"type": "text", "text": "a"}]}}`,
			[]WorkerEvent{{Kind: WorkerEventAssistantText, Text: "a"}},
		},
		{
			"a text_delta without text fails the delta schema",
			`{"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta"}}}`,
			[]WorkerEvent{{Kind: WorkerEventOther, Raw: `{"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta"}}}`}},
		},
		{
			"a tool_result block whose is_error is not a boolean is skipped",
			`{"type": "user", "message": {"content": [{"type": "tool_result", "is_error": "yes"}]}}`,
			[]WorkerEvent{{Kind: WorkerEventOther, Raw: `{"type": "user", "message": {"content": [{"type": "tool_result", "is_error": "yes"}]}}`}},
		},
		{
			"a non-boolean is_error fails the result schema",
			`{"type": "result", "is_error": "yes"}`,
			[]WorkerEvent{{Kind: WorkerEventOther, Raw: `{"type": "result", "is_error": "yes"}`}},
		},
		{
			"a non-string result fails the result schema",
			`{"type": "result", "is_error": true, "result": 5}`,
			[]WorkerEvent{{Kind: WorkerEventOther, Raw: `{"type": "result", "is_error": true, "result": 5}`}},
		},
		{
			"an odd num_turns counts as 0",
			`{"type": "result", "is_error": false, "num_turns": "three"}`,
			[]WorkerEvent{{Kind: WorkerEventResult}},
		},
		{
			"an odd usage count counts as 0",
			`{"type": "result", "is_error": false, "usage": {"input_tokens": "x", "output_tokens": 7}}`,
			[]WorkerEvent{{Kind: WorkerEventResult, Usage: ResultUsage{OutputTokens: 7}}},
		},
		{
			"a usage that is not an object reads as no tokens",
			`{"type": "result", "is_error": false, "usage": 5}`,
			[]WorkerEvent{{Kind: WorkerEventResult}},
		},
		{
			"a null structured_output reads as none",
			`{"type": "result", "is_error": false, "structured_output": null}`,
			[]WorkerEvent{{Kind: WorkerEventResult}},
		},
		{
			"a JSON value that is not an object is other",
			`3`,
			[]WorkerEvent{{Kind: WorkerEventOther, Raw: `3`}},
		},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			events, err := ParseStreamLine(row.line)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if !workerEventsEqual(events, row.want) {
				t.Errorf("got %+v, want %+v", events, row.want)
			}
		})
	}
}

// Every recorded event survives a decode/encode round trip byte for byte: the fixtures are
// JSON.stringify output, and the union marshals only its own variant's fields, in the wire
// format's order. marshalWorkerEvent is the no-HTML-escape encode every writer of these events
// must use, as JavaScript's JSON.stringify does not escape `<`, `>` and `&`.
func TestWorkerEventJSONRoundTrip(t *testing.T) {
	for _, name := range streamFixtureNames(t) {
		raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "events", name))
		if err != nil {
			t.Fatalf("read event fixture %s: %v", name, err)
		}
		for _, line := range strings.Split(string(raw), "\n") {
			if line == "" {
				continue
			}
			var event WorkerEvent
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				t.Fatalf("%s: decode %s: %v", name, line, err)
			}
			encoded, err := marshalWorkerEvent(event)
			if err != nil {
				t.Fatalf("%s: encode %+v: %v", name, event, err)
			}
			if string(encoded) != line {
				t.Errorf("%s: round trip changed the bytes:\ngot:  %s\nwant: %s", name, encoded, line)
			}
		}
	}
	// The session and error variants have no recorded fixture; their wire shape is pinned here,
	// with the result's optional model and the status null the error type always writes.
	roundTrips := []struct {
		event WorkerEvent
		want  string
	}{
		{WorkerEvent{Kind: WorkerEventSession, SessionID: "engine-id-1"}, `{"type":"session","sessionId":"engine-id-1"}`},
		{WorkerEvent{Kind: WorkerEventError, Message: "provider 529", Status: i64Ptr(529)}, `{"type":"error","message":"provider 529","status":529}`},
		{WorkerEvent{Kind: WorkerEventError, Message: "network"}, `{"type":"error","message":"network","status":null}`},
		{WorkerEvent{Kind: WorkerEventResult, Model: strPtr("glm-5.3")},
			`{"type":"result","isError":false,"text":"","structuredOutput":null,"turns":0,"durationMs":0,"costUsd":0,"usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0},"apiErrorStatus":null,"model":"glm-5.3"}`},
	}
	for _, row := range roundTrips {
		encoded, err := marshalWorkerEvent(row.event)
		if err != nil {
			t.Fatalf("encode %+v: %v", row.event, err)
		}
		if string(encoded) != row.want {
			t.Errorf("encode %+v: got %s, want %s", row.event, encoded, row.want)
		}
		var decoded WorkerEvent
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatalf("decode %s: %v", encoded, err)
		}
		if !reflect.DeepEqual(decoded, row.event) {
			t.Errorf("decode %s: got %+v, want %+v", encoded, decoded, row.event)
		}
	}
}

func TestWorkerEventUnknownKind(t *testing.T) {
	if _, err := marshalWorkerEvent(WorkerEvent{Kind: "bogus"}); err == nil {
		t.Error("marshal of an unknown kind succeeds, want an error")
	}
	if err := json.Unmarshal([]byte(`{"type":"bogus"}`), &WorkerEvent{}); err == nil {
		t.Error("unmarshal of an unknown kind succeeds, want an error")
	}
	if err := json.Unmarshal([]byte(`{"type":3}`), &WorkerEvent{}); err == nil {
		t.Error("unmarshal of a non-string type succeeds, want an error")
	}
	if err := json.Unmarshal([]byte(`not json`), &WorkerEvent{}); err == nil {
		t.Error("unmarshal of malformed json succeeds, want an error")
	}
	if err := json.Unmarshal([]byte(`{"type":"init","sessionId":3}`), &WorkerEvent{}); err == nil {
		t.Error("unmarshal of a non-string sessionId succeeds, want an error")
	}
}
