// src/knowledge.ts — knowledge that lasts, on top of the channel's own store (src/channel.ts):
//   verified    a session or the owner vouches for an entry; verified entries come first in recall
//   staleness   every entry shows its age; one older than STALE_DAYS (since written or last verified),
//               or whose referenced files changed since (edited in the channel: src/touches.ts, or
//               a newer file on disk), is marked "may be stale"
//   duplicates  remember finds an existing entry that says the same, and offers to supersede it
//               instead of adding a second one (force adds it anyway)
//   scope       an entry can be for every channel on this server (a tool quirk, a machine fact): it
//               lives in DATA/shared.db, ids from SHARED_BASE up, and every channel's recall finds it
//   export      Markdown grouped by kind, to paste into a project's CLAUDE.md
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { HuddleError, KB_KINDS, OWNER, type Channel, type Row } from "./channel";
import { Store } from "./store";
import { lastEdit } from "./touches";

export const SHARED_BASE = 100000;
export const STALE_DAYS = Number(process.env.HUDDLE_KB_STALE_DAYS) > 0 ? Number(process.env.HUDDLE_KB_STALE_DAYS) : 30;
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const P = (v: any, d: any) => { if (v == null) return d; try { return JSON.parse(v); } catch { return d; } };

// the server-wide store: the knowledge table of one SQLite file, written one call at a time
export class Shared {
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(readonly store: Store) {}
  static async open(file: string) {
    const store = await Store.sqlite(file);
    await store.init();
    // its ids start at SHARED_BASE, so an id says which store holds it
    await store.run("INSERT INTO sqlite_sequence (name, seq) SELECT 'knowledge', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='knowledge')", [SHARED_BASE - 1]);
    return new Shared(store);
  }
  serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.chain.then(fn, fn); this.chain = p.catch(() => {}); return p; }
  close() { return this.store.close(); }
}
const shared = new WeakMap<Channel, Shared>();
export const attachShared = (ch: Channel, s: Shared) => { shared.set(ch, s); };
export const sharedOf = (ch: Channel) => shared.get(ch) ?? null;
const isShared = (id: number) => id >= SHARED_BASE;
const needShared = (ch: Channel) => sharedOf(ch) ?? (() => { throw new HuddleError(400, "this server keeps no server-wide knowledge"); })();
const storeOf = (ch: Channel, id: number) => isShared(id) ? needShared(ch).store : ch.store;
const sharedRetired = async (s: Shared) => new Set((await s.store.all("SELECT supersedes AS id FROM knowledge WHERE supersedes IS NOT NULL")).map(r => r.id as number));

// ── staleness ────────────────────────────────────────────────────────────────
const fileRef = (r: string) => {
  if (/^[a-z][\w+.-]*:\/\//i.test(r) || /^#?\d+$/.test(r) || /\s/.test(r.trim())) return null; // a url, an event seq, prose
  return r.trim().replace(/:\d+(-\d+)?$/, "").replace(/^\.\//, "") || null;
};
async function staleness(ch: Channel, r: Row) {
  const since = [r.created_at, r.verified_at].filter(Boolean).sort().pop() as string;
  const days = Math.floor((Date.now() - Date.parse(r.created_at)) / 86400_000);
  if (Date.now() - Date.parse(since) > STALE_DAYS * 86400_000) return { age_days: days, stale: `not verified for over ${STALE_DAYS} days` };
  const repo = ch.config().repo;
  for (const ref of (P(r.refs, []) as string[]).map(String).map(fileRef).filter(Boolean) as string[]) {
    if (await lastEdit(ch, ref, since)) return { age_days: days, stale: `${ref} was edited since` };
    const f = isAbsolute(ref) ? ref : repo ? `${repo}/${ref}` : null;
    try { if (f && existsSync(f) && statSync(f).mtimeMs > Date.parse(since) + 1000) return { age_days: days, stale: `${ref} changed since` }; } catch {}
  }
  return { age_days: days, stale: null as string | null };
}

// what recall and the dashboard show of an entry
async function shape(ch: Channel, r: Row, hit?: unknown) {
  const s = await staleness(ch, r);
  return { id: r.id as number, kind: r.kind as string, title: r.title as string, by: r.by as string, tags: P(r.tags, []) as string[], refs: P(r.refs, []) as string[],
    task: r.task_id ?? null, created_at: r.created_at as string, hit: hit ?? r.hit ?? String(r.body ?? "").slice(0, 200),
    scope: isShared(r.id) ? "server" : "channel", origin: r.origin ?? null, verified_by: r.verified_by ?? null, verified_at: r.verified_at ?? null, ...s };
}

// ── recall: the channel's entries and the server-wide ones; verified first, then relevance ──
export async function recall(ch: Channel, q: string, o: { kind?: string; tag?: string; by?: string; limit?: number } = {}) {
  const lim = Math.max(1, Math.min(50, o.limit ?? 10));
  const mine = await ch.recall(q, { ...o, limit: 50 });
  const rows = new Map((await Promise.all(mine.map(k => ch.store.get("SELECT * FROM knowledge WHERE id=?", [k.id])))).filter(Boolean).map(r => [r!.id as number, r!]));
  let list = mine.map((k, i) => ({ row: { ...rows.get(k.id), hit: k.hit }, rank: i }));
  const S = sharedOf(ch);
  if (S) {
    const gone = await sharedRetired(S);
    const theirs = q.trim() ? (S.store.fts ? await S.store.searchKnowledge(q.trim(), 60) : await S.store.all(`SELECT *, substr(body,1,200) hit FROM knowledge WHERE ${q.trim().split(/\s+/).slice(0, 8).map(() => "(title LIKE ? OR body LIKE ?)").join(" OR ")} LIMIT 60`, q.trim().split(/\s+/).slice(0, 8).flatMap(w => [`%${w}%`, `%${w}%`])))
      : await S.store.all("SELECT *, substr(body,1,200) hit FROM knowledge ORDER BY id DESC LIMIT 60");
    const ok = theirs.filter(r => !gone.has(r.id) && (!o.kind || r.kind === o.kind) && (!o.by || r.by === o.by || String(r.by).startsWith(o.by + ".")) && (!o.tag || P(r.tags, []).includes(o.tag)));
    // interleave by position: both lists are best first (or newest first without words)
    list = [...list, ...ok.map((row, i) => ({ row, rank: i + 0.5 }))];
    if (!q.trim()) list.sort((a, b) => String(b.row.created_at).localeCompare(String(a.row.created_at)));
    else list.sort((a, b) => a.rank - b.rank);
  }
  list.sort((a, b) => Number(!!b.row.verified_at) - Number(!!a.row.verified_at)); // stable: verified first, order kept within
  return Promise.all(list.slice(0, lim).map(x => shape(ch, x.row)));
}

// ── read one ─────────────────────────────────────────────────────────────────
export async function kb(ch: Channel, id: number) {
  if (!isShared(id)) {
    const k = await ch.kb(id);
    const r = (await ch.store.get("SELECT * FROM knowledge WHERE id=?", [id]))!;
    return { ...k, ...(await shape(ch, r)), body: k.body, hits: k.hits, superseded_by: k.superseded_by, moved_to: r.moved_to ?? null };
  }
  const S = needShared(ch);
  const r = await S.serial(() => S.store.get("UPDATE knowledge SET hits = hits + 1 WHERE id=? RETURNING *", [id]));
  if (!r) throw new HuddleError(404, `no knowledge entry ${id}`);
  const by = await S.store.get("SELECT id FROM knowledge WHERE supersedes=?", [id]);
  return { ...(await shape(ch, r)), body: r.body, hits: r.hits, supersedes: r.supersedes ?? null, superseded_by: by?.id ?? null, moved_to: null };
}

// ── duplicates ───────────────────────────────────────────────────────────────
const words = (s: string) => new Set(String(s).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []);
const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size + b.size - n); };
export async function similar(ch: Channel, k: { title: string; body: string }) {
  const t = words(k.title), b = words(k.body);
  const look = async (store: Store, gone: Set<number>) => (await store.all("SELECT id, kind, title, body, by FROM knowledge ORDER BY id DESC LIMIT 500")).filter(r => !gone.has(r.id));
  const S = sharedOf(ch);
  const rows = [...await look(ch.store, await ch.retired()), ...(S ? await look(S.store, await sharedRetired(S)) : [])];
  let best: { row: Row; score: number } | null = null;
  for (const r of rows) {
    const ts = jaccard(t, words(r.title)), bs = jaccard(b, words(r.body));
    const dup = ts >= 0.75 || (ts >= 0.5 && bs >= 0.5) || bs >= 0.85;
    const score = Math.max(ts, (ts + bs) / 2, bs);
    if (dup && (!best || score > best.score)) best = { row: r, score };
  }
  return best;
}

// ── remember: duplicate check, then the channel's store or the server-wide one ──
type New = { kind: string; title: string; body: string; tags?: string[]; refs?: string[]; task?: string; supersedes?: number; scope?: string; force?: boolean };
export async function remember(ch: Channel, me: string, k: New) {
  if (k.scope && !["channel", "server"].includes(k.scope)) throw new HuddleError(400, "scope: channel (default) or server (every channel on this server)");
  if (!k.force && k.supersedes == null && k.title?.trim() && k.body?.trim()) {
    const d = await similar(ch, k);
    if (d) {
      const r = d.row;
      return { duplicate: true, added: false, existing: { id: r.id as number, kind: r.kind as string, title: r.title as string, by: r.by as string, scope: isShared(r.id) ? "server" : "channel" },
        hint: `#${r.id} [${r.kind}] "${r.title}" (${r.by}) already says this. To replace it, remember again with supersedes=${r.id}; to add yours anyway, force=true; or verify #${r.id} if it is still right.` };
    }
  }
  if (k.supersedes != null && isShared(Number(k.supersedes)) !== (k.scope === "server")) throw new HuddleError(400, `#${k.supersedes} is ${isShared(Number(k.supersedes)) ? "server-wide: supersede it with scope=server" : "this channel's: supersede it without scope=server"}`);
  if (k.scope !== "server") return ch.remember(me, k);
  const S = needShared(ch);
  if (!(KB_KINDS as readonly string[]).includes(k.kind)) throw new HuddleError(400, `kind must be one of ${KB_KINDS.join(", ")}`);
  if (!k.title?.trim() || !k.body?.trim()) throw new HuddleError(400, "need title and body");
  if (k.body.length > 50000) throw new HuddleError(400, "body ≤ 50000 chars; link the rest with refs");
  if (k.supersedes != null && !(await S.store.get("SELECT id FROM knowledge WHERE id=?", [k.supersedes]))) throw new HuddleError(404, `no knowledge entry ${k.supersedes}`);
  if (me !== OWNER && !(await ch.session(me))) throw new HuddleError(404, `"${me}" has not joined channel ${ch.name} (call join first)`);
  const row = await insertShared(S, { by: me, kind: k.kind, title: k.title.trim().slice(0, 200), body: k.body.trim(), tags: k.tags ?? [], refs: k.refs ?? [], supersedes: k.supersedes ?? null, origin: ch.name, created_at: now() });
  await ch.append(me, { topic: "kb.added", ref: `kb:${row.id}`, msg: `[${k.kind}] ${row.title} (every channel)`, data: { kb: row.id, kind: k.kind, tags: k.tags ?? [], scope: "server" } });
  return { ...(await shape(ch, row)), body: row.body, hits: 0, supersedes: row.supersedes ?? null };
}
async function insertShared(S: Shared, k: Row) {
  return S.serial(() => S.store.tx(async q => {
    const row = (await q.get(`INSERT INTO knowledge (by, kind, title, body, tags, refs, supersedes, created_at, origin, verified_by, verified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
      [k.by, k.kind, k.title, k.body, JSON.stringify(k.tags), JSON.stringify(k.refs), k.supersedes, k.created_at, k.origin, k.verified_by ?? null, k.verified_at ?? null]))!;
    await S.store.indexKnowledge(q, row, k.tags);
    return row;
  }));
}

// ── verify: anyone in the channel (or the owner) vouches for an entry, or takes that back ──
export async function verify(ch: Channel, me: string, id: number, undo = false) {
  const store = storeOf(ch, id), run = isShared(id) ? needShared(ch).serial.bind(needShared(ch)) : ch.serial.bind(ch);
  const r = await run(() => store.get(`UPDATE knowledge SET verified_by=?, verified_at=? WHERE id=? RETURNING *`, undo ? [null, null, id] : [me, now(), id]));
  if (!r) throw new HuddleError(404, `no knowledge entry ${id}`);
  await ch.append(me, { topic: "kb.verified", ref: `kb:${id}`, msg: `${undo ? "unverified" : "verified"} [${r.kind}] ${r.title}`, data: { kb: id, verified: !undo } });
  return shape(ch, r);
}

// ── share: a channel entry becomes one for every channel on this server ──
export async function share(ch: Channel, me: string, id: number) {
  if (isShared(id)) throw new HuddleError(400, `#${id} is already for every channel`);
  const S = needShared(ch);
  const r = await ch.store.get("SELECT * FROM knowledge WHERE id=?", [id]);
  if (!r) throw new HuddleError(404, `no knowledge entry ${id}`);
  if (r.moved_to) return kb(ch, r.moved_to);
  if ((await ch.retired()).has(id)) throw new HuddleError(400, `#${id} was superseded: share the entry that replaced it`);
  const row = await insertShared(S, { by: r.by, kind: r.kind, title: r.title, body: r.body, tags: P(r.tags, []), refs: P(r.refs, []), supersedes: null, origin: ch.name,
    created_at: r.created_at, verified_by: r.verified_by, verified_at: r.verified_at });
  await ch.serial(() => ch.store.run("UPDATE knowledge SET moved_to=? WHERE id=?", [row.id, id]));
  await ch.append(me, { topic: "kb.shared", ref: `kb:${row.id}`, msg: `[${r.kind}] ${r.title} is now for every channel (#${id} → #${row.id})`, data: { kb: row.id, from: id } });
  return { ...(await shape(ch, row)), body: row.body, from: id };
}

// ── export: Markdown for a project's CLAUDE.md, grouped by kind ──
const HEAD: Record<string, string> = { lesson: "Lessons", howto: "How-tos", fact: "Facts", decision: "Decisions", context: "Context", result: "Results" };
export async function exportMarkdown(ch: Channel, o: { verified?: boolean } = {}) {
  const S = sharedOf(ch);
  const live = async (store: Store, gone: Set<number>) => (await store.all("SELECT * FROM knowledge ORDER BY id")).filter(r => !gone.has(r.id) && (!o.verified || r.verified_at));
  const rows = [...await live(ch.store, await ch.retired()), ...(S ? await live(S.store, await sharedRetired(S)) : [])];
  const L = [`## Team knowledge (Huddle channel "${ch.config().title}")`, "",
    `<!-- exported from Huddle ${now()}${o.verified ? ", verified entries only" : ""}: ${rows.length} entr${rows.length === 1 ? "y" : "ies"} -->`, ""];
  if (!rows.length) L.push(o.verified ? "_Nothing verified yet._" : "_Nothing remembered yet._", "");
  for (const kind of Object.keys(HEAD)) {
    const of = rows.filter(r => r.kind === kind);
    if (!of.length) continue;
    L.push(`### ${HEAD[kind]}`, "");
    for (const r of of) {
      const refs = (P(r.refs, []) as string[]).filter(Boolean);
      const body = String(r.body).trim().split("\n");
      const tail = [refs.length ? `see ${refs.map(x => `\`${x}\``).join(", ")}` : "", isShared(r.id) ? "every channel" : ""].filter(Boolean).join("; ");
      L.push(`- **${String(r.title).replace(/\*/g, "\\*")}**${body.length === 1 ? `: ${body[0]}` : ""}${tail ? ` (${tail})` : ""}`);
      if (body.length > 1) for (const l of body) L.push(l.trim() ? `  ${l}` : "");
    }
    L.push("");
  }
  return L.join("\n").replace(/\n{3,}/g, "\n\n");
}
