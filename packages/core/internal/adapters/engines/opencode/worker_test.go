package opencode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
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

// The suite re-executes this test binary as the fake opencode (ENGINE_TEST_CHILD names the role),
// so no other runtime is ever started. The parent process is never the fake: the worker starts
// the binary with only the run's argv, and the scenario rides the environment the run passes.

// childScenarioEnv names the role this binary plays when it is re-executed.
const childScenarioEnv = "ENGINE_TEST_CHILD"

// childDeadline bounds every child the tests start, so one that escapes its test's cleanup
// cannot linger.
const childDeadline = 60 * time.Second

func TestMain(m *testing.M) {
	switch scenario := os.Getenv(childScenarioEnv); scenario {
	case "":
		os.Exit(m.Run())
	case "server-child":
		// opencode's server child: silence until its deadline, only a signal ends it earlier.
		time.Sleep(childDeadline)
	case "opencode-run":
		fakeOpenCodeRun()
	default:
		os.Exit(2)
	}
	os.Exit(0)
}

// The fake's argv grammar, `run`'s flags and free arguments (the subcommand first, then the
// prompt).
var valueFlags = map[string]bool{
	"--format": true, "-m": true, "--model": true, "--variant": true, "--session": true, "--agent": true,
}
var booleanFlags = map[string]bool{"--auto": true, "--print-logs": true, "-c": true, "--continue": true}

func fakeParseArgs(argv []string) (flags map[string]string, positionals []string, ok bool) {
	flags = map[string]string{}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case booleanFlags[arg]:
			flags[arg] = ""
		case valueFlags[arg] && i+1 < len(argv):
			flags[arg] = argv[i+1]
			i++
		case len(arg) > 1 && arg[0] == '-':
			fmt.Fprintf(os.Stderr, "Error: Unknown option: %s\n", arg)
			return nil, nil, false
		default:
			positionals = append(positionals, arg)
		}
	}
	return flags, positionals, true
}

func fakeEnv(environ []string, name string) string {
	for _, entry := range environ {
		if value, found := strings.CutPrefix(entry, name+"="); found {
			return value
		}
	}
	return ""
}

// loggedEnv is the whole environment the run passed, the fake's own knobs left out.
func loggedEnv(environ []string) map[string]string {
	env := map[string]string{}
	for _, entry := range environ {
		name, value, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "FAKE_") || name == childScenarioEnv || name == "GOCOVERDIR" {
			continue
		}
		env[name] = value
	}
	return env
}

func writeJsonLine(path string, value any) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		os.Exit(2)
	}
	_ = os.WriteFile(path, buf.Bytes(), 0o600)
}

// startServerChild is opencode's leftover server child: in the run's process group, holding no
// pipes, still there after the run has exited. Its pid is written to pidFile.
func startServerChild(pidFile string) {
	exe, err := os.Executable()
	if err != nil {
		os.Exit(2)
	}
	child := exec.Command(exe)
	child.Env = []string{childScenarioEnv + "=server-child"}
	if dir := os.Getenv("GOCOVERDIR"); dir != "" {
		child.Env = append(child.Env, "GOCOVERDIR="+dir)
	}
	if err := child.Start(); err != nil {
		os.Exit(2)
	}
	_ = os.WriteFile(pidFile, []byte(strconv.Itoa(child.Process.Pid)), 0o600)
}

// fakeOpenCodeRun is the executable stand-in for `opencode run --format json`: it writes the
// JSONL lines of a fixture file to stdout verbatim — malformed lines included — then exits the
// way the real run did (event shapes recorded from opencode 1.18.34, testdata/engines/opencode).
func fakeOpenCodeRun() {
	argv := os.Args[1:]
	environ := os.Environ()
	flags, positionals, ok := fakeParseArgs(argv)
	if !ok {
		os.Exit(2)
	}
	if len(positionals) == 0 || positionals[0] != "run" {
		fmt.Fprintln(os.Stderr, "fake opencode: only `run` is supported")
		os.Exit(2)
	}
	fixturePath := fakeEnv(environ, "FAKE_OPENCODE_FIXTURE")
	if fixturePath == "" {
		fmt.Fprintln(os.Stderr, "fake opencode: FAKE_OPENCODE_FIXTURE is not set")
		os.Exit(2)
	}
	if file := fakeEnv(environ, "FAKE_OPENCODE_ARGV_LOG"); file != "" {
		writeJsonLine(file, argv)
	}
	if file := fakeEnv(environ, "FAKE_OPENCODE_ENV_LOG"); file != "" {
		writeJsonLine(file, loggedEnv(environ))
	}
	// What the real run prints with --session it does not have (ANSI red included), with no
	// stdout at all.
	if fakeEnv(environ, "FAKE_OPENCODE_RESUME_MISSING") == "1" {
		if _, has := flags["--session"]; has {
			fmt.Fprint(os.Stderr, "\x1b[91m\x1b[1mError: \x1b[0mSession not found\n")
			os.Exit(1)
		}
	}
	if pidFile := fakeEnv(environ, "FAKE_OPENCODE_CHILD_PIDFILE"); pidFile != "" {
		startServerChild(pidFile)
	}
	if line := fakeEnv(environ, "FAKE_OPENCODE_STDERR"); line != "" {
		fmt.Fprintln(os.Stderr, line)
	}
	lineMs, _ := strconv.Atoi(fakeEnv(environ, "FAKE_OPENCODE_LINE_MS"))
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake opencode: read fixture: "+err.Error())
		os.Exit(2)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if line == "" {
			continue
		}
		if lineMs > 0 {
			time.Sleep(time.Duration(lineMs) * time.Millisecond)
		}
		_, _ = os.Stdout.WriteString(line + "\n")
	}
	if fakeEnv(environ, "FAKE_OPENCODE_HANG") == "1" {
		time.Sleep(childDeadline)
	}
	exit, _ := strconv.Atoi(fakeEnv(environ, "FAKE_OPENCODE_EXIT"))
	os.Exit(exit)
}

// ── the worker tests ────────────────────────────────────────────────────────────────────────

// The environment the orchestrator runs in: the user's own (HOME, the user's own XDG dirs and a
// key for opencode's own provider) plus what the plugin and the Claude Code session added (the
// plugin's key and knobs, the router URL).
var parentEnv = domain.EnvLookup{
	"PATH":                 os.Getenv("PATH"),
	"HOME":                 os.Getenv("HOME"),
	"XDG_CONFIG_HOME":      "/home/user/.config",
	"OPENROUTER_API_KEY":   "users-own-key",
	"ZAI_API_KEY":          "plugin-provider-key",
	"ZAI_BASE_URL":         "https://api.z.ai/api/anthropic",
	"ANTHROPIC_BASE_URL":   "http://127.0.0.1:18787",
	"ANTHROPIC_AUTH_TOKEN": "router-token",
}

// withheld names the plugin's provider variables, as engine-wire withholds them.
func withheld(name string) bool {
	return name == "ZAI_API_KEY" || strings.HasPrefix(name, "ZAI_")
}

// newSession is the orchestrator's session key; the engine's own id only ever appears in events.
const newSession = "00000000-0000-7000-8000-000000000001"

// reportPrompt is the report prompt the adapter builds for jobSpec (its schema is
// {"type":"object"}).
var reportPrompt = domain.ReportInstructions("Rename foo.ts to bar.ts.", json.RawMessage(`{"type":"object"}`))

// happyResult is the result a happy single-step run synthesizes (fixture timestamps, so the
// numbers are exact).
var happyResult = domain.WorkerEvent{
	Kind:             domain.WorkerEventResult,
	Text:             `{"kind":"file"}`,
	StructuredOutput: json.RawMessage(`{"kind":"file"}`),
	Turns:            1,
	DurationMs:       581,
	CostUSD:          0.0002,
	Usage:            domain.ResultUsage{InputTokens: 100, OutputTokens: 20, CacheReadTokens: 50, CacheWriteTokens: 10},
}

const fencedText = "Here is the rename report:\n```json\n{\"kind\":\"file\"}\n```"
const proseText = `Done! {"kind":"file"} — everything moved.`

var zeroUsage = domain.ResultUsage{}

// specOverrides are the knobs the adapter tests turn; nil keeps jobSpec's default.
type specOverrides struct {
	access    *ports.Access
	effort    *string
	addDirs   []string
	session   *ports.WorkerSession
	timeoutMs *int64
}

func ptrAccess(access ports.Access) *ports.Access { return &access }
func ptrString(text string) *string               { return &text }
func ptrInt64(value int64) *int64                 { return &value }

func fixtureEnv(t *testing.T, name string) map[string]string {
	t.Helper()
	env := map[string]string{
		childScenarioEnv:        "opencode-run",
		"FAKE_OPENCODE_FIXTURE": filepath.Join(testkit.ModuleRoot(t), "testdata", "engines", "opencode", name),
	}
	// GOCOVERDIR comes along when the test run itself is covered, so the re-executed fake stays
	// silent on stderr instead of warning about it.
	if dir := os.Getenv("GOCOVERDIR"); dir != "" {
		env["GOCOVERDIR"] = dir
	}
	return env
}

// withEnv merges extra knobs (the fake's, or a brief's env) over a base env map.
func withEnv(base map[string]string, extra map[string]string) map[string]string {
	merged := make(map[string]string, len(base)+len(extra))
	for name, value := range base {
		merged[name] = value
	}
	for name, value := range extra {
		merged[name] = value
	}
	return merged
}

func selfExe(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	return exe
}

func newWorker(bin string) *OpenCodeWorker {
	return NewOpenCodeWorker(OpenCodeOptions{
		Bin:         bin,
		ParentEnv:   parentEnv,
		Withheld:    withheld,
		StopGraceMs: 2_000,
	})
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

func startRun(t *testing.T, spec ports.WorkerSpec) ports.WorkerRun {
	t.Helper()
	run, err := newWorker(selfExe(t)).Start(context.Background(), spec)
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
func (l *eventLog) waitFor(t *testing.T, kind domain.WorkerEventKind) domain.WorkerEvent {
	t.Helper()
	var found domain.WorkerEvent
	err := testkit.Until(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		for _, event := range l.seen {
			if event.Kind == kind {
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

// eventEqual compares two events field for field, with the cost compared within a small
// tolerance (0.001 + 0.002 is not exactly 0.003 in binary).
func eventEqual(got, want domain.WorkerEvent) bool {
	costsClose := got.CostUSD == want.CostUSD || math.Abs(got.CostUSD-want.CostUSD) <= 1e-9
	got.CostUSD, want.CostUSD = 0, 0
	return costsClose && reflect.DeepEqual(got, want)
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

func exitCode(code int64) *int64 { return &code }

func assertExit(t *testing.T, got, want ports.WorkerExit) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("exit = %+v, want %+v", got, want)
	}
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

// recordedRun is one full run with the argv/env recorders on.
type recordedRun struct {
	argv   []string
	env    map[string]string
	config map[string]any
	jobDir string
}

func recordRun(t *testing.T, passEnv map[string]string, overrides specOverrides) recordedRun {
	t.Helper()
	logs := t.TempDir()
	spec, dir := jobSpec(t, withEnv(fixtureEnv(t, "happy.jsonl"), withEnv(map[string]string{
		"FAKE_OPENCODE_ARGV_LOG": filepath.Join(logs, "argv.json"),
		"FAKE_OPENCODE_ENV_LOG":  filepath.Join(logs, "env.json"),
	}, passEnv)), overrides)
	run := startRun(t, spec)
	_, done := collectEvents(run)
	exit := run.Wait()
	<-done
	if exit.Code == nil || *exit.Code != 0 {
		t.Fatalf("fake opencode exited with %+v: %s", exit.Code, exit.StderrTail)
	}
	var argv []string
	if err := readJsonFile(filepath.Join(logs, "argv.json"), &argv); err != nil {
		t.Fatalf("read argv.json: %v", err)
	}
	env := map[string]string{}
	if err := readJsonFile(filepath.Join(logs, "env.json"), &env); err != nil {
		t.Fatalf("read env.json: %v", err)
	}
	config := map[string]any{}
	if err := json.Unmarshal([]byte(env["OPENCODE_CONFIG_CONTENT"]), &config); err != nil {
		t.Fatalf("OPENCODE_CONFIG_CONTENT %q: %v", env["OPENCODE_CONFIG_CONTENT"], err)
	}
	return recordedRun{argv: argv, env: env, config: config, jobDir: dir}
}

func readJsonFile(path string, into any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, into)
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

func TestOpenCodeWorker(t *testing.T) {
	t.Run("starts a readonly run on opencode's own setup: no model in argv, only the job's permissions added", func(t *testing.T) {
		run := recordRun(t, map[string]string{
			// The brief's env cannot re-route opencode or smuggle a key in: reserved names are dropped.
			"ZAI_API_KEY":        "brief-supplied",
			"OTHER_API_KEY":      "other",
			"OPENCODE_LOG_LEVEL": "debug",
			"XDG_DATA_HOME":      "/elsewhere",
			"GREETING":           "hi",
		}, specOverrides{access: ptrAccess(ports.AccessReadonly)})
		wantArgv := []string{"run", "--format", "json", "--auto", reportPrompt}
		if !reflect.DeepEqual(run.argv, wantArgv) {
			t.Fatalf("argv = %q, want %q", strings.Join(run.argv, "\n"), strings.Join(wantArgv, "\n"))
		}
		// The user's own environment, their own config dirs included, reaches opencode.
		for name, want := range map[string]string{
			"HOME":               os.Getenv("HOME"),
			"XDG_CONFIG_HOME":    "/home/user/.config",
			"OPENROUTER_API_KEY": "users-own-key",
			"GREETING":           "hi",
		} {
			if got := run.env[name]; got != want {
				t.Errorf("env[%s] = %q, want %q", name, got, want)
			}
		}
		for _, name := range []string{
			"ZAI_API_KEY", "ZAI_BASE_URL", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
			"OTHER_API_KEY", "OPENCODE_LOG_LEVEL", "XDG_DATA_HOME", "OPENCODE_DISABLE_AUTOUPDATE",
		} {
			if _, has := run.env[name]; has {
				t.Errorf("env carries %s, want it withheld", name)
			}
		}
		// The one thing the plugin adds is the job's access; no provider, model, endpoint or key.
		wantConfig := map[string]any{"permission": map[string]any{"edit": "deny", "bash": "deny", "question": "deny"}}
		if !reflect.DeepEqual(run.config, wantConfig) {
			t.Fatalf("config = %v, want %v", run.config, wantConfig)
		}
		var everything strings.Builder
		for _, arg := range run.argv {
			everything.WriteString(arg)
		}
		for name, value := range run.env {
			everything.WriteString(name + "=" + value)
		}
		for _, secret := range []string{"plugin-provider-key", "brief-supplied", "api.z.ai", "18787"} {
			if strings.Contains(everything.String(), secret) {
				t.Errorf("argv or env leaks %q", secret)
			}
		}
		if _, err := os.Stat(filepath.Join(run.jobDir, "engine")); err == nil {
			t.Error("job dir has an engine entry, want none")
		}
	})

	for _, access := range []ports.Access{ports.AccessWrite, ports.AccessExec} {
		t.Run("opens "+string(access)+": --auto approves what the config leaves", func(t *testing.T) {
			run := recordRun(t, nil, specOverrides{access: &access})
			if !slices.Contains(run.argv, "--auto") {
				t.Errorf("argv %v has no --auto", run.argv)
			}
			wantEdit := "allow"
			if access == ports.AccessExec {
				wantEdit = "deny"
			}
			permission, ok := run.config["permission"].(map[string]any)
			if !ok {
				t.Fatalf("config has no permission object: %v", run.config)
			}
			for name, want := range map[string]any{"edit": wantEdit, "bash": "allow", "question": "deny"} {
				if got := permission[name]; got != want {
					t.Errorf("permission[%s] = %v, want %v", name, got, want)
				}
			}
		})
	}

	t.Run("takes effort and a resume, and has nothing to do with addDirs", func(t *testing.T) {
		session := ports.WorkerSession{Kind: ports.SessionKindResume, Key: "ses_00000001"}
		run := recordRun(t, nil, specOverrides{
			access:  ptrAccess(ports.AccessReadonly),
			effort:  ptrString("high"),
			addDirs: []string{"/refs/one", "/refs/two"},
			session: &session,
		})
		wantArgv := []string{"run", "--format", "json", "--variant", "high", "--auto", "--session", "ses_00000001", reportPrompt}
		if !reflect.DeepEqual(run.argv, wantArgv) {
			t.Fatalf("argv = %q, want %q", strings.Join(run.argv, "\n"), strings.Join(wantArgv, "\n"))
		}
	})

	t.Run("folds a happy run: the session, the final text as the report, then the result", func(t *testing.T) {
		worker := newWorker(selfExe(t))
		spec, _ := jobSpec(t, fixtureEnv(t, "happy.jsonl"), specOverrides{})
		seen, exit := finishRun(t, spec)
		assertEvents(t, seen, []domain.WorkerEvent{
			{Kind: domain.WorkerEventSession, SessionID: "ses_00000001"},
			{Kind: domain.WorkerEventAssistantText, Text: `{"kind":"file"}`},
			happyResult,
		})
		assertExit(t, exit, ports.WorkerExit{Code: exitCode(0)})
		// The synthetic engine_result line folds back into the same result event.
		logged := logLines(t, spec.LogPath)
		if len(logged) != 4 {
			t.Fatalf("log has %d lines, want 4", len(logged))
		}
		assertEvents(t, worker.ParseLine(logged[3]), []domain.WorkerEvent{happyResult})
		if err := worker.Dispose(context.Background()); err != nil {
			t.Fatalf("dispose: %v", err)
		}
	})

	t.Run("folds a tool run: the call and its outcome, a second step, usage summed over both", func(t *testing.T) {
		seen, exit := finishRun(t, mustSpec(t, fixtureEnv(t, "tool-run.jsonl")))
		assertEvents(t, seen, []domain.WorkerEvent{
			{Kind: domain.WorkerEventSession, SessionID: "ses_00000002"},
			{Kind: domain.WorkerEventToolUse, Name: "bash", Summary: "echo hi"},
			{Kind: domain.WorkerEventToolResult},
			{Kind: domain.WorkerEventSession, SessionID: "ses_00000002"},
			{Kind: domain.WorkerEventAssistantText, Text: `{"kind":"file"}`},
			{
				Kind:             domain.WorkerEventResult,
				Text:             `{"kind":"file"}`,
				StructuredOutput: json.RawMessage(`{"kind":"file"}`),
				Turns:            2,
				DurationMs:       950,
				CostUSD:          0.003,
				Usage:            domain.ResultUsage{InputTokens: 140, OutputTokens: 24, CacheReadTokens: 500, CacheWriteTokens: 4},
			},
		})
		if exit.Code == nil || *exit.Code != 0 {
			t.Fatalf("exit code = %v, want 0", exit.Code)
		}
	})

	t.Run("reports the stream's own error event and fails the run with its message", func(t *testing.T) {
		failure := "Unexpected server error. Check server logs for details."
		spec, _ := jobSpec(t, withEnv(fixtureEnv(t, "error-event.jsonl"), map[string]string{"FAKE_OPENCODE_EXIT": "1"}), specOverrides{})
		seen, exit := finishRun(t, spec)
		assertEvents(t, seen, []domain.WorkerEvent{
			{Kind: domain.WorkerEventSession, SessionID: "ses_00000003"},
			{Kind: domain.WorkerEventAssistantText, Text: "I will check the directory first."},
			{Kind: domain.WorkerEventError, Message: failure},
			{
				Kind:       domain.WorkerEventResult,
				IsError:    true,
				Text:       failure,
				Turns:      0,
				DurationMs: 300,
				Usage:      zeroUsage,
			},
		})
		assertExit(t, exit, ports.WorkerExit{Code: exitCode(1)})
	})

	t.Run("fails a run that exits without a finished step, even on exit 0", func(t *testing.T) {
		failure := "opencode exited without a finished step (exit 0)"
		seen, exit := finishRun(t, mustSpec(t, fixtureEnv(t, "no-step-finish.jsonl")))
		assertEvents(t, seen, []domain.WorkerEvent{
			{Kind: domain.WorkerEventSession, SessionID: "ses_00000004"},
			{Kind: domain.WorkerEventAssistantText, Text: `{"kind":"file"}`},
			{Kind: domain.WorkerEventError, Message: failure},
			{
				Kind:       domain.WorkerEventResult,
				IsError:    true,
				Text:       failure,
				DurationMs: 200,
				Usage:      zeroUsage,
			},
		})
		assertExit(t, exit, ports.WorkerExit{Code: exitCode(0)})
	})

	t.Run("skips lines that are not events and keeps them in the raw log", func(t *testing.T) {
		spec, _ := jobSpec(t, fixtureEnv(t, "malformed.jsonl"), specOverrides{})
		seen, exit := finishRun(t, spec)
		assertEvents(t, seen, []domain.WorkerEvent{
			{Kind: domain.WorkerEventSession, SessionID: "ses_00000001"},
			{Kind: domain.WorkerEventAssistantText, Text: `{"kind":"file"}`},
			happyResult,
		})
		if exit.Code == nil || *exit.Code != 0 {
			t.Fatalf("exit code = %v, want 0", exit.Code)
		}
		// Six fixture lines and the engine_result line; the junk survives verbatim.
		logged := logLines(t, spec.LogPath)
		if len(logged) != 7 {
			t.Fatalf("log has %d lines, want 7", len(logged))
		}
		if !slices.Contains(logged, "this line is not json") {
			t.Errorf("log lost the junk line: %q", logged)
		}
	})

	t.Run("reads the report out of a ```json fence", func(t *testing.T) {
		seen, _ := finishRun(t, mustSpec(t, fixtureEnv(t, "fenced-report.jsonl")))
		assertEvents(t, seen, []domain.WorkerEvent{
			{Kind: domain.WorkerEventSession, SessionID: "ses_00000005"},
			{Kind: domain.WorkerEventAssistantText, Text: fencedText},
			{
				Kind:             domain.WorkerEventResult,
				Text:             fencedText,
				StructuredOutput: json.RawMessage(`{"kind":"file"}`),
				Turns:            1,
				DurationMs:       450,
				CostUSD:          0.0001,
				Usage:            domain.ResultUsage{InputTokens: 90, OutputTokens: 30, CacheReadTokens: 40},
			},
		})
	})

	t.Run("salvages the report out of prose around it", func(t *testing.T) {
		seen, _ := finishRun(t, mustSpec(t, fixtureEnv(t, "prose-report.jsonl")))
		assertEvents(t, seen, []domain.WorkerEvent{
			{Kind: domain.WorkerEventSession, SessionID: "ses_00000006"},
			{Kind: domain.WorkerEventAssistantText, Text: proseText},
			{
				Kind:             domain.WorkerEventResult,
				Text:             proseText,
				StructuredOutput: json.RawMessage(`{"kind":"file"}`),
				Turns:            1,
				DurationMs:       450,
				CostUSD:          0.0001,
				Usage:            domain.ResultUsage{InputTokens: 80, OutputTokens: 40, CacheReadTokens: 30},
			},
		})
	})

	t.Run("has no structured output to salvage when the final text is plain prose", func(t *testing.T) {
		seen, _ := finishRun(t, mustSpec(t, fixtureEnv(t, "plain-text.jsonl")))
		assertEvents(t, seen, []domain.WorkerEvent{
			{Kind: domain.WorkerEventSession, SessionID: "ses_00000007"},
			{Kind: domain.WorkerEventAssistantText, Text: "The rename is complete."},
			{
				Kind:       domain.WorkerEventResult,
				Text:       "The rename is complete.",
				Turns:      1,
				DurationMs: 300,
				CostUSD:    0.00005,
				Usage:      domain.ResultUsage{InputTokens: 60, OutputTokens: 10, CacheReadTokens: 20},
			},
		})
	})

	t.Run(`times a hanging run out: the exit is forced "timeout" and no result is invented`, func(t *testing.T) {
		// The wall clock starts at spawn, so it must outlast the fake's boot: the two events the
		// fixture prints before it hangs have to be out before the timeout, or the event list
		// would be shorter on a loaded box.
		spec, _ := jobSpec(t, withEnv(fixtureEnv(t, "no-step-finish.jsonl"), map[string]string{"FAKE_OPENCODE_HANG": "1"}),
			specOverrides{timeoutMs: ptrInt64(2_000)})
		run := startRun(t, spec)
		pid := enginePid(t, spec)
		log, done := collectEvents(run)
		exit := run.Wait()
		<-done
		if exit.Forced == nil || *exit.Forced != domain.ForcedTimeout {
			t.Fatalf("exit forced = %v, want timeout", exit.Forced)
		}
		// "No exit code" is the signal death.
		if exit.Code != nil {
			t.Fatalf("exit code = %v, want none", *exit.Code)
		}
		assertEvents(t, log.all(), []domain.WorkerEvent{
			{Kind: domain.WorkerEventSession, SessionID: "ses_00000004"},
			{Kind: domain.WorkerEventAssistantText, Text: `{"kind":"file"}`},
		})
		if testkit.IsPidAlive(int(pid)) {
			t.Fatalf("engine pid %d still alive", pid)
		}
	})

	t.Run(`stops on request: the exit is forced "stopped" and the group dies`, func(t *testing.T) {
		spec, _ := jobSpec(t, withEnv(fixtureEnv(t, "no-step-finish.jsonl"), map[string]string{"FAKE_OPENCODE_HANG": "1"}), specOverrides{})
		run := startRun(t, spec)
		pid := enginePid(t, spec)
		log, done := collectEvents(run)
		log.waitFor(t, domain.WorkerEventAssistantText)
		if err := run.Interrupt(context.Background(), ports.InterruptStopped); err != nil {
			t.Fatalf("interrupt: %v", err)
		}
		exit := run.Wait()
		<-done
		if exit.Forced == nil || *exit.Forced != domain.ForcedStopped {
			t.Fatalf("exit forced = %v, want stopped", exit.Forced)
		}
		if exit.Signal == nil || *exit.Signal != "SIGTERM" {
			t.Fatalf("exit signal = %v, want SIGTERM", exit.Signal)
		}
		assertEvents(t, log.all(), []domain.WorkerEvent{
			{Kind: domain.WorkerEventSession, SessionID: "ses_00000004"},
			{Kind: domain.WorkerEventAssistantText, Text: `{"kind":"file"}`},
		})
		if testkit.IsPidAlive(int(pid)) {
			t.Fatalf("engine pid %d still alive", pid)
		}
	})

	t.Run("reaps the server child the run leaves behind", func(t *testing.T) {
		logs := t.TempDir()
		spec, _ := jobSpec(t, withEnv(fixtureEnv(t, "happy.jsonl"), map[string]string{
			"FAKE_OPENCODE_CHILD_PIDFILE": filepath.Join(logs, "child.pid"),
		}), specOverrides{})
		_, exit := finishRun(t, spec)
		assertExit(t, exit, ports.WorkerExit{Code: exitCode(0)})
		raw, err := os.ReadFile(filepath.Join(logs, "child.pid"))
		if err != nil {
			t.Fatalf("read child.pid: %v", err)
		}
		child, err := strconv.Atoi(strings.TrimSpace(string(raw)))
		if err != nil || child <= 1 {
			t.Fatalf("child pid = %q, want an integer above 1", raw)
		}
		if err := testkit.UntilGone(t, child, testkit.UntilOptions{}); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("flags a resume the engine does not know as sessionMissing", func(t *testing.T) {
		failure := "opencode exited without a finished step (exit 1)"
		session := ports.WorkerSession{Kind: ports.SessionKindResume, Key: "ses_99999999"}
		spec, _ := jobSpec(t, withEnv(fixtureEnv(t, "happy.jsonl"), map[string]string{"FAKE_OPENCODE_RESUME_MISSING": "1"}),
			specOverrides{session: &session})
		seen, exit := finishRun(t, spec)
		assertEvents(t, seen, []domain.WorkerEvent{
			{Kind: domain.WorkerEventError, Message: failure},
			{
				Kind:    domain.WorkerEventResult,
				IsError: true,
				Text:    failure,
				Usage:   zeroUsage,
			},
		})
		if exit.Code == nil || *exit.Code != 1 {
			t.Fatalf("exit code = %v, want 1", exit.Code)
		}
		if !exit.SessionMissing {
			t.Error("exit sessionMissing = false, want true")
		}
		if !strings.Contains(exit.StderrTail, "Session not found") {
			t.Errorf("stderr tail = %q, want it to contain the session error", exit.StderrTail)
		}
	})

	t.Run("preflight needs nothing of the plugin's: opencode brings its own login", func(t *testing.T) {
		if err := newWorker(selfExe(t)).Preflight(context.Background()); err != nil {
			t.Fatalf("preflight = %v, want nil", err)
		}
	})

	t.Run("reports a missing binary as spawn_failed", func(t *testing.T) {
		spec, _ := jobSpec(t, fixtureEnv(t, "happy.jsonl"), specOverrides{})
		_, err := newWorker("/no/such/opencode").Start(context.Background(), spec)
		var workerErr *ports.WorkerError
		if !errors.As(err, &workerErr) {
			t.Fatalf("start error = %v, want a worker error", err)
		}
		if workerErr.Kind != ports.WorkerErrorSpawnFailed {
			t.Errorf("error kind = %s, want spawn_failed", workerErr.Kind)
		}
		if !strings.Contains(workerErr.Message, "ENOENT") {
			t.Errorf("error message = %q, want it to name ENOENT", workerErr.Message)
		}
		if _, ok := adapters.ReadEnginePid(domain.EnginePidBeside(spec.LogPath)); ok {
			t.Error("a failed start left an engine pid behind")
		}
	})

	// The worker keeps the engine pid record beside the attempt log, so it is covered here
	// directly.
	t.Run("records the engine's group leader beside the attempt log while it runs", func(t *testing.T) {
		spec, _ := jobSpec(t, withEnv(fixtureEnv(t, "no-step-finish.jsonl"), map[string]string{
			"FAKE_OPENCODE_HANG":   "1",
			"FAKE_OPENCODE_STDERR": " ",
		}), specOverrides{})
		run := startRun(t, spec)
		pidFile := domain.EnginePidBeside(spec.LogPath)
		pid := enginePid(t, spec)
		if !testkit.IsPidAlive(int(pid)) {
			t.Fatalf("engine pid %d is not alive while the run hangs", pid)
		}
		if err := run.Interrupt(context.Background(), ports.InterruptStopped); err != nil {
			t.Fatalf("interrupt: %v", err)
		}
		exit := run.Wait()
		if _, has := adapters.ReadEnginePid(pidFile); has {
			t.Error("engine pid file survived the run, want it cleared")
		}
		if testkit.IsPidAlive(int(pid)) {
			t.Fatalf("engine pid %d still alive", pid)
		}
		// A blank stderr line is terminal noise: benign, kept out of the tail.
		if exit.StderrTail != "" {
			t.Errorf("stderr tail = %q, want the blank line left out", exit.StderrTail)
		}
	})

	t.Run("closes the events and invents nothing when the attempt log cannot be written", func(t *testing.T) {
		// A directory where the log should be: every append fails, so the pump stops at the
		// first line and the run ends with no events at all.
		dir := t.TempDir()
		spec, _ := jobSpec(t, fixtureEnv(t, "happy.jsonl"), specOverrides{})
		spec.LogPath = filepath.Join(dir, "as-a-directory")
		if err := os.Mkdir(spec.LogPath, 0o755); err != nil {
			t.Fatal(err)
		}
		seen, exit := finishRun(t, spec)
		if len(seen) != 0 {
			t.Fatalf("events = %s, want none", formatEvents(seen))
		}
		if exit.Code == nil || *exit.Code != 0 {
			t.Fatalf("exit code = %v, want 0", exit.Code)
		}
	})

	t.Run("carries the engine's caps: engine-keyed sessions, no schema of its own, no budget", func(t *testing.T) {
		caps := newWorker(selfExe(t)).Caps()
		if caps.Name != ports.WorkerNameOpencode || caps.SessionKey != ports.SessionKeyEngine || caps.NativeSchema {
			t.Fatalf("caps = %+v, want opencode on engine session keys without native schema", caps)
		}
		if !reflect.DeepEqual(caps.Efforts, []string{"low", "high", "max"}) || caps.Budget {
			t.Errorf("terms = %+v, want efforts low/high/max and no budget", caps.WorkerTerms)
		}
		if caps.BriefNotes.Effort == "" || caps.BriefNotes.AddDirs == "" || caps.BriefNotes.BudgetUSD == "" || caps.BriefNotes.Readonly == "" {
			t.Errorf("brief notes = %+v, want every one written", caps.BriefNotes)
		}
	})
}

// mustSpec is jobSpec with nothing overridden.
func mustSpec(t *testing.T, passEnv map[string]string) ports.WorkerSpec {
	t.Helper()
	spec, _ := jobSpec(t, passEnv, specOverrides{})
	return spec
}

func TestOpenCodeWorkerParseLine(t *testing.T) {
	worker := newWorker(selfExe(t))

	t.Run("folds only what it knows", func(t *testing.T) {
		for _, line := range []string{
			"this line is not json",
			`{"type":"step_finish","part":{}}`,
			`{"type":"reasoning","part":{}}`,
			`{"type":"text","part":{"type":"text","text":42}}`,
			`{"type":"text","part":{"type":"text","text":""}}`,
		} {
			if got := worker.ParseLine(line); len(got) != 0 {
				t.Errorf("ParseLine(%s) = %s, want none", line, formatEvents(got))
			}
		}
	})

	t.Run("folds the session id off step_start only", func(t *testing.T) {
		got := worker.ParseLine(`{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}`)
		assertEvents(t, got, []domain.WorkerEvent{{Kind: domain.WorkerEventSession, SessionID: "ses_1"}})
		if got := worker.ParseLine(`{"type":"step_start","part":{"type":"step-start"}}`); len(got) != 0 {
			t.Errorf("ParseLine(step_start without a session id) = %s, want none", formatEvents(got))
		}
	})

	t.Run("folds a tool call once it can say what it is about, and its outcome when it has one", func(t *testing.T) {
		tool := func(state string, toolName *string) string {
			part := map[string]any{"type": "tool", "state": json.RawMessage(state)}
			if toolName != nil {
				part["tool"] = *toolName
			}
			raw, err := json.Marshal(map[string]any{"type": "tool_use", "part": part})
			if err != nil {
				t.Fatal(err)
			}
			return string(raw)
		}
		bash, edit, read, grep := "bash", "edit", "read", "grep"
		assertEvents(t, worker.ParseLine(tool(`{"status":"pending","input":{"command":"ls -la"}}`, &bash)), []domain.WorkerEvent{
			{Kind: domain.WorkerEventToolUse, Name: "bash", Summary: "ls -la"},
		})
		assertEvents(t, worker.ParseLine(tool(`{"status":"running"}`, &edit)), []domain.WorkerEvent{
			{Kind: domain.WorkerEventToolUse, Name: "edit"},
		})
		assertEvents(t, worker.ParseLine(tool(`{"status":"completed","title":"read package.json"}`, &read)), []domain.WorkerEvent{
			{Kind: domain.WorkerEventToolUse, Name: "read", Summary: "read package.json"},
			{Kind: domain.WorkerEventToolResult},
		})
		assertEvents(t, worker.ParseLine(tool(`{"status":"error","title":"grep main"}`, &grep)), []domain.WorkerEvent{
			{Kind: domain.WorkerEventToolUse, Name: "grep", Summary: "grep main"},
			{Kind: domain.WorkerEventToolResult, IsError: true},
		})
		// A state that is not an object has no input to name the call after, so the summary is
		// empty — the same silence an empty record gives.
		assertEvents(t, worker.ParseLine(tool(`"broken-state"`, &bash)), []domain.WorkerEvent{
			{Kind: domain.WorkerEventToolUse, Name: "bash"},
		})
		// Without a tool name there is nothing to report, whatever the state says.
		if got := worker.ParseLine(tool(`{"status":"completed","title":"orphan"}`, nil)); len(got) != 0 {
			t.Errorf("ParseLine(tool_use without a name) = %s, want none", formatEvents(got))
		}
	})

	t.Run("unwraps the error's message, then its name, then gives up", func(t *testing.T) {
		errorLine := func(payload string) string {
			return `{"type":"error","error":` + payload + `}`
		}
		assertEvents(t, worker.ParseLine(errorLine(`{"data":{"message":"boom"}}`)), []domain.WorkerEvent{
			{Kind: domain.WorkerEventError, Message: "boom"},
		})
		assertEvents(t, worker.ParseLine(errorLine(`{"name":"ProviderError"}`)), []domain.WorkerEvent{
			{Kind: domain.WorkerEventError, Message: "ProviderError"},
		})
		assertEvents(t, worker.ParseLine(errorLine(`{}`)), []domain.WorkerEvent{
			{Kind: domain.WorkerEventError, Message: "opencode reported an error"},
		})
	})

	t.Run("folds the appended engine_result line back into the result event", func(t *testing.T) {
		assertEvents(t, worker.ParseLine(`{"type":"engine_result"}`), []domain.WorkerEvent{{
			Kind:  domain.WorkerEventResult,
			Usage: zeroUsage,
		}})
		// A report the line spells null reads as none, exactly like a missing one.
		assertEvents(t, worker.ParseLine(`{"type":"engine_result","structuredOutput":null}`), []domain.WorkerEvent{{
			Kind:  domain.WorkerEventResult,
			Usage: zeroUsage,
		}})
		// A status the line carries rides along; opencode itself never writes one.
		folded := worker.ParseLine(`{"type":"engine_result","apiErrorStatus":503}`)
		if len(folded) != 1 || folded[0].APIErrorStatus == nil || *folded[0].APIErrorStatus != 503 {
			t.Errorf("ParseLine(engine_result with a status) = %s, want the status folded", formatEvents(folded))
		}
	})
}

// Direct coverage of the pieces these tests do not otherwise walk: a signalled exit that no run
// forces, and the marshal helpers' error arms.
func TestOpenCodeInternals(t *testing.T) {
	t.Run("names the signal or the exit code when a run ends without a finished step", func(t *testing.T) {
		if got := unfinishedMessage(process.ProcessExit{Signal: "SIGSEGV"}); got != "opencode exited without a finished step (SIGSEGV)" {
			t.Errorf("unfinishedMessage(signal) = %q", got)
		}
		code := 0
		if got := unfinishedMessage(process.ProcessExit{Code: &code}); got != "opencode exited without a finished step (exit 0)" {
			t.Errorf("unfinishedMessage(exit 0) = %q", got)
		}
	})

	t.Run("keeps a multi-key report's key order in the result and the engine_result line", func(t *testing.T) {
		report := `{"zeta":1,"alpha":2}`
		code := 0
		result := synthesizeResult(&runTally{finalText: report, finished: true}, process.ProcessExit{Code: &code})
		// Byte for byte, as JSON.stringify wrote it: a decoded map would re-render it sorted.
		if string(result.StructuredOutput) != report {
			t.Errorf("structuredOutput = %s, want %s", result.StructuredOutput, report)
		}
		line, err := engineResultLine(result)
		if err != nil {
			t.Fatalf("engineResultLine: %v", err)
		}
		if !strings.Contains(line, `"structuredOutput":`+report) {
			t.Errorf("engine_result line = %s, want the report in its written order", line)
		}
	})

	t.Run("refuses an engine_result line whose report cannot be encoded", func(t *testing.T) {
		if line, err := engineResultLine(domain.WorkerEvent{
			Kind:             domain.WorkerEventResult,
			StructuredOutput: json.RawMessage("{broken"),
		}); err == nil {
			t.Errorf("engineResultLine(broken report) = %q, want an error", line)
		}
	})

	t.Run("names the binary the run starts", func(t *testing.T) {
		if got := openCodeBinary(""); got != "opencode" {
			t.Errorf("openCodeBinary(\"\") = %q, want opencode", got)
		}
		if got := openCodeBinary("/opt/opencode/bin"); got != "/opt/opencode/bin" {
			t.Errorf("openCodeBinary(override) = %q, want it back", got)
		}
	})

	t.Run("blank stderr is blank by JS trim's set", func(t *testing.T) {
		if !blankStderr(" ") || !blankStderr(" ") || blankStderr("x") {
			t.Error("blankStderr misclassifies a space, a Zs space or a letter")
		}
	})
}
