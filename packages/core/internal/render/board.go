package render

import (
	"strconv"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// stateLabel is the state a row shows: active, idle, or a job's own state — in review, the verdict
// it will be accepted against (the label the job board always printed); a dead driver marks it
// stale, and a running engine shows its pid.
func stateLabel(row app.ActivityRow) string {
	isJob := row.Kind != app.ActivityKindSubagent && row.Kind != app.ActivityKindSession
	if isJob && row.State == string(domain.JobStateAwaitingReview) {
		verdict := "no verdict"
		if row.Verdict != nil {
			verdict = *row.Verdict
		}
		return "review: " + verdict
	}
	stale := ""
	if row.Stale != nil && *row.Stale {
		stale = " (stale)"
	}
	pid := ""
	if row.Pid != nil {
		pid = " (pid " + strconv.FormatInt(*row.Pid, 10) + ")"
	}
	return row.State + stale + pid
}

// Board is the live board: one table of what runs on the provider right now — subagents and
// sessions the router served, beside the job store's jobs — active first, then newest first.
func Board(provider domain.Provider, rows []app.ActivityRow, now int64) string {
	if len(rows) == 0 {
		return "No " + provider.Display + " activity yet. After " + provider.Slash +
			"setup, the sessions and subagents on its models appear here."
	}
	table := make([][]string, 0, len(rows)+1)
	table = append(table, []string{"KIND", "ID", "MODEL", "STATE", "REQ", "IN", "OUT", "LAST", "TITLE"})
	for _, row := range rows {
		model := "-"
		if row.Model != nil {
			model = *row.Model
		}
		requests := "-"
		if row.Requests != nil {
			requests = jsNumber(float64(*row.Requests))
		}
		input := "-"
		if row.InputTokens != nil {
			input = Count(float64(*row.InputTokens))
		}
		output := "-"
		if row.OutputTokens != nil {
			output = Count(float64(*row.OutputTokens))
		}
		title := "-"
		if row.Title != nil {
			title = *row.Title
		}
		table = append(table, []string{
			string(row.Kind),
			row.ID,
			model,
			stateLabel(row),
			requests,
			input,
			output,
			Ago(row.At, now),
			title,
		})
	}
	lines := Table(table)
	lines = append(lines, engineNote(rows)...)
	lines = append(lines, staleNote(provider, rows)...)
	return strings.Join(lines, "\n")
}

// engineNote says which rows are a delegation tool's own report: omp, opencode, pi and zcode run
// on their own setup.
func engineNote(rows []app.ActivityRow) []string {
	var tools []string
	seen := map[string]bool{}
	for _, row := range rows {
		kind := string(row.Kind)
		if !domain.IsEngineTool(kind) || seen[kind] {
			continue
		}
		seen[kind] = true
		tools = append(tools, kind)
	}
	if len(tools) == 0 {
		return nil
	}
	return []string{
		"",
		strings.Join(tools, ", ") +
			" rows: model and numbers as the tool itself reports them (it runs on its own setup).",
	}
}

// staleNote names the jobs whose driver is gone and how to end them.
func staleNote(provider domain.Provider, rows []app.ActivityRow) []string {
	var ids []string
	for _, row := range rows {
		if row.Stale != nil && *row.Stale {
			ids = append(ids, row.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	return []string{
		"",
		"stale: " + Plural(int64(len(ids)), "job has", "jobs have") + " no live driver (" + strings.Join(ids, ", ") +
			"); stopping one here moves it to review, where " + provider.Slash + "review <id> discards it.",
	}
}

// How many review ids the SessionStart line names before it says how many more there are.
const hookIDs = 3

// Hook is the SessionStart line: what needs the reviewer, what is still running; empty when
// nothing does. It goes into Claude's context every session, so it stays one short line: at most
// three ids, each with the slash command that decides it.
func Hook(provider domain.Provider, rows []app.ActivityRow) string {
	var review []string
	for _, row := range rows {
		if row.State == string(domain.JobStateAwaitingReview) {
			review = append(review, row.ID)
		}
	}
	named := make([]string, 0, hookIDs)
	for _, id := range review {
		if len(named) == hookIDs {
			break
		}
		named = append(named, provider.Slash+"review "+id)
	}
	more := ""
	if len(review) > hookIDs {
		more = " and " + strconv.Itoa(len(review)-hookIDs) + " more"
	}
	active := 0
	for _, row := range rows {
		switch row.State {
		case string(domain.JobStateQueued), string(domain.JobStateRunning), string(domain.JobStateVerifying):
			active++
		}
	}
	var parts []string
	if len(review) > 0 {
		parts = append(parts,
			Plural(int64(len(review)), "job awaits", "jobs await")+" review ("+strings.Join(named, ", ")+more+")")
	}
	if active != 0 {
		parts = append(parts, Plural(int64(active), "job")+" queued or running")
	}
	if len(parts) == 0 {
		return ""
	}
	return provider.Name + ": " + strings.Join(parts, "; ") + ". " + provider.Slash + "board lists them."
}
