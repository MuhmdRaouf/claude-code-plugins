import picomatch from "picomatch";
import type { Mode } from "./brief.ts";
import type { ChangeSet, GateResult, ReportCheck, ScopeCheck, Verdict, WorkerOutcome } from "./job.ts";

export interface ScopeRules {
  readonly mode: Mode;
  readonly scope: readonly string[];
  readonly forbid: readonly string[];
}

/**
 * Glob semantics are picomatch with `dot: true`; paths are repo-relative POSIX. edit: every changed path must match some
 * scope glob and no forbid glob. exec/readonly: any change at all sets repoChanged.
 */
export function checkScope(changes: ChangeSet, rules: ScopeRules): ScopeCheck {
  const paths = changedPaths(changes);
  if (rules.mode !== "edit") return { outOfScope: [], forbidden: [], repoChanged: paths.length > 0 };
  const inScope = anyGlob(rules.scope);
  const isForbidden = anyGlob(rules.forbid);
  const forbidden = paths.filter(isForbidden);
  const outOfScope = paths.filter((path) => !isForbidden(path) && !inScope(path));
  return { outOfScope, forbidden, repoChanged: false };
}

/** A predicate true when the path matches at least one glob; no globs match nothing. */
function anyGlob(globs: readonly string[]): (path: string) => boolean {
  return picomatch([...globs], { dot: true });
}

interface VerdictInput {
  readonly outcome: WorkerOutcome;
  readonly gates: readonly GateResult[];
  readonly scope: ScopeCheck;
  readonly report: ReportCheck;
}

/**
 * Precedence, first match wins: stopped, timeout, quota (an api_error the provider gave for an empty balance),
 * worker_error (any other api_error | crashed), scope_violation, report_invalid,
 * gate_fail (any non-zero exit or timed-out gate), pass.
 */
export function deriveVerdict(input: VerdictInput): Verdict {
  switch (input.outcome.kind) {
    case "stopped":
    case "timeout":
      return input.outcome.kind;
    case "api_error":
      return input.outcome.quota ? "quota" : "worker_error";
    case "crashed":
      return "worker_error";
    case "completed":
      return verificationVerdict(input);
  }
}

function verificationVerdict({ scope, report, gates }: VerdictInput): Verdict {
  if (scopeViolated(scope)) return "scope_violation";
  if (!(report.present && report.valid)) return "report_invalid";
  if (gates.some(gateFailed)) return "gate_fail";
  return "pass";
}

/** A gate killed by a signal has a null exit code and counts as failed. */
export function gateFailed(gate: GateResult): boolean {
  return gate.timedOut || gate.exitCode !== 0;
}

function scopeViolated(scope: ScopeCheck): boolean {
  return scope.repoChanged || scope.outOfScope.length > 0 || scope.forbidden.length > 0;
}

/** All paths of a change set, sorted, de-duplicated. */
export function changedPaths(changes: ChangeSet): readonly string[] {
  const all = new Set([...changes.added, ...changes.modified, ...changes.deleted, ...changes.untracked]);
  return [...all].sort();
}
