// The live board and the spool usage windows: what ran through this plugin's router, read back
// from the spool it wrote. One row per subagent and per main session the router served, beside the
// job store's jobs; usage sums the provider-bound requests per model over calendar windows. Jobs
// on a delegation engine (omp, opencode, pi) join the board through their own source, KIND the
// engine and the engine's pid while it runs.
package app

import (
	"cmp"
	"context"
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// A request this recent marks its session or subagent active.
const activityActiveWindowMs = 60_000

// The board reads today's and yesterday's spool; usage reads thirty days.
const activityBoardSpoolDays = 2
const activityUsageSpoolDays = 30

// UsageWindowSpec is one named window of the usage report: its label and its length in calendar
// days.
type UsageWindowSpec struct {
	Label string
	Days  int
}

// USAGE_WINDOWS lists the windows `usage` reports: today, then the last 7 and 30 calendar days
// (today included). Treat it as read-only.
var USAGE_WINDOWS = []UsageWindowSpec{
	{"Today", 1},
	{"Last 7 days", 7},
	{"Last 30 days", 30},
}

// ActivityKind is one board row's kind: a subagent or a main session the router served, a job from
// the store, or the delegation engine such a job runs on.
type ActivityKind string

const (
	ActivityKindSubagent ActivityKind = "subagent"
	ActivityKindSession  ActivityKind = "session"
	ActivityKindJob      ActivityKind = "job"
)

// ActivityRow is one row of the live board: a subagent or a main session this plugin's router
// served, or a job from the store — `job` on claude, the engine's name on a delegation engine.
type ActivityRow struct {
	Kind ActivityKind `json:"kind"`
	// First 8 characters of the agent or session id; the job id in full.
	ID string `json:"id"`
	// The last request's model; on an engine job, the model the tool last reported.
	Model *string `json:"model,omitempty"`
	// "active" or "idle" for spool rows; the job state for job rows.
	State string `json:"state"`
	// A job row's last verdict: the board's review state label shows it.
	Verdict *string `json:"verdict,omitempty"`
	// A job mid-flight whose driver is gone.
	Stale *bool `json:"stale,omitempty"`
	// Model turns and tokens; nil before the first attempt of a job ends.
	Requests     *int64 `json:"requests,omitempty"`
	InputTokens  *int64 `json:"inputTokens,omitempty"`
	OutputTokens *int64 `json:"outputTokens,omitempty"`
	// When the row was last active: its last request, or the job's last update.
	At string `json:"at"`
	// A job's brief title.
	Title *string `json:"title,omitempty"`
	// An engine job's running engine process (its group leader), while the driver is live.
	Pid *int64 `json:"pid,omitempty"`
}

// RoutesOf is the spool's route events for one plugin only; every plugin's router shares the same
// files.
func RoutesOf(plugin string, events []domain.SpoolEvent) []domain.RouteEvent {
	routes := make([]domain.RouteEvent, 0, len(events))
	for _, event := range events {
		if domain.IsHealthEvent(event) {
			continue
		}
		route, ok := event.(domain.RouteEvent)
		if !ok || route.Event != domain.EventRoute || route.Plugin != plugin {
			continue
		}
		routes = append(routes, route)
	}
	return routes
}

// activityRowKey is the id a row is grouped under: the agent for a subagent's requests, the
// session for a main session's.
func activityRowKey(event domain.RouteEvent) (string, bool) {
	if event.AgentID != nil {
		return *event.AgentID, true
	}
	if event.SessionID != nil {
		return *event.SessionID, true
	}
	return "", false
}

// activityTally is one grouped id's requests and tokens so far, beside its last event.
type activityTally struct {
	last     domain.RouteEvent
	requests int64
	input    int64
	output   int64
}

// SpoolRows is the subagent and session rows of the given route events. A request only reaches the
// spool once it completes, so "active" means one answered within the active window — one still
// streaming shows as soon as it lands.
func SpoolRows(plugin string, events []domain.SpoolEvent, now int64) []ActivityRow {
	groups := map[string]*activityTally{}
	var keys []string
	for _, event := range RoutesOf(plugin, events) {
		key, ok := activityRowKey(event)
		if !ok {
			continue
		}
		tokens := activityUsageTokens(event.Usage)
		group, seen := groups[key]
		if !seen {
			groups[key] = &activityTally{last: event, requests: 1, input: tokens.input, output: tokens.output}
			keys = append(keys, key)
			continue
		}
		group.requests++
		group.input += tokens.input
		group.output += tokens.output
		// An unreadable timestamp never beats the last one: it compares like NaN.
		eventTs, eventOK := activityParseTs(event.Ts)
		lastTs, lastOK := activityParseTs(group.last.Ts)
		if eventOK && lastOK && eventTs > lastTs {
			group.last = event
		}
	}
	rows := make([]ActivityRow, 0, len(keys))
	for _, key := range keys {
		group := groups[key]
		kind := ActivityKindSession
		if group.last.AgentID != nil {
			kind = ActivityKindSubagent
		}
		state := "idle"
		if lastTs, ok := activityParseTs(group.last.Ts); ok && now-lastTs <= activityActiveWindowMs {
			state = "active"
		}
		model := group.last.Model
		requests, input, output := group.requests, group.input, group.output
		rows = append(rows, ActivityRow{
			Kind:         kind,
			ID:           activityShortID(key),
			Model:        &model,
			State:        state,
			Requests:     &requests,
			InputTokens:  &input,
			OutputTokens: &output,
			At:           group.last.Ts,
		})
	}
	return rows
}

// activityTokens is one answer's input and output token counts.
type activityTokens struct {
	input  int64
	output int64
}

// activityUsageTokens is the input and output tokens of one answer's usage, as numbers whatever
// the provider reports.
func activityUsageTokens(usage *domain.RouteUsage) activityTokens {
	return activityTokens{input: TokenCount(usage, "input_tokens"), output: TokenCount(usage, "output_tokens")}
}

// TokenCount is a usage counter by its Anthropic name; anything but a number (or a numeric string)
// counts as nothing.
func TokenCount(usage *domain.RouteUsage, key string) int64 {
	if usage == nil {
		return 0
	}
	return activityNumber((*usage)[key])
}

// activityNumber reads one usage counter the way JavaScript's Number() does: a number or a numeric
// string parses (Number trims whitespace), and anything else — null, a bool, an object, a
// non-finite value — is NaN and counts as nothing.
func activityNumber(value any) int64 {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0
		}
		return int64(typed)
	case int:
		return int64(typed)
	case int64:
		return typed
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil || math.IsInf(parsed, 0) {
			return 0
		}
		return int64(parsed)
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil || math.IsInf(parsed, 0) {
			return 0
		}
		return int64(parsed)
	}
	return 0
}

// activityParseTs reads a spool or job timestamp — ISO, as the clocks write it — as epoch
// milliseconds; false when it does not parse, the case JavaScript's Date.parse answers NaN for.
func activityParseTs(ts string) (int64, bool) {
	parsed, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return 0, false
	}
	return parsed.UnixMilli(), true
}

// activityShortID is the id a spool row shows: the key's first 8 UTF-16 code units, the unit JS
// length and slice count.
func activityShortID(key string) string {
	units := utf16.Encode([]rune(key))
	if len(units) <= 8 {
		return key
	}
	return string(utf16.Decode(units[:8]))
}

// JobRows is the job store's jobs as board rows: the model id it ran on and its verdict.
func JobRows(provider domain.Provider, views []BoardRow) []ActivityRow {
	rows := make([]ActivityRow, 0, len(views))
	for _, view := range views {
		job := view.Job
		verdict := "no verdict"
		if len(job.Attempts) > 0 {
			if last := job.Attempts[len(job.Attempts)-1]; last.Verdict != nil {
				verdict = string(*last.Verdict)
			}
		}
		stale := (job.State == domain.JobStateRunning || job.State == domain.JobStateVerifying) && !view.Live
		model := provider.Catalog[job.Brief.Model].ID
		title := job.Brief.Title
		requests, input, output := activityJobTokens(job)
		rows = append(rows, ActivityRow{
			Kind:         ActivityKindJob,
			ID:           job.ID,
			Model:        &model,
			State:        string(job.State),
			Verdict:      &verdict,
			Stale:        &stale,
			Requests:     requests,
			InputTokens:  input,
			OutputTokens: output,
			At:           job.UpdatedAt,
			Title:        &title,
		})
	}
	return rows
}

// activityJobTokens is a job's model turns and tokens over its finished attempts, for the board's
// REQ, IN and OUT columns; nil before the first attempt ends.
func activityJobTokens(job domain.Job) (requests, input, output *int64) {
	var usages []domain.Usage
	for _, attempt := range job.Attempts {
		if attempt.Usage != nil {
			usages = append(usages, *attempt.Usage)
		}
	}
	if len(usages) == 0 {
		return nil, nil, nil
	}
	var turns, in, out int64
	for _, usage := range usages {
		turns += usage.Turns
		in += usage.InputTokens
		out += usage.OutputTokens
	}
	return &turns, &in, &out
}

// OrderRows is the board's order: active rows first, then newest first by when each row was last
// active.
func OrderRows(rows []ActivityRow) []ActivityRow {
	ordered := append([]ActivityRow(nil), rows...)
	// A stable sort, as JS's: two rows equal on both keys keep the board's source order.
	slices.SortStableFunc(ordered, func(a, b ActivityRow) int {
		activeA, activeB := activityIsActive(a), activityIsActive(b)
		if activeA != activeB {
			if activeB {
				return 1
			}
			return -1
		}
		aTs, aOK := activityParseTs(a.At)
		bTs, bOK := activityParseTs(b.At)
		if !aOK || !bOK {
			return 0
		}
		return cmp.Compare(bTs, aTs)
	})
	return ordered
}

// activityIsActive says whether a row counts as active: a spool row by its state, a job row by
// being mid-flight.
func activityIsActive(row ActivityRow) bool {
	if row.Kind == ActivityKindSubagent || row.Kind == ActivityKindSession {
		return row.State == "active"
	}
	switch domain.JobState(row.State) {
	case domain.JobStateQueued, domain.JobStateRunning, domain.JobStateVerifying:
		return true
	}
	return false
}

// activitySpoolRows is the spool source: subagents and sessions this plugin's router served today
// or yesterday.
func activitySpoolRows(deps Deps, now int64) []ActivityRow {
	return SpoolRows(deps.Provider.Name, deps.Spool.Events(now, activityBoardSpoolDays), now)
}

// activityJobRows is the job store source: the verified loop's claude jobs, repo-filtered unless
// the scope says all.
func activityJobRows(ctx context.Context, deps Deps, scope Scope) []ActivityRow {
	var claude []BoardRow
	for _, view := range Board(ctx, deps, scope) {
		if JobEngine(view.Job) == domain.EngineClaude {
			claude = append(claude, view)
		}
	}
	return JobRows(deps.Provider, claude)
}

// activityEngineRows is the engine source: jobs on omp, opencode, pi or zcode, KIND the engine,
// with the engine's pid while one runs. Stopping one is stopping its job, the same as any other.
func activityEngineRows(ctx context.Context, deps Deps, scope Scope) []ActivityRow {
	var engines []BoardRow
	for _, view := range Board(ctx, deps, scope) {
		if JobEngine(view.Job) != domain.EngineClaude {
			engines = append(engines, view)
		}
	}
	return activityEngineViews(deps, engines)
}

// activityEngineViews is engine jobs as board rows: a job row with the engine as KIND and its live
// engine process. The tool runs on its own setup, so the model and the numbers are the tool's own
// report: the model it last said it ran on (none when it names none, never the provider's
// catalog), and its requests and tokens summed over the attempts.
func activityEngineViews(deps Deps, views []BoardRow) []ActivityRow {
	rows := make([]ActivityRow, 0, len(views))
	for _, view := range views {
		engine := JobEngine(view.Job)
		if engine == domain.EngineClaude {
			continue
		}
		row := JobRows(deps.Provider, []BoardRow{view})[0]
		var usages []domain.Usage
		for _, attempt := range view.Job.Attempts {
			if attempt.Usage != nil {
				usages = append(usages, *attempt.Usage)
			}
		}
		// The catalog's model id is dropped; the tool's own last word stands instead.
		row.Model = nil
		for _, usage := range usages {
			if usage.Model != nil {
				row.Model = usage.Model
			}
		}
		if len(usages) > 0 {
			var requests, input, output int64
			for _, usage := range usages {
				requests += usage.Turns
				input += usage.InputTokens
				output += usage.OutputTokens
			}
			row.Requests, row.InputTokens, row.OutputTokens = &requests, &input, &output
		}
		if view.Live {
			if pid, ok := deps.Files.EnginePid(deps.Store.Paths(view.Job.ID)); ok {
				row.Pid = &pid
			}
		}
		row.Kind = ActivityKind(domain.EngineTool(engine))
		rows = append(rows, row)
	}
	return rows
}

// ActivityBoard is the whole board, every source merged: active first, then newest first.
func ActivityBoard(ctx context.Context, deps Deps, scope Scope) []ActivityRow {
	now := deps.Clock.Now()
	rows := activitySpoolRows(deps, now)
	rows = append(rows, activityJobRows(ctx, deps, scope)...)
	rows = append(rows, activityEngineRows(ctx, deps, scope)...)
	return OrderRows(rows)
}

// ── usage windows ───────────────────────────────────────────────────────────────────────────

// ModelUsage is the per-model totals over one usage window: the provider-bound requests this
// plugin's router forwarded.
type ModelUsage struct {
	Model            string `json:"model"`
	Requests         int64  `json:"requests"`
	InputTokens      int64  `json:"inputTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
}

// UsageWindow is one named window and its per-model rows.
type UsageWindow struct {
	Label string       `json:"label"`
	Days  int          `json:"days"`
	Rows  []ModelUsage `json:"rows"`
}

// WindowStart is the local midnight of days calendar days back, today included: the window's
// inclusive start.
func WindowStart(now int64, days int) int64 {
	local := time.UnixMilli(now)
	return time.Date(local.Year(), local.Month(), local.Day()-(days-1), 0, 0, 0, 0, time.Local).UnixMilli()
}

// ModelUsageOf is the per-model usage over the provider-bound route events since since: the
// provider's own bill. Anthropic-routed and peer-routed requests are someone else's and never
// count.
func ModelUsageOf(plugin string, events []domain.SpoolEvent, since int64) []ModelUsage {
	groups := map[string]*ModelUsage{}
	var models []string
	for _, event := range RoutesOf(plugin, events) {
		// An unreadable timestamp never reads as earlier than the window, so it still counts.
		if ts, ok := activityParseTs(event.Ts); ok && ts < since {
			continue
		}
		if event.Route != "provider" {
			continue
		}
		seen, found := groups[event.Model]
		if !found {
			seen = &ModelUsage{Model: event.Model}
			groups[event.Model] = seen
			models = append(models, event.Model)
		}
		seen.Requests++
		seen.InputTokens += TokenCount(event.Usage, "input_tokens")
		seen.OutputTokens += TokenCount(event.Usage, "output_tokens")
		seen.CacheReadTokens += TokenCount(event.Usage, "cache_read_input_tokens")
		seen.CacheWriteTokens += TokenCount(event.Usage, "cache_creation_input_tokens")
	}
	rows := make([]ModelUsage, 0, len(models))
	for _, model := range models {
		rows = append(rows, *groups[model])
	}
	slices.SortFunc(rows, func(a, b ModelUsage) int { return strings.Compare(a.Model, b.Model) })
	return rows
}

// UsageEvents is the spool's last thirty days, which every part of `usage` reads (read once,
// passed around).
func UsageEvents(deps Deps) []domain.SpoolEvent {
	return deps.Spool.Events(deps.Clock.Now(), activityUsageSpoolDays)
}

// UsageWindows is the three usage windows over the spool's last thirty days.
func UsageWindows(deps Deps, events []domain.SpoolEvent) []UsageWindow {
	now := deps.Clock.Now()
	windows := make([]UsageWindow, 0, len(USAGE_WINDOWS))
	for _, window := range USAGE_WINDOWS {
		windows = append(windows, UsageWindow{
			Label: window.Label,
			Days:  window.Days,
			Rows:  ModelUsageOf(deps.Provider.Name, events, WindowStart(now, window.Days)),
		})
	}
	return windows
}

// ── router health ───────────────────────────────────────────────────────────────────────────

// The router health window: the last 24 hours.
const activityHealthWindowMs = 24 * 60 * 60_000

// RouterHealthCounts is how this plugin's router fared over the last 24 hours, one count per
// health event kind.
type RouterHealthCounts struct {
	Fallback    int64 `json:"fallback"`
	Refusal     int64 `json:"refusal"`
	RateLimited int64 `json:"rate_limited"`
	BudgetStop  int64 `json:"budget_stop"`
	Restart     int64 `json:"restart"`
}

// HealthCounts is the health events of plugin at or after since (epoch ms), counted per kind.
func HealthCounts(plugin string, events []domain.SpoolEvent, since int64) RouterHealthCounts {
	counts := RouterHealthCounts{}
	for _, event := range events {
		health := activityHealthOf(event)
		if health == nil || health.Plugin != plugin || health.Ts < since {
			continue
		}
		switch health.Event {
		case domain.HealthFallback:
			counts.Fallback++
		case domain.HealthRefusal:
			counts.Refusal++
		case domain.HealthRateLimited:
			counts.RateLimited++
		case domain.HealthBudgetStop:
			counts.BudgetStop++
		case domain.HealthRestart:
			counts.Restart++
		}
	}
	return counts
}

// activityHealthOf pulls the health event out of a spool event; nil when it is not one.
func activityHealthOf(event domain.SpoolEvent) *domain.RouterHealthEvent {
	switch typed := event.(type) {
	case domain.RouterHealthEvent:
		return &typed
	case *domain.RouterHealthEvent:
		return typed
	}
	return nil
}

// RouterHealth is the router's last 24 hours, from the spool's events (`usage` passes the thirty
// days it already read).
func RouterHealth(deps Deps, events []domain.SpoolEvent) RouterHealthCounts {
	return HealthCounts(deps.Provider.Name, events, deps.Clock.Now()-activityHealthWindowMs)
}
