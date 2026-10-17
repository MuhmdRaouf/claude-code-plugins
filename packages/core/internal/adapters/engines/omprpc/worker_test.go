package omprpc

// The OmpRpcWorker tests: argv, environment and session flags; the run's events and
// synthesized result; the report corrections;
// interrupt, timeout and crash; and the ParseLine fold over crafted frames. The fake omp runs as
// this binary's own child (fakeomp_test.go), so no test can ever start the user's real omp: every
// start passes the test binary itself as the bin, or a path that does not exist.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/shared"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// The environment the orchestrator runs in: the user's own (HOME, a key of the user's own for
// omp's own provider) plus what the plugin and the Claude Code session added (the plugin's key and
// knobs, the router URL). ENGINE_TEST_CHILD makes the test binary the fake when re-executed.
var parentEnv = domain.EnvLookup{
	"PATH":               os.Getenv("PATH"),
	"HOME":               os.Getenv("HOME"),
	"OPENROUTER_API_KEY": "users-own-key",
	"ZAI_API_KEY":        "plugin-provider-key",
	"ZAI_BASE_URL":       "https://api.z.ai/api/anthropic",
	"ZAI_MODEL_MAIN":     "glm-5.3",
	"ANTHROPIC_BASE_URL": "http://127.0.0.1:18787",
	"CLAUDECODE":         "1",
	childModeEnv:         "omp",
}

// withheld names the plugin's provider variables, as engine-wire withholds them.
func withheld(name string) bool {
	return name == "ZAI_API_KEY" || strings.HasPrefix(name, "ZAI_")
}

// The session id the fake's get_state reports (the engine owns the session) and the caller's key.
const engineSession = fakeSessionID
const newSession = "00000000-0000-7000-8000-000000000001"

// reportText is a space-free report so the fake streams it as one text delta.
const reportText = `{"summary":"renamed-foo.ts-to-bar.ts","files":[],"tests_added":[],"open_items":[]}`

// newWorker builds the worker: the fake's binary, a 2 s stop grace and a 30 s handshake timeout.
func newWorker(t *testing.T, bin string, handshakeTimeoutMs int64) *OmpRpcWorker {
	t.Helper()
	if handshakeTimeoutMs == 0 {
		handshakeTimeoutMs = 30_000
	}
	return NewOmpRpcWorker(OmpRpcWorkerOptions{
		Bin:                bin,
		ParentEnv:          parentEnv,
		Withheld:           withheld,
		StopGraceMs:        2_000,
		HandshakeTimeoutMs: handshakeTimeoutMs,
	})
}

// fakeEnv is the fake's own environment for a run: the child mode plus the scenario's knobs, and
// GOCOVERDIR when the test run itself is covered (so the re-executed fake stays silent).
func fakeEnv(t *testing.T, extra map[string]string) map[string]string {
	t.Helper()
	env := map[string]string{childModeEnv: "omp"}
	if dir := os.Getenv("GOCOVERDIR"); dir != "" {
		env["GOCOVERDIR"] = dir
	}
	for name, value := range extra {
		env[name] = value
	}
	return env
}

// specOverrides are the knobs the adapter tests turn; nil keeps jobSpec's default.
type specOverrides struct {
	access    *ports.Access
	effort    *string
	addDirs   []string
	session   *ports.WorkerSession
	timeoutMs *int64
}

func jobSpec(t *testing.T, passEnv map[string]string, overrides specOverrides) (ports.WorkerSpec, string) {
	t.Helper()
	dir := t.TempDir()
	spec := ports.WorkerSpec{
		Cwd:     dir,
		Model:   testkit.ReferenceProvider.Catalog[domain.ModelTierMain],
		Access:  ports.AccessWrite,
		Prompt:  "Rename foo.ts to bar.ts.",
		Session: ports.WorkerSession{Kind: ports.SessionKindNew, Key: newSession},
		Report: ports.ReportContract{
			Name:       "change.json",
			JSONSchema: json.RawMessage(`{"type":"object"}`),
			Validate: func(report json.RawMessage) domain.ReportCheck {
				return domain.CheckReport(report, domain.ReportContract{Kind: domain.ReportContractFile})
			},
		},
		AddDirs:   []string{},
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

func selfExe(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	return exe
}

// startRun starts one run, stopping it when the test ends if it is still alive.
func startRun(t *testing.T, spec ports.WorkerSpec) *ompRun {
	t.Helper()
	run, err := newWorker(t, selfExe(t), 0).Start(context.Background(), spec)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	pidFile := domain.EnginePidBeside(spec.LogPath)
	t.Cleanup(func() {
		if pid, ok := adapters.ReadEnginePid(pidFile); ok && testkit.IsPidAlive(int(pid)) {
			_ = run.Interrupt(context.Background(), ports.InterruptStopped)
			_ = run.Wait()
		}
	})
	return run.(*ompRun)
}

// eventLog collects a run's events off the Events channel; the test goroutine may read it while
// the collector is still appending.
type eventLog struct {
	mu   sync.Mutex
	seen []domain.WorkerEvent
}

func (l *eventLog) add(event domain.WorkerEvent) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.seen = append(l.seen, event)
}

func (l *eventLog) all() []domain.WorkerEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]domain.WorkerEvent(nil), l.seen...)
}

// waitFor resolves with the first event of the kind, failing the test after 10 s.
func (l *eventLog) waitFor(t *testing.T, kind domain.WorkerEventKind, match func(domain.WorkerEvent) bool) domain.WorkerEvent {
	t.Helper()
	if match == nil {
		match = func(domain.WorkerEvent) bool { return true }
	}
	var found domain.WorkerEvent
	err := testkit.Until(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		for _, event := range l.seen {
			if event.Kind == kind && match(event) {
				found = event
				return true
			}
		}
		return false
	}, testkit.UntilOptions{Message: "event did not arrive"})
	if err != nil {
		t.Fatal(err)
	}
	return found
}

// collectEvents pumps events eagerly; done closes only once the Events channel has closed (after
// the engine_result line is appended).
func collectEvents(run ports.WorkerRun) (*eventLog, chan struct{}) {
	log := &eventLog{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for event := range run.Events() {
			log.add(event)
		}
	}()
	return log, done
}

func logLines(t *testing.T, path string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log %s: %v", path, err)
	}
	var lines []string
	for _, line := range strings.Split(string(raw), "\n") {
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

// promptsSent reads the prompts the run sent back from the frames log (the commands log stores
// prompts as a $ref).
func promptsSent(t *testing.T, spec ports.WorkerSpec) []string {
	t.Helper()
	var prompts []string
	for _, line := range logLines(t, spec.LogPath) {
		frame, reason := parseFrame(line)
		if reason != "" || frameType(frame) != "message_end" {
			continue
		}
		var message map[string]json.RawMessage
		if json.Unmarshal(frame["message"], &message) != nil || rawString(message["role"]) != "user" {
			continue
		}
		var parts []map[string]json.RawMessage
		if json.Unmarshal(message["content"], &parts) != nil {
			continue
		}
		var text strings.Builder
		for _, part := range parts {
			text.WriteString(rawString(part["text"]))
		}
		prompts = append(prompts, text.String())
	}
	return prompts
}

// finishRun drives a run to its end (exit seen, events channel drained).
func finishRun(t *testing.T, spec ports.WorkerSpec) ([]domain.WorkerEvent, ports.WorkerExit) {
	t.Helper()
	run := startRun(t, spec)
	log, done := collectEvents(run)
	exit := run.Wait()
	<-done
	return log.all(), exit
}

// recordedRun is one full run with the argv/env recorders on; it fails unless the fake exited 0.
type recordedRun struct {
	argv   []string
	env    map[string]string
	jobDir string
	spec   ports.WorkerSpec
}

func recordRun(t *testing.T, passEnv map[string]string, overrides specOverrides) recordedRun {
	t.Helper()
	logs := t.TempDir()
	spec, dir := jobSpec(t, fakeEnv(t, map[string]string{
		"FAKE_OMP_ARGV_LOG": filepath.Join(logs, "argv.json"),
		"FAKE_OMP_ENV_LOG":  filepath.Join(logs, "env.json"),
		"FAKE_OMP_SCENARIO": "ok",
	}), overrides)
	for name, value := range passEnv {
		spec.PassEnv[name] = value
	}
	run := startRun(t, spec)
	_, done := collectEvents(run)
	exit := run.Wait()
	<-done
	if exit.Code == nil || *exit.Code != 0 {
		t.Fatalf("fake omp exited with %+v: %s", exit.Code, exit.StderrTail)
	}
	var recorded recordedRun
	if err := json.Unmarshal([]byte(strings.Join(logLines(t, filepath.Join(logs, "argv.json")), "")), &recorded.argv); err != nil {
		t.Fatalf("read argv.json: %v", err)
	}
	recorded.env = map[string]string{}
	if err := json.Unmarshal([]byte(strings.Join(logLines(t, filepath.Join(logs, "env.json")), "")), &recorded.env); err != nil {
		t.Fatalf("read env.json: %v", err)
	}
	recorded.jobDir = dir
	recorded.spec = spec
	return recorded
}

// decodeRaw reads raw JSON as a plain value, so two raws compare by structure (nil is null).
func decodeRaw(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}

// eventEqual compares two events field for field, with the cost compared within a small
// tolerance and the report compared as decoded JSON.
func eventEqual(got, want domain.WorkerEvent) bool {
	costsClose := got.CostUSD == want.CostUSD || math.Abs(got.CostUSD-want.CostUSD) <= 1e-9
	got.CostUSD, want.CostUSD = 0, 0
	structures := reflect.DeepEqual(decodeRaw(got.StructuredOutput), decodeRaw(want.StructuredOutput))
	got.StructuredOutput, want.StructuredOutput = nil, nil
	return costsClose && structures && reflect.DeepEqual(got, want)
}

func formatEvents(events []domain.WorkerEvent) string {
	raw, err := json.Marshal(events)
	if err != nil {
		return fmt.Sprintf("%+v", events)
	}
	return string(raw)
}

func assertEvents(t *testing.T, got, want []domain.WorkerEvent) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("events = %s, want %s", formatEvents(got), formatEvents(want))
	}
	for i := range got {
		if !eventEqual(got[i], want[i]) {
			t.Errorf("event %d = %s, want %s", i, formatEvents([]domain.WorkerEvent{got[i]}), formatEvents([]domain.WorkerEvent{want[i]}))
		}
	}
}

func assertExit(t *testing.T, got, want ports.WorkerExit) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("exit = %+v, want %+v", got, want)
	}
}

// lastResult is the run's result event, when it ended with one.
func lastResult(t *testing.T, seen []domain.WorkerEvent) domain.WorkerEvent {
	t.Helper()
	if len(seen) == 0 || seen[len(seen)-1].Kind != domain.WorkerEventResult {
		t.Fatalf("events ended without a result: %s", formatEvents(seen))
	}
	return seen[len(seen)-1]
}

func TestOmpRpcWorker(t *testing.T) {
	t.Run("readonly runs with narrowed tools and no approvals; omp keeps its own model, setup and environment", func(t *testing.T) {
		run := recordRun(t, map[string]string{
			"ZAI_API_KEY": "brief-supplied", "OMP_CONFIG": "/elsewhere", "OTHER_API_KEY": "x", "GREETING": "hi",
		}, specOverrides{access: ptr(ports.AccessReadonly)})
		wantArgv := []string{"--mode", "rpc", "--no-ui", "--tools", "read,grep,glob", "--approval-mode", "yolo", "--no-title"}
		if !reflect.DeepEqual(run.argv, wantArgv) {
			t.Fatalf("argv = %q, want %q", strings.Join(run.argv, " "), strings.Join(wantArgv, " "))
		}
		// The user's own environment reaches omp; nothing of the plugin's provider or the Claude
		// session does, and a brief cannot hand omp a key or re-route its config.
		for name, want := range map[string]string{
			"HOME":               os.Getenv("HOME"),
			"OPENROUTER_API_KEY": "users-own-key",
			"GREETING":           "hi",
		} {
			if run.env[name] != want {
				t.Errorf("env[%s] = %q, want %q", name, run.env[name], want)
			}
		}
		for _, name := range []string{"ZAI_API_KEY", "ZAI_BASE_URL", "ZAI_MODEL_MAIN", "ANTHROPIC_BASE_URL", "CLAUDECODE"} {
			if _, ok := run.env[name]; ok {
				t.Errorf("env holds %s, which belongs to the plugin's provider or the session", name)
			}
		}
		for _, name := range []string{"OMP_CONFIG", "OTHER_API_KEY", "PI_CODING_AGENT_DIR"} {
			if _, ok := run.env[name]; ok {
				t.Errorf("env holds %s, which a brief may not set", name)
			}
		}
		if leaked, _ := json.Marshal([]any{run.argv, run.env}); strings.Contains(string(leaked), "plugin-provider-key") ||
			strings.Contains(string(leaked), "api.z.ai") || strings.Contains(string(leaked), "18787") {
			t.Errorf("argv or env leaks the plugin's provider: %s", leaked)
		}
		entries, err := os.ReadDir(run.jobDir)
		if err != nil {
			t.Fatalf("read job dir: %v", err)
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "engine") {
				t.Errorf("job dir still holds %s after the run", entry.Name())
			}
		}
	})

	for _, access := range []ports.Access{ports.AccessWrite, ports.AccessExec} {
		t.Run(string(access)+" runs with the full tool list and yolo approvals", func(t *testing.T) {
			run := recordRun(t, nil, specOverrides{access: ptr(access)})
			tools := "read,grep,glob,edit,write,bash,todo"
			if access == ports.AccessExec {
				tools = "read,grep,glob,bash"
			}
			wantArgv := []string{"--mode", "rpc", "--no-ui", "--tools", tools, "--approval-mode", "yolo", "--no-title"}
			if !reflect.DeepEqual(run.argv, wantArgv) {
				t.Fatalf("argv = %q, want %q", strings.Join(run.argv, " "), strings.Join(wantArgv, " "))
			}
		})
	}

	t.Run("passes effort, addDirs and the engine session id as their own flags", func(t *testing.T) {
		run := recordRun(t, nil, specOverrides{
			access:  ptr(ports.AccessReadonly),
			effort:  ptr("high"),
			addDirs: []string{"/refs/one", "/refs/two"},
			session: &ports.WorkerSession{Kind: ports.SessionKindResume, Key: engineSession},
		})
		wantArgv := []string{
			"--mode", "rpc", "--no-ui", "--thinking", "high", "--tools", "read,grep,glob",
			"--approval-mode", "yolo", "--no-title",
			"--add-dir", "/refs/one", "--add-dir", "/refs/two", "--resume", engineSession,
		}
		if !reflect.DeepEqual(run.argv, wantArgv) {
			t.Fatalf("argv = %q, want %q", strings.Join(run.argv, " "), strings.Join(wantArgv, " "))
		}
	})

	t.Run("a completed run yields session, text and a result with usage and report, logged as engine_result", func(t *testing.T) {
		finalText := reportText
		spec, _ := jobSpec(t, fakeEnv(t, map[string]string{"FAKE_OMP_FINAL_TEXT": finalText}), specOverrides{})
		seen, exit := finishRun(t, spec)
		assertExit(t, exit, ports.WorkerExit{Code: ptr(int64(0))})
		// The fake streams "Working on it." as 3 deltas (it splits after each space) and the report
		// as 1.
		wantKinds := []domain.WorkerEventKind{
			domain.WorkerEventSession,
			domain.WorkerEventTextDelta, domain.WorkerEventTextDelta, domain.WorkerEventTextDelta, domain.WorkerEventTextDelta,
			domain.WorkerEventAssistantText,
			domain.WorkerEventResult,
		}
		if got := kindsOf(seen); !reflect.DeepEqual(got, wantKinds) {
			t.Fatalf("event kinds = %v, want %v", got, wantKinds)
		}
		if !reflect.DeepEqual(seen[0], domain.WorkerEvent{Kind: domain.WorkerEventSession, SessionID: engineSession}) {
			t.Errorf("first event = %+v, want the engine's session", seen[0])
		}
		var deltas strings.Builder
		for _, event := range seen {
			if event.Kind == domain.WorkerEventTextDelta {
				deltas.WriteString(event.Text)
			}
		}
		if deltas.String() != "Working on it."+finalText {
			t.Errorf("text deltas = %q, want %q", deltas.String(), "Working on it."+finalText)
		}
		result := lastResult(t, seen)
		if result.IsError || result.Text != finalText || result.Turns != 1 {
			t.Errorf("result = %+v, want the final text after one turn", result)
		}
		if !reflect.DeepEqual(decodeRaw(result.StructuredOutput), decodeRaw(json.RawMessage(reportText))) {
			t.Errorf("structuredOutput = %s, want %s", result.StructuredOutput, reportText)
		}
		if result.Usage != (domain.ResultUsage{InputTokens: 100, OutputTokens: 20, CacheReadTokens: 50}) || result.CostUSD != 0.0001 {
			t.Errorf("usage = %+v, cost %v, want the fake's one assistant message", result.Usage, result.CostUSD)
		}
		if result.APIErrorStatus != nil {
			t.Errorf("apiErrorStatus = %v, want none", *result.APIErrorStatus)
		}
		if result.Model == nil || *result.Model != "zai/glm-5.3" {
			t.Errorf("model = %v, want zai/glm-5.3", result.Model)
		}
		if result.DurationMs < 0 {
			t.Errorf("durationMs = %d, want a non-negative span", result.DurationMs)
		}
		logged := logLines(t, spec.LogPath)
		lastLine := logged[len(logged)-1]
		if parsedLine(t, lastLine)["type"] != "engine_result" {
			t.Fatalf("last log line is %s, want an engine_result", lastLine)
		}
		assertEvents(t, newWorker(t, selfExe(t), 0).ParseLine(lastLine), []domain.WorkerEvent{result})
		var commands []map[string]any
		for _, line := range logLines(t, strings.TrimSuffix(spec.LogPath, ".jsonl")+".rpc-in.jsonl") {
			commands = append(commands, parsedLine(t, line))
		}
		var prompts int
		for _, command := range commands {
			if command["type"] == "prompt" {
				prompts++
			}
		}
		if prompts != 1 {
			t.Errorf("prompt commands = %d, want 1", prompts)
		}
	})

	t.Run("an invalid report draws up to two correction prompts in the same session, and the result carries the problems", func(t *testing.T) {
		// The fake's default final text is "done": no JSON, so every turn's report is missing.
		spec, _ := jobSpec(t, fakeEnv(t, nil), specOverrides{})
		seen, exit := finishRun(t, spec)
		if exit.Code == nil || *exit.Code != 0 {
			t.Fatalf("exit = %+v, want exit 0", exit)
		}
		prompts := promptsSent(t, spec)
		if len(prompts) != 3 {
			t.Fatalf("prompts sent = %d, want 3:\n%s", len(prompts), strings.Join(prompts, "\n---\n"))
		}
		if !strings.Contains(prompts[0], "## Final report") {
			t.Errorf("first prompt = %q, want the report contract", prompts[0])
		}
		for _, correction := range prompts[1:] {
			if !strings.Contains(correction, "Your report was invalid: no structured report") ||
				!strings.Contains(correction, "Reply with only the corrected JSON object.") {
				t.Errorf("correction prompt = %q, want the problems and the instruction", correction)
			}
		}
		result := lastResult(t, seen)
		if result.IsError || result.Text != "done" || result.StructuredOutput != nil || result.Turns != 3 {
			t.Errorf("result = %+v, want the final text, no report, three turns", result)
		}
		if result.Usage != (domain.ResultUsage{InputTokens: 300, OutputTokens: 60, CacheReadTokens: 150}) {
			t.Errorf("usage = %+v, want three assistant messages", result.Usage)
		}
		if math.Abs(result.CostUSD-0.0003) > 1e-9 {
			t.Errorf("costUsd = %v, want 0.0003", result.CostUSD)
		}
	})

	t.Run("extracts the report from a ```json fence when the final text is not pure JSON", func(t *testing.T) {
		spec, _ := jobSpec(t, fakeEnv(t, map[string]string{
			"FAKE_OMP_FINAL_TEXT": "Here you go:\n```json\n" + reportText + "\n```",
		}), specOverrides{})
		seen, exit := finishRun(t, spec)
		if exit.Code == nil || *exit.Code != 0 {
			t.Fatalf("exit = %+v, want exit 0", exit)
		}
		result := lastResult(t, seen)
		if result.IsError || result.Turns != 1 || !reflect.DeepEqual(decodeRaw(result.StructuredOutput), decodeRaw(json.RawMessage(reportText))) {
			t.Errorf("result = %+v, want the fenced report after one turn", result)
		}
	})

	t.Run("extracts the report from the outermost braces in prose", func(t *testing.T) {
		spec, _ := jobSpec(t, fakeEnv(t, map[string]string{
			"FAKE_OMP_FINAL_TEXT": "Sure! " + reportText + " — done.",
		}), specOverrides{})
		seen, exit := finishRun(t, spec)
		if exit.Code == nil || *exit.Code != 0 {
			t.Fatalf("exit = %+v, want exit 0", exit)
		}
		result := lastResult(t, seen)
		if result.IsError || result.Turns != 1 || !reflect.DeepEqual(decodeRaw(result.StructuredOutput), decodeRaw(json.RawMessage(reportText))) {
			t.Errorf("result = %+v, want the braced report after one turn", result)
		}
	})

	t.Run("keeps a multi-key report's key order in the result and the engine_result line", func(t *testing.T) {
		report := `{"zeta":1,"alpha":2}`
		spec, _ := jobSpec(t, fakeEnv(t, map[string]string{"FAKE_OMP_FINAL_TEXT": report}), specOverrides{})
		seen, exit := finishRun(t, spec)
		if exit.Code == nil || *exit.Code != 0 {
			t.Fatalf("exit = %+v, want exit 0", exit)
		}
		result := lastResult(t, seen)
		// Byte for byte, as JSON.stringify wrote it: a decoded map would re-render it sorted.
		if string(result.StructuredOutput) != report {
			t.Errorf("structuredOutput = %s, want %s", result.StructuredOutput, report)
		}
		lastLine := logLines(t, spec.LogPath)[len(logLines(t, spec.LogPath))-1]
		if !strings.Contains(lastLine, `"structuredOutput":`+report) {
			t.Errorf("engine_result line = %s, want the report in its written order", lastLine)
		}
	})

	t.Run("a prompt that ran no agent ends without a final message, and the result says so", func(t *testing.T) {
		spec, _ := jobSpec(t, fakeEnv(t, map[string]string{"FAKE_OMP_NO_AGENT": "1"}), specOverrides{})
		seen, exit := finishRun(t, spec)
		assertExit(t, exit, ports.WorkerExit{Code: ptr(int64(0))})
		result := lastResult(t, seen)
		if !result.IsError || result.Text != "worker stopped without finishing (stopReason )" ||
			result.StructuredOutput != nil || result.Turns != 0 {
			t.Errorf("result = %+v, want an unfinished run with no report and no turns", result)
		}
	})

	t.Run("an omp that exits on an unknown resume reports sessionMissing and emits nothing", func(t *testing.T) {
		resumeKey := "01a11109-0000-7000-8000-0000000000ff"
		spec, _ := jobSpec(t, fakeEnv(t, map[string]string{"FAKE_OMP_RESUME_MISSING": "1"}),
			specOverrides{session: &ports.WorkerSession{Kind: ports.SessionKindResume, Key: resumeKey}})
		seen, exit := finishRun(t, spec)
		if len(seen) != 0 {
			t.Fatalf("events = %s, want none", formatEvents(seen))
		}
		assertExit(t, exit, ports.WorkerExit{
			Code:           ptr(int64(1)),
			StderrTail:     fmt.Sprintf("Session %q not found.\n", resumeKey),
			SessionMissing: true,
		})
	})

	t.Run("interrupt mid-tool stops the run and leaves no process behind", func(t *testing.T) {
		spec, _ := jobSpec(t, fakeEnv(t, map[string]string{"FAKE_OMP_SCENARIO": "sleep"}), specOverrides{})
		run := startRun(t, spec)
		log, done := collectEvents(run)
		// The exit is racy by design (the soft abort races the group kill), so only the forced
		// reason is asserted.
		log.waitFor(t, domain.WorkerEventToolUse, func(event domain.WorkerEvent) bool { return event.Name == "bash" })
		pid, ok := adapters.ReadEnginePid(domain.EnginePidBeside(spec.LogPath))
		if !ok || pid != run.Pid() {
			t.Fatalf("engine pid = %d (ok %v), want the running group leader %d", pid, ok, run.Pid())
		}
		if err := run.Interrupt(context.Background(), ports.InterruptStopped); err != nil {
			t.Fatalf("interrupt: %v", err)
		}
		exit := run.Wait()
		<-done
		if exit.Forced == nil || *exit.Forced != domain.ForcedStopped {
			t.Fatalf("exit = %+v, want a forced stop", exit)
		}
		if testkit.IsPidAlive(int(run.Pid())) {
			t.Fatalf("process %d is still alive after the interrupt", run.Pid())
		}
	})

	t.Run("the wall clock times the run out and the group dies", func(t *testing.T) {
		// The wall clock starts at spawn, before the fake has even booted: 2 s leaves a loaded box
		// room to boot and handshake, and the sleep scenario still runs far longer than that.
		spec, _ := jobSpec(t, fakeEnv(t, map[string]string{"FAKE_OMP_SCENARIO": "sleep"}), specOverrides{timeoutMs: ptr(int64(2_000))})
		run := startRun(t, spec)
		_, done := collectEvents(run)
		exit := run.Wait()
		<-done
		if exit.Forced == nil || *exit.Forced != domain.ForcedTimeout {
			t.Fatalf("exit = %+v, want a forced timeout", exit)
		}
		if testkit.IsPidAlive(int(run.Pid())) {
			t.Fatalf("process %d is still alive after the timeout", run.Pid())
		}
	})

	// A scenario no recorded run meets (an omp that dies mid-handshake with frames in flight):
	// the leftover frames fold nowhere and the exit carries the story.
	t.Run("an omp that dies right after ready emits nothing and exits", func(t *testing.T) {
		spec, _ := jobSpec(t, fakeEnv(t, map[string]string{"FAKE_OMP_DIE_AFTER_READY": "1"}), specOverrides{})
		seen, exit := finishRun(t, spec)
		if len(seen) != 0 {
			t.Fatalf("events = %s, want none", formatEvents(seen))
		}
		assertExit(t, exit, ports.WorkerExit{Code: ptr(int64(1))})
	})

	t.Run("a crashed run emits no result", func(t *testing.T) {
		spec, _ := jobSpec(t, fakeEnv(t, map[string]string{"FAKE_OMP_SCENARIO": "crash"}), specOverrides{})
		seen, exit := finishRun(t, spec)
		if got := kindsOf(seen); !reflect.DeepEqual(got, []domain.WorkerEventKind{domain.WorkerEventSession}) {
			t.Fatalf("event kinds = %v, want only the session", got)
		}
		assertExit(t, exit, ports.WorkerExit{
			Code:       ptr(int64(1)),
			StderrTail: "fake omp: simulated crash\n",
		})
	})

	t.Run("parseLine folds a recorded transcript into the expected event kinds", func(t *testing.T) {
		worker := newWorker(t, selfExe(t), 0)
		events := func(name string) []domain.WorkerEvent {
			var folded []domain.WorkerEvent
			for _, line := range logLines(t, filepath.Join(fixturesDir(), name, "stdout.jsonl")) {
				folded = append(folded, worker.ParseLine(line)...)
			}
			return folded
		}
		if got := kindsOf(events("success-readonly")); !reflect.DeepEqual(got, []domain.WorkerEventKind{
			domain.WorkerEventSession, domain.WorkerEventTextDelta, domain.WorkerEventAssistantText,
		}) {
			t.Errorf("success-readonly kinds = %v", got)
		}
		limited := events("rate-limited-429.synthetic")
		if got := kindsOf(limited); !reflect.DeepEqual(got, []domain.WorkerEventKind{
			domain.WorkerEventSession, domain.WorkerEventTextDelta,
			domain.WorkerEventError, domain.WorkerEventAPIRetry,
			domain.WorkerEventError, domain.WorkerEventAPIRetry,
			domain.WorkerEventAssistantText,
		}) {
			t.Errorf("rate-limited kinds = %v", got)
		}
		var statuses []int64
		for _, event := range limited {
			if event.Kind == domain.WorkerEventAPIRetry && event.Status != nil {
				statuses = append(statuses, *event.Status)
			}
		}
		if !reflect.DeepEqual(statuses, []int64{429, 429}) {
			t.Errorf("retry statuses = %v, want [429 429]", statuses)
		}
	})

	t.Run("preflight needs nothing of the plugin's: omp brings its own login", func(t *testing.T) {
		if err := newWorker(t, selfExe(t), 0).Preflight(context.Background()); err != nil {
			t.Fatalf("preflight: %v", err)
		}
	})

	t.Run("reports a missing binary as spawn_failed", func(t *testing.T) {
		spec, _ := jobSpec(t, fakeEnv(t, nil), specOverrides{})
		_, err := newWorker(t, "/nonexistent/omp", 0).Start(context.Background(), spec)
		if err == nil {
			t.Fatal("start of a missing binary succeeded")
		}
		var workerErr *ports.WorkerError
		if !asWorkerError(err, &workerErr) || workerErr.Kind != ports.WorkerErrorSpawnFailed || !strings.Contains(workerErr.Message, "ENOENT") {
			t.Fatalf("error = %v, want spawn_failed naming ENOENT", err)
		}
	})

	t.Run("reports a protocol-1 omp as protocol", func(t *testing.T) {
		spec, _ := jobSpec(t, fakeEnv(t, map[string]string{"FAKE_OMP_PROTOCOLS": "1"}), specOverrides{})
		_, err := newWorker(t, selfExe(t), 0).Start(context.Background(), spec)
		if err == nil {
			t.Fatal("start of a protocol-1 omp succeeded")
		}
		var workerErr *ports.WorkerError
		if !asWorkerError(err, &workerErr) || workerErr.Kind != ports.WorkerErrorProtocol || !strings.Contains(workerErr.Message, "protocol 1") {
			t.Fatalf("error = %v, want protocol naming protocol 1", err)
		}
	})

	t.Run("reports a handshake that never answers as protocol", func(t *testing.T) {
		spec, _ := jobSpec(t, fakeEnv(t, map[string]string{"FAKE_OMP_READY_DELAY_MS": "5000"}), specOverrides{})
		_, err := newWorker(t, selfExe(t), 300).Start(context.Background(), spec)
		if err == nil {
			t.Fatal("start of a silent omp succeeded")
		}
		var workerErr *ports.WorkerError
		if !asWorkerError(err, &workerErr) || workerErr.Kind != ports.WorkerErrorProtocol || !strings.Contains(workerErr.Message, "handshake") {
			t.Fatalf("error = %v, want protocol naming the handshake", err)
		}
	})
}

func TestParseLineOverCraftedFrames(t *testing.T) {
	worker := newWorker(t, selfExe(t), 0)
	// fold runs one frame through the fold, as ParseLine would read it from a log.
	fold := func(frame string) []domain.WorkerEvent {
		return worker.ParseLine(frame)
	}

	t.Run("returns nothing for a line that is not JSON or a frame the fold does not know", func(t *testing.T) {
		if got := worker.ParseLine("this is not json"); got != nil {
			t.Errorf("non-JSON line folded to %s", formatEvents(got))
		}
		if got := fold(`{"type":"notice"}`); got != nil {
			t.Errorf("notice folded to %s", formatEvents(got))
		}
		if got := fold(`{"type":"session_settled"}`); got != nil {
			t.Errorf("session_settled folded to %s", formatEvents(got))
		}
	})

	t.Run("folds responses: the session id, refusals, and quiet successes", func(t *testing.T) {
		if got := fold(`{"type":"response"}`); got != nil {
			t.Errorf("unguarded response folded to %s", formatEvents(got))
		}
		if got := fold(`{"type":"response","command":"get_state","success":true,"data":{}}`); got != nil {
			t.Errorf("sessionless get_state folded to %s", formatEvents(got))
		}
		assertEvents(t, fold(`{"type":"response","command":"get_state","success":true,"data":{"sessionId":"s1"}}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventSession, SessionID: "s1"}})
		assertEvents(t, fold(`{"type":"response","command":"frobnicate","success":false,"error":"no such command"}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventError, Message: "no such command"}})
		assertEvents(t, fold(`{"type":"response","command":"frobnicate","success":false}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventError, Message: "omp refused frobnicate"}})
	})

	t.Run("folds message updates: only string text deltas", func(t *testing.T) {
		assertEvents(t, fold(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hi"}}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventTextDelta, Text: "hi"}})
		if got := fold(`{"type":"message_update","assistantMessageEvent":{"type":"tool_call"}}`); got != nil {
			t.Errorf("tool_call update folded to %s", formatEvents(got))
		}
		if got := fold(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":3}}`); got != nil {
			t.Errorf("numeric delta folded to %s", formatEvents(got))
		}
		if got := fold(`{"type":"message_update"}`); got != nil {
			t.Errorf("bare update folded to %s", formatEvents(got))
		}
	})

	t.Run("folds assistant message ends, including their error stops", func(t *testing.T) {
		assertEvents(t, fold(`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}],"stopReason":"stop"}}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventAssistantText, Text: "ab"}})
		if got := fold(`{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"u"}]}}`); got != nil {
			t.Errorf("user message folded to %s", formatEvents(got))
		}
		if got := fold(`{"type":"message_end","message":{"role":"assistant","content":"not parts","stopReason":"stop"}}`); got != nil {
			t.Errorf("string content folded to %s", formatEvents(got))
		}
		assertEvents(t, fold(`{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"boom"}}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventError, Message: "boom"}})
		assertEvents(t, fold(`{"type":"message_end","message":{"role":"assistant","stopReason":"error"}}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventError, Message: "omp ended an assistant message in error"}})
	})

	t.Run("folds tool starts and results: a name, then a summary from args, intent, or nothing", func(t *testing.T) {
		assertEvents(t, fold(`{"type":"tool_execution_start","toolName":"bash","args":{"command":"sleep 600"}}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventToolUse, Name: "bash", Summary: "sleep 600"}})
		assertEvents(t, fold(`{"type":"tool_execution_start","toolName":"grep","args":{"pattern":3},"intent":"find todos"}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventToolUse, Name: "grep", Summary: "find todos"}})
		assertEvents(t, fold(`{"type":"tool_execution_start","toolName":"grep"}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventToolUse, Name: "grep", Summary: ""}})
		if got := fold(`{"type":"tool_execution_start"}`); got != nil {
			t.Errorf("nameless tool start folded to %s", formatEvents(got))
		}
		assertEvents(t, fold(`{"type":"tool_execution_end","isError":true}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventToolResult, IsError: true}})
		assertEvents(t, fold(`{"type":"tool_execution_end"}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventToolResult}})
	})

	t.Run("folds retries: a leading 3-digit status, and counts that may be missing", func(t *testing.T) {
		assertEvents(t, fold(`{"type":"auto_retry_start","errorMessage":"429 High concurrency","attempt":2,"maxAttempts":5}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventAPIRetry, Attempt: 2, MaxRetries: 5, Status: ptr(int64(429))}})
		assertEvents(t, fold(`{"type":"auto_retry_start","errorMessage":"provider hiccup","attempt":"soon","maxAttempts":"5"}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventAPIRetry}})
		assertEvents(t, fold(`{"type":"auto_retry_start"}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventAPIRetry}})
	})

	t.Run("folds prompt results: only errors, with their http status when given", func(t *testing.T) {
		base := `"id":"p1","agentInvoked":true,"sessionSettled":true`
		assertEvents(t, fold(`{"type":"prompt_result",`+base+`,"status":"error","error":{"message":"quota gone","httpStatus":402}}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventError, Message: "quota gone", Status: ptr(int64(402))}})
		assertEvents(t, fold(`{"type":"prompt_result",`+base+`,"status":"error","error":{"message":"quota gone"}}`),
			[]domain.WorkerEvent{{Kind: domain.WorkerEventError, Message: "quota gone"}})
		if got := fold(`{"type":"prompt_result",` + base + `,"status":"error"}`); got != nil {
			t.Errorf("errorless result folded to %s", formatEvents(got))
		}
		if got := fold(`{"type":"prompt_result",` + base + `,"status":"aborted"}`); got != nil {
			t.Errorf("aborted result folded to %s", formatEvents(got))
		}
		if got := fold(`{"type":"prompt_result"}`); got != nil {
			t.Errorf("unguarded result folded to %s", formatEvents(got))
		}
	})

	t.Run("rebuilds a logged engine_result, defaulting every missing field", func(t *testing.T) {
		assertEvents(t, fold(`{"type":"engine_result","apiErrorStatus":503}`),
			[]domain.WorkerEvent{{
				Kind:           domain.WorkerEventResult,
				APIErrorStatus: ptr(int64(503)),
				Usage:          domain.ResultUsage{},
			}})
		got := fold(`{"type":"engine_result","isError":true,"structuredOutput":{"a":1},"turns":"3"}`)
		if len(got) != 1 || got[0].Kind != domain.WorkerEventResult {
			t.Fatalf("folded = %s, want one result", formatEvents(got))
		}
		if !got[0].IsError || got[0].Turns != 0 || got[0].APIErrorStatus != nil ||
			!reflect.DeepEqual(decodeRaw(got[0].StructuredOutput), map[string]any{"a": float64(1)}) {
			t.Errorf("folded = %+v, want isError, defaulted turns and status, and the report", got[0])
		}
	})
}

func kindsOf(events []domain.WorkerEvent) []domain.WorkerEventKind {
	kinds := make([]domain.WorkerEventKind, 0, len(events))
	for _, event := range events {
		kinds = append(kinds, event.Kind)
	}
	return kinds
}

// asWorkerError reads err as a worker error when it is one.
func asWorkerError(err error, into **ports.WorkerError) bool {
	workerErr, ok := err.(*ports.WorkerError)
	if ok {
		*into = workerErr
	}
	return ok
}

// Direct unit tests for the pieces whole runs reach only end to end (and for the paths no
// recorded run meets), so every function in worker.go holds the suite's own bar.
func TestOmpWorkerUnits(t *testing.T) {
	t.Run("caps: omp owns the session, has no schema and no budget", func(t *testing.T) {
		caps := newWorker(t, selfExe(t), 0).Caps()
		if caps.Name != ports.WorkerNameOmpRPC || caps.SessionKey != ports.SessionKeyEngine || caps.NativeSchema || caps.Budget {
			t.Fatalf("caps = %+v", caps)
		}
		if !reflect.DeepEqual(caps.Efforts, []string{"low", "high", "max"}) {
			t.Errorf("efforts = %v", caps.Efforts)
		}
		if caps.BriefNotes.Effort != "Passed to omp as --thinking (low, high or max)." {
			t.Errorf("effort note = %q", caps.BriefNotes.Effort)
		}
	})

	t.Run("dispose releases nothing", func(t *testing.T) {
		if err := newWorker(t, selfExe(t), 0).Dispose(context.Background()); err != nil {
			t.Fatalf("dispose: %v", err)
		}
	})

	t.Run("the binary defaults to omp from PATH, the override wins", func(t *testing.T) {
		if ompBinary("") != "omp" || ompBinary("/usr/local/bin/omp") != "/usr/local/bin/omp" {
			t.Fatalf("ompBinary = %q, %q", ompBinary(""), ompBinary("/usr/local/bin/omp"))
		}
	})

	t.Run("the commands log is named after the frames log", func(t *testing.T) {
		if got, want := commandsLog("job/attempt-0002.jsonl"), "job/attempt-0002.rpc-in.jsonl"; got != want {
			t.Errorf("commandsLog = %q, want %q", got, want)
		}
		if got := commandsLog("attempt.log"); got != "attempt.log" {
			t.Errorf("commandsLog of a non-jsonl log = %q, want it unchanged", got)
		}
	})

	t.Run("handshake errors map to worker errors, except an exit", func(t *testing.T) {
		cases := []struct {
			kind RpcErrorKind
			want ports.WorkerErrorKind
			none bool
		}{
			{RpcErrorStart, ports.WorkerErrorSpawnFailed, false},
			{RpcErrorProtocol, ports.WorkerErrorProtocol, false},
			{RpcErrorRejected, ports.WorkerErrorProtocol, false},
			{RpcErrorTimeout, ports.WorkerErrorProtocol, false},
			{RpcErrorClosed, ports.WorkerErrorProtocol, false},
			{RpcErrorExited, "", true},
		}
		for _, test := range cases {
			got := handshakeError(&RpcError{Kind: test.kind, Message: "m"})
			if test.none {
				if got != nil {
					t.Errorf("handshakeError(%s) = %v, want none", test.kind, got)
				}
				continue
			}
			if got == nil || got.Kind != test.want {
				t.Errorf("handshakeError(%s) = %v, want %s", test.kind, got, test.want)
			}
		}
	})

	t.Run("a count member reads as the JS number the engines send", func(t *testing.T) {
		frame := Frame{
			"attempt": json.RawMessage(`2.5`),
			"bogus":   json.RawMessage(`{bad`),
		}
		if got := memberAsCount(frame, "attempt"); got != 2.5 {
			t.Errorf("memberAsCount(2.5) = %v", got)
		}
		if got := memberAsCount(frame, "bogus"); got != 0 {
			t.Errorf("memberAsCount(broken) = %v, want 0", got)
		}
		if got := memberAsCount(frame, "absent"); got != 0 {
			t.Errorf("memberAsCount(absent) = %v, want 0", got)
		}
	})

	t.Run("a failed turn's error stands in the result, with its status", func(t *testing.T) {
		span := shared.ReportTurns[ompTurn]{
			StartedAt: 1_000,
			EndedAt:   2_500,
			Last: ompTurn{end: TurnEnd{Result: PromptResult{
				Status: "error",
				Error:  &PromptError{Message: "quota gone", HTTPStatus: ptr(int64(402))},
			}}},
		}
		result := synthesizeResult(span, &turnTally{finalText: "never reached"})
		if !result.IsError || result.Text != "quota gone" || result.APIErrorStatus == nil || *result.APIErrorStatus != 402 ||
			result.DurationMs != 1_500 {
			t.Fatalf("result = %+v, want the turn's own error", result)
		}
	})

	t.Run("an error turn without a message still says it ended in error", func(t *testing.T) {
		failure := promptFailure(PromptResult{Status: "error"})
		if failure == nil || failure.Message != "omp ended the turn in error without saying why" {
			t.Fatalf("promptFailure = %+v", failure)
		}
		if promptFailure(PromptResult{Status: "completed"}) != nil {
			t.Fatal("promptFailure of a completed turn is not nil")
		}
	})

	t.Run("a result line JSON cannot hold is not appended, and neither is one nowhere to write", func(t *testing.T) {
		dir := t.TempDir()
		logPath := filepath.Join(dir, "attempt.jsonl")
		// NaN cost: the one value the event's own encoding refuses (a run can never produce it,
		// the guard keeps the log writer from throwing).
		appendEngineResult(logPath, domain.WorkerEvent{Kind: domain.WorkerEventResult, CostUSD: math.NaN()})
		appendEngineResult(filepath.Join(dir, "no-such-dir", "attempt.jsonl"), domain.WorkerEvent{Kind: domain.WorkerEventResult})
		if _, err := os.Stat(logPath); !os.IsNotExist(err) {
			t.Fatalf("log %s written anyway (err %v)", logPath, err)
		}
	})
}
