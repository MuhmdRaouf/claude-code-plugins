package cli_test

// The edge branches of the cli suites: the error arms the happy-path cases never walk (a stuck
// clock, a store that fails mid-command, unwritable template paths), plus the runCli lines of the
// engines suite's engine-flag cases.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
)

// stuckClock is a clock whose sleep never happens.
type stuckClock struct {
	ports.Clock
}

func (stuckClock) Sleep(context.Context, int64) error {
	return errors.New("clock stuck")
}

// flakyFindStore finds ids until its Nth call, then fails as a broken disk does. A multi-follow
// looks ids up from several goroutines, so the count carries its own lock.
type flakyFindStore struct {
	ports.JobStore
	mu        sync.Mutex
	calls     int
	failAfter int
	fail      error
}

func (s *flakyFindStore) Find(ctx context.Context, id string) (domain.Job, error) {
	s.mu.Lock()
	s.calls++
	over := s.calls > s.failAfter
	s.mu.Unlock()
	if over {
		return domain.Job{}, s.fail
	}
	return s.JobStore.Find(ctx, id)
}

func TestCliEdgeClocks(t *testing.T) {
	t.Run("board --watch on a clock that cannot wait is one unexpected line", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		cliReviewable(t, world)
		world.Deps.Clock = stuckClock{Clock: world.Clock}

		code := withTTY(t, true, func() cli.ExitCode { return cliRun(t, world, "board", "--watch") })

		if code != cli.ExitUnexpected {
			t.Fatalf("exit = %d, want 1", code)
		}
		if !reflect.DeepEqual(world.Out.Errors, []string{"zai: unexpected error: clock stuck"}) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
	})

	t.Run("show --follow returns the row it has when the clock or the store gives up", func(t *testing.T) {
		stuck := fakedeps.FakeDeps(t)
		stuck.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		stuck.Store.HoldLock("j1", int64(os.Getpid()))
		stuck.Deps.Clock = stuckClock{Clock: stuck.Clock}

		if code := cliRun(t, stuck, "show", "j1", "--follow"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if last := stuck.Out.Lines[len(stuck.Out.Lines)-1]; !strings.HasPrefix(last, "zai job j1:") {
			t.Fatalf("job = %q", last)
		}

		broken := fakedeps.FakeDeps(t)
		broken.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		broken.Store.HoldLock("j1", int64(os.Getpid()))
		broken.Deps.Store = &flakyFindStore{JobStore: broken.Store, failAfter: 1, fail: errors.New("disk on fire")}

		if code := cliRun(t, broken, "show", "j1", "--follow"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if last := broken.Out.Lines[len(broken.Out.Lines)-1]; !strings.HasPrefix(last, "zai job j1:") {
			t.Fatalf("job = %q", last)
		}
	})
}

func TestCliEdgeStores(t *testing.T) {
	t.Run("a store that fails mid-command is one unexpected line, whatever the command", func(t *testing.T) {
		stop := fakedeps.FakeDeps(t)
		stop.Store.Put(testkit.AJob(func(j *domain.Job) { j.ID = "j-idle"; j.State = domain.JobStateQueued }))
		stop.Deps.Store = &flakyFindStore{JobStore: stop.Store, failAfter: 0, fail: errors.New("disk on fire")}
		if code := cliRun(t, stop, "stop", "j-idle"); code != cli.ExitUnexpected {
			t.Fatalf("exit = %d, want 1", code)
		}
		if last := stop.Out.Errors[len(stop.Out.Errors)-1]; last != "zai: unexpected error: disk on fire" {
			t.Fatalf("error = %q", last)
		}

		wait := fakedeps.FakeDeps(t)
		for _, id := range []string{"j1", "j2"} {
			wait.Store.Put(testkit.AJob(func(j *domain.Job) {
				j.ID = id
				j.State = domain.JobStateRunning
				j.Attempts = []domain.Attempt{testkit.AnAttempt()}
			}))
		}
		wait.Deps.Store = &flakyFindStore{JobStore: wait.Store, failAfter: 1, fail: errors.New("disk on fire")}
		if code := cliRun(t, wait, "wait", "j1", "j2"); code != cli.ExitUnexpected {
			t.Fatalf("exit = %d, want 1", code)
		}
		if last := wait.Out.Errors[len(wait.Out.Errors)-1]; last != "zai: unexpected error: disk on fire" {
			t.Fatalf("error = %q", last)
		}
	})

	t.Run("batch --wait passes a follow failure through as the unexpected line", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		dir := filepath.Join(world.Root, "briefs")
		cliBriefFile(t, world, cliBrief, "briefs/one.md")
		cliBriefFile(t, world, cliBrief, "briefs/two.md")
		world.Deps.Store = &flakyFindStore{JobStore: world.Store, failAfter: 1, fail: errors.New("disk on fire")}

		code := cliRun(t, world, "batch", dir, "--wait")

		if code != cli.ExitUnexpected {
			t.Fatalf("exit = %d, want 1", code)
		}
		if last := world.Out.Errors[len(world.Out.Errors)-1]; last != "zai: unexpected error: disk on fire" {
			t.Fatalf("error = %q", last)
		}
	})

	t.Run("wait on a landed job without a verdict is not a pass", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		cliReviewable(t, world, func(j *domain.Job) {
			j.Attempts[0].Verdict = nil
		})

		if code := cliRun(t, world, "wait", "261006-review"); code != cli.ExitNotPass {
			t.Fatalf("exit = %d, want 3", code)
		}
	})

	t.Run("accept explains a verification that failed in the fresh checkout, with its tail", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		cliReviewable(t, world, func(j *domain.Job) {
			j.Brief.Gates = []domain.Gate{{Run: "npm test"}}
		})
		world.Git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		world.Gates.FailOnce("npm test")

		code := cliRun(t, world, "accept", "261006-review")

		if code != cli.ExitConflict {
			t.Fatalf("exit = %d, want 5", code)
		}
		joined := strings.Join(world.Out.Errors, "\n")
		if !strings.Contains(joined, "verification in a fresh checkout failed: npm test") {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
		if !strings.Contains(joined, "/zai:review returns the job with the failing output as feedback.") {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
		if !strings.Contains(joined, "\n  1 failing test") {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
	})
}

func TestCliEdgeEngineFlags(t *testing.T) {
	t.Run("an unknown --engine is a usage error; an unknown engine: is a brief error", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		brief := cliBriefFile(t, world, "---\ntitle: Rename foo\nengine: cursor\n---\nRename `foo` to `bar`.\n")

		if code := cliRun(t, world, "run", brief, "--engine", "cursor"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if world.Out.Errors[0] != "zai: --engine must be one of claude, omp, opencode, pi, zcode" {
			t.Fatalf("error = %q", world.Out.Errors[0])
		}
		world.Out.Errors = nil
		if code := cliRun(t, world, "run", brief); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if last := world.Out.Errors[len(world.Out.Errors)-1]; last !=
			"zai: invalid brief: engine: must be one of claude, omp, opencode, pi, zcode" {
			t.Fatalf("error = %q", last)
		}
	})
}

func TestCliEdgeBriefPaths(t *testing.T) {
	t.Run("brief new cuts a long title to the slug limit", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		title := strings.Repeat("a", 80)

		if code := cliRun(t, world, "brief", "new", title); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		want := filepath.Join(world.Root, "briefs", strings.Repeat("a", 60)+".md")
		if world.Out.Lines[0] != want {
			t.Fatalf("path = %q, want %q", world.Out.Lines[0], want)
		}
	})

	t.Run("brief new over a state root it cannot create is one unexpected line", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		blocker := cliWriteFile(t, world.Root, "not-a-dir", "")
		world.Deps.Host.StateRoot = blocker

		code := cliRun(t, world, "brief", "new", "X")

		if code != cli.ExitUnexpected {
			t.Fatalf("exit = %d, want 1", code)
		}
		if last := world.Out.Errors[len(world.Out.Errors)-1]; !strings.HasPrefix(last, "zai: unexpected error: ") {
			t.Fatalf("error = %q", last)
		}
	})

	t.Run("brief new into a directory it cannot write leaves one unexpected line", func(t *testing.T) {
		// chmod 0500 makes the directory unwritable.
		world := fakedeps.FakeDeps(t)
		if err := os.MkdirAll(filepath.Join(world.Root, "briefs"), 0o500); err != nil {
			t.Fatal(err)
		}
		world.Deps.Host.StateRoot = world.Root

		code := cliRun(t, world, "brief", "new", "X")

		if code != cli.ExitUnexpected {
			t.Fatalf("exit = %d, want 1", code)
		}
		if last := world.Out.Errors[len(world.Out.Errors)-1]; !strings.HasPrefix(last, "zai: unexpected error: ") {
			t.Fatalf("error = %q", last)
		}
	})
}

func TestCliEdgeSpoolRows(t *testing.T) {
	t.Run("usage prices the spool's own rows, windows and JSON both", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		world.Clock.Advance(advisorNoon - world.Clock.Now())
		spoolDir := filepath.Join(world.Root, "home", ".agents", "radar", "spool")
		if err := os.MkdirAll(spoolDir, 0o755); err != nil {
			t.Fatal(err)
		}
		ts := time.UnixMilli(advisorNoon).UTC().Format("2006-01-02T15:04:05.000Z")
		event := domain.RouteEvent{
			Ts: ts, Event: domain.EventRoute, Plugin: "zai", Model: "glm-5.3",
			Upstream: "api.z.ai", Route: "provider", Status: 200, LatencyMs: 40,
		}
		line, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		name := time.UnixMilli(advisorNoon).Format("2006-01-02") + ".jsonl"
		if err := os.WriteFile(filepath.Join(spoolDir, name), append(line, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}

		if code := cliRun(t, world, "usage"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if text := world.Out.Text(); !strings.Contains(text, "Today, agents and /model") {
			t.Fatalf("usage =\n%s", text)
		}
		if code := cliRun(t, world, "usage", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		parsed := jsonOf(t, lastLine(world))
		spool := parsed["spool"].([]any)
		today := spool[0].(map[string]any)
		rows := today["rows"].([]any)
		if len(rows) != 1 {
			t.Fatalf("today rows = %v", rows)
		}
		row := rows[0].(map[string]any)
		if row["model"] != "glm-5.3" || row["costUsd"] == nil {
			t.Fatalf("row = %v", row)
		}
	})
}

func TestCliEdgeInvocation(t *testing.T) {
	t.Run("a value JSON cannot carry is an error, not a broken line", func(t *testing.T) {
		call := stubInvocation{deps: fakedeps.FakeDeps(t).Deps}
		if err := call.JSON(make(chan int)); err == nil {
			t.Fatal("JSON accepted a channel")
		}
	})

	t.Run("run with an empty path reads the working directory and fails on it", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)

		if code := cliRun(t, world, "run", ""); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		// The path is the invocation's cwd as the platform resolves it: /repo here, \repo there.
		if !strings.HasPrefix(world.Out.Errors[0], "zai: cannot read "+filepath.Clean("/repo")) {
			t.Fatalf("error = %q", world.Out.Errors[0])
		}
	})

	t.Run("stdout's own TTY sense answers something", func(t *testing.T) {
		_ = cli.StdoutIsTTY()
	})

	t.Run("the hidden entries stay out of the help but keep their usage lines", func(t *testing.T) {
		for _, command := range []cli.Command{cli.AuthServeCommand{}, cli.DriveCommand{}} {
			lines := cli.UsageLines(testkit.ReferenceProvider, command)
			if len(lines) == 0 || !strings.HasPrefix(lines[0], "usage: ") {
				t.Fatalf("usage lines = %q", lines)
			}
		}
	})
}

// stubInvocation is an Invocation over a bare deps, for the methods the commands call directly.
type stubInvocation struct {
	deps app.Deps
}

func (s stubInvocation) Deps() app.Deps                  { return s.deps }
func (s stubInvocation) Cwd() string                     { return "/repo" }
func (s stubInvocation) Positionals() []string           { return nil }
func (s stubInvocation) Flag(string) bool                { return false }
func (s stubInvocation) Text(string) *string             { return nil }
func (s stubInvocation) Usage(string) cli.ExitCode       { return cli.ExitUsage }
func (s stubInvocation) Fail(*app.AppError) cli.ExitCode { return cli.ExitUnexpected }
func (s stubInvocation) JSON(value any) error {
	data, err := domain.MarshalIndentJSON(value)
	if err != nil {
		return err
	}
	s.deps.Out.Line(string(data))
	return nil
}

func TestCliEdgeBatchPaths(t *testing.T) {
	t.Run("a directory the CLI cannot read, a malformed glob and an unreadable manifest all find no briefs", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		dir := filepath.Join(world.Root, "briefs")
		if err := os.MkdirAll(dir, 0o500); err != nil {
			t.Fatal(err)
		}

		if code := cliRun(t, world, "batch", dir); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if last := world.Out.Errors[len(world.Out.Errors)-1]; last != "zai: no briefs found for "+dir {
			t.Fatalf("error = %q", last)
		}

		world.Out.Errors = nil
		if code := cliRun(t, world, "batch", "["); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if last := world.Out.Errors[len(world.Out.Errors)-1]; last != "zai: no briefs found for [" {
			t.Fatalf("error = %q", last)
		}

		// An unreadable manifest: chmod 0000 hides the file.
		manifest := filepath.Join(world.Root, "jobs.txt")
		if err := os.WriteFile(manifest, []byte("one.md\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(manifest, 0o000); err != nil {
			t.Fatal(err)
		}
		world.Out.Errors = nil
		if code := cliRun(t, world, "batch", manifest); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if last := world.Out.Errors[len(world.Out.Errors)-1]; last != "zai: no briefs found for "+manifest {
			t.Fatalf("error = %q", last)
		}
	})
}

func TestCliEdgeWaitAndEngine(t *testing.T) {
	t.Run("wait on a review job with no attempt at all is not a pass", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		cliReviewable(t, world, func(j *domain.Job) { j.Attempts = nil })

		if code := cliRun(t, world, "wait", "261006-review"); code != cli.ExitNotPass {
			t.Fatalf("exit = %d, want 3", code)
		}
	})

	t.Run("run takes a valid --engine once its setup command enabled it", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		omp := domain.EngineToolOmp
		world.EngineConfig.Write(domain.EngineConfig{
			Engines: map[domain.EngineTool]domain.EngineSetting{
				omp: {Watcher: domain.WatcherSonnet, Version: "1", Path: "omp"},
			},
		})

		code := cliRun(t, world, "run", cliBriefFile(t, world), "--engine", "omp", "--bg")

		if code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0; errors = %q", code, world.Out.Errors)
		}
		if got := world.Process.Spawned(); len(got) != 1 {
			t.Fatalf("spawned = %q", got)
		}
	})
}

func TestCliEdgeSetupFailures(t *testing.T) {
	t.Run("setup names a missing agent file on its models line and is not ready", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		if err := os.Remove(filepath.Join(cli.AgentsDir(world.Deps.BundlePath), "glm-5.3.md")); err != nil {
			t.Fatal(err)
		}

		if code := cliRun(t, world, "setup"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if text := world.Out.Text(); !strings.Contains(text, "models:   FAILED: ") {
			t.Fatalf("report =\n%s", text)
		}
	})

	t.Run("setup names a settings file it cannot change on its settings line", func(t *testing.T) {
		// Both halves below hold a directory back with chmod 0500.
		world := fakedeps.FakeDeps(t)
		home := filepath.Join(world.Root, "home", ".claude")
		if err := os.MkdirAll(home, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(home, 0o500); err != nil {
			t.Fatal(err)
		}

		if code := cliRun(t, world, "setup"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if text := world.Out.Text(); !strings.Contains(text, "settings: FAILED: ") {
			t.Fatalf("report =\n%s", text)
		}

		asJSON := fakedeps.FakeDeps(t)
		homeJSON := filepath.Join(asJSON.Root, "home", ".claude")
		if err := os.MkdirAll(homeJSON, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(homeJSON, 0o500); err != nil {
			t.Fatal(err)
		}
		if code := cliRun(t, asJSON, "setup", "--json"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		parsed := jsonOf(t, asJSON.Out.Text())
		settings := parsed["settings"].(map[string]any)
		if settings["ok"] != false || settings["error"] == "" {
			t.Fatalf("settings = %v", settings)
		}
		if settings["changed"] != false {
			t.Fatalf("settings = %v", settings)
		}
	})

	// cliEdgeWriteEngineAgents writes the four wrapper agents a full remove restores.
	cliEdgeWriteEngineAgents := func(t *testing.T, world fakedeps.Fakes) {
		t.Helper()
		for _, tool := range []string{"omp", "opencode", "pi", "zcode"} {
			agent := filepath.Join(cli.AgentsDir(world.Deps.BundlePath), tool+".md")
			if err := os.WriteFile(agent, []byte("model: sonnet\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}

	t.Run("setup --remove reports each failed step and the restored settings", func(t *testing.T) {
		clean := fakedeps.FakeDeps(t)
		cliEdgeWriteEngineAgents(t, clean)
		if code := cliRun(t, clean, "setup"); code != cli.ExitOK {
			t.Fatalf("setup exit = %d, want 0", code)
		}
		clean.Out.Lines = nil
		if code := cliRun(t, clean, "setup", "--remove"); code != cli.ExitOK {
			t.Fatalf("remove exit = %d, want 0", code)
		}
		text := clean.Out.Lines[0]
		if !strings.HasPrefix(text, "zai removed: its agents are back on their models before setup, ") {
			t.Fatalf("outcome = %q", text)
		}
		if !strings.Contains(text, "(restored)") {
			t.Fatalf("outcome = %q", text)
		}

		routerFailed := fakedeps.FakeDeps(t)
		cliEdgeWriteEngineAgents(t, routerFailed)
		if code := cliRun(t, routerFailed, "setup"); code != cli.ExitOK {
			t.Fatalf("setup exit = %d, want 0", code)
		}
		routerFailed.Out.Lines = nil
		routerFailed.Host.RouterRetireErr = errors.New("the router refused")
		if code := cliRun(t, routerFailed, "setup", "--remove"); code != cli.ExitOK {
			t.Fatalf("remove exit = %d, want 0", code)
		}
		if text := routerFailed.Out.Lines[0]; !strings.Contains(text, "router:   FAILED: the router refused") {
			t.Fatalf("report =\n%s", text)
		}

		settingsFailed := fakedeps.FakeDeps(t)
		cliEdgeWriteEngineAgents(t, settingsFailed)
		if code := cliRun(t, settingsFailed, "setup"); code != cli.ExitOK {
			t.Fatalf("setup exit = %d, want 0", code)
		}
		settingsFailed.Out.Lines = nil
		settingsFile := adapters.ClaudeSettingsPath(domain.EnvLookup(settingsFailed.Deps.Env))
		if err := os.WriteFile(settingsFile, []byte("{not json"), 0o644); err != nil {
			t.Fatal(err)
		}
		if code := cliRun(t, settingsFailed, "setup", "--remove"); code != cli.ExitOK {
			t.Fatalf("remove exit = %d, want 0", code)
		}
		if text := settingsFailed.Out.Lines[0]; !strings.Contains(text, "settings: FAILED: ") {
			t.Fatalf("report =\n%s", text)
		}
	})
}

func TestCliEdgeRestartLine(t *testing.T) {
	t.Run("a repaired agent alone still says the session must restart", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		if code := cliRun(t, world, "setup"); code != cli.ExitOK {
			t.Fatalf("setup exit = %d, want 0", code)
		}
		agent := filepath.Join(cli.AgentsDir(world.Deps.BundlePath), "glm-5.3.md")
		if err := os.WriteFile(agent, []byte("model: sonnet\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		world.Out.Lines = nil

		if code := cliRun(t, world, "setup"); code != cli.ExitOK {
			t.Fatalf("setup exit = %d, want 0", code)
		}
		if text := world.Out.Text(); !strings.Contains(text, "Restart Claude Code now.") {
			t.Fatalf("report =\n%s", text)
		}
	})
}

// The --json output is JSON.stringify(x, null, 2) as one line: no trailing newline of its own,
// the output port adds the one the transcript shows. The state-file marshaler's own newline must
// not double it.
func TestJSONOutputSingleTrailingNewline(t *testing.T) {
	world := fakedeps.FakeDeps(t)

	if code := cliRun(t, world, "usage", "--json"); code != cli.ExitOK {
		t.Fatalf("exit = %d, want 0", code)
	}
	if strings.HasSuffix(world.Out.Text(), "\n") {
		t.Fatalf("usage --json ends with a blank line:\n%s", world.Out.Text())
	}
	for _, line := range world.Out.Lines {
		if strings.TrimRight(line, " ") == "" {
			t.Fatalf("usage --json printed an empty line: %q", world.Out.Text())
		}
	}
}
