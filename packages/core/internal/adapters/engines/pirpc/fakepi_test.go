package pirpc

// The fake pi: an executable stand-in for `pi --mode rpc` (pi 1.0.4 wire shapes). The test binary
// re-executes itself as the fake (ENGINE_TEST_CHILD selects the role), speaking the same frames:
// no ready frame, get_state, prompt (admission only — the turn ends at a bare agent_settled),
// abort, get_last_assistant_text, and the stdin close that saves the session and exits 0. No
// other runtime is ever started, and every child exits on its own or is killed by the test that
// started it.
//
// Environment:
//   - FAKE_PI_SCENARIO      what a prompt does: ok (default), error (an assistant message that ends
//     stopReason error), sleep (a bash tool that never finishes; abort cancels it), ignore-abort
//     (like sleep, but abort is acknowledged and ignored, and so is SIGTERM), crash (exits 1
//     mid-turn with a stderr line), big-frame (a final assistant message with 2 MiB of text);
//     any other name is refused at the prompt
//   - FAKE_PI_FIXTURE       a recorded fixture directory replayed in lockstep instead (replayFixture)
//   - FAKE_PI_SLOW_STATE_MS delays the get_state answer (the handshake timeout)
//   - FAKE_PI_NO_SESSION_ID "1": get_state answers without a sessionId (the protocol refusal)
//   - FAKE_PI_LAST_TEXTLESS "1": get_last_assistant_text answers without a text field
//   - FAKE_PI_NO_AGENT      "1": the prompt is admitted and settled with no assistant message at all
//   - FAKE_PI_GARBAGE       "1": prints a line that is not JSON before the first command
//   - FAKE_PI_WARN_SESSION  "0": silences the benign session-create warning (default: printed)
//   - FAKE_PI_FINAL_TEXT    what the ok scenario's last assistant message says (default "done")
//   - FAKE_PI_TEXTLESS      "1": the ok scenario's final assistant message ends with no text parts;
//     only get_last_assistant_text still knows the answer
//   - FAKE_PI_ARGV_LOG      a file the command line is written to as a one-line JSON array
//   - FAKE_PI_ENV_LOG       a file the whole environment (FAKE_* names left out) is written to as
//     one JSON object

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/shared"
)

// engineChildEnv names the role this binary plays when a test re-executes it as a child.
const engineChildEnv = "ENGINE_TEST_CHILD"

// childDeadline bounds every child the tests start, so one that escapes its test's cleanup cannot
// linger past the suite.
const childDeadline = 90 * time.Second

func TestMain(m *testing.M) {
	switch os.Getenv(engineChildEnv) {
	case "":
		os.Exit(m.Run())
	case "fake-pi":
		runFakePi()
	case "early-death":
		// A pi that dies before answering anything: one frame out, then one line on stderr.
		wire(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"never mind"}}` + "\n")
		os.Stderr.WriteString("early death\n")
		os.Exit(3)
	}
	os.Exit(0)
}

func runFakePi() {
	go func() {
		time.Sleep(childDeadline)
		os.Exit(99)
	}()
	flags, err := parseFakeFlags(os.Args[1:])
	if err != nil {
		os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(2)
	}
	if flags["--mode"] != "rpc" {
		os.Stderr.WriteString("fake pi: only --mode rpc is supported\n")
		os.Exit(2)
	}
	p := newFakePi(flags)
	if dir := os.Getenv("FAKE_PI_FIXTURE"); dir != "" {
		p.replayFixture(dir)
		return
	}
	p.serve()
}

var fakeValueFlags = map[string]bool{
	"--mode": true, "--model": true, "--thinking": true, "--tools": true, "--session-id": true,
}

var fakeBooleanFlags = map[string]bool{
	"--no-extensions": true, "--no-mcp": true, "--no-skills": true, "--no-context-files": true,
}

func parseFakeFlags(argv []string) (map[string]string, error) {
	flags := make(map[string]string)
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		if fakeValueFlags[arg] {
			value := ""
			if i+1 < len(argv) {
				i++
				value = argv[i]
			}
			flags[arg] = value
		} else if fakeBooleanFlags[arg] {
			flags[arg] = ""
		} else {
			return nil, fmt.Errorf("Error: Unknown option: %s", arg)
		}
	}
	return flags, nil
}

// fakePi is the fake engine's whole state. The stdin loop, the turn scenarios and the slow-state
// timer each run on their own goroutine, so mu guards every field and keeps each frame's write
// atomic.
type fakePi struct {
	mu sync.Mutex

	flags         map[string]string
	sessionID     string
	modelProvider string
	modelID       string
	tools         []string

	sessionMessages      []any
	messageIds           int
	bootstrapped         bool
	lastText             string
	lastAssistantMessage any
	turnToolResults      []any
	turn                 *fakeTurn
	inputEnded           bool
	uiReply              chan map[string]any
}

// fakeTurn is one admitted prompt: the command that opened it and the channel its abort lands on.
type fakeTurn struct {
	prompt  map[string]any
	abortCh chan map[string]any
}

func newFakePi(flags map[string]string) *fakePi {
	model := "zai/glm-5.3"
	if value, ok := flags["--model"]; ok && value != "" {
		model = value
	}
	parts := strings.Split(model, "/")
	provider := parts[0]
	if provider == "" {
		provider = "zai"
	}
	modelID := "glm-5.3"
	if len(parts) > 1 && parts[1] != "" {
		modelID = parts[1]
	}
	var tools []string
	for _, tool := range strings.Split(flags["--tools"], ",") {
		if tool != "" {
			tools = append(tools, tool)
		}
	}
	sessionID := "00000000-0000-7000-8000-0000000000ff"
	if value, ok := flags["--session-id"]; ok && value != "" {
		sessionID = value
	}
	return &fakePi{
		flags:         flags,
		sessionID:     sessionID,
		modelProvider: provider,
		modelID:       modelID,
		tools:         tools,
	}
}

// fakeJSON renders a value the way JSON.stringify did: no HTML escaping, members in struct order.
func fakeJSON(value any) string {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return ""
	}
	return strings.TrimSuffix(out.String(), "\n")
}

func wire(line string) {
	os.Stdout.WriteString(line)
}

func (p *fakePi) writeFrame(frame any) {
	wire(fakeJSON(frame) + "\n")
}

// emit writes one frame under the lock, so no other writer can split it.
func (p *fakePi) emit(frame any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.writeFrame(frame)
}

func (p *fakePi) serve() {
	if path := os.Getenv("FAKE_PI_ARGV_LOG"); path != "" {
		_ = os.WriteFile(path, []byte(fakeJSON(os.Args[1:])+"\n"), 0o644)
	}
	if path := os.Getenv("FAKE_PI_ENV_LOG"); path != "" {
		env := map[string]string{}
		for _, entry := range os.Environ() {
			if name, value, found := strings.Cut(entry, "="); found && !strings.HasPrefix(name, "FAKE_") {
				env[name] = value
			}
		}
		_ = os.WriteFile(path, []byte(fakeJSON(env)+"\n"), 0o644)
	}
	if os.Getenv("FAKE_PI_GARBAGE") == "1" {
		wire("this is not json\n")
	}
	if os.Getenv("FAKE_PI_WARN_SESSION") != "0" {
		os.Stderr.WriteString("Warning: No project session found with id '" + p.sessionID +
			"'; creating a new session with that id.\n")
	}
	if os.Getenv("FAKE_PI_SCENARIO") == "ignore-abort" {
		// SIGTERM must leave this pi alive; only SIGKILL ends it.
		signal.Notify(make(chan os.Signal, 1), syscall.SIGTERM)
	}
	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := reader.ReadString('\n')
		if text := strings.TrimSuffix(line, "\n"); text != "" {
			p.handle(text)
		}
		if err != nil {
			break
		}
	}
	p.mu.Lock()
	p.inputEnded = true
	open := p.turn != nil
	p.mu.Unlock()
	if !open {
		// A stop can race stdin's end; the small delay holds the exit back until
		// the last write drains, so the stop that raced it stays the winner.
		time.Sleep(20 * time.Millisecond)
		os.Exit(0)
	}
	// A settle still owed keeps the process up; the exit comes once it is sent.
	for {
		time.Sleep(time.Hour)
	}
}

func (p *fakePi) handle(line string) {
	command := shared.ParseJsonLine(line)
	if command == nil {
		// pi answers a line it could not parse with a response that has no id to correlate.
		p.emit(fakeResponse{Type: "response", Command: "parse", Success: false})
		return
	}
	name, _ := command["type"].(string)
	switch name {
	case "get_state":
		p.handleGetState(command)
	case "prompt":
		p.handlePrompt(command)
	case "abort":
		p.handleAbort(command)
	case "get_last_assistant_text":
		p.handleLastText(command)
	case "extension_ui_response":
		p.mu.Lock()
		reply := p.uiReply
		p.uiReply = nil
		p.mu.Unlock()
		if reply != nil {
			reply <- command
		}
	default:
		p.emit(fakeResponse{
			Id: fakeCommandID(command), Type: "response", Command: name,
			Success: false, Error: "Unknown command: " + name,
		})
	}
}

func fakeCommandID(command map[string]any) string {
	id, _ := command["id"].(string)
	return id
}

// respond is pi's answer to a command: success plus whatever the command reports under data.
func (p *fakePi) respond(command map[string]any, data any) {
	name, _ := command["type"].(string)
	p.emit(fakeResponse{
		Id: fakeCommandID(command), Type: "response", Command: name, Success: true, Data: data,
	})
}

func (p *fakePi) handleGetState(command map[string]any) {
	slow := int64(0)
	if value, err := strconv.ParseInt(strings.TrimSpace(os.Getenv("FAKE_PI_SLOW_STATE_MS")), 10, 64); err == nil {
		slow = value
	}
	if slow > 0 {
		id := fakeCommandID(command)
		time.AfterFunc(time.Duration(slow)*time.Millisecond, func() {
			p.emit(fakeResponse{
				Id: id, Type: "response", Command: "get_state", Success: true, Data: p.state(),
			})
		})
		return
	}
	p.respond(command, p.state())
}

func (p *fakePi) state() fakeState {
	root := os.Getenv("PI_CODING_AGENT_DIR")
	if root == "" {
		if cwd, err := os.Getwd(); err == nil {
			root = cwd
		}
	}
	thinking := "medium"
	if value, ok := p.flags["--thinking"]; ok && value != "" {
		thinking = value
	}
	p.mu.Lock()
	count := len(p.sessionMessages)
	p.mu.Unlock()
	state := fakeState{
		Model: fakeModelState{
			ID:       p.modelID,
			Name:     "Fake " + p.modelID,
			API:      "anthropic-messages",
			Provider: p.modelProvider,
			BaseURL:  "https://api.z.ai/api/anthropic",
		},
		ThinkingLevel: thinking,
		SessionFile:   filepath.Join(root, "sessions", p.sessionID+".jsonl"),
		MessageCount:  count,
		SessionID:     p.sessionID,
	}
	if os.Getenv("FAKE_PI_NO_SESSION_ID") == "1" {
		state.SessionID = ""
	}
	return state
}

var fakeScenarios = map[string]func(*fakePi, *fakeTurn){
	"ok":           (*fakePi).okScenario,
	"error":        (*fakePi).errorScenario,
	"sleep":        (*fakePi).longToolScenario,
	"ignore-abort": (*fakePi).longToolScenario,
	"big-frame":    (*fakePi).bigFrameScenario,
	"crash":        (*fakePi).crashScenario,
	"ui":           (*fakePi).uiScenario,
}

func strEnv(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func (p *fakePi) handlePrompt(command map[string]any) {
	scenario := fakeScenarios[strEnv("FAKE_PI_SCENARIO", "ok")]
	var started *fakeTurn
	p.mu.Lock()
	if scenario != nil && p.turn == nil {
		started = &fakeTurn{prompt: command, abortCh: make(chan map[string]any, 1)}
		p.turn = started
	}
	p.mu.Unlock()
	if started == nil {
		p.emit(fakeResponse{
			Id: fakeCommandID(command), Type: "response", Command: "prompt",
			Success: false, Error: "cannot prompt now",
		})
		return
	}
	p.respond(command, map[string]string{"disposition": "started"})
	if os.Getenv("FAKE_PI_NO_AGENT") == "1" {
		p.beginTurn(started)
		p.settle()
		return
	}
	go scenario(p, started)
}

func (p *fakePi) handleAbort(command map[string]any) {
	p.mu.Lock()
	current := p.turn
	p.mu.Unlock()
	if current == nil || os.Getenv("FAKE_PI_SCENARIO") == "ignore-abort" {
		p.respond(command, nil)
		return
	}
	current.abortCh <- command
}

func (p *fakePi) handleLastText(command map[string]any) {
	if os.Getenv("FAKE_PI_LAST_TEXTLESS") == "1" {
		p.respond(command, map[string]string{})
		return
	}
	p.mu.Lock()
	text := p.lastText
	p.mu.Unlock()
	p.respond(command, map[string]string{"text": text})
}

// beginTurn emits the transcript bracket every turn shares: agent_start, the session's system
// message (first turn only), turn_start, the user message.
func (p *fakePi) beginTurn(current *fakeTurn) {
	p.emit(typeOnlyFrame{Type: "agent_start"})
	p.mu.Lock()
	bootstrapped := p.bootstrapped
	p.bootstrapped = true
	p.mu.Unlock()
	if !bootstrapped {
		p.messageStart("system")
		p.message(fakeSystemMessage{
			Role:       "system",
			Content:    "",
			Sections:   fakeSections{Preamble: "fake pi", Tools: strings.Join(p.tools, ","), Rules: "", Docs: "", Cwd: fakeCwd()},
			ToolsAdded: p.tools,
			Timestamp:  fakeNow(),
		})
	}
	p.nextTurn()
	p.messageStart("user")
	message, _ := current.prompt["message"].(string)
	p.message(fakeUserMessage{
		Role: "user", Content: []any{fakeTextPart{Type: "text", Text: message}}, Timestamp: fakeNow(),
	})
}

func (p *fakePi) nextTurn() {
	p.emit(typeOnlyFrame{Type: "turn_start"})
	p.mu.Lock()
	p.turnToolResults = []any{}
	p.mu.Unlock()
}

// message seals a message: emitted and kept for agent_end.
func (p *fakePi) message(value any) any {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.messageIds++
	p.sessionMessages = append(p.sessionMessages, value)
	p.writeFrame(fakeMessageEnd{
		Type: "message_end", Message: value, MessageId: fmt.Sprintf("msg-%d", p.messageIds),
	})
	return value
}

func (p *fakePi) messageStart(role string) {
	p.emit(fakeMessageStart{Type: "message_start", Message: fakeRoleOnly{Role: role}})
}

func (p *fakePi) assistant(content []any, stopReason string, errorMessage *string) {
	if content == nil {
		content = []any{}
	}
	p.messageStart("assistant")
	sealed := p.message(fakeAssistantMessage{
		Role: "assistant", Content: content, API: "anthropic-messages",
		Provider: p.modelProvider, Model: p.modelID, Usage: fakeUsageValue(),
		StopReason: stopReason, ErrorMessage: errorMessage, Timestamp: fakeNow(),
	})
	p.mu.Lock()
	p.lastAssistantMessage = sealed
	text := ""
	for _, part := range content {
		if textPart, ok := part.(fakeTextPart); ok {
			text += textPart.Text
		}
	}
	if text != "" {
		p.lastText = text
	}
	p.mu.Unlock()
}

// toolEnd writes a tool result in pi's two places: its execution end and a toolResult transcript
// message.
func (p *fakePi) toolEnd(id, name string, content []any, isError bool) {
	p.emit(fakeToolExecutionEnd{
		Type: "tool_execution_end", ToolCallId: id, ToolName: name,
		Result: fakeToolResult{Content: content, Details: map[string]string{}}, IsError: isError,
	})
	p.messageStart("toolResult")
	sealed := p.message(fakeToolResultMessage{
		Role: "toolResult", ToolCallId: id, ToolName: name, Content: content,
		Details: map[string]string{}, IsError: isError, Timestamp: fakeNow(),
	})
	p.mu.Lock()
	p.turnToolResults = append(p.turnToolResults, sealed)
	p.mu.Unlock()
}

// textDeltas streams an assistant text as pi's message_update events: start, one delta per word,
// end.
func (p *fakePi) textDeltas(text string) {
	streaming := fakeUsageValue()
	update := func(event fakeAssistantEvent) {
		p.emit(fakeMessageUpdate{
			Type: "message_update", Usage: streaming, AssistantMessageEvent: event,
		})
	}
	update(fakeAssistantEvent{ContentIndex: 0, Type: "text_start"})
	for _, word := range strings.SplitAfter(text, " ") {
		update(fakeAssistantEvent{ContentIndex: 0, Type: "text_delta", Delta: word})
	}
	update(fakeAssistantEvent{ContentIndex: 0, Type: "text_end", Content: text})
}

func (p *fakePi) turnEnd() {
	p.mu.Lock()
	frame := fakeTurnEnd{
		Type: "turn_end", Message: p.lastAssistantMessage,
		ToolResults: append([]any(nil), p.turnToolResults...),
	}
	p.mu.Unlock()
	p.emit(frame)
}

func (p *fakePi) settle() {
	p.mu.Lock()
	defer p.mu.Unlock()
	messages := append([]any(nil), p.sessionMessages...)
	p.writeFrame(fakeAgentEnd{Type: "agent_end", Messages: messages, WillRetry: false})
	p.writeFrame(typeOnlyFrame{Type: "agent_settled"})
	p.turn = nil
	if p.inputEnded {
		os.Exit(0)
	}
}

// cancelTool is pi's abort order (recorded from 1.0.4): the cancelled tool, the aborted assistant
// message in a turn of its own, agent_end, the bare agent_settled — and the abort response last of
// all.
func (p *fakePi) cancelTool(id, name string, abort map[string]any) {
	p.emit(fakeToolExecutionUpdate{
		Type: "tool_execution_update", ToolCallId: id, ToolName: name,
		PartialResult: fakePartialResult{
			Content: []any{fakeTextPart{Type: "text", Text: "partial output before the abort"}},
		},
	})
	p.toolEnd(id, name, []any{fakeTextPart{Type: "text", Text: "Command aborted"}}, true)
	p.turnEnd()
	p.nextTurn()
	aborted := "The operation was aborted."
	p.assistant(nil, "error", &aborted)
	p.turnEnd()
	p.settle()
	p.respond(abort, nil)
}

func (p *fakePi) okScenario(current *fakeTurn) {
	p.beginTurn(current)
	p.textDeltas("Working on it.")
	text := strEnv("FAKE_PI_FINAL_TEXT", "done")
	p.textDeltas(text)
	if os.Getenv("FAKE_PI_TEXTLESS") == "1" {
		// The message ends with no text parts; only get_last_assistant_text still knows the answer.
		p.mu.Lock()
		p.lastText = text
		p.mu.Unlock()
		p.assistant(nil, "stop", nil)
	} else {
		p.assistant([]any{fakeTextPart{Type: "text", Text: text}}, "stop", nil)
	}
	p.turnEnd()
	p.settle()
}

// uiScenario asks every extension dialog kind in turn; a host that does not answer them
// unattended leaves the turn hanging, and a wrong answer kills the fake.
func (p *fakePi) uiScenario(current *fakeTurn) {
	for _, method := range []string{"confirm", "select", "input", "editor"} {
		reply := make(chan map[string]any, 1)
		p.mu.Lock()
		p.uiReply = reply
		p.mu.Unlock()
		p.emit(fakeUIRequest{
			Type: "extension_ui_request", Id: "ui-" + method, Method: method, Title: "Test dialog",
		})
		answer := <-reply
		approved, _ := answer["confirmed"].(bool)
		cancelled, _ := answer["cancelled"].(bool)
		if method == "confirm" && !approved || method != "confirm" && !cancelled {
			os.Stderr.WriteString("wrong unattended UI response")
			os.Exit(1)
		}
	}
	p.okScenario(current)
}

func (p *fakePi) errorScenario(current *fakeTurn) {
	p.beginTurn(current)
	expired := `401 {"error":{"message":"token expired or incorrect"}}`
	p.assistant(nil, "error", &expired)
	p.turnEnd()
	p.settle()
}

func (p *fakePi) longToolScenario(current *fakeTurn) {
	p.beginTurn(current)
	p.assistant([]any{fakeToolCallPart{
		Type: "toolCall", Id: "call_bash_1", Name: "bash",
		Arguments: map[string]string{"command": "sleep 600"},
	}}, "toolUse", nil)
	p.emit(fakeToolExecutionStart{
		Type: "tool_execution_start", ToolCallId: "call_bash_1", ToolName: "bash",
		Args: map[string]string{"command": "sleep 600"},
	})
	abort := <-current.abortCh
	p.cancelTool("call_bash_1", "bash", abort)
}

func (p *fakePi) bigFrameScenario(current *fakeTurn) {
	p.beginTurn(current)
	p.assistant([]any{fakeTextPart{Type: "text", Text: strings.Repeat("y", 2*1024*1024)}}, "stop", nil)
	p.turnEnd()
	p.settle()
}

func (p *fakePi) crashScenario(current *fakeTurn) {
	p.beginTurn(current)
	p.assistant([]any{fakeToolCallPart{
		Type: "toolCall", Id: "call_bash_1", Name: "bash",
		Arguments: map[string]string{"command": "true"},
	}}, "toolUse", nil)
	os.Stderr.WriteString("fake pi: simulated crash\n")
	os.Exit(1)
}

// replayFixture replays a fixture directory in lockstep with the commands the client sends: out
// lines go out in order, in lines wait for that command to arrive (ids remapped to what the client
// sent), and raw line entries emit a string verbatim.
func (p *fakePi) replayFixture(dir string) {
	if stderrText, err := os.ReadFile(filepath.Join(dir, "stderr.txt")); err == nil {
		os.Stderr.WriteString(string(stderrText))
	}
	var meta struct {
		Exit int `json:"exit"`
	}
	if raw, err := os.ReadFile(filepath.Join(dir, "meta.json")); err == nil {
		_ = json.Unmarshal(raw, &meta)
	}
	var entries []struct {
		Dir   string          `json:"dir"`
		Frame json.RawMessage `json:"frame"`
		Line  *string         `json:"line"`
	}
	if raw, err := os.ReadFile(filepath.Join(dir, "interleaved.jsonl")); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if line == "" {
				continue
			}
			var entry struct {
				Dir   string          `json:"dir"`
				Frame json.RawMessage `json:"frame"`
				Line  *string         `json:"line"`
			}
			if json.Unmarshal([]byte(line), &entry) == nil {
				entries = append(entries, entry)
			}
		}
	}
	inbox := newFakeInbox()
	go inbox.read(os.Stdin)
	ids := map[string]string{}
	for _, entry := range entries {
		switch {
		case entry.Dir == "in":
			var recorded map[string]any
			_ = json.Unmarshal(entry.Frame, &recorded)
			recordedType, _ := recorded["type"].(string)
			sent := inbox.take(recordedType)
			if sent == nil {
				os.Exit(1)
			}
			recordedID, _ := recorded["id"].(string)
			sentID, _ := sent["id"].(string)
			ids[recordedID] = sentID
		case entry.Line != nil:
			wire(*entry.Line + "\n")
		default:
			wire(string(replayFrame(entry.Frame, ids)) + "\n")
		}
	}
	if meta.Exit == 0 {
		<-inbox.ended
	}
	os.Exit(meta.Exit)
}

// replayFrame rewrites a recorded frame's id with the one the client actually sent, keeping every
// member in its recorded order; the frame itself when its id was never mapped.
func replayFrame(raw json.RawMessage, ids map[string]string) json.RawMessage {
	var frame map[string]json.RawMessage
	if json.Unmarshal(raw, &frame) != nil {
		return raw
	}
	id, hasID := frameStringOk(frame, "id")
	if !hasID {
		return raw
	}
	mapped, wasRemapped := ids[id]
	if !wasRemapped {
		return raw
	}
	return swapIDMember(raw, "id", mapped)
}

// swapIDMember rewrites the id member of raw (a JSON object), keeping every member in its written
// order; raw itself on any malformed shape.
func swapIDMember(raw []byte, key, id string) json.RawMessage {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	opening, err := decoder.Token()
	if err != nil {
		return raw
	}
	if delim, ok := opening.(json.Delim); !ok || delim != '{' {
		return raw
	}
	var out bytes.Buffer
	out.WriteByte('{')
	replaced := false
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return raw
		}
		name, isKey := keyToken.(string)
		var value json.RawMessage
		if !isKey || decoder.Decode(&value) != nil {
			return raw
		}
		if out.Len() > 1 {
			out.WriteByte(',')
		}
		appendJSONString(&out, name)
		out.WriteByte(':')
		if name == key && !replaced {
			appendJSONString(&out, id)
			replaced = true
		} else {
			out.Write(value)
		}
	}
	if _, err := decoder.Token(); err != nil {
		return raw
	}
	out.WriteByte('}')
	return out.Bytes()
}

// fakeInbox buffers commands until the replay waits for one; stdin's end releases any waiter left.
type fakeInbox struct {
	mu       sync.Mutex
	cond     *sync.Cond
	received []map[string]any
	done     bool
	ended    chan struct{}
}

func newFakeInbox() *fakeInbox {
	inbox := &fakeInbox{ended: make(chan struct{})}
	inbox.cond = sync.NewCond(&inbox.mu)
	return inbox
}

func (inbox *fakeInbox) read(input io.Reader) {
	defer close(inbox.ended)
	reader := bufio.NewReader(input)
	for {
		line, err := reader.ReadString('\n')
		if text := strings.TrimSuffix(line, "\n"); text != "" {
			if command := shared.ParseJsonLine(text); command != nil {
				inbox.mu.Lock()
				inbox.received = append(inbox.received, command)
				inbox.cond.Broadcast()
				inbox.mu.Unlock()
			}
		}
		if err != nil {
			break
		}
	}
	inbox.mu.Lock()
	inbox.done = true
	inbox.cond.Broadcast()
	inbox.mu.Unlock()
}

// take hands over the first buffered command of commandType, waiting for one to arrive; nil once
// stdin has ended without one.
func (inbox *fakeInbox) take(commandType string) map[string]any {
	inbox.mu.Lock()
	defer inbox.mu.Unlock()
	for {
		for i, command := range inbox.received {
			if name, _ := command["type"].(string); name == commandType {
				inbox.received = append(inbox.received[:i], inbox.received[i+1:]...)
				return command
			}
		}
		if inbox.done {
			return nil
		}
		inbox.cond.Wait()
	}
}

func fakeNow() int64 {
	return time.Now().UnixMilli()
}

func fakeCwd() string {
	cwd, err := os.Getwd()
	if err != nil {
		return ""
	}
	return cwd
}

// The frames the fake speaks, in the member order the wire pins.

type typeOnlyFrame struct {
	Type string `json:"type"`
}

type fakeRoleOnly struct {
	Role string `json:"role"`
}

type fakeResponse struct {
	Id      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Command string `json:"command"`
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
	Data    any    `json:"data,omitempty"`
}

type fakeUIRequest struct {
	Type   string `json:"type"`
	Id     string `json:"id"`
	Method string `json:"method"`
	Title  string `json:"title"`
}

type fakeModelState struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	API      string `json:"api"`
	Provider string `json:"provider"`
	BaseURL  string `json:"baseUrl"`
}

type fakeState struct {
	Model         fakeModelState `json:"model"`
	ThinkingLevel string         `json:"thinkingLevel"`
	SessionFile   string         `json:"sessionFile"`
	MessageCount  int            `json:"messageCount"`
	SessionID     string         `json:"sessionId,omitempty"`
}

type fakeMessageStart struct {
	Type    string       `json:"type"`
	Message fakeRoleOnly `json:"message"`
}

type fakeSections struct {
	Preamble string `json:"preamble"`
	Tools    string `json:"tools"`
	Rules    string `json:"rules"`
	Docs     string `json:"docs"`
	Cwd      string `json:"cwd"`
}

type fakeSystemMessage struct {
	Role       string       `json:"role"`
	Content    string       `json:"content"`
	Sections   fakeSections `json:"sections"`
	ToolsAdded []string     `json:"toolsAdded"`
	Timestamp  int64        `json:"timestamp"`
}

type fakeTextPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type fakeToolCallPart struct {
	Type      string            `json:"type"`
	Id        string            `json:"id"`
	Name      string            `json:"name"`
	Arguments map[string]string `json:"arguments"`
}

type fakeUserMessage struct {
	Role      string `json:"role"`
	Content   []any  `json:"content"`
	Timestamp int64  `json:"timestamp"`
}

type fakeCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Total      float64 `json:"total"`
}

type fakeUsage struct {
	Input       int      `json:"input"`
	Output      int      `json:"output"`
	CacheRead   int      `json:"cacheRead"`
	CacheWrite  int      `json:"cacheWrite"`
	TotalTokens int      `json:"totalTokens"`
	Cost        fakeCost `json:"cost"`
}

func fakeUsageValue() fakeUsage {
	return fakeUsage{
		Input: 100, Output: 20, CacheRead: 50, CacheWrite: 0, TotalTokens: 170,
		Cost: fakeCost{Input: 0.0001, Output: 0, CacheRead: 0, CacheWrite: 0, Total: 0.0001},
	}
}

type fakeAssistantMessage struct {
	Role         string    `json:"role"`
	Content      []any     `json:"content"`
	API          string    `json:"api"`
	Provider     string    `json:"provider"`
	Model        string    `json:"model"`
	Usage        fakeUsage `json:"usage"`
	StopReason   string    `json:"stopReason"`
	ErrorMessage *string   `json:"errorMessage,omitempty"`
	Timestamp    int64     `json:"timestamp"`
}

type fakeToolResultMessage struct {
	Role       string            `json:"role"`
	ToolCallId string            `json:"toolCallId"`
	ToolName   string            `json:"toolName"`
	Content    []any             `json:"content"`
	Details    map[string]string `json:"details"`
	IsError    bool              `json:"isError"`
	Timestamp  int64             `json:"timestamp"`
}

type fakeMessageEnd struct {
	Type      string `json:"type"`
	Message   any    `json:"message"`
	MessageId string `json:"messageId"`
}

type fakeToolResult struct {
	Content []any             `json:"content"`
	Details map[string]string `json:"details"`
}

type fakeToolExecutionStart struct {
	Type       string            `json:"type"`
	ToolCallId string            `json:"toolCallId"`
	ToolName   string            `json:"toolName"`
	Args       map[string]string `json:"args"`
}

type fakeToolExecutionUpdate struct {
	Type          string            `json:"type"`
	ToolCallId    string            `json:"toolCallId"`
	ToolName      string            `json:"toolName"`
	PartialResult fakePartialResult `json:"partialResult"`
}

type fakePartialResult struct {
	Content []any `json:"content"`
}

type fakeToolExecutionEnd struct {
	Type       string         `json:"type"`
	ToolCallId string         `json:"toolCallId"`
	ToolName   string         `json:"toolName"`
	Result     fakeToolResult `json:"result"`
	IsError    bool           `json:"isError"`
}

type fakeTurnEnd struct {
	Type        string `json:"type"`
	Message     any    `json:"message"`
	ToolResults []any  `json:"toolResults"`
}

type fakeAgentEnd struct {
	Type      string `json:"type"`
	Messages  []any  `json:"messages"`
	WillRetry bool   `json:"willRetry"`
}

type fakeAssistantEvent struct {
	ContentIndex int    `json:"contentIndex"`
	Type         string `json:"type"`
	Delta        string `json:"delta,omitempty"`
	Content      string `json:"content,omitempty"`
}

type fakeMessageUpdate struct {
	Type                  string             `json:"type"`
	Usage                 fakeUsage          `json:"usage"`
	AssistantMessageEvent fakeAssistantEvent `json:"assistantMessageEvent"`
}
