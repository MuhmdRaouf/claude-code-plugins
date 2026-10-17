package pirpc

// The frame decoder tests.

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
)

// framesEqual compares the decoded frame with wantText as JSON values, the way vitest's toEqual
// compared the parsed objects.
func framesEqual(t *testing.T, got Frame, wantText string) {
	t.Helper()
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("the decoded frame cannot be marshalled: %v", err)
	}
	var gotValue, wantValue any
	if err := json.Unmarshal(raw, &gotValue); err != nil {
		t.Fatalf("the decoded frame is not JSON: %v", err)
	}
	if err := json.Unmarshal([]byte(wantText), &wantValue); err != nil {
		t.Fatalf("the wanted frame is not JSON: %v", err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Errorf("frame = %v, want %v", gotValue, wantValue)
	}
}

func TestCreateFrameDecoder(t *testing.T) {
	t.Run("decodes a transcript line into its frame and keeps the exact text", func(t *testing.T) {
		decoder := CreateFrameDecoder()
		line := `{"type":"agent_settled"}`
		decoded := decoder.Push(line)
		if decoded.Kind != DecodedFrame {
			t.Fatalf("kind = %q, want frame", decoded.Kind)
		}
		framesEqual(t, decoded.Frame, line)
		if decoded.Text != line {
			t.Errorf("text = %q, want the line itself", decoded.Text)
		}
	})

	t.Run("decodes a response with its id and data", func(t *testing.T) {
		decoder := CreateFrameDecoder()
		line := `{"id":"c1","type":"response","command":"get_state","success":true,"data":{"sessionId":"s"}}`
		decoded := decoder.Push(line)
		if decoded.Kind != DecodedFrame {
			t.Fatalf("kind = %q, want frame", decoded.Kind)
		}
		framesEqual(t, decoded.Frame, line)
		if decoded.Text != line {
			t.Errorf("text = %q, want the line itself", decoded.Text)
		}
	})

	t.Run("keeps the fields it does not know: unknown types still decode", func(t *testing.T) {
		decoder := CreateFrameDecoder()
		line := `{"type":"future_event","payload":{"anything":[1,2]}}`
		decoded := decoder.Push(line)
		if decoded.Kind != DecodedFrame {
			t.Fatalf("kind = %q, want frame", decoded.Kind)
		}
		if got := frameString(decoded.Frame, "type"); got != "future_event" {
			t.Errorf("type = %q, want future_event", got)
		}
		if _, known := decoded.Frame["payload"]; !known {
			t.Error("the unknown payload member was dropped")
		}
	})

	t.Run("tolerates a trailing carriage return", func(t *testing.T) {
		decoder := CreateFrameDecoder()
		decoded := decoder.Push("{\"type\":\"agent_settled\"}\r")
		if decoded.Kind != DecodedFrame {
			t.Fatalf("kind = %q, want frame", decoded.Kind)
		}
		want := `{"type":"agent_settled"}`
		if decoded.Text != want {
			t.Errorf("text = %q, want %q", decoded.Text, want)
		}
	})

	t.Run("parses JSON with its own surrounding whitespace, keeping the text verbatim", func(t *testing.T) {
		decoder := CreateFrameDecoder()
		line := ` { "type" : "agent_settled" } `
		decoded := decoder.Push(line)
		if decoded.Kind != DecodedFrame {
			t.Fatalf("kind = %q, want frame", decoded.Kind)
		}
		if decoded.Text != line {
			t.Errorf("text = %q, want the line as sent", decoded.Text)
		}
	})

	for _, row := range []struct {
		name   string
		line   string
		reason string
	}{
		{"not json", "Still starting…", "not JSON"},
		{"a JSON array", "[1,2]", "not an RPC frame"},
		{"a frame without a type", `{"id":"x"}`, "not an RPC frame"},
		{"a JSON string", `"agent_settled"`, "not an RPC frame"},
		{"a JSON number", "42", "not an RPC frame"},
		{"null", "null", "not an RPC frame"},
		{"a frame whose type is not a string", `{"type":7}`, "not an RPC frame"},
	} {
		t.Run("reports "+row.name+" as malformed instead of throwing", func(t *testing.T) {
			decoded := CreateFrameDecoder().Push(row.line)
			if decoded.Kind != DecodedMalformed {
				t.Errorf("kind = %q, want malformed", decoded.Kind)
			}
			if decoded.Line != row.line || decoded.Reason != row.reason {
				t.Errorf("malformed = (%q, %q), want (%q, %q)",
					decoded.Line, decoded.Reason, row.line, row.reason)
			}
		})
	}

	t.Run("skips blank lines", func(t *testing.T) {
		if decoded := CreateFrameDecoder().Push(""); decoded.Kind != DecodedPartial {
			t.Errorf("kind = %q, want partial", decoded.Kind)
		}
	})

	t.Run("a blank line with a carriage return is still blank", func(t *testing.T) {
		if decoded := CreateFrameDecoder().Push("\r"); decoded.Kind != DecodedPartial {
			t.Errorf("kind = %q, want partial", decoded.Kind)
		}
	})

	t.Run("recovers after a malformed line: the next frame decodes", func(t *testing.T) {
		decoder := CreateFrameDecoder()
		if decoded := decoder.Push("this is not json"); decoded.Kind != DecodedMalformed {
			t.Fatalf("kind = %q, want malformed", decoded.Kind)
		}
		if decoded := decoder.Push(`{"type":"agent_settled"}`); decoded.Kind != DecodedFrame {
			t.Errorf("kind = %q, want frame", decoded.Kind)
		}
	})

	t.Run("MAX_FRAME_BYTES sits above omp's default line limit, for agent_end's whole-session frames", func(t *testing.T) {
		if MaxFrameBytes != 64*1024*1024 {
			t.Errorf("MAX_FRAME_BYTES = %d, want %d", MaxFrameBytes, 64*1024*1024)
		}
		if MaxFrameBytes <= process.DefaultMaxLineBytes {
			t.Error("MAX_FRAME_BYTES does not sit above omp's default line limit")
		}
	})
}

func TestFrameMembers(t *testing.T) {
	t.Run("a null or missing member is no string, a wrong shape is no string either", func(t *testing.T) {
		frame := Frame{
			"id":     json.RawMessage(`null`),
			"method": json.RawMessage(`"select"`),
			"seq":    json.RawMessage(`7`),
		}
		if _, ok := frameStringOk(frame, "id"); ok {
			t.Error("a null member read as a string")
		}
		if _, ok := frameStringOk(frame, "title"); ok {
			t.Error("a missing member read as a string")
		}
		if _, ok := frameStringOk(frame, "seq"); ok {
			t.Error("a number read as a string")
		}
		if got := frameString(frame, "id"); got != "" {
			t.Errorf("frameString(null) = %q, want empty", got)
		}
		if got := frameString(frame, "method"); got != "select" {
			t.Errorf("frameString(method) = %q, want select", got)
		}
	})
}
