import { reportFacts } from "../app/report-facts.ts";
import type { Job } from "../domain/job.ts";
import type { Provider } from "../domain/provider.ts";
import { changedPaths, gateFailed } from "../domain/verify.ts";
import { lastAttempt, modelId, outcomeText, plural, verdictOf } from "./format.ts";
import { nextStep } from "./next.ts";

const FILES_NAMED = 10;

/** Compact one-screen summary the dispatcher subagent returns (verdict first, then what changed, then next actions). */
export function summary(provider: Provider, job: Job): string {
  const { name } = provider;
  const last = lastAttempt(job);
  const verification = last?.verification;
  const history = job.attempts.map(
    (attempt) => `#${attempt.n} ${attempt.kind} ${attempt.verdict ?? "no verdict"}`,
  );
  return [
    `${name} job ${job.id}: verdict ${verdictOf(job)} (${job.state.replace("_", " ")})`,
    `${job.brief.title} (${modelId(provider, job)}, ${job.brief.mode}); ${plural(job.attempts.length, "attempt")}: ${history.join(", ")}`,
    ...(last?.outcome === undefined || last.outcome.kind === "completed"
      ? []
      : [`Worker: ${outcomeText(last.outcome)}`]),
    ...(verification === undefined ? ["Not verified."] : verifiedLines(last?.report, verification)),
    `Next: ${nextStep(provider, job)}`,
  ].join("\n");
}

function verifiedLines(
  report: unknown,
  verification: NonNullable<Job["attempts"][number]["verification"]>,
): string[] {
  const paths = changedPaths(verification.changes);
  const named = paths.slice(0, FILES_NAMED).join(", ");
  const more = paths.length > FILES_NAMED ? ` and ${paths.length - FILES_NAMED} more` : "";
  const failing = verification.gates.filter(gateFailed).map((gate) => gate.run);
  const { gates } = verification;
  const gatesLine =
    gates.length === 0
      ? "Gates: none"
      : `Gates: ${gates.length - failing.length}/${gates.length} passed${failing.length === 0 ? "" : `; failing: ${failing.join(", ")}`}`;
  return [
    paths.length === 0 ? "Changed: nothing" : `Changed ${plural(paths.length, "file")}: ${named}${more}`,
    gatesLine,
    reportLine(report, verification.report),
  ];
}

function reportLine(
  report: unknown,
  check: { readonly present: boolean; readonly valid: boolean; readonly problems: readonly string[] },
): string {
  if (!check.present) return "Report: missing";
  if (!check.valid) return `Report: invalid (${plural(check.problems.length, "problem")})`;
  const { summary: text, openItems } = reportFacts(report);
  const open = openItems.length === 0 ? "" : ` (${plural(openItems.length, "open item")})`;
  return `Report: ${text ?? "(no summary)"}${open}`;
}
