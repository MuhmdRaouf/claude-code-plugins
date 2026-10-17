package cli_test

// The fake engines (fake-omp, fake-pi, fake-opencode and fake-zcode) as children of this test
// binary: CLI_ENGINE_CHILD selects the role the
// re-executed binary plays, so no omp, pi, opencode, zcode or node is ever started. Each fake
// speaks the frames its worker speaks, cut to the scenarios the engine-wire tests run: a run that
// finishes with a notes report, and one that hangs until it is stopped.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
)

// engineChildEnv selects the role a re-executed child of this test binary plays.
const engineChildEnv = "CLI_ENGINE_CHILD"

// engineChildDeadline bounds every child the tests start, so one that escapes its test's cleanup
// cannot linger.
const engineChildDeadline = 75 * time.Second

func TestMain(m *testing.M) {
	// The orphan launcher SpawnOrphan re-runs this test binary as (see process.OrphanLaunch).
	if len(os.Args) > 1 && os.Args[1] == "--orphan-launch" {
		os.Exit(process.OrphanLaunch(os.Args[2:]))
	}
	switch os.Getenv(engineChildEnv) {
	case "":
		os.Exit(m.Run())
	case "driver":
		runFakeDriver()
	case "driver-argv":
		fmt.Println(strings.Join(os.Args[1:], " "))
	case "omp":
		runFakeOmp(os.Args[1:])
	case "pi":
		runFakePi(os.Args[1:])
	case "opencode":
		runFakeOpenCode(os.Args[1:])
	case "zcode":
		runFakeZcode(os.Args[1:])
	}
	os.Exit(0)
}

// childBackstop ends a child that outlived its test, never a test's own run.
func childBackstop() {
	time.AfterFunc(engineChildDeadline, func() { os.Exit(99) })
}

// runFakeDriver is wire's detached driver stand-in: it says it is up and ends.
func runFakeDriver() {
	fmt.Println("driver up")
}

// writeChildJSON writes value as one JSON line the way JSON.stringify did: no HTML escaping.
func writeChildJSON(path string, value any, newline bool) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return
	}
	text := out.Bytes()
	if !newline {
		text = bytes.TrimSuffix(text, []byte("\n"))
	}
	_ = os.WriteFile(path, text, 0o600)
}

// loggedChildEnv is the environment the tool sees, the fake's own FAKE_* knobs and the child-mode
// switch left out.
func loggedChildEnv() map[string]string {
	env := map[string]string{}
	for _, entry := range os.Environ() {
		name, value, found := strings.Cut(entry, "=")
		if !found || strings.HasPrefix(name, "FAKE_") || name == engineChildEnv || name == "GOCOVERDIR" {
			continue
		}
		env[name] = value
	}
	return env
}

// fakeInputLine is one command off the wire.
type fakeInputLine = map[string]json.RawMessage

// fakeMember reads a command member as a JSON string, "" when it is not one.
func fakeMember(command fakeInputLine, key string) string {
	var text string
	if json.Unmarshal(command[key], &text) != nil {
		return ""
	}
	return text
}

// fakeWire writes one JSON line to stdout, as JSON.stringify did: no HTML escaping.
func fakeWire(frame any) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(frame) != nil {
		return
	}
	_, _ = os.Stdout.Write(out.Bytes())
}

// fakeRespond is the RPC answer envelope: {id, type:"response", command, success, data?}.
func fakeRespond(command fakeInputLine, data any) {
	if data == nil {
		fakeWire(struct {
			ID      string `json:"id"`
			Type    string `json:"type"`
			Command string `json:"command"`
			Success bool   `json:"success"`
		}{fakeMember(command, "id"), "response", fakeMember(command, "type"), true})
		return
	}
	fakeWire(struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Command string `json:"command"`
		Success bool   `json:"success"`
		Data    any    `json:"data"`
	}{fakeMember(command, "id"), "response", fakeMember(command, "type"), true, data})
}

// fakePeer is the half of an RPC fake the scenarios share: the wire out, the line dispatcher, and
// the exit once stdin closes and no turn is owed.
type fakePeer struct {
	mu         sync.Mutex
	inputEnded bool
	// A turn still owed keeps the process up; the scenario's goroutine exits it.
	turnOwed bool
}

// serveFakePeer reads stdin into the dispatcher until it closes.
func serveFakePeer(dispatch func(fakeInputLine)) *fakePeer {
	peer := &fakePeer{}
	lines := make(chan string)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()
	go func() {
		for line := range lines {
			var command fakeInputLine
			if json.Unmarshal([]byte(line), &command) != nil {
				continue
			}
			dispatch(command)
		}
		peer.stdinClosed()
	}()
	return peer
}

// stdinClosed records the host's stdin close, exiting when no turn is owed.
func (p *fakePeer) stdinClosed() {
	p.mu.Lock()
	p.inputEnded = true
	owed := p.turnOwed
	p.mu.Unlock()
	if !owed {
		os.Exit(0)
	}
}

// owe keeps the process up until the returned release runs it (and exits when stdin already
// ended).
func (p *fakePeer) owe() func() {
	p.mu.Lock()
	p.turnOwed = true
	p.mu.Unlock()
	return func() {
		p.mu.Lock()
		p.turnOwed = false
		ended := p.inputEnded
		p.mu.Unlock()
		if ended {
			os.Exit(0)
		}
	}
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

// childEnvText is an env variable's value, or fallback when it is empty.
func childEnvText(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// childEnvNumber reads a numeric variable the way Number() did, 0 for anything else.
func childEnvNumber(name string) float64 {
	value, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv(name)), 64)
	if err != nil {
		return 0
	}
	return value
}

// ── the fake omp ─────────────────────────────────────────────────────────────────────────────

// ompValueFlags and ompBooleanFlags are the flags the real omp's rpc mode takes; anything else is
// refused, so a leaked flag fails the run visibly.
var (
	ompValueFlags   = map[string]bool{"--mode": true, "--config": true, "--session-dir": true, "--model": true, "--thinking": true, "--tools": true, "--approval-mode": true, "--add-dir": true, "--resume": true}
	ompBooleanFlags = map[string]bool{"--no-ui": true, "--no-extensions": true, "--no-skills": true, "--no-rules": true, "--no-title": true}
)

// fakeOmp is one `omp --mode rpc --no-ui` process.
type fakeOmp struct {
	peer    *fakePeer
	flags   map[string]string
	cwd     string
	model   string
	ids     int
	prompt  fakeInputLine
	abort   chan fakeInputLine
	release func()
}

// runFakeOmp speaks the omp rpc protocol's happy path: ready, the handshake, one turn that ends
// with the final text, or a tool that hangs until the abort.
func runFakeOmp(args []string) {
	childBackstop()
	for _, arg := range args {
		if arg == "--version" {
			fmt.Println("omp/" + childEnvText("FAKE_OMP_VERSION", "18.6.1"))
			return
		}
	}
	f := &fakeOmp{flags: map[string]string{}, abort: make(chan fakeInputLine, 1)}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if ompBooleanFlags[arg] {
			f.flags[arg] = ""
		} else if ompValueFlags[arg] && i+1 < len(args) {
			f.flags[arg] = args[i+1]
			i++
		} else {
			fmt.Fprintf(os.Stderr, "Error: Unknown option: %s\n", arg)
			os.Exit(2)
		}
	}
	if f.flags["--mode"] != "rpc" {
		fmt.Fprintln(os.Stderr, "fake omp: only --mode rpc is supported")
		os.Exit(2)
	}
	if path := os.Getenv("FAKE_OMP_ARGV_LOG"); path != "" {
		writeChildJSON(path, args, true)
	}
	if path := os.Getenv("FAKE_OMP_ENV_LOG"); path != "" {
		writeChildJSON(path, loggedChildEnv(), true)
	}
	f.cwd, _ = os.Getwd()
	f.model = "zai/glm-5.3"
	if model, ok := f.flags["--model"]; ok {
		f.model = model
	}
	f.peer = serveFakePeer(f.dispatch)
	fakeWire(struct {
		Type            string `json:"type"`
		ProtocolVersion int    `json:"protocolVersion"`
		Supported       []int  `json:"supportedProtocolVersions"`
		MaxFrameBytes   int    `json:"maxFrameBytes"`
	}{"ready", 1, []int{1, 2}, 1024 * 1024})
	select {}
}

func (f *fakeOmp) dispatch(command fakeInputLine) {
	switch fakeMember(command, "type") {
	case "negotiate_protocol":
		fakeRespond(command, struct {
			ProtocolVersion int `json:"protocolVersion"`
		}{2})
	case "set_event_filter":
		fakeRespond(command, struct {
			Events []string `json:"events"`
		}{[]string{}})
	case "get_state":
		fakeRespond(command, f.state())
	case "prompt":
		fakeRespond(command, nil)
		f.prompt = command
		f.release = f.peer.owe()
		f.userMessage(command)
		go f.scenario()
	case "abort":
		select {
		case f.abort <- command:
		default:
			fakeRespond(command, nil)
		}
	}
}

// state is get_state's answer: the session the worker needs, with exactly the tools it allowed.
func (f *fakeOmp) state() any {
	tools := "read,bash,edit,eval,glob,grep,todo,web_search,write"
	if list, ok := f.flags["--tools"]; ok {
		tools = list
	}
	dumpTools := make([]map[string]string, 0, 8)
	for _, name := range strings.Split(tools, ",") {
		if name != "" {
			dumpTools = append(dumpTools, map[string]string{"name": name})
		}
	}
	sessionDir := f.cwd
	if dir, ok := f.flags["--session-dir"]; ok {
		sessionDir = dir
	}
	thinking := "low"
	if level, ok := f.flags["--thinking"]; ok {
		thinking = level
	}
	provider, model, _ := strings.Cut(f.model, "/")
	if provider == "" {
		provider = "zai"
	}
	return struct {
		Model         any    `json:"model"`
		ThinkingLevel string `json:"thinkingLevel"`
		SessionID     string `json:"sessionId"`
		SessionFile   string `json:"sessionFile"`
		MessageCount  int    `json:"messageCount"`
		DumpTools     any    `json:"dumpTools"`
		SystemPrompt  []any  `json:"systemPrompt"`
	}{
		Model:         map[string]string{"id": model, "provider": provider, "api": "anthropic-messages"},
		ThinkingLevel: thinking,
		SessionID:     "01a11109-0000-7000-8000-000000000001",
		SessionFile:   sessionDir + "/fake_01a11109-0000-7000-8000-000000000001.jsonl",
		DumpTools:     dumpTools,
		SystemPrompt:  []any{"fake omp system prompt"},
	}
}

// scenario is what a prompt does: the ok run, or a tool that hangs until the abort.
func (f *fakeOmp) scenario() {
	if os.Getenv("FAKE_OMP_SCENARIO") == "sleep" {
		f.hangOnTool()
		return
	}
	finalText := childEnvText("FAKE_OMP_FINAL_TEXT", "done")
	f.textDeltas("Working on it.")
	f.textDeltas(finalText)
	f.assistant([]any{map[string]any{"type": "text", "text": finalText}}, "stop", nil)
	f.finish("completed")
}

// hangOnTool runs a bash call that never finishes; the abort cancels it in omp's order.
func (f *fakeOmp) hangOnTool() {
	id := "call_bash_1"
	args := map[string]any{"command": "sleep 600", "timeout": 900}
	f.assistant([]any{map[string]any{"type": "toolCall", "id": id, "name": "bash", "arguments": args, "intent": "Sleeping"}}, "toolUse", nil)
	fakeWire(struct {
		Type       string         `json:"type"`
		ToolCallID string         `json:"toolCallId"`
		ToolName   string         `json:"toolName"`
		Args       map[string]any `json:"args"`
		Intent     string         `json:"intent"`
	}{"tool_execution_start", id, "bash", args, "Sleeping"})
	abort := <-f.abort
	cancelled := []any{map[string]any{"type": "text", "text": "[Command cancelled]\n"}}
	fakeWire(struct {
		Type       string `json:"type"`
		ToolCallID string `json:"toolCallId"`
		ToolName   string `json:"toolName"`
		Result     any    `json:"result"`
		IsError    bool   `json:"isError"`
	}{"tool_execution_end", id, "bash", map[string]any{"content": cancelled, "details": map[string]any{}}, true})
	f.message("toolResult", map[string]any{
		"toolCallId": id, "toolName": "bash", "content": cancelled,
		"details": map[string]any{}, "isError": true,
	})
	f.assistant([]any{}, "aborted", map[string]any{"errorMessage": "Interrupted by user"})
	fakeRespond(abort, nil)
	f.finish("aborted")
}

// finish is prompt_result and, the session having settled, session_settled.
func (f *fakeOmp) finish(status string) {
	fakeWire(struct {
		Type           string `json:"type"`
		ID             string `json:"id,omitempty"`
		AgentInvoked   bool   `json:"agentInvoked"`
		Status         string `json:"status"`
		SessionSettled bool   `json:"sessionSettled"`
	}{"prompt_result", fakeMember(f.prompt, "id"), true, status, true})
	fakeWire(struct {
		Type string `json:"type"`
	}{"session_settled"})
	if f.release != nil {
		f.release()
	}
}

// message seals one transcript message.
func (f *fakeOmp) message(role string, fields map[string]any) {
	f.ids++
	all := map[string]any{"role": role}
	for name, value := range fields {
		all[name] = value
	}
	all["timestamp"] = time.Now().UnixMilli()
	fakeWire(struct {
		Type      string         `json:"type"`
		Message   map[string]any `json:"message"`
		MessageID string         `json:"messageId"`
	}{"message_end", all, "msg-" + strconv.Itoa(f.ids)})
}

// userMessage is the prompt's transcript entry.
func (f *fakeOmp) userMessage(prompt fakeInputLine) {
	f.message("user", map[string]any{
		"content":     []any{map[string]any{"type": "text", "text": fakeMember(prompt, "message")}},
		"attribution": "user",
	})
}

// assistant is one assistant message with omp's own usage numbers.
func (f *fakeOmp) assistant(content []any, stopReason string, extra map[string]any) {
	fields := map[string]any{
		"content":    content,
		"api":        "anthropic-messages",
		"provider":   "zai",
		"model":      f.model,
		"usage":      ompUsage(),
		"stopReason": stopReason,
	}
	for name, value := range extra {
		fields[name] = value
	}
	f.message("assistant", fields)
}

// ompUsage is the per-message usage the fake stamps, as omp does.
func ompUsage() map[string]any {
	return map[string]any{
		"input": 100, "output": 20, "cacheRead": 50, "cacheWrite": 0, "totalTokens": 170,
		"cost": map[string]any{"total": 0.0001},
	}
}

// textDeltas streams text as message_update events, one delta per word.
func (f *fakeOmp) textDeltas(text string) {
	f.ids++
	messageID := "msg-" + strconv.Itoa(f.ids)
	update := func(event map[string]any) {
		event["contentIndex"] = 0
		fakeWire(struct {
			Type                  string         `json:"type"`
			AssistantMessageEvent map[string]any `json:"assistantMessageEvent"`
			Message               map[string]any `json:"message"`
			MessageID             string         `json:"messageId"`
		}{"message_update", event, map[string]any{"role": "assistant"}, messageID})
	}
	update(map[string]any{"type": "text_start"})
	for _, word := range splitAfterSpace(text) {
		update(map[string]any{"type": "text_delta", "delta": word})
	}
	update(map[string]any{"type": "text_end"})
}

// ── the fake pi ──────────────────────────────────────────────────────────────────────────────

// piValueFlags and piBooleanFlags are the flags the real pi's rpc mode takes.
var (
	piValueFlags   = map[string]bool{"--mode": true, "--model": true, "--thinking": true, "--tools": true, "--session-id": true}
	piBooleanFlags = map[string]bool{"--no-extensions": true, "--no-mcp": true, "--no-skills": true, "--no-context-files": true}
)

// fakePi is one `pi --mode rpc` process.
type fakePi struct {
	peer      *fakePeer
	flags     map[string]string
	sessionID string
	model     string
	ids       int
	messages  []any
	lastText  string
	lastMsg   map[string]any
	abort     chan fakeInputLine
	release   func()
}

// runFakePi speaks the pi rpc protocol: no ready frame, get_state, a prompt whose turn ends at a
// bare agent_settled, and the stdin close that saves the session and exits 0.
func runFakePi(args []string) {
	childBackstop()
	if len(args) > 0 && args[0] == "--version" {
		fmt.Println("pi/" + childEnvText("FAKE_PI_VERSION", "1.0.4"))
		return
	}
	f := &fakePi{flags: map[string]string{}, abort: make(chan fakeInputLine, 1)}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if piBooleanFlags[arg] {
			f.flags[arg] = ""
		} else if piValueFlags[arg] && i+1 < len(args) {
			f.flags[arg] = args[i+1]
			i++
		} else {
			fmt.Fprintf(os.Stderr, "Error: Unknown option: %s\n", arg)
			os.Exit(2)
		}
	}
	f.sessionID = "00000000-0000-7000-8000-0000000000ff"
	if id, ok := f.flags["--session-id"]; ok {
		f.sessionID = id
	}
	f.model = "zai/glm-5.3"
	if model, ok := f.flags["--model"]; ok {
		f.model = model
	}
	if path := os.Getenv("FAKE_PI_ARGV_LOG"); path != "" {
		writeChildJSON(path, args, true)
	}
	if path := os.Getenv("FAKE_PI_ENV_LOG"); path != "" {
		writeChildJSON(path, loggedChildEnv(), true)
	}
	if os.Getenv("FAKE_PI_WARN_SESSION") != "0" {
		fmt.Fprintf(os.Stderr, "Warning: No project session found with id '%s'; creating a new session with that id.\n", f.sessionID)
	}
	f.peer = serveFakePeer(f.dispatch)
	select {}
}

func (f *fakePi) dispatch(command fakeInputLine) {
	switch fakeMember(command, "type") {
	case "get_state":
		fakeRespond(command, f.state())
	case "prompt":
		fakeRespond(command, struct {
			Disposition string `json:"disposition"`
		}{"started"})
		f.release = f.peer.owe()
		go f.scenario(command)
	case "abort":
		select {
		case f.abort <- command:
		default:
			fakeRespond(command, nil)
		}
	case "get_last_assistant_text":
		fakeRespond(command, struct {
			Text string `json:"text"`
		}{f.lastText})
	default:
		fakeWire(struct {
			ID      string `json:"id"`
			Type    string `json:"type"`
			Command string `json:"command"`
			Success bool   `json:"success"`
			Error   string `json:"error"`
		}{fakeMember(command, "id"), "response", fakeMember(command, "type"), false,
			"Unknown command: " + fakeMember(command, "type")})
	}
}

// state is get_state's answer; the sessionId is what the client insists on.
func (f *fakePi) state() any {
	provider, id, _ := strings.Cut(f.model, "/")
	cwd, _ := os.Getwd()
	thinking := "medium"
	if level, ok := f.flags["--thinking"]; ok {
		thinking = level
	}
	return struct {
		Model         any    `json:"model"`
		ThinkingLevel string `json:"thinkingLevel"`
		SessionID     string `json:"sessionId"`
		SessionFile   string `json:"sessionFile"`
		MessageCount  int    `json:"messageCount"`
	}{
		Model: map[string]string{
			"id": id, "name": "Fake " + id, "api": "anthropic-messages",
			"provider": provider, "baseUrl": "https://api.z.ai/api/anthropic",
		},
		ThinkingLevel: thinking,
		SessionID:     f.sessionID,
		SessionFile:   cwd + "/sessions/" + f.sessionID + ".jsonl",
		MessageCount:  len(f.messages),
	}
}

// scenario is what a prompt does: the ok run, or a tool that hangs until the abort.
func (f *fakePi) scenario(prompt fakeInputLine) {
	if os.Getenv("FAKE_PI_SCENARIO") == "sleep" {
		f.hangOnTool()
		return
	}
	f.beginTurn(prompt)
	finalText := childEnvText("FAKE_PI_FINAL_TEXT", "done")
	f.textDeltas("Working on it.")
	f.textDeltas(finalText)
	f.assistant([]any{map[string]any{"type": "text", "text": finalText}}, "stop", nil)
	f.turnEnd()
	f.settle()
}

// hangOnTool runs a bash call that never finishes; the abort cancels it in pi's order, the abort
// response last of all.
func (f *fakePi) hangOnTool() {
	f.agentStart()
	id := "call_bash_1"
	args := map[string]any{"command": "sleep 600"}
	f.assistant([]any{map[string]any{"type": "toolCall", "id": id, "name": "bash", "arguments": args}}, "toolUse", nil)
	fakeWire(struct {
		Type       string         `json:"type"`
		ToolCallID string         `json:"toolCallId"`
		ToolName   string         `json:"toolName"`
		Args       map[string]any `json:"args"`
	}{"tool_execution_start", id, "bash", args})
	abort := <-f.abort
	fakeWire(struct {
		Type       string         `json:"type"`
		ToolCallID string         `json:"toolCallId"`
		ToolName   string         `json:"toolName"`
		Partial    map[string]any `json:"partialResult"`
	}{"tool_execution_update", id, "bash",
		map[string]any{"content": []any{map[string]any{"type": "text", "text": "partial output before the abort"}}}})
	cancelled := []any{map[string]any{"type": "text", "text": "Command aborted"}}
	fakeWire(struct {
		Type       string `json:"type"`
		ToolCallID string `json:"toolCallId"`
		ToolName   string `json:"toolName"`
		Result     any    `json:"result"`
		IsError    bool   `json:"isError"`
	}{"tool_execution_end", id, "bash", map[string]any{"content": cancelled, "details": map[string]any{}}, true})
	f.messageStart("toolResult")
	f.message("toolResult", map[string]any{
		"toolCallId": id, "toolName": "bash", "content": cancelled,
		"details": map[string]any{}, "isError": true,
	})
	f.turnEnd()
	f.nextTurn()
	f.assistant([]any{}, "error", map[string]any{"errorMessage": "The operation was aborted."})
	f.turnEnd()
	f.settle()
	fakeRespond(abort, nil)
}

// agentStart opens the agent's transcript.
func (f *fakePi) agentStart() {
	fakeWire(struct {
		Type string `json:"type"`
	}{"agent_start"})
}

// beginTurn is the transcript bracket every turn shares: the agent start, the turn, the user
// message.
func (f *fakePi) beginTurn(prompt fakeInputLine) {
	f.agentStart()
	f.nextTurn()
	f.messageStart("user")
	f.message("user", map[string]any{
		"content": []any{map[string]any{"type": "text", "text": fakeMember(prompt, "message")}},
	})
}

// nextTurn opens a turn.
func (f *fakePi) nextTurn() {
	fakeWire(struct {
		Type string `json:"type"`
	}{"turn_start"})
}

// turnEnd closes a turn around its last assistant message.
func (f *fakePi) turnEnd() {
	last := f.lastMsg
	if last == nil {
		last = map[string]any{}
	}
	fakeWire(struct {
		Type        string `json:"type"`
		Message     any    `json:"message"`
		ToolResults []any  `json:"toolResults"`
	}{"turn_end", last, []any{}})
}

// settle ends the agent and the turn: agent_end then the bare agent_settled.
func (f *fakePi) settle() {
	fakeWire(struct {
		Type      string `json:"type"`
		Messages  []any  `json:"messages"`
		WillRetry bool   `json:"willRetry"`
	}{"agent_end", f.messages, false})
	fakeWire(struct {
		Type string `json:"type"`
	}{"agent_settled"})
	if f.release != nil {
		f.release()
	}
}

// messageStart opens a streaming message.
func (f *fakePi) messageStart(role string) {
	fakeWire(struct {
		Type    string         `json:"type"`
		Message map[string]any `json:"message"`
	}{"message_start", map[string]any{"role": role}})
}

// message seals a message into the transcript.
func (f *fakePi) message(role string, fields map[string]any) {
	f.ids++
	all := map[string]any{"role": role}
	for name, value := range fields {
		all[name] = value
	}
	all["timestamp"] = time.Now().UnixMilli()
	f.messages = append(f.messages, all)
	fakeWire(struct {
		Type      string         `json:"type"`
		Message   map[string]any `json:"message"`
		MessageID string         `json:"messageId"`
	}{"message_end", all, "msg-" + strconv.Itoa(f.ids)})
}

// assistant is one assistant message with pi's own usage numbers.
func (f *fakePi) assistant(content []any, stopReason string, extra map[string]any) {
	provider, id, _ := strings.Cut(f.model, "/")
	fields := map[string]any{
		"content":    content,
		"api":        "anthropic-messages",
		"provider":   provider,
		"model":      id,
		"usage":      piUsage(),
		"stopReason": stopReason,
	}
	for name, value := range extra {
		fields[name] = value
	}
	f.messageStart("assistant")
	f.message("assistant", fields)
	f.lastMsg = fields
	var text strings.Builder
	for _, part := range content {
		if record, ok := part.(map[string]any); ok && record["type"] == "text" {
			if value, ok := record["text"].(string); ok {
				text.WriteString(value)
			}
		}
	}
	if text.Len() > 0 {
		f.lastText = text.String()
	}
}

// piUsage is the per-message usage the fake stamps, as pi does.
func piUsage() map[string]any {
	return map[string]any{
		"input": 100, "output": 20, "cacheRead": 50, "cacheWrite": 0, "totalTokens": 170,
		"cost": map[string]any{"input": 0.0001, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.0001},
	}
}

// textDeltas streams text as message_update events, one delta per word.
func (f *fakePi) textDeltas(text string) {
	update := func(event map[string]any) {
		event["contentIndex"] = 0
		fakeWire(struct {
			Type                  string         `json:"type"`
			Usage                 map[string]any `json:"usage"`
			AssistantMessageEvent map[string]any `json:"assistantMessageEvent"`
		}{"message_update", piUsage(), event})
	}
	update(map[string]any{"type": "text_start"})
	for _, word := range splitAfterSpace(text) {
		update(map[string]any{"type": "text_delta", "delta": word})
	}
	update(map[string]any{"type": "text_end", "content": text})
}

// ── the fake opencode ────────────────────────────────────────────────────────────────────────

var (
	opencodeValueFlags   = map[string]bool{"--format": true, "-m": true, "--model": true, "--variant": true, "--session": true, "--agent": true}
	opencodeBooleanFlags = map[string]bool{"--auto": true, "--print-logs": true, "-c": true, "--continue": true}
)

// runFakeOpenCode writes a fixture file's JSONL lines to stdout verbatim, then exits the way the
// real run did, or hangs in silence past the last line.
func runFakeOpenCode(args []string) {
	childBackstop()
	flags := map[string]string{}
	positionals := []string{}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if opencodeBooleanFlags[arg] {
			flags[arg] = ""
		} else if opencodeValueFlags[arg] && i+1 < len(args) {
			flags[arg] = args[i+1]
			i++
		} else if strings.HasPrefix(arg, "-") && arg != "-" {
			fmt.Fprintf(os.Stderr, "Error: Unknown option: %s\n", arg)
			os.Exit(2)
		} else {
			positionals = append(positionals, arg)
		}
	}
	if len(positionals) == 0 || positionals[0] != "run" {
		fmt.Fprintln(os.Stderr, "fake opencode: only `run` is supported")
		os.Exit(2)
	}
	fixture := os.Getenv("FAKE_OPENCODE_FIXTURE")
	if fixture == "" {
		fmt.Fprintln(os.Stderr, "fake opencode: FAKE_OPENCODE_FIXTURE is not set")
		os.Exit(2)
	}
	if path := os.Getenv("FAKE_OPENCODE_ARGV_LOG"); path != "" {
		writeChildJSON(path, args, true)
	}
	if path := os.Getenv("FAKE_OPENCODE_ENV_LOG"); path != "" {
		writeChildJSON(path, loggedChildEnv(), true)
	}
	if os.Getenv("FAKE_OPENCODE_RESUME_MISSING") == "1" {
		if _, ok := flags["--session"]; ok {
			fmt.Fprintln(os.Stderr, "\u001b[91m\u001b[1mError: \u001b[0mSession not found")
			os.Exit(1)
		}
	}
	data, err := os.ReadFile(fixture)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake opencode: "+err.Error())
		os.Exit(2)
	}
	lineMs := childEnvNumber("FAKE_OPENCODE_LINE_MS")
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		if lineMs > 0 {
			time.Sleep(time.Duration(lineMs) * time.Millisecond)
		}
		fmt.Println(line)
	}
	if os.Getenv("FAKE_OPENCODE_HANG") == "1" {
		// The dead-endpoint hang: only a signal ends it.
		time.Sleep(engineChildDeadline)
	}
	os.Exit(int(childEnvNumber("FAKE_OPENCODE_EXIT")))
}

// ── the fake zcode ───────────────────────────────────────────────────────────────────────────

// runFakeZcode prints the SDK warning line the real CLI prints, then one reply document with a
// notes report as its response, or hangs until it is stopped.
func runFakeZcode(args []string) {
	childBackstop()
	for _, arg := range args {
		if arg == "--version" {
			fmt.Println("zcode 0.16.1")
			return
		}
	}
	if path := os.Getenv("FAKE_ZCODE_ARGV_LOG"); path != "" {
		writeChildJSON(path, args, false)
	}
	if path := os.Getenv("FAKE_ZCODE_ENV_LOG"); path != "" {
		env := map[string]string{}
		for _, entry := range os.Environ() {
			name, value, found := strings.Cut(entry, "=")
			if found {
				env[name] = value
			}
		}
		writeChildJSON(path, env, false)
	}
	if os.Getenv("FAKE_ZCODE_HANG") != "" {
		time.Sleep(engineChildDeadline)
	}
	if os.Getenv("FAKE_ZCODE_MISSING") != "" {
		fmt.Fprintln(os.Stderr, "Session not found")
		os.Exit(1)
	}
	if custom := os.Getenv("FAKE_ZCODE_OUTPUT"); custom != "" {
		fmt.Println("SDK warning {not JSON}")
		fmt.Println(custom)
		os.Exit(int(childEnvNumber("FAKE_ZCODE_EXIT")))
	}
	reply := zcodeReply{}
	reply.SessionID = "sess_test"
	reply.Response = childEnvText("FAKE_ZCODE_TEXT", `{"summary":"pong","findings":[],"open_items":[]}`)
	reply.Usage = zcodeUsage{InputTokens: 100, OutputTokens: 20, CacheReadTokens: 50, CacheWriteTokens: 10}
	reply.Projection = zcodeProjection{Status: "idle", TurnCount: 3}
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(reply); err != nil {
		os.Exit(1)
	}
	fmt.Println("SDK warning {not JSON}")
	fmt.Print(out.String())
	os.Exit(int(childEnvNumber("FAKE_ZCODE_EXIT")))
}

// zcodeReply is the reply document the fake prints, in a fixed member order.
type zcodeReply struct {
	SessionID  string          `json:"sessionId"`
	Response   string          `json:"response"`
	Usage      zcodeUsage      `json:"usage"`
	Projection zcodeProjection `json:"projection"`
}

type zcodeUsage struct {
	InputTokens      int `json:"inputTokens"`
	OutputTokens     int `json:"outputTokens"`
	CacheReadTokens  int `json:"cacheReadTokens"`
	CacheWriteTokens int `json:"cacheWriteTokens"`
}

type zcodeProjection struct {
	Status    string `json:"status"`
	TurnCount int    `json:"turnCount"`
}
