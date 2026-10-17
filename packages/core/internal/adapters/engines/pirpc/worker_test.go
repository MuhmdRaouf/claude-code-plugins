package pirpc

// The worker tests: the engine bridge driven end to end against the fake pi from fakepi_test.go,
// which the worker itself starts through PiRpcWorkerOptions.Bin.

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// workerNewSession and workerResumeSession are session keys the caller assigns (pi owns nothing:
// --session-id creates the session when missing).
const workerNewSession = "00000000-0000-7000-8000-000000000001"
const workerResumeSession = "00000000-0000-7000-8000-0000000000a4"

// workerReportText is a space-free report so the fake streams it as one text delta.
const workerReportText = `{"summary":"renamed-foo.ts-to-bar.ts","files":[],"tests_added":[],"open_items":[]}`

// workerParentEnv is the environment the orchestrator runs in: the user's own (HOME, a key of the
// user's own for pi's own provider) plus what the plugin and the Claude Code session added (the
// plugin's key and knobs, the router URL). The fake-pi child role rides along as a user variable.
var workerParentEnv = workerTestParentEnv()

func workerTestParentEnv() domain.EnvLookup {
	env := domain.EnvLookup{
		"PATH":                   os.Getenv("PATH"),
		"HOME":                   os.Getenv("HOME"),
		engineChildEnv:           "fake-pi",
		"OPENROUTER_API_KEY":     "users-own-key",
		"ZAI_API_KEY":            "plugin-provider-key",
		"ZAI_BASE_URL":           "https://api.z.ai/api/anthropic",
		"ANTHROPIC_BASE_URL":     "http://127.0.0.1:18787",
		"CLAUDE_CODE_ENTRYPOINT": "cli",
	}
	if dir := os.Getenv("GOCOVERDIR"); dir != "" {
		// Under coverage the re-executed fake writes its counters through it.
		env["GOCOVERDIR"] = dir
	}
	return env
}

// workerWithheld names the plugin's provider variables, as engine-wire withholds them.
func workerWithheld(name string) bool {
	return name == "ZAI_API_KEY" || strings.HasPrefix(name, "ZAI_")
}

func newPiWorker(bin string, handshakeTimeoutMs int64) *PiRpcWorker {
	return NewPiRpcWorker(PiRpcWorkerOptions{
		Bin:                bin,
		ParentEnv:          workerParentEnv,
		Withheld:           workerWithheld,
		StopGraceMs:        2_000,
		HandshakeTimeoutMs: handshakeTimeoutMs,
	})
}

func strPtr(text string) *string             { return &text }
func i64Ptr(value int64) *int64              { return &value }
func accessPtr(a ports.Access) *ports.Access { return &a }

// specOverrides are the knobs the adapter tests turn; absent optionals stay absent.
type specOverrides struct {
	access    *ports.Access
	effort    *string
	addDirs   []string
	session   *ports.WorkerSession
	timeoutMs *int64
}

func fileReportContract() ports.ReportContract {
	return ports.ReportContract{
		Name:       "change.json",
		JSONSchema: json.RawMessage(`{"type":"object"}`),
		Validate: func(report json.RawMessage) domain.ReportCheck {
			return domain.CheckReport(report, domain.ReportContract{Kind: domain.ReportContractFile})
		},
	}
}

func jobSpec(t *testing.T, passEnv map[string]string, overrides specOverrides) (ports.WorkerSpec, string) {
	t.Helper()
	dir := testkit.TempDir(t, "pi-worker-")
	spec := ports.WorkerSpec{
		Cwd:       dir,
		Model:     testkit.ReferenceProvider.Catalog[domain.ModelTierMain],
		Access:    ports.AccessWrite,
		Prompt:    "Rename foo.ts to bar.ts.",
		Session:   ports.WorkerSession{Kind: ports.SessionKindNew, Key: workerNewSession},
		Report:    fileReportContract(),
		PassEnv:   passEnv,
		TimeoutMs: 60_000,
		LogPath:   filepath.Join(dir, "attempt-0001.jsonl"),
	}
	if overrides.access != nil {
		spec.Access = *overrides.access
	}
	if overrides.effort != nil {
		spec.Effort = overrides.effort
	}
	if overrides.addDirs != nil {
		spec.AddDirs = overrides.addDirs
	}
	if overrides.session != nil {
		spec.Session = *overrides.session
	}
	if overrides.timeoutMs != nil {
		spec.TimeoutMs = *overrides.timeoutMs
	}
	return spec, dir
}

// enginePid reads the run's pid record while the run is live.
func enginePid(t *testing.T, spec ports.WorkerSpec) int64 {
	t.Helper()
	pid, ok := adapters.ReadEnginePid(domain.EnginePidBeside(spec.LogPath))
	if !ok {
		t.Fatalf("no engine pid beside %s", spec.LogPath)
	}
	return pid
}

// assertNoEnginePid says the run's pid record is gone: the worker clears it at the process exit.
func assertNoEnginePid(t *testing.T, spec ports.WorkerSpec) {
	t.Helper()
	if _, ok := adapters.ReadEnginePid(domain.EnginePidBeside(spec.LogPath)); ok {
		t.Fatalf("an engine pid is still beside %s", spec.LogPath)
	}
}

func startRun(t *testing.T, spec ports.WorkerSpec) ports.WorkerRun {
	t.Helper()
	run, err := newPiWorker(selfExe(t), 30_000).Start(context.Background(), spec)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	pidFile := domain.EnginePidBeside(spec.LogPath)
	t.Cleanup(func() {
		if pid, ok := adapters.ReadEnginePid(pidFile); ok && testkit.IsPidAlive(int(pid)) {
			_ = run.Interrupt(context.Background(), ports.InterruptStopped)
		}
	})
	return run
}

// eventCollector pumps events eagerly; done closes once the queue does (after the engine_result
// line is appended).
type eventCollector struct {
	mu   sync.Mutex
	seen []domain.WorkerEvent
	done chan struct{}
}

func collectEvents(run ports.WorkerRun) *eventCollector {
	collected := &eventCollector{done: make(chan struct{})}
	go func() {
		defer close(collected.done)
		for event := range run.Events() {
			collected.mu.Lock()
			collected.seen = append(collected.seen, event)
			collected.mu.Unlock()
		}
	}()
	return collected
}

func (c *eventCollector) snapshot() []domain.WorkerEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]domain.WorkerEvent(nil), c.seen...)
}

func (c *eventCollector) wait(t *testing.T) []domain.WorkerEvent {
	t.Helper()
	select {
	case <-c.done:
	case <-time.After(30 * time.Second):
		t.Fatal("the events queue did not close")
	}
	return c.snapshot()
}

// waitForEvent resolves once an event matching predicate shows up, failing the test after 10 s.
func (c *eventCollector) waitForEvent(t *testing.T, predicate func(domain.WorkerEvent) bool) {
	t.Helper()
	if err := testkit.Until(t, func() bool {
		for _, event := range c.snapshot() {
			if predicate(event) {
				return true
			}
		}
		return false
	}, testkit.UntilOptions{Message: "event did not arrive"}); err != nil {
		t.Fatal(err)
	}
}

func eventKinds(events []domain.WorkerEvent) []string {
	kinds := make([]string, 0, len(events))
	for _, event := range events {
		kinds = append(kinds, string(event.Kind))
	}
	return kinds
}

func workerCommandsLog(logPath string) string {
	if strings.HasSuffix(logPath, ".jsonl") {
		return logPath[:len(logPath)-len(".jsonl")] + ".rpc-in.jsonl"
	}
	return logPath
}

// commandTypes is the commands log's frames, one type per sent command.
func commandTypes(t *testing.T, spec ports.WorkerSpec) []string {
	t.Helper()
	var types []string
	for _, line := range readLines(t, workerCommandsLog(spec.LogPath)) {
		frame, reason := parseFrame(line)
		if frame == nil {
			t.Fatalf("the commands log holds a non-frame %q (%s)", line, reason)
		}
		types = append(types, frameString(frame, "type"))
	}
	return types
}

func countCommand(t *testing.T, spec ports.WorkerSpec, name string) int {
	t.Helper()
	count := 0
	for _, typ := range commandTypes(t, spec) {
		if typ == name {
			count++
		}
	}
	return count
}

// recordedRun is one full run with the argv/env recorders on.
type recordedRun struct {
	argv   []string
	env    map[string]string
	jobDir string
	spec   ports.WorkerSpec
}

// recordRun throws unless the fake exited 0.
func recordRun(t *testing.T, passEnv map[string]string, overrides specOverrides) recordedRun {
	t.Helper()
	logs := testkit.TempDir(t, "pi-worker-logs-")
	full := map[string]string{
		"FAKE_PI_ARGV_LOG": filepath.Join(logs, "argv.json"),
		"FAKE_PI_ENV_LOG":  filepath.Join(logs, "env.json"),
	}
	for name, value := range passEnv {
		full[name] = value
	}
	spec, dir := jobSpec(t, full, overrides)
	run := startRun(t, spec)
	// The pid record exists while the run is live and names its group leader.
	pid := enginePid(t, spec)
	if !testkit.IsPidAlive(int(pid)) {
		t.Fatalf("engine pid %d is not alive while the run is", pid)
	}
	collected := collectEvents(run)
	exit := run.Wait()
	collected.wait(t)
	assertNoEnginePid(t, spec)
	if exit.Code == nil || *exit.Code != 0 {
		t.Fatalf("fake pi exited %+v: %s", exit.Code, exit.StderrTail)
	}
	argvText, err := os.ReadFile(filepath.Join(logs, "argv.json"))
	if err != nil {
		t.Fatalf("read argv.json: %v", err)
	}
	var argv []string
	if err := json.Unmarshal(argvText, &argv); err != nil {
		t.Fatalf("argv.json does not parse: %v", err)
	}
	envText, err := os.ReadFile(filepath.Join(logs, "env.json"))
	if err != nil {
		t.Fatalf("read env.json: %v", err)
	}
	env := map[string]string{}
	if err := json.Unmarshal(envText, &env); err != nil {
		t.Fatalf("env.json does not parse: %v", err)
	}
	return recordedRun{argv: argv, env: env, jobDir: dir, spec: spec}
}

// promptsSent is the prompts the run sent, read back from the frames log (the commands log stores
// prompts as a $ref).
func promptsSent(t *testing.T, spec ports.WorkerSpec) []string {
	t.Helper()
	var prompts []string
	for _, line := range readLines(t, spec.LogPath) {
		frame, _ := parseFrame(line)
		if frame == nil || frameString(frame, "type") != "message_end" {
			continue
		}
		message := frameObject(frame, "message")
		if frameString(message, "role") != "user" {
			continue
		}
		var parts []map[string]json.RawMessage
		if err := json.Unmarshal(message["content"], &parts); err != nil {
			t.Fatalf("a recorded user message's content does not parse: %v", err)
		}
		text := ""
		for _, part := range parts {
			if partText, ok := frameStringOk(part, "text"); ok {
				text += partText
			}
		}
		prompts = append(prompts, text)
	}
	return prompts
}

// finishRun drives a run to its end (exit seen, events queue drained), for the tests that do not
// record argv.
func finishRun(t *testing.T, spec ports.WorkerSpec) ([]domain.WorkerEvent, ports.WorkerExit) {
	t.Helper()
	run := startRun(t, spec)
	collected := collectEvents(run)
	exit := run.Wait()
	return collected.wait(t), exit
}

// reportRaw is the report object as the result event carries it: the fake's own raw bytes, key
// order and all.
func reportRaw(t *testing.T) json.RawMessage {
	t.Helper()
	return json.RawMessage(workerReportText)
}

func assertCleanWorkerExit(t *testing.T, exit ports.WorkerExit) {
	t.Helper()
	if exit.Code == nil || *exit.Code != 0 || exit.Signal != nil || exit.StderrTail != "" ||
		exit.Forced != nil || exit.SessionMissing {
		t.Fatalf("exit = %+v, want pi's own exit 0, no signal, empty tail, unforced, session kept", exit)
	}
}

func TestPiRpcWorker(t *testing.T) {
	t.Run("answers extension confirmations and cancels text dialogs without waiting for a human", func(t *testing.T) {
		// The re-executed test binary boots slower than a plain helper would, so the wall clock
		// here is 5 s. An unanswered dialog hangs past any wall clock, which the unforced-end
		// check below still catches.
		spec, _ := jobSpec(t, map[string]string{
			"FAKE_PI_SCENARIO":   "ui",
			"FAKE_PI_FINAL_TEXT": `{"kind":"file"}`,
		}, specOverrides{timeoutMs: i64Ptr(5_000)})
		run := startRun(t, spec)
		collected := collectEvents(run)
		seen := collected.wait(t)
		exit := run.Wait()
		if exit.Forced != nil {
			t.Fatalf("exit = %+v, want an unforced end", exit)
		}
		passed := false
		for _, event := range seen {
			if event.Kind == domain.WorkerEventResult && !event.IsError {
				passed = true
			}
		}
		if !passed {
			t.Fatalf("events = %v, want a passing result", eventKinds(seen))
		}
	})

	t.Run("readonly runs with narrowed tools; pi keeps its own model, setup and environment", func(t *testing.T) {
		run := recordRun(t, map[string]string{
			"ZAI_API_KEY":         "brief-supplied",
			"PI_CODING_AGENT_DIR": "/elsewhere",
			"GREETING":            "hi",
		}, specOverrides{access: accessPtr(ports.AccessReadonly)})
		wantArgv := []string{
			"--mode", "rpc",
			"--tools", "read,grep,find,ls",
			"--no-mcp",
			"--session-id", workerNewSession,
		}
		if !reflect.DeepEqual(run.argv, wantArgv) {
			t.Errorf("argv = %q, want %q", run.argv, wantArgv)
		}
		if run.env["HOME"] != workerParentEnv["HOME"] {
			t.Errorf("env HOME = %q, want the user's own", run.env["HOME"])
		}
		if run.env["OPENROUTER_API_KEY"] != "users-own-key" {
			t.Errorf("env OPENROUTER_API_KEY = %q, want the user's own key", run.env["OPENROUTER_API_KEY"])
		}
		if run.env["GREETING"] != "hi" {
			t.Errorf("env GREETING = %q, want the brief's value", run.env["GREETING"])
		}
		for _, name := range []string{
			"ZAI_API_KEY", "ZAI_BASE_URL", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_ENTRYPOINT",
			"PI_CODING_AGENT_DIR",
		} {
			if _, kept := run.env[name]; kept {
				t.Errorf("env keeps %s", name)
			}
		}
		serialized := string(mustJSON(t, run.argv)) + string(mustJSON(t, run.env))
		for _, leak := range []string{"plugin-provider-key", "api.z.ai", "18787"} {
			if strings.Contains(serialized, leak) {
				t.Errorf("argv or env leaks %q", leak)
			}
		}
		// The pid record existed while the run was live and named its group leader (recordRun
		// checked both); after Wait it is gone.
		assertNoEnginePid(t, run.spec)
	})

	for _, access := range []ports.Access{ports.AccessWrite, ports.AccessExec} {
		t.Run(string(access)+" runs with pi's own default toolset", func(t *testing.T) {
			run := recordRun(t, nil, specOverrides{access: &access})
			wantArgv := []string{"--mode", "rpc", "--session-id", workerNewSession}
			if access == ports.AccessExec {
				wantArgv = []string{
					"--mode", "rpc",
					"--tools", "read,grep,find,ls,bash",
					"--no-mcp",
					"--session-id", workerNewSession,
				}
			}
			if !reflect.DeepEqual(run.argv, wantArgv) {
				t.Errorf("argv = %q, want %q", run.argv, wantArgv)
			}
		})
	}

	t.Run("passes effort and the caller's session key as their own flags, and drops addDirs", func(t *testing.T) {
		run := recordRun(t, nil, specOverrides{
			access:  accessPtr(ports.AccessReadonly),
			effort:  strPtr("low"),
			addDirs: []string{"/refs/one", "/refs/two"},
			session: &ports.WorkerSession{Kind: ports.SessionKindResume, Key: workerResumeSession},
		})
		wantArgv := []string{
			"--mode", "rpc",
			"--thinking", "low",
			"--tools", "read,grep,find,ls",
			"--no-mcp",
			"--session-id", workerResumeSession,
		}
		if !reflect.DeepEqual(run.argv, wantArgv) {
			t.Errorf("argv = %q, want %q", run.argv, wantArgv)
		}
		if strings.Contains(strings.Join(run.argv, " "), "/refs/") {
			t.Errorf("argv = %q, want the addDirs dropped", run.argv)
		}
	})

	t.Run("a completed run yields session, text and a result with usage and report, logged as engine_result", func(t *testing.T) {
		spec, _ := jobSpec(t, map[string]string{"FAKE_PI_FINAL_TEXT": workerReportText}, specOverrides{})
		seen, exit := finishRun(t, spec)
		assertCleanWorkerExit(t, exit)
		// The fake streams "Working on it." as 3 deltas (it splits after each space) and the report as 1.
		wantKinds := []string{
			"session",
			"text_delta", "text_delta", "text_delta", "text_delta",
			"assistant_text",
			"result",
		}
		if got := eventKinds(seen); !reflect.DeepEqual(got, wantKinds) {
			t.Fatalf("event kinds = %v, want %v", got, wantKinds)
		}
		wantSession := domain.WorkerEvent{Kind: domain.WorkerEventSession, SessionID: workerNewSession}
		if !reflect.DeepEqual(seen[0], wantSession) {
			t.Errorf("first event = %+v, want %+v", seen[0], wantSession)
		}
		var deltas strings.Builder
		for _, event := range seen {
			if event.Kind == domain.WorkerEventTextDelta {
				deltas.WriteString(event.Text)
			}
		}
		if got, want := deltas.String(), "Working on it."+workerReportText; got != want {
			t.Errorf("deltas = %q, want %q", got, want)
		}
		result := seen[len(seen)-1]
		if result.DurationMs < 0 {
			t.Errorf("durationMs = %d, want a number", result.DurationMs)
		}
		wantResult := domain.WorkerEvent{
			Kind:             domain.WorkerEventResult,
			Text:             workerReportText,
			StructuredOutput: reportRaw(t),
			Turns:            1,
			DurationMs:       result.DurationMs,
			CostUSD:          0.0001,
			Usage:            domain.ResultUsage{InputTokens: 100, OutputTokens: 20, CacheReadTokens: 50},
			Model:            strPtr("zai/glm-5.3"),
		}
		if !reflect.DeepEqual(result, wantResult) {
			t.Errorf("result = %+v, want %+v", result, wantResult)
		}
		logged := lastLine(readLines(t, spec.LogPath))
		if frame, _ := parseFrame(logged); frameString(frame, "type") != "engine_result" {
			t.Fatalf("the last logged line is %q, want an engine_result", logged)
		}
		refolded := newPiWorker(selfExe(t), 30_000).ParseLine(logged)
		if !reflect.DeepEqual(refolded, []domain.WorkerEvent{result}) {
			t.Errorf("parseLine(logged) = %+v, want the logged result event", refolded)
		}
		if got := countCommand(t, spec, "prompt"); got != 1 {
			t.Errorf("prompt commands = %d, want 1", got)
		}
	})

	t.Run("an invalid report draws up to two correction prompts in the same session, and the result carries the problems", func(t *testing.T) {
		// The fake's default final text is "done": no JSON, so every turn's report is missing.
		spec, _ := jobSpec(t, nil, specOverrides{})
		seen, exit := finishRun(t, spec)
		if exit.Code == nil || *exit.Code != 0 {
			t.Fatalf("exit = %+v, want pi's own exit 0", exit)
		}
		prompts := promptsSent(t, spec)
		if len(prompts) != 3 {
			t.Fatalf("prompts = %d, want 3 (%v)", len(prompts), prompts)
		}
		if !strings.Contains(prompts[0], "## Final report") {
			t.Errorf("the first prompt = %q, want the report contract in words", prompts[0])
		}
		for _, correction := range prompts[1:] {
			if !strings.Contains(correction, "Your report was invalid: no structured report") {
				t.Errorf("a correction = %q, want it to name the missing report", correction)
			}
			if !strings.Contains(correction, "Reply with only the corrected JSON object.") {
				t.Errorf("a correction = %q, want the correction ask", correction)
			}
		}
		result := seen[len(seen)-1]
		if result.CostUSD < 0.0003-1e-9 || result.CostUSD > 0.0003+1e-9 {
			t.Errorf("costUsd = %v, want 0.0003", result.CostUSD)
		}
		want := domain.WorkerEvent{
			Kind:       domain.WorkerEventResult,
			Text:       "done",
			Turns:      3,
			DurationMs: result.DurationMs,
			CostUSD:    result.CostUSD,
			Usage:      domain.ResultUsage{InputTokens: 300, OutputTokens: 60, CacheReadTokens: 150},
			Model:      strPtr("zai/glm-5.3"),
		}
		if result.IsError || !reflect.DeepEqual(result, want) {
			t.Errorf("result = %+v, want %+v", result, want)
		}
	})

	t.Run("extracts the report from a ```json fence when the final text is not pure JSON", func(t *testing.T) {
		spec, _ := jobSpec(t, map[string]string{
			"FAKE_PI_FINAL_TEXT": "Here you go:\n```json\n" + workerReportText + "\n```",
		}, specOverrides{})
		seen, exit := finishRun(t, spec)
		if exit.Code == nil || *exit.Code != 0 {
			t.Fatalf("exit = %+v, want pi's own exit 0", exit)
		}
		result := seen[len(seen)-1]
		if result.IsError || !reflect.DeepEqual(result.StructuredOutput, reportRaw(t)) || result.Turns != 1 {
			t.Errorf("result = %+v, want the fenced report after one turn", result)
		}
	})

	t.Run("extracts the report from the outermost braces in prose", func(t *testing.T) {
		spec, _ := jobSpec(t, map[string]string{
			"FAKE_PI_FINAL_TEXT": "Sure! " + workerReportText + " — done.",
		}, specOverrides{})
		seen, exit := finishRun(t, spec)
		if exit.Code == nil || *exit.Code != 0 {
			t.Fatalf("exit = %+v, want pi's own exit 0", exit)
		}
		result := seen[len(seen)-1]
		if result.IsError || !reflect.DeepEqual(result.StructuredOutput, reportRaw(t)) || result.Turns != 1 {
			t.Errorf("result = %+v, want the report out of the prose", result)
		}
	})

	t.Run("keeps a multi-key report's key order in the result and the engine_result line", func(t *testing.T) {
		report := `{"zeta":1,"alpha":2}`
		spec, _ := jobSpec(t, map[string]string{"FAKE_PI_FINAL_TEXT": report}, specOverrides{})
		seen, exit := finishRun(t, spec)
		if exit.Code == nil || *exit.Code != 0 {
			t.Fatalf("exit = %+v, want pi's own exit 0", exit)
		}
		result := seen[len(seen)-1]
		// Byte for byte, as JSON.stringify wrote it: a decoded map would re-render it sorted.
		if string(result.StructuredOutput) != report {
			t.Errorf("structuredOutput = %s, want %s", result.StructuredOutput, report)
		}
		logged := lastLine(readLines(t, spec.LogPath))
		if !strings.Contains(logged, `"structuredOutput":`+report) {
			t.Errorf("engine_result line = %s, want the report in its written order", logged)
		}
	})

	t.Run("recovers the report with get_last_assistant_text when the final message ends textless", func(t *testing.T) {
		spec, _ := jobSpec(t, map[string]string{
			"FAKE_PI_FINAL_TEXT": workerReportText,
			"FAKE_PI_TEXTLESS":   "1",
		}, specOverrides{})
		seen, exit := finishRun(t, spec)
		if exit.Code == nil || *exit.Code != 0 {
			t.Fatalf("exit = %+v, want pi's own exit 0", exit)
		}
		for _, kind := range eventKinds(seen) {
			if kind == "assistant_text" {
				t.Fatalf("event kinds = %v, want no assistant_text", eventKinds(seen))
			}
		}
		result := seen[len(seen)-1]
		if result.IsError || !reflect.DeepEqual(result.StructuredOutput, reportRaw(t)) || result.Turns != 1 {
			t.Errorf("result = %+v, want the recovered report", result)
		}
		if got := countCommand(t, spec, "get_last_assistant_text"); got != 1 {
			t.Errorf("get_last_assistant_text commands = %d, want 1", got)
		}
	})

	t.Run("a prompt that ran no agent ends without a final message, and the result says so", func(t *testing.T) {
		spec, _ := jobSpec(t, map[string]string{"FAKE_PI_NO_AGENT": "1"}, specOverrides{})
		seen, exit := finishRun(t, spec)
		assertCleanWorkerExit(t, exit)
		result := seen[len(seen)-1]
		want := domain.WorkerEvent{
			Kind:       domain.WorkerEventResult,
			IsError:    true,
			Text:       "worker stopped without finishing (stopReason )",
			Turns:      0,
			DurationMs: result.DurationMs,
		}
		if !reflect.DeepEqual(result, want) {
			t.Errorf("result = %+v, want %+v", result, want)
		}
	})

	t.Run("a provider failure arrives on the message stream: an error event and a result with its status", func(t *testing.T) {
		spec, _ := jobSpec(t, map[string]string{"FAKE_PI_SCENARIO": "error"}, specOverrides{})
		seen, exit := finishRun(t, spec)
		assertCleanWorkerExit(t, exit)
		if got := eventKinds(seen); !reflect.DeepEqual(got, []string{"session", "error", "result"}) {
			t.Fatalf("event kinds = %v, want [session error result]", got)
		}
		wantError := domain.WorkerEvent{
			Kind:    domain.WorkerEventError,
			Message: `401 {"error":{"message":"token expired or incorrect"}}`,
		}
		if !reflect.DeepEqual(seen[1], wantError) {
			t.Errorf("the error event = %+v, want %+v", seen[1], wantError)
		}
		result := seen[len(seen)-1]
		if !result.IsError || result.Text != wantError.Message || result.Turns != 1 ||
			result.APIErrorStatus == nil || *result.APIErrorStatus != 401 {
			t.Errorf("result = %+v, want the 401 failure", result)
		}
		// The failure is not correctable: no second prompt is sent.
		if got := countCommand(t, spec, "prompt"); got != 1 {
			t.Errorf("prompt commands = %d, want 1", got)
		}
	})

	t.Run("interrupt mid-tool stops the run and leaves no process behind", func(t *testing.T) {
		spec, _ := jobSpec(t, map[string]string{"FAKE_PI_SCENARIO": "sleep"}, specOverrides{})
		run := startRun(t, spec)
		collected := collectEvents(run)
		// The exit is racy by design (the soft abort races the group kill), so only the forced
		// reason is asserted.
		collected.waitForEvent(t, func(event domain.WorkerEvent) bool {
			return event.Kind == domain.WorkerEventToolUse && event.Name == "bash"
		})
		leader := enginePid(t, spec)
		if err := run.Interrupt(context.Background(), ports.InterruptStopped); err != nil {
			t.Fatalf("interrupt: %v", err)
		}
		exit := run.Wait()
		collected.wait(t)
		if exit.Forced == nil || *exit.Forced != domain.ForcedStopped {
			t.Fatalf("exit = %+v, want the forced stop", exit)
		}
		assertNoEnginePid(t, spec)
		if testkit.IsPidAlive(int(leader)) {
			t.Error("the recorded engine pid is still alive after the interrupt")
		}
	})

	t.Run("the wall clock times the run out and the group dies", func(t *testing.T) {
		// The wall clock starts at spawn, before the fake has even booted: 2 s leaves a loaded box
		// room to boot and handshake, and the sleep scenario still runs far longer than that.
		spec, _ := jobSpec(t, map[string]string{"FAKE_PI_SCENARIO": "sleep"}, specOverrides{
			timeoutMs: i64Ptr(2_000),
		})
		run := startRun(t, spec)
		leader := enginePid(t, spec)
		collected := collectEvents(run)
		exit := run.Wait()
		collected.wait(t)
		if exit.Forced == nil || *exit.Forced != domain.ForcedTimeout {
			t.Fatalf("exit = %+v, want the forced timeout", exit)
		}
		assertNoEnginePid(t, spec)
		if testkit.IsPidAlive(int(leader)) {
			t.Error("the recorded engine pid is still alive after the timeout")
		}
	})

	t.Run("a crashed run emits no result", func(t *testing.T) {
		spec, _ := jobSpec(t, map[string]string{"FAKE_PI_SCENARIO": "crash"}, specOverrides{})
		seen, exit := finishRun(t, spec)
		if got := eventKinds(seen); !reflect.DeepEqual(got, []string{"session"}) {
			t.Fatalf("event kinds = %v, want the session alone", got)
		}
		crashCode := int64(1)
		want := ports.WorkerExit{
			Code:       &crashCode,
			StderrTail: "fake pi: simulated crash\n",
		}
		if !reflect.DeepEqual(exit, want) {
			t.Fatalf("exit = %+v, want %+v", exit, want)
		}
	})

	t.Run("parseLine folds a recorded transcript into the expected event kinds", func(t *testing.T) {
		worker := newPiWorker("", 30_000)
		kinds := func(name string) []string {
			var collected []string
			for _, line := range jsonLines(t, fixturePath(t, name, "stdout.jsonl")) {
				for _, event := range worker.ParseLine(line) {
					collected = append(collected, string(event.Kind))
				}
			}
			return collected
		}
		if got := kinds("success-readonly"); !reflect.DeepEqual(got, []string{
			"session", "tool_use", "tool_result", "text_delta", "text_delta", "text_delta",
			"assistant_text",
		}) {
			t.Errorf("success-readonly kinds = %v", got)
		}
		if got := kinds("error-after-success"); !reflect.DeepEqual(got, []string{"session", "error"}) {
			t.Errorf("error-after-success kinds = %v", got)
		}
		if got := kinds("abort-mid-run"); !reflect.DeepEqual(got, []string{
			"session", "tool_use", "tool_result", "error",
		}) {
			t.Errorf("abort-mid-run kinds = %v", got)
		}
	})

	t.Run("preflight needs nothing of the plugin's: pi brings its own login", func(t *testing.T) {
		if err := newPiWorker(selfExe(t), 30_000).Preflight(context.Background()); err != nil {
			t.Errorf("preflight = %v, want nil", err)
		}
	})

	t.Run("reports a missing binary as spawn_failed", func(t *testing.T) {
		spec, _ := jobSpec(t, nil, specOverrides{})
		_, err := newPiWorker("/nonexistent/pi", 30_000).Start(context.Background(), spec)
		if err == nil {
			t.Fatal("start succeeded, want a spawn failure")
		}
		var workerErr *ports.WorkerError
		if !errors.As(err, &workerErr) || workerErr.Kind != ports.WorkerErrorSpawnFailed {
			t.Fatalf("error = %+v, want a spawn_failed worker error", err)
		}
		if !strings.Contains(workerErr.Message, "ENOENT") {
			t.Errorf("message = %q, want it to name ENOENT", workerErr.Message)
		}
		assertNoEnginePid(t, spec)
	})

	t.Run("reports a get_state answer without a sessionId as protocol", func(t *testing.T) {
		spec, _ := jobSpec(t, map[string]string{"FAKE_PI_NO_SESSION_ID": "1"}, specOverrides{})
		_, err := newPiWorker(selfExe(t), 30_000).Start(context.Background(), spec)
		if err == nil {
			t.Fatal("start succeeded, want a protocol failure")
		}
		var workerErr *ports.WorkerError
		if !errors.As(err, &workerErr) || workerErr.Kind != ports.WorkerErrorProtocol {
			t.Fatalf("error = %+v, want a protocol worker error", err)
		}
		if !strings.Contains(workerErr.Message, "sessionId") {
			t.Errorf("message = %q, want it to name the sessionId", workerErr.Message)
		}
		assertNoEnginePid(t, spec)
	})

	t.Run("reports a handshake that never answers as protocol", func(t *testing.T) {
		spec, _ := jobSpec(t, map[string]string{"FAKE_PI_SLOW_STATE_MS": "5000"}, specOverrides{})
		_, err := newPiWorker(selfExe(t), 300).Start(context.Background(), spec)
		if err == nil {
			t.Fatal("start succeeded, want a protocol failure")
		}
		var workerErr *ports.WorkerError
		if !errors.As(err, &workerErr) || workerErr.Kind != ports.WorkerErrorProtocol {
			t.Fatalf("error = %+v, want a protocol worker error", err)
		}
		if !strings.Contains(workerErr.Message, "handshake") {
			t.Errorf("message = %q, want it to name the handshake", workerErr.Message)
		}
		assertNoEnginePid(t, spec)
	})
}

func TestParseLineOverCraftedFrames(t *testing.T) {
	worker := newPiWorker("", 30_000)
	// fold is one frame through the fold, as parseLine would read it from a log.
	fold := func(t *testing.T, frame string) []domain.WorkerEvent {
		t.Helper()
		return worker.ParseLine(frame)
	}

	t.Run("returns nothing for a line that is not JSON or a frame the fold does not know", func(t *testing.T) {
		if got := worker.ParseLine("this is not json"); got != nil {
			t.Errorf("parseLine(non-json) = %+v, want none", got)
		}
		for _, frame := range []string{`{"type":"notice"}`, `{"type":"agent_settled"}`} {
			if got := fold(t, frame); got != nil {
				t.Errorf("parseLine(%s) = %+v, want none", frame, got)
			}
		}
	})

	t.Run("folds responses: the get_state session, refusals, and quiet successes", func(t *testing.T) {
		if got := fold(t, `{"type":"response"}`); got != nil {
			t.Errorf("a response without command or success folded to %+v", got)
		}
		if got := fold(t, `{"type":"response","command":"get_state","success":true,"data":{}}`); got != nil {
			t.Errorf("a dataless get_state folded to %+v", got)
		}
		got := fold(t, `{"type":"response","command":"get_state","success":true,"data":{"sessionId":"s1"}}`)
		want := []domain.WorkerEvent{{Kind: domain.WorkerEventSession, SessionID: "s1"}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("get_state folded to %+v, want %+v", got, want)
		}
		if got := fold(t, `{"type":"response","command":"get_last_assistant_text","success":true,"data":{"sessionId":"s1"}}`); got != nil {
			t.Errorf("a quiet success folded to %+v", got)
		}
		got = fold(t, `{"type":"response","command":"frobnicate","success":false,"error":"no such command"}`)
		want = []domain.WorkerEvent{{Kind: domain.WorkerEventError, Message: "no such command"}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("the refusal folded to %+v, want %+v", got, want)
		}
		got = fold(t, `{"type":"response","command":"frobnicate","success":false}`)
		want = []domain.WorkerEvent{{Kind: domain.WorkerEventError, Message: "pi refused frobnicate"}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("the textless refusal folded to %+v, want %+v", got, want)
		}
	})

	t.Run("folds message updates: only string text deltas", func(t *testing.T) {
		got := fold(t, `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hi"}}`)
		want := []domain.WorkerEvent{{Kind: domain.WorkerEventTextDelta, Text: "hi"}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("a text delta folded to %+v, want %+v", got, want)
		}
		for _, frame := range []string{
			`{"type":"message_update","assistantMessageEvent":{"type":"tool_call"}}`,
			`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":3}}`,
			`{"type":"message_update"}`,
		} {
			if got := fold(t, frame); got != nil {
				t.Errorf("parseLine(%s) = %+v, want none", frame, got)
			}
		}
	})

	t.Run("folds assistant message ends, including their error stops", func(t *testing.T) {
		got := fold(t, `{"type":"message_end","message":{"role":"assistant","content":[`+
			`{"type":"text","text":"a"},{"type":"text","text":"b"}],"stopReason":"stop"}}`)
		want := []domain.WorkerEvent{{Kind: domain.WorkerEventAssistantText, Text: "ab"}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("two text parts folded to %+v, want %+v", got, want)
		}
		if got := fold(t, `{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"u"}]}}`); got != nil {
			t.Errorf("a user message folded to %+v", got)
		}
		if got := fold(t, `{"type":"message_end","message":{"role":"assistant","content":"not parts","stopReason":"stop"}}`); got != nil {
			t.Errorf("a non-part content folded to %+v", got)
		}
		got = fold(t, `{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"boom"}}`)
		want = []domain.WorkerEvent{{Kind: domain.WorkerEventError, Message: "boom"}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("an error stop folded to %+v, want %+v", got, want)
		}
		got = fold(t, `{"type":"message_end","message":{"role":"assistant","stopReason":"error"}}`)
		want = []domain.WorkerEvent{{Kind: domain.WorkerEventError, Message: "pi ended an assistant message in error"}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("a textless error stop folded to %+v, want %+v", got, want)
		}
		got = fold(t, `{"type":"message_end","message":{"role":"assistant","content":[`+
			`{"type":"text","text":"partial"}],"stopReason":"error","errorMessage":"boom"}}`)
		want = []domain.WorkerEvent{
			{Kind: domain.WorkerEventAssistantText, Text: "partial"},
			{Kind: domain.WorkerEventError, Message: "boom"},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("a partial error stop folded to %+v, want %+v", got, want)
		}
	})

	t.Run("folds tool starts and results: a name, then a summary from the first string argument or nothing", func(t *testing.T) {
		got := fold(t, `{"type":"tool_execution_start","toolName":"bash","args":{"command":"sleep 600"}}`)
		want := []domain.WorkerEvent{{Kind: domain.WorkerEventToolUse, Name: "bash", Summary: "sleep 600"}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("a tool start folded to %+v, want %+v", got, want)
		}
		for _, row := range []struct {
			frame string
			want  domain.WorkerEvent
		}{
			{`{"type":"tool_execution_start","toolName":"grep","args":{"pattern":3}}`,
				domain.WorkerEvent{Kind: domain.WorkerEventToolUse, Name: "grep"}},
			{`{"type":"tool_execution_start","toolName":"grep"}`,
				domain.WorkerEvent{Kind: domain.WorkerEventToolUse, Name: "grep"}},
		} {
			if got := fold(t, row.frame); !reflect.DeepEqual(got, []domain.WorkerEvent{row.want}) {
				t.Errorf("parseLine(%s) = %+v, want %+v", row.frame, got, row.want)
			}
		}
		if got := fold(t, `{"type":"tool_execution_start"}`); got != nil {
			t.Errorf("a nameless tool start folded to %+v", got)
		}
		got = fold(t, `{"type":"tool_execution_end","isError":true}`)
		want = []domain.WorkerEvent{{Kind: domain.WorkerEventToolResult, IsError: true}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("a failed tool end folded to %+v, want %+v", got, want)
		}
		got = fold(t, `{"type":"tool_execution_end"}`)
		want = []domain.WorkerEvent{{Kind: domain.WorkerEventToolResult}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("a tool end folded to %+v, want %+v", got, want)
		}
	})

	t.Run("folds retries: a leading 3-digit status, and counts that may be missing", func(t *testing.T) {
		got := fold(t, `{"type":"auto_retry_start","errorMessage":"429 High concurrency","attempt":2,"maxAttempts":5}`)
		want := []domain.WorkerEvent{{
			Kind:       domain.WorkerEventAPIRetry,
			Attempt:    2,
			MaxRetries: 5,
			Status:     i64Ptr(429),
		}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("a retry folded to %+v, want %+v", got, want)
		}
		for _, frame := range []string{
			`{"type":"auto_retry_start","errorMessage":"provider hiccup","attempt":"soon","maxAttempts":"5"}`,
			`{"type":"auto_retry_start"}`,
		} {
			want := []domain.WorkerEvent{{Kind: domain.WorkerEventAPIRetry}}
			if got := fold(t, frame); !reflect.DeepEqual(got, want) {
				t.Errorf("parseLine(%s) = %+v, want %+v", frame, got, want)
			}
		}
	})

	t.Run("rebuilds a logged engine_result, defaulting every missing field", func(t *testing.T) {
		got := fold(t, `{"type":"engine_result","apiErrorStatus":503}`)
		want := []domain.WorkerEvent{{Kind: domain.WorkerEventResult, APIErrorStatus: i64Ptr(503)}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("a bare engine_result folded to %+v, want %+v", got, want)
		}
		events := fold(t, `{"type":"engine_result","isError":true,"structuredOutput":{"a":1},"turns":"3"}`)
		if len(events) != 1 {
			t.Fatalf("engine_result folded to %d events", len(events))
		}
		result := events[0]
		var output map[string]any
		if err := json.Unmarshal(result.StructuredOutput, &output); err != nil {
			t.Fatalf("structuredOutput = %s does not parse: %v", result.StructuredOutput, err)
		}
		if !result.IsError || !reflect.DeepEqual(output, map[string]any{"a": float64(1)}) ||
			result.Turns != 0 || result.APIErrorStatus != nil {
			t.Errorf("engine_result folded to %+v (output %v)", result, output)
		}
		events = fold(t, `{"type":"engine_result","usage":{"writeTokens":7}}`)
		if events[0].Usage.CacheWriteTokens != 7 {
			t.Errorf("writeTokens folded to %+v, want it as cacheWriteTokens", events[0].Usage)
		}
		events = fold(t, `{"type":"engine_result","usage":{"cacheWriteTokens":9}}`)
		if events[0].Usage.CacheWriteTokens != 9 {
			t.Errorf("cacheWriteTokens folded to %+v", events[0].Usage)
		}
	})
}

// mustJSON marshals value or fails the test.
func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal %v: %v", value, err)
	}
	return raw
}

func lastLine(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	return lines[len(lines)-1]
}

// The paths the end-to-end cases reach only through other layers, as direct tests so the coverage
// stays whole.

func TestWorkerPlumbing(t *testing.T) {
	t.Run("caps name the engine and its terms", func(t *testing.T) {
		caps := newPiWorker("", 30_000).Caps()
		if caps.Name != ports.WorkerNamePiRPC || caps.SessionKey != ports.SessionKeyCaller ||
			caps.NativeSchema || caps.Budget {
			t.Errorf("caps = %+v, want the pi RPC terms", caps)
		}
		wantEfforts := []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}
		if !reflect.DeepEqual(caps.Efforts, wantEfforts) {
			t.Errorf("efforts = %v, want %v", caps.Efforts, wantEfforts)
		}
		if !strings.Contains(caps.BriefNotes.Readonly, "read,grep,find,ls") {
			t.Errorf("readonly note = %q, want the narrowed tool list", caps.BriefNotes.Readonly)
		}
	})

	t.Run("dispose releases nothing: one pi per attempt", func(t *testing.T) {
		if err := newPiWorker("", 30_000).Dispose(context.Background()); err != nil {
			t.Errorf("dispose = %v, want nil", err)
		}
	})

	t.Run("handshake errors map to the port's kinds, and an exit is no error at all", func(t *testing.T) {
		for _, row := range []struct {
			kind ports.WorkerErrorKind
			rpc  RpcErrorKind
		}{
			{ports.WorkerErrorSpawnFailed, RpcErrorStart},
			{ports.WorkerErrorProtocol, RpcErrorProtocol},
			{ports.WorkerErrorProtocol, RpcErrorRejected},
			{ports.WorkerErrorProtocol, RpcErrorTimeout},
			{ports.WorkerErrorProtocol, RpcErrorClosed},
		} {
			got := handshakeError(&RpcError{Kind: row.rpc, Message: "no answer"})
			if got == nil || got.Kind != row.kind || got.Message != "no answer" {
				t.Errorf("handshakeError(%s) = %+v, want a %s carrying the message", row.rpc, got, row.kind)
			}
		}
		if got := handshakeError(&RpcError{Kind: RpcErrorExited, Message: "pi ended"}); got != nil {
			t.Errorf("handshakeError(exited) = %+v, want none: the run finished without starting", got)
		}
	})

	t.Run("a pi that dies before the handshake ran nothing: no events, the exit tells the story", func(t *testing.T) {
		parent := domain.EnvLookup{}
		for name, value := range workerParentEnv {
			parent[name] = value
		}
		parent[engineChildEnv] = "early-death"
		spec, _ := jobSpec(t, nil, specOverrides{})
		run, err := NewPiRpcWorker(PiRpcWorkerOptions{
			Bin:                selfExe(t),
			ParentEnv:          parent,
			Withheld:           workerWithheld,
			StopGraceMs:        100,
			HandshakeTimeoutMs: 30_000,
		}).Start(context.Background(), spec)
		if err != nil {
			t.Fatalf("start: %v (a pre-handshake death is not a worker error)", err)
		}
		for range run.Events() {
			t.Fatal("a run that never started yielded an event")
		}
		exit := run.Wait()
		if exit.Code == nil || *exit.Code != 3 || exit.StderrTail != "early death\n" {
			t.Fatalf("exit = %+v, want the early death's code 3 and stderr", exit)
		}
		assertNoEnginePid(t, spec)
	})

	t.Run("the bin defaults to pi from PATH", func(t *testing.T) {
		t.Setenv("PATH", t.TempDir())
		spec, _ := jobSpec(t, nil, specOverrides{})
		_, err := NewPiRpcWorker(PiRpcWorkerOptions{
			ParentEnv:          domain.EnvLookup{"PATH": os.Getenv("PATH")},
			Withheld:           workerWithheld,
			StopGraceMs:        100,
			HandshakeTimeoutMs: 200,
		}).Start(context.Background(), spec)
		var workerErr *ports.WorkerError
		if !errors.As(err, &workerErr) || workerErr.Kind != ports.WorkerErrorSpawnFailed {
			t.Fatalf("error = %+v, want a spawn failure for a pi missing from PATH", err)
		}
		if !strings.Contains(workerErr.Message, "pi") {
			t.Errorf("message = %q, want it to name pi", workerErr.Message)
		}
	})

	t.Run("commandsLog names the frames log's sibling, or the path itself", func(t *testing.T) {
		if got := commandsLog("dir/attempt-0001.jsonl"); got != "dir/attempt-0001.rpc-in.jsonl" {
			t.Errorf("commandsLog(.jsonl) = %q", got)
		}
		if got := commandsLog("dir/attempt.log"); got != "dir/attempt.log" {
			t.Errorf("commandsLog(other) = %q, want the path itself", got)
		}
	})

	t.Run("forcedReason keeps the port's reasons", func(t *testing.T) {
		if got := forcedReason(ports.InterruptStopped); got != process.ForcedStopped {
			t.Errorf("forcedReason(stopped) = %q", got)
		}
		if got := forcedReason(ports.InterruptTimeout); got != process.ForcedTimeout {
			t.Errorf("forcedReason(timeout) = %q", got)
		}
	})

	t.Run("countValue takes only finite numbers", func(t *testing.T) {
		for _, row := range []struct {
			raw  json.RawMessage
			want float64
		}{
			{json.RawMessage(`7`), 7},
			{json.RawMessage(`1.5`), 1.5},
			{json.RawMessage(`null`), 0},
			{json.RawMessage(`"3"`), 0},
			{json.RawMessage(`{`), 0},
			{nil, 0},
		} {
			if got := countValue(row.raw); got != row.want {
				t.Errorf("countValue(%s) = %v, want %v", row.raw, got, row.want)
			}
		}
	})

	t.Run("pickValue takes only finite numbers, else the fallback", func(t *testing.T) {
		if got := pickValue(3.25, 0); got != 3.25 {
			t.Errorf("pickValue(3.25) = %v", got)
		}
		if got := pickValue("three", 1.5); got != 1.5 {
			t.Errorf("pickValue(three) = %v, want the fallback", got)
		}
		if got := pickValue(math.Inf(1), 1.5); got != 1.5 {
			t.Errorf("pickValue(Inf) = %v, want the fallback", got)
		}
	})

	t.Run("engineResultLine swaps the type in place, and leaves other lines alone", func(t *testing.T) {
		if got := engineResultLine([]byte(`{"type":"result","isError":false}`)); got != `{"type":"engine_result","isError":false}` {
			t.Errorf("engineResultLine(result) = %s", got)
		}
		if got := engineResultLine([]byte(`{"type":"other"}`)); got != `{"type":"other"}` {
			t.Errorf("engineResultLine(other) = %s, want the line itself", got)
		}
	})

	t.Run("appendEngineResult tolerates an event it cannot write and a log it cannot open", func(t *testing.T) {
		appendEngineResult(filepath.Join(t.TempDir(), "attempt.jsonl"), domain.WorkerEvent{Kind: "bogus"})
		blocker := filepath.Join(t.TempDir(), "not-a-dir")
		if err := os.WriteFile(blocker, []byte("occupied"), 0o644); err != nil {
			t.Fatal(err)
		}
		appendEngineResult(filepath.Join(blocker, "attempt.jsonl"), domain.WorkerEvent{Kind: domain.WorkerEventResult})
	})
}
