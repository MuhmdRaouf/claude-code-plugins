// src/ext/repo.ts — read-only access to a channel's repo (channel config `repo`):
//   safe(p)      the path inside the repo (or its .agents/scratch tree), never anything named secrets
//   tree(p)      one directory level, with READMEs and the steps that touch each entry
//   file(p)      a whole file (capped) for the code view
//   drift(steps) does each non-proposed snippet still match the file it quotes?
import { readdirSync, statSync, existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";

type Row = Record<string, any>;
const SKIP = new Set([".git", ".terraform", "node_modules", ".direnv", "result", ".agents"]);
export type RepoTools = ReturnType<typeof make>;
const cache = new Map<string, RepoTools>();
// one instance per repo path; a path that does not exist yields null
export function repoTools(REPO: string) {
  if (!existsSync(REPO)) return null;
  let t = cache.get(REPO); if (!t) { t = make(REPO); cache.set(REPO, t); }
  return t;
}

function make(REPO: string) {
  const real = realpathSync(REPO);
  // the scratch tree is a symlink out of the worktree; quotes from it are allowed too
  const scratch = existsSync(`${REPO}/.agents/scratch`) ? realpathSync(`${REPO}/.agents/scratch`) : null;
  const safe = (rel: string) => {
    if (rel.includes("..") || rel.startsWith("/")) return null;
    if (/(^|\/)secrets(\/|$)/.test(rel)) return null; // never serve a secrets/ directory
    let full = rel ? `${REPO}/${rel}` : REPO;
    if (!existsSync(full) && scratch && existsSync(`${scratch}/${rel}`)) full = `${scratch}/${rel}`;
    if (!existsSync(full)) return null;
    const rp = realpathSync(full);
    if (/(^|\/)secrets(\/|$)/.test(rp)) return null; // also via a symlink
    const within = (root: string) => rp === root || rp.startsWith(root + "/");
    return within(real) || (scratch && within(scratch)) ? full : null;
  };

  async function tree(rel: string) {
    const full = safe(rel); if (!full) return { error: "not found" };
    if (!statSync(full).isDirectory()) return { file: true, path: rel };
    const entries = readdirSync(full).filter(n => !SKIP.has(n) && !n.startsWith(".DS_Store") && safe(rel ? `${rel}/${n}` : n)).sort((a, b) => {
      const da = statSync(`${full}/${a}`).isDirectory(), dbb = statSync(`${full}/${b}`).isDirectory();
      return da === dbb ? a.localeCompare(b) : da ? -1 : 1;
    }).map(n => { const st = statSync(`${full}/${n}`); return { name: n, path: rel ? `${rel}/${n}` : n, dir: st.isDirectory(), size: st.size }; });
    const readme = entries.find(e => /^README\.md$/i.test(e.name));
    return { path: rel, entries, readme: readme ? await readFile(`${full}/${readme.name}`, "utf8") : null };
  }

  async function file(rel: string) {
    const full = safe(rel); if (!full || statSync(full).isDirectory()) return { error: "not a file" };
    const size = statSync(full).size;
    if (size > 2_000_000) return { path: rel, size, text: "(file larger than 2 MB)" };
    const text = await readFile(full, "utf8");
    if (/\u0000/.test(text.slice(0, 2000))) return { path: rel, size, binary: true };
    return { path: rel, size, text };
  }

  // a snippet matches when most of its meaningful lines still occur in the file it quotes
  async function drift(steps: Row[]) {
    const out: Row[] = [];
    const cache = new Map<string, string | null>();
    for (const s of steps) for (const [i, sn] of (s.snippets ?? []).entries()) {
      if (!sn.path || sn.proposed) continue;
      const path = String(sn.path).replace(/:\d+(-\d+)?$/, "");
      if (!cache.has(path)) { const f = safe(path); cache.set(path, f && !statSync(f).isDirectory() ? await readFile(f, "utf8") : null); }
      const text = cache.get(path);
      if (text == null) { out.push({ step: s.id, i, path, state: "missing" }); continue; }
      const norm = (l: string) => l.replace(/\s+/g, " ").trim();
      const flat = norm(text);
      const lines = String(sn.code).split("\n").map(l => norm(l).replace(/^…\s*|\s*…$/g, ""))
        .filter(l => l.length > 3 && !/^(#|\/\/)\s*…|^…$|^\.\.\.$/.test(l));
      if (!lines.length) continue;
      // a quoted line counts when it still occurs in the file (wrapped Markdown and long XML lines included)
      const hit = lines.filter(l => flat.includes(l)).length / lines.length;
      out.push({ step: s.id, i, path, state: hit >= 0.6 ? "ok" : hit >= 0.3 ? "partial" : "drift", score: Math.round(hit * 100) });
    }
    return out;
  }

  return { tree, file, drift, safe };
}
