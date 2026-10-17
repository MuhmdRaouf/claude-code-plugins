// Package opencode is the opencode engine as a ports.Worker: one `opencode run --format json`
// per attempt, the prompt as its last argv and every event on stdout as one JSON object per line
// (shapes recorded from opencode 1.18.34). There is no RPC and no stdin: the process exits when
// the run ends, so the exit is the turn boundary and exiting without a finished step is a
// failure. opencode runs as the user set it up — its own login, provider, default model and
// config dirs; the adapter names no model, provider, endpoint or key. The one thing it adds is
// the job's access: OPENCODE_CONFIG_CONTENT carries only the edit and bash permissions, which
// opencode merges over the user's config. opencode leaves a server child behind, so the rest of
// its group is reaped once the run's own process has exited.
package opencode

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"regexp"
	"strings"
	"unicode"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/shared"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// opencodeCaps is what the opencode engine can do. Treat it as read-only: opencode owns the
// session — every event carries the id, `--session` takes it back.
var opencodeCaps = ports.WorkerCapabilities{
	WorkerTerms: domain.WorkerTerms{
		Efforts: []string{"low", "high", "max"},
		Budget:  false,
		BriefNotes: domain.BriefNotes{
			Effort:    "Passed to opencode as --variant (low, high or max).",
			AddDirs:   "opencode has no directory mounts; additional directories are ignored, the cwd is the workspace.",
			BudgetUSD: "opencode has no budget control; a brief that sets a budget is refused before the run starts.",
			Readonly:  "opencode's edit and bash permissions are denied, so the model is never offered those tools.",
		},
	},
	Name:         ports.WorkerNameOpencode,
	SessionKey:   ports.SessionKeyEngine,
	NativeSchema: false,
}

// OpenCodeOptions is how the orchestrator wires the opencode engine in.
type OpenCodeOptions struct {
	// Bin is the opencode binary; "opencode" from PATH when empty.
	Bin string
	// ParentEnv is the orchestrator's environment: the user's own, passed on so opencode finds
	// its own setup.
	ParentEnv domain.EnvLookup
	// Withheld names what to keep from opencode: the plugin's own provider variables (its key,
	// its `<PREFIX>_` knobs).
	Withheld func(name string) bool
	// StopGraceMs is between the soft stop failing and SIGTERM, and between SIGTERM and SIGKILL.
	StopGraceMs int64
}

// OpenCodeWorker is the opencode engine as a ports.Worker.
type OpenCodeWorker struct {
	options OpenCodeOptions
}

var _ ports.Worker = (*OpenCodeWorker)(nil)

// NewOpenCodeWorker wires the engine in.
func NewOpenCodeWorker(options OpenCodeOptions) *OpenCodeWorker {
	return &OpenCodeWorker{options: options}
}

// Caps is what the opencode engine can do.
func (w *OpenCodeWorker) Caps() ports.WorkerCapabilities {
	return opencodeCaps
}

// Preflight is cheap readiness; opencode brings its own login, so there is nothing of the
// plugin's to check before it starts.
func (w *OpenCodeWorker) Preflight(ctx context.Context) error {
	return nil
}

// Dispose releases long-lived processes; one `run` per attempt leaves nothing behind.
func (w *OpenCodeWorker) Dispose(ctx context.Context) error {
	return nil
}

// ParseLine turns one attempt-log line into its events: opencode's events are JSON objects, so
// anything else is not an event.
func (w *OpenCodeWorker) ParseLine(line string) []domain.WorkerEvent {
	event := shared.ParseJsonLine(line)
	if event == nil {
		return nil
	}
	return foldEvent(event, line)
}

// Start runs one `opencode run`: the process group's leader is recorded beside the attempt log
// while it runs, so a stop or discard after the driver died can still terminate it.
func (w *OpenCodeWorker) Start(ctx context.Context, spec ports.WorkerSpec) (ports.WorkerRun, error) {
	graceMs := w.options.StopGraceMs
	proc, err := process.StartStreaming(ctx, process.StreamCommand{
		Command:   openCodeBinary(w.options.Bin),
		Args:      buildOpenCodeArgs(spec),
		Cwd:       spec.Cwd,
		Env:       envSlice(buildOpenCodeEnv(spec, w.options)),
		TimeoutMs: &spec.TimeoutMs,
		GraceMs:   &graceMs,
		// opencode's happy runs print nothing on stderr; blank lines are terminal noise, not
		// trouble.
		IsBenignStderr: blankStderr,
		// opencode leaves its server child behind; the rest of the group is reaped once the
		// leader has exited.
		ReapGroupOnExit: true,
	}, nil)
	if err != nil {
		return nil, &ports.WorkerError{Kind: ports.WorkerErrorSpawnFailed, Message: err.Error()}
	}
	// The prompt rides in argv; stdin is closed at once so nothing can wait on it.
	proc.EndInput()
	adapters.WriteEnginePid(domain.EnginePidBeside(spec.LogPath), proc.Pid)
	return drive(proc, spec), nil
}

// openCodeBinary is the opencode binary: the override when one is given, `opencode` from PATH
// otherwise.
func openCodeBinary(bin string) string {
	if bin == "" {
		return "opencode"
	}
	return bin
}

// buildOpenCodeArgs is the run's argv; no model: opencode runs on whatever model its own setup
// defaults to.
func buildOpenCodeArgs(spec ports.WorkerSpec) []string {
	args := []string{"run", "--format", "json"}
	if spec.Effort != nil {
		args = append(args, "--variant", *spec.Effort)
	}
	// Denying a permission removes the tool entirely; `--auto` approves whatever the config
	// leaves open.
	args = append(args, "--auto")
	if spec.Session.Kind == ports.SessionKindResume {
		args = append(args, "--session", spec.Session.Key)
	}
	// Last: `run` takes the prompt as a free argument, so nothing that follows can be mistaken
	// for an option.
	return append(args, domain.ReportInstructions(spec.Prompt, spec.Report.JSONSchema))
}

// permissionConfig is the job's access in opencode's own terms; the keys sit in the order its
// config writes them.
type permissionConfig struct {
	Edit     string `json:"edit"`
	Bash     string `json:"bash"`
	Question string `json:"question"`
}

type accessConfig struct {
	Permission permissionConfig `json:"permission"`
}

// permissionsFor is the permission config per access: edit for changes, bash for running
// anything.
func permissionsFor(access ports.Access) permissionConfig {
	switch access {
	case ports.AccessReadonly:
		return permissionConfig{Edit: "deny", Bash: "deny", Question: "deny"}
	case ports.AccessExec:
		return permissionConfig{Edit: "deny", Bash: "allow", Question: "deny"}
	default:
		return permissionConfig{Edit: "allow", Bash: "allow", Question: "deny"}
	}
}

// configContent is the job's access, handed over as OPENCODE_CONFIG_CONTENT (merged over the
// user's own config): permissions only.
func configContent(spec ports.WorkerSpec) string {
	// A struct of three string fields always encodes; JSON.stringify never throws here either.
	raw, _ := json.Marshal(accessConfig{Permission: permissionsFor(spec.Access)})
	return string(raw)
}

// reservedName keeps a brief `env` name from re-routing opencode's own setup or handing it a key.
func reservedName(name string) bool {
	return strings.HasPrefix(name, "OPENCODE_") || strings.HasPrefix(name, "XDG_") || strings.HasSuffix(name, "_API_KEY")
}

// buildOpenCodeEnv is the user's own environment for opencode — its own config, data and state
// dirs — plus the job's permissions.
func buildOpenCodeEnv(spec ports.WorkerSpec, options OpenCodeOptions) map[string]string {
	env := shared.ToolEnv(options.ParentEnv, spec.PassEnv, options.Withheld, reservedName)
	env["OPENCODE_CONFIG_CONTENT"] = configContent(spec)
	return env
}

// envSlice is the built environment as exec takes it.
func envSlice(env map[string]string) []string {
	list := make([]string, 0, len(env))
	for name, value := range env {
		list = append(list, name+"="+value)
	}
	return list
}

// blankStderr names the stderr lines that carry nothing but whitespace (JS trim's set).
func blankStderr(line string) bool {
	return strings.TrimFunc(line, isJsSpace) == ""
}

func isJsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u2028', '\u2029', '\ufeff':
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

// sessionMissingRe matches what opencode says on stderr when `--session` names a session it does
// not have (ANSI colours around it).
var sessionMissingRe = regexp.MustCompile(`(?i)session not found`)

// engineResultType is the synthetic log line appended after the run, which ParseLine folds back
// into the result event.
const engineResultType = "engine_result"

// stampOf is opencode's stamp on an event, epoch milliseconds; anything else is not a time.
func stampOf(event map[string]any) (int64, bool) {
	stamp, ok := event["timestamp"].(float64)
	if !ok || math.IsInf(stamp, 0) || math.IsNaN(stamp) {
		return 0, false
	}
	return int64(stamp), true
}

// foldEvent is one stdout event → its WorkerEvents; types we do not track fold to nothing, they
// stay in the raw log. The line rides along for the fields whose bytes matter (a tool input's
// first key, a folded-back report), which a decoded Go map has no order for.
func foldEvent(event map[string]any, line string) []domain.WorkerEvent {
	kind, _ := shared.AsString(event["type"])
	switch kind {
	case "step_start":
		return sessionEvent(event)
	case "text":
		text, ok := shared.AsString(shared.AsRecord(event["part"])["text"])
		if !ok || text == "" {
			return nil
		}
		return []domain.WorkerEvent{{Kind: domain.WorkerEventAssistantText, Text: text}}
	case "tool_use":
		return foldToolUse(event, line)
	case "error":
		return []domain.WorkerEvent{{Kind: domain.WorkerEventError, Message: errorMessage(event)}}
	case engineResultType:
		return foldEngineResult(event, line)
	default:
		// step_finish is accounting the tally reads; reasoning and whatever else opencode adds
		// stays raw.
		return nil
	}
}

// sessionEvent folds step_start: the session id rides on every event, and step_start opens a
// step, so it is where the id is first heard.
func sessionEvent(event map[string]any) []domain.WorkerEvent {
	sessionID, ok := shared.AsString(event["sessionID"])
	if !ok {
		return nil
	}
	return []domain.WorkerEvent{{Kind: domain.WorkerEventSession, SessionID: sessionID}}
}

// foldToolUse folds a tool part, which carries its own outcome: the state's title or first input
// value says what the call was about.
func foldToolUse(event map[string]any, line string) []domain.WorkerEvent {
	part := shared.AsRecord(event["part"])
	name, ok := shared.AsString(part["tool"])
	if !ok {
		return nil
	}
	state := shared.AsRecord(part["state"])
	summary := ""
	if title, ok := shared.AsString(state["title"]); ok {
		summary = title
	} else if first, ok := shared.FirstStringValue(rawToolInput(line)); ok {
		summary = first
	}
	status, _ := shared.AsString(state["status"])
	if status != "completed" && status != "error" {
		return []domain.WorkerEvent{{Kind: domain.WorkerEventToolUse, Name: name, Summary: summary}}
	}
	return []domain.WorkerEvent{
		{Kind: domain.WorkerEventToolUse, Name: name, Summary: summary},
		{Kind: domain.WorkerEventToolResult, IsError: status == "error"},
	}
}

// rawToolInput is part.state.input as the raw JSON the engine wrote: the first string value
// keeps the engine's own key order, which a decoded Go map has none.
func rawToolInput(line string) json.RawMessage {
	var wire struct {
		Part struct {
			State struct {
				Input json.RawMessage `json:"input"`
			} `json:"state"`
		} `json:"part"`
	}
	if err := json.Unmarshal([]byte(line), &wire); err != nil {
		return nil
	}
	return wire.Part.State.Input
}

// errorMessage unwraps the reason nested under the error's data; its name is the fallback.
func errorMessage(event map[string]any) string {
	errRecord := shared.AsRecord(event["error"])
	if message, ok := shared.AsString(shared.AsRecord(errRecord["data"])["message"]); ok {
		return message
	}
	if name, ok := shared.AsString(errRecord["name"]); ok {
		return name
	}
	return "opencode reported an error"
}

// foldEngineResult folds the appended engine_result line back into the result event.
func foldEngineResult(event map[string]any, line string) []domain.WorkerEvent {
	usage := shared.AsRecord(event["usage"])
	return []domain.WorkerEvent{{
		Kind:             domain.WorkerEventResult,
		IsError:          event["isError"] == true,
		Text:             stringOrEmpty(event["text"]),
		StructuredOutput: rawStructuredOutput(line),
		Turns:            int64(shared.AsCount(event["turns"])),
		DurationMs:       int64(shared.AsCount(event["durationMs"])),
		CostUSD:          shared.AsCount(event["costUsd"]),
		Usage: domain.ResultUsage{
			InputTokens:      int64(shared.AsCount(usage["inputTokens"])),
			OutputTokens:     int64(shared.AsCount(usage["outputTokens"])),
			CacheReadTokens:  int64(shared.AsCount(usage["cacheReadTokens"])),
			CacheWriteTokens: int64(shared.AsCount(usage["cacheWriteTokens"])),
		},
		// opencode reports failures as events, not HTTP statuses.
		APIErrorStatus: apiErrorStatus(event["apiErrorStatus"]),
	}}
}

// rawStructuredOutput is the line's report as the raw JSON it rode in on; absent and null are
// both no report.
func rawStructuredOutput(line string) json.RawMessage {
	var wire struct {
		StructuredOutput json.RawMessage `json:"structuredOutput"`
	}
	// The line already parsed as JSON once (ParseLine read it), so this cannot fail.
	_ = json.Unmarshal([]byte(line), &wire)
	if bytes.Equal(wire.StructuredOutput, []byte("null")) {
		return nil
	}
	return wire.StructuredOutput
}

// apiErrorStatus is the wire's status only when it is a number.
func apiErrorStatus(value any) *int64 {
	number, ok := value.(float64)
	if !ok {
		return nil
	}
	status := int64(number)
	return &status
}

func stringOrEmpty(value any) string {
	text, _ := shared.AsString(value)
	return text
}

// workerExit maps the process exit onto the run's end; a resume the engine does not know is
// flagged for the core to start a new session.
func workerExit(ended process.ProcessExit, spec ports.WorkerSpec) ports.WorkerExit {
	exit := ports.WorkerExit{StderrTail: ended.StderrTail}
	if ended.Code != nil {
		exit.Code = new(int64)
		*exit.Code = int64(*ended.Code)
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

// usageCounts sums the token counts of the steps that finished; the engines send JS numbers, so
// the counts stay float64 until the result event carries them.
type usageCounts struct {
	input      float64
	output     float64
	cacheRead  float64
	cacheWrite float64
}

// runTally sums over the events the run has streamed so far; the driver reads it once the
// process has exited.
type runTally struct {
	// finalText is the text of the last text part (where the report rides).
	finalText string
	// errorText is the stream's own error message, when it reported one.
	errorText string
	errorSet  bool
	// finished says any step finished: opencode's own marker that the model was done.
	finished  bool
	turns     int64
	stamped   bool
	startedAt int64
	endedAt   int64
	usage     usageCounts
	costUsd   float64
}

// tallyEvent folds one wire event into the tally.
func tallyEvent(tally *runTally, event map[string]any) {
	if stamp, ok := stampOf(event); ok {
		if !tally.stamped {
			tally.startedAt = stamp
			tally.stamped = true
		}
		tally.endedAt = stamp
	}
	kind, _ := shared.AsString(event["type"])
	switch kind {
	case "text":
		if text, ok := shared.AsString(shared.AsRecord(event["part"])["text"]); ok && text != "" {
			tally.finalText = text
		}
	case "error":
		if !tally.errorSet {
			tally.errorText = errorMessage(event)
			tally.errorSet = true
		}
	case "step_finish":
		tally.finished = true
		tally.turns++
		part := shared.AsRecord(event["part"])
		tokens := shared.AsRecord(part["tokens"])
		cache := shared.AsRecord(tokens["cache"])
		tally.usage.input += shared.AsCount(tokens["input"])
		tally.usage.output += shared.AsCount(tokens["output"])
		tally.usage.cacheRead += shared.AsCount(cache["read"])
		tally.usage.cacheWrite += shared.AsCount(cache["write"])
		tally.costUsd += shared.AsCount(part["cost"])
	}
}

// openCodeRun is the eager run: lines are logged, tallied and folded from the moment Start
// returns, whatever the caller does.
type openCodeRun struct {
	proc   *process.StreamingProcess
	events *process.Queue[domain.WorkerEvent]
	exit   ports.WorkerExit
	done   chan struct{}
}

var _ ports.WorkerRun = (*openCodeRun)(nil)

// Events yields the run's events in order and closes once its output ends.
func (r *openCodeRun) Events() <-chan domain.WorkerEvent {
	return r.events.Items()
}

// Wait blocks until the worker process has exited — after Events is closed, the engine_result
// line appended and the pid record cleared — and returns how it ended.
func (r *openCodeRun) Wait() ports.WorkerExit {
	<-r.done
	return r.exit
}

// Interrupt stops the run: opencode has no stop request, so the group is terminated and the
// grace lets a tool's child die with it.
func (r *openCodeRun) Interrupt(ctx context.Context, reason ports.InterruptReason) error {
	r.proc.Interrupt(ctx, process.ForcedReason(reason))
	return nil
}

// drive starts the run's two pumps: the eager line reader (log, tally, fold) and the waiter that
// settles the run once the process has ended.
func drive(proc *process.StreamingProcess, spec ports.WorkerSpec) *openCodeRun {
	run := &openCodeRun{
		proc:   proc,
		events: process.CreateQueue[domain.WorkerEvent](),
		done:   make(chan struct{}),
	}
	tally := &runTally{}
	pumped := make(chan struct{})
	logFailed := false
	go func() {
		defer close(pumped)
		for line := range proc.Lines {
			if !appendLogLine(spec.LogPath, line) {
				logFailed = true
				return
			}
			event := shared.ParseJsonLine(line)
			if event == nil {
				continue
			}
			tallyEvent(tally, event)
			for _, folded := range foldEvent(event, line) {
				run.events.Push(folded)
			}
		}
	}()
	go func() {
		ended := <-proc.Exit
		run.exit = workerExit(ended, spec)
		adapters.ClearEnginePid(domain.EnginePidBeside(spec.LogPath))
		<-pumped
		// A forced exit ran nothing to completion, and a log that would not open reads nothing:
		// the events close with no result either way — the exit tells the story.
		if logFailed || ended.Forced != "" {
			run.events.Close()
			close(run.done)
			return
		}
		// A natural exit always gets a result: when no step ever finished one error event says
		// so, so the log and the events carry the whole story.
		if !tally.finished && !tally.errorSet {
			run.events.Push(domain.WorkerEvent{Kind: domain.WorkerEventError, Message: unfinishedMessage(ended)})
		}
		result := synthesizeResult(tally, ended)
		run.events.Push(result)
		if line, err := engineResultLine(result); err == nil {
			appendLogLine(spec.LogPath, line)
		}
		run.events.Close()
		close(run.done)
	}()
	return run
}

// appendLogLine appends one raw stdout line to the attempt log; false when the log cannot be
// written (the run then ends with what it already folded).
func appendLogLine(logPath, line string) bool {
	file, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	defer file.Close()
	_, err = file.WriteString(line + "\n")
	return err == nil
}

// engineResultLine is the result event as the log's last line, with the synthetic engine_result
// type ParseLine folds back into the event.
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
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(line); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}

// synthesizeResult is the run's result event: the stream's own error message stands when it
// reported one, the final text and its extracted report otherwise.
func synthesizeResult(tally *runTally, ended process.ProcessExit) domain.WorkerEvent {
	failure, failed := tally.errorText, tally.errorSet
	if !failed && !tally.finished {
		failure = unfinishedMessage(ended)
		failed = true
	}
	text := failure
	var structured json.RawMessage
	if !failed {
		text = tally.finalText
		// Raw bytes: the key order the worker wrote survives, as JSON.stringify kept it.
		structured = domain.ExtractReport(tally.finalText)
	}
	return domain.WorkerEvent{
		Kind:             domain.WorkerEventResult,
		IsError:          failed,
		Text:             text,
		StructuredOutput: structured,
		Turns:            tally.turns,
		DurationMs:       tallyDuration(tally),
		CostUSD:          tally.costUsd,
		Usage: domain.ResultUsage{
			InputTokens:      int64(tally.usage.input),
			OutputTokens:     int64(tally.usage.output),
			CacheReadTokens:  int64(tally.usage.cacheRead),
			CacheWriteTokens: int64(tally.usage.cacheWrite),
		},
		// opencode reports failures as events, not HTTP statuses; there is no status to pass on.
		APIErrorStatus: nil,
	}
}

// tallyDuration is the run's span over the stamps opencode put on its events.
func tallyDuration(tally *runTally) int64 {
	if !tally.stamped {
		return 0
	}
	return tally.endedAt - tally.startedAt
}

// unfinishedMessage says how a run ended without a finished step.
func unfinishedMessage(ended process.ProcessExit) string {
	if ended.Signal != "" {
		return fmt.Sprintf("opencode exited without a finished step (%s)", ended.Signal)
	}
	code := int64(-1)
	if ended.Code != nil {
		code = int64(*ended.Code)
	}
	return fmt.Sprintf("opencode exited without a finished step (exit %d)", code)
}
