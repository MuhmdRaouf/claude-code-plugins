import type { BoardRow } from "../app/queries.ts";
import { attemptSummary } from "../domain/prompt-summary.ts";
import type { Provider } from "../domain/provider.ts";
import { ago, modelId, oneLine, progressText } from "./format.ts";

const LAST_TEXT_CHARS = 160;

/** `show`: state, attempts so far and, while running, what the worker is doing. */
export function jobView(provider: Provider, row: BoardRow, now: number): string {
  const { name, slash } = provider;
  const { job, progress, live } = row;
  const active = job.state === "running" || job.state === "verifying";
  const driver =
    active && !live
      ? ` (stale: no live driver; ${slash}board stops it, ${slash}review ${job.id} then discards it)`
      : "";
  return [
    `${name} job ${job.id}: ${job.brief.title}`,
    `${job.state.replace("_", " ")}${driver} · ${modelId(provider, job)} · ${job.brief.mode} · created ${ago(job.createdAt, now)} · updated ${ago(job.updatedAt, now)}`,
    `workspace ${job.workspace.worktree ?? job.workspace.repoRoot}`,
    ...(job.attempts.length === 0
      ? ["Attempts: none yet"]
      : ["Attempts:", ...job.attempts.map((attempt) => `  ${attemptSummary(attempt)}`)]),
    ...(progress === undefined
      ? []
      : [
          `Progress: ${progressText(progress)}`,
          ...(progress.lastText === "" ? [] : [`  "${oneLine(progress.lastText, LAST_TEXT_CHARS)}"`]),
        ]),
  ].join("\n");
}
