// src/channel.ts — one channel: its own SQLite file (src/store.ts),
// its sessions, their events, the turn, the owner's (and each other's) pause, messages that need
// a reply, and a plan of tasks that can depend on each other across sessions.
//
// Every public method is async. The server process is the only writer of a channel: writes run
// one at a time per channel (serial), each multi-statement write is one transaction, and every
// wake-up is in-process. A waiter registers first, then queries; any commit that could satisfy
// it pokes it to query again. Nothing polls, and no wake-up falls between a query and the
// registration.
//
// Visibility: a session sees an event when it did not send it and the event is addressed to it
// or to everyone (to_name NULL). Each session has one cursor over what it sees; ack moves it.
import { AsyncLocalStorage } from "node:async_hooks";
import { Store, type Q, type Row } from "./store";

export type { Row };
export type Ev = {
  seq: number; ts: string; from: string; to: string | null; topic: string; ref: string | null;
  msg: string | null; data: any; reply_to: number | null; needs_reply: boolean;
};
export type Live = { ch: string; type: string; data: any; at: string };
export type WaitHit = { kind: "event" | "message" | "timeout" | "cancelled"; [k: string]: unknown };

export const OWNER = "owner";
// a session is "<name>"; a subagent working for it joins as "<name>.<role>" (one level)
export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}(\.[a-z0-9][a-z0-9_-]{0,31})?$/;
export const parentOf = (n: string) => n.includes(".") ? n.slice(0, n.indexOf(".")) : null;
export const TOPIC_RE = /^[a-z][a-z0-9_.*-]{0,63}$/;
export const STATES = ["working", "waiting", "paused", "idle", "blocked", "left"] as const;
export const KB_KINDS = ["fact", "lesson", "decision", "context", "result", "howto"] as const;
export const STATUSES = ["todo", "doing", "done", "blocked", "skipped"] as const;
export const NOTE_KINDS = ["note", "change", "optimize", "enhance", "direction", "question"] as const;
export const CONTEXTS = ["sync", "fresh"] as const;
type Context = typeof CONTEXTS[number];
const FINISHED = new Set(["done", "skipped"]);
// words too common to say what a session's role or task is about
const STOP = new Set("the and for with from that this into what when then than have has are was were will not but you your our its any all each per via use uses using".split(" "));
export const PRESENCE_STALE_S = 900;

export class HuddleError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const bad = (m: string) => new HuddleError(400, m);
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const J = (v: unknown) => v == null ? null : JSON.stringify(v);
const P = (v: any, d: any = null) => { if (v == null) return d; try { return JSON.parse(v); } catch { return d; } };
const COUNT = "CAST(COUNT(*) AS INTEGER)";

export function globMatch(topic: string, globs: string[]) {
  if (!globs.length) return true;
  return globs.some(g => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(topic));
}

// the fields of a task body that the plan view knows how to show; anything else is kept too
export const JSON_FIELDS = ["alternatives", "how", "snippets", "verify", "files", "refs"];
export const TEXT_FIELDS = ["what", "why", "use", "value", "rollback", "notes", "kind", "gate", "risk"];
const EDITABLE = new Set(["title", ...JSON_FIELDS, ...TEXT_FIELDS]);

// the channels whose write lock the current async call chain holds (a write may call another)
const held = new AsyncLocalStorage<Set<Channel>>();

export class Channel {
  private waiters = new Set<{ poke: () => void }>();
  private listeners = new Set<(m: Live) => void>();
  private seen = new Map<string, number>(); // last_seen writes, throttled
  private metaC = new Map<string, string>(); // meta, read once: this process is the only writer
  private metaP = new Map<string, string | null>(); // meta written by the open transaction
  private chain: Promise<unknown> = Promise.resolve();
  private pending: Ev[] = [];

  private constructor(readonly name: string, readonly store: Store) {}
  get fts() { return this.store.fts; }
  static async open(name: string, store: Store) {
    await store.init();
    const c = new Channel(name, store);
    for (const r of await store.all("SELECT key, value FROM meta")) c.metaC.set(r.key, r.value);
    if (!c.meta("created_at")) await c.serial(() => c.setMeta("created_at", now()));
    return c;
  }
  async close() {
    this.cancelAll();
    await this.chain.catch(() => {});
    await this.store.close();
  }
  private cancels = new Set<() => void>();
  private cancelAll() { for (const c of [...this.cancels]) c(); }

  // ── writes: one at a time per channel; a write called from a write runs inline ──
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const mine = held.getStore();
    if (mine?.has(this)) return fn();
    const run = () => held.run(new Set([...(mine ?? []), this]), fn);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
  // one transaction; meta and live events it produced take effect only when it commits
  private async tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    try {
      const r = await this.store.tx(fn);
      for (const [k, v] of this.metaP) v == null ? this.metaC.delete(k) : this.metaC.set(k, v);
      this.metaP.clear();
      return r;
    } catch (e) { this.metaP.clear(); this.pending = []; throw e; }
  }

  // ── meta and config ─────────────────────────────────────────────────────────
  meta(k: string): string | null { return this.metaP.has(k) ? this.metaP.get(k)! : this.metaC.get(k) ?? null; }
  async setMeta(k: string, v: string | null, q: Q = this.store) {
    if (v == null) await q.run("DELETE FROM meta WHERE key=?", [k]);
    else await q.run("INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
    if (q !== this.store) this.metaP.set(k, v);
    else if (v == null) this.metaC.delete(k); else this.metaC.set(k, v);
  }
  // handover: {sender: {to, topics[]}} — publishing one of these topics passes the turn to `to`
  config() {
    return {
      title: this.meta("title") ?? this.name, description: this.meta("description") ?? "",
      start: this.meta("turn_start"), handover: P(this.meta("handover"), {}) as Record<string, { to: string; topics: string[] }>,
      profile: this.meta("profile"), repo: this.meta("repo"), created_at: this.meta("created_at"),
      // who may join; empty = any local session. A member's subagents (<member>.<role>) may always join.
      members: P(this.meta("members"), []) as string[],
      // the session that runs the plan with the owner: import_plan, configure, approve, assign, brief
      orchestrator: this.meta("orchestrator"),
    };
  }
  configure(c: Row) {
    return this.serial(async () => {
      if (c.start !== undefined && c.start && !NAME_RE.test(c.start)) throw bad("bad start");
      if (c.handover !== undefined)
        for (const [k, v] of Object.entries<any>(c.handover ?? {})) if (!NAME_RE.test(k) || !NAME_RE.test(v?.to ?? "") || !Array.isArray(v.topics)) throw bad("handover: {sender: {to, topics[]}}");
      if (c.orchestrator !== undefined && c.orchestrator && (!NAME_RE.test(c.orchestrator) || c.orchestrator.includes("."))) throw bad("orchestrator: a session name (not a subagent)");
      if (c.members !== undefined && (!Array.isArray(c.members) || c.members.some((m: unknown) => typeof m !== "string" || !NAME_RE.test(m) || m.includes(".")))) throw bad("members: session names");
      if (c.title != null) await this.setMeta("title", String(c.title).slice(0, 120));
      if (c.description != null) await this.setMeta("description", String(c.description).slice(0, 2000));
      if (c.start !== undefined) await this.setMeta("turn_start", c.start || null);
      if (c.handover !== undefined) await this.setMeta("handover", JSON.stringify(c.handover ?? {}));
      if (c.profile !== undefined) await this.setMeta("profile", c.profile || null);
      if (c.members !== undefined) await this.setMeta("members", JSON.stringify(c.members));
      if (c.repo !== undefined) await this.setMeta("repo", c.repo || null);
      if (c.orchestrator !== undefined) await this.setMeta("orchestrator", c.orchestrator || null);
      this.emit("channel", this.config());
      return this.config();
    });
  }

  // ── live fan-out (UI, stdio bridges) and waiters ────────────
  subscribe(f: (m: Live) => void) { this.listeners.add(f); return () => this.listeners.delete(f); }
  emit(type: string, data: any) {
    const m: Live = { ch: this.name, type, data, at: new Date().toISOString() };
    for (const f of this.listeners) try { f(m); } catch {}
  }
  // every waiter queries again, outside the write lock
  private wake() { held.exit(() => { for (const w of [...this.waiters]) w.poke(); }); }
  // Register, then query; a poke while a query runs makes it query once more. onMiss runs once,
  // when the first query finds nothing. The promise settles once: hit, timeout or cancel.
  private block(check: () => Promise<WaitHit | null>, timeoutS: number, signal?: AbortSignal, onMiss?: () => void): Promise<WaitHit> {
    return new Promise((res, rej) => {
      let done = false, busy = false, again = false, first = true;
      let tm: ReturnType<typeof setTimeout> | null = null;
      const end = () => { done = true; this.waiters.delete(w); this.cancels.delete(ab); if (tm) clearTimeout(tm); signal?.removeEventListener("abort", ab); };
      const finish = (h: WaitHit) => { if (done) return; end(); res(h); };
      const poke = async () => {
        if (done) return;
        if (busy) { again = true; return; }
        busy = true;
        try {
          do {
            again = false;
            const h = await check();
            if (done) return;
            if (h) return finish(h);
            if (first) { first = false; onMiss?.(); }
          } while (again);
        } catch (e) { if (!done) { end(); rej(e); } }
        finally { busy = false; }
      };
      const w = { poke };
      const ab = () => finish({ kind: "cancelled" });
      this.waiters.add(w);
      this.cancels.add(ab);
      if (timeoutS > 0) tm = setTimeout(() => finish({ kind: "timeout" }), timeoutS * 1000);
      if (signal) { if (signal.aborted) return ab(); signal.addEventListener("abort", ab); }
      poke();
    });
  }
  // a wait that marks the session's presence while it sleeps, and restores it afterwards
  private async sleep(name: string, check: () => Promise<WaitHit | null>, timeoutS: number, signal: AbortSignal | undefined,
    asleep: () => Promise<{ state: string; task: string }>, awake: (h: WaitHit) => Promise<void>) {
    let marked: Promise<unknown> | null = null;
    const h = await this.block(check, timeoutS, signal, () => { marked = asleep().then(p => this.presence(name, p)).catch(() => {}); });
    if (marked) await marked;
    await awake(h);
    return h;
  }

  // ── sessions ────────────────────────────────────────────────────────────────
  session(name: string): Promise<Row | null> { return this.store.get("SELECT * FROM sessions WHERE name=?", [name]); }
  private async need(name: string) {
    if (name === OWNER) return { name, control: "run", cursor: 0 } as Row;
    const s = await this.session(name);
    if (!s) throw new HuddleError(404, `"${name}" has not joined channel ${this.name} (call join first)`);
    return s;
  }
  async touch(name: string) {
    if (name === OWNER) return;
    const t = Date.now();
    if (t - (this.seen.get(name) ?? 0) < 5000) return;
    this.seen.set(name, t);
    await this.serial(() => this.store.run("UPDATE sessions SET last_seen=? WHERE name=?", [now(), name]));
  }
  // context: "sync" reads on from the session's cursor; "fresh" moves the cursor to the present
  // and returns a brief instead (open asks are kept either way). Default: fresh for a subagent and
  // for a session's first join; on a return, the orchestrator's setting for it (assign), else sync.
  async join(name: string, o: { label?: string; role?: string; task?: string; context?: string | null } = {}) {
    if (!NAME_RE.test(name) || name === OWNER || name === "all") throw bad(`session name must match ${NAME_RE} and not be owner/all`);
    if (o.context && !(CONTEXTS as readonly string[]).includes(o.context)) throw bad(`context must be one of ${CONTEXTS.join(", ")}`);
    return this.serial(async () => {
      const parent = parentOf(name);
      if (parent && !(await this.session(parent))) throw bad(`${parent} must join before its subagent ${name}`);
      const members = this.config().members;
      if (members.length && !members.includes(parent ?? name)) throw new HuddleError(403, `channel ${this.name} admits ${members.join(", ")} (the owner adds members)`);
      const prev = await this.session(name);
      const mode = (o.context || (parent || !prev ? "fresh" : prev.context ?? "sync")) as Context;
      const t = now();
      await this.store.run(`INSERT INTO sessions (name, label, role, joined_at, last_seen, state, task, parent) VALUES (?,?,?,?,?, 'working', ?, ?)
        ON CONFLICT(name) DO UPDATE SET label=COALESCE(excluded.label, sessions.label), role=COALESCE(excluded.role, sessions.role),
        last_seen=excluded.last_seen, state='working', task=excluded.task`, [name, o.label ?? null, o.role ?? null, t, t, o.task ?? "joined", parent]);
      // what the session missed: skipped when it starts fresh, to catch up on when it syncs
      const skipped = (await this.store.get(`SELECT ${COUNT} n FROM events WHERE seq > ? AND from_name != ?`, [prev?.cursor ?? 0, name]))!.n as number;
      // every start is on the timeline, with how the session came in
      await this.append(name, { topic: "session.joined", msg: `${name} ${prev && prev.state !== "left" ? "returned" : "joined"}${o.role ? ": " + o.role : ""}`,
        data: { context: mode, skipped, returning: !!prev && prev.state !== "left" } });
      let brief: Row | null = null;
      if (mode === "fresh") {
        // the backlog is skipped, the cursor moves to the present, the stored brief is used once
        const s = (await this.session(name))!;
        await this.store.run("UPDATE sessions SET cursor=?, brief=NULL WHERE name=?", [await this.lastSeq(), name]);
        brief = await this.briefFor(name, o.role ?? s.role, P(s.brief));
      }
      this.emit("presence", await this.presenceOf(name));
      return this.snapshot(name, { context: mode, skipped, brief });
    });
  }
  // a subagent (or a session) is done: it stays in the history, out of the live views
  leave(name: string, summary = "") {
    return this.serial(async () => {
      await this.need(name);
      await this.append(name, { topic: "session.left", msg: summary ? `${name} left: ${summary}` : `${name} left` });
      return this.presence(name, { state: "left", task: summary || "left" });
    });
  }
  presence(name: string, p: { state?: string; task?: string; step?: string | null }) {
    return this.serial(async () => {
      await this.need(name);
      if (p.state && !(STATES as readonly string[]).includes(p.state)) throw bad(`state must be one of ${STATES.join(", ")}`);
      const step = p.step !== undefined ? ", step=?" : "";
      await this.store.run(`UPDATE sessions SET state=COALESCE(?, state), task=COALESCE(?, task), last_seen=?${step} WHERE name=?`,
        [p.state ?? null, p.task ?? null, now(), ...(step ? [p.step ?? null] : []), name]);
      this.seen.set(name, Date.now());
      const out = await this.presenceOf(name);
      this.emit("presence", out);
      return out;
    });
  }
  private shape(s: Row) {
    const age = (Date.now() - Date.parse(s.last_seen)) / 1000;
    return { name: s.name as string, parent: (s.parent ?? null) as string | null, label: s.label, role: s.role, state: s.state as string, task: s.task, step: s.step, last_seen: s.last_seen as string,
      stale: age > PRESENCE_STALE_S, control: s.control as string, control_by: s.control_by, control_at: s.control_at, cursor: s.cursor as number, context: (s.context ?? null) as string | null, brief_waiting: !!s.brief };
  }
  // the orchestrator (or the owner) sets how a session's next return joins, and can hand it a task
  assign(by: string, session: string, context: string | null, task?: string) {
    return this.serial(async () => {
      await this.need(session);
      if (context != null && !(CONTEXTS as readonly string[]).includes(context)) throw bad(`context must be one of ${CONTEXTS.join(", ")} or null`);
      if (task) await this.updateTask(by, task, { owner: session });
      await this.store.run("UPDATE sessions SET context=? WHERE name=?", [context ?? null, session]);
      this.emit("presence", await this.presenceOf(session));
      return { session, context: context ?? null, task: task ?? null };
    });
  }
  // a brief for a session's next fresh join (kept until then; a newer one replaces it), sent now as a msg too
  brief(by: string, session: string, msg: string) {
    return this.serial(async () => {
      await this.need(session);
      if (!msg?.trim() || msg.length > 20000) throw bad("need msg (≤ 20000 chars)");
      const at = now();
      await this.store.run("UPDATE sessions SET brief=? WHERE name=?", [JSON.stringify({ msg: msg.trim(), by, at }), session]);
      const ev = await this.append(by, { topic: "msg", to: session, msg: msg.trim(), data: { brief: true } });
      return { session, stored: true, event: ev.seq };
    });
  }
  // what a fresh join gets instead of the backlog: the channel's goal, the orchestrator's brief, the
  // session's own open tasks with what they wait on, the 5 knowledge entries nearest to its role
  // and task, and every open ask
  private async briefFor(name: string, role: string | null, stored: Row | null) {
    const cfg = this.config();
    const mine = (await this.tasks({ owner: name })).filter(t => !FINISHED.has(t.status));
    const n = await this.next(name);
    const focus = mine.find(t => t.status === "doing") ?? (n.done ? mine[0] : n);
    const full = focus ? await this.task(focus.id) : null;
    return {
      title: cfg.title, goal: cfg.description, orchestrator: cfg.orchestrator,
      from_orchestrator: stored,
      tasks: mine.map(t => ({ id: t.id, title: t.title, status: t.status, ready: !t.blocked_by.length, waits_on: t.blocked_by })),
      knowledge: await this.relevant([role ?? "", full?.title ?? "", full?.what ?? ""].join(" "), 5),
      asks: (await this.inbox(name)).map(e => ({ seq: e.seq, from: e.from, msg: e.msg, task: e.data?.task ?? null })),
    };
  }
  // entries recall never shows: superseded ones, and ones moved to the server-wide store (src/knowledge.ts)
  async retired() {
    return new Set((await this.store.all("SELECT supersedes AS id FROM knowledge WHERE supersedes IS NOT NULL UNION SELECT id FROM knowledge WHERE moved_to IS NOT NULL")).map(r => r.id as number));
  }
  // knowledge nearest to some text: full-text matches best first (most hits on ties), then the
  // most-read entries; superseded entries never
  private async relevant(text: string, k: number) {
    const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])].filter(w => !STOP.has(w)).slice(0, 16);
    const retired = await this.retired();
    const hits = words.length && this.fts ? (await this.store.searchKnowledge(words.join(" "), k * 4)).filter(r => !retired.has(r.id)) : [];
    hits.sort((a, b) => (Math.round((b.score - a.score) * 1e6)) || b.hits - a.hits);
    const out = hits.slice(0, k);
    if (out.length < k) for (const r of await this.store.all("SELECT *, substr(body,1,200) hit FROM knowledge ORDER BY hits DESC, id DESC LIMIT ?", [k * 4]))
      if (out.length < k && !retired.has(r.id) && !out.some(x => x.id === r.id)) out.push(r);
    return out.map(r => ({ id: r.id as number, kind: r.kind as string, title: r.title as string, by: r.by as string, hits: r.hits as number, hit: r.hit }));
  }
  async presenceOf(name: string) { const s = await this.session(name); return s ? this.shape(s) : null; }
  async sessions() {
    const turn = await this.turn();
    const rows = await this.store.all("SELECT * FROM sessions ORDER BY joined_at, name");
    return Promise.all(rows.map(async s => {
      const [u, o] = await Promise.all([
        this.store.get(`SELECT ${COUNT} n FROM events WHERE seq > ? AND from_name != ?`, [s.cursor, s.name]),
        this.store.get(`SELECT ${COUNT} n FROM events e WHERE ${this.openAsk}`, [s.name, s.name, s.name]),
      ]);
      return { ...this.shape(s), unread: u!.n as number, open: o!.n as number, holds_turn: turn.holder === s.name };
    }));
  }

  // ── control: the owner, or any session in the channel, pauses and resumes a session ──
  control(by: string, target: string, action: "pause" | "resume", why = "") {
    return this.serial(async () => {
      await this.need(by); await this.need(target);
      if (target === OWNER) throw bad("the owner cannot be paused");
      const st = action === "pause" ? "pause" : "run";
      await this.tx(async q => {
        await q.run("UPDATE sessions SET control=?, control_by=?, control_at=? WHERE name=?", [st, by, now(), target]);
        await this.insert(q, by, { topic: `control.${action}`, to: target, msg: why || `${by} ${action}d ${target}` });
      });
      this.emit("presence", await this.presenceOf(target));
      this.flush();
      this.wake();
      return { name: target, control: st, by };
    });
  }
  async controlOf(name: string) { return name === OWNER ? "run" : ((await this.need(name)).control as "run" | "pause"); }
  // s: the session as need() returned it
  private mustRun(s: Row, what: string) {
    if (s.control === "pause") throw new HuddleError(423, `${s.name} is paused by ${s.control_by} since ${s.control_at}; ${what} refused. Call gate to wait for resume.`);
  }
  async gate(name: string, timeoutS = 0, signal?: AbortSignal) {
    await this.need(name);
    const check = async () => (await this.controlOf(name)) === "run" ? { kind: "event" as const, control: "run" } : null;
    const h = await this.sleep(name, check, timeoutS, signal,
      async () => ({ state: "paused", task: `paused by ${(await this.session(name))?.control_by}` }),
      async h => { if (h.kind === "event" && (await this.session(name))?.state === "paused") await this.presence(name, { state: "working", task: "resumed" }); });
    if (h.kind === "event") return { control: "run" };
    return { control: await this.controlOf(name), [h.kind]: true };
  }

  // ── events ──────────────────────────────────────────────────────────────────
  private toEv(r: Row): Ev {
    return { seq: r.seq, ts: r.ts, from: r.from_name, to: r.to_name, topic: r.topic, ref: r.ref, msg: r.msg,
      data: P(r.data), reply_to: r.reply_to, needs_reply: !!r.needs_reply };
  }
  // raw insert, inside a caller's transaction; returns the event (or the earlier one for a repeated key)
  private async insert(q: Q, from: string, e: { topic: string; to?: string | null; ref?: string | null; msg?: string | null; data?: any; reply_to?: number | null; needs_reply?: boolean; key?: string | null; ts?: string }): Promise<Ev> {
    if (e.key) {
      const dup = await q.get("SELECT * FROM events WHERE from_name=? AND key=?", [from, e.key]);
      if (dup) return { ...this.toEv(dup), duplicate: true } as Ev;
    }
    const r = await q.get(`INSERT INTO events (ts, from_name, to_name, topic, ref, msg, data, reply_to, needs_reply, key)
      VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`, [e.ts ?? now(), from, e.to ?? null, e.topic, e.ref ?? null, e.msg ?? null,
      J(e.data), e.reply_to ?? null, e.needs_reply ? 1 : 0, e.key ?? null]);
    const ev = this.toEv(r!);
    await this.advanceTurn(q, ev);
    this.pending.push(ev);
    return ev;
  }
  private flush() { const p = this.pending; this.pending = []; for (const ev of p) this.emit("event", ev); if (p.length) this.wake(); }
  append(from: string, e: Parameters<Channel["insert"]>[2]): Promise<Ev> {
    return this.serial(async () => {
      const ev = await this.tx(q => this.insert(q, from, e));
      this.flush();
      return ev;
    });
  }
  publish(from: string, a: { topic: string; to?: string | null; ref?: string; msg: string; data?: any; needs_reply?: boolean; key?: string }) {
    return this.serial(async () => {
      const me = await this.need(from);
      if (!TOPIC_RE.test(a.topic) || a.topic.includes("*")) throw bad(`topic must match ${TOPIC_RE} without *`);
      if (/^(control|reply|session|task)\./.test(a.topic) || a.topic === "reply") throw bad(`topic ${a.topic} is reserved; use the matching tool`);
      if (!a.msg) throw bad("need msg");
      if (a.to && a.to !== OWNER) await this.need(a.to);
      this.mustRun(me, "publish");
      return this.append(from, { topic: a.topic, to: a.to ?? null, ref: a.ref ?? null, msg: String(a.msg).slice(0, 20000), data: a.data, needs_reply: !!a.needs_reply, key: a.key ?? null });
    });
  }
  // a message to one session (or to everyone, to=null); ask=true puts it in their inbox until they reply
  send(from: string, to: string | null, msg: string, o: { ask?: boolean; task?: string; key?: string } = {}) {
    return this.serial(async () => {
      await this.need(from);
      if (to && to !== OWNER) await this.need(to);
      if (!msg) throw bad("need msg");
      return this.append(from, { topic: o.ask ? "ask" : "msg", to, msg: msg.slice(0, 20000), data: o.task ? { task: o.task } : null, needs_reply: !!o.ask, key: o.key ?? null });
    });
  }
  reply(from: string, seq: number, msg: string) {
    return this.serial(async () => {
      await this.need(from);
      const q = await this.store.get("SELECT * FROM events WHERE seq=?", [seq]);
      if (!q) throw new HuddleError(404, `no event ${seq}`);
      if (q.from_name === from) throw bad("you cannot answer your own message");
      if (q.to_name && q.to_name !== from) throw new HuddleError(403, `event ${seq} is addressed to ${q.to_name}, not ${from}`);
      if (q.needs_reply && await this.store.get("SELECT 1 FROM events WHERE reply_to=? AND from_name=?", [seq, from]))
        throw new HuddleError(409, `event ${seq} is already answered by ${from}`);
      return this.append(from, { topic: "reply", to: q.from_name, msg: msg || "ack", reply_to: seq, ref: q.ref });
    });
  }
  async event(seq: number) { const r = await this.store.get("SELECT * FROM events WHERE seq=?", [seq]); return r ? this.toEv(r) : null; }
  async events(o: { after?: number; before?: number; limit?: number; topic?: string; from?: string } = {}) {
    const lim = Math.max(1, Math.min(2000, o.limit ?? 300));
    const w = ["seq > ?"], p: unknown[] = [o.after ?? 0];
    if (o.before != null) { w.push("seq < ?"); p.push(o.before); }
    if (o.from != null) { w.push("from_name = ?"); p.push(o.from); }
    const rows = await this.store.all(`SELECT * FROM events WHERE ${w.join(" AND ")} ORDER BY seq DESC LIMIT ?`, [...p, lim]);
    return rows.reverse().map(r => this.toEv(r)).filter(e => !o.topic || globMatch(e.topic, [o.topic]));
  }
  async lastSeq() { return (await this.store.get("SELECT COALESCE(MAX(seq),0) s FROM events"))!.s as number; }
  // everything this session has not acked yet, in order: every member sees every message, also
  // those addressed to another session (it overhears them); only its own are left out
  async unread(name: string): Promise<Ev[]> {
    const s = await this.need(name);
    return (await this.store.all(`SELECT * FROM events WHERE seq > ? AND from_name != ? ORDER BY seq`, [s.cursor, name])).map(r => this.toEv(r));
  }
  // messages that wait for this session's reply (asks, and owner directives); params: name ×3
  private openAsk = `e.needs_reply = 1 AND e.from_name != ? AND (e.to_name IS NULL OR e.to_name = ?)
    AND NOT EXISTS (SELECT 1 FROM events r WHERE r.reply_to = e.seq AND r.from_name = ?)`;
  async inbox(name: string): Promise<Ev[]> {
    return (await this.store.all(`SELECT e.* FROM events e WHERE ${this.openAsk} ORDER BY e.seq`, [name, name, name])).map(r => this.toEv(r));
  }
  ack(name: string, seq: number) {
    return this.serial(async () => {
      const s = await this.need(name);
      if (!Number.isInteger(seq) || seq < 0) throw bad("seq must be an integer");
      const top = Math.min(seq, await this.lastSeq());
      if (top > s.cursor) await this.store.run("UPDATE sessions SET cursor=? WHERE name=?", [top, name]); // never backwards
      const cursor = Math.max(top, s.cursor);
      this.emit("ack", { name, cursor });
      return { cursor };
    });
  }
  // Block until (1) a message waits for this session's reply → kind "message"; (2) the first
  // unread event for this session (to it or to everyone) that matches a topic glob → kind "event",
  // with the unread events before it, overheard ones included ("skipped": acking the hit moves the
  // cursor past them); (3) the timeout. A message to another session never wakes this one.
  async wait(name: string, topics: string[], timeoutS = 0, signal?: AbortSignal) {
    const before = await this.need(name);
    for (const t of topics) if (!TOPIC_RE.test(t)) throw bad(`bad topic glob ${t}`);
    const check = async (): Promise<WaitHit | null> => {
      const ib = await this.inbox(name);
      if (ib.length) return { kind: "message", ...ib[0], more: ib.length - 1 };
      const all = await this.unread(name);
      const i = all.findIndex(e => (!e.to || e.to === name) && globMatch(e.topic, topics));
      if (i < 0) return null;
      const sk = all.slice(0, i);
      return { kind: "event", ...all[i], skipped: sk.slice(-25).map(e => ({ seq: e.seq, from: e.from, to: e.to, topic: e.topic, msg: e.msg?.slice(0, 200) ?? null })), skipped_total: sk.length };
    };
    return this.sleep(name, check, timeoutS, signal,
      async () => ({ state: "waiting", task: `waiting for ${topics.join(" ") || "any event"}` }),
      async h => {
        const s = await this.session(name);
        if (s?.state === "waiting") await this.presence(name, { state: before.state === "waiting" ? "working" : before.state, task: h.kind === "timeout" ? "wait timed out" : "handling a wake-up" });
      });
  }

  // ── the turn: who may work now ──────────────────────────────────────────────
  // turn.pass (to X) gives it to X; turn.take gives it to the sender; a sender's handover topic
  // gives it to that sender's handover target. Kept materialized: O(1) to read.
  private async advanceTurn(q: Q, e: Ev) {
    const h = this.config().handover;
    let holder: string | null = null;
    if (e.topic === "turn.take") holder = e.from;
    else if (e.topic === "turn.pass" && e.to) holder = e.to;
    else if (h[e.from]?.topics.includes(e.topic)) holder = h[e.from].to;
    if (holder) { await this.setMeta("turn_holder", holder, q); await this.setMeta("turn_seq", String(e.seq), q); }
  }
  async turn() {
    const seq = Number(this.meta("turn_seq") ?? 0);
    return { holder: this.meta("turn_holder") ?? this.config().start ?? null, since: seq ? await this.event(seq) : null };
  }
  passTurn(from: string, to: string, msg = "") {
    return this.serial(async () => {
      const me = await this.need(from); await this.need(to);
      this.mustRun(me, "turn.pass");
      return this.append(from, { topic: "turn.pass", to, msg: msg || `${from} hands the turn to ${to}` });
    });
  }
  takeTurn(from: string, msg = "") {
    return this.serial(async () => {
      this.mustRun(await this.need(from), "turn.take");
      return this.append(from, { topic: "turn.take", msg: msg || `${from} takes the turn` });
    });
  }
  // recompute the materialized turn from the whole history (after an import)
  replayTurn() {
    return this.serial(() => this.tx(async q => {
      await this.setMeta("turn_holder", null, q); await this.setMeta("turn_seq", null, q);
      for (const r of await q.all("SELECT * FROM events ORDER BY seq")) await this.advanceTurn(q, this.toEv(r));
    }));
  }

  // ── tasks: the plan, shared by every session ────────────────────────────────
  private rawTask(id: string, q: Q = this.store) { return q.get("SELECT * FROM tasks WHERE id=?", [id]); }
  private async editsBy(q: Q = this.store) {
    const m = new Map<string, Row[]>();
    for (const e of await q.all("SELECT * FROM edits")) (m.get(e.task_id) ?? m.set(e.task_id, []).get(e.task_id)!).push(e);
    return m;
  }
  // a task as the views see it: body fields flattened, owner edits applied, depends = after
  effective(r: Row, edits: Row[]): Row {
    const body = P(r.body, {});
    const out: Row = { ...body, id: r.id, phase_n: r.phase, ord: r.ord, title: r.title, owner: r.owner, status: r.status,
      depends: P(r.after, []), origin: r.origin, created_by: r.created_by, status_at: r.status_at, status_by: r.status_by, status_note: r.status_note };
    for (const f of JSON_FIELDS) out[f] ??= [];
    out.edited = {} as Row;
    for (const e of edits) {
      out.edited[e.field] = { original: out[e.field], at: e.at, by: e.by };
      out[e.field] = P(e.value, e.value);
    }
    return out;
  }
  async task(id: string) {
    const r = await this.rawTask(id); if (!r) return null;
    const [edits, comments, all] = await Promise.all([
      this.store.all("SELECT * FROM edits WHERE task_id=?", [id]),
      this.store.all("SELECT * FROM notes WHERE task_id=? ORDER BY created_at, id", [id]),
      this.store.all("SELECT id, after, status, owner, title FROM tasks"),
    ]);
    const e = this.effective(r, edits);
    e.comments = comments;
    const st = new Map(all.map(x => [x.id, x]));
    e.needed_by = all.filter(x => P(x.after, []).includes(id)).map(x => x.id);
    e.unmet = (e.depends as string[]).filter(d => !FINISHED.has(st.get(d)?.status ?? "todo"))
      .map(d => ({ id: d, owner: st.get(d)?.owner ?? null, status: st.get(d)?.status ?? "missing", title: st.get(d)?.title ?? null }));
    e.ready = e.unmet.length === 0;
    e.open_notes = (e.comments as Row[]).filter(c => !c.resolved);
    return e;
  }
  // every task, in plan order, for lists and the kanban (3 queries, no per-row lookups)
  async tasks(o: { owner?: string; status?: string; phase?: number } = {}) {
    const [edits, countRows, rows] = await Promise.all([
      this.editsBy(),
      this.store.all(`SELECT task_id, ${COUNT} n, CAST(SUM(CASE WHEN resolved=0 THEN 1 ELSE 0 END) AS INTEGER) open, GROUP_CONCAT(DISTINCT kind) kinds FROM notes GROUP BY task_id`),
      this.store.all("SELECT * FROM tasks ORDER BY phase, ord, id"),
    ]);
    const counts = new Map(countRows.map(c => [c.task_id, c]));
    const status = new Map(rows.map(r => [r.id, r.status]));
    return rows.filter(r => (o.owner === undefined || r.owner === o.owner) && (!o.status || r.status === o.status) && (o.phase === undefined || r.phase === o.phase))
      .map(r => {
        const e = this.effective(r, edits.get(r.id) ?? []);
        const c = counts.get(r.id);
        return { id: e.id, phase_n: e.phase_n, title: e.title, owner: e.owner, kind: e.kind, gate: e.gate, risk: e.risk,
          status: e.status, value: e.value, depends: e.depends, status_by: e.status_by,
          blocked_by: (e.depends as string[]).filter(d => !FINISHED.has(status.get(d) ?? "todo")),
          comments: c ? { n: c.n, open: c.open, kinds: String(c.kinds ?? "").split(",") } : null,
          edited: Object.keys(e.edited).length > 0 };
      });
  }
  // the first unfinished task this session should work: its own or an unowned one, in plan order
  async next(name: string) {
    await this.need(name);
    const r = await this.store.get(`SELECT id FROM tasks WHERE status NOT IN ('done','skipped') AND (owner = ? OR owner IS NULL)
      ORDER BY phase, ord, id LIMIT 1`, [name]);
    return r ? (await this.task(r.id))! : { done: true } as Row;
  }
  private async checkAfter(id: string, after: string[], q: Q = this.store) {
    const graph = new Map((await q.all("SELECT id, after FROM tasks")).map(r => [r.id as string, P(r.after, []) as string[]]));
    for (const d of after) if (!graph.has(d)) throw bad(`depends on unknown task ${d}`);
    // reject a cycle: walk the dependency graph from the new edges back to id
    graph.set(id, after);
    const seen = new Set<string>(), stack = [...after];
    while (stack.length) {
      const x = stack.pop()!;
      if (x === id) throw bad(`dependency cycle through ${id}`);
      if (seen.has(x)) continue; seen.add(x);
      stack.push(...(graph.get(x) ?? []));
    }
  }
  createTask(by: string, t: { id?: string; title: string; owner?: string | null; after?: string[]; phase?: number; body?: Row; status?: string }) {
    return this.serial(async () => {
      this.mustRun(await this.need(by), "task create");
      const id = t.id ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      if (!/^[\w.-]{1,32}$/.test(id)) throw bad("task id: 1-32 of [A-Za-z0-9_.-]");
      if (await this.rawTask(id)) throw new HuddleError(409, `task ${id} exists`);
      if (!t.title) throw bad("need title");
      if (t.owner && t.owner !== OWNER) await this.need(t.owner);
      const after = t.after ?? [];
      await this.checkAfter(id, after);
      const phase = t.phase ?? 0;
      const ev = await this.tx(async q => {
        const ord = (await q.get("SELECT COALESCE(MAX(ord),-1)+1 o FROM tasks WHERE phase=?", [phase]))!.o as number;
        await q.run(`INSERT INTO tasks (id, phase, ord, title, owner, status, after, body, origin, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [id, phase, ord, t.title, t.owner ?? null, t.status ?? "todo", J(after), J(t.body ?? {}), by === OWNER ? "owner" : "session", by, now()]);
        return this.insert(q, by, { topic: "task.created", to: t.owner && t.owner !== by ? t.owner : null, ref: id, msg: `${id} ${t.title}${t.owner ? ` → ${t.owner}` : ""}${after.length ? ` after ${after.join(", ")}` : ""}`, data: { task: id } });
      });
      await this.reindex([id]); this.flush(); this.emit("task", await this.taskBrief(id));
      return { task: await this.task(id), event: ev };
    });
  }
  // owner, depends, title or a body field; body fields keep the original for the "edited" view
  updateTask(by: string, id: string, f: { owner?: string | null; after?: string[]; field?: string; value?: unknown }) {
    return this.serial(async () => {
      await this.need(by);
      const r = await this.rawTask(id); if (!r) throw new HuddleError(404, `no task ${id}`);
      if (f.owner !== undefined && f.owner && f.owner !== OWNER) await this.need(f.owner);
      if (f.after !== undefined) await this.checkAfter(id, f.after);
      if (f.field !== undefined && !EDITABLE.has(f.field)) throw bad(`field ${f.field} is not editable`);
      await this.tx(async q => {
        if (f.owner !== undefined) {
          await q.run("UPDATE tasks SET owner=? WHERE id=?", [f.owner, id]);
          await this.insert(q, by, { topic: "task.assigned", to: f.owner && f.owner !== by ? f.owner : null, ref: id, msg: `${id} → ${f.owner ?? "nobody"}`, data: { task: id, owner: f.owner } });
        }
        if (f.after !== undefined) await q.run("UPDATE tasks SET after=? WHERE id=?", [J(f.after), id]);
        if (f.field !== undefined) {
          if (f.value === null) await q.run("DELETE FROM edits WHERE task_id=? AND field=?", [id, f.field]);
          else await q.run(`INSERT INTO edits (task_id, field, value, by, at) VALUES (?,?,?,?,?)
            ON CONFLICT(task_id, field) DO UPDATE SET value=excluded.value, by=excluded.by, at=excluded.at`, [id, f.field, JSON.stringify(f.value), by, now()]);
        }
        if (f.after !== undefined) await this.releaseReadyTx(q, by, [id]);
      });
      await this.reindex([id]); this.flush(); this.emit("task", await this.taskBrief(id));
      return (await this.task(id))!;
    });
  }
  // Moving a task to done/skipped releases every task that waited only on it: each gets a
  // task.ready event addressed to its owner, so a session blocked on another's work wakes up.
  setStatus(by: string, id: string, status: string, note = "") {
    return this.serial(async () => {
      const me = await this.need(by);
      if (!(STATUSES as readonly string[]).includes(status)) throw bad(`status must be one of ${STATUSES.join(", ")}`);
      const r = await this.rawTask(id); if (!r) throw new HuddleError(404, `no task ${id}`);
      this.mustRun(me, "task status");
      if (status === "doing") {
        const st = await this.statusMap();
        const unmet = (P(r.after, []) as string[]).filter(d => !FINISHED.has(st.get(d) ?? "todo"));
        if (unmet.length) throw new HuddleError(409, `${id} waits on ${unmet.join(", ")}; wait for task.ready (or the owner edits its dependencies)`);
      }
      await this.tx(async q => {
        await q.run("UPDATE tasks SET status=?, status_by=?, status_at=?, status_note=? WHERE id=?", [status, by, now(), note, id]);
        await this.insert(q, by, { topic: "task.status", ref: id, msg: `${id} → ${status}${note ? ` · ${note}` : ""}`, data: { task: id, status, note } });
        if (FINISHED.has(status)) {
          const waiting = (await q.all("SELECT id, after FROM tasks WHERE status NOT IN ('done','skipped')")).filter(d => (P(d.after, []) as string[]).includes(id));
          await this.releaseReadyTx(q, by, waiting.map(d => d.id));
        }
      });
      this.flush(); this.emit("task", await this.taskBrief(id));
      return { ok: true, id, status };
    });
  }
  private async statusMap(q: Q = this.store) { return new Map((await q.all("SELECT id, status FROM tasks")).map(r => [r.id as string, r.status as string])); }
  // each of these tasks that is open and has nothing left to wait on gets task.ready
  private async releaseReadyTx(q: Q, by: string, ids: string[]) {
    if (!ids.length) return;
    const st = await this.statusMap(q);
    for (const id of ids) {
      const d = (await this.rawTask(id, q))!;
      const deps = P(d.after, []) as string[];
      if (deps.length && !FINISHED.has(d.status) && deps.every(x => FINISHED.has(st.get(x) ?? "todo")))
        await this.insert(q, by, { topic: "task.ready", to: d.owner ?? null, ref: d.id, msg: `${d.id} ${d.title}: everything it waits on is done`, data: { task: d.id, after: deps } });
    }
  }
  // block until a task is done or skipped (a session that needs another's work before its own)
  async waitTask(name: string, id: string, timeoutS = 0, signal?: AbortSignal) {
    await this.need(name);
    if (!(await this.rawTask(id))) throw new HuddleError(404, `no task ${id}`);
    const check = async (): Promise<WaitHit | null> => { const t = await this.rawTask(id); return t && FINISHED.has(t.status) ? { kind: "event", task: id, status: t.status, by: t.status_by, note: t.status_note } : null; };
    return this.sleep(name, check, timeoutS, signal, async () => ({ state: "waiting", task: `waiting for task ${id}` }),
      async h => { if ((await this.session(name))?.state === "waiting") await this.presence(name, { state: "working", task: h.kind === "timeout" ? "wait timed out" : `task ${id} finished` }); });
  }
  // block until `from` (or anyone it was sent to) answers the message at seq
  async waitReply(name: string, seq: number, timeoutS = 0, signal?: AbortSignal) {
    await this.need(name);
    const check = async (): Promise<WaitHit | null> => {
      const r = await this.store.get("SELECT * FROM events WHERE reply_to=? ORDER BY seq LIMIT 1", [seq]);
      return r ? { kind: "event", ...this.toEv(r) } : null;
    };
    return this.sleep(name, check, timeoutS, signal, async () => ({ state: "waiting", task: `waiting for a reply to #${seq}` }),
      async h => { if ((await this.session(name))?.state === "waiting") await this.presence(name, { state: "working", task: h.kind === "timeout" ? "no reply yet" : `reply to #${seq} received` }); });
  }
  // the task a session is working now (its newest "doing" one)
  async current(name: string) {
    return ((await this.store.get("SELECT id FROM tasks WHERE status='doing' AND (owner=? OR status_by=?) ORDER BY status_at DESC LIMIT 1", [name, name]))?.id ?? null) as string | null;
  }
  note(by: string, id: string, kind: string, body: string) {
    return this.serial(async () => {
      if (!(await this.rawTask(id))) throw new HuddleError(404, `no task ${id}`);
      if (!(NOTE_KINDS as readonly string[]).includes(kind)) throw bad(`kind must be one of ${NOTE_KINDS.join(", ")}`);
      if (!body?.trim() || body.length > 20000) throw bad("need body (≤ 20000 chars)");
      await this.store.run("INSERT INTO notes (task_id, kind, body, by, created_at) VALUES (?,?,?,?,?)", [id, kind, body.trim(), by, now()]);
      this.emit("task", await this.taskBrief(id));
      return (await this.task(id))!;
    });
  }
  editNote(id: number, f: { resolved?: boolean; body?: string; remove?: boolean }) {
    return this.serial(async () => {
      const c = await this.store.get("SELECT task_id FROM notes WHERE id=?", [id]);
      if (!c) throw new HuddleError(404, "no such note");
      if (f.remove) await this.store.run("DELETE FROM notes WHERE id=?", [id]);
      else {
        if (typeof f.resolved === "boolean") await this.store.run("UPDATE notes SET resolved=? WHERE id=?", [f.resolved ? 1 : 0, id]);
        if (typeof f.body === "string" && f.body.trim()) await this.store.run("UPDATE notes SET body=? WHERE id=?", [f.body.trim(), id]);
      }
      this.emit("task", await this.taskBrief(c.task_id));
      return (await this.task(c.task_id))!;
    });
  }
  private async taskBrief(id: string) { const r = await this.rawTask(id); return r ? { id, status: r.status, owner: r.owner, title: r.title } : { id, removed: true }; }

  // ── phases and the plan import ──────────────────────────────────────────────
  async phases() {
    return (await this.store.all("SELECT * FROM phases ORDER BY n")).map(p => ({ n: p.n, title: p.title, ...P(p.body, {}) }));
  }
  // Load a plan: phases with their tasks. Content (title, body, order, dependencies) comes from
  // the plan; state (status, owner edits, notes) is kept by id. A task whose title changed under
  // owner state is reported in "moved". Tasks the plan no longer has are removed unless a session
  // or the owner created them.
  importPlan(by: string, plan: { phases: Row[] }, o: { owner?: string | null } = {}) {
    return this.serial(async () => {
      const old = new Map((await this.store.all("SELECT id, title FROM tasks")).map(r => [r.id, r.title]));
      const keep = new Set<string>(), errors: string[] = [];
      await this.tx(async q => {
        await q.run("DELETE FROM phases");
        for (const p of plan.phases ?? []) {
          const { steps, n, title, ...rest } = p;
          await q.run("INSERT INTO phases (n, title, body) VALUES (?,?,?)", [Number(n), String(title ?? `Phase ${n}`), J(rest)]);
          for (const [i, st] of ((steps ?? []) as Row[]).entries()) {
            const { id, title: tt, status, depends, owner, ...body } = st;
            const sid = String(id);
            keep.add(sid);
            await q.run(`INSERT INTO tasks (id, phase, ord, title, owner, status, after, body, origin, created_by, created_at)
              VALUES (?,?,?,?,?,?,?,?, 'plan', ?, ?)
              ON CONFLICT(id) DO UPDATE SET phase=excluded.phase, ord=excluded.ord, title=excluded.title, after=excluded.after, body=excluded.body, origin='plan'`,
              [sid, Number(n), i, String(tt ?? sid), owner ?? o.owner ?? null, (STATUSES as readonly string[]).includes(status) ? status : "todo",
                J(depends ?? []), J(body), by, now()]);
          }
        }
        for (const r of await q.all("SELECT id, status FROM tasks WHERE origin='plan'")) if (!keep.has(r.id)) {
          const owned = (await q.get("SELECT 1 FROM notes WHERE task_id=? UNION SELECT 1 FROM edits WHERE task_id=?", [r.id, r.id])) || r.status !== "todo";
          if (owned) errors.push(`${r.id} left the plan but has owner state; kept`); else await q.run("DELETE FROM tasks WHERE id=?", [r.id]);
        }
        const rows = await q.all("SELECT id, after FROM tasks");
        const ids = new Set(rows.map(r => r.id));
        for (const r of rows) for (const d of P(r.after, []) as string[]) if (!ids.has(d)) errors.push(`${r.id} depends on unknown ${d}`);
      });
      const owned = new Set((await this.store.all("SELECT task_id id FROM notes UNION SELECT task_id FROM edits UNION SELECT id FROM tasks WHERE status != 'todo'")).map(r => r.id));
      const nowT = new Map((await this.store.all("SELECT id, title FROM tasks")).map(r => [r.id, r.title]));
      const moved = (P(this.meta("plan_moved"), []) as Row[]).filter(m => owned.has(m.id) && nowT.get(m.id) !== m.was);
      for (const id of owned) if (old.has(id) && old.get(id) !== nowT.get(id) && !moved.some(m => m.id === id)) moved.push({ id, was: old.get(id), now: nowT.get(id) ?? null });
      await this.setMeta("plan_moved", JSON.stringify(moved));
      await this.setMeta("plan_at", now());
      await this.reindex();
      this.emit("plan", { tasks: keep.size });
      return { phases: (plan.phases ?? []).length, tasks: keep.size, moved, errors };
    });
  }
  // the search index of the given tasks (all without ids), from their effective text
  reindex(ids?: string[]) {
    return this.serial(async () => {
      if (!this.fts) return;
      const rows = ids ? (await Promise.all(ids.map(i => this.rawTask(i)))).filter(Boolean) as Row[] : await this.store.all("SELECT * FROM tasks");
      const edits = await this.editsBy();
      const docs = rows.map(r => { const { id, title, edited, ...rest } = this.effective(r, edits.get(r.id) ?? []); return { id, title, body: JSON.stringify(rest) }; });
      await this.tx(q => this.store.indexTasks(q, docs, ids));
    });
  }
  async search(q: string) {
    q = q.trim(); if (!q) return [];
    const hits = await this.store.searchTasks(q);
    if (hits) return hits;
    const like = `%${q}%`;
    return this.store.all(`SELECT id, title, substr(body,1,140) AS hit FROM tasks WHERE title LIKE ? OR body LIKE ? LIMIT 80`, [like, like]);
  }
  async review() {
    const [open, edits] = await Promise.all([
      this.store.all(`SELECT n.*, n.task_id AS step_id, t.title FROM notes n LEFT JOIN tasks t ON t.id=n.task_id WHERE n.resolved=0 ORDER BY n.task_id, n.id`),
      this.store.all(`SELECT e.task_id AS step_id, e.field, e.at AS updated_at, e.by, t.title FROM edits e LEFT JOIN tasks t ON t.id=e.task_id ORDER BY e.task_id`),
    ]);
    return { open, edits, moved: P(this.meta("plan_moved"), []) };
  }

  // ── knowledge: what one session learned, so the others do not pay for it again ──
  // kinds: fact (true about the code/system), lesson (a mistake not to repeat), decision (made,
  // with why), context (a summary of files/state read), result (output of a finished piece of
  // work), howto (a command sequence that works). supersedes retires an older entry.
  remember(by: string, k: { kind: string; title: string; body: string; tags?: string[]; refs?: string[]; task?: string; supersedes?: number }) {
    return this.serial(async () => {
      await this.need(by);
      if (!(KB_KINDS as readonly string[]).includes(k.kind)) throw bad(`kind must be one of ${KB_KINDS.join(", ")}`);
      if (!k.title?.trim() || !k.body?.trim()) throw bad("need title and body");
      if (k.body.length > 50000) throw bad("body ≤ 50000 chars; link the rest with refs");
      if (k.task && !(await this.rawTask(k.task))) throw new HuddleError(404, `no task ${k.task}`);
      const row = await this.tx(async q => {
        const row = (await q.get(`INSERT INTO knowledge (by, kind, title, body, tags, refs, task_id, supersedes, created_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING *`,
          [by, k.kind, k.title.trim().slice(0, 200), k.body.trim(), J(k.tags ?? []), J(k.refs ?? []), k.task ?? null, k.supersedes ?? null, now()]))!;
        await this.store.indexKnowledge(q, row, k.tags ?? []);
        await this.insert(q, by, { topic: "kb.added", ref: `kb:${row.id}`, msg: `[${k.kind}] ${row.title}`, data: { kb: row.id, kind: k.kind, tags: k.tags ?? [] } });
        return row;
      });
      this.flush();
      return this.kbRow(row);
    });
  }
  private kbRow(r: Row) { return { id: r.id, by: r.by, kind: r.kind, title: r.title, body: r.body, tags: P(r.tags, []), refs: P(r.refs, []), task: r.task_id, supersedes: r.supersedes, created_at: r.created_at, hits: r.hits }; }
  // search first, read second: recall returns titles and a snippet; kb(id) returns the body
  async recall(q: string, o: { kind?: string; tag?: string; by?: string; limit?: number } = {}) {
    const lim = Math.max(1, Math.min(50, o.limit ?? 10));
    const retired = await this.retired();
    let rows: Row[];
    if (q.trim() && this.fts) rows = await this.store.searchKnowledge(q.trim(), lim * 3);
    else if (q.trim()) { // a SQLite without FTS5 (early Node 22): entries holding any of the words, newest first
      const words = q.trim().split(/\s+/).slice(0, 8).map(w => `%${w.replace(/[\\%_]/g, "\\$&")}%`);
      rows = await this.store.all(`SELECT *, substr(body,1,200) hit FROM knowledge WHERE ${words.map(() => "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')").join(" OR ")} ORDER BY id DESC LIMIT ?`,
        [...words.flatMap(w => [w, w, w]), lim * 3]);
    } else rows = await this.store.all("SELECT *, substr(body,1,200) hit FROM knowledge ORDER BY id DESC LIMIT ?", [lim * 3]);
    return rows.filter(r => !retired.has(r.id) && (!o.kind || r.kind === o.kind) && (!o.by || r.by === o.by || r.by.startsWith(o.by + ".")) && (!o.tag || P(r.tags, []).includes(o.tag)))
      .slice(0, lim).map(r => ({ id: r.id as number, kind: r.kind as string, title: r.title as string, by: r.by as string, tags: P(r.tags, []) as string[], task: r.task_id, created_at: r.created_at, hit: r.hit }));
  }
  kb(id: number) {
    return this.serial(async () => {
      const r = await this.store.get("UPDATE knowledge SET hits = hits + 1 WHERE id=? RETURNING *", [id]);
      if (!r) throw new HuddleError(404, `no knowledge entry ${id}`);
      const by = await this.store.get("SELECT id FROM knowledge WHERE supersedes=?", [id]);
      return { ...this.kbRow(r), superseded_by: by?.id ?? null };
    });
  }

  // ── what a session sees when it joins ───────────────────────────────────────
  async snapshot(name: string, j: { context?: Context; skipped?: number; brief?: Row | null } = {}) {
    const [u, ib, control, turn, sessions, total, latest] = await Promise.all([
      this.unread(name), this.inbox(name), this.controlOf(name), this.turn(), this.sessions(),
      this.store.get(`SELECT ${COUNT} n FROM knowledge`), this.recall("", { limit: 8 }),
    ]);
    const n = name === OWNER ? null : await this.next(name);
    return {
      channel: this.name, me: name, control, turn, orchestrator: this.config().orchestrator,
      context: j.context ?? null, skipped: j.skipped ?? 0, brief: j.brief ?? null,
      sessions: sessions.filter(s => s.name !== name && s.state !== "left").map(s => ({ name: s.name, role: s.role, state: s.state, task: s.task, stale: s.stale, control: s.control })),
      knowledge: { total: total!.n as number, latest: latest.map(k => `#${k.id} [${k.kind}] ${k.title} (${k.by})`) },
      unread: u.slice(-50).map(e => ({ seq: e.seq, from: e.from, to: e.to, topic: e.topic, msg: e.msg?.slice(0, 300) ?? null })), unread_total: u.length,
      inbox: ib.map(e => ({ seq: e.seq, from: e.from, msg: e.msg, task: e.data?.task ?? null })),
      next: !n || n.done ? null : { id: n.id, title: n.title, ready: n.ready, unmet: n.unmet },
    };
  }
  // Everything that waits on the owner, in one read: asks addressed to the owner (or to all),
  // paused and stale sessions, blocked tasks, and the next tasks gated owner/ask-first that are
  // ready (nothing they wait on is open) and not yet approved.
  async attention() {
    const [inbox, allSess, all, approvedRows, raw, review] = await Promise.all([
      this.inbox(OWNER), this.sessions(), this.tasks(),
      this.store.all("SELECT DISTINCT task_id FROM notes WHERE kind='direction' AND body LIKE 'Approved by %'"),
      this.store.all("SELECT id, status_note FROM tasks WHERE status='blocked'"),
      this.store.get(`SELECT ${COUNT} n FROM notes WHERE resolved=0`),
    ]);
    const asks = inbox.map(e => ({ seq: e.seq, from: e.from, msg: e.msg, ts: e.ts, task: e.data?.task ?? null, ref: e.ref }));
    const sess = allSess.filter(s => s.state !== "left");
    const status = new Map(all.map(t => [t.id, t.status]));
    const approved = new Set(approvedRows.map(r => r.task_id));
    const notes = new Map(raw.map(r => [r.id, r.status_note]));
    const gates = all.filter(t => (t.gate === "owner" || t.gate === "ask-first") && !FINISHED.has(t.status) && !t.blocked_by.length && !approved.has(t.id)).slice(0, 12)
      .map(t => ({ id: t.id, title: t.title, gate: t.gate, owner: t.owner, status: t.status, phase_n: t.phase_n }));
    const blocked = all.filter(t => t.status === "blocked").map(t => ({ id: t.id, title: t.title, owner: t.owner, note: notes.get(t.id) ?? "", waits_on: t.blocked_by }));
    const next = await Promise.all(sess.filter(s => !s.parent).map(async s => { const n = await this.next(s.name); return { session: s.name, task: n.done ? null : { id: n.id, title: n.title, ready: n.ready, unmet: (n.unmet ?? []).map((u: Row) => u.id) } }; }));
    return {
      asks, gates, blocked, open_notes: review!.n as number,
      paused: sess.filter(s => s.control === "pause").map(s => ({ name: s.name, by: s.control_by, at: s.control_at })),
      stale: sess.filter(s => s.stale).map(s => ({ name: s.name, last_seen: s.last_seen })),
      next,
      unblocked_by: [...new Set(all.flatMap(t => t.blocked_by))].filter(id => status.get(id) && !FINISHED.has(status.get(id)!)).length,
      total: asks.length + gates.length + blocked.length,
    };
  }
  // the owner's go-ahead on a gated task: a note on the task plus a message to its owner
  approve(id: string, msg = "", by = OWNER) {
    return this.serial(async () => {
      const t = await this.rawTask(id); if (!t) throw new HuddleError(404, `no task ${id}`);
      await this.note(by, id, "direction", `Approved by ${by === OWNER ? "the owner" : by}${msg ? `: ${msg}` : ""}`);
      const to = t.owner && t.owner !== by && t.owner !== OWNER && await this.session(t.owner) ? t.owner : null;
      const ev = await this.append(by, { topic: "msg", to, ref: id, msg: `Approved ${id} ${t.title}${msg ? `: ${msg}` : ""}`, data: { task: id, approved: true } });
      return { ok: true, id, event: ev.seq };
    });
  }
  // The big picture in one read: each phase's progress, what every session does now and next,
  // and the critical path: the longest chain of unfinished tasks linked by dependencies.
  async map() {
    const [all, phases, sess] = await Promise.all([this.tasks(), this.phases(), this.sessions()]);
    const open = new Map(all.filter(t => !FINISHED.has(t.status)).map(t => [t.id, t]));
    const order = new Map(all.map((t, i) => [t.id, i]));
    // len(t) = tasks on the longest open chain ending at t
    const len = new Map<string, number>(), visiting = new Set<string>();
    const L = (id: string): number => {
      if (len.has(id)) return len.get(id)!;
      if (visiting.has(id)) return 0; // an imported plan can hold a cycle: do not follow it
      visiting.add(id);
      const v = 1 + Math.max(0, ...(open.get(id)!.depends as string[]).filter(d => open.has(d)).map(L));
      visiting.delete(id); len.set(id, v);
      return v;
    };
    let end: string | null = null;
    for (const id of open.keys()) if (!end || L(id) > L(end)) end = id;
    const path: string[] = [];
    for (let cur = end; cur; ) {
      path.unshift(cur);
      const want = L(cur) - 1;
      cur = want > 0 ? (open.get(cur)!.depends as string[]).filter(d => open.has(d) && L(d) === want).sort((a, b) => order.get(a)! - order.get(b)!)[0] ?? null : null;
    }
    const byPhase = (n: number) => all.filter(t => t.phase_n === n);
    const known = new Set(phases.map(p => p.n));
    const loose = all.filter(t => !known.has(t.phase_n));
    const sessions = await Promise.all(sess.filter(s => !s.parent && s.state !== "left").map(async s => {
      const cur = await this.current(s.name);
      const n = await this.next(s.name);
      const ct = cur ? all.find(t => t.id === cur) : null;
      return { name: s.name, state: s.state, current: ct ? { id: ct.id, title: ct.title } : null,
        next: n.done || n.id === cur ? null : { id: n.id, title: n.title, ready: n.ready } };
    }));
    return {
      title: this.config().title, orchestrator: this.config().orchestrator,
      done: all.length - open.size, total: all.length,
      phases: [...phases.map(p => ({ n: p.n, title: p.title, done: byPhase(p.n).filter(t => FINISHED.has(t.status)).length, total: byPhase(p.n).length })),
        ...(loose.length ? [{ n: null, title: "(no phase)", done: loose.filter(t => FINISHED.has(t.status)).length, total: loose.length }] : [])],
      sessions,
      critical_path: path.map(id => { const t = open.get(id)!; return { id, title: t.title, owner: t.owner, status: t.status }; }),
    };
  }
  async stats() {
    const c = async (q: string) => (await this.store.get(q))!.n as number;
    const [events, tasks, done, sessions, knowledge, open_asks, last] = await Promise.all([
      c(`SELECT ${COUNT} n FROM events`), c(`SELECT ${COUNT} n FROM tasks`), c(`SELECT ${COUNT} n FROM tasks WHERE status IN ('done','skipped')`),
      c(`SELECT ${COUNT} n FROM sessions WHERE state != 'left'`), c(`SELECT ${COUNT} n FROM knowledge`),
      c(`SELECT ${COUNT} n FROM events e WHERE needs_reply=1 AND NOT EXISTS (SELECT 1 FROM events r WHERE r.reply_to=e.seq)`), this.lastSeq()]);
    return { events, tasks, done, sessions, knowledge, open_asks, last };
  }
}
