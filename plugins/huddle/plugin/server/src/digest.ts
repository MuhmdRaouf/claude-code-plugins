// src/digest.ts — what happened in a channel since a moment, per session: tasks finished, notes
// written, knowledge added, approval requests; plus what is blocked now and the questions still
// open. Built from the stored events and tables only (no model calls); the estimated cost per
// session comes from Radar when it runs (src/radar.ts), else it is left out.
// The dashboard's Today view, `huddle digest [--since 24h]` and the MCP tool `digest` show it.
import { HuddleError, OWNER, parentOf, type Channel, type Row } from "./channel";
import { costBySession } from "./radar";
import { links } from "./links";

const P = (v: any, d: any = null) => { if (v == null) return d; try { return JSON.parse(v); } catch { return d; } };
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
const MAX_MS = 90 * 86_400_000;

/** "24h", "90m", "7d", "2w", seconds, or an ISO date → epoch ms (default: 24 hours ago). */
export function parseSince(v: unknown, now = Date.now()): number {
  const s = String(v ?? "").trim();
  if (!s) return now - 86_400_000;
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw]?)$/i.exec(s);
  if (m) {
    const ms = Number(m[1]) * ({ "": 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as Record<string, number>)[m[2].toLowerCase()];
    return now - Math.min(ms, MAX_MS);
  }
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(t, now - MAX_MS);
  throw new HuddleError(400, `since: 24h, 90m, 7d or an ISO date, not ${s}`);
}
const rangeFor = (ms: number): "day" | "week" | "month" => ms <= 86_400_000 * 1.01 ? "day" : ms <= 7 * 86_400_000 * 1.01 ? "week" : "month";

type Sess = { name: string; state: string | null; role: string | null; done: Row[]; notes: Row[]; knowledge: Row[]; approvals: Row[]; asked: number; events: number; cost: number | null };

export async function digest(ch: Channel, since?: unknown, o: { cost?: boolean } = {}) {
  const now = Date.now(), from = parseSince(since, now), at = iso(from);
  const [events, tasks, notes, sessions, open] = await Promise.all([
    ch.store.all("SELECT * FROM events WHERE ts >= ? ORDER BY seq LIMIT 50000", [at]),
    ch.tasks(),
    ch.store.all("SELECT task_id, kind, body, by, created_at FROM notes WHERE created_at >= ? ORDER BY id", [at]),
    ch.sessions(),
    ch.store.all(`SELECT e.* FROM events e WHERE e.needs_reply = 1 AND NOT EXISTS (SELECT 1 FROM events r WHERE r.reply_to = e.seq) ORDER BY e.seq`),
  ]);
  const byId = new Map(tasks.map(t => [t.id, t]));
  const top = (n: string) => parentOf(n) ?? n;
  const live = new Map(sessions.map(s => [s.name, s]));
  const per = new Map<string, Sess>();
  const S = (n: string): Sess => {
    const k = top(n);
    let s = per.get(k);
    if (!s) { const x = live.get(k); per.set(k, s = { name: k, state: x?.state ?? (k === OWNER ? null : "left"), role: x?.role ?? null, done: [], notes: [], knowledge: [], approvals: [], asked: 0, events: 0, cost: null }); }
    return s;
  };
  for (const s of sessions) if (!s.parent && s.state !== "left") S(s.name);

  const kbIds: number[] = [];
  const finished = new Map<string, Row>(); // task id → its last done/skipped, so a task done twice counts once
  for (const r of events) {
    const s = S(r.from_name), d = P(r.data, {}) ?? {};
    s.events++;
    if (r.topic === "task.status" && (d.status === "done" || d.status === "skipped")) {
      const t = byId.get(r.ref ?? d.task);
      finished.set(String(r.ref ?? d.task), { who: s.name, id: r.ref ?? d.task, title: t?.title ?? null, status: d.status, note: String(d.note ?? "").slice(0, 300), at: r.ts, now: t?.status ?? null });
    } else if (r.topic === "kb.added" && d.kb != null) { s.knowledge.push({ id: d.kb, kind: d.kind ?? null, title: null, at: r.ts }); kbIds.push(Number(d.kb)); }
    else if (r.topic === "approval.request") s.approvals.push({ seq: r.seq, labels: Array.isArray(d.labels) ? d.labels : [], at: r.ts });
  }
  for (const f of finished.values()) if (f.now == null || f.now === f.status) S(f.who).done.push({ id: f.id, title: f.title, status: f.status, note: f.note, at: f.at });
  if (kbIds.length) {
    const rows = await ch.store.all(`SELECT id, kind, title FROM knowledge WHERE id IN (${kbIds.map(() => "?").join(",")})`, kbIds);
    const t = new Map(rows.map(r => [r.id, r]));
    for (const s of per.values()) for (const k of s.knowledge) { const r = t.get(Number(k.id)); if (r) { k.title = r.title; k.kind = r.kind; } }
  }
  for (const n of notes) S(n.by ?? OWNER).notes.push({ task: n.task_id, title: byId.get(n.task_id)?.title ?? null, kind: n.kind, body: String(n.body).slice(0, 300), at: n.created_at });

  const questions = open.map(r => ({ seq: r.seq as number, from: r.from_name as string, to: (r.to_name ?? null) as string | null, msg: String(r.msg ?? "").slice(0, 300), at: r.ts as string, task: P(r.data, {})?.task ?? null }));
  for (const q of questions) if (per.has(top(q.from))) per.get(top(q.from))!.asked++;
  const blocked = tasks.filter(t => t.status === "blocked").map(t => ({ id: t.id, title: t.title, owner: t.owner, waits_on: t.blocked_by }));
  const notesOf = new Map((await ch.store.all("SELECT id, status_note FROM tasks WHERE status='blocked'")).map(r => [r.id, r.status_note]));
  for (const b of blocked as Row[]) b.note = notesOf.get(b.id) ?? "";

  // estimated cost per session: Radar's per-Claude-session spend, folded onto Huddle names
  let cost: { available: boolean; total: number | null; range: string } = { available: false, total: null, range: rangeFor(now - from) };
  if (o.cost !== false) {
    const m = await costBySession(cost.range as any);
    if (m) {
      const L = await links(ch);
      let total = 0;
      for (const [cid, usd] of m) { const n = L.get(cid); if (!n) continue; const s = S(n); s.cost = (s.cost ?? 0) + usd; total += usd; }
      cost = { ...cost, available: true, total };
    }
  }
  const order = (s: Sess) => (s.name === OWNER ? 1 : 0);
  const list = [...per.values()].filter(s => s.events || s.notes.length || s.state && s.state !== "left" || s.cost)
    .sort((a, b) => order(a) - order(b) || (b.done.length + b.knowledge.length) - (a.done.length + a.knowledge.length) || b.events - a.events || a.name.localeCompare(b.name));
  return {
    channel: ch.name, title: ch.config().title, since: at, until: iso(now),
    totals: { done: list.reduce((n, s) => n + s.done.length, 0), notes: notes.length, knowledge: kbIds.length, events: events.length, blocked: blocked.length, questions: questions.length,
      approvals: list.reduce((n, s) => n + s.approvals.length, 0) },
    sessions: list, blocked, questions, cost,
  };
}

const usd = (n: number) => n >= 100 ? `$${n.toFixed(0)}` : n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : "$0";
export function digestText(r: Row) {
  const T = r.totals;
  const L = [`digest: ${r.title} · since ${r.since}`,
    `${T.done} task${T.done === 1 ? "" : "s"} finished · ${T.knowledge} knowledge · ${T.notes} note${T.notes === 1 ? "" : "s"} · ${T.blocked} blocked · ${T.questions} open question${T.questions === 1 ? "" : "s"}${r.cost.available ? ` · est. cost ${usd(r.cost.total ?? 0)} (radar, this ${r.cost.range})` : ""}`];
  for (const s of r.sessions as Row[]) {
    L.push("", `${s.name === OWNER ? "owner (you)" : s.name}${s.state ? ` (${s.state})` : ""}${s.cost != null ? ` · est. ${usd(s.cost)}` : ""} · ${s.events} event${s.events === 1 ? "" : "s"}`);
    for (const d of s.done) L.push(`  ${d.status === "skipped" ? "skipped" : "done"} ${d.id}${d.title ? ` ${d.title}` : ""}${d.note ? ` — ${d.note.slice(0, 120)}` : ""}`);
    for (const k of s.knowledge) L.push(`  kb #${k.id} [${k.kind ?? "?"}] ${k.title ?? ""}`);
    for (const n of s.notes.slice(0, 8)) L.push(`  note on ${n.task} [${n.kind}] ${n.body.replace(/\s+/g, " ").slice(0, 100)}`);
    if (s.notes.length > 8) L.push(`  … ${s.notes.length - 8} more notes`);
    if (s.approvals.length) L.push(`  asked permission ${s.approvals.length}×: ${[...new Set(s.approvals.flatMap((a: Row) => a.labels))].join(", ")}`);
    if (!s.done.length && !s.knowledge.length && !s.notes.length && !s.approvals.length) L.push("  nothing finished or shared");
  }
  if (r.blocked.length) { L.push("", "blocked now:"); for (const b of r.blocked) L.push(`  ${b.id} ${b.title}${b.owner ? ` @${b.owner}` : ""}${b.note ? ` — ${b.note.slice(0, 120)}` : ""}${b.waits_on?.length ? ` (waits on ${b.waits_on.join(", ")})` : ""}`); }
  if (r.questions.length) { L.push("", "open questions:"); for (const q of r.questions.slice(0, 20)) L.push(`  #${q.seq} ${q.from} → ${q.to ?? "everyone"}: ${q.msg.replace(/\s+/g, " ").slice(0, 140)}`); }
  return L.join("\n");
}
