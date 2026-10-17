package pirpc

// A client for one `pi --mode rpc` process (pi 1.0.4): frame decoding, command/response
// correlation, the handshake, prompt completion and close semantics. Every inbound frame is also
// passed through, in order, on Frames, which is what the attempt log holds and what the event fold
// reads. pi negotiates nothing and has no host-tool sub-protocol: commands are sent, answered, and
// a bare agent_settled ends every turn.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/shared"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
)

// DefaultHandshakeTimeoutMs: a healthy pi answers get_state within a second of spawn (probed on
// 1.0.4); slow starts are node itself.
const DefaultHandshakeTimeoutMs int64 = 15_000

// PiCommand is how pi is started. A bare client applies no wall clock of its own; the worker
// always passes one.
type PiCommand struct {
	Command string
	Args    []string
	Cwd     string
	Env     []string
	// TimeoutMs is the wall clock after which the run is interrupted with reason "timeout".
	TimeoutMs *int64
	// GraceMs is between the RPC abort and SIGTERM, and between SIGTERM and SIGKILL.
	GraceMs *int64
}

// RpcErrorKind is how an RPC exchange failed.
type RpcErrorKind string

const (
	// RpcErrorStart: the binary could not be started, or a log could not be opened.
	RpcErrorStart RpcErrorKind = "start"
	// RpcErrorExited: the process ended (or its output did) before the answer came.
	RpcErrorExited  RpcErrorKind = "exited"
	RpcErrorTimeout RpcErrorKind = "timeout"
	// RpcErrorProtocol: pi spoke something the client cannot trust: a get_state without a
	// sessionId, a text-less answer.
	RpcErrorProtocol RpcErrorKind = "protocol"
	// RpcErrorRejected: pi answered success false.
	RpcErrorRejected RpcErrorKind = "rejected"
	// RpcErrorClosed: stdin was already closed.
	RpcErrorClosed RpcErrorKind = "closed"
)

// RpcError is one failed RPC exchange.
type RpcError struct {
	Kind    RpcErrorKind
	Message string
	// Exit, for RpcErrorExited: how the process ended.
	Exit *process.ProcessExit
	// Command, for RpcErrorRejected: what pi refused.
	Command string
}

func (e *RpcError) Error() string {
	return e.Message
}

// PiRpcOptions is a PiCommand plus what the client adds around it.
type PiRpcOptions struct {
	PiCommand
	Log      *shared.RpcLogPaths
	OnStderr process.StderrListener
}

// HandshakeOptions shapes the handshake wait.
type HandshakeOptions struct {
	// TimeoutMs covers waiting for the get_state answer.
	TimeoutMs int64
}

// Handshake is a completed handshake.
type Handshake struct {
	// State is get_state's data: sessionId, sessionFile, model, thinkingLevel…
	State map[string]json.RawMessage
}

// TurnEnd is when one turn ran: epoch ms when the prompt was written, and when the turn was
// settled.
type TurnEnd struct {
	PromptSentAt int64
	EndedAt      int64
}

// PiRpcClient is one running pi.
type PiRpcClient struct {
	Pid int64
	// Frames is every inbound frame in arrival order; it closes with stdout. It must be kept
	// draining: the queue buffers unread frames in memory without bound.
	Frames <-chan Frame
	// Exit delivers the process exit once, to one consumer at a time; Wait is the multi-caller
	// form.
	Exit <-chan process.ProcessExit

	ctx            context.Context
	proc           *process.StreamingProcess
	logs           shared.RpcLogs
	queue          *process.Queue[Frame]
	mu             sync.Mutex
	pending        map[string]chan rpcAnswer
	nextId         int
	inputClosed    bool
	terminal       *RpcError
	pendingTurn    *pendingTurn
	handshakeTimer *time.Timer
	exitCh         chan process.ProcessExit
	exitMu         sync.Mutex
	exitValue      process.ProcessExit
	exitSet        bool
	exitWaiting    bool
	exitDone       chan struct{}
}

// rpcAnswer is what a waiting command call receives.
type rpcAnswer struct {
	response RpcResponse
	err      *RpcError
}

// rpcTurnAnswer is what a waiting prompt receives.
type rpcTurnAnswer struct {
	turn TurnEnd
	err  *RpcError
}

// pendingTurn is the turn waiting for its agent_settled.
type pendingTurn struct {
	answer       chan rpcTurnAnswer
	promptSentAt int64
}

// handshakeWork is the handshake's own answer, delivered from its goroutine.
type handshakeWork struct {
	state Handshake
	err   *RpcError
}

// benignStderr matches what pi prints on stderr while creating a session for a --session-id it
// has not seen (it resumes otherwise).
var benignStderr = regexp.MustCompile(
	`^Warning: No project session found with id '.+'; creating a new session with that id\.$`)

func isBenignStderr(line string) bool {
	return benignStderr.MatchString(line)
}

// HandshakeTimeoutMs is PICC_HANDSHAKE_TIMEOUT_MS when it is a positive integer, else the
// default.
func HandshakeTimeoutMs(env map[string]string) int64 {
	value, err := strconv.ParseInt(strings.TrimSpace(env["PICC_HANDSHAKE_TIMEOUT_MS"]), 10, 64)
	if err != nil || value <= 0 {
		return DefaultHandshakeTimeoutMs
	}
	return value
}

// StartPiRpc starts one pi process and wires its client.
func StartPiRpc(ctx context.Context, options PiRpcOptions) (*PiRpcClient, *RpcError) {
	logs, err := shared.OpenRpcLogs(ctx, options.Log)
	if err != nil {
		return nil, &RpcError{Kind: RpcErrorStart, Message: err.Error()}
	}
	// The soft stop is pi's own cancel, so it only exists once the client does: the hook looks it
	// up when fired. The channel hands it over whenever the process's supervision calls for it.
	ready := make(chan *PiRpcClient, 1)
	soft := func(process.ForcedReason) {
		// The abort ends the running turn; closing stdin then lets pi save its session and exit
		// on its own.
		client := <-ready
		_, _ = client.Abort()
		client.proc.EndInput()
	}
	maxFrameBytes := MaxFrameBytes
	proc, err := process.StartStreaming(ctx, process.StreamCommand{
		Command:   options.Command,
		Args:      options.Args,
		Cwd:       options.Cwd,
		Env:       options.Env,
		TimeoutMs: options.TimeoutMs,
		GraceMs:   options.GraceMs,
		// pi's agent_end frames carry the whole session, so its budget is far above the shared
		// default (frames.go owns the number).
		MaxLineBytes:   &maxFrameBytes,
		IsBenignStderr: isBenignStderr,
		Soft:           soft,
	}, options.OnStderr)
	if err != nil {
		_ = logs.Close(ctx)
		return nil, &RpcError{
			Kind:    RpcErrorStart,
			Message: fmt.Sprintf("cannot start %s: %v", options.Command, err),
		}
	}
	client := connect(ctx, proc, logs)
	ready <- client
	return client, nil
}

// connect wires the started process into a client and starts its reader loop, which owns the
// frame decoder and the logs' closing.
func connect(ctx context.Context, proc *process.StreamingProcess, logs shared.RpcLogs) *PiRpcClient {
	queue := process.CreateQueue[Frame]()
	exitCh := make(chan process.ProcessExit, 1)
	client := &PiRpcClient{
		Pid:      proc.Pid,
		Frames:   queue.Items(),
		Exit:     exitCh,
		ctx:      ctx,
		proc:     proc,
		logs:     logs,
		queue:    queue,
		pending:  map[string]chan rpcAnswer{},
		exitCh:   exitCh,
		exitDone: make(chan struct{}),
	}
	decoder := CreateFrameDecoder()
	go func() {
		for line := range proc.Lines {
			client.dispatch(decoder.Push(line), line)
		}
		ended := <-proc.Exit
		client.fail(&RpcError{Kind: RpcErrorExited, Message: describeExit(ended), Exit: &ended})
		// The queue closes with stdout: nothing new can arrive after this.
		queue.Close()
		_ = client.logs.Close(ctx)
		exitCh <- ended
	}()
	return client
}

// Handshake sends get_state and waits for its answer within the timeout. A peer the handshake
// gave up on keeps running unwatched; it must not outlive the attempt, so pi is killed on every
// failure but an exit.
func (c *PiRpcClient) Handshake(options HandshakeOptions) (Handshake, *RpcError) {
	work := make(chan handshakeWork, 1)
	go func() {
		state, err := c.handshakeSteps()
		work <- handshakeWork{state: state, err: err}
	}()
	timer := time.NewTimer(time.Duration(options.TimeoutMs) * time.Millisecond)
	c.mu.Lock()
	c.handshakeTimer = timer
	c.mu.Unlock()
	defer timer.Stop()
	select {
	case done := <-work:
		if done.err != nil && done.err.Kind != RpcErrorExited {
			c.abandon()
		}
		return done.state, done.err
	case <-timer.C:
		c.abandon()
		return Handshake{}, &RpcError{
			Kind:    RpcErrorTimeout,
			Message: fmt.Sprintf("pi did not complete the RPC handshake within %d ms", options.TimeoutMs),
		}
	}
}

// handshakeSteps is the handshake itself, without its timeout.
func (c *PiRpcClient) handshakeSteps() (Handshake, *RpcError) {
	reply, err := c.Request(json.RawMessage(`{"type":"get_state"}`))
	if err != nil {
		return Handshake{}, err
	}
	state := reply.Data
	if _, ok := frameStringOk(state, "sessionId"); !ok {
		return Handshake{}, &RpcError{
			Kind:    RpcErrorProtocol,
			Message: "pi's get_state answer carries no sessionId",
		}
	}
	return Handshake{State: state}, nil
}

// Request sends a command (an object without its id; the client assigns ids) and waits for its
// response.
func (c *PiRpcClient) Request(command json.RawMessage) (RpcResponse, *RpcError) {
	c.mu.Lock()
	c.nextId++
	id := fmt.Sprintf("c%d", c.nextId)
	c.mu.Unlock()
	return c.call(id, command)
}

// call sends a command under a known id and waits for its answer.
func (c *PiRpcClient) call(id string, command json.RawMessage) (RpcResponse, *RpcError) {
	c.mu.Lock()
	if c.inputClosed || c.terminal != nil {
		err := c.unavailable()
		c.mu.Unlock()
		return RpcResponse{}, err
	}
	answer := make(chan rpcAnswer, 1)
	c.pending[id] = answer
	c.mu.Unlock()
	c.send(withID(id, command))
	// A send that failed (pi closed its stdin) resolves at the latest when its exit fails every
	// pending call.
	got := <-answer
	return got.response, got.err
}

// send writes one command, logged as sent.
func (c *PiRpcClient) send(command json.RawMessage) bool {
	c.mu.Lock()
	blocked := c.inputClosed || c.terminal != nil
	c.mu.Unlock()
	if blocked {
		return false
	}
	c.logs.Outbound(command)
	return c.proc.Write(string(command))
}

// Prompt runs one turn: the prompt's ack (admission only), then the agent_settled that ends the
// turn. pi is single-flight, so a second prompt while a turn is open drops the first turn's
// completion.
func (c *PiRpcClient) Prompt(message string) (TurnEnd, *RpcError) {
	c.mu.Lock()
	c.nextId++
	id := fmt.Sprintf("c%d", c.nextId)
	mine := &pendingTurn{
		answer:       make(chan rpcTurnAnswer, 1),
		promptSentAt: time.Now().UnixMilli(),
	}
	c.pendingTurn = mine
	c.mu.Unlock()
	_, ack := c.call(id, promptCommand(message))
	if ack != nil {
		c.mu.Lock()
		if c.pendingTurn == mine {
			c.pendingTurn = nil
		}
		c.mu.Unlock()
		return TurnEnd{}, ack
	}
	answer := <-mine.answer
	return answer.turn, answer.err
}

// Abort is the RPC abort: pi cancels the running tool and settles the turn.
func (c *PiRpcClient) Abort() (RpcResponse, *RpcError) {
	return c.Request(json.RawMessage(`{"type":"abort"}`))
}

// LastAssistantText is get_last_assistant_text: the worker's fallback when the last assistant
// message ended with no text.
func (c *PiRpcClient) LastAssistantText() (string, *RpcError) {
	reply, err := c.Request(json.RawMessage(`{"type":"get_last_assistant_text"}`))
	if err != nil {
		return "", err
	}
	text, ok := frameStringOk(reply.Data, "text")
	if !ok {
		return "", &RpcError{
			Kind:    RpcErrorProtocol,
			Message: "pi's get_last_assistant_text answer carries no text",
		}
	}
	return text, nil
}

// Close closes stdin and keeps reading until EOF: pi saves its session and exits 0.
func (c *PiRpcClient) Close() process.ProcessExit {
	c.mu.Lock()
	c.inputClosed = true
	c.mu.Unlock()
	c.proc.EndInput()
	return c.Wait()
}

// Wait is the exit promise: it resolves once stdout is drained, the process has exited and the
// logs are closed, and every caller gets the same answer.
func (c *PiRpcClient) Wait() process.ProcessExit {
	c.exitMu.Lock()
	if c.exitSet {
		value := c.exitValue
		c.exitMu.Unlock()
		return value
	}
	if c.exitWaiting {
		c.exitMu.Unlock()
		<-c.exitDone
		c.exitMu.Lock()
		value := c.exitValue
		c.exitMu.Unlock()
		return value
	}
	c.exitWaiting = true
	c.exitMu.Unlock()
	value := <-c.exitCh
	c.exitMu.Lock()
	c.exitValue, c.exitSet = value, true
	close(c.exitDone)
	c.exitMu.Unlock()
	return value
}

// Interrupt runs the RPC abort and stdin close first (the soft stop), then terminates pi's
// process group. A graceMs given here overrides the one the command was started with.
func (c *PiRpcClient) Interrupt(ctx context.Context, reason process.ForcedReason, graceMs ...int64) {
	c.proc.Interrupt(ctx, reason, graceMs...)
}

// Kill signals pi's process group.
func (c *PiRpcClient) Kill(signal syscall.Signal) {
	c.proc.Signal(signal)
}

// fail settles everything still waiting with one terminal failure; the first failure wins.
func (c *PiRpcClient) fail(failure *RpcError) {
	c.mu.Lock()
	if c.terminal == nil {
		c.terminal = failure
	}
	terminal := c.terminal
	pending := c.pending
	c.pending = map[string]chan rpcAnswer{}
	turn := c.pendingTurn
	c.pendingTurn = nil
	c.mu.Unlock()
	for _, answer := range pending {
		answer <- rpcAnswer{err: terminal}
	}
	if turn != nil {
		turn.answer <- rpcTurnAnswer{err: terminal}
	}
}

// onResponse hands a response envelope to its waiting call, correlating by id; an answer with no
// id (pi answering a line it could not parse) reaches no one.
func (c *PiRpcClient) onResponse(response RpcResponse) {
	c.mu.Lock()
	answer, waiting := c.pending[response.Id]
	if waiting {
		delete(c.pending, response.Id)
	}
	c.mu.Unlock()
	if !waiting {
		return
	}
	if response.Success {
		answer <- rpcAnswer{response: response}
		return
	}
	message := response.Error
	if message == "" {
		message = "pi refused " + response.Command
	}
	answer <- rpcAnswer{err: &RpcError{
		Kind:    RpcErrorRejected,
		Command: response.Command,
		Message: message,
	}}
}

// onSettled settles the pending turn at its bare agent_settled.
func (c *PiRpcClient) onSettled() {
	c.mu.Lock()
	turn := c.pendingTurn
	c.pendingTurn = nil
	c.mu.Unlock()
	if turn == nil {
		return
	}
	turn.answer <- rpcTurnAnswer{turn: TurnEnd{
		PromptSentAt: turn.promptSentAt,
		EndedAt:      time.Now().UnixMilli(),
	}}
}

// route reacts to one inbound frame.
func (c *PiRpcClient) route(frame Frame) {
	if response, ok := IsResponse(frame); ok {
		c.onResponse(response)
		return
	}
	switch frameString(frame, "type") {
	case "agent_settled":
		c.onSettled()
	case "extension_ui_request":
		if answer := unattendedReply(frame); answer != nil {
			c.send(answer)
		}
	}
}

// dispatch decodes one stdout line, logs it and routes its frame.
func (c *PiRpcClient) dispatch(decoded Decoded, line string) {
	switch decoded.Kind {
	case DecodedFrame:
		c.logs.Inbound(shared.LogText(decoded.Frame, decoded.Text))
		c.queue.Push(decoded.Frame)
		c.route(decoded.Frame)
	case DecodedMalformed:
		// Stray output: logged as sent and skipped.
		c.logs.Inbound(line)
	}
}

// unavailable is what a command answers once no more can be sent: the terminal failure when there
// is one, else that stdin is closed. Called under c.mu.
func (c *PiRpcClient) unavailable() *RpcError {
	if c.terminal != nil {
		return c.terminal
	}
	return &RpcError{
		Kind:    RpcErrorClosed,
		Message: "pi's stdin is closed; no further commands can be sent",
	}
}

// abandon is the kill a failed handshake owes: stdin closed, then the group signalled.
func (c *PiRpcClient) abandon() {
	c.mu.Lock()
	c.inputClosed = true
	c.mu.Unlock()
	c.proc.EndInput()
	c.proc.Signal(syscall.SIGKILL)
}

// describeExit is how the exited failure names the process's end.
func describeExit(exit process.ProcessExit) string {
	how := "signal " + exit.Signal
	if exit.Signal == "" && exit.Code != nil {
		how = fmt.Sprintf("exit code %d", *exit.Code)
	}
	tail := strings.TrimSpace(exit.StderrTail)
	if tail == "" {
		return fmt.Sprintf("pi ended (%s)", how)
	}
	return fmt.Sprintf("pi ended (%s): %s", how, tail)
}

// unattendedReply is the automatic answer to an extension_ui_request: RPC has no human UI.
// Confirmations are approved; choices needing input return cancellation to the extension.
func unattendedReply(frame Frame) json.RawMessage {
	id, ok := frameStringOk(frame, "id")
	if !ok {
		return nil
	}
	var out bytes.Buffer
	switch frameString(frame, "method") {
	case "confirm":
		out.WriteString(`{"type":"extension_ui_response","id":`)
		appendJSONString(&out, id)
		out.WriteString(`,"confirmed":true}`)
	case "select", "input", "editor":
		out.WriteString(`{"type":"extension_ui_response","id":`)
		appendJSONString(&out, id)
		out.WriteString(`,"cancelled":true}`)
	default:
		return nil
	}
	return json.RawMessage(out.Bytes())
}

// withID builds {"id":<id>,<command's members>}: the id the client assigns rides first.
func withID(id string, command json.RawMessage) json.RawMessage {
	if len(command) == 0 || command[0] != '{' {
		return command
	}
	var out bytes.Buffer
	out.WriteString(`{"id":`)
	appendJSONString(&out, id)
	out.WriteByte(',')
	out.Write(command[1:])
	return json.RawMessage(out.Bytes())
}

// promptCommand is {"type":"prompt","message":<message>}.
func promptCommand(message string) json.RawMessage {
	var out bytes.Buffer
	out.WriteString(`{"type":"prompt","message":`)
	appendJSONString(&out, message)
	out.WriteByte('}')
	return json.RawMessage(out.Bytes())
}

// appendJSONString writes text as a JSON string the way JSON.stringify does: no HTML escaping,
// the short escapes for \b \t \n \f \r, \u00xx for the other control characters, and every other
// byte as written.
func appendJSONString(out *bytes.Buffer, text string) {
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
