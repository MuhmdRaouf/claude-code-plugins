package domain

import (
	"fmt"
	"strconv"
)

// FailureSections is one section per verification failure of the attempt, each ready to quote back
// to the worker.
func FailureSections(attempt Attempt, limits PromptLimits) []string {
	if attempt.Verification == nil {
		return nil
	}
	verification := attempt.Verification
	repoChanged := []string{}
	if verification.Scope.RepoChanged {
		repoChanged = ChangedPaths(verification.Changes)
	}
	sections := pathSection(failuresRepoChanged, repoChanged, limits.PathsListed)
	sections = append(sections,
		pathSection("Changed outside scope. Revert these changes:", verification.Scope.OutOfScope, limits.PathsListed)...)
	sections = append(sections,
		pathSection("Changed forbidden paths. Revert these changes:", verification.Scope.Forbidden, limits.PathsListed)...)
	sections = append(sections, reportSection(verification.Report)...)
	for _, gate := range verification.Gates {
		if GateFailed(gate) {
			sections = append(sections, gateSection(gate, limits.GateTailChars))
		}
	}
	return sections
}

func reportSection(report ReportCheck) []string {
	if !report.Present {
		return []string{"The structured report is missing."}
	}
	if report.Valid {
		return nil
	}
	content := make([]string, 0, len(report.Problems)+1)
	content = append(content, "The structured report is invalid:")
	for _, problem := range report.Problems {
		content = append(content, "- "+problem)
	}
	return []string{Lines(content)}
}

const failuresRepoChanged = "The repository changed, but this job must leave it unchanged. Revert these changes:"

func pathSection(heading string, paths []string, max int) []string {
	if len(paths) == 0 {
		return nil
	}
	listed := min(max, len(paths))
	content := make([]string, 0, listed+2)
	content = append(content, heading)
	for _, path := range paths[:listed] {
		content = append(content, "- `"+path+"`")
	}
	if len(paths) > max {
		content = append(content, fmt.Sprintf("- and %d more", len(paths)-max))
	}
	return []string{Lines(content)}
}

func gateSection(gate GateResult, tailChars int) string {
	output := "(no output)"
	if gate.Tail != "" {
		output = keepEnd(gate.Tail, tailChars)
	}
	return "Gate failed: `" + gate.Run + "` (" + gateStatus(gate) + ")\n" + Fenced(output, "text")
}

// keepEnd keeps the end of the output, where the error usually is. The bound and the cut count
// UTF-16 code units, as JavaScript counts strings.
func keepEnd(text string, max int) string {
	length := utf16Len(text)
	if length <= max {
		return text
	}
	return fmt.Sprintf("[%d earlier characters cut]\n", length-max) + utf16Slice(text, length-max, length)
}

func gateStatus(gate GateResult) string {
	if gate.TimedOut {
		return "timed out"
	}
	if gate.ExitCode == nil {
		return "killed, no exit code"
	}
	return "exit " + strconv.FormatInt(*gate.ExitCode, 10)
}
