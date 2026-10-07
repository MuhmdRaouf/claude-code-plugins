import type { Attempt, GateResult, ReportCheck, ScopeCheck } from "./job.ts";
import { changedPaths, gateFailed } from "./verify.ts";

/** One line per attempt: "#2 (auto_fix): gate_fail; gates 1/2 passed (failing: `npm test`); 3 changed paths, in scope; report valid." */
export function attemptSummary(attempt: Attempt): string {
  const head = `#${attempt.n} (${attempt.kind}): ${attempt.verdict ?? "no verdict"}`;
  const verification = attempt.verification;
  if (verification === undefined) return `${head}; not verified.`;
  const changed = changedPaths(verification.changes).length;
  return `${head}; ${gatesSummary(verification.gates)}; ${plural(changed, "changed path")}, ${scopeSummary(verification.scope)}; ${reportSummary(verification.report)}.`;
}

function gatesSummary(gates: readonly GateResult[]): string {
  if (gates.length === 0) return "no gates";
  const failing = gates.filter(gateFailed);
  const passed = `gates ${gates.length - failing.length}/${gates.length} passed`;
  return failing.length === 0
    ? passed
    : `${passed} (failing: ${failing.map((gate) => `\`${gate.run}\``).join(", ")})`;
}

function scopeSummary(scope: ScopeCheck): string {
  if (scope.repoChanged) return "repository changed";
  const violations = [
    ...(scope.outOfScope.length > 0 ? [`${scope.outOfScope.length} out of scope`] : []),
    ...(scope.forbidden.length > 0 ? [`${scope.forbidden.length} forbidden`] : []),
  ];
  return violations.length === 0 ? "in scope" : violations.join(", ");
}

function reportSummary(report: ReportCheck): string {
  if (!report.present) return "report missing";
  return report.valid ? "report valid" : "report invalid";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
