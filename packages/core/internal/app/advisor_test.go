package app

import (
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// The router-health and model-advisor cases, calling the app functions directly; the renderUsage
// and runCli halves live with the render and CLI layers.

// advisorSince is the window the advisor tests look back from: Sep 8, local midnight.
var advisorSince = time.Date(2026, time.September, 8, 0, 0, 0, 0, time.Local).UnixMilli()

// advisorJob builds a main-model job on the claude engine with one attempt ended yesterday, its
// usage shaped by apply.
func advisorJob(id string, apply func(*domain.Usage), briefs ...func(*domain.Brief)) domain.Job {
	return testkit.AJob(func(j *domain.Job) {
		j.ID = id
		for _, brief := range briefs {
			brief(&j.Brief)
		}
		usage := domain.Usage{
			Turns: 3, InputTokens: 100_000, OutputTokens: 1000,
			CacheReadTokens: 0, CacheWriteTokens: 0, CostUSD: 0,
			RateLimitRetries: 0, DurationMs: 1000,
		}
		if apply != nil {
			apply(&usage)
		}
		j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
			a.StartedAt = activityAt(-1, 9, 0, 0)
			ended := activityAt(-1, 10, 0, 0)
			a.EndedAt = &ended
			a.Usage = &usage
		})}
	})
}

func TestHealthCounts(t *testing.T) {
	t.Run("counts this plugin's health events per kind, newer than the window only", func(t *testing.T) {
		now := activityNoon
		const hour = int64(3_600_000)
		events := []domain.SpoolEvent{
			domain.HealthEvent("zai", domain.HealthFallback, "no worker was ready", "glm-5.3", now-hour),
			domain.HealthEvent("zai", domain.HealthFallback, "no worker was ready", "", now-2*hour),
			domain.HealthEvent("zai", domain.HealthRefusal, "key: HTTP 401", "glm-5.3", now-3*hour),
			domain.HealthEvent("zai", domain.HealthRateLimited, "HTTP 429", "glm-5.3", now-25*hour),
			domain.HealthEvent("kimi", domain.HealthRestart, "worker exited (SIGKILL)", "", now-hour),
			domain.HealthEvent("zai", domain.HealthBudgetStop, "total budget reached for this day", "glm-5.3", now),
			activityRoute(activityAt(0, 11, 0, 0)),
		}

		got := HealthCounts("zai", events, now-24*hour)

		want := RouterHealthCounts{Fallback: 2, Refusal: 1, RateLimited: 0, BudgetStop: 1, Restart: 0}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("HealthCounts() = %+v, want %+v", got, want)
		}
		// A pointer-typed health event, which the spool reader never makes, counts too.
		pointer := &domain.RouterHealthEvent{
			Kind: domain.HealthEventKind, Plugin: "zai", Event: domain.HealthRefusal, Ts: now,
		}
		if got := HealthCounts("zai", []domain.SpoolEvent{pointer}, 0); got.Refusal != 1 {
			t.Errorf("HealthCounts(pointer) = %+v, want the one refusal", got)
		}
	})
}

func TestFlashAdviceOf(t *testing.T) {
	t.Run("calls a main-model job light when it was read-only or a sweep, or took few turns and wrote little", func(t *testing.T) {
		omp := domain.EngineToolOmp
		jobs := []domain.Job{
			advisorJob("sweep", func(u *domain.Usage) { u.Turns, u.OutputTokens = 40, 50_000 },
				func(b *domain.Brief) { b.Mode = domain.ModeExec }),
			advisorJob("read", func(u *domain.Usage) { u.Turns, u.OutputTokens = 40, 50_000 },
				func(b *domain.Brief) { b.Mode = domain.ModeReadonly }),
			advisorJob("small", func(u *domain.Usage) { u.Turns, u.OutputTokens = 4, 2000 }),
			advisorJob("big", func(u *domain.Usage) { u.Turns, u.OutputTokens = 30, 2000 }),
			advisorJob("wordy", func(u *domain.Usage) { u.Turns, u.OutputTokens = 4, LightOutputTokens+1 }),
			advisorJob("flash", func(u *domain.Usage) { u.Turns = 2 },
				func(b *domain.Brief) { b.Model = domain.ModelTierFlash }),
			advisorJob("omp", func(u *domain.Usage) { u.Turns = 2 },
				func(b *domain.Brief) { b.Engine = &omp }),
			testkit.AJob(func(j *domain.Job) {
				j.ID = "unrun"
				j.Brief.Model = domain.ModelTierMain
			}),
			testkit.AJob(func(j *domain.Job) {
				j.ID = "old"
				j.Brief.Model = domain.ModelTierMain
				j.Brief.Mode = domain.ModeExec
				usage := domain.Usage{Turns: 3, InputTokens: 100_000, OutputTokens: 1000, DurationMs: 1000}
				j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
					a.StartedAt = activityAt(-40, 9, 0, 0)
					ended := activityAt(-40, 10, 0, 0)
					a.EndedAt = &ended
					a.Usage = &usage
				})}
			}),
		}

		advice := FlashAdviceOf(testkit.ReferenceProvider, jobs, nil, advisorSince)

		want := FlashAdvice{
			MainModel: "glm-5.3", FlashModel: "glm-5.3-flash",
			Runs: 5, LightJobs: 3, LightAgents: 0,
			Tokens: TokenTotals{InputTokens: 300_000, OutputTokens: 102_000},
		}
		if !reflect.DeepEqual(advice, want) {
			t.Errorf("FlashAdviceOf() = %+v, want %+v", advice, want)
		}
	})

	t.Run("counts each subagent the router sent to the main model as one run; main sessions and other models are not runs", func(t *testing.T) {
		tokens := domain.RouteUsage{
			"input_tokens": float64(10_000), "output_tokens": float64(100), "cache_read_input_tokens": float64(50),
		}
		agentEvent := func(id string) domain.SpoolEvent {
			return activityRoute(activityAt(-1, 9, 0, 0), func(e *domain.RouteEvent) {
				e.AgentID = &id
				e.Usage = &tokens
			})
		}
		events := []domain.SpoolEvent{}
		for range 3 {
			events = append(events, agentEvent("quick"))
		}
		for range 12 {
			events = append(events, agentEvent("long"))
		}
		session := "main-session"
		flashy := "flashy"
		claude := "claude"
		other := "other"
		ancient := "ancient"
		events = append(events,
			// A main session is the user's own /model choice; flash, anthropic-routed and other
			// plugins' requests are not this provider's main-model runs; the ancient one is outside.
			activityRoute(activityAt(-1, 9, 0, 0), func(e *domain.RouteEvent) {
				e.SessionID = &session
				e.Usage = &tokens
			}),
			activityRoute(activityAt(-1, 9, 0, 0), func(e *domain.RouteEvent) {
				e.AgentID = &flashy
				e.Model = "glm-5.3-flash"
				e.Usage = &tokens
			}),
			activityRoute(activityAt(-1, 9, 0, 0), func(e *domain.RouteEvent) {
				e.AgentID = &claude
				e.Model = "claude-sonnet-5-5"
				e.Route = "anthropic"
			}),
			activityRoute(activityAt(-1, 9, 0, 0), func(e *domain.RouteEvent) {
				e.AgentID = &other
				e.Plugin = "kimi"
			}),
			activityRoute(activityAt(-45, 9, 0, 0), func(e *domain.RouteEvent) {
				e.AgentID = &ancient
				e.Usage = &tokens
			}),
		)

		advice := FlashAdviceOf(testkit.ReferenceProvider, nil, events, advisorSince)

		want := FlashAdvice{
			MainModel: "glm-5.3", FlashModel: "glm-5.3-flash",
			Runs: 2, LightJobs: 0, LightAgents: 1,
			Tokens: TokenTotals{InputTokens: 30_000, OutputTokens: 300, CacheReadTokens: 150},
		}
		if !reflect.DeepEqual(advice, want) {
			t.Errorf("FlashAdviceOf() = %+v, want %+v", advice, want)
		}
	})
}

func TestModelAdvice(t *testing.T) {
	t.Run("prints the health line and, with enough data, the advisor's cautious estimate; never a change", func(t *testing.T) {
		// The CLI case prints renderUsage output; this check covers the advice it printed, the app
		// half.
		deps, w := newWorld(t, nil)
		w.clock.Advance(activityNoon - w.clock.Now())
		jobs := make([]domain.Job, 0, 10)
		for i := range 10 {
			jobs = append(jobs, advisorJob(fmt.Sprintf("j%d", i),
				func(u *domain.Usage) { u.Turns, u.InputTokens, u.OutputTokens = 3, 1_000_000, 1000 },
				func(b *domain.Brief) { b.Mode = domain.ModeReadonly }))
		}

		advice := ModelAdvice(deps, jobs, nil)

		want := FlashAdvice{
			MainModel: "glm-5.3", FlashModel: "glm-5.3-flash",
			Runs: 10, LightJobs: 10, LightAgents: 0,
			Tokens: TokenTotals{InputTokens: 10_000_000, OutputTokens: 10_000},
		}
		if !reflect.DeepEqual(advice, want) {
			t.Errorf("ModelAdvice() = %+v, want 10 light readonly runs", advice)
		}
	})
}

func TestAdvisorRunEdgesDirect(t *testing.T) {
	t.Run("an attempt without usage, or one whose timestamps do not parse, is no run", func(t *testing.T) {
		jobs := []domain.Job{
			testkit.AJob(func(j *domain.Job) {
				j.ID = "logless"
				j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
					a.StartedAt = activityAt(-1, 9, 0, 0)
					ended := activityAt(-1, 10, 0, 0)
					a.EndedAt = &ended // no usage: nothing to judge the run by
				})}
			}),
			testkit.AJob(func(j *domain.Job) {
				j.ID = "timeless"
				usage := domain.Usage{Turns: 1}
				j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
					a.StartedAt = "not a timestamp"
					a.Usage = &usage
				})}
			}),
		}

		advice := FlashAdviceOf(testkit.ReferenceProvider, jobs, nil, advisorSince)

		if advice.Runs != 0 || advice.LightJobs != 0 || advice.Tokens != (TokenTotals{}) {
			t.Errorf("FlashAdviceOf() = %+v, want no runs", advice)
		}
	})
}
