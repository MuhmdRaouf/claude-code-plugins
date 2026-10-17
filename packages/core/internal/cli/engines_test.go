package cli_test

// The runCli halves of the engines suite: the board and usage tables, the show envelope, the
// no-engines report and the decide commands' engine terminations. The engine selection and
// driving halves live in internal/app.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// cliEngineJob is one job on (or off) an engine, with one attempt that used the tool's own
// numbers.
func cliEngineJob(id string, engine *domain.EngineTool, state domain.JobState, model *string) domain.Job {
	usage := domain.Usage{
		Turns: 3, InputTokens: 100, OutputTokens: 20,
		CacheReadTokens: 10, CacheWriteTokens: 5,
		CostUSD: 0.25, RateLimitRetries: 0, DurationMs: 1000, Model: model,
	}
	return testkit.AJob(func(j *domain.Job) {
		j.ID = id
		j.State = state
		if engine != nil {
			j.Brief.Engine = engine
		}
		j.Workspace.RepoRoot = "/repo"
		j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
			a.Usage = &usage
		})}
		j.UpdatedAt = "2026-10-06T00:00:00.000Z"
	})
}

// cliEnginePtr is a typed pointer for the table literals above.
func cliEnginePtr(tool domain.EngineTool) *domain.EngineTool {
	named := tool
	return &named
}

// cliStringPtr is a string pointer for the table literals above.
func cliStringPtr(text string) *string { return &text }

func TestCliEngineBoardRows(t *testing.T) {
	t.Run("an engine job shows its engine as KIND, the tool's own model and numbers, and its pid while the driver lives", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		world.Store.Put(cliEngineJob("j1", cliEnginePtr(domain.EngineToolOmp), domain.JobStateRunning, cliStringPtr("openrouter/qwen-coder")))
		world.Store.Put(cliEngineJob("j2", nil, domain.JobStateAccepted, nil))
		world.Store.Put(cliEngineJob("j3", cliEnginePtr(domain.EngineToolPi), domain.JobStateAwaitingReview, nil))
		world.Store.HoldLock("j1", int64(os.Getpid()))
		adapters.WriteEnginePid(world.Store.Paths("j1").EnginePid, 61_300)
		adapters.WriteEnginePid(world.Store.Paths("j3").EnginePid, 61_301)

		if code := cliRun(t, world, "board"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		text := world.Out.Text()
		// The tool runs on its own setup: its row names the model the tool reported, never the
		// provider's catalog.
		if !regexp.MustCompile(`omp +j1 +openrouter/qwen-coder +running \(pid 61300\) +3 +100 +20 `).MatchString(text) {
			t.Fatalf("board =\n%s", text)
		}
		if !regexp.MustCompile(`pi +j3 +- +review: no verdict +3 +100 +20 `).MatchString(text) {
			t.Fatalf("board =\n%s", text)
		}
		if !strings.Contains(text,
			"omp, pi rows: model and numbers as the tool itself reports them (it runs on its own setup).") {
			t.Fatalf("board =\n%s", text)
		}
	})
}

func TestCliEngineUsageRows(t *testing.T) {
	t.Run("usage keeps the claude ledger to claude jobs and adds one row per engine", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		world.Store.Put(cliEngineJob("j1", cliEnginePtr(domain.EngineToolOmp), domain.JobStateAccepted, cliStringPtr("zai/glm-5.3")))
		world.Store.Put(cliEngineJob("j2", cliEnginePtr(domain.EngineToolOmp), domain.JobStateDiscarded, cliStringPtr("anthropic/claude-sonnet")))
		world.Store.Put(cliEngineJob("j3", nil, domain.JobStateAccepted, nil))

		if code := cliRun(t, world, "usage"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		text := world.Out.Text()
		if !strings.Contains(text,
			"zai engines (as each tool reports them; the tools run on their own setup)\n") {
			t.Fatalf("engines section missing from\n%s", text)
		}
		if !strings.Contains(text, "Jobs on omp, opencode, pi or zcode are not in the total") {
			t.Fatalf("engines note missing from\n%s", text)
		}
		if !regexp.MustCompile(`ENGINE +MODEL +JOBS +ACCEPTED +REQ +IN +OUT +CACHE R +CACHE W +COST`).MatchString(text) {
			t.Fatalf("engines table missing from\n%s", text)
		}
		var ompLine string
		for _, line := range strings.Split(text, "\n") {
			if strings.HasPrefix(line, "omp") {
				ompLine = line
				break
			}
		}
		if fields := strings.Fields(ompLine); !equalStrings(fields, []string{
			"omp", "anthropic/claude-sonnet,", "zai/glm-5.3", "2", "1", "6", "200", "40", "20", "10", "$0.5000",
		}) {
			t.Fatalf("omp row = %q", ompLine)
		}
		if code := cliRun(t, world, "usage", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if engines := jsonOf(t, lastLine(world))["engines"].([]any); len(engines) != 1 {
			t.Fatalf("engines = %v", engines)
		}
	})

	t.Run("with no engine jobs, usage has no engines section and no engines key", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		world.Store.Put(cliEngineJob("j3", nil, domain.JobStateAccepted, nil))

		if code := cliRun(t, world, "usage", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		raw := lastLine(world)
		var order []string
		for _, field := range []string{"estimate", "spool", "jobs", "routerHealth"} {
			if at := strings.Index(raw, `"`+field+`":`); at < 0 {
				t.Fatalf("%s missing from %s", field, raw)
			} else {
				order = append(order, field)
			}
		}
		if strings.Contains(raw, `"engines"`) {
			t.Fatalf("engines key in %s", raw)
		}
		if code := cliRun(t, world, "usage"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if strings.Contains(world.Out.Text(), "engines") {
			t.Fatalf("engines section in\n%s", world.Out.Text())
		}
	})

	t.Run("an engine job's live progress is folded by its own engine's parser", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		pi := fakes.NewScriptedWorker(t, world.Process)
		world.Deps.Engines = &app.EngineWorkers{
			Worker: func(domain.EngineTool) ports.Worker { return pi },
			Bin:    func(tool domain.EngineTool) string { return "/opt/" + string(tool) + "/bin/" + string(tool) },
		}
		world.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Brief.Engine = cliEnginePtr(domain.EngineToolPi)
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		logPath := world.Store.Paths("j1").AttemptLog(1)
		if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(logPath, []byte(fakes.Wire.Text("from pi")+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}

		if code := cliRun(t, world, "show", "j1", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		parsed := jsonOf(t, lastLine(world))
		progress, ok := parsed["progress"].(map[string]any)
		if !ok {
			t.Fatalf("progress = %v", parsed["progress"])
		}
		if progress["lastText"] != "from pi" {
			t.Fatalf("lastText = %v", progress["lastText"])
		}
	})
}

func TestCliEngineDecideTerminates(t *testing.T) {
	t.Run("discard terminates the engine group after the driver that held the job is gone", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		world.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Brief.Engine = cliEnginePtr(domain.EngineToolOpencode)
		}))
		world.Process.SetAlive(61_236, true)
		adapters.WriteEnginePid(world.Store.Paths("j1").EnginePid, 61_236)

		if code := cliRun(t, world, "discard", "j1"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if terminated := world.Process.Terminated(); !containsInt(terminated, 61_236) {
			t.Fatalf("terminated = %v", terminated)
		}
	})

	t.Run("stop of a job with no live driver terminates its engine too", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		world.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Brief.Engine = cliEnginePtr(domain.EngineToolOmp)
		}))
		world.Process.SetAlive(61_237, true)
		adapters.WriteEnginePid(world.Store.Paths("j1").EnginePid, 61_237)

		if code := cliRun(t, world, "stop", "j1"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if terminated := world.Process.Terminated(); !containsInt(terminated, 61_237) {
			t.Fatalf("terminated = %v", terminated)
		}
	})
}

// containsInt says whether want is in the list.
func containsInt(list []int64, want int64) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}
