package render

import (
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// JobCostUsd is what one job cost at the list price of the job's model: the plugin's own estimate,
// never the worker's (a `claude -p` worker prices the provider's ids as the Anthropic model they
// stand in for).
func JobCostUsd(provider domain.Provider, job domain.Job) float64 {
	model := ModelID(provider, job)
	var total float64
	for _, attempt := range job.Attempts {
		if attempt.Usage == nil {
			continue
		}
		total += CostUsdOf(model, usageTokens(*attempt.Usage))
	}
	return total
}

// windowCost is one window's estimated cost: the router's requests (agents and `/model`) and the
// jobs' attempts, apart.
type windowCost struct {
	Label  string  `json:"label"`
	Router float64 `json:"router"`
	Jobs   float64 `json:"jobs"`
}

// WindowCosts prices each usage window: the spool's per-model rows plus every job attempt that
// ended in the window. Jobs reach the provider directly, never through the router, so the two never
// count the same request.
func WindowCosts(provider domain.Provider, windows []app.UsageWindow, jobs []domain.Job, now int64) []windowCost {
	// A job on omp, opencode, pi or zcode runs on the tool's own setup and model: only the tool's
	// report prices it.
	priced := make([]domain.Job, 0, len(jobs))
	for _, job := range jobs {
		if job.Brief.Engine == nil {
			priced = append(priced, job)
		}
	}
	costs := make([]windowCost, 0, len(app.USAGE_WINDOWS))
	for _, window := range app.USAGE_WINDOWS {
		since := app.WindowStart(now, window.Days)
		rows := []app.ModelUsage{}
		for _, read := range windows {
			if read.Days == window.Days {
				rows = read.Rows
				break
			}
		}
		var jobsCost float64
		for _, job := range priced {
			model := ModelID(provider, job)
			var jobCost float64
			for _, attempt := range job.Attempts {
				if attempt.Usage == nil {
					continue
				}
				at := attempt.StartedAt
				if attempt.EndedAt != nil {
					at = *attempt.EndedAt
				}
				ended, ok := parseISO(at)
				if !ok || ended.UnixMilli() < since {
					continue
				}
				jobCost += CostUsdOf(model, usageTokens(*attempt.Usage))
			}
			jobsCost += jobCost
		}
		var routerCost float64
		for _, row := range rows {
			routerCost += CostUsdOf(row.Model, modelUsageTokens(row))
		}
		costs = append(costs, windowCost{Label: window.Label, Router: routerCost, Jobs: jobsCost})
	}
	return costs
}

// usageLineNumbers is one row's numbers as the table prints them.
type usageLineNumbers struct {
	requests         int64
	inputTokens      int64
	outputTokens     int64
	cacheReadTokens  int64
	cacheWriteTokens int64
	costUsd          float64
}

// windowTable is one usage window's table: a row per model, then the window's total.
func windowTable(window app.UsageWindow) []string {
	rows := window.Rows
	total := usageLineNumbers{}
	for _, row := range rows {
		total.requests += row.Requests
		total.inputTokens += row.InputTokens
		total.outputTokens += row.OutputTokens
		total.cacheReadTokens += row.CacheReadTokens
		total.cacheWriteTokens += row.CacheWriteTokens
		total.costUsd += CostUsdOf(row.Model, modelUsageTokens(row))
	}
	table := [][]string{{"MODEL", "REQ", "IN", "OUT", "CACHE R", "CACHE W", "EST COST"}}
	for _, row := range rows {
		table = append(table, append([]string{row.Model},
			lineOf(usageLineNumbers{
				requests:         row.Requests,
				inputTokens:      row.InputTokens,
				outputTokens:     row.OutputTokens,
				cacheReadTokens:  row.CacheReadTokens,
				cacheWriteTokens: row.CacheWriteTokens,
				costUsd:          CostUsdOf(row.Model, modelUsageTokens(row)),
			})...))
	}
	table = append(table, append([]string{"TOTAL"}, lineOf(total)...))
	return Table(table)
}

func lineOf(line usageLineNumbers) []string {
	return []string{
		jsNumber(float64(line.requests)),
		Count(float64(line.inputTokens)),
		Count(float64(line.outputTokens)),
		Count(float64(line.cacheReadTokens)),
		Count(float64(line.cacheWriteTokens)),
		Usd(line.costUsd),
	}
}

// headline is the headline: one estimated total per window, then where the 30 days went and what
// the estimate rests on.
func headline(provider domain.Provider, costs []windowCost, models []string) []string {
	totals := make([]string, 0, len(costs))
	for _, cost := range costs {
		totals = append(totals, shortLabel(cost.Label)+" "+Usd(cost.Router+cost.Jobs))
	}
	split := ""
	if len(costs) > 0 {
		month := costs[len(costs)-1]
		split = " (30 days: agents and /model " + Usd(month.Router) + ", jobs " + Usd(month.Jobs) + ")"
	}
	var unpriced, unverified []string
	for _, model := range models {
		price, ok := PriceOf(model)
		if !ok {
			unpriced = append(unpriced, model)
			continue
		}
		if !price.Verified {
			unverified = append(unverified, model)
		}
	}
	lines := []string{
		"Est. cost: " + strings.Join(totals, " · ") + split,
		"Estimated from " + provider.Display + " list prices read " + PricesRetrieved +
			"; your bill is the provider's. Token counts are exact.",
	}
	if len(unpriced) > 0 {
		lines = append(lines, "No list price for "+strings.Join(unpriced, ", ")+": counted as $0.")
	}
	if len(unverified) > 0 {
		lines = append(lines, "Cache rates unverified for "+strings.Join(unverified, ", ")+".")
	}
	return lines
}

// shortLabel lowers a window label the way the headline prints it: "Last 7 days" to "7 days".
func shortLabel(label string) string {
	return strings.ToLower(strings.TrimPrefix(label, "Last "))
}

// engineSection is the delegation engines' section: one row per engine that ran jobs; nothing at
// all when none did. Each tool runs on its own setup, so the row is the tool's own report — the
// models it named and its numbers — and says so.
func engineSection(provider domain.Provider, engines []domain.EngineUsage) []string {
	if len(engines) == 0 {
		return nil
	}
	table := [][]string{{"ENGINE", "MODEL", "JOBS", "ACCEPTED", "REQ", "IN", "OUT", "CACHE R", "CACHE W", "COST"}}
	for _, row := range engines {
		models := "-"
		if len(row.Models) > 0 {
			models = strings.Join(row.Models, ", ")
		}
		table = append(table, append([]string{
			string(row.Engine),
			models,
			jsNumber(float64(row.Jobs)),
			jsNumber(float64(row.Accepted)),
		}, lineOf(usageLineNumbers{
			requests:         row.Requests,
			inputTokens:      row.InputTokens,
			outputTokens:     row.OutputTokens,
			cacheReadTokens:  row.CacheReadTokens,
			cacheWriteTokens: row.CacheWriteTokens,
			costUsd:          row.CostUSD,
		})...))
	}
	return append([]string{
		"",
		provider.Name + " engines (as each tool reports them; the tools run on their own setup)",
	}, Table(table)...)
}

// jobSection is the job ledger: how jobs went, per model. Their cost is in the headline.
func jobSection(provider domain.Provider, jobs []domain.TierUsage) []string {
	if len(jobs) == 0 {
		return []string{"No " + provider.Name + " jobs in this repository yet."}
	}
	table := [][]string{{"MODEL", "JOBS", "ACCEPTED", "DISCARDED", "1ST-TRY", "RETURNS", "IN", "OUT", "429S", "TIME"}}
	for _, row := range jobs {
		table = append(table, []string{
			provider.Catalog[row.Tier].ID,
			jsNumber(float64(row.Jobs)),
			jsNumber(float64(row.Accepted)),
			jsNumber(float64(row.Discarded)),
			Percent(row.FirstTryPassRate),
			jsNumber(float64(row.ReviewReturns)),
			Count(float64(row.InputTokens)),
			Count(float64(row.OutputTokens)),
			jsNumber(float64(row.RateLimitRetries)),
			Duration(float64(row.DurationMs)),
		})
	}
	return append([]string{provider.Name + " jobs in this repository"}, Table(table)...)
}

// healthSection is the router's last 24 hours in one line: what went other than plainly, counted.
func healthSection(health *app.RouterHealthCounts) []string {
	if health == nil {
		return nil
	}
	parts := []string{
		Plural(health.Fallback, "fallback"),
		Plural(health.Refusal, "refusal"),
		Plural(health.RateLimited, "rate limit"),
		Plural(health.Restart, "restart"),
	}
	if health.BudgetStop != 0 {
		parts = append(parts, Plural(health.BudgetStop, "budget stop"))
	}
	quiet := health.Fallback == 0 && health.Refusal == 0 && health.RateLimited == 0 &&
		health.BudgetStop == 0 && health.Restart == 0
	if quiet {
		return []string{"", "Router health, last 24 h: no fallbacks, refusals, rate limits or restarts."}
	}
	return []string{"", "Router health, last 24 h: " + strings.Join(parts, " · ")}
}

// The advisor speaks only with this much to go on: main-model runs looked at, light ones among
// them, and a saving.
const AdvisorMinRuns = 10
const AdvisorMinLight = 3
const advisorMinSavingUsd = 0.01

// AdvisorSaving is what the light runs would have saved on the flash model at list prices; nil when
// either model is unpriced.
func AdvisorSaving(advice app.FlashAdvice) *float64 {
	if _, ok := PriceOf(advice.MainModel); !ok {
		return nil
	}
	if _, ok := PriceOf(advice.FlashModel); !ok {
		return nil
	}
	tokens := TokenCounts{
		InputTokens:      float64(advice.Tokens.InputTokens),
		OutputTokens:     float64(advice.Tokens.OutputTokens),
		CacheReadTokens:  float64(advice.Tokens.CacheReadTokens),
		CacheWriteTokens: float64(advice.Tokens.CacheWriteTokens),
	}
	saving := CostUsdOf(advice.MainModel, tokens) - CostUsdOf(advice.FlashModel, tokens)
	return &saving
}

// AdviceWorthShowing says whether the advisor has enough to say anything: enough runs, enough light
// ones, a priced saving worth a cent.
func AdviceWorthShowing(advice *app.FlashAdvice) bool {
	if advice == nil {
		return false
	}
	light := advice.LightJobs + advice.LightAgents
	saving := AdvisorSaving(*advice)
	return advice.Runs >= AdvisorMinRuns && light >= AdvisorMinLight && saving != nil &&
		*saving >= advisorMinSavingUsd
}

// adviceSection is the model advisor, cautiously worded and only with enough data; it suggests, it
// never changes anything.
func adviceSection(provider domain.Provider, advice *app.FlashAdvice) []string {
	if !AdviceWorthShowing(advice) {
		return nil
	}
	light := advice.LightJobs + advice.LightAgents
	less := 0.0
	if saving := AdvisorSaving(*advice); saving != nil {
		less = *saving
	}
	return []string{
		"",
		"Model advisor (an estimate; nothing was changed)",
		jsNumber(float64(light)) + " of " + jsNumber(float64(advice.Runs)) + " " + advice.MainModel +
			" runs in the last 30 days looked light: read-only or sweep jobs, or few turns and short answers.",
		"On " + advice.FlashModel + " they could have cost about " + Usd(less) +
			" less at list prices, if the flash model handles them as well.",
		"For work like that, try `model: " + provider.TierNames[domain.ModelTierFlash] + "` in a brief or the " +
			provider.AgentPrefix + provider.Agents[domain.ModelTierFlash] + " agent.",
	}
}

// UsageReport is what `usage` prints.
type UsageReport struct {
	Windows []app.UsageWindow `json:"windows"`
	// This repository's claude-engine ledger, per tier.
	Jobs    []domain.TierUsage   `json:"jobs"`
	Engines []domain.EngineUsage `json:"engines"`
	// Every job on this machine, for the priced totals.
	AllJobs []domain.Job `json:"allJobs"`
	Now     int64        `json:"now"`
	// The router's last 24 hours; nil for no health line.
	Health *app.RouterHealthCounts `json:"health,omitempty"`
	// The model advisor's findings; shown only when there is enough data.
	Advice *app.FlashAdvice `json:"advice,omitempty"`
}

// Usage prints the estimated totals first, then the router's health and per-model windows (agents
// and `/model`), then the job ledger, then the engines', then the model advisor when it has
// something to say.
func Usage(provider domain.Provider, report UsageReport) string {
	costs := WindowCosts(provider, report.Windows, report.AllJobs, report.Now)
	models := pricedModels(provider, report.Windows, report.AllJobs)
	spool := make([]string, 0, len(report.Windows))
	for _, window := range report.Windows {
		if len(window.Rows) == 0 {
			spool = append(spool, window.Label+": no agent or /model requests.")
			continue
		}
		lines := append([]string{window.Label + ", agents and /model"}, windowTable(window)...)
		spool = append(spool, strings.Join(lines, "\n"))
	}
	lines := []string{provider.Display + " usage"}
	lines = append(lines, headline(provider, costs, models)...)
	if len(report.Engines) > 0 {
		lines = append(lines,
			"Jobs on omp, opencode, pi or zcode are not in the total: their rows below are as each tool reports them.")
	}
	lines = append(lines, healthSection(report.Health)...)
	lines = append(lines, "")
	lines = append(lines, spool...)
	lines = append(lines, "")
	lines = append(lines, jobSection(provider, report.Jobs)...)
	lines = append(lines, engineSection(provider, report.Engines)...)
	lines = append(lines, adviceSection(provider, report.Advice)...)
	return strings.Join(lines, "\n")
}

// pricedModels is every model the report priced, window rows first then jobs, each named once, in
// first-seen order.
func pricedModels(provider domain.Provider, windows []app.UsageWindow, jobs []domain.Job) []string {
	var models []string
	seen := map[string]bool{}
	add := func(model string) {
		if seen[model] {
			return
		}
		seen[model] = true
		models = append(models, model)
	}
	for _, window := range windows {
		for _, row := range window.Rows {
			add(row.Model)
		}
	}
	for _, job := range jobs {
		if job.Brief.Engine == nil {
			add(ModelID(provider, job))
		}
	}
	return models
}

// usageTokens is an attempt's usage in the price table's shape.
func usageTokens(usage domain.Usage) TokenCounts {
	return TokenCounts{
		InputTokens:      float64(usage.InputTokens),
		OutputTokens:     float64(usage.OutputTokens),
		CacheReadTokens:  float64(usage.CacheReadTokens),
		CacheWriteTokens: float64(usage.CacheWriteTokens),
	}
}

// modelUsageTokens is a spool row's usage in the price table's shape.
func modelUsageTokens(row app.ModelUsage) TokenCounts {
	return TokenCounts{
		InputTokens:      float64(row.InputTokens),
		OutputTokens:     float64(row.OutputTokens),
		CacheReadTokens:  float64(row.CacheReadTokens),
		CacheWriteTokens: float64(row.CacheWriteTokens),
	}
}
