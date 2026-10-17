package render

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

const filesNamed = 10

// Summary is the compact one-screen summary the dispatcher subagent returns: verdict first, then
// what changed, then next actions.
func Summary(provider domain.Provider, job domain.Job) string {
	last := LastAttempt(job)
	history := make([]string, 0, len(job.Attempts))
	for _, attempt := range job.Attempts {
		verdict := "no verdict"
		if attempt.Verdict != nil {
			verdict = string(*attempt.Verdict)
		}
		history = append(history, "#"+strconv.FormatInt(attempt.N, 10)+" "+string(attempt.Kind)+" "+verdict)
	}
	lines := []string{
		provider.Name + " job " + job.ID + ": verdict " + VerdictOf(job) + " (" +
			strings.Replace(string(job.State), "_", " ", 1) + ")",
		job.Brief.Title + " (" + ModelID(provider, job) + ", " + string(job.Brief.Mode) + "); " +
			Plural(int64(len(job.Attempts)), "attempt") + ": " + strings.Join(history, ", "),
	}
	if last != nil && last.Outcome != nil && last.Outcome.Kind != domain.WorkerOutcomeCompleted {
		lines = append(lines, "Worker: "+OutcomeText(*last.Outcome))
	}
	if last == nil || last.Verification == nil {
		lines = append(lines, "Not verified.")
	} else {
		lines = append(lines, verifiedLines(last.Report, *last.Verification)...)
	}
	lines = append(lines, "Next: "+NextStep(provider, job))
	return strings.Join(lines, "\n")
}

// verifiedLines is what an attempt's verification says: the files it touched, the gates and the
// report.
func verifiedLines(report json.RawMessage, verification domain.Verification) []string {
	paths := domain.ChangedPaths(verification.Changes)
	named := paths
	if len(named) > filesNamed {
		named = named[:filesNamed]
	}
	more := ""
	if len(paths) > filesNamed {
		more = " and " + strconv.Itoa(len(paths)-filesNamed) + " more"
	}
	failing := make([]string, 0, len(verification.Gates))
	for _, gate := range verification.Gates {
		if domain.GateFailed(gate) {
			failing = append(failing, gate.Run)
		}
	}
	gatesLine := "Gates: none"
	if len(verification.Gates) > 0 {
		gatesLine = "Gates: " + strconv.Itoa(len(verification.Gates)-len(failing)) + "/" +
			strconv.Itoa(len(verification.Gates)) + " passed"
		if len(failing) > 0 {
			gatesLine += "; failing: " + strings.Join(failing, ", ")
		}
	}
	changedLine := "Changed: nothing"
	if len(paths) > 0 {
		changedLine = "Changed " + Plural(int64(len(paths)), "file") + ": " + strings.Join(named, ", ") + more
	}
	return []string{changedLine, gatesLine, reportLine(report, verification.Report)}
}

// reportLine is the report's own summary line: missing, invalid, or what it said.
func reportLine(report json.RawMessage, check domain.ReportCheck) string {
	if !check.Present {
		return "Report: missing"
	}
	if !check.Valid {
		return "Report: invalid (" + Plural(int64(len(check.Problems)), "problem") + ")"
	}
	facts := app.ReportFacts(report)
	text := "(no summary)"
	if facts.Summary != nil {
		text = *facts.Summary
	}
	open := ""
	if len(facts.OpenItems) > 0 {
		open = " (" + Plural(int64(len(facts.OpenItems)), "open item") + ")"
	}
	return "Report: " + text + open
}
