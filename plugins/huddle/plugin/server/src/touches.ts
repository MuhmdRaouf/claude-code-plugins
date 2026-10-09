// src/touches.ts — which files the sessions of a channel edit, so two of them do not work on the
// same file without knowing. The PostToolUse hook (hooks/listen.ts, bin/touch.ts) reports each edit
// (Edit, Write, MultiEdit, NotebookEdit) as a path relative to its repo, never its contents; one row
// per session, repo and path keeps the latest time. A conflict is a file that two live sessions
// (not left) edited within WINDOW_MIN minutes in the same repo. The editing session hears about it
// once per file per window: one line in its context, nothing else. No locks; nothing ever blocks.
import { HuddleError, parentOf, type Channel, type Row } from "./channel";

export const WINDOW_MIN = 30;
const KEEP_DAYS = 90; // knowledge staleness reads old touches too (src/knowledge.ts)
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const mins = (at: string) => Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
export const ago = (at: string) => { const m = mins(at); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
// a repo key is a local path; the panel shows its last part
export const repoName = (repo: string) => repo.replace(/\/+$/, "").split("/").pop() || repo;

function clean(path: unknown, repo: unknown) {
  const p = String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  const r = String(repo ?? "");
  if (!p || p.length > 500 || p.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(p) || /[\0\n]/.test(p)) throw new HuddleError(400, "path: a file path relative to its repo");
  if (!r || r.length > 500 || /[\0\n]/.test(r)) throw new HuddleError(400, "repo: the repo the file is in");
  return { path: p, repo: r };
}

// a session edited a file: record it; say who else (live, same repo) edited it in the window, and
// whether this session should be told now (once per file per window)
export function touched(ch: Channel, me: string, a: { path?: unknown; repo?: unknown }) {
  const { path, repo } = clean(a.path, a.repo);
  const name = parentOf(me) ?? me; // a subagent's edits are its session's
  return ch.serial(async () => {
    if (!(await ch.session(name))) throw new HuddleError(404, `"${name}" has not joined channel ${ch.name}`);
    const now = Date.now(), at = iso(now), since = iso(now - WINDOW_MIN * 60_000);
    const others = await ch.store.all(`SELECT t.session, t.at FROM touches t JOIN sessions s ON s.name = t.session
      WHERE t.repo=? AND t.path=? AND t.session != ? AND t.at > ? AND s.state != 'left' ORDER BY t.at DESC`, [repo, path, name, since]);
    const mine = await ch.store.get("SELECT warned_at FROM touches WHERE session=? AND repo=? AND path=?", [name, repo, path]);
    const warn = others.length > 0 && !(mine?.warned_at && mine.warned_at > since);
    await ch.store.run(`INSERT INTO touches (session, repo, path, at, warned_at) VALUES (?,?,?,?,?)
      ON CONFLICT(session, repo, path) DO UPDATE SET at=excluded.at, warned_at=COALESCE(excluded.warned_at, touches.warned_at)`, [name, repo, path, at, warn ? at : null]);
    if (Math.random() < 0.02) await ch.store.run("DELETE FROM touches WHERE at < ?", [iso(now - KEEP_DAYS * 86400_000)]);
    if (others.length) ch.emit("conflict", { repo, path, sessions: [name, ...others.map(o => o.session as string)] });
    const who = others.map(o => `${o.session} edited ${path} ${ago(o.at)}`);
    const line = warn ? `Huddle: ${who.length > 1 ? `${who[0]}, ${others.slice(1).map(o => `${o.session} ${ago(o.at)}`).join(", ")}` : who[0]} — coordinate with ${others.length > 1 ? "them" : "it"} (send, or ask) before you change more.` : null;
    return { path, repo, others: others.map(o => ({ session: o.session as string, at: o.at as string })), warn: line };
  });
}

// every file two or more live sessions edited in the window, newest first
export async function conflicts(ch: Channel) {
  const since = iso(Date.now() - WINDOW_MIN * 60_000);
  const rows = await ch.store.all(`SELECT t.session, t.repo, t.path, t.at FROM touches t JOIN sessions s ON s.name = t.session
    WHERE t.at > ? AND s.state != 'left' ORDER BY t.at DESC`, [since]);
  const by = new Map<string, Row>();
  for (const r of rows) {
    const k = `${r.repo}\0${r.path}`;
    const g = by.get(k) ?? { repo: r.repo, repo_name: repoName(r.repo), path: r.path, last: r.at, sessions: [] as Row[] };
    g.sessions.push({ name: r.session, at: r.at });
    by.set(k, g);
  }
  return { window_min: WINDOW_MIN, conflicts: [...by.values()].filter(g => g.sessions.length > 1) };
}

// the last time any session of the channel edited a path (for knowledge staleness): a ref matches a
// touched path when it is that path or ends with "/<path>" (an absolute ref)
export async function lastEdit(ch: Channel, ref: string, after: string): Promise<string | null> {
  const name = ref.split("/").pop() ?? ref;
  const rows = await ch.store.all("SELECT path, MAX(at) at FROM touches WHERE path LIKE ? ESCAPE '\\' AND at > ? GROUP BY path", [`%${name.replace(/[\\%_]/g, "\\$&")}`, after]);
  const hit = rows.filter(r => ref === r.path || ref.endsWith(`/${r.path}`)).map(r => r.at as string).sort().pop();
  return hit ?? null;
}
