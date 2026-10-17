package domain

import (
	"fmt"
	"strings"
)

// AttemptSummary is one line per attempt:
// "#2 (auto_fix): gate_fail; gates 1/2 passed (failing: `npm test`); 3 changed paths, in scope; report valid."
func AttemptSummary(attempt Attempt) string {
	head := fmt.Sprintf("#%d (%s): %s", attempt.N, attempt.Kind, verdictName(attempt.Verdict))
	if attempt.Verification == nil {
		return head + "; not verified."
	}
	verification := attempt.Verification
	changed := len(ChangedPaths(verification.Changes))
	return head + "; " + gatesSummary(verification.Gates) + "; " + plural(changed, "changed path") + ", " +
		scopeSummary(verification.Scope) + "; " + reportSummary(verification.Report) + "."
}

func verdictName(verdict *Verdict) string {
	if verdict == nil {
		return "no verdict"
	}
	return string(*verdict)
}

func gatesSummary(gates []GateResult) string {
	if len(gates) == 0 {
		return "no gates"
	}
	failing := make([]string, 0, len(gates))
	for _, gate := range gates {
		if GateFailed(gate) {
			failing = append(failing, "`"+gate.Run+"`")
		}
	}
	passed := fmt.Sprintf("gates %d/%d passed", len(gates)-len(failing), len(gates))
	if len(failing) == 0 {
		return passed
	}
	return passed + " (failing: " + strings.Join(failing, ", ") + ")"
}

func scopeSummary(scope ScopeCheck) string {
	if scope.RepoChanged {
		return "repository changed"
	}
	violations := make([]string, 0, 2)
	if len(scope.OutOfScope) > 0 {
		violations = append(violations, fmt.Sprintf("%d out of scope", len(scope.OutOfScope)))
	}
	if len(scope.Forbidden) > 0 {
		violations = append(violations, fmt.Sprintf("%d forbidden", len(scope.Forbidden)))
	}
	if len(violations) == 0 {
		return "in scope"
	}
	return strings.Join(violations, ", ")
}

func reportSummary(report ReportCheck) string {
	if !report.Present {
		return "report missing"
	}
	if report.Valid {
		return "report valid"
	}
	return "report invalid"
}

func plural(count int, noun string) string {
	if count == 1 {
		return fmt.Sprintf("%d %s", count, noun)
	}
	return fmt.Sprintf("%d %ss", count, noun)
}
