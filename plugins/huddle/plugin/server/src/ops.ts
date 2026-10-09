// src/ops.ts — every operation a session (or the owner) can perform, once. The HTTP API
// (POST /api/c/<channel>/op/<name>), the MCP tools and the `huddle` CLI are all this table, so
// they cannot drift. Each op names its JSON schema, whether it can block, and how it renders
// as text for an agent's context.
import * as K from "./knowledge";
import { touched } from "./touches";
import { Channel, OWNER, NAME_RE, HuddleError, STATES, STATUSES, NOTE_KINDS, KB_KINDS, CONTEXTS, type Row } from "./channel";
import { digest, digestText } from "./digest";

type Ctx = { ch: Channel; me: string; signal?: AbortSignal; waitDefault: number };
type Op = { desc: string; props: Row; required?: string[]; blocks?: boolean; owner?: boolean; run: (c: Ctx, a: Row) => unknown; text?: (r: any, c: Ctx) => string };

const s = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const i = (description?: string) => ({ type: "integer", ...(description ? { description } : {}) });
const b = (description?: string) => ({ type: "boolean", ...(description ? { description } : {}) });
const arr = (description?: string) => ({ type: "array", items: { type: "string" }, ...(description ? { description } : {}) });
const en = (vals: readonly string[], description?: string) => ({ type: "string", enum: vals, ...(description ? { description } : {}) });
const timeout = (c: Ctx, a: Row) => Math.max(0, Math.min(3600, Number(a.timeout ?? c.waitDefault)));

export const OPS: Record<string, Op> = {
  join: { desc: "Join the channel (or resume). Returns who else is here, the turn, your pause state, your inbox, your next task and the latest shared knowledge, plus either your unread events (context sync) or a brief instead of the backlog (context fresh). Call first.",
    props: { role: s("one line: what you do here"), label: s(), task: s("what you are doing now"),
      context: en(CONTEXTS, "sync: everything unread since you left; fresh: skip the backlog, get a brief (open asks are kept). Omit it: fresh on a first join, else what the orchestrator set for you, else sync") },
    run: (c, a) => c.ch.join(c.me, { role: a.role, label: a.label, task: a.task, context: a.context }), text: r => snapText(r) },
  status: { desc: "The same picture as join, without changing presence.", props: {}, run: c => c.ch.snapshot(c.me), text: r => snapText(r) },
  leave: { desc: "Leave the channel when your work is finished (subagents: always, with a one-line summary).", props: { summary: s() }, run: (c, a) => c.ch.leave(c.me, a.summary ?? "") },
  sessions: { desc: "Every session and subagent: state, task, pause, unread, open asks, who holds the turn.", props: {}, run: c => c.ch.sessions() },
  state: { desc: "Say what you are doing (shown live to the owner and the other sessions).", props: { state: en(STATES), task: s(), step: s("task id") }, required: ["state"],
    run: (c, a) => c.ch.presence(c.me, { state: a.state, task: a.task, step: a.step }) },

  publish: { desc: "Publish an event on the channel (to everyone, or to one session with `to`). Durable; wakes whoever waits on the topic. key makes a retry idempotent.",
    props: { topic: s("e.g. finding.ready, build.ready"), msg: s(), to: s("one session; omit for everyone"), ref: s("file or id the event is about"), data: { type: "object" }, ask: b("needs a reply: lands in the recipient's inbox"), key: s("idempotency key") },
    required: ["topic", "msg"], run: (c, a) => c.ch.publish(c.me, { topic: a.topic, msg: a.msg, to: a.to, ref: a.ref, data: a.data, needs_reply: a.ask, key: a.key }) },
  send: { desc: "Message one session (to) or everyone. ask=true needs a reply: it sits in their inbox and wakes their wait until they answer.",
    props: { to: s("session name; omit for everyone"), msg: s(), ask: b(), task: s("task id it is about"), key: s() }, required: ["msg"],
    run: (c, a) => c.ch.send(c.me, a.to ?? null, a.msg, { ask: a.ask, task: a.task, key: a.key }) },
  reply: { desc: "Answer a message (by seq). Closes it in your inbox.", props: { seq: i(), msg: s() }, required: ["seq", "msg"], run: (c, a) => c.ch.reply(c.me, Number(a.seq), a.msg) },
  inbox: { desc: "Messages waiting for your reply (asks from sessions, the owner's directives).", props: {}, run: c => c.ch.inbox(c.me) },
  events: { desc: "Read the channel history (newest last).", props: { after: i(), limit: i(), topic: s("glob"), from: s() }, run: (c, a) => c.ch.events({ after: a.after, limit: a.limit, topic: a.topic, from: a.from }) },
  wait: { desc: "Block until (1) a message needs your reply → kind=message, (2) the first unread event for you (to you or to everyone) matching a topic glob → kind=event (handle it and its skipped list, which includes messages between other sessions, then ack its seq), or (3) timeout → call wait again. Use this to stop and listen while another session works.",
    props: { topics: arr("globs, e.g. task.ready build.* turn.pass; empty = any"), timeout: i("seconds; omit it: the default waits as long as the transport allows, and a timeout only means call wait again") }, blocks: true,
    run: (c, a) => c.ch.wait(c.me, a.topics ?? [], timeout(c, a), c.signal) },
  ack: { desc: "Mark everything up to seq as handled (your cursor; never moves back).", props: { seq: i() }, required: ["seq"], run: (c, a) => c.ch.ack(c.me, Number(a.seq)) },
  gate: { desc: "Check the pause. block=true (default) waits until you are resumed. Call before any action that changes things; while paused, publish/task changes are refused.",
    props: { block: b(), timeout: i() }, blocks: true,
    run: async (c, a) => a.block === false ? { control: await c.ch.controlOf(c.me) } : c.ch.gate(c.me, Number(a.timeout ?? 0), c.signal) },
  pause: { desc: "Pause another session (it stops at its next gate; its writes are refused until resume).", props: { target: s(), why: s() }, required: ["target"], run: (c, a) => c.ch.control(c.me, a.target, "pause", a.why) },
  resume: { desc: "Resume a paused session.", props: { target: s(), why: s() }, required: ["target"], run: (c, a) => c.ch.control(c.me, a.target, "resume", a.why) },

  turn: { desc: "Who holds the turn (in ping-pong work only the holder acts), and the event that gave it.", props: {}, run: c => c.ch.turn() },
  pass: { desc: "Hand the turn to another session, with what it should do next.", props: { to: s(), msg: s() }, required: ["to"], run: (c, a) => c.ch.passTurn(c.me, a.to, a.msg) },
  take: { desc: "Take the turn (only when the owner asked you to, or the channel works in parallel).", props: { msg: s() }, run: (c, a) => c.ch.takeTurn(c.me, a.msg) },

  next: { desc: "Your next task in plan order (yours or unowned): what, why, how, checks, the owner's notes (they override the text). ready=false lists what it waits on: wait for task.ready.",
    props: { json: b() }, run: c => c.ch.next(c.me), text: (r, c) => r.done ? "every task you can take is done or skipped" : taskText(r, c.ch.name) },
  task: { desc: "One task as the owner sees it.", props: { id: s(), json: b() }, required: ["id"],
    run: async (c, a) => (await c.ch.task(a.id)) ?? (() => { throw new HuddleError(404, `no task ${a.id}`); })(), text: (r, c) => taskText(r, c.ch.name) },
  map: { desc: "The big picture, when you need it: each phase's progress, what every session does now and next, and the critical path (the longest chain of unfinished dependencies).", props: { json: b() },
    run: c => c.ch.map(), text: r => mapText(r) },
  tasks: { desc: "The plan as a list (filter by owner, status, phase).", props: { owner: s(), status: en(STATUSES), phase: i() },
    run: (c, a) => c.ch.tasks({ owner: a.owner, status: a.status, phase: a.phase }),
    text: (r: Row[]) => r.map(t => `${t.id} [${t.status}]${t.owner ? ` @${t.owner}` : ""} ${t.title}${t.blocked_by.length ? `  ⟵ waits on ${t.blocked_by.join(", ")}` : ""}`).join("\n") || "(no tasks)" },
  task_create: { desc: "Create a task, optionally for another session (owner) and after other tasks (after): that session gets task.created now and task.ready when the dependencies finish.",
    props: { title: s(), owner: s(), after: arr("task ids it waits on"), id: s(), phase: i(), what: s(), how: arr(), verify: arr() }, required: ["title"],
    run: (c, a) => c.ch.createTask(c.me, { id: a.id, title: a.title, owner: a.owner, after: a.after, phase: a.phase, body: { what: a.what ?? "", how: a.how ?? [], verify: (a.verify ?? []).map((v: string) => ({ cmd: v, expect: "" })) } }) },
  task_update: { desc: "Reassign (owner), change dependencies (after; cycles are refused) or edit a field (field + value; null restores the plan's text).",
    props: { id: s(), owner: s(), after: arr(), field: s(), value: {} }, required: ["id"],
    run: (c, a) => c.ch.updateTask(c.me, a.id, { owner: a.owner, after: a.after, field: a.field, value: a.value }), text: (r, c) => taskText(r, c.ch.name) },
  task_status: { desc: "Move a task: doing (refused while it waits on unfinished tasks), done (with evidence in note: releases the tasks waiting on it), blocked (why), skipped.",
    props: { id: s(), status: en(STATUSES), note: s("evidence or reason") }, required: ["id", "status"], run: (c, a) => c.ch.setStatus(c.me, a.id, a.status, a.note ?? "") },
  wait_task: { desc: "Block until a task (usually another session's) is done or skipped.", props: { id: s(), timeout: i("seconds; omit it") }, required: ["id"], blocks: true,
    run: (c, a) => c.ch.waitTask(c.me, a.id, timeout(c, a), c.signal) },
  note: { desc: "Add a review note to a task.", props: { id: s(), kind: en(NOTE_KINDS), body: s() }, required: ["id", "kind", "body"], run: (c, a) => c.ch.note(c.me, a.id, a.kind, a.body), text: (r, c) => taskText(r, c.ch.name) },

  // ── workflows: the common moves in one call each (fewer turns, fewer tokens) ──
  start: { desc: "Start work: checks the pause, takes the task (id, or your next one), marks it doing and returns its full text. If it still waits on other tasks, says on which and does not start it: then call wait with topics [\"task.ready\"].",
    props: { id: s("task id; omit for your next task") },
    run: async (c, a) => {
      if (await c.ch.controlOf(c.me) === "pause") return { started: false, paused: true, hint: "paused: call gate" };
      const t = a.id ? await c.ch.task(a.id) : await c.ch.next(c.me);
      if (!t) throw new HuddleError(404, `no task ${a.id}`);
      if (t.done) return { started: false, done: true };
      if (!t.ready) return { started: false, task: t, hint: `waits on ${t.unmet.map((u: Row) => `${u.id} (${u.owner ?? "unowned"}, ${u.status})`).join(", ")}: wait with topics ["task.ready"]` };
      if (t.status !== "doing") await c.ch.setStatus(c.me, t.id, "doing");
      await c.ch.presence(c.me, { state: "working", task: `${t.id} ${t.title}`, step: t.id });
      return { started: true, task: await c.ch.task(t.id) };
    },
    text: (r, c) => r.paused ? "PAUSED: call gate before any work" : r.done ? "every task you can take is done or skipped" : `${r.started ? "STARTED" : `NOT STARTED: ${r.hint}`}\n\n${taskText(r.task, c.ch.name)}` },
  finish: { desc: "Finish a task: marks it done with your evidence (note), optionally shares its output as a result others can recall, and returns what it released and your next task.",
    props: { id: s("omit for the task you are doing"), note: s("evidence: command + result"), result: s("output another task needs (stored as knowledge kind=result)"), title: s("title for that result") }, required: ["note"],
    run: async (c, a) => {
      const id = a.id ?? await c.ch.current(c.me);
      if (!id) throw new HuddleError(400, "no task in progress: pass id");
      const before = await c.ch.lastSeq();
      await c.ch.setStatus(c.me, id, "done", a.note);
      const released = (await c.ch.events({ after: before, topic: "task.ready" })).map(e => ({ task: e.ref, to: e.to }));
      const t = (await c.ch.task(id))!;
      const kb = a.result ? await c.ch.remember(c.me, { kind: "result", title: a.title ?? `${id} ${t.title}`, body: a.result, task: id }) : null;
      const n = await c.ch.next(c.me);
      await c.ch.presence(c.me, { state: "working", task: `finished ${id}`, step: null });
      return { done: id, released, knowledge: kb?.id ?? null, next: n.done ? null : { id: n.id, title: n.title, ready: n.ready, unmet: n.unmet?.map((u: Row) => u.id) } };
    } },
  depend: { desc: "You need another session's work before yours can go on: creates a task for that session, makes your task wait on it, marks yours blocked, then blocks until it is released (task.ready) — one call instead of four.",
    props: { owner: s("the session that must do it"), title: s("what they must do"), what: s("details"), id: s("your task; omit for the one you are doing"), wait: b("default true"), timeout: i("seconds; omit it") }, required: ["owner", "title"], blocks: true,
    run: async (c, a) => {
      const mine = a.id ?? await c.ch.current(c.me);
      if (!mine) throw new HuddleError(400, "no task in progress: pass id");
      const t = (await c.ch.createTask(c.me, { title: a.title, owner: a.owner, body: { what: a.what ?? "" } })).task!;
      const cur = (await c.ch.task(mine))!;
      await c.ch.updateTask(c.me, mine, { after: [...new Set([...(cur.depends as string[]), t.id])] });
      await c.ch.setStatus(c.me, mine, "blocked", `waits on ${t.id} (${a.owner}): ${a.title}`);
      if (a.wait === false) return { created: t.id, blocked: mine, waiting: false };
      const h = await c.ch.wait(c.me, ["task.ready"], timeout(c, a), c.signal);
      return { created: t.id, blocked: mine, woke: h, hint: h.kind === "event" ? `ack ${h.seq}, then start ${mine}` : "call wait with topics [\"task.ready\"]" };
    } },
  handoff: { desc: "Hand the work to another session in one call: optionally creates a task for it (title, after), passes the turn with your message, then waits for your next wake-up (unless wait=false).",
    props: { to: s(), msg: s("what they should do next"), title: s("create a task for them with this title"), after: arr("their task waits on these"), topics: arr("what to wait for afterwards; default turn.pass task.ready"), wait: b("default true"), timeout: i("seconds; omit it") }, required: ["to", "msg"], blocks: true,
    run: async (c, a) => {
      const task = a.title ? (await c.ch.createTask(c.me, { title: a.title, owner: a.to, after: a.after })).task!.id : null;
      const ev = await c.ch.passTurn(c.me, a.to, a.msg);
      if (a.wait === false) return { passed: ev.seq, task };
      const h = await c.ch.wait(c.me, a.topics ?? ["turn.pass", "task.ready"], timeout(c, a), c.signal);
      return { passed: ev.seq, task, woke: h };
    } },
  ask_wait: { desc: "Ask one session a question and block until it replies (the answer comes back as the result).",
    props: { to: s(), msg: s(), timeout: i("seconds; omit it") }, required: ["to", "msg"], blocks: true,
    run: async (c, a) => {
      const q = await c.ch.send(c.me, a.to, a.msg, { ask: true });
      const h = await c.ch.waitReply(c.me, q.seq, timeout(c, a), c.signal);
      return h.kind === "event" ? { asked: q.seq, answer: (h as Row).msg, from: (h as Row).from, seq: (h as Row).seq } : { asked: q.seq, ...h, hint: "no reply yet: the ask stays open; wait again later" };
    } },

  remember: { desc: "Share what you learned so no other session or subagent pays for it again: fact, lesson, decision (with why), context (summary of what you read), result (output of finished work), howto (commands that work). supersedes retires an older entry. If an entry already says the same, nothing is added and you get its id: supersede it, verify it, or pass force. scope=server: for every channel on this server (tool quirks, machine facts).",
    props: { kind: en(KB_KINDS), title: s("one line, searchable"), body: s(), tags: arr(), refs: arr("files, urls, event seqs (a file that changes later marks the entry may be stale)"), task: s(), supersedes: i(),
      scope: en(["channel", "server"], "channel (default) or server: every channel on this server"), force: b("add it even if a similar entry exists") }, required: ["kind", "title", "body"],
    run: (c, a) => K.remember(c.ch, c.me, { kind: a.kind, title: a.title, body: a.body, tags: a.tags, refs: a.refs, task: a.task, supersedes: a.supersedes, scope: a.scope, force: !!a.force }),
    text: (r: Row) => r.duplicate ? `not added: ${r.hint}` : `#${r.id} remembered: ${r.title}` },
  recall: { desc: "Search the shared knowledge (this channel's and the entries for every channel) before reading files or re-deriving anything. Verified entries come first; each shows its age, and \"may be stale\" when it is old or its files changed. Returns titles and snippets; read one with kb.",
    props: { q: s("words; empty = latest"), kind: en(KB_KINDS), tag: s(), by: s(), limit: i() },
    run: (c, a) => K.recall(c.ch, a.q ?? "", { kind: a.kind, tag: a.tag, by: a.by, limit: a.limit }),
    text: (r: Row[]) => r.map(k => `#${k.id} [${k.kind}] ${k.title} — ${k.by}${kbFlags(k)}${k.tags.length ? ` {${k.tags.join(",")}}` : ""}\n   ${String(k.hit ?? "").replace(/\s+/g, " ").slice(0, 240)}`).join("\n") || "(nothing yet: remember what you learn)" },
  kb: { desc: "Read one knowledge entry in full.", props: { id: i() }, required: ["id"], run: (c, a) => K.kb(c.ch, Number(a.id)),
    text: (k: Row) => `#${k.id} [${k.kind}] ${k.title}\nby ${k.by} · ${k.created_at}${kbFlags(k)}${k.task ? ` · task ${k.task}` : ""}${k.superseded_by ? ` · SUPERSEDED by #${k.superseded_by}` : ""}${k.moved_to ? ` · now for every channel as #${k.moved_to}` : ""}\n${k.tags.length ? `tags: ${k.tags.join(", ")}\n` : ""}${k.refs.length ? `refs: ${k.refs.join(", ")}\n` : ""}\n${k.body}` },
  verify: { desc: "Vouch for a knowledge entry you checked is still right (verified entries come first in recall; verifying also clears \"may be stale\"). undo=true takes it back.",
    props: { id: i(), undo: b() }, required: ["id"], run: (c, a) => K.verify(c.ch, c.me, Number(a.id), !!a.undo),
    text: (k: Row) => `#${k.id} ${k.verified_at ? `verified by ${k.verified_by}` : "no longer verified"}: ${k.title}` },
  share: { desc: "Make one of this channel's knowledge entries one for every channel on this server (a tool quirk, a machine fact); it gets a new id.",
    props: { id: i() }, required: ["id"], run: (c, a) => K.share(c.ch, c.me, Number(a.id)),
    text: (k: Row) => `#${k.id} is for every channel now${k.from ? ` (was #${k.from})` : ""}: ${k.title}` },
  digest: { desc: "What happened since a moment (default: the last 24 h), per session: tasks finished, notes, knowledge added, approval requests; what is blocked now and the questions still open; and the estimated cost per session when the Radar plugin runs. Built from the channel's history, no model calls.",
    props: { since: s("24h, 90m, 7d or an ISO date; default 24h"), json: b() }, run: (c, a) => digest(c.ch, a.since), text: r => digestText(r) },
};

// ops that run the plan: the owner's, and the channel's orchestrator's (config `orchestrator`).
// Only the owner changes who the orchestrator is and who may join (members).
export const OWNER_OPS: Record<string, Op> = {
  configure: { desc: "Owner or orchestrator: configure the channel: title, description, start (who holds the turn first), handover ({sender: {to, topics}}), profile, repo; the owner only: members, orchestrator.",
    props: { title: s(), description: s(), start: s(), handover: { type: "object" }, profile: s(), repo: s(), members: arr("who may join; empty = anyone"), orchestrator: s("the session that runs the plan with the owner; empty = none") }, owner: true,
    run: (c, a) => {
      if (c.me !== OWNER && (a.members !== undefined || a.orchestrator !== undefined)) throw new HuddleError(403, "only the owner changes members and the orchestrator");
      return c.ch.configure(a);
    } },
  import_plan: { desc: "Owner or orchestrator: load a plan {phases:[{n,title,…,steps:[{id,title,owner,depends,…}]}]}; merged by task id, keeping status, edits and notes.", props: { plan: { type: "object" }, owner: s("owner of steps that name none") }, required: ["plan"], owner: true,
    run: (c, a) => c.ch.importPlan(c.me, a.plan, { owner: a.owner }) },
  approve: { desc: "Owner or orchestrator: approve a gated task (owner / ask-first): a note on it and a message to its owner.", props: { id: s(), msg: s() }, required: ["id"], owner: true, run: (c, a) => c.ch.approve(a.id, a.msg ?? "", c.me) },
  note_edit: { desc: "Owner or orchestrator: resolve, edit or remove a note.", props: { id: i(), resolved: b(), body: s(), remove: b() }, required: ["id"], owner: true, run: (c, a) => c.ch.editNote(Number(a.id), a) },
  assign: { desc: "Owner or orchestrator: how a session joins when it returns (context sync or fresh; null = sync), and optionally a task it now owns.",
    props: { session: s(), context: { type: ["string", "null"], enum: [...CONTEXTS, null] }, task: s("task id to give the session") }, required: ["session"], owner: true,
    run: (c, a) => c.ch.assign(c.me, a.session, a.context ?? null, a.task) },
  brief: { desc: "Owner or orchestrator: what a session gets on its next fresh join instead of the history (kept until then; also sent now as a message).",
    props: { session: s(), msg: s() }, required: ["session", "msg"], owner: true, run: (c, a) => c.ch.brief(c.me, a.session, a.msg) },
};

// Who may act as whom: a connection is one session; it may act for its own subagents
// ("<me>.<role>") by passing `as`. The owner may act as anyone (the UI speaks for the owner).
export function identity(conn: string, as?: unknown) {
  if (as == null || as === "" || as === conn) return conn;
  const a = String(as);
  if (!NAME_RE.test(a) && a !== OWNER) throw new HuddleError(400, `bad identity ${a}`);
  if (conn === OWNER || a.startsWith(conn + ".")) return a;
  throw new HuddleError(403, `${conn} may act only as itself or its subagents (${conn}.<role>), not ${a}`);
}

// ops the hooks call, not tools an agent sees
const HOOK_OPS: Record<string, Op> = {
  touched: { desc: "The PostToolUse hook: this session edited a file (path relative to its repo).", props: { path: s(), repo: s() }, required: ["path", "repo"],
    run: (c, a) => touched(c.ch, c.me, a), text: r => r.warn ?? "" },
};
// a knowledge entry's marks, for an agent's context
const kbFlags = (k: Row) => [k.age_days != null ? ` · ${k.age_days ? `${k.age_days}d old` : "today"}` : "", k.verified_at ? ` · verified (${k.verified_by})` : "",
  k.scope === "server" ? " · every channel" : "", k.stale ? ` · MAY BE STALE: ${k.stale}` : ""].join("");

export async function runOp(name: string, ch: Channel, conn: string, args: Row, o: { signal?: AbortSignal; waitDefault?: number } = {}) {
  const op = OPS[name] ?? OWNER_OPS[name] ?? HOOK_OPS[name];
  if (!op) throw new HuddleError(404, `no operation ${name}`);
  const { as, ...a } = args ?? {};
  const me = identity(conn, as);
  if (op.owner && me !== OWNER && me !== ch.config().orchestrator) throw new HuddleError(403, `${name} is the owner's or the orchestrator's`);
  for (const r of op.required ?? []) if (a[r] === undefined || a[r] === null || a[r] === "") throw new HuddleError(400, `${name}: missing ${r}`);
  if (name !== "join") await ch.touch(me);
  const ctx: Ctx = { ch, me, signal: o.signal, waitDefault: o.waitDefault ?? 240 };
  const result = await op.run(ctx, a);
  return { result, text: op.text && !a.json ? op.text(result, ctx) : null };
}

// the tool list for MCP: every op (the plan ops answer 403 unless you are the orchestrator), plus
// `as` for acting as one of your subagents
export function toolDefs() {
  return Object.entries({ ...OPS, ...OWNER_OPS }).map(([name, op]) => ({
    name, description: op.desc,
    inputSchema: { type: "object", properties: { ...op.props, as: s("act as one of your subagents: <you>.<role> (join it first)") }, ...(op.required?.length ? { required: op.required } : {}) },
  }));
}

// ── text renderings for an agent's context ────────────────────────────────────
export function snapText(r: Row) {
  const L = [`channel ${r.channel} · you are ${r.me} · ${r.control === "run" ? "running" : "PAUSED: call gate before any work"}`,
    `turn: ${r.turn.holder ?? "free (parallel)"}${r.turn.since ? ` (since #${r.turn.since.seq} ${r.turn.since.from} ${r.turn.since.topic})` : ""}`];
  if (r.orchestrator) L.push(`orchestrator: ${r.orchestrator}${r.orchestrator === r.me ? " (you: you run the plan with the owner)" : ""}`);
  if (r.context) L.push(r.context === "fresh" ? `context: fresh (${r.skipped} earlier events skipped; asks kept)` : "context: sync (everything unread since you left)");
  if (r.brief) {
    const b = r.brief;
    L.push(`brief: ${b.title}${b.goal ? ` · ${b.goal}` : ""}`);
    if (b.from_orchestrator) L.push(`from ${b.from_orchestrator.by} (${b.from_orchestrator.at}): ${b.from_orchestrator.msg}`);
    L.push(`your tasks: ${b.tasks.length ? "" : "none"}${b.tasks.map((t: Row) => `\n  ${t.id} [${t.status}] ${t.title}${t.ready ? "" : ` (waits on ${t.waits_on.join(", ")})`}`).join("")}`);
    if (b.knowledge.length) L.push(`relevant knowledge (kb <id> to read):${b.knowledge.map((k: Row) => `\n  #${k.id} [${k.kind}] ${k.title} (${k.by})`).join("")}`);
  }
  L.push(`others: ${r.sessions.length ? r.sessions.map((x: Row) => `${x.name}${x.control === "pause" ? "(paused)" : ""} ${x.state}${x.task ? ": " + x.task : ""}${x.stale ? " [stale]" : ""}`).join(" · ") : "none yet"}`);
  L.push(`inbox: ${r.inbox.length}${r.inbox.map((m: Row) => `\n  #${m.seq} from ${m.from}: ${m.msg}`).join("")}`);
  L.push(`unread: ${r.unread_total}${r.unread_total ? " → " + r.unread.slice(-12).map((e: Row) => `#${e.seq} ${e.from}${e.to ? `→${e.to}` : ""} ${e.topic}`).join(", ") : ""}`);
  if (r.next) L.push(`next task: ${r.next.id} ${r.next.title}${r.next.ready ? "" : ` (waits on ${r.next.unmet.map((u: Row) => `${u.id}@${u.owner ?? "?"}:${u.status}`).join(", ")})`}`);
  if (r.knowledge) L.push(`knowledge: ${r.knowledge.total} entries${r.knowledge.latest.length ? "\n  " + r.knowledge.latest.join("\n  ") : ""} — recall before you read or re-derive`);
  return L.join("\n");
}

// the map in about 40 lines at most
export function mapText(r: Row) {
  const L = [`map: ${r.title} · ${r.done}/${r.total} tasks done${r.orchestrator ? ` · orchestrator ${r.orchestrator}` : ""}`, "phases:"];
  const ph = r.phases as Row[];
  const first = Math.max(0, ph.findIndex(p => p.done < p.total)); // from the first unfinished phase on
  const shown = ph.length > 14 ? ph.slice(first, first + 12) : ph;
  if (shown[0] !== ph[0] && first > 0) L.push(`  … ${first} finished phase(s)`);
  for (const p of shown) L.push(`  ${String(p.n ?? "-").padStart(3)} ${p.done === p.total ? "✓" : " "} ${p.done}/${p.total}  ${p.title}`);
  const after = ph.length - (ph.indexOf(shown[shown.length - 1]) + 1);
  if (after > 0) L.push(`  … ${after} more phase(s)`);
  L.push("sessions:");
  for (const s of (r.sessions as Row[]).slice(0, 10)) L.push(`  ${s.name} (${s.state}): ${s.current ? `doing ${s.current.id} ${s.current.title}` : "nothing in progress"}${s.next ? ` · next ${s.next.id}${s.next.ready ? "" : " (waits)"}` : ""}`);
  const cp = r.critical_path as Row[];
  L.push(`critical path (${cp.length} open task${cp.length === 1 ? "" : "s"} in a chain): ${cp.length ? "" : "none"}`);
  for (const t of cp.slice(0, 10)) L.push(`  ${t.id} [${t.status}]${t.owner ? ` @${t.owner}` : ""} ${t.title}`);
  if (cp.length > 10) L.push(`  … ${cp.length - 10} more`);
  return L.join("\n");
}

export function taskText(t: Row, channel: string) {
  const L: string[] = [];
  const gate = t.gate && t.gate !== "none" ? ` · gate ${t.gate}` : "";
  L.push(`${t.id}  ${t.title}`, `${t.kind ?? "task"}${t.risk ? ` · ${t.risk} risk` : ""}${gate} · ${t.status}${t.owner ? ` · owner ${t.owner}` : " · unowned"}${t.status_by ? ` (last by ${t.status_by})` : ""}`);
  if (t.unmet?.length) L.push(`WAITS ON: ${t.unmet.map((u: Row) => `${u.id} (${u.owner ?? "unowned"}, ${u.status})`).join(", ")} → wait with topics ["task.ready"] or wait_task`);
  const notes = t.open_notes ?? [];
  if (notes.length) L.push("", "OWNER NOTES (read first; they override the text below):", ...notes.map((c: Row) => `  [${c.kind}] ${c.body}${c.by && c.by !== "owner" ? ` — ${c.by}` : ""}`));
  if (Object.keys(t.edited ?? {}).length) L.push(`(edited: ${Object.keys(t.edited).join(", ")})`);
  if (t.what) L.push("", "WHAT", t.what);
  if (t.why) L.push("", "WHY", t.why);
  if (t.alternatives?.length) L.push("", "NOT THAT WAY", ...t.alternatives.map((a: Row) => `  - ${a.option}: ${a.why_not}`));
  if (t.how?.length) L.push("", "HOW", ...t.how.map((h: string, n: number) => `  ${n + 1}. ${h}`));
  for (const sn of t.snippets ?? []) L.push("", `CODE: ${sn.title}${sn.path ? ` (${sn.path})` : ""}${sn.proposed ? " [proposed]" : ""}`, ...String(sn.code).split("\n").map((x: string) => "    " + x));
  if (t.verify?.length) L.push("", "CHECK", ...t.verify.map((v: Row) => `  $ ${v.cmd}${v.expect ? `\n    → ${v.expect}` : ""}`));
  if (t.value) L.push("", "DONE MEANS", t.value);
  if (t.use) L.push("", "USE", t.use);
  if (t.rollback) L.push("", "ROLLBACK", t.rollback);
  if (t.depends?.length) L.push("", `depends on ${t.depends.join(", ")}`);
  if (t.needed_by?.length) L.push(`needed by ${t.needed_by.join(", ")}`);
  L.push("", `board: /#/c/${channel}/t/${t.id}`);
  return L.join("\n");
}
