import type { Deps } from "../app/deps.ts";

/** The repository of cwd, so board/usage/stop --all default to it; undefined outside a repository. */
export async function repoOf(deps: Deps, cwd: string): Promise<string | undefined> {
  const root = await deps.git.root(cwd);
  return root.ok ? root.value : undefined;
}
