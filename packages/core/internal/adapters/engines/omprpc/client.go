// A client for one `omp --mode rpc --no-ui` process: frame decoding, command/response
// correlation, the handshake, the host-tool sub-protocol, prompt completion and close semantics.
// Every inbound frame is also passed through, in order, on Frames, which is what the attempt log
// holds and what the event fold reads.
package omprpc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/shared"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
)

// DefaultHandshakeTimeoutMs: O0 measured a solo ready at 1.6–8 s and 15–18 s under 12–16
// concurrent spawns.
const DefaultHandshakeTimeoutMs int64 = 45_000

// benignStderr matches what omp prints while a slow startup phase runs (O0: up to 18 s under 16
// concurrent spawns).
var benignStderr = regexp.MustCompile(`^Still starting after \d+s\b`)

func isBenignStderr(line string) bool {
	return benignStderr.MatchString(line)
}

// RpcErrorKind discriminates the ways an RPC exchange fails.
type RpcErrorKind string

const (
	// RpcErrorStart: the binary could not be started, or a log could not be opened.
	RpcErrorStart RpcErrorKind = "start"
	// RpcErrorExited: the process ended (or its output did) before the answer came.
	RpcErrorExited  RpcErrorKind = "exited"
	RpcErrorTimeout RpcErrorKind = "timeout"
	// RpcErrorProtocol: omp spoke something the client cannot trust (no protocol 2, a broken
	// chunk sequence, unexpected tools).
	RpcErrorProtocol RpcErrorKind = "protocol"
	// RpcErrorRejected: omp answered success:false.
	RpcErrorRejected RpcErrorKind = "rejected"
	// RpcErrorClosed: stdin was already closed.
	RpcErrorClosed RpcErrorKind = "closed"
)

// RpcError is the error of one RPC exchange.
type RpcError struct {
	Kind    RpcErrorKind
	Message string
	Exit    *process.ProcessExit
	Command string
}

func (e *RpcError) Error() string { return e.Message }

// HostToolSpec is one host tool mounted during the handshake.
type HostToolSpec struct {
	Name        string         `json:"name"`
	Label       *string        `json:"label,omitempty"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
	// LoadMode "essential" mounts the tool directly; the default ("discoverable") adds write to a
	// read-only worker (O0 P3).
	LoadMode *string `json:"loadMode,omitempty"`
}

// EventFilter is the set of frame types omp emits for the session.
type EventFilter struct {
	Events         []string `json:"events"`
	MessageUpdates *string  `json:"messageUpdates,omitempty"`
}

// HostToolReply is a host tool's answer.
type HostToolReply struct {
	Text    string `json:"text"`
	IsError bool   `json:"isError,omitempty"`
}

// HostToolHandler runs a host tool. The signal channel closes when omp sends host_tool_cancel;
// nothing is replied after that. A nil reply with a nil error is a handler that did not answer.
type HostToolHandler func(call HostToolCall, signal <-chan struct{}) (*HostToolReply, error)

// RpcCommand is a command as sent, without its id (the client assigns ids): a JSON object.
type RpcCommand json.RawMessage

// OmpRpcOptions is how omp is started and observed.
type OmpRpcOptions struct {
	Command string
	Args    []string
	Cwd     string
	Env     []string
	// TimeoutMs is the wall clock after which the run is interrupted with reason "timeout".
	TimeoutMs *int64
	// GraceMs is between the RPC abort and SIGTERM, and between SIGTERM and SIGKILL.
	GraceMs        *int64
	Log            *shared.RpcLogPaths
	OnHostToolCall HostToolHandler
	OnStderr       process.StderrListener
}

// HandshakeOptions shapes the handshake.
type HandshakeOptions struct {
	// HostTools are mounted during the handshake; when empty set_host_tools is not sent and omp
	// keeps its built-in tools.
	HostTools   []HostToolSpec
	EventFilter EventFilter
	// TimeoutMs covers waiting for ready and every handshake response.
	TimeoutMs int64
	// ExpectTools: when given, get_state.dumpTools[].name must be exactly this set.
	ExpectTools []string
}

// Handshake is a completed handshake: get_state's data (sessionId, sessionFile, model, dumpTools,
// systemPrompt…) and the ready frame it started from.
type Handshake struct {
	Ready ReadyFrame
	State map[string]any
}

// TurnEnd is one finished turn, with the epoch ms of when the prompt was written and the turn
// settled.
type TurnEnd struct {
	Result         PromptResult
	PromptSentAtMs int64
	EndedAtMs      int64
}

// The client's own wire shapes, in the member order omp's protocol writes them. The id is not
// among them: call adds it first.
type (
	negotiateProtocolCommand struct {
		Type            string `json:"type"`
		ProtocolVersion int    `json:"protocolVersion"`
	}
	setHostToolsCommand struct {
		Type  string         `json:"type"`
		Tools []HostToolSpec `json:"tools"`
	}
	setEventFilterCommand struct {
		Type           string   `json:"type"`
		Events         []string `json:"events"`
		MessageUpdates *string  `json:"messageUpdates,omitempty"`
	}
	typeOnlyCommand struct {
		Type string `json:"type"`
	}
	promptCommand struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	}
	hostToolContent struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	hostToolResultBody struct {
		Content []hostToolContent `json:"content"`
	}
	hostToolResultFrame struct {
		Type    string             `json:"type"`
		ID      string             `json:"id"`
		Result  hostToolResultBody `json:"result"`
		IsError bool               `json:"isError,omitempty"`
	}
	idFrame struct {
		ID string `json:"id"`
	}
)

// rpcAnswer is one request's outcome, delivered to the goroutine waiting on it.
type rpcAnswer struct {
	response RpcResponse
	err      *RpcError
}

// turnAnswer is one turn's outcome.
type turnAnswer struct {
	end TurnEnd
	err *RpcError
}

// readyAnswer is the ready frame, or the error that ended it.
type readyAnswer struct {
	ready ReadyFrame
	err   *RpcError
}

// pendingTurn is a prompt waiting for its prompt_result.
type pendingTurn struct {
	done           chan turnAnswer
	promptSentAtMs int64
	// awaitingSettle is set once prompt_result said the session is not settled yet.
	awaitingSettle *PromptResult
}

// OmpRpcClient drives one omp process.
type OmpRpcClient struct {
	Pid int64

	ctx     context.Context
	proc    *process.StreamingProcess
	logs    shared.RpcLogs
	handler HostToolHandler

	frames *process.Queue[Frame]

	mu            sync.Mutex
	pending       map[string]chan rpcAnswer
	turns         map[string]*pendingTurn
	hostCalls     map[string]chan struct{}
	nextID        int
	inputClosed   bool
	terminal      *RpcError
	readyCh       chan readyAnswer
	readyAnswered bool
	decoder       *FrameDecoder

	exitOnce  sync.Once
	exitDone  chan struct{}
	exitValue process.ProcessExit
}

// softStop holds the stop function the process package races against the grace window; it only
// exists once the client does, so it is set after the start.
type softStop struct {
	mu   sync.Mutex
	stop func()
}

// Set installs the stop function.
func (s *softStop) Set(stop func()) {
	s.mu.Lock()
	s.stop = stop
	s.mu.Unlock()
}

// Run fires the stop function, whatever the interrupt's reason.
func (s *softStop) Run(process.ForcedReason) {
	s.mu.Lock()
	stop := s.stop
	s.mu.Unlock()
	if stop != nil {
		stop()
	}
}

// StartOmpRpc starts omp and wires the client to it.
func StartOmpRpc(ctx context.Context, options OmpRpcOptions) (*OmpRpcClient, *RpcError) {
	logs, err := shared.OpenRpcLogs(ctx, options.Log)
	if err != nil {
		return nil, &RpcError{Kind: RpcErrorStart, Message: err.Error()}
	}
	// The soft stop is omp's own cancel, so it only exists once the client does: the interrupt
	// looks it up when fired.
	stops := &softStop{}
	maxFrameBytes := int64(MaxFrameBytes)
	proc, err := process.StartStreaming(ctx, process.StreamCommand{
		Command:        options.Command,
		Args:           options.Args,
		Cwd:            options.Cwd,
		Env:            options.Env,
		TimeoutMs:      options.TimeoutMs,
		GraceMs:        options.GraceMs,
		MaxLineBytes:   &maxFrameBytes,
		IsBenignStderr: isBenignStderr,
		Soft:           stops.Run,
	}, options.OnStderr)
	if err != nil {
		_ = logs.Close(ctx)
		return nil, &RpcError{
			Kind:    RpcErrorStart,
			Message: fmt.Sprintf("cannot start %s: %v", options.Command, err),
		}
	}
	client := connect(ctx, proc, logs, options.OnHostToolCall)
	stops.Set(func() {
		// The abort ends the running turn; closing stdin then lets omp drain and exit on its own.
		_, _ = client.Abort()
		proc.EndInput()
	})
	return client, nil
}

// connect wires one started process into a client: one decoder for the whole stream, so the
// handshake can turn chunk decoding on the moment protocol 2 is agreed.
func connect(ctx context.Context, proc *process.StreamingProcess, logs shared.RpcLogs, handler HostToolHandler) *OmpRpcClient {
	client := &OmpRpcClient{
		Pid:       proc.Pid,
		ctx:       ctx,
		proc:      proc,
		logs:      logs,
		handler:   handler,
		frames:    process.CreateQueue[Frame](),
		pending:   map[string]chan rpcAnswer{},
		turns:     map[string]*pendingTurn{},
		hostCalls: map[string]chan struct{}{},
		readyCh:   make(chan readyAnswer, 1),
		exitDone:  make(chan struct{}),
		decoder:   CreateFrameDecoder(),
	}
	go client.readLoop()
	return client
}

// readLoop drains the process's lines through the decoder until stdout ends, then settles the
// exit: every waiter hears the exit, the frame stream ends and the logs close.
func (c *OmpRpcClient) readLoop() {
	for line := range c.proc.Lines {
		c.dispatch(c.decoder.Push(line), line)
	}
	ended := <-c.proc.Exit
	c.fail(&RpcError{Kind: RpcErrorExited, Message: describeExit(ended), Exit: &ended})
	c.frames.Close()
	_ = c.logs.Close(c.ctx)
	c.exitOnce.Do(func() {
		c.exitValue = ended
		close(c.exitDone)
	})
}

// Frames is every inbound frame in arrival order (chunked frames reassembled); it ends with
// stdout. It must be kept draining: the queue buffers unread frames in memory without bound.
func (c *OmpRpcClient) Frames() <-chan Frame { return c.frames.Items() }

// Exit resolves once stdout is drained, the process has exited and the logs are closed.
func (c *OmpRpcClient) Exit() process.ProcessExit {
	<-c.exitDone
	return c.exitValue
}

// Handshake negotiates v2, mounts the host tools, sets the filter and returns get_state. On
// failure omp is killed: a peer the handshake gave up on keeps running unwatched, and must not
// outlive the attempt.
func (c *OmpRpcClient) Handshake(ctx context.Context, options HandshakeOptions) (Handshake, *RpcError) {
	steps := make(chan handshakeStep, 1)
	go func() {
		handshake, err := c.handshakeSteps(options)
		steps <- handshakeStep{handshake: handshake, err: err}
	}()
	timer := time.NewTimer(time.Duration(options.TimeoutMs) * time.Millisecond)
	var result handshakeStep
	select {
	case result = <-steps:
		timer.Stop()
	case <-timer.C:
		result.err = &RpcError{
			Kind:    RpcErrorTimeout,
			Message: fmt.Sprintf("omp did not complete the RPC handshake within %d ms", options.TimeoutMs),
		}
	}
	if result.err != nil && result.err.Kind != RpcErrorExited {
		c.mu.Lock()
		c.inputClosed = true
		c.mu.Unlock()
		// The kill goes first: a peer that drains on stdin EOF would otherwise race its own
		// clean exit 0 past the SIGKILL the failed handshake owes it.
		c.proc.Signal(syscall.SIGKILL)
		c.proc.EndInput()
	}
	return result.handshake, result.err
}

// handshakeStep carries the handshake steps' answer into the timeout race.
type handshakeStep struct {
	handshake Handshake
	err       *RpcError
}

// handshakeSteps runs the handshake's own exchange, without its timeout.
func (c *OmpRpcClient) handshakeSteps(options HandshakeOptions) (Handshake, *RpcError) {
	ready := <-c.readyCh
	if ready.err != nil {
		return Handshake{}, ready.err
	}
	if err := requireProtocol2(ready.ready); err != nil {
		return Handshake{}, err
	}
	c.decoder.Negotiated(ready.ready.MaxFrameBytes)
	// All the commands go out before any answer is awaited: a replaying peer answers them only
	// once it has taken every one.
	commands := handshakeCommands(options)
	answers := make([]chan rpcAnswer, len(commands))
	for i, command := range commands {
		answer, err := c.start(c.nextCommandID(), command)
		if err != nil {
			return Handshake{}, err
		}
		answers[i] = answer
	}
	var last RpcResponse
	for _, answer := range answers {
		received := <-answer
		if received.err != nil {
			return Handshake{}, received.err
		}
		last = received.response
	}
	state := map[string]any{}
	if len(last.Data) > 0 {
		var data any
		if err := json.Unmarshal(last.Data, &data); err == nil {
			if record, ok := data.(map[string]any); ok {
				state = record
			}
		}
	}
	if err := checkTools(state, options.ExpectTools); err != nil {
		return Handshake{}, err
	}
	return Handshake{Ready: ready.ready, State: state}, nil
}

// Request sends a command and waits for its response.
func (c *OmpRpcClient) Request(command RpcCommand) (RpcResponse, *RpcError) {
	return c.call(c.nextCommandID(), json.RawMessage(command))
}

// Prompt runs one turn: the ack, then prompt_result, then session_settled only when the result
// says the session is not settled.
func (c *OmpRpcClient) Prompt(message string) (TurnEnd, *RpcError) {
	c.mu.Lock()
	c.nextID++
	id := fmt.Sprintf("c%d", c.nextID)
	c.mu.Unlock()
	promptSentAt := time.Now().UnixMilli()
	turn := &pendingTurn{done: make(chan turnAnswer, 1), promptSentAtMs: promptSentAt}
	c.mu.Lock()
	c.turns[id] = turn
	c.mu.Unlock()
	if _, err := c.call(id, mustJSON(promptCommand{Type: "prompt", Message: message})); err != nil {
		c.mu.Lock()
		delete(c.turns, id)
		c.mu.Unlock()
		return TurnEnd{}, err
	}
	answer := <-turn.done
	return answer.end, answer.err
}

// Abort is the RPC abort: omp cancels the running tool and ends the turn with
// prompt_result{aborted}.
func (c *OmpRpcClient) Abort() (RpcResponse, *RpcError) {
	return c.Request(RpcCommand(`{"type":"abort"}`))
}

// Close closes stdin and keeps reading until EOF: omp drains, disposes the session and exits 0.
func (c *OmpRpcClient) Close() process.ProcessExit {
	c.mu.Lock()
	c.inputClosed = true
	c.mu.Unlock()
	c.proc.EndInput()
	return c.Exit()
}

// Interrupt runs the RPC abort and stdin close first (the soft stop), then terminates omp's
// process group.
func (c *OmpRpcClient) Interrupt(reason process.ForcedReason) {
	c.proc.Interrupt(c.ctx, reason)
}

// Kill signals omp's process group.
func (c *OmpRpcClient) Kill(signal syscall.Signal) bool {
	return c.proc.Signal(signal)
}

// HandshakeTimeoutMs reads OMPCC_HANDSHAKE_TIMEOUT_MS when it names a positive integer, else the
// default.
func HandshakeTimeoutMs(env map[string]string) int64 {
	if value, ok := env["OMPCC_HANDSHAKE_TIMEOUT_MS"]; ok {
		if number, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil &&
			number == math.Trunc(number) && number > 0 && number <= maxSafeInteger {
			return int64(number)
		}
	}
	return DefaultHandshakeTimeoutMs
}

// nextCommandID is the next request's id.
func (c *OmpRpcClient) nextCommandID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextID++
	return fmt.Sprintf("c%d", c.nextID)
}

// call sends one command under id and waits for its response.
func (c *OmpRpcClient) call(id string, command json.RawMessage) (RpcResponse, *RpcError) {
	answer, err := c.start(id, command)
	if err != nil {
		return RpcResponse{}, err
	}
	received := <-answer
	return received.response, received.err
}

// start registers one request and writes it; the returned channel resolves once omp answers.
func (c *OmpRpcClient) start(id string, command json.RawMessage) (chan rpcAnswer, *RpcError) {
	c.mu.Lock()
	if c.inputClosed || c.terminal != nil {
		err := c.unavailable()
		c.mu.Unlock()
		return nil, err
	}
	answer := make(chan rpcAnswer, 1)
	c.pending[id] = answer
	c.mu.Unlock()
	if !c.send(withID(command, id)) {
		// A command this close refused to write can never be answered; a broken pipe instead is
		// the exit's story, and the waiter hears it when the exit fails everything.
		c.mu.Lock()
		refused := c.inputClosed
		err := c.unavailable()
		c.mu.Unlock()
		if refused {
			delete(c.pending, id)
			return nil, err
		}
	}
	return answer, nil
}

// unavailable is why no command can be sent: the terminal error when one was recorded, else the
// closed stdin. Called with mu held.
func (c *OmpRpcClient) unavailable() *RpcError {
	if c.terminal != nil {
		return c.terminal
	}
	return &RpcError{
		Kind:    RpcErrorClosed,
		Message: "omp's stdin is closed; no further commands can be sent",
	}
}

// send writes one frame to omp, logging it as sent.
func (c *OmpRpcClient) send(frame json.RawMessage) bool {
	c.mu.Lock()
	closed := c.inputClosed || c.terminal != nil
	c.mu.Unlock()
	if closed {
		return false
	}
	c.logs.Outbound(frame)
	return c.proc.Write(string(frame))
}

// fail ends the client: the first error is the terminal one, every waiter hears it, and every
// host-tool handler is cancelled.
func (c *OmpRpcClient) fail(err *RpcError) {
	c.mu.Lock()
	if c.terminal == nil {
		c.terminal = err
	}
	terminal := c.terminal
	pending := c.pending
	c.pending = map[string]chan rpcAnswer{}
	turns := c.turns
	c.turns = map[string]*pendingTurn{}
	hostCalls := c.hostCalls
	c.hostCalls = map[string]chan struct{}{}
	c.mu.Unlock()

	c.resolveReady(ReadyFrame{}, terminal)
	for _, answer := range pending {
		answer <- rpcAnswer{err: terminal}
	}
	for _, turn := range turns {
		turn.done <- turnAnswer{err: terminal}
	}
	for _, cancel := range hostCalls {
		close(cancel)
	}
}

// resolveReady hands the ready frame (or the error that ended it) to the handshake, once.
func (c *OmpRpcClient) resolveReady(ready ReadyFrame, err *RpcError) {
	c.mu.Lock()
	if c.readyAnswered {
		c.mu.Unlock()
		return
	}
	c.readyAnswered = true
	c.mu.Unlock()
	c.readyCh <- readyAnswer{ready: ready, err: err}
}

// dispatch is what one decoded line becomes: a logged and routed frame, a logged stray line, or
// the end of the stream.
func (c *OmpRpcClient) dispatch(decoded Decoded, line string) {
	switch decoded.Kind {
	case DecodedFrame:
		c.logs.Inbound(shared.LogText(decoded.Frame, decoded.Text))
		c.frames.Push(decoded.Frame)
		c.route(decoded.Frame)
	case DecodedMalformed:
		c.logs.Inbound(line)
	case DecodedError:
		c.fail(&RpcError{Kind: RpcErrorProtocol, Message: "omp RPC stream: " + decoded.Reason})
	}
}

// route sends one frame to whoever waits for it.
func (c *OmpRpcClient) route(frame Frame) {
	if ready, ok := IsReady(frame); ok {
		c.resolveReady(ready, nil)
		return
	}
	if response, ok := IsResponse(frame); ok {
		c.onResponse(response)
		return
	}
	if result, ok := IsPromptResult(frame); ok {
		c.onPromptResult(result)
		return
	}
	if frameType(frame) == "session_settled" {
		c.onSessionSettled()
		return
	}
	if call, ok := IsHostToolCall(frame); ok {
		c.onHostCall(call)
		return
	}
	if targetID, ok := IsHostToolCancel(frame); ok {
		c.cancelHostCall(targetID)
	}
}

// onResponse hands one response to the request waiting on its id.
func (c *OmpRpcClient) onResponse(response RpcResponse) {
	if response.ID == nil {
		return
	}
	c.mu.Lock()
	answer, waiting := c.pending[*response.ID]
	if waiting {
		delete(c.pending, *response.ID)
	}
	c.mu.Unlock()
	if !waiting {
		return
	}
	if response.Success {
		answer <- rpcAnswer{response: response}
		return
	}
	message := fmt.Sprintf("omp refused %s", response.Command)
	if response.Error != nil {
		message = *response.Error
	}
	answer <- rpcAnswer{err: &RpcError{Kind: RpcErrorRejected, Command: response.Command, Message: message}}
}

// onPromptResult settles the turn it belongs to, or holds it until the session settles.
func (c *OmpRpcClient) onPromptResult(result PromptResult) {
	c.mu.Lock()
	turn, waiting := c.turns[result.ID]
	if !waiting {
		c.mu.Unlock()
		return
	}
	if result.SessionSettled || !result.AgentInvoked {
		delete(c.turns, result.ID)
		c.mu.Unlock()
		turn.done <- turnAnswer{end: c.turnEnd(turn, result)}
		return
	}
	awaiting := result
	turn.awaitingSettle = &awaiting
	c.mu.Unlock()
}

// onSessionSettled settles every turn whose prompt_result said the session was not settled yet.
func (c *OmpRpcClient) onSessionSettled() {
	type settled struct {
		turn   *pendingTurn
		result PromptResult
	}
	c.mu.Lock()
	var ready []settled
	for id, turn := range c.turns {
		if turn.awaitingSettle != nil {
			delete(c.turns, id)
			ready = append(ready, settled{turn: turn, result: *turn.awaitingSettle})
		}
	}
	c.mu.Unlock()
	for _, done := range ready {
		done.turn.done <- turnAnswer{end: c.turnEnd(done.turn, done.result)}
	}
}

// turnEnd stamps a prompt_result with its turn's timing.
func (c *OmpRpcClient) turnEnd(turn *pendingTurn, result PromptResult) TurnEnd {
	return TurnEnd{Result: result, PromptSentAtMs: turn.promptSentAtMs, EndedAtMs: time.Now().UnixMilli()}
}

// onHostCall runs one host tool on its own goroutine and replies with its result.
func (c *OmpRpcClient) onHostCall(call HostToolCall) {
	cancel := make(chan struct{})
	c.mu.Lock()
	c.hostCalls[call.ID] = cancel
	c.mu.Unlock()
	go func() {
		reply := runHostTool(c.handler, call, cancel)
		c.mu.Lock()
		delete(c.hostCalls, call.ID)
		aborted := false
		select {
		case <-cancel:
			aborted = true
		default:
		}
		c.mu.Unlock()
		if aborted {
			// omp gave up on the call (host_tool_cancel); no result may follow.
			return
		}
		c.send(mustJSON(hostToolResultFrame{
			Type:    "host_tool_result",
			ID:      call.ID,
			Result:  hostToolResultBody{Content: []hostToolContent{{Type: "text", Text: reply.Text}}},
			IsError: reply.IsError,
		}))
	}()
}

// cancelHostCall cancels one host-tool handler: omp gave up on its call.
func (c *OmpRpcClient) cancelHostCall(targetID string) {
	c.mu.Lock()
	cancel, waiting := c.hostCalls[targetID]
	if waiting {
		delete(c.hostCalls, targetID)
	}
	c.mu.Unlock()
	if waiting {
		close(cancel)
	}
}

// runHostTool runs the handler, answering for it when it is missing, broken or mute. omp waits on
// the call until it is answered, so even a broken reply path must send one.
func runHostTool(handler HostToolHandler, call HostToolCall, signal <-chan struct{}) HostToolReply {
	if handler == nil {
		return HostToolReply{Text: "No host tool named " + call.ToolName + ".", IsError: true}
	}
	reply, err := handler(call, signal)
	if err != nil {
		return HostToolReply{Text: err.Error(), IsError: true}
	}
	// The handler is host code; whatever it returns is only a reply once it says so.
	if reply == nil {
		return HostToolReply{
			Text:    "the handler for " + call.ToolName + " did not return a reply",
			IsError: true,
		}
	}
	return *reply
}

// handshakeCommands is the handshake's commands in send order; the get_state reply is always the
// last one.
func handshakeCommands(options HandshakeOptions) []json.RawMessage {
	commands := []json.RawMessage{
		mustJSON(negotiateProtocolCommand{Type: "negotiate_protocol", ProtocolVersion: 2}),
	}
	if len(options.HostTools) > 0 {
		commands = append(commands, mustJSON(setHostToolsCommand{Type: "set_host_tools", Tools: options.HostTools}))
	}
	commands = append(commands,
		mustJSON(setEventFilterCommand{
			Type:           "set_event_filter",
			Events:         options.EventFilter.Events,
			MessageUpdates: options.EventFilter.MessageUpdates,
		}),
		mustJSON(typeOnlyCommand{Type: "get_state"}),
	)
	return commands
}

// requireProtocol2 refuses a peer that does not speak protocol 2.
func requireProtocol2(ready ReadyFrame) *RpcError {
	for _, version := range ready.SupportedProtocolVersions {
		if version == 2 {
			return nil
		}
	}
	versions := make([]string, 0, len(ready.SupportedProtocolVersions))
	for _, version := range ready.SupportedProtocolVersions {
		versions = append(versions, strconv.FormatFloat(version, 'g', -1, 64))
	}
	return &RpcError{
		Kind:    RpcErrorProtocol,
		Message: fmt.Sprintf("omp offers RPC protocol %s; 2 is required", strings.Join(versions, ", ")),
	}
}

// checkTools refuses a peer whose exposed tools are not exactly the expected set.
func checkTools(state map[string]any, expected []string) *RpcError {
	if expected == nil {
		return nil
	}
	var names []string
	if dump, ok := state["dumpTools"].([]any); ok {
		for _, tool := range dump {
			if record, ok := tool.(map[string]any); ok {
				if name, ok := record["name"].(string); ok {
					names = append(names, name)
				}
			}
		}
	}
	same := len(names) == len(expected)
	if same {
		for _, want := range expected {
			found := false
			for _, name := range names {
				if name == want {
					found = true
					break
				}
			}
			if !found {
				same = false
				break
			}
		}
	}
	if same {
		return nil
	}
	return &RpcError{
		Kind: RpcErrorProtocol,
		Message: fmt.Sprintf("omp exposes the tools [%s], expected exactly [%s]",
			strings.Join(names, ", "), strings.Join(expected, ", ")),
	}
}

// describeExit is the message the exit error carries: how omp ended and, when it has one, the tail
// of its stderr.
func describeExit(exit process.ProcessExit) string {
	how := ""
	if exit.Code != nil {
		how = fmt.Sprintf("exit code %d", *exit.Code)
	} else {
		how = "signal " + exit.Signal
	}
	tail := strings.TrimSpace(exit.StderrTail)
	if tail == "" {
		return fmt.Sprintf("omp ended (%s)", how)
	}
	return fmt.Sprintf("omp ended (%s): %s", how, tail)
}

// withID renders `{id, ...command}`: the id first, the command's members in written order. A
// command that is not an object contributes nothing.
func withID(command json.RawMessage, id string) json.RawMessage {
	if trimmed := bytes.TrimSpace(command); len(trimmed) > 0 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}' {
		body := string(trimmed[1 : len(trimmed)-1])
		if strings.TrimSpace(body) != "" {
			var out bytes.Buffer
			out.WriteString(`{"id":`)
			out.Write(mustJSON(id))
			out.WriteByte(',')
			out.WriteString(body)
			out.WriteByte('}')
			return json.RawMessage(out.Bytes())
		}
	}
	return mustJSON(idFrame{ID: id})
}

// mustJSON encodes value, falling back to an empty object (the caller's shapes never fail).
func mustJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return encoded
}
