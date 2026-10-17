package shared

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

// What an RPC engine's (omp's, pi's) attempt logs hold. Inbound frames are logged byte for byte,
// with one exception: tool results carry the full pre-elision output (a tool_execution_end's
// result.details, a toolResult message_end's content and details; a 3 MB read once wrote two
// ~519 KB lines although the model saw 40 KB), so a field over LogFieldLimit is cut to its first
// and last LogKeep bytes of JSON plus its byte count. The fold never reads those fields. Outbound
// commands are logged as sent, except the prompt text, which job.json keeps.

// LogFieldLimit is the JSON byte length a tool result field may reach before it is cut.
const LogFieldLimit = 64 * 1024

// LogKeep is how many bytes of the head and of the tail a cut field keeps.
const LogKeep = 16 * 1024

// LogText is the log line for an inbound frame: text itself unless a tool result field is too
// big, when the frame is rewritten with that field replaced by
// {"$truncated":<bytes>,"head":"…","tail":"…"} — every member kept, in the order the engine
// wrote it, compacted the way JSON.stringify renders the parsed frame.
func LogText(frame map[string]json.RawMessage, text string) string {
	cut, ok := cutFrame(frame, text)
	if !ok {
		return text
	}
	return cut
}

// OutboundLogText is the log line for an outbound command, logged as sent except that a prompt's
// message becomes {"$ref":promptRef}.
func OutboundLogText(command json.RawMessage, promptRef string) string {
	if commandType(command) == "prompt" {
		var ref bytes.Buffer
		ref.WriteString(`{"$ref":`)
		jsonStringLiteral(&ref, promptRef)
		ref.WriteByte('}')
		return replaceField(command, "message", ref.Bytes())
	}
	var out bytes.Buffer
	if json.Compact(&out, command) != nil {
		return string(command)
	}
	return out.String()
}

// cutFrame rewrites a tool result frame with its oversized fields cut; ok is false when nothing
// needed cutting, and then the frame's own text is the log line.
func cutFrame(frame map[string]json.RawMessage, text string) (string, bool) {
	switch frameString(frame, "type") {
	case "tool_execution_end":
		result, ok := frame["result"]
		if !ok || asObject(result) == nil {
			return "", false
		}
		cut, cutOk := cutFields(result, "details")
		if !cutOk {
			return "", false
		}
		return replaceField(json.RawMessage(text), "result", cut), true
	case "message_end":
		message, ok := frame["message"]
		if !ok {
			return "", false
		}
		members := asObject(message)
		if members == nil || frameString(members, "role") != "toolResult" {
			return "", false
		}
		cut, cutOk := cutFields(message, "content", "details")
		if !cutOk {
			return "", false
		}
		return replaceField(json.RawMessage(text), "message", cut), true
	}
	return "", false
}

// cutFields replaces every listed member of object whose JSON runs over LogFieldLimit with its
// truncated stand-in; ok is false when no member needed cutting.
func cutFields(object json.RawMessage, keys ...string) (json.RawMessage, bool) {
	out := object
	cut := false
	for _, key := range keys {
		value, ok := memberValue(object, key)
		if !ok {
			continue
		}
		truncated, ok := cutValue(value)
		if !ok {
			continue
		}
		out = json.RawMessage(replaceField(out, key, truncated))
		cut = true
	}
	return out, cut
}

// cutValue is value's stand-in when its JSON runs over LogFieldLimit: the byte count plus the
// first and last LogKeep bytes.
func cutValue(value json.RawMessage) (json.RawMessage, bool) {
	var compact bytes.Buffer
	if json.Compact(&compact, value) != nil {
		return nil, false
	}
	b := compact.Bytes()
	if len(b) <= LogFieldLimit {
		return nil, false
	}
	var out bytes.Buffer
	out.WriteString(`{"$truncated":`)
	out.WriteString(strconv.Itoa(len(b)))
	out.WriteString(`,"head":`)
	jsonStringLiteral(&out, cutBytes(b, 0, LogKeep))
	out.WriteString(`,"tail":`)
	jsonStringLiteral(&out, cutBytes(b, len(b)-LogKeep, len(b)))
	out.WriteByte('}')
	return out.Bytes(), true
}

// cutBytes is b[start:end) as text, walked to the nearest UTF-8 boundary so no character is cut
// in half.
func cutBytes(b []byte, start, end int) string {
	for end > start && end < len(b) && isContinuation(b[end]) {
		end--
	}
	for start < end && isContinuation(b[start]) {
		start++
	}
	return string(b[start:end])
}

func isContinuation(b byte) bool { return b&0xc0 == 0x80 }

// replaceField rewrites raw, a JSON object, with member key's value replaced by replacement:
// every member kept in its written order, compacted. A key the object does not hold is
// appended.
func replaceField(raw json.RawMessage, key string, replacement json.RawMessage) string {
	var out bytes.Buffer
	out.WriteByte('{')
	replaced := false
	walkObject(raw, func(name string, value json.RawMessage) bool {
		if out.Len() > 1 {
			out.WriteByte(',')
		}
		jsonStringLiteral(&out, name)
		out.WriteByte(':')
		if name == key {
			out.Write(replacement)
			replaced = true
		} else {
			_ = json.Compact(&out, value)
		}
		return true
	})
	if !replaced {
		if out.Len() > 1 {
			out.WriteByte(',')
		}
		jsonStringLiteral(&out, key)
		out.WriteString(":")
		out.Write(replacement)
	}
	out.WriteByte('}')
	return out.String()
}

// walkObject visits each member of raw (a JSON object) in written order; ok is false when raw is
// not an object. visit stops the walk by returning false.
func walkObject(raw []byte, visit func(key string, value json.RawMessage) bool) bool {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	opening, err := decoder.Token()
	if err != nil {
		return false
	}
	if delim, ok := opening.(json.Delim); !ok || delim != '{' {
		return false
	}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return false
		}
		key, isKey := keyToken.(string)
		var value json.RawMessage
		// A non-string key cannot occur in valid JSON; it fails the walk the same way a broken
		// value does.
		if !isKey || decoder.Decode(&value) != nil {
			return false
		}
		if !visit(key, value) {
			// The visitor stopped the walk; raw is still an object.
			return true
		}
	}
	return true
}

// memberValue is object's member key as raw JSON; ok is false when the object holds no such key.
func memberValue(object json.RawMessage, key string) (json.RawMessage, bool) {
	var value json.RawMessage
	found := false
	walkObject(object, func(name string, raw json.RawMessage) bool {
		if name == key {
			value, found = raw, true
			return false
		}
		return true
	})
	return value, found
}

// frameString reads frame's member key as a string, "" when missing or not a string.
func frameString(frame map[string]json.RawMessage, key string) string {
	if raw, ok := frame[key]; ok {
		if text, ok := unquoteString(raw); ok {
			return text
		}
	}
	return ""
}

// commandType reads a command's type member, "" when it is not an object with a string type.
func commandType(command json.RawMessage) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal(command, &fields) != nil {
		return ""
	}
	return frameString(fields, "type")
}

// asObject decodes raw JSON as an object's members; nil when raw is not an object (null is not
// one either).
func asObject(raw json.RawMessage) map[string]json.RawMessage {
	var members map[string]json.RawMessage
	if json.Unmarshal(raw, &members) != nil {
		return nil
	}
	return members
}

// unquoteString reads raw JSON as a string value; ok is false for any other JSON value (null
// unmarshals into a string without error in Go, so it is ruled out first).
func unquoteString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}

// jsonStringLiteral writes text as a JSON string the way JSON.stringify does: no HTML escaping,
// the short escapes for \b \t \n \f \r, \u00xx for the other control characters, and every other
// byte as written (encoding/json would escape U+2028 and U+2029, which JSON.stringify writes
// raw).
func jsonStringLiteral(out *bytes.Buffer, text string) {
	out.WriteByte('"')
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch {
		case c == '"':
			out.WriteString(`\"`)
		case c == '\\':
			out.WriteString(`\\`)
		case c == '\b':
			out.WriteString(`\b`)
		case c == '\f':
			out.WriteString(`\f`)
		case c == '\n':
			out.WriteString(`\n`)
		case c == '\r':
			out.WriteString(`\r`)
		case c == '\t':
			out.WriteString(`\t`)
		case c < 0x20:
			const hex = "0123456789abcdef"
			out.WriteString(`\u00`)
			out.WriteByte(hex[c>>4])
			out.WriteByte(hex[c&0xf])
		default:
			out.WriteByte(c)
		}
	}
	out.WriteByte('"')
}

// RpcLogPaths says where a worker session's RPC traffic is logged.
type RpcLogPaths struct {
	// Stdout holds inbound frames, one per line (`attempt-<n>.jsonl`).
	Stdout string
	// Stdin holds outbound commands (`attempt-<n>.rpc-in.jsonl`).
	Stdin string
	// PromptRef stands in for the prompt text in the outbound log, e.g. `job.json#attempts[0].prompt`.
	PromptRef string
}

// RpcLogs is a worker session's two attempt logs.
type RpcLogs interface {
	// Inbound appends the log line for one inbound frame.
	Inbound(line string)
	// Outbound appends the log line for one outbound command, as sent.
	Outbound(command json.RawMessage)
	// Failure is the first write failure, once one happens; logging stops after it.
	Failure() (string, bool)
	// Close flushes and closes both files.
	Close(ctx context.Context) error
}

// noLogs is what OpenRpcLogs returns without paths: nothing is logged.
type noLogs struct{}

func (noLogs) Inbound(string)              {}
func (noLogs) Outbound(json.RawMessage)    {}
func (noLogs) Failure() (string, bool)     { return "", false }
func (noLogs) Close(context.Context) error { return nil }

// OpenRpcLogs opens both logs for appending (0600, the directory created when missing); without
// paths nothing is logged.
func OpenRpcLogs(ctx context.Context, paths *RpcLogPaths) (RpcLogs, error) {
	if paths == nil {
		return noLogs{}, nil
	}
	frames, err := appendStream(paths.Stdout)
	if err != nil {
		return nil, err
	}
	commands, err := appendStream(paths.Stdin)
	if err != nil {
		frames.Close()
		return nil, err
	}
	return CreateRpcLogs(frames, commands, paths.PromptRef), nil
}

// CreateRpcLogs wires two opened append files into the logs.
func CreateRpcLogs(frames *os.File, commands *os.File, promptRef string) RpcLogs {
	return &fileLogs{frames: frames, commands: commands, promptRef: promptRef}
}

// fileLogs writes both attempt logs; the first write or close failure stops all logging. An
// engine client logs inbound frames from its reader goroutine and outbound commands from
// whichever caller sends them, so every method takes the lock.
type fileLogs struct {
	frames    *os.File
	commands  *os.File
	promptRef string
	mu        sync.Mutex
	failure   string
	closed    bool
}

func (l *fileLogs) Inbound(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.failure == "" {
		l.write(l.frames, line+"\n")
	}
}

func (l *fileLogs) Outbound(command json.RawMessage) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.failure == "" {
		l.write(l.commands, OutboundLogText(command, l.promptRef)+"\n")
	}
}

func (l *fileLogs) Failure() (string, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.failure, l.failure != ""
}

// Close closes both files; a close failure is recorded as the logs' failure and close itself
// never fails. A second Close is a no-op.
func (l *fileLogs) Close(ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	l.closed = true
	for _, file := range []*os.File{l.frames, l.commands} {
		if err := file.Close(); err != nil {
			l.record(err)
		}
	}
	return nil
}

func (l *fileLogs) write(file *os.File, text string) {
	if _, err := file.WriteString(text); err != nil {
		l.record(err)
	}
}

func (l *fileLogs) record(err error) {
	if l.failure == "" {
		l.failure = err.Error()
	}
}

// appendStream opens path for appending (0600), creating its directory when missing.
func appendStream(path string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("cannot open log %s: %w", path, err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("cannot open log %s: %w", path, err)
	}
	return file, nil
}
