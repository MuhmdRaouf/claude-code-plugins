package cli_test

// The renderUsage and runCli halves of the advisor suite; the app halves live in
// internal/app/advisor_test.go.

import (
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/render"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
)

// advisorNoon is the suite's fixed clock: Oct 7 2026, noon, local.
var advisorNoon = time.Date(2026, time.October, 7, 12, 0, 0, 0, time.Local).UnixMilli()

// advisorQuiet is the all-zero health report.
var advisorQuiet = app.RouterHealthCounts{}

// advisorUsageText renders the usage report the way `usage` prints it.
func advisorUsageText(health *app.RouterHealthCounts, advice *app.FlashAdvice) string {
	return render.Usage(testkit.ReferenceProvider, render.UsageReport{
		Windows: []app.UsageWindow{},
		Jobs:    []domain.TierUsage{},
		Engines: []domain.EngineUsage{},
		AllJobs: []domain.Job{},
		Now:     advisorNoon,
		Health:  health,
		Advice:  advice,
	})
}

// advisorTenRuns is the advice ten readonly main-model runs produce.
func advisorTenRuns() app.FlashAdvice {
	return app.FlashAdvice{
		MainModel: "glm-5.3", FlashModel: "glm-5.3-flash",
		Runs: 10, LightJobs: 10, LightAgents: 0,
		Tokens: app.TokenTotals{InputTokens: 10_000_000, OutputTokens: 10_000},
	}
}

// advisorLightJob is one light readonly job with a million input tokens, its attempt ended
// yesterday.
func advisorLightJob(id string) domain.Job {
	usage := domain.Usage{Turns: 3, InputTokens: 1_000_000, OutputTokens: 1000, DurationMs: 1000}
	started := "2026-10-06T09:00:00.000Z"
	ended := "2026-10-06T10:00:00.000Z"
	return testkit.AJob(func(j *domain.Job) {
		j.ID = id
		j.Brief = testkit.ABrief(func(b *domain.Brief) { b.Mode = domain.ModeReadonly })
		j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
			a.StartedAt = started
			a.EndedAt = &ended
			a.Usage = &usage
		})}
	})
}

func TestAdvisorRenderedLines(t *testing.T) {
	t.Run("prints the health line and, with enough data, the advisor's cautious estimate; never a change", func(t *testing.T) {
		advice := advisorTenRuns()
		if text := advisorUsageText(&advisorQuiet, &advice); !strings.Contains(text,
			"Router health, last 24 h: no fallbacks, refusals, rate limits or restarts.") {
			t.Fatalf("health line missing from\n%s", text)
		}
		counted := app.RouterHealthCounts{Fallback: 1, Refusal: 2, RateLimited: 3}
		if text := advisorUsageText(&counted, &advice); !strings.Contains(text,
			"Router health, last 24 h: 1 fallback · 2 refusals · 3 rate limits · 0 restarts") {
			t.Fatalf("health line missing from\n%s", text)
		}
		stopped := app.RouterHealthCounts{Restart: 1, BudgetStop: 2}
		if text := advisorUsageText(&stopped, &advice); !strings.Contains(text,
			"Router health, last 24 h: 0 fallbacks · 0 refusals · 0 rate limits · 1 restart · 2 budget stops") {
			t.Fatalf("health line missing from\n%s", text)
		}
		if text := advisorUsageText(nil, &advice); strings.Contains(text, "Router health") {
			t.Fatalf("health line without counts:\n%s", text)
		} else if tail := lastLines(text, 4); !equalStrings(tail, []string{
			"Model advisor (an estimate; nothing was changed)",
			"10 of 10 glm-5.3 runs in the last 30 days looked light: read-only or sweep jobs, or few turns and short answers.",
			"On glm-5.3-flash they could have cost about $12.54 less at list prices, if the flash model handles them as well.",
			"For work like that, try `model: flash` in a brief or the zai:glm-5.3-flash agent.",
		}) {
			t.Fatalf("advisor block = %q", tail)
		}
		quiet := advice
		quiet.Runs = 3
		if text := advisorUsageText(nil, &quiet); strings.Contains(text, "Model advisor") {
			t.Fatalf("advisor speaks on thin data:\n%s", text)
		}
	})
}

// lastLines is text's last n lines.
func lastLines(text string, n int) []string {
	lines := strings.Split(text, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

func TestAdvisorUsageJSON(t *testing.T) {
	t.Run("usage --json carries the health counts always and the advisor only when it speaks", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		world.Clock.Advance(advisorNoon - world.Clock.Now())

		if code := cliRun(t, world, "usage", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		quiet := jsonOf(t, lastLine(world))
		health, ok := quiet["routerHealth"].(map[string]any)
		if !ok {
			t.Fatalf("routerHealth = %v", quiet["routerHealth"])
		}
		for _, name := range []string{"fallback", "refusal", "rate_limited", "budget_stop", "restart"} {
			if health[name] != float64(0) {
				t.Fatalf("%s = %v", name, health[name])
			}
		}
		if _, has := quiet["advisor"]; has {
			t.Fatalf("advisor = %v", quiet["advisor"])
		}

		for i := range 10 {
			world.Store.Put(advisorLightJob(string(rune('a' + i))))
		}
		if code := cliRun(t, world, "usage", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		advised := jsonOf(t, lastLine(world))
		advisor, ok := advised["advisor"].(map[string]any)
		if !ok {
			t.Fatalf("advisor = %v", advised["advisor"])
		}
		if advisor["runs"] != float64(10) || advisor["lightJobs"] != float64(10) || advisor["lightAgents"] != float64(0) {
			t.Fatalf("advisor = %v", advisor)
		}
		if saving, ok := advisor["estSavingUsd"].(float64); !ok || saving < 12.538 || saving > 12.541 {
			t.Fatalf("estSavingUsd = %v", advisor["estSavingUsd"])
		}
		if code := cliRun(t, world, "usage"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		text := world.Out.Lines[len(world.Out.Lines)-1]
		if !strings.Contains(text, "Model advisor (an estimate; nothing was changed)") {
			t.Fatalf("advisor missing from the report")
		}
		if !strings.Contains(text, "Router health, last 24 h:") {
			t.Fatalf("health line missing from the report")
		}
	})
}

// lastLine is the last line the fakes recorded.
func lastLine(world fakedeps.Fakes) string {
	return world.Out.Lines[len(world.Out.Lines)-1]
}
