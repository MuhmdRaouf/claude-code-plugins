package app

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// The engine-row cases ("board and usage engine rows"), calling the app functions directly; the
// runCli render halves live with the CLI.

// activityEngineJob builds a job with one finished attempt whose usage the tool reported, on the
// given engine when there is one.
func activityEngineJob(id string, engine *domain.EngineTool, state domain.JobState, model *string) domain.Job {
	return testkit.AJob(func(j *domain.Job) {
		j.ID = id
		j.State = state
		j.Brief.Engine = engine
		j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
			usage := domain.Usage{
				Turns: 3, InputTokens: 100, OutputTokens: 20,
				CacheReadTokens: 10, CacheWriteTokens: 5,
				CostUSD: 0.25, RateLimitRetries: 0, DurationMs: 1000, Model: model,
			}
			a.Usage = &usage
		})}
		j.UpdatedAt = "2026-10-06T00:00:00.000Z"
	})
}

// activityWriteEnginePid writes a job's engine.pid the way the fs adapter does.
func activityWriteEnginePid(t *testing.T, file string, pid int64) {
	t.Helper()
	if err := os.WriteFile(file, []byte(strconv.FormatInt(pid, 10)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestActivityBoardEngineRows(t *testing.T) {
	ctx := context.Background()

	t.Run("an engine job shows its engine as KIND, the tool's own model and numbers, and its pid while the driver lives", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		omp, pi := domain.EngineToolOmp, domain.EngineToolPi
		w.store.Put(activityEngineJob("j1", &omp, domain.JobStateRunning, strPtr("openrouter/qwen-coder")))
		w.store.Put(activityEngineJob("j2", nil, domain.JobStateAccepted, nil))
		w.store.Put(activityEngineJob("j3", &pi, domain.JobStateAwaitingReview, nil))
		w.store.HoldLock("j1", int64(os.Getpid()))
		activityWriteEnginePid(t, w.store.Paths("j1").EnginePid, 61_300)
		activityWriteEnginePid(t, w.store.Paths("j3").EnginePid, 61_301)

		rows := ActivityBoard(ctx, deps, Scope{RepoRoot: strPtr("/repo"), All: false})

		got := make([][5]any, len(rows))
		for i, row := range rows {
			var pid, model any
			if row.Pid != nil {
				pid = *row.Pid
			}
			if row.Model != nil {
				model = *row.Model
			}
			got[i] = [5]any{string(row.Kind), row.ID, pid, model, derefInt64(row.Requests)}
		}
		// The tool runs on its own setup: its row names the model the tool reported, never the
		// provider's catalog, and j3's engine pid stays hidden because its driver is gone.
		want := [][5]any{
			{"omp", "j1", int64(61_300), "openrouter/qwen-coder", int64(3)},
			{"job", "j2", nil, "glm-5.3", int64(3)},
			{"pi", "j3", nil, nil, int64(3)},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("ActivityBoard() = %v, want %v", got, want)
		}
	})

	t.Run("an engine job with no attempt usages carries no numbers, and a live driver without an engine.pid shows no pid", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		omp := domain.EngineToolOmp
		w.store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Brief.Engine = &omp
		}))
		w.store.HoldLock("j1", int64(os.Getpid())) // live, but no engine.pid file

		rows := ActivityBoard(ctx, deps, Scope{All: true})

		if len(rows) != 1 {
			t.Fatalf("rows = %d, want one", len(rows))
		}
		row := rows[0]
		if row.Kind != ActivityKind(omp) || row.Pid != nil || row.Model != nil {
			t.Errorf("row = %+v, want an omp row with no pid and no model", row)
		}
		if row.Requests != nil || row.InputTokens != nil || row.OutputTokens != nil {
			t.Errorf("numbers = %v/%v/%v, want none before a usage lands",
				row.Requests, row.InputTokens, row.OutputTokens)
		}
	})

	t.Run("usage keeps the claude ledger to claude jobs and adds one row per engine", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		omp := domain.EngineToolOmp
		w.store.Put(activityEngineJob("j1", &omp, domain.JobStateAccepted, strPtr("zai/glm-5.3")))
		w.store.Put(activityEngineJob("j2", &omp, domain.JobStateDiscarded, strPtr("anthropic/claude-sonnet")))
		w.store.Put(activityEngineJob("j3", nil, domain.JobStateAccepted, nil))

		scope := Scope{RepoRoot: strPtr("/repo"), All: false}
		claude := Usage(ctx, deps, scope)
		if len(claude) != 1 || claude[0].Jobs != 1 {
			t.Errorf("Usage() = %+v, want the one claude job's tier row", claude)
		}

		engines := EngineUsage(ctx, deps, scope)
		want := []domain.EngineUsage{{
			Engine: domain.EngineToolOmp,
			Models: []string{"anthropic/claude-sonnet", "zai/glm-5.3"},
			Jobs:   2, Accepted: 1, Requests: 6,
			InputTokens: 200, OutputTokens: 40, CacheReadTokens: 20, CacheWriteTokens: 10,
			CostUSD: 0.5,
		}}
		if !reflect.DeepEqual(engines, want) {
			t.Errorf("EngineUsage() = %+v, want %+v", engines, want)
		}
	})

	t.Run("an engine job's live progress is folded by its own engine's parser", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		engineWorker := fakes.NewScriptedWorker(t, w.process.FakeProcess, fakes.Completes())
		deps.Engines = &EngineWorkers{
			Worker: func(domain.EngineTool) ports.Worker { return engineWorker },
			Bin:    func(tool domain.EngineTool) string { return "/opt/" + string(tool) + "/bin/" + string(tool) },
		}
		pi := domain.EngineToolPi
		job := w.store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Brief.Engine = &pi
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		log := w.store.Paths(job.ID).AttemptLog(1)
		if err := os.MkdirAll(filepath.Dir(log), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(log, []byte(fakes.Wire.Text("from pi")+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}

		rows := Board(ctx, deps, Scope{RepoRoot: strPtr("/repo"), All: false})

		if len(rows) != 1 || rows[0].Progress == nil || rows[0].Progress.LastText != "from pi" {
			t.Errorf("progress = %+v, want the engine's own fold of its log", rows)
		}
	})
}

// derefInt64 is a row's number when it has one, or nil, as a mixed JSON array holds it.
func derefInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}
