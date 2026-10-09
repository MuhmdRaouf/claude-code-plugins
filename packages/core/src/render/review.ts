import type { ReviewPacket } from "../app/queries.ts";
import { reportFacts, sweepItems } from "../app/report-facts.ts";
import { isSweepBrief } from "../domain/brief.ts";
import type { Attempt, ChangeSet, GateResult, Job, ReportCheck, ScopeCheck, Usage } from "../domain/job.ts";
import { fenced } from "../domain/prompt-fence.ts";
import { attemptSummary } from "../domain/prompt-summary.ts";
import type { Provider } from "../domain/provider.ts";
import { gateFailed } from "../domain/verify.ts";
import {
  count,
  duration,
  lastAttempt,
  modelId,
  oneLine,
  outcomeText,
  plural,
  table,
  verdictOf,
} from "./format.ts";
import { nextStep } from "./next.ts";
import { estimateText } from "./prices.ts";

/** Lines of a failing gate's output quoted inline; the full output is in the gate log. */
const TAIL_LINES = 20;
const CHANGES_LISTED = 50;
const DETAIL_CHARS = 160;

export function review(provider: Provider, packet: ReviewPacket): string {
  const { job } = packet;
  const last = lastAttempt(job);
  return [
    ...header(provider, job, last),
    ...(job.attempts.length > 1
      ? section(
          "Attempts",
          job.attempts.map((attempt) => attemptSummary(attempt)),
        )
      : []),
    ...(last === undefined ? [] : attemptSections(last, modelId(provider, job))),
    ...(packet.diffStat === undefined ? [] : section("Diff stat", packet.diffStat.trimEnd().split("\n"))),
    ...(packet.diff === undefined ? [] : ["", "Diff", fenced(packet.diff, "diff").trimEnd()]),
    ...nextActions(provider, job),
  ].join("\n");
}

/** `review --summary`: verdict, gates, the report's summary and open items, only the failing sweep items — no diff, no
 *  change list, no attempt history. What the reviewer reads first; the full `review` when it is not enough. */
export function reviewSummary(provider: Provider, packet: ReviewPacket): string {
  const { job } = packet;
  const last = lastAttempt(job);
  const worker =
    last?.outcome !== undefined && last.outcome.kind !== "completed"
      ? [`Worker: ${outcomeText(last.outcome)}`]
      : [];
  const verified =
    last?.verification === undefined
      ? ["", "Not verified yet."]
      : [
          ...gatesSection(last.verification.gates),
          ...reportSection(last.report, last.verification.report),
          ...sweepFailures(job, last),
        ];
  return [...header(provider, job, last), ...(worker.length === 0 ? [] : ["", ...worker]), ...verified].join(
    "\n",
  );
}

function header(provider: Provider, job: Job, last: Attempt | undefined): readonly string[] {
  const { workspace } = job;
  const attempt = last === undefined ? "no attempt yet" : `attempt ${last.n} (${last.kind})`;
  const where =
    workspace.worktree === undefined
      ? `repository ${workspace.repoRoot} (must stay unchanged), artifacts ${workspace.artifactsDir}`
      : `worktree ${workspace.worktree} (branch ${workspace.branch ?? "?"}, base ${workspace.baseSha.slice(0, 7)})`;
  return [
    `${provider.name} job ${job.id}: ${job.brief.title}`,
    `verdict ${verdictOf(job)} · ${modelId(provider, job)} · ${job.brief.mode} · ${attempt} · ${job.state.replace("_", " ")}`,
    where,
  ];
}

function attemptSections(attempt: Attempt, model: string): readonly string[] {
  const worker =
    attempt.outcome === undefined || attempt.outcome.kind === "completed"
      ? []
      : [`Worker: ${outcomeText(attempt.outcome)}`];
  const verification = attempt.verification;
  return [
    ...(worker.length === 0 ? [] : ["", ...worker]),
    ...(verification === undefined
      ? ["", "Not verified yet."]
      : [
          ...reportSection(attempt.report, verification.report),
          ...gatesSection(verification.gates),
          "",
          scopeLine(verification.scope),
          ...changesSection(verification.changes),
        ]),
    ...(attempt.usage === undefined ? [] : ["", usageLine(attempt.usage, model)]),
  ];
}

function section(title: string, lines: readonly string[]): readonly string[] {
  return ["", title, ...lines.map((line) => `  ${line}`)];
}

function reportSection(report: unknown, check: ReportCheck): readonly string[] {
  if (!check.present) return ["", "Report: missing (the worker ended without a structured report)"];
  const { summary, openItems, testsAdded } = reportFacts(report);
  const tests = testsAdded.length === 0 ? [] : [`Tests added: ${testsAdded.join(", ")}`];
  const problems = check.valid
    ? []
    : ["Invalid against its contract:", ...check.problems.map((problem) => `- ${problem}`)];
  const open =
    openItems.length === 0 ? ["Open items: none"] : ["Open items:", ...openItems.map((item) => `- ${item}`)];
  return section("Report", [summary ?? "(no summary)", ...tests, ...open, ...problems]);
}

function gatesSection(gates: readonly GateResult[]): readonly string[] {
  if (gates.length === 0) return ["", "Gates: none run"];
  const passed = gates.filter((gate) => !gateFailed(gate)).length;
  const rows = table(
    gates.map((gate) => [
      gateFailed(gate) ? "FAIL" : "pass",
      gate.run,
      gateStatus(gate),
      duration(gate.durationMs),
    ]),
  );
  const lines = rows.flatMap((row, i) => {
    const gate = gates[i];
    return gate !== undefined && gateFailed(gate) ? [row, ...tail(gate.tail)] : [row];
  });
  return section(`Gates (${passed}/${gates.length} passed)`, lines);
}

/** Only the sweep items that did not pass, one line each; empty for other reports or a clean sweep. */
function sweepFailures(job: Job, last: Attempt): readonly string[] {
  if (!isSweepBrief(job.brief)) return [];
  const failing = (sweepItems(last.report) ?? []).filter((item) => item.status !== "ok");
  if (failing.length === 0) return [];
  return section(
    "Sweep (failing only)",
    failing.map((item) => `${item.id}: ${item.status} — ${oneLine(item.detail, DETAIL_CHARS)}`),
  );
}

function gateStatus(gate: GateResult): string {
  if (gate.timedOut) return "timed out";
  return gate.exitCode === null ? "killed" : `exit ${gate.exitCode}`;
}

function tail(text: string): readonly string[] {
  const lines = text.trimEnd().split("\n");
  if (text.trim() === "") return ["  | (no output)"];
  return lines.slice(-TAIL_LINES).map((line) => `  | ${line}`.trimEnd());
}

function scopeLine(scope: ScopeCheck): string {
  if (scope.repoChanged) return "Scope: VIOLATED, the repository changed (this job must leave it unchanged)";
  const problems = [
    ...(scope.outOfScope.length === 0 ? [] : [`out of scope: ${scope.outOfScope.join(", ")}`]),
    ...(scope.forbidden.length === 0 ? [] : [`forbidden: ${scope.forbidden.join(", ")}`]),
  ];
  return problems.length === 0 ? "Scope: in scope" : `Scope: VIOLATED, ${problems.join("; ")}`;
}

function changesSection(changes: ChangeSet): readonly string[] {
  const entries = [
    ...changes.added.map((path) => `A ${path}`),
    ...changes.modified.map((path) => `M ${path}`),
    ...changes.deleted.map((path) => `D ${path}`),
    ...changes.untracked.map((path) => `? ${path}`),
  ];
  if (entries.length === 0) return ["Changes: none"];
  const more = entries.length > CHANGES_LISTED ? [`and ${entries.length - CHANGES_LISTED} more`] : [];
  return [
    `Changes (${entries.length}):`,
    ...[...entries.slice(0, CHANGES_LISTED), ...more].map((line) => `  ${line}`),
  ];
}

/** The attempt's tokens and time; the cost is the plugin's estimate at the model's list price. */
function usageLine(usage: Usage, model: string): string {
  const parts = [
    plural(usage.turns, "turn"),
    `${count(usage.inputTokens)} in / ${count(usage.outputTokens)} out tokens`,
    `${count(usage.cacheReadTokens)} cache read`,
    estimateText(model, usage),
    duration(usage.durationMs),
    ...(usage.rateLimitRetries === 0
      ? []
      : [plural(usage.rateLimitRetries, "rate-limit retry", "rate-limit retries")]),
  ];
  return `Usage: ${parts.join(" · ")}`;
}

/** The reviewer's next step, chosen from the verdict (see nextStep). */
function nextActions(provider: Provider, job: Job): readonly string[] {
  return section("Next", [nextStep(provider, job)]);
}
