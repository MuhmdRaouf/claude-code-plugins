import { DEFAULT_GATE_TIMEOUT_MS } from "../domain/brief-defaults.ts";
import type { Attempt, ChangeSet, GateResult, Job, ScopeCheck, Verification } from "../domain/job.ts";
import { checkReport } from "../domain/reports.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { checkScope, gateFailed } from "../domain/verify.ts";
import type { Deps } from "./deps.ts";
import { passEnv, workspaceDir } from "./drive-run.ts";
import type { AppError } from "./errors.ts";

const NO_CHANGES: ChangeSet = { added: [], modified: [], deleted: [], untracked: [] };

/** exec/readonly jobs must leave the repository as they found it: its fingerprint before the worker ran. */
export async function repositoryFingerprint(deps: Deps, job: Job): Promise<Result<string | null, AppError>> {
  if (job.brief.mode === "edit") return ok(null);
  const fingerprint = await deps.git.statusFingerprint(job.workspace.repoRoot);
  return fingerprint.ok ? fingerprint : err({ kind: "git", error: fingerprint.error });
}

/** Gates (only when the worker completed), the change set against scope, and the report against its contract. */
export async function verifyAttempt(
  deps: Deps,
  job: Job,
  attempt: Attempt,
  before: string | null,
): Promise<Result<Verification, AppError>> {
  const paths = deps.store.paths(job.id);
  const gates =
    attempt.outcome?.kind === "completed"
      ? await runSetupAndGates(deps, job, workspaceDir(job), (i) => paths.gateLog(attempt.n, i))
      : [];
  const changed = before === null ? await editChanges(deps, job) : await repositoryChanges(deps, job, before);
  if (!changed.ok) return changed;
  return ok({ gates, ...changed.value, report: checkReport(attempt.report, job.brief.report) });
}

/** The brief's setup commands in order, then its gates, all through the gate runner. The first failed setup stops
 *  there: the gates would run against a workspace that was never prepared. */
export async function runSetupAndGates(
  deps: Deps,
  job: Job,
  cwd: string,
  logAt: (i: number) => string,
): Promise<readonly GateResult[]> {
  const env = passEnv(deps, job);
  const setup = job.brief.setup ?? [];
  const results: GateResult[] = [];
  for (const [i, run] of setup.entries()) {
    const result = await deps.gates.run(cwd, { run, timeoutMs: DEFAULT_GATE_TIMEOUT_MS }, env, logAt(i));
    results.push(result);
    if (gateFailed(result)) return results;
  }
  for (const [i, gate] of job.brief.gates.entries()) {
    results.push(await deps.gates.run(cwd, gate, env, logAt(setup.length + i)));
  }
  return results;
}

type ChangeCheck = Result<{ readonly changes: ChangeSet; readonly scope: ScopeCheck }, AppError>;

async function editChanges(deps: Deps, job: Job): Promise<ChangeCheck> {
  const changes = await deps.git.changes(workspaceDir(job), job.workspace.baseSha);
  if (!changes.ok) return err({ kind: "git", error: changes.error });
  return ok({ changes: changes.value, scope: checkScope(changes.value, job.brief) });
}

/** Any fingerprint change is a violation; the change set (against the base) is listed only then. */
async function repositoryChanges(deps: Deps, job: Job, before: string): Promise<ChangeCheck> {
  const after = await repositoryFingerprint(deps, job);
  if (!after.ok) return after;
  const unchanged = { outOfScope: [], forbidden: [], repoChanged: false };
  if (after.value === before) return ok({ changes: NO_CHANGES, scope: unchanged });
  const changes = await deps.git.changes(job.workspace.repoRoot, job.workspace.baseSha);
  if (!changes.ok) return err({ kind: "git", error: changes.error });
  return ok({ changes: changes.value, scope: { ...unchanged, repoChanged: true } });
}
