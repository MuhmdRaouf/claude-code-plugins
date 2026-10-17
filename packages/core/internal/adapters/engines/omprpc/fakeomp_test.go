package omprpc

// The fake omp as a child of this test binary: ENGINE_TEST_CHILD selects the role the
// re-executed binary plays, so no other runtime is ever started. The fake speaks the frames
// recorded from omp 18.6.1 (testdata/engines/omp-rpc).

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/shared"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
)

const childModeEnv = "ENGINE_TEST_CHILD"

// childDeadline bounds every child the tests start, so one that escapes its test's cleanup cannot
// linger.
const childDeadline = 60 * time.Second

func TestMain(m *testing.M) {
	switch os.Getenv(childModeEnv) {
	case "":
		os.Exit(m.Run())
	case "omp":
		runFakeOmp(os.Args[1:])
	case "hold-stdout", "group-sleeper":
		time.Sleep(childDeadline)
	}
	os.Exit(0)
}

// --- ordered JSON ---------------------------------------------------------------------------------------------

// The fake writes frames as object literals: members in source order, a member whose value is
// undefined dropped, the way JSON.stringify renders them. Go maps cannot do that, so the fake
// builds its JSON through fields held in a slice.
type fld struct {
	name  string
	value any
}

func fStr(name, value string) fld     { return fld{name, value} }
func fInt(name string, value int) fld { return fld{name, value} }
func fVal(name string, value any) fld { return fld{name, value} }
func fBool(name string, value bool) fld {
	return fld{name, value}
}
func fRaw(name string, value json.RawMessage) fld { return fld{name, value} }

// object renders fields as one JSON object, in order; a nil RawMessage value is dropped.
func object(fields ...fld) json.RawMessage {
	var out bytes.Buffer
	out.WriteByte('{')
	first := true
	write := func(name string, value any) {
		if !first {
			out.WriteByte(',')
		}
		first = false
		jsonString(&out, name)
		out.WriteByte(':')
		encodeValue(&out, value)
	}
	for _, field := range fields {
		if raw, ok := field.value.(json.RawMessage); ok && raw == nil {
			continue
		}
		write(field.name, field.value)
	}
	out.WriteByte('}')
	return json.RawMessage(out.Bytes())
}

// array renders values as one JSON array.
func array(values ...any) json.RawMessage {
	var out bytes.Buffer
	out.WriteByte('[')
	for i, value := range values {
		if i > 0 {
			out.WriteByte(',')
		}
		encodeValue(&out, value)
	}
	out.WriteByte(']')
	return json.RawMessage(out.Bytes())
}

func encodeValue(out *bytes.Buffer, value any) {
	switch v := value.(type) {
	case json.RawMessage:
		out.Write(v)
	case nil:
		out.WriteString("null")
	case string:
		jsonString(out, v)
	case bool:
		if v {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	case int:
		out.WriteString(strconv.Itoa(v))
	case int64:
		out.WriteString(strconv.FormatInt(v, 10))
	case float64:
		encoded, err := json.Marshal(v)
		if err != nil {
			out.WriteString("0")
			return
		}
		out.Write(encoded)
	case []any:
		out.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				out.WriteByte(',')
			}
			encodeValue(out, item)
		}
		out.WriteByte(']')
	default:
		encoded, err := json.Marshal(v)
		if err != nil {
			out.WriteString("null")
			return
		}
		out.Write(encoded)
	}
}

// jsonString writes text as a JSON string the way JSON.stringify does: no HTML escaping, the short
// escapes, and every other byte as written.
func jsonString(out *bytes.Buffer, text string) {
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

// rawString reads a raw JSON member as a string, "" for anything else.
func rawString(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return ""
	}
	return text
}

// rawNumber reads a raw JSON member as a number, 0 for anything else.
func rawNumber(raw json.RawMessage) float64 {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return 0
	}
	if number, ok := value.(float64); ok {
		return number
	}
	return 0
}

// rawBool reads a raw JSON member as true, false for anything else.
func rawBool(raw json.RawMessage) bool {
	var value bool
	return json.Unmarshal(raw, &value) == nil && value
}

// withoutID rewrites a JSON object with its id member dropped, every other member kept in order.
func withoutID(raw json.RawMessage) json.RawMessage {
	var out bytes.Buffer
	out.WriteByte('{')
	first := true
	walkMembers(raw, func(name string, value json.RawMessage) bool {
		if name == "id" {
			return true
		}
		if !first {
			out.WriteByte(',')
		}
		first = false
		jsonString(&out, name)
		out.WriteByte(':')
		out.Write(value)
		return true
	})
	out.WriteByte('}')
	return json.RawMessage(out.Bytes())
}

// replaceID rewrites a JSON object's id member in place, every member kept in order.
func replaceID(raw json.RawMessage, id string) json.RawMessage {
	var out bytes.Buffer
	out.WriteByte('{')
	first := true
	walkMembers(raw, func(name string, value json.RawMessage) bool {
		if !first {
			out.WriteByte(',')
		}
		first = false
		jsonString(&out, name)
		out.WriteByte(':')
		if name == "id" {
			jsonString(&out, id)
		} else {
			out.Write(value)
		}
		return true
	})
	out.WriteByte('}')
	return json.RawMessage(out.Bytes())
}

// walkMembers visits each member of raw (a JSON object) in written order; broken JSON ends the walk.
func walkMembers(raw json.RawMessage, visit func(name string, value json.RawMessage) bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	opening, err := decoder.Token()
	if err != nil {
		return
	}
	if delim, ok := opening.(json.Delim); !ok || delim != '{' {
		return
	}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return
		}
		key, isKey := keyToken.(string)
		var value json.RawMessage
		if !isKey || decoder.Decode(&value) != nil {
			return
		}
		if !visit(key, value) {
			return
		}
	}
}

// --- the fake omp ----------------------------------------------------------------------------------------------

// writeFakeJSON writes value as one JSON line the way JSON.stringify would (no HTML escaping).
func writeFakeJSON(path string, value any) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(value) != nil {
		return
	}
	_ = os.WriteFile(path, out.Bytes(), 0o600)
}

// loggedChildEnv is the environment the tool sees: the harness's own knobs (the fake's FAKE_*,
// the child mode, the coverage dir) left out.
func loggedChildEnv(environ []string) map[string]string {
	env := map[string]string{}
	for _, entry := range environ {
		name, value, found := strings.Cut(entry, "=")
		if !found || strings.HasPrefix(name, "FAKE_") || name == childModeEnv || name == "GOCOVERDIR" {
			continue
		}
		env[name] = value
	}
	return env
}

const (
	fakeFrameBytes = 1024 * 1024
	fakeChunkBytes = 256 * 1024
	fakeMaxTries   = 3
	fakeSessionID  = "01a11109-0000-7000-8000-000000000001"
)

// Frame types omp's event filter applies to; anything else is always emitted.
var fakeFilterable = map[string]bool{
	"agent_start": true, "agent_end": true, "turn_start": true, "turn_end": true,
	"message_start": true, "message_update": true, "message_end": true,
	"tool_execution_start": true, "tool_execution_update": true, "tool_execution_end": true,
	"auto_compaction_start": true, "auto_compaction_end": true,
	"auto_retry_start": true, "auto_retry_end": true, "retry_fallback_applied": true,
	"notice": true,
}

var fakeValueFlags = map[string]bool{
	"--mode": true, "--config": true, "--session-dir": true, "--model": true, "--thinking": true,
	"--tools": true, "--approval-mode": true, "--add-dir": true, "--resume": true,
}

var fakeBooleanFlags = map[string]bool{
	"--no-ui": true, "--no-extensions": true, "--no-skills": true, "--no-rules": true,
	"--no-title": true,
}

// fakeTurn is the prompt a scenario runs for; abortCh carries the abort command when the host aborts.
type fakeTurn struct {
	promptID string
	abortCh  chan map[string]json.RawMessage
}

type fakeStats struct {
	userMessages      int
	assistantMessages int
	toolCalls         int
	input             int
	output            int
	cacheRead         int
	cost              float64
}

type fakeOmp struct {
	flags map[string]string
	cwd   string
	model string

	outMu   sync.Mutex // stdout and the wire log
	wireLog *os.File

	mu          sync.Mutex // everything below
	protocol    int
	filter      map[string]bool
	filterSet   bool
	chunkIds    int
	messageIds  int
	stats       fakeStats
	hostTools   []string
	turn        *fakeTurn
	settleTimer *time.Timer
	inputEnded  bool
	hostReplies map[string]chan map[string]json.RawMessage
	hostCallIds int
}

func runFakeOmp(args []string) {
	// One backstop for every child: a fake stuck without its host dies here, not in CI.
	time.AfterFunc(childDeadline, func() { os.Exit(99) })
	// --version is answered before the flags are parsed, as the real omp does.
	for _, arg := range args {
		if arg == "--version" {
			version := os.Getenv("FAKE_OMP_VERSION")
			if version == "" {
				version = "18.6.1"
			}
			os.Stdout.WriteString("omp/" + version + "\n")
			os.Exit(0)
		}
	}
	f := newFakeOmp(args)
	if f.flags["--mode"] != "rpc" {
		os.Stderr.WriteString("fake omp: only --mode rpc is supported\n")
		os.Exit(2)
	}
	if fixture := os.Getenv("FAKE_OMP_FIXTURE"); fixture != "" {
		f.replay(fixture)
	}
	f.serve()
	// A settle or a turn still owed keeps the process up; its goroutine exits when it is done.
	select {}
}

func newFakeOmp(args []string) *fakeOmp {
	flags := map[string]string{}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if fakeBooleanFlags[arg] {
			flags[arg] = ""
		} else if fakeValueFlags[arg] && i+1 < len(args) {
			flags[arg] = args[i+1]
			i++
		} else {
			os.Stderr.WriteString("Error: Unknown option: " + arg + "\n")
			os.Exit(2)
		}
	}
	cwd, _ := os.Getwd()
	model, ok := flags["--model"]
	if !ok {
		model = "zai/glm-5.3"
	}
	f := &fakeOmp{
		flags:       flags,
		cwd:         cwd,
		model:       strings.TrimPrefix(model, "zai/"),
		hostReplies: map[string]chan map[string]json.RawMessage{},
	}
	if path := os.Getenv("FAKE_OMP_WIRE_LOG"); path != "" {
		if file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			f.wireLog = file
		}
	}
	return f
}

// --- output -----------------------------------------------------------------------------------------------------

func (f *fakeOmp) wire(line string) {
	f.outMu.Lock()
	defer f.outMu.Unlock()
	_, _ = os.Stdout.WriteString(line)
	if f.wireLog != nil {
		_, _ = f.wireLog.WriteString(line)
	}
}

func (f *fakeOmp) writeFrame(frame json.RawMessage) {
	text := string(frame)
	f.mu.Lock()
	protocol := f.protocol
	f.mu.Unlock()
	if protocol < 2 || len(text)+1 <= fakeFrameBytes {
		f.wire(text + "\n")
		return
	}
	f.mu.Lock()
	f.chunkIds++
	chunkID := fmt.Sprintf("rpc-%d", f.chunkIds)
	f.mu.Unlock()
	data := []byte(text)
	count := (len(data) + fakeChunkBytes - 1) / fakeChunkBytes
	for index := 0; index < count; index++ {
		end := min((index+1)*fakeChunkBytes, len(data))
		chunk := object(
			fStr("type", "rpc_chunk"),
			fStr("chunkId", chunkID),
			fInt("index", index),
			fInt("count", count),
			fInt("byteLength", len(data)),
			fStr("data", base64.StdEncoding.EncodeToString(data[index*fakeChunkBytes:end])),
		)
		f.wire(string(chunk) + "\n")
	}
}

func (f *fakeOmp) emit(frame json.RawMessage) {
	frameType := rawString(frameTypeMember(frame))
	f.mu.Lock()
	filter, filterSet := f.filter, f.filterSet
	f.mu.Unlock()
	if filterSet && fakeFilterable[frameType] && !filter[frameType] {
		return
	}
	f.writeFrame(frame)
}

// frameTypeMember reads a raw frame's type member.
func frameTypeMember(frame json.RawMessage) json.RawMessage {
	var members map[string]json.RawMessage
	if json.Unmarshal(frame, &members) != nil {
		return nil
	}
	return members["type"]
}

func (f *fakeOmp) respond(command map[string]json.RawMessage, data json.RawMessage) {
	f.writeFrame(object(
		fRaw("id", command["id"]),
		fStr("type", "response"),
		fRaw("command", command["type"]),
		fBool("success", true),
		fRaw("data", data),
	))
}

func (f *fakeOmp) refuse(command map[string]json.RawMessage, message string) {
	f.writeFrame(object(
		fRaw("id", command["id"]),
		fStr("type", "response"),
		fRaw("command", command["type"]),
		fBool("success", false),
		fStr("error", message),
	))
}

// --- session ----------------------------------------------------------------------------------------------------

func (f *fakeOmp) state() json.RawMessage {
	f.mu.Lock()
	messageCount := f.stats.userMessages + f.stats.assistantMessages
	hostTools := append([]string(nil), f.hostTools...)
	f.mu.Unlock()
	toolsList, ok := f.flags["--tools"]
	if !ok {
		toolsList = "read,bash,edit,eval,glob,grep,todo,web_search,write"
	}
	var dumpTools []any
	for _, name := range append(strings.Split(toolsList, ","), hostTools...) {
		dumpTools = append(dumpTools, object(fStr("name", name)))
	}
	sessionDir, ok := f.flags["--session-dir"]
	if !ok {
		sessionDir = f.cwd
	}
	thinking, ok := f.flags["--thinking"]
	if !ok {
		thinking = "low"
	}
	return object(
		fRaw("model", object(fStr("id", f.model), fStr("provider", "zai"), fStr("api", "anthropic-messages"))),
		fStr("thinkingLevel", thinking),
		fStr("sessionId", fakeSessionID),
		fStr("sessionFile", filepath.Join(sessionDir, "fake_"+fakeSessionID+".jsonl")),
		fInt("messageCount", messageCount),
		fRaw("dumpTools", array(dumpTools...)),
		fRaw("systemPrompt", array("fake omp system prompt",
			"<project-context>\n<repo-rules>\n</repo-rules>\n</project-context>")),
	)
}

func (f *fakeOmp) sessionStats() json.RawMessage {
	f.mu.Lock()
	stats := f.stats
	f.mu.Unlock()
	return object(
		fStr("sessionId", fakeSessionID),
		fInt("userMessages", stats.userMessages),
		fInt("assistantMessages", stats.assistantMessages),
		fInt("toolCalls", stats.toolCalls),
		fRaw("tokens", object(
			fInt("input", stats.input),
			fInt("output", stats.output),
			fInt("reasoning", 0),
			fInt("cacheRead", stats.cacheRead),
			fInt("cacheWrite", 0),
			fInt("total", stats.input+stats.output+stats.cacheRead),
		)),
		fVal("cost", stats.cost),
	)
}

func (f *fakeOmp) message(role string, fields ...fld) {
	f.mu.Lock()
	f.messageIds++
	messageID := f.messageIds
	f.mu.Unlock()
	all := append([]fld{fStr("role", role)}, fields...)
	all = append(all, fInt("timestamp", int(time.Now().UnixMilli())))
	f.emit(object(
		fStr("type", "message_end"),
		fRaw("message", object(all...)),
		fStr("messageId", fmt.Sprintf("msg-%d", messageID)),
	))
}

func (f *fakeOmp) assistant(content json.RawMessage, stopReason string, extra ...fld) {
	f.mu.Lock()
	f.stats.assistantMessages++
	f.stats.input += 100
	f.stats.output += 20
	f.stats.cacheRead += 50
	f.stats.cost += 0.0001
	f.mu.Unlock()
	fields := []fld{
		fRaw("content", content),
		fStr("api", "anthropic-messages"),
		fStr("provider", "zai"),
		fStr("model", f.model),
		fRaw("usage", object(
			fInt("input", 100), fInt("output", 20), fInt("cacheRead", 50), fInt("cacheWrite", 0),
			fInt("totalTokens", 170), fRaw("cost", object(fVal("total", 0.0001))),
		)),
		fStr("stopReason", stopReason),
	}
	f.message("assistant", append(fields, extra...)...)
}

func (f *fakeOmp) toolCall(id, name string, args json.RawMessage, intent string) json.RawMessage {
	f.mu.Lock()
	f.stats.toolCalls++
	f.mu.Unlock()
	return object(
		fStr("type", "toolCall"),
		fStr("id", id),
		fStr("name", name),
		fRaw("arguments", args),
		fStr("intent", intent),
	)
}

func (f *fakeOmp) toolEnd(id, name string, content, details json.RawMessage, isError bool) {
	f.emit(object(
		fStr("type", "tool_execution_end"),
		fStr("toolCallId", id),
		fStr("toolName", name),
		fRaw("result", object(fRaw("content", content), fRaw("details", details))),
		fBool("isError", isError),
	))
	f.message("toolResult",
		fStr("toolCallId", id),
		fStr("toolName", name),
		fRaw("content", content),
		fRaw("details", details),
		fBool("isError", isError),
	)
}

// splitAfterSpace cuts text after each space, as JS's split(/(?<= ))/ does.
func splitAfterSpace(text string) []string {
	var parts []string
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == ' ' {
			parts = append(parts, text[start:i+1])
			start = i + 1
		}
	}
	if start < len(text) {
		parts = append(parts, text[start:])
	}
	return parts
}

func (f *fakeOmp) textDeltas(text string) {
	f.mu.Lock()
	messageID := fmt.Sprintf("msg-%d", f.messageIds+1)
	f.mu.Unlock()
	update := func(event ...fld) {
		all := append([]fld{fInt("contentIndex", 0)}, event...)
		f.emit(object(
			fStr("type", "message_update"),
			fRaw("assistantMessageEvent", object(all...)),
			fRaw("message", object(fStr("role", "assistant"))),
			fStr("messageId", messageID),
		))
	}
	update(fStr("type", "text_start"))
	for _, word := range splitAfterSpace(text) {
		update(fStr("type", "text_delta"), fStr("delta", word))
	}
	update(fStr("type", "text_end"))
}

// --- turns ------------------------------------------------------------------------------------------------------

func (f *fakeOmp) finish(status string) {
	f.mu.Lock()
	promptID := ""
	if f.turn != nil {
		promptID = f.turn.promptID
	}
	f.turn = nil
	f.mu.Unlock()
	late := os.Getenv("FAKE_OMP_LATE_SETTLE") == "1"
	noAgent := os.Getenv("FAKE_OMP_NO_AGENT") == "1"
	fields := []fld{fStr("type", "prompt_result")}
	if promptID != "" {
		fields = append(fields, fStr("id", promptID))
	}
	f.writeFrame(object(append(fields,
		fBool("agentInvoked", !noAgent),
		fStr("status", status),
		fBool("sessionSettled", !late && !noAgent),
	)...))
	if noAgent {
		f.mu.Lock()
		ended := f.inputEnded
		f.mu.Unlock()
		if ended {
			os.Exit(0)
		}
		return
	}
	if late {
		f.mu.Lock()
		f.settleTimer = time.AfterFunc(100*time.Millisecond, f.settled)
		f.mu.Unlock()
		return
	}
	f.settled()
}

func (f *fakeOmp) settled() {
	f.mu.Lock()
	f.settleTimer = nil
	ended := f.inputEnded
	f.mu.Unlock()
	f.writeFrame(object(fStr("type", "session_settled")))
	if ended {
		os.Exit(0)
	}
}

// omp's abort order: the cancelled tool, the aborted assistant message, the abort response, prompt_result.
func (f *fakeOmp) cancelTool(id, name string, abort map[string]json.RawMessage) {
	f.toolEnd(id, name,
		array(object(fStr("type", "text"), fStr("text", "[Command cancelled]\n"))),
		object(), true)
	f.endAborted(abort)
}

func (f *fakeOmp) endAborted(abort map[string]json.RawMessage) {
	f.assistant(array(), "aborted", fStr("errorMessage", "Interrupted by user"))
	f.respond(abort, nil)
	f.finish("aborted")
}

// hostCall emits host_tool_call and waits for the host's result, or for an abort (then omp sends
// host_tool_cancel).
func (f *fakeOmp) hostCall(toolCallID, name string, args json.RawMessage, turn *fakeTurn) (map[string]json.RawMessage, bool) {
	f.mu.Lock()
	f.hostCallIds++
	id := fmt.Sprintf("host-%d", f.hostCallIds)
	f.mu.Unlock()
	replies := make(chan map[string]json.RawMessage, 1)
	f.mu.Lock()
	f.hostReplies[id] = replies
	f.mu.Unlock()
	f.writeFrame(object(
		fStr("type", "host_tool_call"),
		fStr("id", id),
		fStr("toolCallId", toolCallID),
		fStr("toolName", name),
		fRaw("arguments", args),
	))
	select {
	case reply := <-replies:
		f.mu.Lock()
		delete(f.hostReplies, id)
		f.mu.Unlock()
		return reply, false
	case command := <-turn.abortCh:
		f.mu.Lock()
		delete(f.hostReplies, id)
		f.hostCallIds++
		cancelID := fmt.Sprintf("host-%d", f.hostCallIds)
		f.mu.Unlock()
		f.writeFrame(object(
			fStr("type", "host_tool_cancel"),
			fStr("id", cancelID),
			fStr("targetId", id),
		))
		f.endAborted(command)
		return nil, true
	}
}

func (f *fakeOmp) submitReport(turn *fakeTurn) bool {
	report := json.RawMessage(os.Getenv("FAKE_OMP_REPORT"))
	if len(report) == 0 {
		report = json.RawMessage(`{"summary":"fake run"}`)
	}
	f.mu.Lock()
	hasReport := false
	for _, name := range f.hostTools {
		if name == "submit_report" {
			hasReport = true
		}
	}
	f.mu.Unlock()
	if !hasReport {
		return true
	}
	for attempt := 1; attempt <= fakeMaxTries; attempt++ {
		id := fmt.Sprintf("call_report_%d", attempt)
		f.assistant(array(f.toolCall(id, "submit_report", report, "Submitting the report")), "toolUse")
		reply, aborted := f.hostCall(id, "submit_report", report, turn)
		if aborted {
			return false
		}
		f.emit(object(
			fStr("type", "tool_execution_start"),
			fStr("toolCallId", id),
			fStr("toolName", "submit_report"),
			fRaw("args", report),
			fStr("intent", "Submitting the report"),
		))
		isError := false
		content := array()
		if reply != nil {
			isError = rawBool(reply["isError"])
			if result, ok := reply["result"]; ok {
				var members map[string]json.RawMessage
				if json.Unmarshal(result, &members) == nil && members["content"] != nil {
					content = members["content"]
				}
			}
		}
		f.toolEnd(id, "submit_report", content, object(), isError)
		if !isError {
			return true
		}
	}
	return true
}

func (f *fakeOmp) ok(turn *fakeTurn) {
	f.textDeltas("Working on it.")
	if !f.submitReport(turn) {
		return
	}
	finalText := os.Getenv("FAKE_OMP_FINAL_TEXT")
	if finalText == "" {
		finalText = "done"
	}
	f.textDeltas(finalText)
	f.assistant(array(object(fStr("type", "text"), fStr("text", finalText))), "stop")
	f.finish("completed")
}

// longTool runs a bash tool that never finishes, until the host aborts.
func (f *fakeOmp) longTool(turn *fakeTurn, onAbort func()) {
	id := "call_bash_1"
	args := object(fStr("command", "sleep 600"), fInt("timeout", 900))
	f.assistant(array(f.toolCall(id, "bash", args, "Sleeping")), "toolUse")
	f.emit(object(
		fStr("type", "tool_execution_start"),
		fStr("toolCallId", id),
		fStr("toolName", "bash"),
		fRaw("args", args),
		fStr("intent", "Sleeping"),
	))
	command := <-turn.abortCh
	if onAbort != nil {
		onAbort()
	}
	f.cancelTool(id, "bash", command)
}

func (f *fakeOmp) bashChild(turn *fakeTurn) {
	exe, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}
	// The grandchild runs in its own process group, as omp's bash tool does: a signal to omp's
	// group leaves it alone, omp's abort kills it.
	child := exec.Command(exe)
	child.Env = []string{childModeEnv + "=group-sleeper"}
	child.SysProcAttr = ownGroupAttr()
	if err := child.Start(); err != nil {
		os.Exit(1)
	}
	// Node reaps its spawned children on its own; Go leaves them as zombies, which answer the
	// liveness probe, so the fake waits the grandchild out.
	go func() { _ = child.Wait() }()
	if pidFile := os.Getenv("FAKE_OMP_CHILD_PIDFILE"); pidFile != "" {
		_ = os.WriteFile(pidFile, []byte(strconv.Itoa(child.Process.Pid)), 0o600)
	}
	f.longTool(turn, func() { killGroup(child.Process.Pid) })
}

func (f *fakeOmp) bigFrame(turn *fakeTurn) {
	id := "call_read_1"
	details := object(fRaw("displayContent", object(fStr("text", strings.Repeat("y", 3*1024*1024)))))
	content := array(object(fStr("type", "text"), fStr("text", strings.Repeat("y", 40*1024))))
	f.assistant(array(f.toolCall(id, "read", object(fStr("path", "big.txt")), "Reading big.txt")), "toolUse")
	f.emit(object(
		fStr("type", "tool_execution_start"),
		fStr("toolCallId", id),
		fStr("toolName", "read"),
		fRaw("args", object(fStr("path", "big.txt"))),
		fStr("intent", "Reading big.txt"),
	))
	f.toolEnd(id, "read", content, details, false)
	f.ok(turn)
}

func (f *fakeOmp) crash() {
	f.assistant(array(f.toolCall("call_bash_1", "bash", object(fStr("command", "true")), "Checking")), "toolUse")
	os.Stderr.WriteString("fake omp: simulated crash\n")
	os.Exit(1)
}

func (f *fakeOmp) runScenario(scenario string, turn *fakeTurn) {
	switch scenario {
	case "ok":
		f.ok(turn)
	case "sleep", "ignore-abort":
		f.longTool(turn, nil)
	case "bash-child":
		f.bashChild(turn)
	case "big-frame":
		f.bigFrame(turn)
	case "crash":
		f.crash()
	}
}

// --- commands ---------------------------------------------------------------------------------------------------

func (f *fakeOmp) handle(line string) {
	var command map[string]json.RawMessage
	if json.Unmarshal([]byte(line), &command) != nil {
		return
	}
	commandType := rawString(command["type"])
	switch commandType {
	case "negotiate_protocol":
		protocol := int(rawNumber(command["protocolVersion"]))
		f.mu.Lock()
		f.protocol = protocol
		f.mu.Unlock()
		f.respond(command, object(fInt("protocolVersion", protocol)))
	case "set_host_tools":
		var names []string
		var tools []map[string]json.RawMessage
		if raw := command["tools"]; raw != nil && json.Unmarshal(raw, &tools) == nil {
			for _, tool := range tools {
				names = append(names, rawString(tool["name"]))
			}
		}
		f.mu.Lock()
		f.hostTools = names
		f.mu.Unlock()
		var nameValues []any
		for _, name := range names {
			nameValues = append(nameValues, name)
		}
		f.respond(command, object(fRaw("toolNames", array(nameValues...))))
	case "set_event_filter":
		var events []string
		_ = json.Unmarshal(command["events"], &events)
		filter := map[string]bool{}
		for _, event := range events {
			filter[event] = true
		}
		f.mu.Lock()
		f.filter = filter
		f.filterSet = true
		f.mu.Unlock()
		f.respond(command, object(fRaw("events", command["events"]), fRaw("messageUpdates", command["messageUpdates"])))
	case "get_state":
		f.respond(command, f.state())
	case "get_session_stats":
		f.respond(command, f.sessionStats())
	case "prompt":
		f.prompt(command)
	case "abort":
		f.abort(command)
	case "host_tool_result":
		id := rawString(command["id"])
		f.mu.Lock()
		replies := f.hostReplies[id]
		delete(f.hostReplies, id)
		f.mu.Unlock()
		if replies != nil {
			replies <- command
		}
	default:
		f.refuse(command, "Unknown command: "+commandType)
	}
}

func (f *fakeOmp) prompt(command map[string]json.RawMessage) {
	scenario := os.Getenv("FAKE_OMP_SCENARIO")
	if scenario == "" {
		scenario = "ok"
	}
	known := map[string]bool{
		"ok": true, "sleep": true, "ignore-abort": true, "bash-child": true, "big-frame": true,
		"crash": true,
	}
	f.mu.Lock()
	if !known[scenario] || f.turn != nil {
		f.mu.Unlock()
		f.refuse(command, "cannot prompt now")
		return
	}
	f.mu.Unlock()
	f.respond(command, nil)
	turn := &fakeTurn{
		promptID: rawString(command["id"]),
		abortCh:  make(chan map[string]json.RawMessage, 1),
	}
	f.mu.Lock()
	f.turn = turn
	f.stats.userMessages++
	f.mu.Unlock()
	f.message("user",
		fRaw("content", array(object(fStr("type", "text"), fStr("text", rawString(command["message"]))))),
		fStr("attribution", "user"),
	)
	f.writeFrame(object(fStr("type", "advisor_cost_changed")))
	if os.Getenv("FAKE_OMP_NO_AGENT") == "1" {
		f.finish("completed")
		return
	}
	go f.runScenario(scenario, turn)
}

func (f *fakeOmp) abort(command map[string]json.RawMessage) {
	f.mu.Lock()
	turn := f.turn
	f.mu.Unlock()
	if turn == nil || os.Getenv("FAKE_OMP_SCENARIO") == "ignore-abort" {
		f.respond(command, nil)
		return
	}
	select {
	case turn.abortCh <- command:
	default:
	}
}

// --- serve ------------------------------------------------------------------------------------------------------

func (f *fakeOmp) serve() {
	// The recorders the adapter tests read: the command line as a one-line JSON array, the whole
	// environment as one JSON object (the fake's own knobs, the child mode and the coverage dir
	// left out).
	if path := os.Getenv("FAKE_OMP_ARGV_LOG"); path != "" {
		writeFakeJSON(path, os.Args[1:])
	}
	if path := os.Getenv("FAKE_OMP_ENV_LOG"); path != "" {
		writeFakeJSON(path, loggedChildEnv(os.Environ()))
	}
	// A resume the session store does not know dies before ready, as the real omp does.
	if os.Getenv("FAKE_OMP_RESUME_MISSING") == "1" {
		if resume, ok := f.flags["--resume"]; ok {
			fmt.Fprintf(os.Stderr, "Session %q not found.\n", resume)
			os.Exit(1)
		}
	}
	// omp dying right after booting, mid-handshake: one stray frame, then exit 1 (a Go-side
	// scenario; the worker folds such frames nowhere, the exit carries the story).
	if os.Getenv("FAKE_OMP_DIE_AFTER_READY") == "1" {
		f.writeFrame(object(
			fStr("type", "ready"),
			fInt("protocolVersion", 1),
			fRaw("supportedProtocolVersions", array(float64(1), float64(2))),
			fInt("maxFrameBytes", fakeFrameBytes),
		))
		f.writeFrame(object(
			fStr("type", "message_update"),
			fRaw("assistantMessageEvent", object(fStr("type", "text_delta"), fStr("delta", "left over"))),
			fRaw("message", object(fStr("role", "assistant"))),
			fStr("messageId", "msg-1"),
		))
		os.Exit(1)
	}
	if os.Getenv("FAKE_OMP_SCENARIO") == "ignore-abort" {
		// The scenario ignores both abort and SIGTERM, as a wedged omp would.
		signal.Notify(make(chan os.Signal, 1), syscall.SIGTERM)
	}
	if pidFile := os.Getenv("FAKE_OMP_PIDFILE"); pidFile != "" {
		f.startGrandchild(pidFile)
	}
	if os.Getenv("FAKE_OMP_GARBAGE") == "1" {
		f.wire("this is not json\n")
	}
	if delay := rawNumber(json.RawMessage(os.Getenv("FAKE_OMP_READY_DELAY_MS"))); delay > 0 {
		os.Stderr.WriteString("Still starting after 10s — phase: discoverCustomToolPaths\n")
		time.Sleep(time.Duration(delay) * time.Millisecond)
	}
	versions := os.Getenv("FAKE_OMP_PROTOCOLS")
	if versions == "" {
		versions = "1,2"
	}
	var versionValues []any
	for _, part := range strings.Split(versions, ",") {
		if number, err := strconv.ParseFloat(strings.TrimSpace(part), 64); err == nil {
			versionValues = append(versionValues, number)
		}
	}
	f.writeFrame(object(
		fStr("type", "ready"),
		fInt("protocolVersion", 1),
		fRaw("supportedProtocolVersions", array(versionValues...)),
		fInt("maxFrameBytes", fakeFrameBytes),
	))
	f.writeFrame(object(fStr("type", "advisor_cost_changed")))
	f.writeFrame(object(
		fStr("type", "available_commands_update"),
		fRaw("commands", array(object(fStr("name", "dump"), fStr("description", "Dump the session")))),
	))
	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := reader.ReadString('\n')
		if trimmed := strings.TrimRight(line, "\r\n"); trimmed != "" {
			f.handle(trimmed)
		}
		if err != nil {
			break
		}
	}
	f.mu.Lock()
	f.inputEnded = true
	leave := f.turn == nil && f.settleTimer == nil
	f.mu.Unlock()
	// A settle still owed keeps the process up; the exit comes once it is sent.
	if leave {
		os.Exit(0)
	}
}

// startGrandchild starts a child of omp's own group that holds stdout open and outlives omp.
func (f *fakeOmp) startGrandchild(pidFile string) {
	exe, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}
	grandchild := exec.Command(exe)
	grandchild.Env = []string{childModeEnv + "=hold-stdout"}
	grandchild.Stdout = os.Stdout
	grandchild.Stderr = os.Stderr
	if err := grandchild.Start(); err != nil {
		os.Exit(1)
	}
	_ = os.WriteFile(pidFile, []byte(fmt.Sprintf("%d %d", os.Getpid(), grandchild.Process.Pid)), 0o600)
}

// --- fixture replay --------------------------------------------------------------------------------------------

// fakeInbox collects the host's commands until the replay needs one of a type.
type fakeInbox struct {
	mu       sync.Mutex
	cond     *sync.Cond
	received []map[string]json.RawMessage
	ended    chan struct{}
}

func newFakeInbox() *fakeInbox {
	inbox := &fakeInbox{ended: make(chan struct{})}
	inbox.cond = sync.NewCond(&inbox.mu)
	go func() {
		defer close(inbox.ended)
		reader := bufio.NewReader(os.Stdin)
		for {
			line, err := reader.ReadString('\n')
			if trimmed := strings.TrimRight(line, "\r\n"); trimmed != "" {
				var command map[string]json.RawMessage
				if json.Unmarshal([]byte(trimmed), &command) == nil {
					inbox.mu.Lock()
					inbox.received = append(inbox.received, command)
					inbox.cond.Signal()
					inbox.mu.Unlock()
				}
			}
			if err != nil {
				return
			}
		}
	}()
	return inbox
}

// take returns the first not-yet-taken command of the type, waiting for one to arrive.
func (i *fakeInbox) take(commandType string) map[string]json.RawMessage {
	i.mu.Lock()
	defer i.mu.Unlock()
	for {
		for at, command := range i.received {
			if rawString(command["type"]) == commandType {
				taken := command
				i.received = append(i.received[:at], i.received[at+1:]...)
				return taken
			}
		}
		i.cond.Wait()
	}
}

// replay replays a recorded fixture in lockstep: outbound frames are written in order, and before
// each recorded inbound command it waits for the host to send a command of that type.
func (f *fakeOmp) replay(dir string) {
	if stderr, err := os.ReadFile(filepath.Join(dir, "stderr.txt")); err == nil {
		os.Stderr.Write(stderr)
	}
	metaRaw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		os.Exit(1)
	}
	var meta struct {
		Exit float64 `json:"exit"`
	}
	if json.Unmarshal(metaRaw, &meta) != nil {
		os.Exit(1)
	}
	entriesRaw, err := os.ReadFile(filepath.Join(dir, "interleaved.jsonl"))
	if err != nil {
		os.Exit(1)
	}
	var entries []struct {
		Dir   string          `json:"dir"`
		Frame json.RawMessage `json:"frame"`
	}
	for _, line := range strings.Split(string(entriesRaw), "\n") {
		if line == "" {
			continue
		}
		var entry struct {
			Dir   string          `json:"dir"`
			Frame json.RawMessage `json:"frame"`
		}
		if json.Unmarshal([]byte(line), &entry) == nil {
			entries = append(entries, entry)
		}
	}
	inbox := newFakeInbox()
	ids := map[string]string{}
	for _, entry := range entries {
		if entry.Dir == "in" {
			sent := inbox.take(rawString(frameTypeMember(entry.Frame)))
			ids[rawString(idMember(entry.Frame))] = rawString(sent["id"])
		} else {
			f.replayFrame(entry.Frame, ids)
		}
	}
	if meta.Exit == 0 {
		<-inbox.ended
	}
	os.Exit(int(meta.Exit))
}

func idMember(frame json.RawMessage) json.RawMessage {
	var members map[string]json.RawMessage
	if json.Unmarshal(frame, &members) != nil {
		return nil
	}
	return members["id"]
}

// replayFrame writes a recorded frame with the host's id in place of the recorded one.
func (f *fakeOmp) replayFrame(frame json.RawMessage, ids map[string]string) {
	recorded := rawString(idMember(frame))
	if host, ok := ids[recorded]; ok && host != "" && recorded != "" {
		frame = replaceID(frame, host)
	}
	f.writeFrame(frame)
	var members map[string]json.RawMessage
	if json.Unmarshal(frame, &members) == nil &&
		rawString(members["type"]) == "response" && rawString(members["command"]) == "negotiate_protocol" {
		f.mu.Lock()
		f.protocol = 2
		f.mu.Unlock()
	}
}

// --- the harness the client tests use ---------------------------------------------------------------------------

// The same event filter the O0 probes used (DESIGN §3.1 step 3).
func eventFilter() EventFilter {
	return EventFilter{
		Events: []string{
			"message_update", "message_end", "tool_execution_start", "tool_execution_end",
			"auto_retry_start", "auto_retry_end", "retry_fallback_applied",
			"auto_compaction_start", "auto_compaction_end", "notice",
		},
		MessageUpdates: ptr("delta"),
	}
}

func submitReportTool() HostToolSpec {
	return HostToolSpec{
		Name:        "submit_report",
		Label:       ptr("Submit report"),
		Description: "Submit your final structured report. Call it exactly once, as your last action.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"status":  map[string]any{"type": "string", "enum": []any{"done", "blocked"}},
				"summary": map[string]any{"type": "string"},
			},
			"required": []any{"status", "summary"},
		},
		LoadMode: ptr("essential"),
	}
}

func handshakeOptions() HandshakeOptions {
	return HandshakeOptions{
		HostTools:   []HostToolSpec{submitReportTool()},
		EventFilter: eventFilter(),
		TimeoutMs:   30_000,
	}
}

var readonlyArgs = []string{"--mode", "rpc", "--no-ui", "--tools", "read,grep,glob", "--approval-mode", "yolo"}

func fixturesDir() string {
	// Absolute, so the fake child resolves it from its own working directory too.
	dir, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "testdata", "engines", "omp-rpc"))
	if err != nil {
		return filepath.Join("..", "..", "..", "..", "testdata", "engines", "omp-rpc")
	}
	return dir
}

// fakeOptions are the client options a test layers on top of the fake start.
type fakeOptions struct {
	Log            *shared.RpcLogPaths
	OnHostToolCall HostToolHandler
	OnStderr       process.StderrListener
}

// startFake starts the fake omp under the client, killed when the test ends.
func startFake(t *testing.T, fakeEnv map[string]string, options fakeOptions) *OmpRpcClient {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("test binary path: %v", err)
	}
	env := append(os.Environ(), childModeEnv+"=omp")
	for name, value := range fakeEnv {
		env = append(env, name+"="+value)
	}
	started, startErr := StartOmpRpc(context.Background(), OmpRpcOptions{
		Command:        exe,
		Args:           readonlyArgs,
		Cwd:            t.TempDir(),
		Env:            env,
		Log:            options.Log,
		OnHostToolCall: options.OnHostToolCall,
		OnStderr:       options.OnStderr,
	})
	if startErr != nil {
		t.Fatalf("startOmpRpc: %s", startErr.Message)
	}
	t.Cleanup(func() {
		started.Kill(syscall.SIGKILL)
		_ = started.Exit()
	})
	return started
}

// startFixture replays a recorded fixture through the fake.
func startFixture(t *testing.T, name string, options fakeOptions) *OmpRpcClient {
	t.Helper()
	return startFake(t, map[string]string{
		"FAKE_OMP_FIXTURE": filepath.Join(fixturesDir(), name),
	}, options)
}

// frameLog collects every frame the client passes through, in order.
type frameLog struct {
	mu     sync.Mutex
	frames []Frame
	done   chan struct{}
}

func collect(client *OmpRpcClient) *frameLog {
	log := &frameLog{done: make(chan struct{})}
	go func() {
		defer close(log.done)
		for frame := range client.Frames() {
			log.mu.Lock()
			log.frames = append(log.frames, frame)
			log.mu.Unlock()
		}
	}()
	return log
}

func (l *frameLog) snapshot() []Frame {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]Frame(nil), l.frames...)
}

// waitForFrame resolves with the first frame matching predicate, failing the test after ms.
func (l *frameLog) waitForFrame(t *testing.T, ms int64, predicate func(Frame) bool) Frame {
	t.Helper()
	deadline := time.Now().Add(time.Duration(ms) * time.Millisecond)
	for {
		for _, frame := range l.snapshot() {
			if predicate(frame) {
				return frame
			}
		}
		if !time.Now().Before(deadline) {
			t.Fatal("frame did not arrive")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// lines reads a file as its non-empty lines.
func lines(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var out []string
	for _, line := range strings.Split(string(data), "\n") {
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

// ownGroupAttr starts a child as its own process-group leader, as omp's bash tool does.
func ownGroupAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// killGroup kills every process in pid's own group.
func killGroup(pid int) {
	_ = syscall.Kill(-pid, syscall.SIGKILL)
}
