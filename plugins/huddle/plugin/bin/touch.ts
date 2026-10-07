// touch.ts — the file a PostToolUse edit touched, as Huddle records it (server/src/touches.ts):
// the repo it is in and its path inside that repo. Only Edit, Write, MultiEdit and NotebookEdit
// count, and only the path leaves this machine's hook: never the contents. The repo is found
// without running git: the nearest .git up from the file; a worktree's .git file points at the
// repository's common dir, so every worktree of one repository is the same repo (their edits to the
// same file meet at merge time). A file outside any git repo counts within the session's cwd.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hfetch, type Identity } from "./identity";

export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const rel = (root: string, f: string) => { const r = relative(root, f); return !r || r.startsWith("..") || isAbsolute(r) ? null : r.split(sep).join("/"); };

// the repository a .git entry stands for: a worktree's (or submodule's) .git file names its gitdir,
// whose commondir names the shared one
function common(git: string): string {
  try {
    if (statSync(git).isDirectory()) return real(git);
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, "utf8"));
    if (!m) return real(git);
    const gd = resolve(dirname(git), m[1].trim());
    try { return real(resolve(gd, readFileSync(join(gd, "commondir"), "utf8").trim())); } catch { return real(gd); }
  } catch { return real(git); }
}

export function touchOf(input: { tool_name?: string; tool_input?: any; cwd?: string }): { repo: string; path: string } | null {
  if (!EDIT_TOOLS.has(String(input.tool_name ?? ""))) return null;
  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof raw !== "string" || !raw) return null;
  const cwd = input.cwd || process.cwd();
  const file = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw); // as given: a symlinked ancestor is fine, both sides keep it
  for (let d = dirname(file), i = 0; i < 64; i++) {
    const g = join(d, ".git");
    if (existsSync(g)) {
      const path = rel(d, file);
      if (!path) return null;
      const c = common(g);
      return { repo: c.endsWith(`${sep}.git`) ? dirname(c) : c, path };
    }
    const up = dirname(d); if (up === d) break; d = up;
  }
  const path = rel(resolve(cwd), file);
  return path ? { repo: real(cwd), path } : null;
}

// report it; the answer is one line for the session when another live session edited the same file
// lately (once per file per window), else nothing. Never throws, never waits longer than ms.
export async function reportTouch(id: Identity, t: { repo: string; path: string }, ms: number): Promise<string> {
  try {
    const r = await hfetch(`${id.url}/api/c/${encodeURIComponent(id.channel)}/op/touched?as=${encodeURIComponent(id.as)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t), signal: AbortSignal.timeout(ms) });
    if (!r.ok) return "";
    const j = await r.json() as any;
    return typeof j?.result?.warn === "string" ? j.result.warn : "";
  } catch { return ""; }
}
