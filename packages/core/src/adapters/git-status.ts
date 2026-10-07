import { ok, type Result } from "../domain/result.ts";
import type { GitError } from "../ports/index.ts";
import { parseStatus } from "./git-parse.ts";
import { gitText } from "./git-run.ts";

export const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"];

/** Paths in repo that block writing `touched`: dirty or untracked ones among them, plus (when the operation commits,
 *  like cherry-pick) any staged change at all. Sorted. */
export async function blockingPaths(
  repo: string,
  touched: readonly string[],
  opts: { readonly stagedAnywhere: boolean },
): Promise<Result<string[], GitError>> {
  const status = await gitText(repo, STATUS_ARGS);
  if (!status.ok) return status;
  const wanted = new Set(touched);
  const blocking = parseStatus(status.value).filter(
    (entry) => wanted.has(entry.path) || (opts.stagedAnywhere && entry.staged),
  );
  return ok(blocking.map((entry) => entry.path).sort());
}
