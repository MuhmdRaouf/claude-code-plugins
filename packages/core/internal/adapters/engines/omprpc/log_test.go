package omprpc

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/shared"
)

// The omp log tests drive the shared rpc-log helpers through the omp client's own shapes, with
// the frames built in written order.

// mustFrame parses text as a frame for the log.
func mustFrame(t *testing.T, text string) Frame {
	t.Helper()
	var frame Frame
	if err := json.Unmarshal([]byte(text), &frame); err != nil {
		t.Fatalf("test frame does not parse: %v", err)
	}
	return frame
}

// loggedFrame is what the log line for frame decodes to.
func loggedFrame(t *testing.T, frame json.RawMessage) map[string]any {
	t.Helper()
	return parsedLine(t, shared.LogText(mustFrame(t, string(frame)), string(frame)))
}

func TestLogText(t *testing.T) {
	big := func(chars int) string { return strings.Repeat("x", chars) }

	t.Run("keeps small frames byte for byte (the original text, not a re-serialization)", func(t *testing.T) {
		text := `{"type":"tool_execution_end","toolName":"read",  "result":{"details":{}}}`
		if got := shared.LogText(mustFrame(t, text), text); got != text {
			t.Errorf("LogText() = %q, want the text itself", got)
		}
	})

	t.Run("cuts tool_execution_end.result.details over the limit to its head and tail with a byte count", func(t *testing.T) {
		frame := object(
			fStr("type", "tool_execution_end"),
			fStr("toolName", "read"),
			fRaw("result", object(
				fRaw("content", array()),
				fRaw("details", object(fRaw("displayContent", object(fStr("text", big(500_000)))))),
			)),
			fBool("isError", false),
		)
		detailsJSON := `{"displayContent":{"text":"` + big(500_000) + `"}}`
		out := loggedFrame(t, frame)
		result, _ := out["result"].(map[string]any)
		cut, _ := result["details"].(map[string]any)
		if len(cut) != 3 {
			t.Fatalf("details = %v, want $truncated, head and tail", cut)
		}
		if truncated, _ := cut["$truncated"].(float64); int(truncated) != len(detailsJSON) {
			t.Errorf("$truncated = %v, want %d", cut["$truncated"], len(detailsJSON))
		}
		if head, _ := cut["head"].(string); head != detailsJSON[:shared.LogKeep] {
			t.Errorf("head keeps %d bytes, want LogKeep", len(head))
		}
		if tail, _ := cut["tail"].(string); tail != detailsJSON[len(detailsJSON)-shared.LogKeep:] {
			t.Errorf("tail keeps %d bytes, want LogKeep", len(tail))
		}
		if content, _ := result["content"].([]any); len(content) != 0 {
			t.Errorf("content = %v, want the untouched empty array", result["content"])
		}
		if reencoded, err := json.Marshal(out); err != nil || len(reencoded) >= 3*shared.LogKeep {
			t.Errorf("the logged frame is %d bytes, want under three keeps", len(reencoded))
		}
	})

	t.Run("cuts a toolResult message_end's details and content, and leaves the envelope alone", func(t *testing.T) {
		frame := object(
			fStr("type", "message_end"),
			fRaw("message", object(
				fStr("role", "toolResult"),
				fStr("toolName", "read"),
				fRaw("content", array(object(fStr("type", "text"), fStr("text", big(shared.LogFieldLimit+1))))),
				fRaw("details", object(fStr("text", big(shared.LogFieldLimit)))),
				fBool("isError", false),
			)),
			fStr("messageId", "msg-3"),
		)
		out := loggedFrame(t, frame)
		if out["messageId"] != "msg-3" {
			t.Errorf("messageId = %v, want msg-3", out["messageId"])
		}
		message, _ := out["message"].(map[string]any)
		if message["role"] != "toolResult" || message["toolName"] != "read" || message["isError"] != false {
			t.Errorf("message envelope = %v, want it left alone", message)
		}
		content, _ := message["content"].(map[string]any)
		if _, ok := content["$truncated"].(float64); !ok {
			t.Errorf("content = %v, want it cut with a byte count", message["content"])
		}
		details, _ := message["details"].(map[string]any)
		if _, ok := details["$truncated"].(float64); !ok {
			t.Errorf("details = %v, want it cut with a byte count", message["details"])
		}
	})

	t.Run("counts UTF-8 bytes, not characters", func(t *testing.T) {
		frame := object(
			fStr("type", "tool_execution_end"),
			fRaw("result", object(fRaw("details", object(fStr("text", strings.Repeat("é", shared.LogFieldLimit/2+10)))))),
		)
		detailsJSON := `{"text":"` + strings.Repeat("é", shared.LogFieldLimit/2+10) + `"}`
		out := loggedFrame(t, frame)
		result, _ := out["result"].(map[string]any)
		cut, _ := result["details"].(map[string]any)
		if truncated, _ := cut["$truncated"].(float64); int(truncated) != len(detailsJSON) {
			t.Errorf("$truncated = %v, want %d bytes", cut["$truncated"], len(detailsJSON))
		}
	})

	t.Run("keeps LOG_KEEP bytes of head and tail without splitting a UTF-8 character", func(t *testing.T) {
		// The 9-byte ASCII prefix `{"text":"` pushes the 16 KB cut into the middle of an é.
		text := strings.Repeat("é", 80_000)
		frame := object(
			fStr("type", "tool_execution_end"),
			fRaw("result", object(fRaw("details", object(fStr("text", text))))),
		)
		detailsJSON := `{"text":"` + text + `"}`
		out := loggedFrame(t, frame)
		result, _ := out["result"].(map[string]any)
		cut, _ := result["details"].(map[string]any)
		head, _ := cut["head"].(string)
		tail, _ := cut["tail"].(string)
		if !strings.HasPrefix(detailsJSON, head) {
			t.Error("the head is not the JSON's head")
		}
		if !strings.HasSuffix(detailsJSON, tail) {
			t.Error("the tail is not the JSON's tail")
		}
		for _, part := range []string{head, tail} {
			if size := len(part); size <= shared.LogKeep-4 || size > shared.LogKeep {
				t.Errorf("a cut keeps %d bytes, want just under or at LogKeep", size)
			}
			if strings.Contains(part, "�") {
				t.Error("a cut split a UTF-8 character")
			}
		}
	})

	t.Run("leaves frames that are not tool results untouched", func(t *testing.T) {
		assistant := object(
			fStr("type", "message_end"),
			fRaw("message", object(fStr("role", "assistant"), fStr("content", big(70_000)))),
		)
		others := []json.RawMessage{
			assistant,
			object(fStr("type", "message_update"), fStr("details", big(70_000))),
			object(fStr("type", "tool_execution_end")),
			object(fStr("type", "message_end"), fStr("message", "odd")),
			object(
				fStr("type", "tool_execution_end"),
				fRaw("result", object(fStr("details", big(shared.LogFieldLimit-2)))),
			),
		}
		for _, frame := range others {
			if got := shared.LogText(mustFrame(t, string(frame)), string(frame)); got != string(frame) {
				t.Errorf("LogText(%.60s…) rewrote the frame", got)
			}
		}
	})
}

func TestCreateRpcLogs(t *testing.T) {
	t.Run("stops logging after a stream failure instead of throwing, and still closes", func(t *testing.T) {
		dir := t.TempDir()
		frames, commands := openAppend(t, filepath.Join(dir, "out.jsonl")), openAppend(t, filepath.Join(dir, "in.jsonl"))
		logs := shared.CreateRpcLogs(frames, commands, "job.json#attempts[0].prompt")
		logs.Inbound(`{"type":"session_settled"}`)
		logs.Outbound(json.RawMessage(`{"id":"c1","type":"get_state"}`))

		// The frames stream dies; the first write after that fails.
		if err := frames.Close(); err != nil {
			t.Fatal(err)
		}
		logs.Inbound(`{"type":"message_end"}`)
		if failure, failed := logs.Failure(); !failed || failure == "" {
			t.Fatal("Failure() reported nothing after a failed write")
		}
		logs.Outbound(json.RawMessage(`{"id":"c2","type":"get_state"}`))
		if err := logs.Close(context.Background()); err != nil {
			t.Errorf("Close() = %v, want nil", err)
		}
		// The healthy stream keeps what was written before the failure and nothing after it.
		if got := strings.Join(lines(t, filepath.Join(dir, "in.jsonl")), "\n"); got != `{"id":"c1","type":"get_state"}` {
			t.Errorf("outbound log = %q, want only the first command", got)
		}
	})
}

func TestOutboundLogText(t *testing.T) {
	t.Run("replaces a prompt's text with a reference", func(t *testing.T) {
		command := json.RawMessage(`{"id":"c5","type":"prompt","message":"secret-ish brief"}`)
		want := `{"id":"c5","type":"prompt","message":{"$ref":"job.json#attempts[0].prompt"}}`
		if got := shared.OutboundLogText(command, "job.json#attempts[0].prompt"); got != want {
			t.Errorf("outboundLogText() = %q, want %q", got, want)
		}
	})

	t.Run("logs other commands as sent", func(t *testing.T) {
		command := json.RawMessage(`{"id":"c1","type":"get_state"}`)
		if got := shared.OutboundLogText(command, "ref"); got != string(command) {
			t.Errorf("outboundLogText() = %q, want the command itself", got)
		}
	})
}

// openAppend opens path for appending the way the rpc logs themselves are opened.
func openAppend(t *testing.T, path string) *os.File {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	t.Cleanup(func() { file.Close() })
	return file
}
