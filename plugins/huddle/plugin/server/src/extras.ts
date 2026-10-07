// src/extras.ts — what the server adds around a channel for the owner, in one place:
//   needs-you notifications  every channel the hub opens is watched; a question to the owner, a session
//                            someone paused, an approval request and a blocked task notify the desktop
//                            (src/notify.ts), as the event happens
//   approval rules           per channel switches (src/rules.ts; channel meta approval_rules); the
//                            PreToolUse hook (hooks/approve.ts) posts a command that could match, and
//                            a match on a rule that is on records an approval.request event
//   session links            which Claude session ids are which Huddle session (from the SessionStart
//                            join and the approval hook), so Observatory's per-Claude-session alerts
//                            and costs land on Huddle names
//   observatory              its alerts for this channel's sessions and the cost per session
// Routes (under /api/c/<ch>/x/…): GET rules · POST rules (owner) · POST approval (a session) ·
// GET approvals · POST approvals/dismiss (owner) · GET observatory · GET digest[?since=24h];
// and GET|POST /api/settings ({notify}) for the whole server.
import { HuddleError, NAME_RE, OWNER, parentOf, type Channel, type Ev, type Row } from "./channel";
import type { Hub } from "./hub";
import { Notifier } from "./notify";
import { RULES, DEFAULTS, effective, matching } from "./rules";
import { alerts, costBySession } from "./observatory";
import { digest } from "./digest";
import { link, links } from "./links";
export { link, links };

const P = (v: any, d: any = null) => { if (v == null) return d; try { return JSON.parse(v); } catch { return d; } };
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");

// ── approval rules ───────────────────────────────────────────────────────────
export const rulesOf = (ch: Channel) => effective(P(ch.meta("approval_rules"), {}));
export const rulesList = (ch: Channel) => { const on = rulesOf(ch); return RULES.map(r => ({ id: r.id, label: r.label, help: r.help, on: on[r.id], default: DEFAULTS[r.id] })); };
export async function setRules(ch: Channel, patch: Row) {
  if (!patch || typeof patch !== "object") throw new HuddleError(400, "rules: {<rule id>: true|false}");
  const cur = rulesOf(ch);
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) throw new HuddleError(400, `no approval rule ${k} (rules: ${Object.keys(DEFAULTS).join(", ")})`);
    if (typeof v !== "boolean") throw new HuddleError(400, `rule ${k}: true or false`);
    cur[k] = v;
  }
  await ch.serial(() => ch.setMeta("approval_rules", JSON.stringify(cur)));
  return rulesList(ch);
}

/** A session is about to run a command: if a rule that is on matches, record the request and say ask. */
export async function approval(ch: Channel, as: string, b: Row) {
  if (!as || as === OWNER || !NAME_RE.test(as)) throw new HuddleError(400, "say which session asks: ?as=<session>");
  if (!(await ch.session(as))) throw new HuddleError(404, `"${as}" has not joined channel ${ch.name}`);
  void link(ch, as, b.claude_session);
  const on = rulesOf(ch);
  const hit = matching(String(b.command ?? "")).filter(r => on[r.id]);
  if (!hit.length) return { ask: false };
  const labels = hit.map(r => r.label);
  // the command itself is never stored, logged or shown: it may hold a secret
  const ev = await ch.append(as, { topic: "approval.request", to: OWNER, msg: `${as} asks permission: ${labels.join(", ")}`, data: { rules: hit.map(r => r.id), labels } });
  return { ask: true, rules: hit.map(r => r.id), labels, event: ev.seq,
    reason: `Huddle (channel ${ch.name}): the owner asked to approve ${labels.join(" and ").toLowerCase()} — allow only if this is intended.` };
}

// the approval requests of the last day the owner has not dismissed
export async function approvals(ch: Channel) {
  const cleared = Number(ch.meta("approvals_cleared") ?? 0), dismissed = new Set(P(ch.meta("approvals_dismissed"), []) as number[]);
  const rows = await ch.store.all("SELECT * FROM events WHERE topic='approval.request' AND seq > ? AND ts >= ? ORDER BY seq DESC LIMIT 50", [cleared, iso(Date.now() - 86_400_000)]);
  return rows.filter(r => !dismissed.has(r.seq)).map(r => { const d = P(r.data, {}) ?? {}; return { seq: r.seq as number, from: r.from_name as string, ts: r.ts as string, rules: d.rules ?? [], labels: d.labels ?? [] }; });
}
export async function dismiss(ch: Channel, b: Row) {
  await ch.serial(async () => {
    if (b.all) await ch.setMeta("approvals_cleared", String(await ch.lastSeq()));
    else {
      const seq = Number(b.seq);
      if (!Number.isInteger(seq) || seq <= 0) throw new HuddleError(400, "dismiss: {seq} or {all: true}");
      const d = (P(ch.meta("approvals_dismissed"), []) as number[]).filter(Number.isInteger);
      await ch.setMeta("approvals_dismissed", JSON.stringify([...new Set([...d, seq])].slice(-300)));
    }
  });
  return { approvals: await approvals(ch) };
}

// ── observatory, for this channel ────────────────────────────────────────────
export async function observatory(ch: Channel) {
  const [al, cost] = await Promise.all([alerts(), costBySession("day")]);
  if (al === null && cost === null) return { available: false };
  const L = await links(ch);
  const byName: Record<string, number> = {};
  let total = 0;
  for (const [cid, usd] of cost ?? []) { const n = L.get(cid); if (n) { byName[n] = (byName[n] ?? 0) + usd; total += usd; } }
  return {
    available: true, range: "day",
    alerts: (al ?? []).filter(a => L.has(a.sessionId)).map(a => ({ id: a.id, kind: a.kind, session: L.get(a.sessionId)!, agent: a.agentId, since: a.since, detail: a.detail.slice(0, 300), cost: a.costUsd })),
    cost: cost ? byName : null, total: cost ? total : null,
  };
}

// ── needs-you notifications ──────────────────────────────────────────────────
/** What an event means for the owner's desktop, or null: names and ids only, never a message body. */
export function needsYou(e: Ev, channel: string): { kind: string; subject: string; title: string; body: string } | null {
  if (!e || e.from === OWNER) return null;
  const title = `Huddle · ${channel}`;
  if (e.needs_reply && (e.to == null || e.to === OWNER))
    return { kind: "ask", subject: `${channel}/${e.from}`, title, body: `${e.from} asks you a question${e.data?.task ? ` about task ${e.data.task}` : ""}` };
  if (e.topic === "control.pause" && e.to)
    return { kind: "pause", subject: `${channel}/${e.to}`, title, body: `${e.to} was paused by ${e.from}` };
  if (e.topic === "approval.request")
    return { kind: "approval", subject: `${channel}/${e.from}/${(e.data?.rules ?? []).join(",")}`, title,
      body: `${e.from} asks permission: ${(e.data?.labels ?? []).join(", ") || "a command"}. Answer in its Claude Code window.` };
  if (e.topic === "task.status" && e.data?.status === "blocked")
    return { kind: "blocked", subject: `${channel}/${e.ref}`, title, body: `Task ${e.ref} is blocked (${e.from})` };
  return null;
}
const watched = new WeakSet<Channel>();
export function watch(ch: Channel, n: Notifier) {
  if (watched.has(ch)) return;
  watched.add(ch);
  ch.subscribe(m => { if (m.type !== "event") return; const x = needsYou(m.data, ch.config().title || ch.name); if (x) n.send(x.kind, x.subject, x.title, x.body); });
}
/** Every channel the hub opens is watched (once). */
export function watchHub(hub: Hub, n: Notifier) {
  const get = hub.get.bind(hub);
  hub.get = async (name: string, create?: boolean) => { const ch = await (create === undefined ? get(name) : get(name, create)); watch(ch, n); return ch; };
}

// ── routes ───────────────────────────────────────────────────────────────────
type Body = () => Promise<Row>;
/** /api/c/<ch>/x/<rest>: null when the path is not ours. */
export async function route(ch: Channel, rest: string, req: Request, u: URL, as: string, body: Body): Promise<unknown | null> {
  const owner = () => { if (as !== OWNER) throw new HuddleError(403, "only the owner changes this (the dashboard, or ?as=owner)"); };
  const post = req.method === "POST";
  if (rest === "rules" && !post) return { rules: rulesList(ch) };
  if (rest === "rules" && post) { owner(); return { rules: await setRules(ch, (await body()).rules ?? {}) }; }
  if (rest === "approval" && post) return approval(ch, as, await body());
  if (rest === "approvals" && !post) return { approvals: await approvals(ch) };
  if (rest === "approvals/dismiss" && post) { owner(); return dismiss(ch, await body()); }
  if (rest === "observatory" && !post) return observatory(ch);
  if (rest === "digest" && !post) return digest(ch, u.searchParams.get("since") ?? undefined);
  if (rest === "link" && post) { const b = await body(); await link(ch, as, b.claude_session); return { ok: true }; }
  return null;
}
/** GET|POST /api/settings: the server-wide switches (notifications). */
export async function settings(req: Request, n: Notifier, me: { name: string }, body: Body) {
  if (req.method === "POST") {
    if (me.name !== OWNER) throw new HuddleError(403, "only the owner (the dashboard, or the session that started Huddle) changes settings");
    const b = await body();
    if (typeof b.notify !== "boolean") throw new HuddleError(400, "settings: {notify: true|false}");
    return n.set(b.notify);
  }
  return n.state();
}
