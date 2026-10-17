package pirpc

// The log tests: what the attempt logs hold, through the shared rpc-log helpers.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/shared"
)

func big(chars int) string {
	return strings.Repeat("x", chars)
}

// logged is the log line for one inbound frame text, parsed back for comparison.
func logged(t *testing.T, frameText string) (map[string]any, string) {
	t.Helper()
	var frame Frame
	if err := json.Unmarshal([]byte(frameText), &frame); err != nil {
		t.Fatalf("test frame does not parse: %v", err)
	}
	got := shared.LogText(frame, frameText)
	var value any
	if err := json.Unmarshal([]byte(got), &value); err != nil {
		t.Fatalf("logText output is not JSON: %q", got)
	}
	object, _ := value.(map[string]any)
	if object == nil {
		t.Fatalf("logText output is not an object: %q", got)
	}
	return object, got
}

// member returns out's member as a JSON object, nil when it is not one.
func member(t *testing.T, out map[string]any, key string) map[string]any {
	t.Helper()
	object, _ := out[key].(map[string]any)
	return object
}

func number(t *testing.T, out map[string]any, key string) float64 {
	t.Helper()
	value, _ := out[key].(float64)
	return value
}

func TestLogText(t *testing.T) {
	t.Run("keeps small frames byte for byte (the original text, not a re-serialization)", func(t *testing.T) {
		text := `{"type":"tool_execution_end","toolName":"read",  "result":{"details":{}}}`
		var frame Frame
		if err := json.Unmarshal([]byte(text), &frame); err != nil {
			t.Fatal(err)
		}
		if got := shared.LogText(frame, text); got != text {
			t.Errorf("logText() = %q, want the text itself", got)
		}
	})

	t.Run("cuts tool_execution_end.result.details over the limit to its head and tail with a byte count", func(t *testing.T) {
		details := `{"stdout":"` + big(500_000) + `"}`
		text := `{"type":"tool_execution_end","toolCallId":"call_0123456789abcdef01234567","toolName":"bash",` +
			`"result":{"content":[],"details":` + details + `},"isError":false}`
		out, line := logged(t, text)
		cut := member(t, member(t, out, "result"), "details")
		if cut == nil {
			t.Fatal("result.details was not cut")
		}
		if number(t, cut, "$truncated") != float64(len(details)) {
			t.Errorf("$truncated = %v, want %d", cut["$truncated"], len(details))
		}
		if head, _ := cut["head"].(string); head != details[:shared.LogKeep] {
			t.Errorf("head keeps %d bytes, want %d", len(head), shared.LogKeep)
		}
		if tail, _ := cut["tail"].(string); tail != details[len(details)-shared.LogKeep:] {
			t.Errorf("tail keeps %d bytes, want %d", len(tail), shared.LogKeep)
		}
		if out["type"] != "tool_execution_end" || out["toolName"] != "bash" || out["isError"] != false {
			t.Errorf("the envelope was rewritten: %v", out)
		}
		result := member(t, out, "result")
		if result == nil {
			t.Fatal("result was dropped")
		}
		if content, isArray := result["content"].([]any); !isArray || len(content) != 0 {
			t.Errorf("result.content = %v, want the empty part list kept", result["content"])
		}
		if len(line) >= 3*shared.LogKeep {
			t.Errorf("the logged line is %d bytes, want under %d", len(line), 3*shared.LogKeep)
		}
	})

	t.Run("cuts a toolResult message_end's content and details, and leaves the envelope alone", func(t *testing.T) {
		text := `{"type":"message_end","message":{"role":"toolResult","toolCallId":"call_0123456789abcdef01234567",` +
			`"toolName":"read","content":[{"type":"text","text":"` + big(shared.LogFieldLimit+1) + `"}],` +
			`"details":{"text":"` + big(shared.LogFieldLimit) + `"},"isError":false},"messageId":"msg-3"}`
		out, _ := logged(t, text)
		if out["messageId"] != "msg-3" {
			t.Errorf("messageId = %v, want msg-3", out["messageId"])
		}
		message := member(t, out, "message")
		if message == nil || message["role"] != "toolResult" || message["toolName"] != "read" ||
			message["isError"] != false {
			t.Fatalf("the message envelope was rewritten: %v", message)
		}
		for _, field := range []string{"content", "details"} {
			cut := member(t, message, field)
			if cut == nil {
				t.Fatalf("message.%s was not cut", field)
			}
			if _, hasCount := cut["$truncated"]; !hasCount {
				t.Errorf("message.%s carries no $truncated byte count", field)
			}
		}
	})

	t.Run("counts UTF-8 bytes, not characters", func(t *testing.T) {
		details := `{"text":"` + strings.Repeat("é", shared.LogFieldLimit/2+10) + `"}`
		out, _ := logged(t, `{"type":"tool_execution_end","result":{"details":`+details+`}}`)
		cut := member(t, member(t, out, "result"), "details")
		if cut == nil {
			t.Fatal("result.details was not cut")
		}
		if number(t, cut, "$truncated") != float64(len(details)) {
			t.Errorf("$truncated = %v, want %d (the byte count)", cut["$truncated"], len(details))
		}
	})

	t.Run("keeps LOG_KEEP bytes of head and tail without splitting a UTF-8 character", func(t *testing.T) {
		// The 9-byte ASCII prefix `{"text":"` pushes the 16 KB cut into the middle of an é.
		details := `{"text":"` + strings.Repeat("é", 80_000) + `"}`
		out, _ := logged(t, `{"type":"tool_execution_end","result":{"details":`+details+`}}`)
		cut := member(t, member(t, out, "result"), "details")
		if cut == nil {
			t.Fatal("result.details was not cut")
		}
		head, _ := cut["head"].(string)
		tail, _ := cut["tail"].(string)
		if !strings.HasPrefix(details, head) {
			t.Error("head is not the JSON's head")
		}
		if !strings.HasSuffix(details, tail) {
			t.Error("tail is not the JSON's tail")
		}
		for _, part := range []string{head, tail} {
			if byteLen := len(part); byteLen <= shared.LogKeep-4 || byteLen > shared.LogKeep {
				t.Errorf("a cut side keeps %d bytes, want (%d, %d]", byteLen, shared.LogKeep-4, shared.LogKeep)
			}
			if strings.Contains(part, "�") {
				t.Error("a cut side splits a character into a replacement character")
			}
		}
	})

	leaves := []struct {
		name string
		text string
	}{
		{"an assistant message_end", `{"type":"message_end","message":{"role":"assistant","content":"` + big(70_000) + `"}}`},
		{"a frame of another type", `{"type":"message_update","details":"` + big(70_000) + `"}`},
		{"a tool_execution_end without a result", `{"type":"tool_execution_end"}`},
		{"a message_end without a message", `{"type":"message_end","message":"odd"}`},
		{"a non-object result", `{"type":"tool_execution_end","result":"` + big(70_000) + `"}`},
		{"a field at the limit", `{"type":"tool_execution_end","result":{"details":"` + big(shared.LogFieldLimit-2) + `"}}`},
	}
	for _, row := range leaves {
		t.Run("leaves "+row.name+" untouched", func(t *testing.T) {
			var frame Frame
			if err := json.Unmarshal([]byte(row.text), &frame); err != nil {
				t.Fatal(err)
			}
			if got := shared.LogText(frame, row.text); got != row.text {
				t.Errorf("logText() rewrote the frame: %.80s", got)
			}
		})
	}
}

func TestCreateRpcLogs(t *testing.T) {
	t.Run("stops logging after a stream failure instead of throwing, and still closes", func(t *testing.T) {
		dir := t.TempDir()
		frames, err := os.Create(filepath.Join(dir, "out.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		commands, err := os.Create(filepath.Join(dir, "in.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		logs := shared.CreateRpcLogs(frames, commands, "job.json#prompt")
		logs.Inbound(`{"type":"agent_settled"}`)
		logs.Outbound(json.RawMessage(`{"id":"c1","type":"get_state"}`))

		// A write stream the platform killed: the next write fails and logging stops.
		if err := frames.Close(); err != nil {
			t.Fatal(err)
		}
		logs.Inbound(`{"type":"message_end"}`)
		failure, failed := logs.Failure()
		if !failed {
			t.Fatal("Failure() reported nothing after the stream failure")
		}
		if !strings.Contains(failure, "closed") {
			t.Errorf("Failure() = %q, want the write error", failure)
		}
		logs.Outbound(json.RawMessage(`{"id":"c2","type":"get_state"}`))
		if err := logs.Close(context.Background()); err != nil {
			t.Errorf("Close() = %v, want nil", err)
		}
		// The healthy stream keeps what was written before the failure and nothing after it.
		written, err := os.ReadFile(filepath.Join(dir, "in.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		if got := strings.Split(strings.TrimSuffix(string(written), "\n"), "\n"); len(got) != 1 || got[0] != `{"id":"c1","type":"get_state"}` {
			t.Errorf("the commands log holds %q, want the first command alone", written)
		}
	})
}

func TestOutboundLogText(t *testing.T) {
	t.Run("replaces a prompt's text with a reference", func(t *testing.T) {
		command := json.RawMessage(`{"id":"c5","type":"prompt","message":"secret-ish brief"}`)
		want := `{"id":"c5","type":"prompt","message":{"$ref":"job.json#prompt"}}`
		if got := shared.OutboundLogText(command, "job.json#prompt"); got != want {
			t.Errorf("outboundLogText() = %s, want %s", got, want)
		}
	})

	t.Run("logs other commands as sent", func(t *testing.T) {
		command := json.RawMessage(`{"id":"c1","type":"get_state"}`)
		if got := shared.OutboundLogText(command, "ref"); got != `{"id":"c1","type":"get_state"}` {
			t.Errorf("outboundLogText() = %s, want the command as sent", got)
		}
	})
}
