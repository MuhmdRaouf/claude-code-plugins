package zcode

// The zcode worker bridge tests: one process per attempt, the brief attached as a file, one final
// JSON document on stdout. The fake zcode is this test binary re-executed through
// ENGINE_TEST_CHILD (no other runtime is ever started), speaking the same lines: an SDK warning,
// then the document, then its exit. Every child the tests start exits on its own or is killed by
// the test that started it.
//
// Environment (the fake's knobs, verbatim):
//   - FAKE_ZCODE_OUTPUT  printed as the final document instead of the default reply
//   - FAKE_ZCODE_TEXT    the default reply's response text
//   - FAKE_ZCODE_EXIT    the fake's exit code (default 0)
//   - FAKE_ZCODE_RECORD  a file the fake writes its args, cwd, env and attached prompt to
//   - FAKE_ZCODE_CHILD   a file the fake writes a lingering child's pid to
//   - FAKE_ZCODE_HANG    "1": print nothing and never exit
//   - FAKE_ZCODE_HUGE    "1": nine 1 MiB lines before whatever else it does (the output budget)
//   - FAKE_ZCODE_MISSING "1": "Session not found" on stderr, exit 1

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// engineChildEnv names the role this binary plays when a test re-executes it as a child.
const engineChildEnv = "ENGINE_TEST_CHILD"

// childDeadline bounds every child the tests start, so one that escapes its test's cleanup cannot
// linger past the suite.
const childDeadline = 90 * time.Second

// fixturesRoot is testdata/engines: the recorded engine runs, byte for byte.
var fixturesRoot = filepath.Join("..", "..", "..", "..", "testdata", "engines")

func TestMain(m *testing.M) {
	switch os.Getenv(engineChildEnv) {
	case "":
		os.Exit(m.Run())
	case "fake-zcode":
		runFakeZcode()
	case "zcode-linger":
		go func() {
			time.Sleep(childDeadline)
			os.Exit(99)
		}()
		hang()
	}
	os.Exit(0)
}

func hang() {
	for {
		time.Sleep(time.Hour)
	}
}

// runFakeZcode speaks the fake zcode's protocol: the record, the lingering child, then the hang,
// the missing session or the reply.
func runFakeZcode() {
	go func() {
		time.Sleep(childDeadline)
		os.Exit(99)
	}()
	args := os.Args[1:]
	if slices.Contains(args, "--version") {
		os.Stdout.WriteString("zcode 0.16.1\n")
		os.Exit(0)
	}
	if record := os.Getenv("FAKE_ZCODE_RECORD"); record != "" {
		writeFakeRecord(record, args)
	}
	if child := os.Getenv("FAKE_ZCODE_CHILD"); child != "" {
		spawnLingerer(child)
	}
	if os.Getenv("FAKE_ZCODE_HUGE") == "1" {
		// Nine 1 MiB lines: each under the line budget, together past the output budget.
		line := strings.Repeat("x", 1024*1024)
		for range 9 {
			os.Stdout.WriteString(line + "\n")
		}
	}
	switch {
	case os.Getenv("FAKE_ZCODE_HANG") == "1":
		hang()
	case os.Getenv("FAKE_ZCODE_MISSING") == "1":
		os.Stderr.WriteString("Session not found\n")
		os.Exit(1)
	default:
		printFakeReply()
		if os.Getenv("FAKE_ZCODE_SIGNAL") == "1" {
			// Die from a signal rather than an exit code, reply already printed.
			if proc, err := os.FindProcess(os.Getpid()); err == nil {
				_ = proc.Signal(syscall.SIGTERM)
			}
			time.Sleep(10 * time.Second)
		}
		code := 0
		if value := os.Getenv("FAKE_ZCODE_EXIT"); value != "" {
			if parsed, err := strconv.Atoi(value); err == nil {
				code = parsed
			}
		}
		os.Exit(code)
	}
	os.Exit(0)
}

// fakeRecord is what the fake zcode writes about how it was launched. Argv0 is the worker's own
// binary path, so the tests can tell it apart from a shell's argv[0].
type fakeRecord struct {
	Args   []string          `json:"args"`
	Cwd    string            `json:"cwd"`
	Env    map[string]string `json:"env"`
	Prompt string            `json:"prompt"`
	Argv0  string            `json:"argv0"`
}

// writeFakeRecord writes what the worker handed over: its argv, its cwd, its environment and the
// attached prompt file's content, in the member order the record's JSON pins.
func writeFakeRecord(record string, args []string) {
	promptPath := fakeArgAfter(args, "--attach")
	prompt, _ := os.ReadFile(promptPath)
	env := map[string]string{}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		env[name] = value
	}
	cwd, err := os.Getwd()
	if err != nil {
		cwd = ""
	}
	data, err := json.Marshal(fakeRecord{
		Args: args, Cwd: cwd, Env: env, Prompt: string(prompt), Argv0: os.Args[0],
	})
	if err != nil {
		os.Exit(1)
	}
	_ = os.WriteFile(record, data, 0o600)
}

// readRecord reads back what the fake wrote.
func readRecord(t *testing.T, path string) fakeRecord {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var seen fakeRecord
	if err := json.Unmarshal(data, &seen); err != nil {
		t.Fatalf("record: %v", err)
	}
	return seen
}

// spawnLingerer starts a process that outlives the fake until the group is terminated: the stop
// test's descendant.
func spawnLingerer(pidFile string) {
	child := exec.Command(os.Args[0])
	child.Env = append(os.Environ(), engineChildEnv+"=zcode-linger")
	if err := child.Start(); err != nil {
		return
	}
	_ = os.WriteFile(pidFile, []byte(strconv.Itoa(child.Process.Pid)), 0o600)
}

func fakeArgAfter(args []string, flag string) string {
	for i, arg := range args {
		if arg == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

// printFakeReply prints the SDK warning line the real CLI emits, then the final document:
// FAKE_ZCODE_OUTPUT verbatim, or the default reply rendered the way JSON.stringify(reply, null, 2)
// did it.
func printFakeReply() {
	os.Stdout.WriteString("SDK warning {not JSON}\n")
	out := os.Getenv("FAKE_ZCODE_OUTPUT")
	if out == "" {
		out = fakeJSON(map[string]any{
			"sessionId": "sess_test",
			"response":  fakeReplyText(),
			"usage": map[string]any{
				"inputTokens": 100, "outputTokens": 20,
				"cacheReadTokens": 50, "cacheWriteTokens": 10,
			},
			"projection": map[string]any{"status": "idle", "turnCount": 3},
		})
	}
	os.Stdout.WriteString(out + "\n")
}

func fakeReplyText() string {
	if text := os.Getenv("FAKE_ZCODE_TEXT"); text != "" {
		return text
	}
	return `{"summary":"pong","findings":[],"open_items":[]}`
}

// fakeJSON renders the reply the way JSON.stringify(…, null, 2) did: two-space indent, no HTML
// escaping. A map's keys sort, which the assertions never read as order.
func fakeJSON(value any) string {
	var out strings.Builder
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return ""
	}
	return out.String()
}

// fakeZcodeBin is this test binary: the worker starts it as the CLI (it carries no .cjs suffix, so
// it runs as itself).
var fakeZcodeBin = os.Args[0]

func worker(t *testing.T) *ZcodeWorker {
	return workerWithBin(t, fakeZcodeBin)
}

// workerWithBin always names the binary explicitly (the test binary or a missing path): no test
// resolves or starts a real zcode, whatever this machine has installed. The PATH below only rides
// in the child's environment; nothing looks anything up in it.
func workerWithBin(t *testing.T, bin string) *ZcodeWorker {
	t.Helper()
	return NewZcodeWorker(Options{
		Bin: bin,
		ParentEnv: domain.EnvLookup{
			"PATH":               os.Getenv("PATH"),
			"HOME":               testkit.TempDir(t, "zcode-home-"),
			"ZAI_API_KEY":        "withheld",
			"ANTHROPIC_BASE_URL": "http://router",
			"ZCODE_CONFIG":       "own-config",
			// How the started test binary knows to be the fake rather than run the suite.
			engineChildEnv: "fake-zcode",
		},
		Withheld:    func(name string) bool { return strings.HasPrefix(name, "ZAI_") },
		StopGraceMs: 100,
	})
}

func spec(t *testing.T, passEnv map[string]string, changes func(*ports.WorkerSpec)) ports.WorkerSpec {
	t.Helper()
	cwd := testkit.TempDir(t, "zcode-job-")
	s := ports.WorkerSpec{
		Cwd:       cwd,
		LogPath:   filepath.Join(cwd, "attempt.jsonl"),
		Prompt:    "Inspect this repository.",
		Access:    ports.AccessReadonly,
		Model:     testkit.ReferenceProvider.Catalog[domain.ModelTierMain],
		Session:   ports.WorkerSession{Kind: ports.SessionKindNew, Key: "caller-id"},
		Report:    app.BuiltinContract(domain.BuiltinReportNotes),
		TimeoutMs: 5000,
		AddDirs:   []string{},
		PassEnv:   passEnv,
	}
	if changes != nil {
		changes(&s)
	}
	return s
}

type runResult struct {
	events []domain.WorkerEvent
	exit   ports.WorkerExit
	result domain.WorkerResult
}

func run(t *testing.T, w ports.Worker, s ports.WorkerSpec) runResult {
	t.Helper()
	started, err := w.Start(context.Background(), s)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	var events []domain.WorkerEvent
	for event := range started.Events() {
		events = append(events, event)
	}
	exit := started.Wait()
	end := domain.WorkerExit{Code: exit.Code, Signal: exit.Signal, StderrTail: exit.StderrTail}
	return runResult{events: events, exit: exit, result: domain.FinalizeWorker(events, end, exit.Forced)}
}

func resultEventOf(t *testing.T, events []domain.WorkerEvent) *domain.WorkerEvent {
	t.Helper()
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Kind == domain.WorkerEventResult {
			return &events[i]
		}
	}
	return nil
}

// sameJSON compares two values the way vitest's toEqual does: parsed JSON, never bytes.
func sameJSON(t *testing.T, what string, got, want any) {
	t.Helper()
	toValue := func(value any) any {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("marshal %s: %v", what, err)
		}
		var parsed any
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatalf("unmarshal %s: %v", what, err)
		}
		return parsed
	}
	if !reflect.DeepEqual(toValue(got), toValue(want)) {
		t.Fatalf("%s:\ngot  %s\nwant %s", what, mustJSON(got), mustJSON(want))
	}
}

func mustJSON(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		return "?"
	}
	return string(data)
}

func TestReadsTheRecordedGLMWriteResponseFromTheAppBundledCLI(t *testing.T) {
	output, err := os.ReadFile(filepath.Join(fixturesRoot, "zcode", "success-write.json"))
	if err != nil {
		t.Fatal(err)
	}
	r := run(t, worker(t), spec(t, map[string]string{"FAKE_ZCODE_OUTPUT": string(output)}, nil))
	if r.result.Outcome.Kind != domain.WorkerOutcomeCompleted {
		t.Fatalf("outcome = %s, want completed: %s", r.result.Outcome.Kind, mustJSON(r.result.Outcome))
	}
	// Byte for byte: the report's key order must survive the bridge (a decoded map would re-render
	// it sorted).
	want := `{"summary":"GLM smoke ready","findings":[],"open_items":[]}`
	if string(r.result.Report) != want {
		t.Fatalf("report = %s, want %s", string(r.result.Report), want)
	}
	if r.result.Usage.InputTokens != 47339 || r.result.Usage.OutputTokens != 735 {
		t.Fatalf("usage = %s", mustJSON(r.result.Usage))
	}
	if r.result.SessionID == nil || *r.result.SessionID != "sess_live_fixture" {
		t.Fatalf("session id = %s", mustJSON(r.result.SessionID))
	}
}

func TestKeepsAMultiKeyReportsWrittenKeyOrder(t *testing.T) {
	report := `{"zeta":1,"alpha":2}`
	r := run(t, worker(t), spec(t, map[string]string{"FAKE_ZCODE_TEXT": report}, nil))
	result := resultEventOf(t, r.events)
	if result == nil || result.IsError {
		t.Fatalf("no successful result event: %s", mustJSON(r.events))
	}
	// Byte for byte, as JSON.stringify wrote it: a decoded map would re-render it sorted.
	if string(result.StructuredOutput) != report {
		t.Fatalf("structuredOutput = %s, want %s", string(result.StructuredOutput), report)
	}
	if string(r.result.Report) != report {
		t.Fatalf("report = %s, want %s", string(r.result.Report), report)
	}
}

func TestReadsAPrettyJSONResponseAfterWarningsAndReplaysTheSameNormalizedEvents(t *testing.T) {
	w := worker(t)
	s := spec(t, nil, nil)
	if err := w.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight: %v", err)
	}
	r := run(t, w, s)
	if r.result.Outcome.Kind != domain.WorkerOutcomeCompleted {
		t.Fatalf("outcome = %s, want completed", r.result.Outcome.Kind)
	}
	var session *domain.WorkerEvent
	for i := range r.events {
		if r.events[i].Kind == domain.WorkerEventSession {
			session = &r.events[i]
		}
	}
	if session == nil || session.SessionID != "sess_test" {
		t.Fatalf("no session event for sess_test: %s", mustJSON(r.events))
	}
	result := resultEventOf(t, r.events)
	if result == nil || result.IsError {
		t.Fatalf("no successful result event: %s", mustJSON(r.events))
	}
	sameJSON(t, "structured output", result.StructuredOutput,
		map[string]any{"summary": "pong", "findings": []any{}, "open_items": []any{}})
	if result.Turns != 1 {
		t.Fatalf("turns = %d, want 1", result.Turns)
	}
	sameJSON(t, "usage", result.Usage, domain.ResultUsage{
		InputTokens: 100, OutputTokens: 20, CacheReadTokens: 50, CacheWriteTokens: 10,
	})

	// The log's lines fold back into exactly the events the run streamed.
	logText, err := os.ReadFile(s.LogPath)
	if err != nil {
		t.Fatal(err)
	}
	var replayed []domain.WorkerEvent
	for _, line := range strings.Split(strings.TrimSpace(string(logText)), "\n") {
		replayed = append(replayed, w.ParseLine(line)...)
	}
	sameJSON(t, "replayed events", replayed, r.events)
	if len(w.ParseLine("bad json")) != 0 {
		t.Fatal(`ParseLine("bad json") returned events`)
	}
	if len(w.ParseLine(`{"response":"not a normalized event"}`)) != 0 {
		t.Fatal("ParseLine of a non-event line returned events")
	}
	if err := w.Dispose(context.Background()); err != nil {
		t.Fatalf("dispose: %v", err)
	}
}

func TestRefusesAZeroExitWithInvalidOutput(t *testing.T) {
	for _, output := range []string{
		"not json",
		"[]",
		"{}",
		`{"sessionId":"sess_test"}`,
		`{"sessionId":"sess_test","response":"ok","projection":{"status":"failed"}}`,
	} {
		t.Run(output, func(t *testing.T) {
			r := run(t, worker(t), spec(t, map[string]string{"FAKE_ZCODE_OUTPUT": output}, nil))
			if r.result.Outcome.Kind == domain.WorkerOutcomeCompleted {
				t.Fatalf("outcome = completed for %q", output)
			}
			result := resultEventOf(t, r.events)
			if result == nil || !result.IsError || result.StructuredOutput != nil {
				t.Fatalf("no failing result event with a null report: %s", mustJSON(r.events))
			}
		})
	}
}

func TestPreservesAnInvalidReportForCoreVerificationInsteadOfInventingAPassingReport(t *testing.T) {
	s := spec(t, map[string]string{"FAKE_ZCODE_TEXT": "done, no report"}, nil)
	r := run(t, worker(t), s)
	result := resultEventOf(t, r.events)
	if result == nil || result.StructuredOutput != nil {
		t.Fatalf("result event does not preserve the invalid report: %s", mustJSON(r.events))
	}
	if check := s.Report.Validate(nil); check.Valid {
		t.Fatalf("validate(nil) = %s, want invalid", mustJSON(check))
	}
}

func TestANonzeroExitOverridesAPlausibleResponse(t *testing.T) {
	r := run(t, worker(t), spec(t, map[string]string{"FAKE_ZCODE_EXIT": "1"}, nil))
	if r.result.Outcome.Kind == domain.WorkerOutcomeCompleted {
		t.Fatal("outcome = completed, want a failure")
	}
}

func TestPassesAccessTheAttachedContractAndOnlyTheToolsOwnSettings(t *testing.T) {
	for _, access := range []ports.Access{ports.AccessReadonly, ports.AccessExec, ports.AccessWrite} {
		t.Run(string(access), func(t *testing.T) {
			dir := testkit.TempDir(t, "zcode-record-")
			record := filepath.Join(dir, "record.json")
			s := spec(t, map[string]string{
				"FAKE_ZCODE_RECORD":  record,
				"ZCODE_CONFIG":       "bad",
				"ZAI_API_KEY":        "bad",
				"ANTHROPIC_BASE_URL": "bad",
				"OTHER":              "passed",
			}, func(s *ports.WorkerSpec) {
				s.Access = access
				s.Session = ports.WorkerSession{Kind: ports.SessionKindResume, Key: "sess_previous"}
				s.Prompt = strings.Repeat("A long brief\n", 5000)
			})
			run(t, worker(t), s)
			data, err := os.ReadFile(record)
			if err != nil {
				t.Fatal(err)
			}
			var seen struct {
				Args   []string          `json:"args"`
				Cwd    string            `json:"cwd"`
				Env    map[string]string `json:"env"`
				Prompt string            `json:"prompt"`
			}
			if err := json.Unmarshal(data, &seen); err != nil {
				t.Fatalf("record: %v", err)
			}
			if seen.Cwd != s.Cwd {
				t.Fatalf("cwd = %s, want %s", seen.Cwd, s.Cwd)
			}
			if !slices.Contains(seen.Args, "sess_previous") {
				t.Fatalf("args carry no resume key: %s", mustJSON(seen.Args))
			}
			if value := flagValue(t, seen.Args, "--mode"); value != "yolo" {
				t.Fatalf("--mode = %s, want yolo", value)
			}
			// The prompt rides in the attached file, so argv stays small.
			if len(strings.Join(seen.Args, " ")) >= 1500 {
				t.Fatalf("args are %d chars, the prompt leaked into argv", len(strings.Join(seen.Args, " ")))
			}
			if !strings.Contains(seen.Prompt, s.Prompt) {
				t.Fatal("the attached prompt does not carry the brief")
			}
			if !strings.Contains(seen.Prompt, "## Final report") {
				t.Fatal("the attached prompt does not carry the report contract")
			}
			if _, ok := seen.Env["ZAI_API_KEY"]; ok {
				t.Fatal("the tool saw the provider's key")
			}
			if _, ok := seen.Env["ANTHROPIC_BASE_URL"]; ok {
				t.Fatal("the tool saw the plugin's routing")
			}
			if seen.Env["ZCODE_CONFIG"] != "own-config" {
				t.Fatalf("ZCODE_CONFIG = %q, want the tool's own setting", seen.Env["ZCODE_CONFIG"])
			}
			if seen.Env["OTHER"] != "passed" {
				t.Fatal("the brief's env did not pass through")
			}
			allowed := slices.Index(seen.Args, "--allowed-tools")
			if access == ports.AccessWrite {
				if allowed >= 0 {
					t.Fatal("write access narrowed the tools")
				}
				return
			}
			if allowed < 0 {
				t.Fatal("readonly or exec access did not name the allowed tools")
			}
			want := "Read,Glob,Grep,Bash"
			if access == ports.AccessReadonly {
				want = "Read,Glob,Grep"
			}
			if seen.Args[allowed+1] != want {
				t.Fatalf("--allowed-tools = %s, want %s", seen.Args[allowed+1], want)
			}
		})
	}
}

func flagValue(t *testing.T, args []string, flag string) string {
	t.Helper()
	index := slices.Index(args, flag)
	if index < 0 || index+1 >= len(args) {
		t.Fatalf("args carry no %s value: %s", flag, mustJSON(args))
	}
	return args[index+1]
}

func TestReportsAMissingResumedSessionForTheDriversFreshSessionFallback(t *testing.T) {
	r := run(t, worker(t), spec(t, map[string]string{"FAKE_ZCODE_MISSING": "1"},
		func(s *ports.WorkerSpec) {
			s.Session = ports.WorkerSession{Kind: ports.SessionKindResume, Key: "sess_gone"}
		}))
	if !r.exit.SessionMissing {
		t.Fatalf("sessionMissing = false, stderr tail %q", r.exit.StderrTail)
	}
}

func TestTimesOutAHangingProcessWithoutACompletionEvent(t *testing.T) {
	r := run(t, worker(t), spec(t, map[string]string{"FAKE_ZCODE_HANG": "1"},
		func(s *ports.WorkerSpec) { s.TimeoutMs = 150 }))
	if r.exit.Forced == nil || *r.exit.Forced != domain.ForcedTimeout {
		t.Fatalf("forced = %s, want timeout", mustJSON(r.exit.Forced))
	}
	if len(r.events) != 0 {
		t.Fatalf("events = %s, want none", mustJSON(r.events))
	}
}

func TestStopsTheProcessGroupIncludingDescendants(t *testing.T) {
	dir := testkit.TempDir(t, "zcode-child-")
	childPidFile := filepath.Join(dir, "child.pid")
	w := worker(t)
	s := spec(t, map[string]string{"FAKE_ZCODE_CHILD": childPidFile, "FAKE_ZCODE_HANG": "1"}, nil)
	started, err := w.Start(context.Background(), s)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = started.Interrupt(context.Background(), ports.InterruptStopped) })
	pidFile := domain.EnginePidBeside(s.LogPath)
	if err := testkit.Until(t, func() bool {
		pid, ok := readPidFile(t, childPidFile)
		return ok && pid > 0
	}, testkit.UntilOptions{Message: "the fake never wrote its child's pid"}); err != nil {
		t.Fatal(err)
	}
	pid, _ := readPidFile(t, childPidFile)
	if !testkit.IsPidAlive(int(pid)) {
		t.Fatalf("child %d is not alive", pid)
	}
	// The group leader's pid is recorded beside the attempt log while the engine runs.
	leader, ok := readPidFile(t, pidFile)
	if !ok || !testkit.IsPidAlive(int(leader)) {
		t.Fatalf("engine.pid = %d (ok %t), want the live group leader", leader, ok)
	}
	if err := started.Interrupt(context.Background(), ports.InterruptStopped); err != nil {
		t.Fatalf("interrupt: %v", err)
	}
	exit := started.Wait()
	if exit.Forced == nil || *exit.Forced != domain.ForcedStopped {
		t.Fatalf("forced = %s, want stopped", mustJSON(exit.Forced))
	}
	if err := testkit.UntilGone(t, int(pid), testkit.UntilOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(pidFile); !os.IsNotExist(err) {
		t.Fatalf("engine.pid survived the run: %v", err)
	}
}

func readPidFile(t *testing.T, path string) (int64, bool) {
	t.Helper()
	text, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	return domain.ParsePid(string(text))
}

func TestReturnsExpectedStartFailuresAsValues(t *testing.T) {
	ctx := context.Background()
	if _, err := workerWithBin(t, "/missing/zcode").Start(ctx, spec(t, nil, nil)); err == nil {
		t.Fatal("a missing binary started")
	}
	if _, err := worker(t).Start(ctx, spec(t, nil,
		func(s *ports.WorkerSpec) { s.LogPath = "/missing/parent/log" })); err == nil {
		t.Fatal("an unwritable prompt path started")
	}
	budget := 1.0
	if _, err := worker(t).Start(ctx, spec(t, nil,
		func(s *ports.WorkerSpec) { s.BudgetUSD = &budget })); err == nil {
		t.Fatal("a budget started")
	}
	effort := "high"
	if _, err := worker(t).Start(ctx, spec(t, nil,
		func(s *ports.WorkerSpec) { s.Effort = &effort })); err == nil {
		t.Fatal("an effort override started")
	}
}

// The output budget: past it the run is stopped and nothing counts as output, so a runaway stream
// cannot pose as a reply. No e2e run drives this branch; this test keeps it covered.
func TestStopsARunThatStreamsPastTheOutputBudget(t *testing.T) {
	// The wall clock stays out of the way: the output budget, not the timeout, ends the run.
	r := run(t, worker(t), spec(t, map[string]string{"FAKE_ZCODE_HUGE": "1", "FAKE_ZCODE_HANG": "1"},
		func(s *ports.WorkerSpec) { s.TimeoutMs = 30000 }))
	if r.exit.Forced == nil || *r.exit.Forced != domain.ForcedStopped {
		t.Fatalf("forced = %s, want stopped", mustJSON(r.exit.Forced))
	}
	if len(r.events) != 0 {
		t.Fatalf("events = %s, want none", mustJSON(r.events))
	}
}

// Every lookup here stays inside temp directories or an explicit override: PATH is a temp dir the
// test filled itself, HOME never points at the real one, and the only platform defaults probed are
// behind a PATH entry that wins first — nothing on this machine (a real ZCode.app, a real zcode on
// PATH) can resolve, and no lookup ever starts anything.
func TestPrefersOverridesThenZcodeCliThenExecutablePathEntries(t *testing.T) {
	dir := testkit.TempDir(t, "zcode-bin-")
	file := filepath.Join(dir, "zcode")
	if err := os.WriteFile(file, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	env := domain.EnvLookup{"PATH": dir, "ZCODE_CLI": "/custom/zcode.cjs"}
	if got := ZcodeBinary(env, "/explicit/zcode.cjs", runtime.GOOS); got != "/explicit/zcode.cjs" {
		t.Fatalf("override lost: %s", got)
	}
	if got := ZcodeBinary(env, "", runtime.GOOS); got != "/custom/zcode.cjs" {
		t.Fatalf("ZCODE_CLI lost: %s", got)
	}
	if got := ZcodeBinary(domain.EnvLookup{"PATH": dir, "HOME": testkit.TempDir(t, "zcode-lookup-home-")}, "", runtime.GOOS); got != file {
		t.Fatalf("PATH entry lost: %s", got)
	}
	if got := ZcodeBinary(domain.EnvLookup{"PATH": "/not-present"}, "", "linux"); got != "zcode" {
		t.Fatalf("fallback = %s, want zcode", got)
	}
	// PATH entries without an executable bit, and directories, are skipped.
	plain := testkit.TempDir(t, "zcode-plain-")
	plainBin := filepath.Join(plain, "zcode")
	if err := os.WriteFile(plainBin, []byte("#!/bin/sh\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := onPath(plain); got != "" {
		t.Fatalf("a non-executable entry matched: %s", got)
	}
	if err := os.Remove(plainBin); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(plainBin, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := onPath(strings.Join([]string{plain, plain, "", plain}, string(os.PathListSeparator))); got != "" {
		t.Fatalf("a directory entry matched: %s", got)
	}
}

func TestLaunchesReadableDesktopScriptsThroughTheRuntimeWithoutRequiringAnExecutableBit(t *testing.T) {
	dir := testkit.TempDir(t, "zcode-script-")
	file := filepath.Join(dir, "zcode.cjs")
	if err := os.WriteFile(file, []byte("console.log('0.16.1')"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !ReadableZcodeScript(file) {
		t.Fatal("a readable script without an executable bit was refused")
	}
	if ReadableZcodeScript(dir) {
		t.Fatal("a directory counted as a script")
	}
	if ReadableZcodeScript("/missing/zcode.cjs") {
		t.Fatal("a missing script counted as readable")
	}
	command, args := ZcodeCommand(file)
	if command != "node" || len(args) != 1 || args[0] != file {
		t.Fatalf("command = %s %s, want node %s", command, mustJSON(args), file)
	}
	if command, args = ZcodeCommand("zcode"); command != "zcode" || len(args) != 0 {
		t.Fatalf("command = %s %s, want zcode with no args", command, mustJSON(args))
	}
	// The desktop bundle candidates per platform: the app's install, and under $HOME on macOS; none
	// on Linux.
	home := testkit.TempDir(t, "zcode-home-")
	sameJSON(t, "darwin candidates", bundleCandidates(domain.EnvLookup{"HOME": home}, "darwin"), []string{
		"/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
		filepath.Join(home, "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
	})
	sameJSON(t, "darwin without a home", bundleCandidates(domain.EnvLookup{}, "darwin"), []string{
		"/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
	})
	sameJSON(t, "linux", bundleCandidates(domain.EnvLookup{"HOME": home}, "linux"), []string{})
}

// A run whose process died from a signal: the failure names the signal, not a code.
func TestNamesTheSignalAKilledProcessDiedFrom(t *testing.T) {
	wantPrefix := "ZCode exited SIGTERM"
	r := run(t, worker(t), spec(t, map[string]string{"FAKE_ZCODE_SIGNAL": "1"}, nil))
	if r.result.Outcome.Kind == domain.WorkerOutcomeCompleted {
		t.Fatal("outcome = completed, want a failure")
	}
	result := resultEventOf(t, r.events)
	if result == nil || !result.IsError || !strings.HasPrefix(result.Text, wantPrefix) {
		t.Fatalf("result text = %q", resultText(result))
	}
}

func resultText(result *domain.WorkerEvent) string {
	if result == nil {
		return "<no result event>"
	}
	return result.Text
}

// The worker's own details, asserted directly (the engine wiring reads them through whole runs).
func TestWorkerDetails(t *testing.T) {
	caps := worker(t).Caps()
	if caps.Name != ports.WorkerNameZcode || caps.SessionKey != ports.SessionKeyEngine || caps.NativeSchema {
		t.Fatalf("caps = %s", mustJSON(caps))
	}
	if caps.Budget || !slices.Equal(caps.Efforts, []string{"default"}) {
		t.Fatalf("terms = %s", mustJSON(caps.WorkerTerms))
	}
	if caps.BriefNotes.BudgetUSD == "" || caps.BriefNotes.Readonly == "" {
		t.Fatalf("brief notes = %s", mustJSON(caps.BriefNotes))
	}
	if got := NewZcodeWorker(Options{}).bin(); got != "zcode" {
		t.Fatalf("default bin = %s", got)
	}
	if got := forced(ports.InterruptTimeout); got != "timeout" {
		t.Fatalf("timeout mapping = %s", got)
	}
	if got := forced(ports.InterruptStopped); got != "stopped" {
		t.Fatalf("stopped mapping = %s", got)
	}
	if got := utf16Units("a\u007f😀"); got != 4 {
		t.Fatalf("utf16Units = %d, want 4", got)
	}
	appendLine("/dev/null/no-such-dir", "line\n")
	// Lines the worker never writes still fold to nothing: no event member, an event of an
	// unknown kind, an unparseable line.
	w := worker(t)
	if got := w.ParseLine(`{"type":"zcode_event"}`); len(got) != 0 {
		t.Fatalf("eventless line = %s", mustJSON(got))
	}
	if got := w.ParseLine(`{"type":"zcode_event","event":{"type":"bogus"}}`); len(got) != 0 {
		t.Fatalf("unknown event kind = %s", mustJSON(got))
	}
	if got := w.ParseLine("not json at all"); len(got) != 0 {
		t.Fatalf("unparseable line = %s", mustJSON(got))
	}
}

// The report the result event carries is domain.ExtractReport's raw bytes, whose key order
// survives the bridge.
func TestExtractsTheReportAsRawBytes(t *testing.T) {
	cases := []struct {
		name string
		text string
		want string
	}{
		{"whole text", `  {"summary":"ok","findings":[]}  `, `{"summary":"ok","findings":[]}`},
		{"key order survives", "{ \"b\" : 2, \"a\" : 1 }", `{"b":2,"a":1}`},
		{"zeta before alpha, as JSON.stringify writes it", `{"zeta":1,"alpha":2}`, `{"zeta":1,"alpha":2}`},
		{"fenced block", "words\n```json\n{\"summary\":\"ok\"}\n```\nafter", `{"summary":"ok"}`},
		{"outermost braces", `noise {"summary":"ok"} trailing`, `{"summary":"ok"}`},
		{"array is no report", "[]", ""},
		{"fenced array", "```json\n[1]\n```", ""},
		{"braces hold no object", "x {nope} y", ""},
		{"no braces at all", "plain text", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := domain.ExtractReport(tc.text)
			if tc.want == "" {
				if got != nil {
					t.Fatalf("domain.ExtractReport(%q) = %s, want nil", tc.text, string(got))
				}
				return
			}
			if string(got) != tc.want {
				t.Fatalf("domain.ExtractReport(%q) = %s, want %s", tc.text, string(got), tc.want)
			}
		})
	}
}

// workerWithParentEnv wires a worker over an explicit environment, for the launches whose PATH must
// contain only what the test placed there (a fake node, or nothing at all).
func workerWithParentEnv(t *testing.T, bin string, parentEnv domain.EnvLookup) *ZcodeWorker {
	t.Helper()
	return NewZcodeWorker(Options{
		Bin:         bin,
		ParentEnv:   parentEnv,
		Withheld:    func(name string) bool { return strings.HasPrefix(name, "ZAI_") },
		StopGraceMs: 100,
	})
}

// linkTestBinary makes path run this test binary: a symlink where the filesystem takes one, a copy
// where it does not.
func linkTestBinary(t *testing.T, path string) {
	t.Helper()
	if err := os.Symlink(fakeZcodeBin, path); err == nil {
		return
	}
	source, err := os.Open(fakeZcodeBin)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	target, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(target, source); err != nil {
		t.Fatal(err)
	}
	if err := target.Close(); err != nil {
		t.Fatal(err)
	}
}

// appLayout builds the desktop app's macOS install layout and returns the bundled script beside
// the app's own executable.
func appLayout(t *testing.T, root string) (script, exe string) {
	t.Helper()
	contents := filepath.Join(root, "ZCode.app", "Contents")
	script = filepath.Join(contents, "Resources", "glm", "zcode.cjs")
	exe = filepath.Join(contents, "MacOS", "ZCode")
	if err := os.MkdirAll(filepath.Dir(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte("console.log('0.16.1')"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		t.Fatal(err)
	}
	return script, exe
}

// The app-bundled script runs on the desktop app's own Electron executable as plain node — the port
// depends on no Node install — with ELECTRON_RUN_AS_NODE=1 in the child's environment and the script
// as its first argument. PATH stays empty: nothing outside the test's own app layout can run.
func TestLaunchesTheAppBundledScriptThroughTheAppsOwnExecutable(t *testing.T) {
	app := testkit.TempDir(t, "zcode-app-")
	script, exe := appLayout(t, app)
	linkTestBinary(t, exe)

	command, args := ZcodeCommand(script)
	if command != exe || len(args) != 1 || args[0] != script {
		t.Fatalf("command = %s %s, want %s %s", command, mustJSON(args), exe, mustJSON([]string{script}))
	}
	w := workerWithParentEnv(t, script, domain.EnvLookup{
		"PATH": testkit.TempDir(t, "zcode-empty-path-"),
		"HOME": testkit.TempDir(t, "zcode-home-"),
		// How the started app executable knows to be the fake rather than run the suite.
		engineChildEnv: "fake-zcode",
	})
	if err := w.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight with the app executable beside the script: %v", err)
	}
	dir := testkit.TempDir(t, "zcode-record-")
	record := filepath.Join(dir, "record.json")
	s := spec(t, map[string]string{"FAKE_ZCODE_RECORD": record}, func(s *ports.WorkerSpec) {
		s.Cwd = testkit.TempDir(t, "zcode-job-")
		s.LogPath = filepath.Join(s.Cwd, "attempt.jsonl")
	})
	r := run(t, w, s)
	if r.result.Outcome.Kind != domain.WorkerOutcomeCompleted {
		t.Fatalf("outcome = %s, want completed", r.result.Outcome.Kind)
	}
	seen := readRecord(t, record)
	if seen.Argv0 != exe {
		t.Fatalf("argv0 = %s, want the app's own executable %s", seen.Argv0, exe)
	}
	if seen.Env["ELECTRON_RUN_AS_NODE"] != "1" {
		t.Fatalf("ELECTRON_RUN_AS_NODE = %q, want 1", seen.Env["ELECTRON_RUN_AS_NODE"])
	}
	if len(seen.Args) == 0 || seen.Args[0] != script {
		t.Fatalf("args = %s, want the script first", mustJSON(seen.Args))
	}

	// A non-script derives no app executable.
	if got := ElectronApp("zcode"); got != "" {
		t.Fatalf("ElectronApp(zcode) = %s, want none", got)
	}
}

// A script with no app executable beside it runs on node resolved from the tool's own environment —
// never from the orchestrator's PATH, which the binary never consults. The node here is the test
// binary itself; the real one is never started.
func TestRunsABareScriptOnNodeResolvedFromTheToolsEnvironment(t *testing.T) {
	binDir := testkit.TempDir(t, "zcode-nodedir-")
	fakeNode := filepath.Join(binDir, "node")
	linkTestBinary(t, fakeNode)
	script := filepath.Join(binDir, "glm", "zcode.cjs")
	if err := os.MkdirAll(filepath.Dir(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte("console.log('0.16.1')"), 0o600); err != nil {
		t.Fatal(err)
	}
	w := workerWithParentEnv(t, script, domain.EnvLookup{
		"PATH": binDir,
		"HOME": testkit.TempDir(t, "zcode-home-"),
		// How the started fake node knows to be the fake rather than run the suite.
		engineChildEnv: "fake-zcode",
	})
	if err := w.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight with node on the tool's PATH: %v", err)
	}
	dir := testkit.TempDir(t, "zcode-record-")
	record := filepath.Join(dir, "record.json")
	r := run(t, w, spec(t, map[string]string{"FAKE_ZCODE_RECORD": record}, nil))
	if r.result.Outcome.Kind != domain.WorkerOutcomeCompleted {
		t.Fatalf("outcome = %s, want completed", r.result.Outcome.Kind)
	}
	seen := readRecord(t, record)
	if seen.Argv0 != fakeNode {
		t.Fatalf("argv0 = %s, want the tool's own node %s", seen.Argv0, fakeNode)
	}
	if _, ok := seen.Env["ELECTRON_RUN_AS_NODE"]; ok {
		t.Fatal("the node fallback set ELECTRON_RUN_AS_NODE")
	}
}

// A script with neither the app's executable beside it nor node on the tool's PATH cannot run:
// preflight says so, naming both options, and start refuses rather than resolving anything from the
// orchestrator's own PATH.
func TestPreflightFailsWhenAScriptHasNeitherTheAppsExecutableNorNode(t *testing.T) {
	dir := testkit.TempDir(t, "zcode-bare-")
	script := filepath.Join(dir, "glm", "zcode.cjs")
	if err := os.MkdirAll(filepath.Dir(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	w := workerWithParentEnv(t, script, domain.EnvLookup{
		"PATH": testkit.TempDir(t, "zcode-empty-path-"),
		"HOME": testkit.TempDir(t, "zcode-home-"),
	})
	err := w.Preflight(context.Background())
	if err == nil {
		t.Fatal("preflight passed with no runner for the script")
	}
	var workerErr *ports.WorkerError
	if !errors.As(err, &workerErr) || workerErr.Kind != ports.WorkerErrorSpawnFailed {
		t.Fatalf("preflight error = %v, want a spawn failure", err)
	}
	if !strings.Contains(workerErr.Message, "ZCode") || !strings.Contains(workerErr.Message, "node") {
		t.Fatalf("message names neither option: %q", workerErr.Message)
	}
	if _, err := w.Start(context.Background(), spec(t, nil, nil)); err == nil {
		t.Fatal("start ran with no runner for the script")
	}
}
