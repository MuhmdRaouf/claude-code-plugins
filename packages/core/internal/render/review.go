package render

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// Lines of a failing gate's output quoted inline; the full output is in the gate log.
const tailLines = 20
const changesListed = 50
const detailChars = 160

// Review is the review packet: header, attempts, the last attempt's report and gates, the diff,
// and the reviewer's next step.
func Review(provider domain.Provider, packet app.ReviewPacket) string {
	job := packet.Job
	last := LastAttempt(job)
	lines := []string{}
	lines = append(lines, reviewHeader(provider, job, last)...)
	if len(job.Attempts) > 1 {
		attempts := make([]string, 0, len(job.Attempts))
		for _, attempt := range job.Attempts {
			attempts = append(attempts, domain.AttemptSummary(attempt))
		}
		lines = append(lines, reviewSection("Attempts", attempts)...)
	}
	if last != nil {
		lines = append(lines, attemptSections(*last, ModelID(provider, job))...)
	}
	if packet.DiffStat != nil {
		lines = append(lines, reviewSection("Diff stat", strings.Split(trimEndJS(*packet.DiffStat), "\n"))...)
	}
	if packet.Diff != nil {
		lines = append(lines, "", "Diff", trimEndJS(domain.Fenced(*packet.Diff, "diff")))
	}
	lines = append(lines, nextActions(provider, job)...)
	return strings.Join(lines, "\n")
}

// ReviewSummary is `review --summary`: verdict, gates, the report's summary and open items, only
// the failing sweep items — no diff, no change list, no attempt history. What the reviewer reads
// first; the full review when it is not enough.
func ReviewSummary(provider domain.Provider, packet app.ReviewPacket) string {
	job := packet.Job
	last := LastAttempt(job)
	lines := append([]string{}, reviewHeader(provider, job, last)...)
	if last != nil && last.Outcome != nil && last.Outcome.Kind != domain.WorkerOutcomeCompleted {
		lines = append(lines, "", "Worker: "+OutcomeText(*last.Outcome))
	}
	if last == nil || last.Verification == nil {
		lines = append(lines, "", "Not verified yet.")
	} else {
		lines = append(lines, gatesSection(last.Verification.Gates)...)
		lines = append(lines, reportSection(last.Report, last.Verification.Report)...)
		lines = append(lines, sweepFailures(job, *last)...)
	}
	return strings.Join(lines, "\n")
}

// reviewHeader is the packet's first lines: who, what, which model and mode, and where the work
// is.
func reviewHeader(provider domain.Provider, job domain.Job, last *domain.Attempt) []string {
	workspace := job.Workspace
	attempt := "no attempt yet"
	if last != nil {
		attempt = "attempt " + strconv.FormatInt(last.N, 10) + " (" + string(last.Kind) + ")"
	}
	where := "repository " + workspace.RepoRoot + " (must stay unchanged), artifacts " + workspace.ArtifactsDir
	if workspace.Worktree != nil {
		branch := "?"
		if workspace.Branch != nil {
			branch = *workspace.Branch
		}
		where = "worktree " + *workspace.Worktree + " (branch " + branch + ", base " +
			utf16Slice(workspace.BaseSha, 0, 7) + ")"
	}
	return []string{
		provider.Name + " job " + job.ID + ": " + job.Brief.Title,
		"verdict " + VerdictOf(job) + " · " + ModelID(provider, job) + " · " + string(job.Brief.Mode) + " · " +
			attempt + " · " + strings.Replace(string(job.State), "_", " ", 1),
		where,
	}
}

// attemptSections is one attempt's own report: how the worker ended, what the report and gates
// said, the scope result, the changes, and what it used.
func attemptSections(attempt domain.Attempt, model string) []string {
	lines := []string{}
	if attempt.Outcome != nil && attempt.Outcome.Kind != domain.WorkerOutcomeCompleted {
		lines = append(lines, "", "Worker: "+OutcomeText(*attempt.Outcome))
	}
	if attempt.Verification == nil {
		lines = append(lines, "", "Not verified yet.")
	} else {
		lines = append(lines, reportSection(attempt.Report, attempt.Verification.Report)...)
		lines = append(lines, gatesSection(attempt.Verification.Gates)...)
		lines = append(lines, "", scopeLine(attempt.Verification.Scope))
		lines = append(lines, changesSection(attempt.Verification.Changes)...)
	}
	if attempt.Usage != nil {
		lines = append(lines, "", usageLine(*attempt.Usage, model))
	}
	return lines
}

// reviewSection is a titled block of indented lines.
func reviewSection(title string, lines []string) []string {
	out := make([]string, 0, len(lines)+2)
	out = append(out, "", title)
	for _, line := range lines {
		out = append(out, "  "+line)
	}
	return out
}

// trimEndJS is JS trimEnd: trailing whitespace off, in JS's own space set.
func trimEndJS(text string) string {
	return strings.TrimRightFunc(text, jsSpace)
}

// reportSection is the worker's report: its summary, added tests, open items, and the contract
// problems when it is invalid.
func reportSection(report json.RawMessage, check domain.ReportCheck) []string {
	if !check.Present {
		return []string{"", "Report: missing (the worker ended without a structured report)"}
	}
	facts := app.ReportFacts(report)
	summary := "(no summary)"
	if facts.Summary != nil {
		summary = *facts.Summary
	}
	body := []string{summary}
	if len(facts.TestsAdded) > 0 {
		body = append(body, "Tests added: "+strings.Join(facts.TestsAdded, ", "))
	}
	if len(facts.OpenItems) == 0 {
		body = append(body, "Open items: none")
	} else {
		body = append(body, "Open items:")
		for _, item := range facts.OpenItems {
			body = append(body, "- "+item)
		}
	}
	if !check.Valid {
		body = append(body, "Invalid against its contract:")
		for _, problem := range check.Problems {
			body = append(body, "- "+problem)
		}
	}
	return reviewSection("Report", body)
}

// gatesSection is the gate table, with each failing gate's tail quoted under its row.
func gatesSection(gates []domain.GateResult) []string {
	if len(gates) == 0 {
		return []string{"", "Gates: none run"}
	}
	passed := 0
	for _, gate := range gates {
		if !domain.GateFailed(gate) {
			passed++
		}
	}
	rows := make([][]string, 0, len(gates))
	for _, gate := range gates {
		status := "pass"
		if domain.GateFailed(gate) {
			status = "FAIL"
		}
		rows = append(rows, []string{status, gate.Run, gateStatus(gate), Duration(float64(gate.DurationMs))})
	}
	lines := make([]string, 0, len(rows))
	for i, row := range Table(rows) {
		lines = append(lines, row)
		if domain.GateFailed(gates[i]) {
			lines = append(lines, gateTail(gates[i].Tail)...)
		}
	}
	return reviewSection("Gates ("+strconv.Itoa(passed)+"/"+strconv.Itoa(len(gates))+" passed)", lines)
}

// sweepFailures is only the sweep items that did not pass, one line each; empty for other reports
// or a clean sweep.
func sweepFailures(job domain.Job, last domain.Attempt) []string {
	if !domain.IsSweepBrief(job.Brief) {
		return nil
	}
	items, ok := app.SweepItems(last.Report)
	if !ok {
		return nil
	}
	failing := make([]string, 0, len(items))
	for _, item := range items {
		if item.Status == app.SweepStatusOK {
			continue
		}
		failing = append(failing, item.ID+": "+string(item.Status)+" — "+OneLine(item.Detail, detailChars))
	}
	if len(failing) == 0 {
		return nil
	}
	return reviewSection("Sweep (failing only)", failing)
}

// gateStatus is how a gate ended: timed out, killed by a signal, or its exit code.
func gateStatus(gate domain.GateResult) string {
	if gate.TimedOut {
		return "timed out"
	}
	if gate.ExitCode == nil {
		return "killed"
	}
	return "exit " + strconv.FormatInt(*gate.ExitCode, 10)
}

// gateTail quotes a failing gate's last lines inline.
func gateTail(text string) []string {
	if strings.TrimFunc(text, jsSpace) == "" {
		return []string{"  | (no output)"}
	}
	lines := strings.Split(trimEndJS(text), "\n")
	start := len(lines) - tailLines
	if start < 0 {
		start = 0
	}
	out := make([]string, 0, len(lines)-start)
	for _, line := range lines[start:] {
		out = append(out, trimEndJS("  | "+line))
	}
	return out
}

// scopeLine is the scope check in one line.
func scopeLine(scope domain.ScopeCheck) string {
	if scope.RepoChanged {
		return "Scope: VIOLATED, the repository changed (this job must leave it unchanged)"
	}
	problems := []string{}
	if len(scope.OutOfScope) > 0 {
		problems = append(problems, "out of scope: "+strings.Join(scope.OutOfScope, ", "))
	}
	if len(scope.Forbidden) > 0 {
		problems = append(problems, "forbidden: "+strings.Join(scope.Forbidden, ", "))
	}
	if len(problems) == 0 {
		return "Scope: in scope"
	}
	return "Scope: VIOLATED, " + strings.Join(problems, "; ")
}

// changesSection lists what the attempt touched, capped, in git status order.
func changesSection(changes domain.ChangeSet) []string {
	entries := make([]string, 0, len(changes.Added)+len(changes.Modified)+len(changes.Deleted)+len(changes.Untracked))
	for _, path := range changes.Added {
		entries = append(entries, "A "+path)
	}
	for _, path := range changes.Modified {
		entries = append(entries, "M "+path)
	}
	for _, path := range changes.Deleted {
		entries = append(entries, "D "+path)
	}
	for _, path := range changes.Untracked {
		entries = append(entries, "? "+path)
	}
	if len(entries) == 0 {
		return []string{"Changes: none"}
	}
	listed := entries
	if len(entries) > changesListed {
		listed = append(append([]string{}, entries[:changesListed]...),
			"and "+strconv.Itoa(len(entries)-changesListed)+" more")
	}
	out := make([]string, 0, len(listed)+1)
	out = append(out, "Changes ("+strconv.Itoa(len(entries))+"):")
	for _, line := range listed {
		out = append(out, "  "+line)
	}
	return out
}

// usageLine is the attempt's tokens and time; the cost is the plugin's estimate at the model's
// list price.
func usageLine(usage domain.Usage, model string) string {
	parts := []string{
		Plural(usage.Turns, "turn"),
		Count(float64(usage.InputTokens)) + " in / " + Count(float64(usage.OutputTokens)) + " out tokens",
		Count(float64(usage.CacheReadTokens)) + " cache read",
		EstimateText(model, usageTokens(usage)),
		Duration(float64(usage.DurationMs)),
	}
	if usage.RateLimitRetries != 0 {
		parts = append(parts, Plural(usage.RateLimitRetries, "rate-limit retry", "rate-limit retries"))
	}
	return "Usage: " + strings.Join(parts, " · ")
}

// nextActions is the reviewer's next step, chosen from the verdict (see NextStep).
func nextActions(provider domain.Provider, job domain.Job) []string {
	return reviewSection("Next", []string{NextStep(provider, job)})
}
