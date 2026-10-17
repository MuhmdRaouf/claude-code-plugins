// The omp RPC engine as a ports.Worker: one omp process per attempt, driven over its RPC
// protocol. The process plumbing lives in the client; this adapter owns the argv, the
// environment, the session key omp assigns, and the fold from frames to WorkerEvents. omp runs as
// the user set it up — its own login, provider, default model, extensions and rules; the adapter
// names no model and writes no config, and only narrows the tools to the job's access. omp has no
// native schema, so the report rides in the final assistant text and is checked here (and again by
// the core) before it is accepted.
package omprpc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/shared"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// ompRpcCaps is what the omp engine can do. Treat it as read-only: omp owns the session —
// get_state reports the id, --resume takes it back.
var ompRpcCaps = ports.WorkerCapabilities{
	WorkerTerms: domain.WorkerTerms{
		Efforts: []string{"low", "high", "max"},
		Budget:  false,
		BriefNotes: domain.BriefNotes{
			Effort:    "Passed to omp as --thinking (low, high or max).",
			AddDirs:   "Each additional directory is passed as its own --add-dir.",
			BudgetUSD: "omp has no budget control; a brief that sets a budget is refused before the run starts.",
			Readonly:  "omp has no readonly mode; the tool allowlist is narrowed to read,grep,glob instead.",
		},
	},
	Name:         ports.WorkerNameOmpRPC,
	SessionKey:   ports.SessionKeyEngine,
	NativeSchema: false,
}

// OmpRpcWorkerOptions is how the orchestrator wires the omp engine in.
type OmpRpcWorkerOptions struct {
	// Bin is the omp binary; "omp" from PATH when empty.
	Bin string
	// ParentEnv is the orchestrator's environment: the user's own, passed on so omp finds its own
	// setup.
	ParentEnv domain.EnvLookup
	// Withheld names what to keep from omp: the plugin's own provider variables (its key, its
	// `<PREFIX>_` knobs).
	Withheld func(name string) bool
	// StopGraceMs is between the RPC abort and SIGTERM, and between SIGTERM and SIGKILL.
	StopGraceMs int64
	// HandshakeTimeoutMs covers waiting for ready and every handshake response.
	HandshakeTimeoutMs int64
}

// OmpRpcWorker is the omp engine as a ports.Worker.
type OmpRpcWorker struct {
	options OmpRpcWorkerOptions
}

var _ ports.Worker = (*OmpRpcWorker)(nil)

// NewOmpRpcWorker wires the engine in.
func NewOmpRpcWorker(options OmpRpcWorkerOptions) *OmpRpcWorker {
	return &OmpRpcWorker{options: options}
}

// Caps is what the omp engine can do.
func (w *OmpRpcWorker) Caps() ports.WorkerCapabilities {
	return ompRpcCaps
}

// Preflight is cheap readiness; omp brings its own login, so there is nothing of the plugin's to
// check before it starts.
func (w *OmpRpcWorker) Preflight(ctx context.Context) error {
	return nil
}

// Dispose has nothing to release: one process per attempt.
func (w *OmpRpcWorker) Dispose(ctx context.Context) error {
	return nil
}

// ParseLine turns one line of an attempt log into its events (none for a line it cannot read).
func (w *OmpRpcWorker) ParseLine(line string) []domain.WorkerEvent {
	frame, reason := parseFrame(line)
	if reason != "" {
		return nil
	}
	return foldFrame(frame)
}

// Start runs one omp process: the handshake first, then the eager run whose frames are folded and
// queued from the moment it returns, whatever the caller does with them. The process group's
// leader is recorded beside the attempt log while it runs, so a stop or discard after the driver
// died can still terminate it.
func (w *OmpRpcWorker) Start(ctx context.Context, spec ports.WorkerSpec) (ports.WorkerRun, error) {
	timeoutMs := spec.TimeoutMs
	graceMs := w.options.StopGraceMs
	started, startErr := StartOmpRpc(ctx, OmpRpcOptions{
		Command:   ompBinary(w.options.Bin),
		Args:      buildOmpArgs(spec),
		Cwd:       spec.Cwd,
		Env:       envSlice(buildOmpEnv(spec, w.options)),
		TimeoutMs: &timeoutMs,
		GraceMs:   &graceMs,
		Log: &shared.RpcLogPaths{
			Stdout:    spec.LogPath,
			Stdin:     commandsLog(spec.LogPath),
			PromptRef: "job.json#prompt",
		},
	})
	if startErr != nil {
		return nil, &ports.WorkerError{Kind: ports.WorkerErrorSpawnFailed, Message: startErr.Message}
	}
	client := started
	_, err := client.Handshake(ctx, HandshakeOptions{
		EventFilter: workerEventFilter(),
		TimeoutMs:   w.options.HandshakeTimeoutMs,
		ExpectTools: toolsFor(spec.Access),
	})
	if err != nil {
		if failed := handshakeError(err); failed != nil {
			return nil, failed
		}
		// omp died before the handshake ran anything: no events, the exit carries the story.
		return finishedRun(client, spec), nil
	}
	return eagerRun(client, spec), nil
}

// ompBinary is the omp binary: the override when one is given, `omp` from PATH otherwise.
func ompBinary(bin string) string {
	if bin == "" {
		return "omp"
	}
	return bin
}

// toolsFor is the tools each access runs with; omp's `--tools` is a plain allowlist, so write also
// drops the approvals gate.
func toolsFor(access ports.Access) []string {
	switch access {
	case ports.AccessReadonly:
		return []string{"read", "grep", "glob"}
	case ports.AccessExec:
		return []string{"read", "grep", "glob", "bash"}
	default:
		return []string{"read", "grep", "glob", "edit", "write", "bash", "todo"}
	}
}

// buildOmpArgs is the run's argv; no --model: omp runs on whatever model its own setup defaults
// to.
func buildOmpArgs(spec ports.WorkerSpec) []string {
	args := []string{"--mode", "rpc", "--no-ui"}
	if spec.Effort != nil {
		args = append(args, "--thinking", *spec.Effort)
	}
	args = append(args,
		"--tools", strings.Join(toolsFor(spec.Access), ","),
		"--approval-mode", "yolo",
		"--no-title",
	)
	for _, dir := range spec.AddDirs {
		args = append(args, "--add-dir", dir)
	}
	if spec.Session.Kind == ports.SessionKindResume {
		args = append(args, "--resume", spec.Session.Key)
	}
	return args
}

// reservedName keeps a brief `env` name from re-routing omp's own setup or handing it a key.
func reservedName(name string) bool {
	return strings.HasPrefix(name, "PI_") || strings.HasPrefix(name, "OMP_") || strings.HasSuffix(name, "_API_KEY")
}

// buildOmpEnv is the user's own environment for omp, nothing of the plugin's provider added or
// kept.
func buildOmpEnv(spec ports.WorkerSpec, options OmpRpcWorkerOptions) map[string]string {
	return shared.ToolEnv(options.ParentEnv, spec.PassEnv, options.Withheld, reservedName)
}

// envSlice is the built environment as exec takes it, by name so a run is reproducible.
func envSlice(env map[string]string) []string {
	pairs := make([]string, 0, len(env))
	for _, name := range slices.Sorted(maps.Keys(env)) {
		pairs = append(pairs, name+"="+env[name])
	}
	return pairs
}

// commandsLog is the commands log, beside the frames log and named after it.
func commandsLog(logPath string) string {
	if strings.HasSuffix(logPath, ".jsonl") {
		return strings.TrimSuffix(logPath, ".jsonl") + ".rpc-in.jsonl"
	}
	return logPath
}

// workerEventFilter is the frames the fold reads; message updates as deltas, not full rewrites.
func workerEventFilter() EventFilter {
	return EventFilter{
		Events: []string{
			"message_update",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"auto_retry_start",
			"auto_retry_end",
			"retry_fallback_applied",
			"auto_compaction_start",
			"auto_compaction_end",
			"notice",
		},
		MessageUpdates: ptr("delta"),
	}
}

// sessionMissingRe matches what omp prints on stderr when --resume names a session it does not
// have.
var sessionMissingRe = regexp.MustCompile(`(?i)Session ".*" not found`)

// engineResultType is the synthetic log line appended after the run, which ParseLine folds back
// into the result event.
const engineResultType = "engine_result"

// httpStatusRe reads the status a retry's error message leads with: "429 High concurrency…" → 429;
// anything else (or nothing) is not an HTTP status.
var httpStatusRe = regexp.MustCompile(`^\d{3}`)

// foldFrame is one frame → its WorkerEvents; frame types the fold does not track fold to nothing,
// they stay in the raw log.
func foldFrame(frame Frame) []domain.WorkerEvent {
	switch frameType(frame) {
	case "response":
		return foldResponse(frame)
	case "message_update":
		return foldUpdate(frame)
	case "message_end":
		return foldMessageEnd(frame)
	case "tool_execution_start":
		return foldToolStart(frame)
	case "tool_execution_end":
		isError, _ := memberBool(frame, "isError")
		return []domain.WorkerEvent{{Kind: domain.WorkerEventToolResult, IsError: isError}}
	case "auto_retry_start":
		return foldRetry(frame)
	case "prompt_result":
		return foldPromptResult(frame)
	case engineResultType:
		return foldEngineResult(frame)
	default:
		return nil
	}
}

// foldResponse folds a response: the session id get_state reports, refusals as errors, quiet
// successes as nothing.
func foldResponse(frame Frame) []domain.WorkerEvent {
	response, ok := IsResponse(frame)
	if !ok {
		return nil
	}
	if !response.Success {
		message := fmt.Sprintf("omp refused %s", response.Command)
		if response.Error != nil {
			message = *response.Error
		}
		return []domain.WorkerEvent{{Kind: domain.WorkerEventError, Message: message}}
	}
	var data map[string]json.RawMessage
	_ = json.Unmarshal(response.Data, &data)
	sessionID, hasSession := memberString(data, "sessionId")
	if response.Command != "get_state" || !hasSession {
		return nil
	}
	return []domain.WorkerEvent{{Kind: domain.WorkerEventSession, SessionID: sessionID}}
}

// foldUpdate folds a message update: only string text deltas.
func foldUpdate(frame Frame) []domain.WorkerEvent {
	var event map[string]any
	_ = json.Unmarshal(frame["assistantMessageEvent"], &event)
	if kind, _ := shared.AsString(event["type"]); kind != "text_delta" {
		return nil
	}
	text, isText := shared.AsString(event["delta"])
	if !isText {
		return nil
	}
	return []domain.WorkerEvent{{Kind: domain.WorkerEventTextDelta, Text: text}}
}

// foldMessageEnd folds an assistant message end: its text, and an error event when omp ended the
// message in error.
func foldMessageEnd(frame Frame) []domain.WorkerEvent {
	var message map[string]any
	if json.Unmarshal(frame["message"], &message) != nil {
		return nil
	}
	if role, _ := shared.AsString(message["role"]); role != "assistant" {
		return nil
	}
	var events []domain.WorkerEvent
	if text := shared.TextOf(message["content"]); text != "" {
		events = append(events, domain.WorkerEvent{Kind: domain.WorkerEventAssistantText, Text: text})
	}
	if stop, _ := shared.AsString(message["stopReason"]); stop == "error" {
		reason, isReason := shared.AsString(message["errorMessage"])
		if !isReason {
			reason = "omp ended an assistant message in error"
		}
		events = append(events, domain.WorkerEvent{Kind: domain.WorkerEventError, Message: reason})
	}
	return events
}

// foldToolStart folds a tool start: a name, then a summary from args (the first string value, in
// the order the engine wrote them), the intent, or nothing.
func foldToolStart(frame Frame) []domain.WorkerEvent {
	name, hasName := memberString(frame, "toolName")
	if !hasName {
		return nil
	}
	summary, hasSummary := shared.FirstStringValue(frame["args"])
	if !hasSummary {
		summary, _ = memberString(frame, "intent")
	}
	return []domain.WorkerEvent{{Kind: domain.WorkerEventToolUse, Name: name, Summary: summary}}
}

// foldRetry folds a retry: a leading 3-digit status, and counts that may be missing.
func foldRetry(frame Frame) []domain.WorkerEvent {
	event := domain.WorkerEvent{
		Kind:       domain.WorkerEventAPIRetry,
		Attempt:    int64(memberAsCount(frame, "attempt")),
		MaxRetries: int64(memberAsCount(frame, "maxAttempts")),
	}
	if message, isMessage := memberString(frame, "errorMessage"); isMessage {
		if matched := httpStatusRe.FindString(message); matched != "" {
			if status, err := strconv.ParseInt(matched, 10, 64); err == nil {
				event.Status = &status
			}
		}
	}
	return []domain.WorkerEvent{event}
}

// foldPromptResult folds a prompt result: only errors, with their http status when given.
func foldPromptResult(frame Frame) []domain.WorkerEvent {
	result, ok := IsPromptResult(frame)
	if !ok || result.Status != "error" || result.Error == nil {
		return nil
	}
	return []domain.WorkerEvent{{
		Kind:    domain.WorkerEventError,
		Message: result.Error.Message,
		Status:  result.Error.HTTPStatus,
	}}
}

// foldEngineResult folds the appended engine_result line back into the result event, defaulting
// every missing field.
func foldEngineResult(frame Frame) []domain.WorkerEvent {
	var usage map[string]any
	_ = json.Unmarshal(frame["usage"], &usage)
	event := domain.WorkerEvent{
		Kind:             domain.WorkerEventResult,
		StructuredOutput: rawOrNull(frame["structuredOutput"]),
		Turns:            int64(memberAsCount(frame, "turns")),
		DurationMs:       int64(memberAsCount(frame, "durationMs")),
		CostUSD:          memberAsCount(frame, "costUsd"),
		Usage: domain.ResultUsage{
			InputTokens:      int64(shared.AsCount(usage["inputTokens"])),
			OutputTokens:     int64(shared.AsCount(usage["outputTokens"])),
			CacheReadTokens:  int64(shared.AsCount(usage["cacheReadTokens"])),
			CacheWriteTokens: int64(shared.AsCount(usage["cacheWriteTokens"])),
		},
	}
	event.IsError, _ = memberBool(frame, "isError")
	event.Text = memberText(frame, "text")
	event.APIErrorStatus = numberMember(frame["apiErrorStatus"])
	if model, isModel := memberString(frame, "model"); isModel {
		event.Model = &model
	}
	return []domain.WorkerEvent{event}
}

// memberAsCount reads a member as the JS number the engines send (a missing or mistyped field
// reads as 0, never fails).
func memberAsCount(frame Frame, key string) float64 {
	raw, ok := frame[key]
	if !ok || len(raw) == 0 {
		return 0
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return 0
	}
	return shared.AsCount(value)
}

// memberText reads a member as a string, "" for anything else.
func memberText(frame Frame, key string) string {
	text, _ := memberString(frame, key)
	return text
}

// numberMember reads a raw member as a number, nil for anything else.
func numberMember(raw json.RawMessage) *int64 {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	number, ok := value.(float64)
	if !ok {
		return nil
	}
	status := int64(number)
	return &status
}

// rawOrNull is a member's raw JSON, with absent and null both reading as no value.
func rawOrNull(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil
	}
	return raw
}

// handshakeError is the handshake's RpcError in the port's terms; exited is not a WorkerError (the
// run finished without starting).
func handshakeError(err *RpcError) *ports.WorkerError {
	switch err.Kind {
	case RpcErrorStart:
		return &ports.WorkerError{Kind: ports.WorkerErrorSpawnFailed, Message: err.Message}
	case RpcErrorProtocol, RpcErrorRejected, RpcErrorTimeout, RpcErrorClosed:
		return &ports.WorkerError{Kind: ports.WorkerErrorProtocol, Message: err.Message}
	default:
		return nil
	}
}

// workerExit maps the process exit onto the run's end; a resume the engine does not know is
// flagged for the core to start a new session.
func workerExit(ended process.ProcessExit, spec ports.WorkerSpec) ports.WorkerExit {
	exit := ports.WorkerExit{StderrTail: ended.StderrTail}
	if ended.Code != nil {
		code := int64(*ended.Code)
		exit.Code = &code
	}
	if ended.Signal != "" {
		exit.Signal = &ended.Signal
	}
	if ended.Forced != "" {
		forced := domain.ForcedEnd(ended.Forced)
		exit.Forced = &forced
	}
	exit.SessionMissing = spec.Session.Kind == ports.SessionKindResume && sessionMissingRe.MatchString(ended.StderrTail)
	return exit
}

// turnTally sums over the assistant messages the run has folded so far; the driver reads it once
// the turns are over. Only the run's own goroutine touches it.
type turnTally struct {
	// finalText is the text of the last assistant message_end (where the report rides).
	finalText string
	// lastStopReason is how the last assistant message ended.
	lastStopReason string
	turns          int64
	// model is the id the tool stamped on its last assistant message, as the tool names it.
	model   *string
	usage   domain.ResultUsage
	costUSD float64
}

// tallyFrame folds one frame into the tally: every assistant message end.
func tallyFrame(tally *turnTally, frame Frame) {
	if frameType(frame) != "message_end" {
		return
	}
	var message map[string]any
	if json.Unmarshal(frame["message"], &message) != nil {
		return
	}
	if role, _ := shared.AsString(message["role"]); role != "assistant" {
		return
	}
	tally.turns++
	if model, ok := shared.ReportedModel(message); ok {
		tally.model = &model
	}
	tally.finalText = shared.TextOf(message["content"])
	stop, _ := shared.AsString(message["stopReason"])
	tally.lastStopReason = stop
	usage := shared.AsRecord(message["usage"])
	tally.usage.InputTokens += int64(shared.AsCount(usage["input"]))
	tally.usage.OutputTokens += int64(shared.AsCount(usage["output"]))
	tally.usage.CacheReadTokens += int64(shared.AsCount(usage["cacheRead"]))
	tally.usage.CacheWriteTokens += int64(shared.AsCount(usage["cacheWrite"]))
	tally.costUSD += shared.AsCount(shared.AsRecord(usage["cost"])["total"])
}

// ompTurn is one omp turn as the report-turn loop sees it.
type ompTurn struct {
	end TurnEnd
}

func (t ompTurn) PromptSentAt() int64 { return t.end.PromptSentAtMs }
func (t ompTurn) EndedAt() int64      { return t.end.EndedAtMs }

// turnOutcome is one prompt's answer from the client.
type turnOutcome struct {
	end TurnEnd
	err *RpcError
}

// settlerGrace bounds the wait for a settling frame's answer: the client settles the turn as it
// routes that very frame, so the answer follows within its dispatch; a settler that is not ours
// (a prompt_result still awaiting session_settled) lets the timer pass and the next settler retry.
const settlerGrace = 200 * time.Millisecond

// ompRun is the eager run: frames are folded and queued from the moment Start returns, whatever
// the caller does with them.
type ompRun struct {
	pid    int64
	client *OmpRpcClient
	spec   ports.WorkerSpec
	events *process.Queue[domain.WorkerEvent]
	tally  turnTally

	done chan struct{}
	exit ports.WorkerExit
}

var (
	_ ports.WorkerRun            = (*ompRun)(nil)
	_ shared.TurnDriver[ompTurn] = (*ompRun)(nil)
)

// Pid is the engine process group's leader.
func (r *ompRun) Pid() int64 { return r.pid }

// Events yields the run's events in order and closes once its output ends.
func (r *ompRun) Events() <-chan domain.WorkerEvent {
	return r.events.Items()
}

// Wait blocks until the worker process has exited and the pid record beside the attempt log is
// cleared, and returns how it ended.
func (r *ompRun) Wait() ports.WorkerExit {
	<-r.done
	return r.exit
}

// Interrupt stops the run: the RPC abort and stdin close first (the soft stop), then omp's process
// group.
func (r *ompRun) Interrupt(ctx context.Context, reason ports.InterruptReason) error {
	r.client.Interrupt(process.ForcedReason(reason))
	return nil
}

// Prompt sends one prompt and waits for its turn. ctx is not consulted: the turn's end is bounded
// by the process's own wall clock. Frames are folded while the turn runs; after a frame that can
// settle a turn, the answer is awaited before anything else happens, so the turn's last assistant
// message is in the tally before the report turns read it.
func (r *ompRun) Prompt(ctx context.Context, text string) (ompTurn, bool) {
	answer := make(chan turnOutcome, 1)
	go func() {
		end, err := r.client.Prompt(text)
		answer <- turnOutcome{end: end, err: err}
	}()
	frames := r.client.Frames()
	for {
		frame, open := <-frames
		if !open {
			// The stream ended; the client fails every pending turn, so the answer comes.
			outcome := <-answer
			return ompTurn{end: outcome.end}, outcome.err == nil
		}
		r.processFrame(frame)
		if !settlesTurn(frame) {
			continue
		}
		timer := time.NewTimer(settlerGrace)
		select {
		case outcome := <-answer:
			timer.Stop()
			return ompTurn{end: outcome.end}, outcome.err == nil
		case <-timer.C:
		}
	}
}

// FinalText is the text of the last assistant message so far.
func (r *ompRun) FinalText() string {
	return r.tally.finalText
}

// Failed says a turn ended in a way no correction can fix: a turn omp ended in error has nothing
// to correct.
func (r *ompRun) Failed(turn ompTurn) bool {
	return turn.end.Result.Status != "completed"
}

// processFrame folds one frame: first the tally, then the events it becomes.
func (r *ompRun) processFrame(frame Frame) {
	tallyFrame(&r.tally, frame)
	for _, event := range foldFrame(frame) {
		r.events.Push(event)
	}
}

// settlesTurn says whether a frame can settle the turn omp's client is waiting on: prompt_result
// always reaches it, session_settled finishes one that prompt_result left unsettled.
func settlesTurn(frame Frame) bool {
	kind := frameType(frame)
	return kind == "prompt_result" || kind == "session_settled"
}

// newOmpRun records the run's group leader beside the attempt log and clears the record once the
// process has exited.
func newOmpRun(client *OmpRpcClient, spec ports.WorkerSpec) *ompRun {
	run := &ompRun{
		pid:    client.Pid,
		client: client,
		spec:   spec,
		events: process.CreateQueue[domain.WorkerEvent](),
		done:   make(chan struct{}),
	}
	adapters.WriteEnginePid(domain.EnginePidBeside(spec.LogPath), client.Pid)
	go func() {
		run.exit = workerExit(client.Exit(), spec)
		adapters.ClearEnginePid(domain.EnginePidBeside(spec.LogPath))
		close(run.done)
	}()
	return run
}

// eagerRun drives the run to its end: the report turns, then stdin closed so omp drains and exits,
// then every remaining frame folded, and only then the synthesized result, as the last event and
// as one synthetic line in the log.
func eagerRun(client *OmpRpcClient, spec ports.WorkerSpec) *ompRun {
	run := newOmpRun(client, spec)
	go func() {
		defer run.events.Close()
		span, ok := shared.RunReportTurns[ompTurn](context.Background(), run, spec.Prompt, spec.Report)
		_ = client.Close()
		for frame := range client.Frames() {
			run.processFrame(frame)
		}
		if !ok {
			return
		}
		result := synthesizeResult(span, &run.tally)
		run.events.Push(result)
		appendEngineResult(spec.LogPath, result)
	}()
	return run
}

// finishedRun is an omp that died before the handshake ran anything: no events, the exit carries
// the whole story.
func finishedRun(client *OmpRpcClient, spec ports.WorkerSpec) *ompRun {
	run := newOmpRun(client, spec)
	run.events.Close()
	// The client's frame stream must always be drained; the events queue is closed, so the folds
	// go nowhere.
	go func() {
		for frame := range client.Frames() {
			for _, event := range foldFrame(frame) {
				run.events.Push(event)
			}
		}
	}()
	return run
}

// synthesizeResult is the run's result event: the failed turn's own error stands, a completed turn
// that never reached a stop reason says so, and the final text and its extracted report otherwise.
func synthesizeResult(span shared.ReportTurns[ompTurn], tally *turnTally) domain.WorkerEvent {
	failure := promptFailure(span.Last.end.Result)
	unfinished := span.Last.end.Result.Status == "completed" && tally.lastStopReason != "stop"
	text := tally.finalText
	if failure != nil {
		text = failure.Message
	} else if unfinished {
		text = fmt.Sprintf("worker stopped without finishing (stopReason %s)", tally.lastStopReason)
	}
	var apiStatus *int64
	if failure != nil {
		apiStatus = failure.HTTPStatus
	}
	return domain.WorkerEvent{
		Kind:    domain.WorkerEventResult,
		IsError: failure != nil || unfinished,
		Text:    text,
		// Raw bytes: the key order the worker wrote survives, as JSON.stringify kept it.
		StructuredOutput: span.Value,
		Turns:            tally.turns,
		DurationMs:       span.EndedAt - span.StartedAt,
		CostUSD:          tally.costUSD,
		Usage:            tally.usage,
		APIErrorStatus:   apiStatus,
		Model:            tally.model,
	}
}

// promptFailure is why a prompt failed; an error with no message still says it ended in error.
func promptFailure(result PromptResult) *PromptError {
	if result.Status != "error" {
		return nil
	}
	if result.Error != nil {
		return result.Error
	}
	return &PromptError{Message: "omp ended the turn in error without saying why"}
}

// appendEngineResult appends the result event to the attempt log as its last line, with the
// synthetic type ParseLine folds back into the event. The frames log is closed by then, so the
// line opens the file again to append.
func appendEngineResult(logPath string, result domain.WorkerEvent) {
	line, err := engineResultLine(result)
	if err != nil {
		return
	}
	file, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.WriteString(line + "\n")
}

// engineResultLine is the result event as the log's last line, with the synthetic engine_result
// type and the members in the order the event itself writes them.
func engineResultLine(result domain.WorkerEvent) (string, error) {
	line := struct {
		Kind             domain.WorkerEventKind `json:"type"`
		IsError          bool                   `json:"isError"`
		Text             string                 `json:"text"`
		StructuredOutput json.RawMessage        `json:"structuredOutput"`
		Turns            int64                  `json:"turns"`
		DurationMs       int64                  `json:"durationMs"`
		CostUSD          float64                `json:"costUsd"`
		Usage            domain.ResultUsage     `json:"usage"`
		APIErrorStatus   *int64                 `json:"apiErrorStatus"`
		Model            *string                `json:"model,omitempty"`
	}{
		Kind:             engineResultType,
		IsError:          result.IsError,
		Text:             result.Text,
		StructuredOutput: result.StructuredOutput,
		Turns:            result.Turns,
		DurationMs:       result.DurationMs,
		CostUSD:          result.CostUSD,
		Usage:            result.Usage,
		APIErrorStatus:   result.APIErrorStatus,
		Model:            result.Model,
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(line); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}
