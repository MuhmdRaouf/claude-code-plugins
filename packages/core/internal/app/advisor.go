// The model advisor: which of the plugin's own main-model runs over the last 30 days looked small
// enough for the flash model. A run is a claude-engine job or a subagent the router served; it
// looks light when it was read-only or a sweep (a job not in edit mode), or when it took few turns
// and wrote little. This only reads the records the plugin already keeps; `/<p>:usage` prices the
// light runs on both models and words the result as an estimate. It never changes a brief, an
// agent or a setting.
package app

import (
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// A run this short (model turns, or requests for a subagent) and this quiet (output tokens) looks
// flash-sized.
const (
	LightTurns        = 10
	LightOutputTokens = 4000
)

// TokenTotals is tokens summed over runs, in the price table's shape.
type TokenTotals struct {
	InputTokens      int64 `json:"inputTokens"`
	OutputTokens     int64 `json:"outputTokens"`
	CacheReadTokens  int64 `json:"cacheReadTokens"`
	CacheWriteTokens int64 `json:"cacheWriteTokens"`
}

// FlashAdvice is what the advisor found: how many main-model runs it looked at, how many looked
// light, and their tokens.
type FlashAdvice struct {
	MainModel  string `json:"mainModel"`
	FlashModel string `json:"flashModel"`
	// Main-model runs in the window.
	Runs int64 `json:"runs"`
	// Those that looked light: jobs and subagents apart.
	LightJobs   int64 `json:"lightJobs"`
	LightAgents int64 `json:"lightAgents"`
	// The light runs' tokens, to price on both models.
	Tokens TokenTotals `json:"tokens"`
}

// advisorSource says which half a run came from: a claude job or a subagent.
type advisorSource string

const (
	advisorSourceJob   advisorSource = "job"
	advisorSourceAgent advisorSource = "agent"
)

// advisorRun is one main-model run the advisor judged.
type advisorRun struct {
	light  bool
	source advisorSource
	tokens TokenTotals
}

// advisorZero is the empty total every sum starts from.
var advisorZero = TokenTotals{}

// advisorAdd sums two token totals.
func advisorAdd(a, b TokenTotals) TokenTotals {
	return TokenTotals{
		InputTokens:      a.InputTokens + b.InputTokens,
		OutputTokens:     a.OutputTokens + b.OutputTokens,
		CacheReadTokens:  a.CacheReadTokens + b.CacheReadTokens,
		CacheWriteTokens: a.CacheWriteTokens + b.CacheWriteTokens,
	}
}

// advisorJobRuns is the main-model jobs on the claude engine with an attempt ended since since, as
// runs.
func advisorJobRuns(jobs []domain.Job, since int64) []advisorRun {
	var runs []advisorRun
	for _, job := range jobs {
		if job.Brief.Engine != nil || job.Brief.Model != domain.ModelTierMain {
			continue
		}
		var usages []domain.Usage
		for _, attempt := range job.Attempts {
			if attempt.Usage == nil {
				continue
			}
			// An unreadable timestamp is never inside the window: it compares like NaN.
			ended := attempt.StartedAt
			if attempt.EndedAt != nil {
				ended = *attempt.EndedAt
			}
			if ts, ok := activityParseTs(ended); !ok || ts < since {
				continue
			}
			usages = append(usages, *attempt.Usage)
		}
		if len(usages) == 0 {
			continue
		}
		tokens := advisorZero
		var turns int64
		for _, usage := range usages {
			tokens = advisorAdd(tokens, TokenTotals{
				InputTokens:      usage.InputTokens,
				OutputTokens:     usage.OutputTokens,
				CacheReadTokens:  usage.CacheReadTokens,
				CacheWriteTokens: usage.CacheWriteTokens,
			})
			turns += usage.Turns
		}
		light := job.Brief.Mode != domain.ModeEdit ||
			(turns <= LightTurns && tokens.OutputTokens <= LightOutputTokens)
		runs = append(runs, advisorRun{light: light, source: advisorSourceJob, tokens: tokens})
	}
	return runs
}

// advisorAgentTally is one agent's requests and tokens so far.
type advisorAgentTally struct {
	requests int64
	tokens   TokenTotals
}

// advisorAgentRuns is the subagents the router sent to the main model since since, one run per
// agent id. A main session is the user's own `/model` choice and is left alone.
func advisorAgentRuns(plugin, model string, events []domain.SpoolEvent, since int64) []advisorRun {
	agents := map[string]*advisorAgentTally{}
	var ids []string
	for _, event := range RoutesOf(plugin, events) {
		if event.Route != "provider" || event.Model != model || event.AgentID == nil {
			continue
		}
		if ts, ok := activityParseTs(event.Ts); !ok || ts < since {
			continue
		}
		seen := agents[*event.AgentID]
		if seen == nil {
			seen = &advisorAgentTally{}
			agents[*event.AgentID] = seen
			ids = append(ids, *event.AgentID)
		}
		seen.requests++
		seen.tokens = advisorAdd(seen.tokens, TokenTotals{
			InputTokens:      TokenCount(event.Usage, "input_tokens"),
			OutputTokens:     TokenCount(event.Usage, "output_tokens"),
			CacheReadTokens:  TokenCount(event.Usage, "cache_read_input_tokens"),
			CacheWriteTokens: TokenCount(event.Usage, "cache_creation_input_tokens"),
		})
	}
	runs := make([]advisorRun, 0, len(ids))
	for _, id := range ids {
		tally := agents[id]
		runs = append(runs, advisorRun{
			light:  tally.requests <= LightTurns && tally.tokens.OutputTokens <= LightOutputTokens,
			source: advisorSourceAgent,
			tokens: tally.tokens,
		})
	}
	return runs
}

// FlashAdviceOf is the advisor's findings over the plugin's jobs and its router's spool since
// since (epoch ms).
func FlashAdviceOf(provider domain.Provider, jobs []domain.Job, events []domain.SpoolEvent, since int64) FlashAdvice {
	mainModel := provider.Catalog[domain.ModelTierMain].ID
	runs := append(advisorJobRuns(jobs, since),
		advisorAgentRuns(provider.Name, mainModel, events, since)...)
	var lightJobs, lightAgents int64
	tokens := advisorZero
	for _, run := range runs {
		if !run.light {
			continue
		}
		if run.source == advisorSourceJob {
			lightJobs++
		} else {
			lightAgents++
		}
		tokens = advisorAdd(tokens, run.tokens)
	}
	return FlashAdvice{
		MainModel:   mainModel,
		FlashModel:  provider.Catalog[domain.ModelTierFlash].ID,
		Runs:        int64(len(runs)),
		LightJobs:   lightJobs,
		LightAgents: lightAgents,
		Tokens:      tokens,
	}
}

// The window the advisor looks at: the last 30 calendar days, like the usage report's longest
// window.
const advisorDays = 30

// ModelAdvice is the advisor over every job on this machine and the spool events `usage` already
// read.
func ModelAdvice(deps Deps, jobs []domain.Job, events []domain.SpoolEvent) FlashAdvice {
	return FlashAdviceOf(deps.Provider, jobs, events, WindowStart(deps.Clock.Now(), advisorDays))
}
