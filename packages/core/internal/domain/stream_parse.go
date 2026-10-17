package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ParseStreamLine reads one NDJSON line of Claude Code's
// `claude -p --output-format stream-json --verbose --include-partial-messages` output into its
// events (an assistant message may carry several blocks). Blank lines give none; malformed JSON is
// an error the caller logs before continuing.
func ParseStreamLine(line string) ([]WorkerEvent, error) {
	if strings.TrimSpace(line) == "" {
		return nil, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(line), &fields); err != nil {
		var typeError *json.UnmarshalTypeError
		if errors.As(err, &typeError) {
			// Valid JSON that is not an object: no decoder can match, so it is `other`.
			return []WorkerEvent{{Kind: WorkerEventOther, Raw: line}}, nil
		}
		return nil, fmt.Errorf("malformed JSON: %v", err)
	}
	return toStreamEvents(fields, line), nil
}

// The wire shapes of the stream-json lines we act on. Each decoder names only the keys it reads,
// so new keys in later Claude Code versions are harmless; a shape that no longer matches degrades
// to `other` so new Claude Code versions never break parsing.

func decodeSystemInit(fields map[string]json.RawMessage) ([]WorkerEvent, bool) {
	if !wireIs(fields, "type", "system") || !wireIs(fields, "subtype", "init") {
		return nil, false
	}
	sessionID, ok := wireString(fields, "session_id")
	if !ok {
		return nil, false
	}
	model, ok := wireString(fields, "model")
	if !ok {
		return nil, false
	}
	return []WorkerEvent{{Kind: WorkerEventInit, SessionID: sessionID, Model: &model}}, true
}

func decodeSystemAPIRetry(fields map[string]json.RawMessage) ([]WorkerEvent, bool) {
	if !wireIs(fields, "type", "system") || !wireIs(fields, "subtype", "api_retry") {
		return nil, false
	}
	attempt, ok := wireNumber(fields, "attempt")
	if !ok {
		return nil, false
	}
	maxRetries, ok := wireNumber(fields, "max_retries")
	if !ok {
		return nil, false
	}
	status, ok := wireNullishNumber(fields, "error_status")
	if !ok {
		return nil, false
	}
	return []WorkerEvent{
		{Kind: WorkerEventAPIRetry, Attempt: int64(attempt), MaxRetries: int64(maxRetries), Status: status},
	}, true
}

// decodeAssistant reads an assistant message: usually one content block, but every block is kept,
// in order; blocks we do not track (thinking) are skipped.
func decodeAssistant(fields map[string]json.RawMessage) ([]WorkerEvent, bool) {
	if !wireIs(fields, "type", "assistant") {
		return nil, false
	}
	var message struct {
		Content []json.RawMessage `json:"content"`
	}
	if !wireInto(fields, "message", &message) {
		return nil, false
	}
	var events []WorkerEvent
	for _, block := range message.Content {
		var wire struct {
			Type  string          `json:"type"`
			Text  *string         `json:"text"`
			Name  *string         `json:"name"`
			Input json.RawMessage `json:"input"`
		}
		if err := json.Unmarshal(block, &wire); err != nil {
			continue
		}
		switch wire.Type {
		case "text":
			if wire.Text == nil {
				continue
			}
			previous := len(events) - 1
			// Adjacent text blocks are one piece of prose split by the API, not separate messages.
			if previous >= 0 && events[previous].Kind == WorkerEventAssistantText {
				events[previous].Text += *wire.Text
			} else {
				events = append(events, WorkerEvent{Kind: WorkerEventAssistantText, Text: *wire.Text})
			}
		case "tool_use":
			if wire.Name == nil {
				continue
			}
			events = append(events, WorkerEvent{
				Kind:    WorkerEventToolUse,
				Name:    *wire.Name,
				Summary: SummarizeToolInput(wire.Input),
			})
		}
	}
	if len(events) == 0 {
		return nil, false
	}
	return events, true
}

// decodeTextDelta reads the raw API streaming events --include-partial-messages wraps as
// {type: "stream_event", event}: only text deltas are tracked.
func decodeTextDelta(fields map[string]json.RawMessage) ([]WorkerEvent, bool) {
	if !wireIs(fields, "type", "stream_event") {
		return nil, false
	}
	var streamEvent struct {
		Type  string `json:"type"`
		Delta struct {
			Type string  `json:"type"`
			Text *string `json:"text"`
		} `json:"delta"`
	}
	if !wireInto(fields, "event", &streamEvent) {
		return nil, false
	}
	if streamEvent.Type != "content_block_delta" || streamEvent.Delta.Type != "text_delta" ||
		streamEvent.Delta.Text == nil {
		return nil, false
	}
	return []WorkerEvent{{Kind: WorkerEventTextDelta, Text: *streamEvent.Delta.Text}}, true
}

// decodeToolResult reads tool results, which come back as a user message; `is_error` is omitted
// when the tool succeeded.
func decodeToolResult(fields map[string]json.RawMessage) ([]WorkerEvent, bool) {
	if !wireIs(fields, "type", "user") {
		return nil, false
	}
	var message struct {
		Content []json.RawMessage `json:"content"`
	}
	if !wireInto(fields, "message", &message) {
		return nil, false
	}
	found := false
	isError := false
	for _, block := range message.Content {
		var wire struct {
			Type    string `json:"type"`
			IsError *bool  `json:"is_error"`
		}
		if err := json.Unmarshal(block, &wire); err != nil || wire.Type != "tool_result" {
			continue
		}
		found = true
		if wire.IsError != nil && *wire.IsError {
			isError = true
		}
	}
	if !found {
		return nil, false
	}
	return []WorkerEvent{{Kind: WorkerEventToolResult, IsError: isError}}, true
}

// decodeResult reads the final `result` line: `is_error` is authoritative — subtype "success"
// with is_error true happens on API errors (live capture). Accounting fields never cost us the
// event: a missing or odd value counts as 0.
func decodeResult(fields map[string]json.RawMessage) ([]WorkerEvent, bool) {
	if !wireIs(fields, "type", "result") {
		return nil, false
	}
	var isError bool
	if raw, ok := fields["is_error"]; !ok || json.Unmarshal(raw, &isError) != nil {
		return nil, false
	}
	text := ""
	if raw, ok := fields["result"]; ok && json.Unmarshal(raw, &text) != nil {
		return nil, false
	}
	var structuredOutput json.RawMessage
	if raw, ok := fields["structured_output"]; ok {
		structuredOutput = rawOrNull(raw)
	}
	// z.number().nullish().catch(null): a value that is not a number or null reads as null.
	apiErrorStatus, _ := wireNullishNumber(fields, "api_error_status")
	return []WorkerEvent{{
		Kind:             WorkerEventResult,
		IsError:          isError,
		Text:             text,
		StructuredOutput: structuredOutput,
		Turns:            int64(wireCount(fields, "num_turns")),
		DurationMs:       int64(wireCount(fields, "duration_ms")),
		CostUSD:          wireCount(fields, "total_cost_usd"),
		Usage:            decodeResultUsage(fields),
		APIErrorStatus:   apiErrorStatus,
	}}, true
}

// decodeResultUsage reads the usage object: four .catch(0) counts inside a .catch(NO_TOKENS)
// object, so anything but an object of numbers reads as all zeros.
func decodeResultUsage(fields map[string]json.RawMessage) ResultUsage {
	raw, ok := fields["usage"]
	if !ok {
		return ResultUsage{}
	}
	var counts map[string]json.RawMessage
	if err := json.Unmarshal(raw, &counts); err != nil {
		return ResultUsage{}
	}
	return ResultUsage{
		InputTokens:      int64(wireCount(counts, "input_tokens")),
		OutputTokens:     int64(wireCount(counts, "output_tokens")),
		CacheReadTokens:  int64(wireCount(counts, "cache_read_input_tokens")),
		CacheWriteTokens: int64(wireCount(counts, "cache_creation_input_tokens")),
	}
}

// streamDecoders tries each wire shape in order; the first that matches decides the line.
var streamDecoders = []func(fields map[string]json.RawMessage) ([]WorkerEvent, bool){
	decodeSystemInit,
	decodeSystemAPIRetry,
	decodeAssistant,
	decodeTextDelta,
	decodeToolResult,
	decodeResult,
}

// toStreamEvents maps a decoded JSON line to the events it represents, or one `other` carrying the
// raw line.
func toStreamEvents(fields map[string]json.RawMessage, raw string) []WorkerEvent {
	for _, decode := range streamDecoders {
		if events, ok := decode(fields); ok {
			return events
		}
	}
	return []WorkerEvent{{Kind: WorkerEventOther, Raw: raw}}
}

// wireIs reports whether the field is the given JSON string (zod's z.literal).
func wireIs(fields map[string]json.RawMessage, key, literal string) bool {
	value, ok := wireString(fields, key)
	return ok && value == literal
}

// wireString reads a field the schema types as a string (z.string(): present and a string).
func wireString(fields map[string]json.RawMessage, key string) (string, bool) {
	raw, ok := fields[key]
	if !ok {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

// wireNumber reads a field the schema types as a number (z.number(): present and a number).
func wireNumber(fields map[string]json.RawMessage, key string) (float64, bool) {
	raw, ok := fields[key]
	if !ok {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

// wireNullishNumber reads a field the schema types as z.number().nullish(): absent and null read
// as a nil value, any other shape fails the schema.
func wireNullishNumber(fields map[string]json.RawMessage, key string) (*int64, bool) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(raw, []byte("null")) {
		return nil, true
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	number := int64(value)
	return &number, true
}

// wireCount reads a field the schema types as z.number().catch(0): a missing or odd value counts
// as 0.
func wireCount(fields map[string]json.RawMessage, key string) float64 {
	value, ok := wireNumber(fields, key)
	if !ok {
		return 0
	}
	return value
}

// wireInto decodes a field into target; a missing field or a shape that does not fit fails.
func wireInto(fields map[string]json.RawMessage, key string, target any) bool {
	raw, ok := fields[key]
	if !ok {
		return false
	}
	return json.Unmarshal(raw, target) == nil
}
