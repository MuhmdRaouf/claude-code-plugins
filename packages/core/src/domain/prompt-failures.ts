import type { Attempt, GateResult, ReportCheck } from "./job.ts";
import type { PromptLimits } from "./prompt.ts";
import { fenced } from "./prompt-fence.ts";
import { lines } from "./prompt-text.ts";
import { changedPaths, gateFailed } from "./verify.ts";

/** One section per verification failure of the attempt, each ready to quote back to the worker. */
export function failureSections(attempt: Attempt, limits: PromptLimits): readonly string[] {
  const verification = attempt.verification;
  if (verification === undefined) return [];
  const { scope, gates, changes, report } = verification;
  const repoChanged = scope.repoChanged ? changedPaths(changes) : [];
  return [
    ...pathSection(REPO_CHANGED, repoChanged, limits.pathsListed),
    ...pathSection("Changed outside scope. Revert these changes:", scope.outOfScope, limits.pathsListed),
    ...pathSection("Changed forbidden paths. Revert these changes:", scope.forbidden, limits.pathsListed),
    ...reportSection(report),
    ...gates.filter(gateFailed).map((gate) => gateSection(gate, limits.gateTailChars)),
  ];
}

function reportSection(report: ReportCheck): readonly string[] {
  if (!report.present) return ["The structured report is missing."];
  if (report.valid) return [];
  return [lines(["The structured report is invalid:", ...report.problems.map((problem) => `- ${problem}`)])];
}

const REPO_CHANGED = "The repository changed, but this job must leave it unchanged. Revert these changes:";

function pathSection(heading: string, paths: readonly string[], max: number): readonly string[] {
  if (paths.length === 0) return [];
  const listed = paths.slice(0, max).map((path) => `- \`${path}\``);
  const more = paths.length > max ? [`- and ${paths.length - max} more`] : [];
  return [lines([heading, ...listed, ...more])];
}

function gateSection(gate: GateResult, tailChars: number): string {
  const output = gate.tail === "" ? "(no output)" : keepEnd(gate.tail, tailChars);
  return `Gate failed: \`${gate.run}\` (${gateStatus(gate)})\n${fenced(output, "text")}`;
}

/** The end of the output is where the error usually is. */
function keepEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  return `[${text.length - max} earlier characters cut]\n${text.slice(text.length - max)}`;
}

function gateStatus(gate: GateResult): string {
  if (gate.timedOut) return "timed out";
  return gate.exitCode === null ? "killed, no exit code" : `exit ${gate.exitCode}`;
}
