// Package pirpc speaks pi's RPC wire (pi 1.0.4): one JSON object per line, no negotiation, a bare
// agent_settled ending every turn.
package pirpc

import (
	"encoding/json"
	"strings"
)

// MaxFrameBytes is the longest stdout line pi may write (spawn's maxLineBytes): its agent_end
// frames carry the whole session, so a long one can pass the 1 MiB default while still being a
// frame worth reading, not a runaway.
const MaxFrameBytes int64 = 64 * 1024 * 1024

// Frame is any frame pi sends or the worker commands: the known shapes stay untyped here (see
// messages.go for why), so every member rides as the raw JSON pi wrote.
type Frame map[string]json.RawMessage

// DecodedKind is what one stdout line decoded to.
type DecodedKind string

const (
	// DecodedFrame is a frame; Text holds its exact JSON text, for the attempt log.
	DecodedFrame DecodedKind = "frame"
	// DecodedPartial is a blank line.
	DecodedPartial DecodedKind = "partial"
	// DecodedMalformed is a line that is not a frame (stray output); callers log and skip it.
	DecodedMalformed DecodedKind = "malformed"
)

// Decoded is one pushed stdout line.
type Decoded struct {
	Kind   DecodedKind
	Frame  Frame
	Text   string
	Line   string
	Reason string
}

// FrameDecoder decodes pi's stdout line by line. One decoder serves a whole stream: pi has no
// negotiation to switch partway through.
type FrameDecoder struct{}

// CreateFrameDecoder builds the stream's decoder.
func CreateFrameDecoder() *FrameDecoder {
	return &FrameDecoder{}
}

// Push decodes one raw stdout line. pi's wire is one JSON object per line, each {type, ...};
// unknown types still arrive (its event stream grows release by release), so the decoder accepts
// any object with a string type and leaves the rest of the work to the fold, which ignores what it
// does not know. There is no chunked framing (that was omp's rpc_chunk): every line either parses
// as a frame or is stray output the caller logs and skips.
func (d *FrameDecoder) Push(raw string) Decoded {
	// pi tolerates a trailing CR, so its RPC peer must too (checked against pi 1.0.4).
	line := raw
	if strings.HasSuffix(line, "\r") {
		line = line[:len(line)-1]
	}
	if line == "" {
		return Decoded{Kind: DecodedPartial}
	}
	frame, reason := parseFrame(line)
	if frame != nil {
		return Decoded{Kind: DecodedFrame, Frame: frame, Text: line}
	}
	return Decoded{Kind: DecodedMalformed, Line: line, Reason: reason}
}

// parseFrame decodes text as a frame, or says why it is not one.
func parseFrame(text string) (Frame, string) {
	var frame Frame
	if err := json.Unmarshal([]byte(text), &frame); err != nil {
		// Valid JSON that is not an object (an array, a scalar) is not a frame, not broken JSON.
		var value any
		if json.Unmarshal([]byte(text), &value) == nil {
			return nil, "not an RPC frame"
		}
		return nil, "not JSON"
	}
	if frame == nil {
		// null unmarshals into a nil map without an error.
		return nil, "not an RPC frame"
	}
	if _, ok := frameStringOk(frame, "type"); !ok {
		return nil, "not an RPC frame"
	}
	return frame, ""
}

// frameString reads frame's member key as a string, "" when missing or not a string.
func frameString(frame Frame, key string) string {
	if text, ok := frameStringOk(frame, key); ok {
		return text
	}
	return ""
}

// frameStringOk reads frame's member key as a string; ok is false for any other shape, a missing
// member included.
func frameStringOk(frame Frame, key string) (string, bool) {
	raw, ok := frame[key]
	if !ok {
		return "", false
	}
	if len(raw) == 0 || string(raw) == "null" {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}

// frameBool reads frame's member key as a boolean; ok is false for any other shape.
func frameBool(frame Frame, key string) (bool, bool) {
	if raw, ok := frame[key]; ok {
		switch string(raw) {
		case "true":
			return true, true
		case "false":
			return false, true
		}
	}
	return false, false
}

// frameObject reads frame's member key as an object's members; nil when it is missing or not an
// object (null is not one either), the empty record a missing field reads as.
func frameObject(frame Frame, key string) map[string]json.RawMessage {
	var members map[string]json.RawMessage
	if raw, ok := frame[key]; ok {
		_ = json.Unmarshal(raw, &members)
	}
	return members
}
