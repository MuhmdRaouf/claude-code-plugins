import { type Brief, type Priority, parseBrief } from "../domain/brief.ts";
import { type Job, jobOrigin, type Workspace } from "../domain/job.ts";
import { maxFromEnv } from "../domain/limiter.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Deps } from "./deps.ts";
import { briefEngine, resolveEngine, workerOf } from "./engine-select.ts";
import type { AppError } from "./errors.ts";
import { reportSchema } from "./report-schema.ts";
import { type BriefOverrides, withOverrides } from "./submit-overrides.ts";

interface SubmitInput {
  /** Brief document text and where it came from (for relative cwd/addDirs/report paths). */
  readonly text: string;
  readonly sourcePath?: string;
  readonly cwd: string;
  /** CLI overrides: --flash, --mode, --effort. Applied after parsing, before defaults that depend on them. */
  readonly overrides?: BriefOverrides;
  /** The queue priority a brief without its own `priority` field gets (run: high, batch: normal). */
  readonly defaultPriority?: Priority;
}

/**
 * Parse + validate the brief, check every `env` name is set in deps.env (values are not stored), resolve repo root and
 * base sha, create the artifacts dir and (edit mode) the worktree on branch <branchPrefix><id>, persist the job as `queued`.
 * Any failure after the worktree exists removes it again (no orphans).
 */
export async function submit(deps: Deps, input: SubmitInput): Promise<Result<Job, AppError>> {
  const brief = await validBrief(deps, input);
  if (!brief.ok) return brief;
  const repoRoot = await deps.git.root(brief.value.cwd);
  if (!repoRoot.ok) return err({ kind: "git", error: repoRoot.error });
  const baseSha = await deps.git.resolve(repoRoot.value, brief.value.base);
  if (!baseSha.ok) return err({ kind: "git", error: baseSha.error });

  const id = deps.ids.jobId();
  const paths = deps.store.paths(id);
  const workspace: Workspace = {
    repoRoot: repoRoot.value,
    baseSha: baseSha.value,
    ...(brief.value.mode === "edit"
      ? { worktree: paths.worktree, branch: `${deps.provider.branchPrefix}${id}` }
      : {}),
    artifactsDir: paths.artifacts,
  };
  if (workspace.worktree !== undefined && workspace.branch !== undefined) {
    const added = await deps.git.addWorktree(
      workspace.repoRoot,
      workspace.worktree,
      workspace.branch,
      baseSha.value,
    );
    if (!added.ok) return err({ kind: "git", error: added.error });
  }
  const now = deps.clock.iso();
  const job = queuedJob(deps, id, brief.value, workspace, now);
  const created = await deps.store.create(job);
  if (!created.ok) {
    if (workspace.worktree !== undefined && workspace.branch !== undefined) {
      await deps.git.removeWorktree(workspace.repoRoot, workspace.worktree, workspace.branch);
    }
    return err({ kind: "store", error: created.error });
  }
  await deps.files.writeBrief(paths, input.text);
  // Every submission refreshes the ceiling the drivers grow towards (A3: `${envPrefix}_MAX_CONCURRENCY`, default 16).
  await deps.limiter.saveMax(
    maxFromEnv(deps.env[`${deps.provider.envPrefix}_MAX_CONCURRENCY`], deps.config.limiter),
    deps.clock.now(),
  );
  return created;
}

/** The queued job submit persists: `origin` names the Claude Code session that ran the command, when the
 *  environment carries one (Radar shows the job inside that session). */
function queuedJob(deps: Deps, id: string, brief: Brief, workspace: Workspace, now: string): Job {
  const origin = jobOrigin(deps.env.CLAUDE_CODE_SESSION_ID);
  return {
    id,
    brief,
    state: "queued",
    workspace,
    attempts: [],
    createdAt: now,
    updatedAt: now,
    ...(origin !== undefined ? { origin } : {}),
    version: 0,
  };
}

/** The brief as the job will run it: parsed against the current git root, overrides applied, report schema file
 *  readable, every env name set. `brief lint` checks exactly this. */
export async function validBrief(deps: Deps, input: SubmitInput): Promise<Result<Brief, AppError>> {
  const root = await deps.git.root(input.cwd);
  const defaultCwd = root.ok ? root.value : input.cwd;
  const engine = resolveEngine(deps, input.overrides?.engine, input.text);
  if (!engine.ok) return engine;
  // The brief is checked against the terms (efforts, budget) of the engine that will run it; an engine the brief does
  // not name already (the --engine flag, the configured default) is written into it like any other override.
  const named = briefEngine(input.text) ?? "claude";
  const overrides = { ...input.overrides, ...(engine.value === named ? {} : { engine: engine.value }) };
  const parsed = parseBrief(withOverrides(input.text, overrides, deps.provider), {
    defaultCwd,
    provider: deps.provider,
    worker: (workerOf(deps, engine.value) ?? deps.worker).caps,
  });
  if (!parsed.ok) return err({ kind: "brief", errors: parsed.error });
  const brief =
    parsed.value.priority === undefined && input.defaultPriority !== undefined
      ? { ...parsed.value, priority: input.defaultPriority }
      : parsed.value;
  const schema = await reportSchema(deps.files, brief.report);
  if (!schema.ok)
    return err({ kind: "brief", errors: [{ kind: "field", field: "report", message: schema.error }] });
  const missing = brief.env.filter((name) => deps.env[name] === undefined);
  return missing.length > 0 ? err({ kind: "missing_env", names: missing }) : ok(brief);
}
