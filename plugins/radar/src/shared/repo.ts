/**
 * The repository a working directory belongs to, from its nearest `.git` alone. A linked worktree's `.git` is a
 * file pointing into the main checkout, so a worktree folds into the repo it works on. Pure: the caller supplies
 * the fs and caches results per cwd.
 */
import { dirname, join, normalize } from "node:path";

/** The slice of the filesystem repoOf may look at: enough to tell a `.git` directory from a `.git` file. */
export type RepoFs = { exists(path: string): boolean; readFile(path: string): string | null };

/** "gitdir: <x>/.git/worktrees/<name>" → the main checkout <x>; any other content reads as no pointer. */
function worktreeRepo(dir: string, content: string): string | null {
  const match = /^gitdir:\s*(\S+)\s*$/.exec(content.trim());
  if (match === null) return null;
  const raw = match[1] ?? "";
  const gitdir = normalize(raw.startsWith("/") ? raw : join(dir, raw));
  const at = gitdir.lastIndexOf("/.git/worktrees/");
  return at <= 0 ? null : gitdir.slice(0, at);
}

/** A path shown from the home directory: /Users/raouf/work → ~/work, /home/u/x → ~/x, any other path stands. */
export function homeShort(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

/** The name a repo path stands for: its last non-empty segment ("claude-code-plugins", "app"). A name
 *  never shows as a path — the full path stays where the workspace is shown, in tooltips. */
export function repoName(path: string): string {
  const base = path
    .split("/")
    .filter((part) => part !== "")
    .pop();
  return base ?? path;
}

/** The repo root `cwd` sits in, or null when no parent holds a `.git`. */
export function repoOf(cwd: string, fs: RepoFs): string | null {
  let dir = cwd;
  for (;;) {
    const gitPath = join(dir, ".git");
    if (fs.exists(gitPath)) {
      // a `.git` directory never reads as text; an unreadable `.git` file counts as a plain checkout
      return worktreeRepo(dir, fs.readFile(gitPath) ?? "") ?? dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
