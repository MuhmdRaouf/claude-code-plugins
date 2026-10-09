import { copyFile, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Result } from "../domain/result.ts";
import type { GitError } from "../ports/index.ts";
import { gitValue, gitVoid } from "./git-run.ts";

/** Runs `fn` with a private copy of dir's index (GIT_INDEX_FILE), so staging there never touches the real index. The
 *  copy lives in a temp dir named after the provider (`<provider>-index-…`). */
export async function withTempIndex<T>(
  dir: string,
  provider: string,
  fn: (env: Readonly<Record<string, string>>) => Promise<Result<T, GitError>>,
): Promise<Result<T, GitError>> {
  const located = await gitValue(dir, ["rev-parse", "--git-path", "index"]);
  if (!located.ok) return located;
  const scratch = await mkdtemp(join(tmpdir(), `${provider}-index-`));
  try {
    const index = join(scratch, "index");
    await copyIndex(resolve(dir, located.value), index).catch(() => {
      // No readable index: start empty. The tree is the same, `add -A` just hashes every file.
    });
    return await fn({ GIT_INDEX_FILE: index });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The copy keeps the index's timestamps: git re-reads an entry whose mtime is not older than the index file (a
 *  "racily clean" entry), and a newer copy would make a same-size edit made in that window look unchanged. */
async function copyIndex(from: string, to: string): Promise<void> {
  await copyFile(from, to);
  const { atime, mtime } = await stat(from);
  await utimes(to, atime, mtime);
}

/** The tree of dir's working state as `git add -A` sees it (tracked + untracked, minus ignored), without changing the
 *  real index. Starts from a copy of the real index so force-added files stay and unchanged files are not rehashed. */
export function snapshotTree(dir: string, provider: string): Promise<Result<string, GitError>> {
  return withTempIndex(dir, provider, async (env) => {
    const added = await gitVoid(dir, ["add", "-A"], { env });
    return added.ok ? gitValue(dir, ["write-tree"], { env }) : added;
  });
}
