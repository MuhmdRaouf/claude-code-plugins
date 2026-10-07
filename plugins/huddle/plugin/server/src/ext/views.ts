// src/ext/views.ts — read-only views for a channel whose plan lives next to a repo (channel config
// `repo` = a path Huddle can read):
//   code      a directory level or a file excerpt, with the tasks that touch it
//   drift     does each snippet a task quotes still match the file it quotes?
//   diagrams  PNG files in <repo>/docs/architecture
//   refs      the tasks that touch a path
// plus the plan as Markdown. Extra views can live in src/ext/local/index.ts (gitignored): it exports
// `views: Record<string, (ch, u, repo) => Promise<unknown>>`, and the UI shows a tab for each.
import { readdirSync, statSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { PLUGIN } from "../rt";
import type { Channel, Row } from "../channel";
import { repoTools, type RepoTools } from "./repo";

type View = (ch: Channel, u: URL, repo: RepoTools) => Promise<unknown>;
// the local views live beside the sources (also when the server runs bundled); Node loads index.js,
// or index.ts where it strips types
const LOCAL = [`${PLUGIN}/server/src/ext/local/index.js`, `${PLUGIN}/server/src/ext/local/index.ts`].find(f => existsSync(f));
const local: Record<string, View> = LOCAL ? ((await import(LOCAL).catch(e => { console.error(`local views: ${(e as Error).message}`); return {}; })).views ?? {}) : {};

const BUILTIN = ["code", "drift", "diagrams"];
const driftCache = new Map<string, { at: number; rows: Row[] }>();

// the repo tabs a channel offers (none without a reachable repo)
export function viewNames(ch: Channel): string[] {
  const repo = ch.config().repo;
  return repo && existsSync(repo) ? [...BUILTIN, ...Object.keys(local)] : [];
}

export async function repoRoute(ch: Channel, sub: string, u: URL): Promise<unknown> {
  const cfg = ch.config();
  const R = cfg.repo ? repoTools(cfg.repo) : null;
  if (!R) return { error: cfg.repo ? `repo ${cfg.repo} is not reachable from Huddle` : "this channel has no repo configured" };
  const all = async () => Promise.all((await ch.tasks()).map(async t => (await ch.task(t.id))!));
  const p = u.searchParams.get("path") ?? "";
  switch (sub) {
    case "tree": return R.tree(p);
    case "file": return R.file(p);
    case "code": {
      const full = R.safe(p);
      if (!p || !full) return { missing: true, path: p };
      if (statSync(full).isDirectory()) return { dir: true, path: p, entries: readdirSync(full).filter(n => R.safe(`${p}/${n}`)).sort().slice(0, 200) };
      const text = await readFile(full, "utf8").catch(() => null);
      if (text == null) return { missing: true, path: p };
      const lines = text.split("\n"); const a = u.searchParams.get("anchor");
      let start = 0; if (a) { const i = lines.findIndex(l => l.includes(a)); if (i >= 0) start = Math.max(0, i - 3); }
      return { path: p, from: start + 1, total: lines.length, excerpt: lines.slice(start, start + 80).join("\n") };
    }
    case "refs": {
      const q = p.replace(/\/$/, ""); if (!q) return [];
      return (await all()).filter(r => [...(r.files ?? []), ...(r.snippets ?? []).map((x: Row) => x.path ?? "")].some((f: string) => f && (f === q || f.startsWith(q + "/") || f.replace(/:\d.*$/, "") === q)))
        .map(r => ({ id: r.id, title: r.title, status: r.status }));
    }
    case "drift": {
      const hit = driftCache.get(ch.name);
      if (hit && Date.now() - hit.at < 120_000) return { at: new Date(hit.at).toISOString(), rows: hit.rows };
      const rows = await R.drift(await all());
      driftCache.set(ch.name, { at: Date.now(), rows });
      return { at: new Date().toISOString(), rows };
    }
    case "diagrams": { try { return readdirSync(`${cfg.repo}/docs/architecture`).filter(f => f.endsWith(".png")).sort(); } catch { return []; } }
  }
  if (local[sub]) return local[sub](ch, u, R);
  return { error: `no repo view ${sub}` };
}

export function diagramFile(ch: Channel, name: string) {
  const repo = ch.config().repo;
  if (!repo || !/^[\w.-]+\.png$/.test(name)) return null;
  return `${repo}/docs/architecture/${name}`;
}

// the whole plan as Markdown (effective text + open notes)
export async function exportMd(ch: Channel) {
  const out: string[] = [`# ${ch.config().title}`, "", `Exported ${new Date().toISOString()} from Huddle (channel ${ch.name}).`, ""];
  const tasks = await ch.tasks();
  const full = new Map((await Promise.all(tasks.map(t => ch.task(t.id)))).map(t => [t!.id, t!]));
  const phased = new Set<string>();
  const step = (id: string) => {
    const e = full.get(id)!; phased.add(id);
    out.push(`### ${e.id} ${e.title}`, "", `\`${e.kind}\` · gate \`${e.gate}\` · risk \`${e.risk}\` · status **${e.status}**${e.owner ? ` · owner ${e.owner}` : ""}${Object.keys(e.edited).length ? " · *edited*" : ""}`, "");
    if (e.what) out.push(`**What.** ${e.what}`, "");
    if (e.why) out.push(`**Why.** ${e.why}`, "");
    if (e.alternatives?.length) { out.push("**Not done that way:**", ""); for (const a of e.alternatives) out.push(`- *${a.option}*: ${a.why_not}`); out.push(""); }
    if (e.how?.length) { out.push("**How:**", ""); e.how.forEach((h: string, i: number) => out.push(`${i + 1}. ${h}`)); out.push(""); }
    for (const sn of e.snippets ?? []) out.push(`*${sn.title}*${sn.path ? ` — \`${sn.path}\`` : ""}${sn.proposed ? " (proposed)" : ""}`, "", "```" + (sn.lang || ""), sn.code, "```", "");
    if (e.use) out.push(`**Use.** ${e.use}`, "");
    if (e.verify?.length) { out.push("**Verify:**", ""); for (const v of e.verify) out.push(`- \`${v.cmd}\` → ${v.expect}`); out.push(""); }
    if (e.value) out.push(`**Value.** ${e.value}`, "");
    if (e.rollback) out.push(`**Rollback.** ${e.rollback}`, "");
    const open = (e.comments as Row[]).filter(c => !c.resolved);
    if (open.length) { out.push("**Owner review:**", ""); for (const c of open) out.push(`- [${c.kind}] ${c.body}`); out.push(""); }
  };
  for (const p of await ch.phases() as Row[]) {
    out.push(`## Step ${p.n}: ${p.title}`, "", p.summary || "", "", `- **Needs:** ${p.needs || "-"}`,
      `- **Make:** ${(p.make || []).map((m: string) => "`make " + m + "`").join(", ") || "-"}`, `- **Value:** ${p.value || "-"}`, "");
    for (const s of tasks.filter(x => x.phase_n === p.n)) step(s.id);
  }
  const loose = tasks.filter(t => !phased.has(t.id));
  if (loose.length) { out.push("## Tasks", ""); for (const t of loose) step(t.id); }
  return out.join("\n");
}
