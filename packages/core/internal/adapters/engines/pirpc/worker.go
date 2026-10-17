package pirpc

// The pi RPC engine as a Worker: one pi process per attempt, driven over its RPC protocol (pi
// 1.0.4). The process plumbing lives in the client; this adapter owns the argv, the environment,
// the session key the caller assigns, and the fold from frames to worker events. pi runs as the
// user set it up — its own login, provider, default model, extensions, skills and context files;
// the adapter names no model and writes no config, and only narrows the tools of a readonly job.
// pi has no native schema, so the report rides in the final assistant text and is checked here
// (and again by the core) before it is accepted.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/shared"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// engineResultFrame is the synthetic frame type appended to the log after the run, which ParseLine
// folds back into the result event.
const engineResultFrame = "engine_result"

// httpStatus reads a provider failure's leading HTTP status ("429 High concurrency…" → 429);
// anything else (or nothing) is not a status.
var httpStatus = regexp.MustCompile(`^\d{3}`)

// piRpcCaps is what the pi RPC engine can do.
var piRpcCaps = ports.WorkerCapabilities{
	WorkerTerms: domain.WorkerTerms{
		Efforts: []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"},
		BriefNotes: domain.BriefNotes{
			Effort:    "Passed to pi as --thinking (off, minimal, low, medium, high, xhigh or max).",
			AddDirs:   "pi has no extra mounts; directories beyond the job's own are not passed on.",
			BudgetUSD: "pi has no budget control; a brief that sets a budget is refused before the run starts.",
			Readonly:  "pi has no readonly mode; the tool allowlist is narrowed to read,grep,find,ls instead.",
		},
	},
	// The caller owns the session: its key is passed as --session-id, which pi creates when missing.
	Name:         ports.WorkerNamePiRPC,
	SessionKey:   ports.SessionKeyCaller,
	NativeSchema: false,
}

// PiRpcWorkerOptions shapes the worker.
type PiRpcWorkerOptions struct {
	// Bin is the pi binary; "pi" from PATH when empty.
	Bin string
	// ParentEnv is the orchestrator's environment: the user's own, passed on so pi finds its own
	// setup.
	ParentEnv domain.EnvLookup
	// Withheld names what stays pi's own to find: the plugin's provider variables (its key, its
	// `<PREFIX>_` knobs).
	Withheld func(name string) bool
	// StopGraceMs is between the RPC abort and SIGTERM, and between SIGTERM and SIGKILL.
	StopGraceMs int64
	// HandshakeTimeoutMs covers waiting for the get_state answer.
	HandshakeTimeoutMs int64
}

// PiRpcWorker is the pi RPC engine as a ports.Worker.
type PiRpcWorker struct {
	options PiRpcWorkerOptions
}

var _ ports.Worker = (*PiRpcWorker)(nil)

// NewPiRpcWorker builds the worker from its options.
func NewPiRpcWorker(options PiRpcWorkerOptions) *PiRpcWorker {
	return &PiRpcWorker{options: options}
}

// Caps is what the pi RPC engine can do.
func (w *PiRpcWorker) Caps() ports.WorkerCapabilities {
	return piRpcCaps
}

// ParseLine turns one line of an attempt log into its events (none for a line it cannot read);
// folds logs for show and the board.
func (w *PiRpcWorker) ParseLine(line string) []domain.WorkerEvent {
	frame, _ := parseFrame(line)
	if frame == nil {
		return nil
	}
	return foldFrame(frame)
}

// Preflight is cheap, offline readiness. pi brings its own login; there is nothing of the plugin's
// to check before it starts.
func (w *PiRpcWorker) Preflight(ctx context.Context) error {
	return nil
}

// Start runs one pi process for the attempt: spawn, handshake, then the eager run whose events are
// folded from the moment Start returns, whatever the caller does with them. The process group's
// leader is recorded beside the attempt log while it runs, so a stop or discard after the driver
// died can still terminate it.
func (w *PiRpcWorker) Start(ctx context.Context, spec ports.WorkerSpec) (ports.WorkerRun, error) {
	command := w.options.Bin
	if command == "" {
		command = "pi"
	}
	timeoutMs := spec.TimeoutMs
	graceMs := w.options.StopGraceMs
	client, err := StartPiRpc(ctx, PiRpcOptions{
		PiCommand: PiCommand{
			Command:   command,
			Args:      buildPiArgs(spec),
			Cwd:       spec.Cwd,
			Env:       envList(buildPiEnv(spec, w.options)),
			TimeoutMs: &timeoutMs,
			GraceMs:   &graceMs,
		},
		Log: &shared.RpcLogPaths{
			Stdout:    spec.LogPath,
			Stdin:     commandsLog(spec.LogPath),
			PromptRef: "job.json#prompt",
		},
	})
	if err != nil {
		return nil, &ports.WorkerError{Kind: ports.WorkerErrorSpawnFailed, Message: err.Message}
	}
	adapters.WriteEnginePid(domain.EnginePidBeside(spec.LogPath), client.Pid)
	if _, shakeErr := client.Handshake(HandshakeOptions{TimeoutMs: w.options.HandshakeTimeoutMs}); shakeErr == nil {
		return drive(ctx, client, spec), nil
	} else if failed := handshakeError(shakeErr); failed != nil {
		// The handshake killed pi; the run this pid record was for never happened.
		adapters.ClearEnginePid(domain.EnginePidBeside(spec.LogPath))
		return nil, failed
	}
	return finishedRun(client, spec.LogPath), nil
}

// Dispose releases long-lived processes once the driver is done; the pi worker starts one process
// per attempt, so there is nothing to release.
func (w *PiRpcWorker) Dispose(ctx context.Context) error {
	return nil
}

// handshakeError is the handshake's RpcError in the port's terms.
func handshakeError(err *RpcError) *ports.WorkerError {
	switch err.Kind {
	case RpcErrorStart:
		return &ports.WorkerError{Kind: ports.WorkerErrorSpawnFailed, Message: err.Message}
	case RpcErrorProtocol, RpcErrorRejected, RpcErrorTimeout, RpcErrorClosed:
		return &ports.WorkerError{Kind: ports.WorkerErrorProtocol, Message: err.Message}
	}
	// exited is not a WorkerError: the run finished without starting.
	return nil
}

// readonlyTools are pi's built-in read tools; exec adds bash, while write keeps the configured
// tools.
func readonlyTools() []string {
	return []string{"read", "grep", "find", "ls"}
}

// buildPiArgs is pi's command line. No --model: pi runs on whatever model its own setup defaults
// to.
func buildPiArgs(spec ports.WorkerSpec) []string {
	args := []string{"--mode", "rpc"}
	if spec.Effort != nil {
		args = append(args, "--thinking", *spec.Effort)
	}
	if spec.Access != ports.AccessWrite {
		tools := readonlyTools()
		if spec.Access == ports.AccessExec {
			tools = append(tools, "bash")
		}
		args = append(args, "--tools", strings.Join(tools, ","), "--no-mcp")
	}
	args = append(args, "--session-id", spec.Session.Key)
	return args
}

// reservedName keeps a brief `env` name from re-routing pi's own setup or handing it a key.
func reservedName(name string) bool {
	return strings.HasPrefix(name, "PI_") || strings.HasSuffix(name, "_API_KEY")
}

// buildPiEnv is the user's own environment for pi, nothing of the plugin's provider added or kept.
func buildPiEnv(spec ports.WorkerSpec, options PiRpcWorkerOptions) map[string]string {
	return shared.ToolEnv(options.ParentEnv, spec.PassEnv, options.Withheld, reservedName)
}

// envList is the environment map as the process layer takes it, in a deterministic order.
func envList(env map[string]string) []string {
	names := make([]string, 0, len(env))
	for name := range env {
		names = append(names, name)
	}
	sort.Strings(names)
	list := make([]string, 0, len(env))
	for _, name := range names {
		list = append(list, name+"="+env[name])
	}
	return list
}

// commandsLog is the commands log's path, beside the frames log and named after it.
func commandsLog(logPath string) string {
	if strings.HasSuffix(logPath, ".jsonl") {
		return logPath[:len(logPath)-len(".jsonl")] + ".rpc-in.jsonl"
	}
	return logPath
}

// piRun is one started pi: its events, how it ended, and how to stop it early.
type piRun struct {
	client *PiRpcClient
	events <-chan domain.WorkerEvent
	exit   ports.WorkerExit
	done   chan struct{}
}

var _ ports.WorkerRun = (*piRun)(nil)

// Events yields the run's events in order and closes when its output ends.
func (r *piRun) Events() <-chan domain.WorkerEvent {
	return r.events
}

// Wait blocks until the worker process has exited — after Events is closed, the engine_result
// line appended and the pid record cleared — and returns how it ended.
func (r *piRun) Wait() ports.WorkerExit {
	<-r.done
	return r.exit
}

// Interrupt asks pi to stop (its own RPC abort), then kills its process group; Wait then reports
// the forced reason.
func (r *piRun) Interrupt(ctx context.Context, reason ports.InterruptReason) error {
	r.client.Interrupt(ctx, forcedReason(reason))
	return nil
}

// forcedReason is the port's interrupt reason in the process layer's terms.
func forcedReason(reason ports.InterruptReason) process.ForcedReason {
	if reason == ports.InterruptTimeout {
		return process.ForcedTimeout
	}
	return process.ForcedStopped
}

// workerExit is the process layer's exit in the port's terms. pi creates the session id it is
// handed, so a resume never finds nothing.
func workerExit(ended process.ProcessExit) ports.WorkerExit {
	var code *int64
	if ended.Code != nil {
		value := int64(*ended.Code)
		code = &value
	}
	var signal *string
	if ended.Signal != "" {
		signal = &ended.Signal
	}
	var forced *domain.ForcedEnd
	if ended.Forced != "" {
		value := domain.ForcedEnd(ended.Forced)
		forced = &value
	}
	return ports.WorkerExit{
		Code:       code,
		Signal:     signal,
		StderrTail: ended.StderrTail,
		Forced:     forced,
	}
}

// foldFrame is the fold from one frame to worker events: the frames the core tracks, nothing for
// the ones it does not know.
func foldFrame(frame Frame) []domain.WorkerEvent {
	switch frameString(frame, "type") {
	case "response":
		return foldResponse(frame)
	case "message_update":
		return foldUpdate(frame)
	case "message_end":
		return foldMessageEnd(frame)
	case "tool_execution_start":
		return foldToolStart(frame)
	case "tool_execution_end":
		return []domain.WorkerEvent{{
			Kind:    domain.WorkerEventToolResult,
			IsError: isFrameTrue(frame, "isError"),
		}}
	case "auto_retry_start":
		return foldRetry(frame)
	case engineResultFrame:
		return foldEngineResult(frame)
	default:
		return nil
	}
}

// foldResponse folds a response envelope: the get_state session, refusals as errors, quiet
// successes as nothing.
func foldResponse(frame Frame) []domain.WorkerEvent {
	response, ok := IsResponse(frame)
	if !ok {
		return nil
	}
	if !response.Success {
		message := response.Error
		if message == "" {
			message = "pi refused " + response.Command
		}
		return []domain.WorkerEvent{{Kind: domain.WorkerEventError, Message: message}}
	}
	if response.Command != "get_state" {
		return nil
	}
	if sessionID, ok := frameStringOk(response.Data, "sessionId"); ok {
		return []domain.WorkerEvent{{Kind: domain.WorkerEventSession, SessionID: sessionID}}
	}
	return nil
}

// foldUpdate folds a message update: only string text deltas are progress.
func foldUpdate(frame Frame) []domain.WorkerEvent {
	update := shared.AsRecord(frameValue(frame, "assistantMessageEvent"))
	var events []domain.WorkerEvent
	if kind, _ := shared.AsString(update["type"]); kind == "text_delta" {
		if delta, isText := shared.AsString(update["delta"]); isText {
			events = append(events, domain.WorkerEvent{Kind: domain.WorkerEventTextDelta, Text: delta})
		}
	}
	return events
}

// foldMessageEnd folds an assistant message end: its text parts as one assistant_text, and an
// error stop as an error event.
func foldMessageEnd(frame Frame) []domain.WorkerEvent {
	message := shared.AsRecord(frameValue(frame, "message"))
	if role, _ := shared.AsString(message["role"]); role != "assistant" {
		return nil
	}
	var events []domain.WorkerEvent
	if text := shared.TextOf(message["content"]); text != "" {
		events = append(events, domain.WorkerEvent{Kind: domain.WorkerEventAssistantText, Text: text})
	}
	if stopReason, _ := shared.AsString(message["stopReason"]); stopReason == "error" {
		reason, isText := shared.AsString(message["errorMessage"])
		if !isText {
			reason = "pi ended an assistant message in error"
		}
		events = append(events, domain.WorkerEvent{Kind: domain.WorkerEventError, Message: reason})
	}
	return events
}

// foldToolStart folds a tool execution start: a name, then a summary from the first string
// argument or nothing.
func foldToolStart(frame Frame) []domain.WorkerEvent {
	name, ok := frameStringOk(frame, "toolName")
	if !ok {
		return nil
	}
	summary := ""
	if text, found := shared.FirstStringValue(frame["args"]); found {
		summary = text
	}
	return []domain.WorkerEvent{{Kind: domain.WorkerEventToolUse, Name: name, Summary: summary}}
}

// foldRetry folds an auto retry: a leading 3-digit status, and counts that may be missing.
func foldRetry(frame Frame) []domain.WorkerEvent {
	return []domain.WorkerEvent{{
		Kind:       domain.WorkerEventAPIRetry,
		Attempt:    int64(frameCount(frame, "attempt")),
		MaxRetries: int64(frameCount(frame, "maxAttempts")),
		Status:     leadingStatus(frameString(frame, "errorMessage")),
	}}
}

// foldEngineResult rebuilds the result event the run appended to its log, defaulting every field
// the line does not carry.
func foldEngineResult(frame Frame) []domain.WorkerEvent {
	usage := frameObject(frame, "usage")
	cacheWrite := frameCount(usage, "cacheWriteTokens")
	if raw, ok := usage["writeTokens"]; ok && !bytes.Equal(raw, []byte("null")) {
		cacheWrite = countValue(raw)
	}
	var model *string
	if reported, ok := frameStringOk(frame, "model"); ok {
		model = &reported
	}
	var output json.RawMessage
	if raw, ok := frame["structuredOutput"]; ok && !bytes.Equal(raw, []byte("null")) {
		output = raw
	}
	var apiStatus *int64
	if raw, ok := frame["apiErrorStatus"]; ok && !bytes.Equal(raw, []byte("null")) {
		var number float64
		if json.Unmarshal(raw, &number) == nil {
			value := int64(number)
			apiStatus = &value
		}
	}
	return []domain.WorkerEvent{{
		Kind:             domain.WorkerEventResult,
		IsError:          isFrameTrue(frame, "isError"),
		Text:             frameString(frame, "text"),
		StructuredOutput: output,
		Turns:            int64(frameCount(frame, "turns")),
		DurationMs:       int64(frameCount(frame, "durationMs")),
		CostUSD:          frameCount(frame, "costUsd"),
		Usage: domain.ResultUsage{
			InputTokens:      int64(frameCount(usage, "inputTokens")),
			OutputTokens:     int64(frameCount(usage, "outputTokens")),
			CacheReadTokens:  int64(frameCount(usage, "cacheReadTokens")),
			CacheWriteTokens: int64(cacheWrite),
		},
		APIErrorStatus: apiStatus,
		Model:          model,
	}}
}

// leadingStatus is the message's leading HTTP status as a number, nil when it has none. The
// pattern hands back three ASCII digits at most, so the parse cannot fail.
func leadingStatus(message string) *int64 {
	match := httpStatus.FindString(message)
	if match == "" {
		return nil
	}
	status, _ := strconv.ParseInt(match, 10, 64)
	return &status
}

// frameValue is a frame member decoded as a JSON value, nil when missing or malformed.
func frameValue(frame Frame, key string) any {
	if raw, ok := frame[key]; ok {
		var value any
		if json.Unmarshal(raw, &value) == nil {
			return value
		}
	}
	return nil
}

// isFrameTrue reads a frame member as the boolean true, the only truthy shape it accepts.
func isFrameTrue(frame Frame, key string) bool {
	value, ok := frameBool(frame, key)
	return ok && value
}

// frameCount is a frame member as a finite count, 0 for anything else.
func frameCount(frame map[string]json.RawMessage, key string) float64 {
	if raw, ok := frame[key]; ok {
		return countValue(raw)
	}
	return 0
}

// countValue is raw JSON as a finite count, 0 for anything else.
func countValue(raw json.RawMessage) float64 {
	if len(raw) == 0 {
		return 0
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return 0
	}
	return shared.AsCount(value)
}

// piTurn is the client's TurnEnd as the report-turn loop's Turn.
type piTurn struct {
	turn TurnEnd
}

func (t piTurn) PromptSentAt() int64 { return t.turn.PromptSentAt }
func (t piTurn) EndedAt() int64      { return t.turn.EndedAt }

// tallyTokens is the usage counts a message carries.
type tallyTokens struct {
	input      float64
	output     float64
	cacheRead  float64
	cacheWrite float64
}

// tallyPending is the usage of the message still streaming: pi reports its usage cumulatively on
// every message_update.
type tallyPending struct {
	tokens  tallyTokens
	costUSD float64
}

// turnTally sums over the assistant messages the run has folded so far; the driver reads it once
// the turns are over. The fold goroutine writes it and the report-turn loop reads it, so every
// access takes the lock.
type turnTally struct {
	mu sync.Mutex
	// finalText is the text of the last assistant message_end (where the report rides).
	finalText      string
	lastStopReason string
	// lastError is the last assistant errorMessage, when a message ended in error.
	lastError string
	turns     int64
	// model is the model the tool stamped on its last assistant message.
	model   *string
	usage   tallyTokens
	costUSD float64
	pending tallyPending
}

// apply is the tally's half of one frame.
func (t *turnTally) apply(frame Frame) {
	switch frameString(frame, "type") {
	case "message_update":
		usage := shared.AsRecord(frameValue(frame, "usage"))
		t.mu.Lock()
		defer t.mu.Unlock()
		t.pending.tokens.input = shared.AsCount(usage["input"])
		t.pending.tokens.output = shared.AsCount(usage["output"])
		t.pending.tokens.cacheRead = shared.AsCount(usage["cacheRead"])
		t.pending.tokens.cacheWrite = shared.AsCount(usage["cacheWrite"])
		t.pending.costUSD = shared.AsCount(shared.AsRecord(usage["cost"])["total"])
	case "message_end":
		message := shared.AsRecord(frameValue(frame, "message"))
		if role, _ := shared.AsString(message["role"]); role != "assistant" {
			return
		}
		stopReason, _ := shared.AsString(message["stopReason"])
		t.mu.Lock()
		defer t.mu.Unlock()
		t.turns++
		if model, ok := shared.ReportedModel(message); ok {
			t.model = &model
		}
		t.finalText = shared.TextOf(message["content"])
		t.lastStopReason = stopReason
		if stopReason == "error" {
			reason, isText := shared.AsString(message["errorMessage"])
			if !isText {
				reason = "pi ended an assistant message in error"
			}
			t.lastError = reason
		}
		usage := shared.AsRecord(message["usage"])
		t.usage.input += pickValue(usage["input"], t.pending.tokens.input)
		t.usage.output += pickValue(usage["output"], t.pending.tokens.output)
		t.usage.cacheRead += pickValue(usage["cacheRead"], t.pending.tokens.cacheRead)
		t.usage.cacheWrite += pickValue(usage["cacheWrite"], t.pending.tokens.cacheWrite)
		t.costUSD += pickValue(shared.AsRecord(usage["cost"])["total"], t.pending.costUSD)
		t.pending = tallyPending{}
	}
}

// pickValue is the value when it is a finite number, else the fallback.
func pickValue(value any, fallback float64) float64 {
	if count, ok := value.(float64); ok && !math.IsInf(count, 0) && !math.IsNaN(count) {
		return count
	}
	return fallback
}

// tallyState is the tally as one immutable snapshot.
type tallyState struct {
	finalText      string
	lastStopReason string
	lastError      string
	turns          int64
	model          *string
	usage          tallyTokens
	costUSD        float64
}

// state is the tally under one lock.
func (t *turnTally) state() tallyState {
	t.mu.Lock()
	defer t.mu.Unlock()
	return tallyState{
		finalText:      t.finalText,
		lastStopReason: t.lastStopReason,
		lastError:      t.lastError,
		turns:          t.turns,
		model:          t.model,
		usage:          t.usage,
		costUSD:        t.costUSD,
	}
}

// finalTextOf is the final assistant text so far.
func (t *turnTally) finalTextOf() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.finalText
}

// failedStop says the last assistant message ended in an error no correction can fix.
func (t *turnTally) failedStop() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.lastStopReason == "error"
}

// recoverFinalText asks pi for the session's last assistant text when the final message ended with
// none: pi's last assistant message can end with no text parts although the session holds one; pi
// keeps the answer itself.
func (t *turnTally) recoverFinalText(client *PiRpcClient) {
	t.mu.Lock()
	stop := t.lastStopReason == "stop"
	empty := t.finalText == ""
	t.mu.Unlock()
	if !stop || !empty {
		return
	}
	text, err := client.LastAssistantText()
	if err != nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if text != "" {
		t.finalText = text
	}
}

// piTurnDriver drives the report turns over the client.
type piTurnDriver struct {
	client *PiRpcClient
	tally  *turnTally
	// settled is signalled once the fold has tallied a turn's agent_settled, its last frame; the
	// report-turn loop waits for it before it reads the tally, so the tally is complete when
	// read.
	settled chan struct{}
}

// Prompt sends one prompt and waits for its turn to end; ok is false when the turn failed (the
// exit tells the story).
func (d *piTurnDriver) Prompt(ctx context.Context, text string) (piTurn, bool) {
	turn, err := d.client.Prompt(text)
	if err != nil {
		return piTurn{}, false
	}
	<-d.settled
	d.tally.recoverFinalText(d.client)
	return piTurn{turn: turn}, true
}

// FinalText is the final assistant text so far.
func (d *piTurnDriver) FinalText() string {
	return d.tally.finalTextOf()
}

// Failed says a turn ended in a way no correction can fix: pi reports engine failures on the
// message stream, and there is nothing to correct after one.
func (d *piTurnDriver) Failed(turn piTurn) bool {
	return d.tally.failedStop()
}

// drive is the eager run: frames are folded and queued from the moment Start returns, whatever the
// caller does with them.
func drive(ctx context.Context, client *PiRpcClient, spec ports.WorkerSpec) ports.WorkerRun {
	events := process.CreateQueue[domain.WorkerEvent]()
	tally := &turnTally{}
	driver := &piTurnDriver{client: client, tally: tally, settled: make(chan struct{}, 2)}
	run := &piRun{client: client, events: events.Items(), done: make(chan struct{})}
	pumped := make(chan struct{})
	go func() {
		defer close(pumped)
		for frame := range client.Frames {
			tally.apply(frame)
			for _, event := range foldFrame(frame) {
				events.Push(event)
			}
			if frameString(frame, "type") == "agent_settled" {
				select {
				case driver.settled <- struct{}{}:
				default:
				}
			}
		}
	}()
	go driveRun(ctx, client, spec, events, tally, driver, run, pumped)
	return run
}

// driveRun drives the run to its end: the turns, then stdin closed so pi saves its session and
// exits, then every remaining frame folded (the exit resolves with the logs closed, and the pump
// ends with the frames), and only then the synthesized result, as the last event and as one
// synthetic line in the log. The events queue closes with the log, the exit lands and the pid
// record clears before Wait's waiters return.
func driveRun(
	ctx context.Context,
	client *PiRpcClient,
	spec ports.WorkerSpec,
	events *process.Queue[domain.WorkerEvent],
	tally *turnTally,
	driver *piTurnDriver,
	run *piRun,
	pumped <-chan struct{},
) {
	span, ran := shared.RunReportTurns[piTurn](ctx, driver, spec.Prompt, spec.Report)
	ended := client.Close()
	// The exit has arrived: the pid record's process is gone.
	adapters.ClearEnginePid(domain.EnginePidBeside(spec.LogPath))
	<-pumped
	if ran {
		result := synthesizeResult(span, tally)
		events.Push(result)
		appendEngineResult(spec.LogPath, result)
	}
	events.Close()
	run.exit = workerExit(ended)
	close(run.done)
}

// synthesizeResult is the run's result event: the report the turns produced, the usage they
// summed, and the engine's own failure when the last assistant message ended in one.
func synthesizeResult(span shared.ReportTurns[piTurn], tally *turnTally) domain.WorkerEvent {
	state := tally.state()
	errorStop := state.lastStopReason == "error"
	unfinished := !errorStop && state.lastStopReason != "stop"
	text := state.finalText
	var status *int64
	if errorStop {
		text = state.lastError
		status = leadingStatus(state.lastError)
	} else if unfinished {
		text = fmt.Sprintf("worker stopped without finishing (stopReason %s)", state.lastStopReason)
	}
	return domain.WorkerEvent{
		Kind:    domain.WorkerEventResult,
		IsError: errorStop || unfinished,
		Text:    text,
		// Raw bytes: the key order the worker wrote survives, as JSON.stringify kept it.
		StructuredOutput: span.Value,
		Turns:            state.turns,
		DurationMs:       span.EndedAt - span.StartedAt,
		CostUSD:          state.costUSD,
		Usage: domain.ResultUsage{
			InputTokens:      int64(state.usage.input),
			OutputTokens:     int64(state.usage.output),
			CacheReadTokens:  int64(state.usage.cacheRead),
			CacheWriteTokens: int64(state.usage.cacheWrite),
		},
		APIErrorStatus: status,
		Model:          state.model,
	}
}

// appendEngineResult appends the synthetic engine_result line to the attempt log, beside the
// frames it summarizes. The write is best effort: the event is already queued, and a log that
// cannot take one more line cannot be fixed here.
func appendEngineResult(logPath string, result domain.WorkerEvent) {
	marshalled, err := result.MarshalJSON()
	if err != nil {
		return
	}
	file, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.WriteString(engineResultLine(marshalled) + "\n")
}

// engineResultLine is the result event as a log line: the same members in the same order, with the
// synthetic engine_result type where the event's own result rode.
func engineResultLine(marshalled []byte) string {
	const prefix = `{"type":"result"`
	if bytes.HasPrefix(marshalled, []byte(prefix)) {
		return `{"type":"engine_result"` + string(marshalled[len(prefix):])
	}
	return string(marshalled)
}

// finishedRun is a pi that died before the handshake ran nothing: no events, the exit carries the
// whole story.
func finishedRun(client *PiRpcClient, logPath string) ports.WorkerRun {
	events := process.CreateQueue[domain.WorkerEvent]()
	events.Close()
	run := &piRun{client: client, events: events.Items(), done: make(chan struct{})}
	// The client's frame queue must always be drained; the events queue is closed, so the folds go
	// nowhere.
	go func() {
		for frame := range client.Frames {
			for _, event := range foldFrame(frame) {
				events.Push(event)
			}
		}
	}()
	go func() {
		ended := client.Wait()
		adapters.ClearEnginePid(domain.EnginePidBeside(logPath))
		run.exit = workerExit(ended)
		close(run.done)
	}()
	return run
}
