// The ZCode desktop CLI as a ports.Worker: one zcode process per attempt, the brief attached as a
// file, the answer as one final JSON document on stdout (ZCode 0.16.1's shape, sometimes after SDK
// warning lines). zcode runs as the user set it up — its own login, provider, default model and
// config; the bridge names no model, provider or key. The one thing it adds is the job's access:
// yolo mode with the tools the access allows, which is a tool restriction, not an OS sandbox. The
// process runs in its own group, recorded beside the attempt log while it runs so a stop or discard
// after the driver died can still terminate it, and the rest of the group is reaped once the run's
// own process has exited.
package zcode

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/shared"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// maxOutputChars caps the output that can count as the final document, in UTF-16 code units (the
// unit JS string lengths count).
const maxOutputChars = int64(8 * 1024 * 1024)

// logEvent is the envelope the worker's normalized events are written to the attempt log in; raw
// stdout is stored separately, only these lines fold back into events.
const logEvent = "zcode_event"

// sessionIdRe is the shape of a session id zcode reports.
var sessionIdRe = regexp.MustCompile(`^sess_[\w.:-]+$`)

// sessionMissingRe is what zcode says on stderr when --resume names a session it does not have.
var sessionMissingRe = regexp.MustCompile(`(?i)session.*(not found|does not exist)|unknown session`)

var caps = ports.WorkerCapabilities{
	WorkerTerms: domain.WorkerTerms{
		Efforts: []string{"default"},
		Budget:  false,
		BriefNotes: domain.BriefNotes{
			Effort:    "Only default is supported; ZCode keeps its configured thought level.",
			AddDirs:   "ZCode has no directory mounts; additional directories are ignored.",
			BudgetUSD: "ZCode has no budget control; briefs with a budget are refused.",
			Readonly: "ZCode uses yolo mode with only Read, Glob and Grep allowed; " +
				"this is a tool restriction, not an OS sandbox.",
		},
	},
	Name:         ports.WorkerNameZcode,
	SessionKey:   ports.SessionKeyEngine,
	NativeSchema: false,
}

// Options is how the engine wiring hands the CLI over.
type Options struct {
	// Bin is the zcode binary or script; "zcode" from PATH when empty.
	Bin string
	// ParentEnv is the orchestrator's environment, passed on so zcode finds its own setup.
	ParentEnv domain.EnvLookup
	// Withheld names what this session added on top of it: the plugin's own provider variables.
	Withheld func(name string) bool
	// StopGraceMs is between the soft stop failing and SIGTERM, and between SIGTERM and SIGKILL.
	StopGraceMs int64
}

// ZcodeWorker runs zcode as a ports.Worker.
type ZcodeWorker struct {
	options Options
}

// NewZcodeWorker builds the worker.
func NewZcodeWorker(options Options) *ZcodeWorker {
	return &ZcodeWorker{options: options}
}

// Caps is the worker's capabilities.
func (w *ZcodeWorker) Caps() ports.WorkerCapabilities {
	return caps
}

// Preflight is cheap, offline readiness. zcode brings its own login; the only thing to check is
// that a bundled script has its runner: the desktop app's own executable beside it, or node on the
// tool's PATH.
func (w *ZcodeWorker) Preflight(ctx context.Context) error {
	if !IsZcodeScript(w.bin()) || ElectronApp(w.bin()) != "" {
		return nil
	}
	if _, ok := NodeOnPath(w.options.ParentEnv); !ok {
		return &ports.WorkerError{Kind: ports.WorkerErrorSpawnFailed, Message: noRunnerMessage(w.bin())}
	}
	return nil
}

// noRunnerMessage names both ways a bundled script can run, for the error that says neither is
// there.
func noRunnerMessage(bin string) string {
	return bin + " has no ZCode app executable beside it (Contents/MacOS/ZCode) " +
		"and no node on PATH"
}

// Dispose: one process per attempt leaves nothing long-lived to release.
func (w *ZcodeWorker) Dispose(ctx context.Context) error {
	return nil
}

// ParseLine turns one line of an attempt log into its events: only the worker's own normalized
// event lines count, each holding exactly one event.
func (w *ZcodeWorker) ParseLine(line string) []domain.WorkerEvent {
	row := shared.ParseJsonLine(line)
	if kind, ok := shared.AsString(row["type"]); !ok || kind != logEvent {
		return nil
	}
	// The event member is taken as raw bytes, not through the parsed record, so a report it
	// carries keeps the key order it was written with.
	var envelope struct {
		Event json.RawMessage `json:"event"`
	}
	if json.Unmarshal([]byte(line), &envelope) != nil {
		return nil
	}
	var event domain.WorkerEvent
	if len(envelope.Event) == 0 || json.Unmarshal(envelope.Event, &event) != nil {
		return nil
	}
	return []domain.WorkerEvent{event}
}

// Start runs one attempt: the brief and its report contract attached as a file, the job's access
// narrowed to the tools it allows, and the process's group recorded beside the attempt log.
func (w *ZcodeWorker) Start(ctx context.Context, spec ports.WorkerSpec) (ports.WorkerRun, error) {
	if spec.BudgetUSD != nil || (spec.Effort != nil && *spec.Effort != "default") {
		return nil, &ports.WorkerError{
			Kind:    ports.WorkerErrorUnsupported,
			Message: "ZCode supports neither a budget nor an effort override",
		}
	}
	promptPath := spec.LogPath + ".prompt.md"
	if _, err := fsutil.WriteFileAtomic(ctx, promptPath,
		[]byte(domain.ReportInstructions(spec.Prompt, spec.Report.JSONSchema)),
		fsutil.WriteOptions{Mode: fsutil.Perm(0o600)}); err != nil {
		return nil, &ports.WorkerError{Kind: ports.WorkerErrorSpawnFailed, Message: err.Error()}
	}
	bin := w.bin()
	command, prefix := ZcodeCommand(bin)
	env := shared.ToolEnv(w.options.ParentEnv, spec.PassEnv, w.options.Withheld, reservedName)
	if IsZcodeScript(bin) {
		if app := ElectronApp(bin); app != "" {
			// The app's own Electron runs the bundle as plain node.
			env["ELECTRON_RUN_AS_NODE"] = "1"
		} else {
			node, ok := NodeOnPath(w.options.ParentEnv)
			if !ok {
				return nil, &ports.WorkerError{
					Kind:    ports.WorkerErrorSpawnFailed,
					Message: noRunnerMessage(bin),
				}
			}
			// A bare "node" would be resolved against the orchestrator's PATH; the tool's own
			// environment decides.
			command = node
		}
	}
	args := append(prefix, "--cwd", spec.Cwd, "--json", "--no-color", "--mode", "yolo")
	if spec.Access != ports.AccessWrite {
		tools := "Read,Glob,Grep,Bash"
		disallowed := "Write,Edit,NotebookEdit"
		if spec.Access == ports.AccessReadonly {
			tools = "Read,Glob,Grep"
			disallowed = "Bash,Write,Edit,NotebookEdit"
		}
		args = append(args, "--allowed-tools", tools, "--disallowed-tools", disallowed)
	}
	if spec.Session.Kind == ports.SessionKindResume {
		args = append(args, "--resume", spec.Session.Key)
	}
	args = append(args,
		"--attach", promptPath,
		"--prompt", "Read the attached task brief and follow it. End with the required JSON report.",
	)
	stdoutLog := spec.LogPath + ".stdout"
	stdin := ""
	grace := w.options.StopGraceMs
	lineBudget := maxOutputChars
	var timeout *int64
	if spec.TimeoutMs > 0 {
		timeout = &spec.TimeoutMs
	}
	proc, err := process.StartStreaming(ctx, process.StreamCommand{
		Command: command,
		Args:    args,
		Cwd:     spec.Cwd,
		Env:     envList(env),
		// The brief rides in the attached file; stdin is closed at once so nothing can wait on it.
		Stdin:           &stdin,
		LogPath:         &stdoutLog,
		TimeoutMs:       timeout,
		GraceMs:         &grace,
		MaxLineBytes:    &lineBudget,
		ReapGroupOnExit: true,
	}, nil)
	if err != nil {
		return nil, &ports.WorkerError{Kind: ports.WorkerErrorSpawnFailed, Message: err.Error()}
	}
	run := newRun(proc, spec)
	adapters.WriteEnginePid(domain.EnginePidBeside(spec.LogPath), proc.Pid)
	go run.drive(ctx)
	return run, nil
}

func (w *ZcodeWorker) bin() string {
	if w.options.Bin != "" {
		return w.options.Bin
	}
	return "zcode"
}

// reservedName keeps a brief env name from re-routing zcode's own setup or handing it a key.
func reservedName(name string) bool {
	return strings.HasPrefix(name, "ZCODE_") || strings.HasPrefix(name, "XDG_") ||
		strings.HasSuffix(name, "_API_KEY")
}

// envList renders the tool's environment as the child's env: name=value, sorted by name so the
// same environment always builds the same list.
func envList(env map[string]string) []string {
	names := make([]string, 0, len(env))
	for name := range env {
		names = append(names, name)
	}
	sort.Strings(names)
	list := make([]string, 0, len(names))
	for _, name := range names {
		list = append(list, name+"="+env[name])
	}
	return list
}

// zcodeRun is one started attempt: the normalized events it streams, how it ended, and how to stop
// it early.
type zcodeRun struct {
	proc    *process.StreamingProcess
	events  *process.Queue[domain.WorkerEvent]
	spec    ports.WorkerSpec
	pidFile string
	done    chan ports.WorkerExit
}

func newRun(proc *process.StreamingProcess, spec ports.WorkerSpec) *zcodeRun {
	return &zcodeRun{
		proc:    proc,
		events:  process.CreateQueue[domain.WorkerEvent](),
		spec:    spec,
		pidFile: domain.EnginePidBeside(spec.LogPath),
		done:    make(chan ports.WorkerExit, 1),
	}
}

func (r *zcodeRun) Events() <-chan domain.WorkerEvent {
	return r.events.Items()
}

// Wait blocks until the process has exited and its events have ended.
func (r *zcodeRun) Wait() ports.WorkerExit {
	return <-r.done
}

// Interrupt asks zcode to stop; there is no stop request, so the group is terminated and the grace
// lets a tool's child die with it.
func (r *zcodeRun) Interrupt(ctx context.Context, reason ports.InterruptReason) error {
	r.proc.Interrupt(ctx, forced(reason))
	return nil
}

func forced(reason ports.InterruptReason) process.ForcedReason {
	if reason == ports.InterruptTimeout {
		return process.ForcedTimeout
	}
	return process.ForcedStopped
}

// drive waits the run out: the drained output, then the exit. A forced exit ran nothing to
// completion, so the events end without a result — the exit tells the story. A natural exit always
// gets a session event when the document names one, and a result built from the document: the
// response text with its report extracted, or why the run failed instead.
func (r *zcodeRun) drive(ctx context.Context) {
	output := collectOutput(ctx, r.proc)
	ended := <-r.proc.Exit
	adapters.ClearEnginePid(r.pidFile)
	if ended.Forced == "" {
		doc := outputDocument(output)
		if sessionId, ok := shared.AsString(doc["sessionId"]); ok {
			r.emit(domain.WorkerEvent{Kind: domain.WorkerEventSession, SessionID: sessionId})
		}
		r.emit(resultEvent(doc, ended))
	}
	r.events.Close()
	r.done <- workerExit(ended, r.spec)
}

// emit appends the event to the attempt log (only normalized events enter it; raw stdout is stored
// separately) and hands it to the events stream.
func (r *zcodeRun) emit(event domain.WorkerEvent) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(struct {
		Type  string             `json:"type"`
		Event domain.WorkerEvent `json:"event"`
	}{logEvent, event}) == nil {
		appendLine(r.spec.LogPath, buf.String())
	}
	r.events.Push(event)
}

func appendLine(path, line string) {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_, _ = file.WriteString(line)
	_ = file.Close()
}

// workerExit is the process's own exit as the core reads it, plus the missing-session flag the
// driver's fresh-session fallback needs.
func workerExit(ended process.ProcessExit, spec ports.WorkerSpec) ports.WorkerExit {
	exit := ports.WorkerExit{StderrTail: ended.StderrTail}
	if ended.Code != nil {
		code := int64(*ended.Code)
		exit.Code = &code
	}
	if ended.Signal != "" {
		signal := ended.Signal
		exit.Signal = &signal
	}
	if ended.Forced != "" {
		forced := domain.ForcedEnd(ended.Forced)
		exit.Forced = &forced
	}
	exit.SessionMissing = spec.Session.Kind == ports.SessionKindResume &&
		sessionMissingRe.MatchString(ended.StderrTail)
	return exit
}

// collectOutput keeps stdout's lines (each with its newline) until they pass the output budget;
// past it the run is stopped and nothing counts as output, so a runaway stream cannot pose as a
// reply.
func collectOutput(ctx context.Context, proc *process.StreamingProcess) string {
	var output strings.Builder
	units := int64(0)
	oversized := false
	for line := range proc.Lines {
		if oversized {
			continue
		}
		length := int64(utf16Units(line)) + 1
		if units+length > maxOutputChars {
			oversized = true
			go proc.Interrupt(ctx, process.ForcedStopped)
			continue
		}
		units += length
		output.WriteString(line)
		output.WriteString("\n")
	}
	if oversized {
		return ""
	}
	return output.String()
}

// utf16Units counts the UTF-16 code units in text, the unit JS string lengths count.
func utf16Units(text string) int {
	units := 0
	for _, r := range text {
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
	}
	return units
}

// outputDocument scans stdout for the final JSON document: a "{" opening a line whose remainder
// parses as one JSON value that is an object. A warning line can contain braces mid-line; only a
// complete document from a line start counts.
func outputDocument(text string) map[string]any {
	for index := 0; index < len(text); index++ {
		if text[index] != '{' || (index > 0 && text[index-1] != '\n') {
			continue
		}
		var value any
		if json.Unmarshal([]byte(text[index:]), &value) == nil {
			if record, ok := value.(map[string]any); ok {
				return record
			}
		}
	}
	return nil
}

// failureReason is why the run failed: a nonzero exit (its stderr tail), a document without a
// valid response and session id, or a projection that says the turn failed. Empty when it did not.
func failureReason(doc map[string]any, ended process.ProcessExit) string {
	if ended.Code == nil || *ended.Code != 0 {
		return fmt.Sprintf("ZCode exited %s: %s", exitLabel(ended), ended.StderrTail)
	}
	_, hasResponse := shared.AsString(doc["response"])
	sessionId, hasSession := shared.AsString(doc["sessionId"])
	if !hasResponse || !hasSession || !sessionIdRe.MatchString(sessionId) {
		return "ZCode returned no valid JSON response and session id"
	}
	if status, _ := shared.AsString(shared.AsRecord(doc["projection"])["status"]); status == "error" || status == "failed" {
		return "ZCode reported a failed turn"
	}
	return ""
}

// exitLabel names how the process ended the way the failure message reads it: the signal, else the
// exit code.
func exitLabel(ended process.ProcessExit) string {
	if ended.Signal != "" {
		return ended.Signal
	}
	code := 0
	if ended.Code != nil {
		code = *ended.Code
	}
	return strconv.Itoa(code)
}

// resultEvent is the run's one result event: the document's response text with its report
// extracted as raw JSON (the key order must survive), or the failure reason instead. The event
// carries no duration or cost: the document reports none.
func resultEvent(doc map[string]any, ended process.ProcessExit) domain.WorkerEvent {
	response, _ := shared.AsString(doc["response"])
	failure := failureReason(doc, ended)
	event := domain.WorkerEvent{
		Kind:    domain.WorkerEventResult,
		IsError: failure != "",
		Text:    response,
	}
	if failure != "" {
		event.Text = failure
	} else {
		event.StructuredOutput = domain.ExtractReport(response)
	}
	if response != "" {
		event.Turns = 1
	}
	usage := shared.AsRecord(doc["usage"])
	event.Usage = domain.ResultUsage{
		InputTokens:      int64(shared.AsCount(usage["inputTokens"])),
		OutputTokens:     int64(shared.AsCount(usage["outputTokens"])),
		CacheReadTokens:  int64(shared.AsCount(usage["cacheReadTokens"])),
		CacheWriteTokens: int64(shared.AsCount(usage["cacheWriteTokens"])),
	}
	return event
}
