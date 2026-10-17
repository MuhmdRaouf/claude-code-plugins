package domain

import (
	"fmt"
	"math"
	"slices"
)

// Spending budgets, as Radar sets them: `<radar home>/budgets.json` holds what the user asked
// for, and `<radar home>/budget-status.json` what Radar last worked out — which scopes are
// stopped this period. A router reads the status (and the budgets, for the period's name) and
// refuses its provider's models while its scope, or "total", is stopped. Anything it cannot
// trust — no file, a file older than ten minutes, a file that does not parse — stops nothing: a
// broken radar must never cut a user off.

// BUDGET_STALE_MS: a status older than this (or this far in the future) is stale and stops
// nothing.
const BUDGET_STALE_MS = 10 * 60_000

// BudgetPeriod is a budget's period.
type BudgetPeriod string

const (
	BudgetDay   BudgetPeriod = "day"
	BudgetWeek  BudgetPeriod = "week"
	BudgetMonth BudgetPeriod = "month"
)

// BudgetStop is the stop a router obeys: the scope that is stopped and its budget's period, when
// budgets.json names it.
type BudgetStop struct {
	Scope  string
	Period *BudgetPeriod
}

// radarStatus is the part of budget-status.json the decision reads, already validated.
type radarStatus struct {
	updatedAt float64
	stopped   []string
	// Ids whose spend is at or over 100 percent.
	spendOver map[string]bool
}

// budgetEntry is one budgets.json entry that parsed.
type budgetEntry struct {
	id     string
	scope  string
	period BudgetPeriod
	action string
}

// ProviderScope is the scope a plugin's own budget has: `provider:<name>`.
func ProviderScope(plugin string) string {
	return "provider:" + plugin
}

// BudgetStopFor decides whether this plugin's provider models are stopped right now: its own
// scope first, then "total". `status` and `budgets` are the parsed files (nil when missing or
// unreadable); `now` is epoch milliseconds.
func BudgetStopFor(plugin string, status, budgets any, now int64) (BudgetStop, bool) {
	parsed, ok := parseRadarStatus(status)
	if !ok {
		return BudgetStop{}, false
	}
	if math.Abs(float64(now)-parsed.updatedAt) > BUDGET_STALE_MS {
		return BudgetStop{}, false
	}
	scope := ""
	for _, name := range []string{ProviderScope(plugin), "total"} {
		if slices.Contains(parsed.stopped, name) {
			scope = name
			break
		}
	}
	if scope == "" {
		return BudgetStop{}, false
	}
	var stops []budgetEntry
	for _, entry := range budgetsOf(budgets) {
		if entry.scope == scope && entry.action == "stop" {
			stops = append(stops, entry)
		}
	}
	var period *BudgetPeriod
	for _, entry := range stops {
		if parsed.spendOver[entry.id] {
			found := entry.period
			period = &found
			break
		}
	}
	if period == nil && len(stops) > 0 {
		first := stops[0].period
		period = &first
	}
	return BudgetStop{Scope: scope, Period: period}, true
}

// BudgetMessage words the refusal, word for word the same in every router.
func BudgetMessage(display string, stop BudgetStop) string {
	period := "period"
	if stop.Period != nil {
		period = string(*stop.Period)
	}
	return fmt.Sprintf("%s budget reached for this %s: raise or lift it in the Radar dashboard (/radar:open)", display, period)
}

// budgetsOf returns the budgets that parse, one bad entry skipped rather than all of them lost.
func budgetsOf(budgets any) []budgetEntry {
	obj, ok := budgets.(map[string]any)
	if !ok || !isVersionOne(obj["version"]) {
		return nil
	}
	list, ok := obj["budgets"].([]any)
	if !ok {
		return nil
	}
	var entries []budgetEntry
	for _, item := range list {
		if entry, ok := parseBudgetEntry(item); ok {
			entries = append(entries, entry)
		}
	}
	return entries
}

func parseBudgetEntry(item any) (budgetEntry, bool) {
	obj, ok := item.(map[string]any)
	if !ok {
		return budgetEntry{}, false
	}
	id, ok := obj["id"].(string)
	if !ok {
		return budgetEntry{}, false
	}
	scope, ok := obj["scope"].(string)
	if !ok {
		return budgetEntry{}, false
	}
	period, ok := obj["period"].(string)
	if !ok {
		return budgetEntry{}, false
	}
	switch BudgetPeriod(period) {
	case BudgetDay, BudgetWeek, BudgetMonth:
	default:
		return budgetEntry{}, false
	}
	action, ok := obj["action"].(string)
	if !ok {
		return budgetEntry{}, false
	}
	return budgetEntry{id: id, scope: scope, period: BudgetPeriod(period), action: action}, true
}

// parseRadarStatus validates the status file radar writes: version 1, a number updatedAt, a list
// of stopped scopes, and a spend list that, when broken, is no spend at all.
func parseRadarStatus(status any) (radarStatus, bool) {
	obj, ok := status.(map[string]any)
	if !ok || !isVersionOne(obj["version"]) {
		return radarStatus{}, false
	}
	updatedAt, ok := budgetNumber(obj["updatedAt"])
	if !ok {
		return radarStatus{}, false
	}
	list, ok := obj["stopped"].([]any)
	if !ok {
		return radarStatus{}, false
	}
	stopped := make([]string, 0, len(list))
	for _, item := range list {
		name, ok := item.(string)
		if !ok {
			return radarStatus{}, false
		}
		stopped = append(stopped, name)
	}
	over := map[string]bool{}
	if spend, present := obj["spend"]; present {
		// A spend list that does not parse reads as no spend.
		if ids, ok := spendOver(spend); ok {
			over = ids
		}
	}
	return radarStatus{updatedAt: updatedAt, stopped: stopped, spendOver: over}, true
}

// spendOver collects the ids whose pct is at or over 100; false when the list does not parse.
func spendOver(spend any) (map[string]bool, bool) {
	rows, ok := spend.([]any)
	if !ok {
		return nil, false
	}
	over := make(map[string]bool, len(rows))
	for _, row := range rows {
		obj, ok := row.(map[string]any)
		if !ok {
			return nil, false
		}
		id, ok := obj["id"].(string)
		if !ok {
			return nil, false
		}
		pct, ok := budgetNumber(obj["pct"])
		if !ok {
			return nil, false
		}
		if pct >= 100 {
			over[id] = true
		}
	}
	return over, true
}

func isVersionOne(value any) bool {
	version, ok := budgetNumber(value)
	return ok && version == 1
}

// budgetNumber reads a JSON or YAML number the way zod's z.number does.
func budgetNumber(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	default:
		return 0, false
	}
}
