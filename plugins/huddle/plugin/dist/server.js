// generated from plugin/server/server.ts by scripts/build.mjs (bun run build): edit the source

// plugin/server/src/hub.ts
import { readdirSync, existsSync as existsSync3, mkdirSync as mkdirSync2 } from "node:fs";

// plugin/server/src/channel.ts
import { AsyncLocalStorage } from "node:async_hooks";
var OWNER = "owner";
var NAME_RE = /^[a-z][a-z0-9_-]{0,31}(\.[a-z0-9][a-z0-9_-]{0,31})?$/;
var parentOf = (n) => n.includes(".") ? n.slice(0, n.indexOf(".")) : null;
var TOPIC_RE = /^[a-z][a-z0-9_.*-]{0,63}$/;
var STATES = ["working", "waiting", "paused", "idle", "blocked", "left"];
var KB_KINDS = ["fact", "lesson", "decision", "context", "result", "howto"];
var STATUSES = ["todo", "doing", "done", "blocked", "skipped"];
var NOTE_KINDS = ["note", "change", "optimize", "enhance", "direction", "question"];
var CONTEXTS = ["sync", "fresh"];
var FINISHED = /* @__PURE__ */ new Set(["done", "skipped"]);
var STOP = new Set("the and for with from that this into what when then than have has are was were will not but you your our its any all each per via use uses using".split(" "));
var PRESENCE_STALE_S = 900;
var HuddleError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
var bad = (m) => new HuddleError(400, m);
var now = () => (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "Z");
var J = (v) => v == null ? null : JSON.stringify(v);
var P = (v, d = null) => {
  if (v == null) return d;
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};
var COUNT = "CAST(COUNT(*) AS INTEGER)";
function globMatch(topic, globs) {
  if (!globs.length) return true;
  return globs.some((g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(topic));
}
var JSON_FIELDS = ["alternatives", "how", "snippets", "verify", "files", "refs"];
var TEXT_FIELDS = ["what", "why", "use", "value", "rollback", "notes", "kind", "gate", "risk"];
var EDITABLE = /* @__PURE__ */ new Set(["title", ...JSON_FIELDS, ...TEXT_FIELDS]);
var held = new AsyncLocalStorage();
var Channel = class _Channel {
  constructor(name, store) {
    this.name = name;
    this.store = store;
  }
  name;
  store;
  waiters = /* @__PURE__ */ new Set();
  listeners = /* @__PURE__ */ new Set();
  seen = /* @__PURE__ */ new Map();
  // last_seen writes, throttled
  metaC = /* @__PURE__ */ new Map();
  // meta, read once: this process is the only writer
  metaP = /* @__PURE__ */ new Map();
  // meta written by the open transaction
  chain = Promise.resolve();
  pending = [];
  get fts() {
    return this.store.fts;
  }
  static async open(name, store) {
    await store.init();
    const c = new _Channel(name, store);
    for (const r of await store.all("SELECT key, value FROM meta")) c.metaC.set(r.key, r.value);
    if (!c.meta("created_at")) await c.serial(() => c.setMeta("created_at", now()));
    return c;
  }
  async close() {
    this.cancelAll();
    await this.chain.catch(() => {
    });
    await this.store.close();
  }
  cancels = /* @__PURE__ */ new Set();
  cancelAll() {
    for (const c of [...this.cancels]) c();
  }
  // ── writes: one at a time per channel; a write called from a write runs inline ──
  serial(fn) {
    const mine = held.getStore();
    if (mine?.has(this)) return fn();
    const run = () => held.run(/* @__PURE__ */ new Set([...mine ?? [], this]), fn);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {
    });
    return p;
  }
  // one transaction; meta and live events it produced take effect only when it commits
  async tx(fn) {
    try {
      const r = await this.store.tx(fn);
      for (const [k, v] of this.metaP) v == null ? this.metaC.delete(k) : this.metaC.set(k, v);
      this.metaP.clear();
      return r;
    } catch (e) {
      this.metaP.clear();
      this.pending = [];
      throw e;
    }
  }
  // ── meta and config ─────────────────────────────────────────────────────────
  meta(k) {
    return this.metaP.has(k) ? this.metaP.get(k) : this.metaC.get(k) ?? null;
  }
  async setMeta(k, v, q = this.store) {
    if (v == null) await q.run("DELETE FROM meta WHERE key=?", [k]);
    else await q.run("INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
    if (q !== this.store) this.metaP.set(k, v);
    else if (v == null) this.metaC.delete(k);
    else this.metaC.set(k, v);
  }
  // handover: {sender: {to, topics[]}} — publishing one of these topics passes the turn to `to`
  config() {
    return {
      title: this.meta("title") ?? this.name,
      description: this.meta("description") ?? "",
      start: this.meta("turn_start"),
      handover: P(this.meta("handover"), {}),
      profile: this.meta("profile"),
      repo: this.meta("repo"),
      created_at: this.meta("created_at"),
      // who may join; empty = any local session. A member's subagents (<member>.<role>) may always join.
      members: P(this.meta("members"), []),
      // the session that runs the plan with the owner: import_plan, configure, approve, assign, brief
      orchestrator: this.meta("orchestrator")
    };
  }
  configure(c) {
    return this.serial(async () => {
      if (c.start !== void 0 && c.start && !NAME_RE.test(c.start)) throw bad("bad start");
      if (c.handover !== void 0) {
        for (const [k, v] of Object.entries(c.handover ?? {})) if (!NAME_RE.test(k) || !NAME_RE.test(v?.to ?? "") || !Array.isArray(v.topics)) throw bad("handover: {sender: {to, topics[]}}");
      }
      if (c.orchestrator !== void 0 && c.orchestrator && (!NAME_RE.test(c.orchestrator) || c.orchestrator.includes("."))) throw bad("orchestrator: a session name (not a subagent)");
      if (c.members !== void 0 && (!Array.isArray(c.members) || c.members.some((m) => typeof m !== "string" || !NAME_RE.test(m) || m.includes(".")))) throw bad("members: session names");
      if (c.title != null) await this.setMeta("title", String(c.title).slice(0, 120));
      if (c.description != null) await this.setMeta("description", String(c.description).slice(0, 2e3));
      if (c.start !== void 0) await this.setMeta("turn_start", c.start || null);
      if (c.handover !== void 0) await this.setMeta("handover", JSON.stringify(c.handover ?? {}));
      if (c.profile !== void 0) await this.setMeta("profile", c.profile || null);
      if (c.members !== void 0) await this.setMeta("members", JSON.stringify(c.members));
      if (c.repo !== void 0) await this.setMeta("repo", c.repo || null);
      if (c.orchestrator !== void 0) await this.setMeta("orchestrator", c.orchestrator || null);
      this.emit("channel", this.config());
      return this.config();
    });
  }
  // ── live fan-out (UI, stdio bridges) and waiters ────────────
  subscribe(f) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
  emit(type, data) {
    const m = { ch: this.name, type, data, at: (/* @__PURE__ */ new Date()).toISOString() };
    for (const f of this.listeners) try {
      f(m);
    } catch {
    }
  }
  // every waiter queries again, outside the write lock
  wake() {
    held.exit(() => {
      for (const w of [...this.waiters]) w.poke();
    });
  }
  // Register, then query; a poke while a query runs makes it query once more. onMiss runs once,
  // when the first query finds nothing. The promise settles once: hit, timeout or cancel.
  block(check, timeoutS, signal, onMiss) {
    return new Promise((res, rej) => {
      let done = false, busy = false, again = false, first = true;
      let tm = null;
      const end = () => {
        done = true;
        this.waiters.delete(w);
        this.cancels.delete(ab);
        if (tm) clearTimeout(tm);
        signal?.removeEventListener("abort", ab);
      };
      const finish = (h) => {
        if (done) return;
        end();
        res(h);
      };
      const poke = async () => {
        if (done) return;
        if (busy) {
          again = true;
          return;
        }
        busy = true;
        try {
          do {
            again = false;
            const h = await check();
            if (done) return;
            if (h) return finish(h);
            if (first) {
              first = false;
              onMiss?.();
            }
          } while (again);
        } catch (e) {
          if (!done) {
            end();
            rej(e);
          }
        } finally {
          busy = false;
        }
      };
      const w = { poke };
      const ab = () => finish({ kind: "cancelled" });
      this.waiters.add(w);
      this.cancels.add(ab);
      if (timeoutS > 0) tm = setTimeout(() => finish({ kind: "timeout" }), timeoutS * 1e3);
      if (signal) {
        if (signal.aborted) return ab();
        signal.addEventListener("abort", ab);
      }
      poke();
    });
  }
  // a wait that marks the session's presence while it sleeps, and restores it afterwards
  async sleep(name, check, timeoutS, signal, asleep, awake) {
    let marked = null;
    const h = await this.block(check, timeoutS, signal, () => {
      marked = asleep().then((p) => this.presence(name, p)).catch(() => {
      });
    });
    if (marked) await marked;
    await awake(h);
    return h;
  }
  // ── sessions ────────────────────────────────────────────────────────────────
  session(name) {
    return this.store.get("SELECT * FROM sessions WHERE name=?", [name]);
  }
  async need(name) {
    if (name === OWNER) return { name, control: "run", cursor: 0 };
    const s2 = await this.session(name);
    if (!s2) throw new HuddleError(404, `"${name}" has not joined channel ${this.name} (call join first)`);
    return s2;
  }
  async touch(name) {
    if (name === OWNER) return;
    const t = Date.now();
    if (t - (this.seen.get(name) ?? 0) < 5e3) return;
    this.seen.set(name, t);
    await this.serial(() => this.store.run("UPDATE sessions SET last_seen=? WHERE name=?", [now(), name]));
  }
  // context: "sync" reads on from the session's cursor; "fresh" moves the cursor to the present
  // and returns a brief instead (open asks are kept either way). Default: fresh for a subagent and
  // for a session's first join; on a return, the orchestrator's setting for it (assign), else sync.
  async join(name, o = {}) {
    if (!NAME_RE.test(name) || name === OWNER || name === "all") throw bad(`session name must match ${NAME_RE} and not be owner/all`);
    if (o.context && !CONTEXTS.includes(o.context)) throw bad(`context must be one of ${CONTEXTS.join(", ")}`);
    return this.serial(async () => {
      const parent = parentOf(name);
      if (parent && !await this.session(parent)) throw bad(`${parent} must join before its subagent ${name}`);
      const members = this.config().members;
      if (members.length && !members.includes(parent ?? name)) throw new HuddleError(403, `channel ${this.name} admits ${members.join(", ")} (the owner adds members)`);
      const prev = await this.session(name);
      const mode = o.context || (parent || !prev ? "fresh" : prev.context ?? "sync");
      const t = now();
      await this.store.run(`INSERT INTO sessions (name, label, role, joined_at, last_seen, state, task, parent) VALUES (?,?,?,?,?, 'working', ?, ?)
        ON CONFLICT(name) DO UPDATE SET label=COALESCE(excluded.label, sessions.label), role=COALESCE(excluded.role, sessions.role),
        last_seen=excluded.last_seen, state='working', task=excluded.task`, [name, o.label ?? null, o.role ?? null, t, t, o.task ?? "joined", parent]);
      const skipped = (await this.store.get(`SELECT ${COUNT} n FROM events WHERE seq > ? AND from_name != ?`, [prev?.cursor ?? 0, name])).n;
      await this.append(name, {
        topic: "session.joined",
        msg: `${name} ${prev && prev.state !== "left" ? "returned" : "joined"}${o.role ? ": " + o.role : ""}`,
        data: { context: mode, skipped, returning: !!prev && prev.state !== "left" }
      });
      let brief = null;
      if (mode === "fresh") {
        const s2 = await this.session(name);
        await this.store.run("UPDATE sessions SET cursor=?, brief=NULL WHERE name=?", [await this.lastSeq(), name]);
        brief = await this.briefFor(name, o.role ?? s2.role, P(s2.brief));
      }
      this.emit("presence", await this.presenceOf(name));
      return this.snapshot(name, { context: mode, skipped, brief });
    });
  }
  // a subagent (or a session) is done: it stays in the history, out of the live views
  leave(name, summary = "") {
    return this.serial(async () => {
      await this.need(name);
      await this.append(name, { topic: "session.left", msg: summary ? `${name} left: ${summary}` : `${name} left` });
      return this.presence(name, { state: "left", task: summary || "left" });
    });
  }
  presence(name, p) {
    return this.serial(async () => {
      await this.need(name);
      if (p.state && !STATES.includes(p.state)) throw bad(`state must be one of ${STATES.join(", ")}`);
      const step = p.step !== void 0 ? ", step=?" : "";
      await this.store.run(
        `UPDATE sessions SET state=COALESCE(?, state), task=COALESCE(?, task), last_seen=?${step} WHERE name=?`,
        [p.state ?? null, p.task ?? null, now(), ...step ? [p.step ?? null] : [], name]
      );
      this.seen.set(name, Date.now());
      const out = await this.presenceOf(name);
      this.emit("presence", out);
      return out;
    });
  }
  shape(s2) {
    const age = (Date.now() - Date.parse(s2.last_seen)) / 1e3;
    return {
      name: s2.name,
      parent: s2.parent ?? null,
      label: s2.label,
      role: s2.role,
      state: s2.state,
      task: s2.task,
      step: s2.step,
      last_seen: s2.last_seen,
      stale: age > PRESENCE_STALE_S,
      control: s2.control,
      control_by: s2.control_by,
      control_at: s2.control_at,
      cursor: s2.cursor,
      context: s2.context ?? null,
      brief_waiting: !!s2.brief
    };
  }
  // the orchestrator (or the owner) sets how a session's next return joins, and can hand it a task
  assign(by, session, context, task) {
    return this.serial(async () => {
      await this.need(session);
      if (context != null && !CONTEXTS.includes(context)) throw bad(`context must be one of ${CONTEXTS.join(", ")} or null`);
      if (task) await this.updateTask(by, task, { owner: session });
      await this.store.run("UPDATE sessions SET context=? WHERE name=?", [context ?? null, session]);
      this.emit("presence", await this.presenceOf(session));
      return { session, context: context ?? null, task: task ?? null };
    });
  }
  // a brief for a session's next fresh join (kept until then; a newer one replaces it), sent now as a msg too
  brief(by, session, msg) {
    return this.serial(async () => {
      await this.need(session);
      if (!msg?.trim() || msg.length > 2e4) throw bad("need msg (\u2264 20000 chars)");
      const at = now();
      await this.store.run("UPDATE sessions SET brief=? WHERE name=?", [JSON.stringify({ msg: msg.trim(), by, at }), session]);
      const ev2 = await this.append(by, { topic: "msg", to: session, msg: msg.trim(), data: { brief: true } });
      return { session, stored: true, event: ev2.seq };
    });
  }
  // what a fresh join gets instead of the backlog: the channel's goal, the orchestrator's brief, the
  // session's own open tasks with what they wait on, the 5 knowledge entries nearest to its role
  // and task, and every open ask
  async briefFor(name, role, stored) {
    const cfg = this.config();
    const mine = (await this.tasks({ owner: name })).filter((t) => !FINISHED.has(t.status));
    const n = await this.next(name);
    const focus = mine.find((t) => t.status === "doing") ?? (n.done ? mine[0] : n);
    const full = focus ? await this.task(focus.id) : null;
    return {
      title: cfg.title,
      goal: cfg.description,
      orchestrator: cfg.orchestrator,
      from_orchestrator: stored,
      tasks: mine.map((t) => ({ id: t.id, title: t.title, status: t.status, ready: !t.blocked_by.length, waits_on: t.blocked_by })),
      knowledge: await this.relevant([role ?? "", full?.title ?? "", full?.what ?? ""].join(" "), 5),
      asks: (await this.inbox(name)).map((e) => ({ seq: e.seq, from: e.from, msg: e.msg, task: e.data?.task ?? null }))
    };
  }
  // entries recall never shows: superseded ones, and ones moved to the server-wide store (src/knowledge.ts)
  async retired() {
    return new Set((await this.store.all("SELECT supersedes AS id FROM knowledge WHERE supersedes IS NOT NULL UNION SELECT id FROM knowledge WHERE moved_to IS NOT NULL")).map((r) => r.id));
  }
  // knowledge nearest to some text: full-text matches best first (most hits on ties), then the
  // most-read entries; superseded entries never
  async relevant(text, k) {
    const words2 = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])].filter((w) => !STOP.has(w)).slice(0, 16);
    const retired = await this.retired();
    const hits = words2.length && this.fts ? (await this.store.searchKnowledge(words2.join(" "), k * 4)).filter((r) => !retired.has(r.id)) : [];
    hits.sort((a, b2) => Math.round((b2.score - a.score) * 1e6) || b2.hits - a.hits);
    const out = hits.slice(0, k);
    if (out.length < k) {
      for (const r of await this.store.all("SELECT *, substr(body,1,200) hit FROM knowledge ORDER BY hits DESC, id DESC LIMIT ?", [k * 4]))
        if (out.length < k && !retired.has(r.id) && !out.some((x) => x.id === r.id)) out.push(r);
    }
    return out.map((r) => ({ id: r.id, kind: r.kind, title: r.title, by: r.by, hits: r.hits, hit: r.hit }));
  }
  async presenceOf(name) {
    const s2 = await this.session(name);
    return s2 ? this.shape(s2) : null;
  }
  async sessions() {
    const turn = await this.turn();
    const rows = await this.store.all("SELECT * FROM sessions ORDER BY joined_at, name");
    return Promise.all(rows.map(async (s2) => {
      const [u, o] = await Promise.all([
        this.store.get(`SELECT ${COUNT} n FROM events WHERE seq > ? AND from_name != ?`, [s2.cursor, s2.name]),
        this.store.get(`SELECT ${COUNT} n FROM events e WHERE ${this.openAsk}`, [s2.name, s2.name, s2.name])
      ]);
      return { ...this.shape(s2), unread: u.n, open: o.n, holds_turn: turn.holder === s2.name };
    }));
  }
  // ── control: the owner, or any session in the channel, pauses and resumes a session ──
  control(by, target, action, why = "") {
    return this.serial(async () => {
      await this.need(by);
      await this.need(target);
      if (target === OWNER) throw bad("the owner cannot be paused");
      const st = action === "pause" ? "pause" : "run";
      await this.tx(async (q) => {
        await q.run("UPDATE sessions SET control=?, control_by=?, control_at=? WHERE name=?", [st, by, now(), target]);
        await this.insert(q, by, { topic: `control.${action}`, to: target, msg: why || `${by} ${action}d ${target}` });
      });
      this.emit("presence", await this.presenceOf(target));
      this.flush();
      this.wake();
      return { name: target, control: st, by };
    });
  }
  async controlOf(name) {
    return name === OWNER ? "run" : (await this.need(name)).control;
  }
  // s: the session as need() returned it
  mustRun(s2, what) {
    if (s2.control === "pause") throw new HuddleError(423, `${s2.name} is paused by ${s2.control_by} since ${s2.control_at}; ${what} refused. Call gate to wait for resume.`);
  }
  async gate(name, timeoutS = 0, signal) {
    await this.need(name);
    const check = async () => await this.controlOf(name) === "run" ? { kind: "event", control: "run" } : null;
    const h = await this.sleep(
      name,
      check,
      timeoutS,
      signal,
      async () => ({ state: "paused", task: `paused by ${(await this.session(name))?.control_by}` }),
      async (h2) => {
        if (h2.kind === "event" && (await this.session(name))?.state === "paused") await this.presence(name, { state: "working", task: "resumed" });
      }
    );
    if (h.kind === "event") return { control: "run" };
    return { control: await this.controlOf(name), [h.kind]: true };
  }
  // ── events ──────────────────────────────────────────────────────────────────
  toEv(r) {
    return {
      seq: r.seq,
      ts: r.ts,
      from: r.from_name,
      to: r.to_name,
      topic: r.topic,
      ref: r.ref,
      msg: r.msg,
      data: P(r.data),
      reply_to: r.reply_to,
      needs_reply: !!r.needs_reply
    };
  }
  // raw insert, inside a caller's transaction; returns the event (or the earlier one for a repeated key)
  async insert(q, from, e) {
    if (e.key) {
      const dup = await q.get("SELECT * FROM events WHERE from_name=? AND key=?", [from, e.key]);
      if (dup) return { ...this.toEv(dup), duplicate: true };
    }
    const r = await q.get(`INSERT INTO events (ts, from_name, to_name, topic, ref, msg, data, reply_to, needs_reply, key)
      VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`, [
      e.ts ?? now(),
      from,
      e.to ?? null,
      e.topic,
      e.ref ?? null,
      e.msg ?? null,
      J(e.data),
      e.reply_to ?? null,
      e.needs_reply ? 1 : 0,
      e.key ?? null
    ]);
    const ev2 = this.toEv(r);
    await this.advanceTurn(q, ev2);
    this.pending.push(ev2);
    return ev2;
  }
  flush() {
    const p = this.pending;
    this.pending = [];
    for (const ev2 of p) this.emit("event", ev2);
    if (p.length) this.wake();
  }
  append(from, e) {
    return this.serial(async () => {
      const ev2 = await this.tx((q) => this.insert(q, from, e));
      this.flush();
      return ev2;
    });
  }
  publish(from, a) {
    return this.serial(async () => {
      const me = await this.need(from);
      if (!TOPIC_RE.test(a.topic) || a.topic.includes("*")) throw bad(`topic must match ${TOPIC_RE} without *`);
      if (/^(control|reply|session|task)\./.test(a.topic) || a.topic === "reply") throw bad(`topic ${a.topic} is reserved; use the matching tool`);
      if (!a.msg) throw bad("need msg");
      if (a.to && a.to !== OWNER) await this.need(a.to);
      this.mustRun(me, "publish");
      return this.append(from, { topic: a.topic, to: a.to ?? null, ref: a.ref ?? null, msg: String(a.msg).slice(0, 2e4), data: a.data, needs_reply: !!a.needs_reply, key: a.key ?? null });
    });
  }
  // a message to one session (or to everyone, to=null); ask=true puts it in their inbox until they reply
  send(from, to, msg, o = {}) {
    return this.serial(async () => {
      await this.need(from);
      if (to && to !== OWNER) await this.need(to);
      if (!msg) throw bad("need msg");
      return this.append(from, { topic: o.ask ? "ask" : "msg", to, msg: msg.slice(0, 2e4), data: o.task ? { task: o.task } : null, needs_reply: !!o.ask, key: o.key ?? null });
    });
  }
  reply(from, seq, msg) {
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
  async event(seq) {
    const r = await this.store.get("SELECT * FROM events WHERE seq=?", [seq]);
    return r ? this.toEv(r) : null;
  }
  async events(o = {}) {
    const lim = Math.max(1, Math.min(2e3, o.limit ?? 300));
    const w = ["seq > ?"], p = [o.after ?? 0];
    if (o.before != null) {
      w.push("seq < ?");
      p.push(o.before);
    }
    if (o.from != null) {
      w.push("from_name = ?");
      p.push(o.from);
    }
    const rows = await this.store.all(`SELECT * FROM events WHERE ${w.join(" AND ")} ORDER BY seq DESC LIMIT ?`, [...p, lim]);
    return rows.reverse().map((r) => this.toEv(r)).filter((e) => !o.topic || globMatch(e.topic, [o.topic]));
  }
  async lastSeq() {
    return (await this.store.get("SELECT COALESCE(MAX(seq),0) s FROM events")).s;
  }
  // everything this session has not acked yet, in order: every member sees every message, also
  // those addressed to another session (it overhears them); only its own are left out
  async unread(name) {
    const s2 = await this.need(name);
    return (await this.store.all(`SELECT * FROM events WHERE seq > ? AND from_name != ? ORDER BY seq`, [s2.cursor, name])).map((r) => this.toEv(r));
  }
  // messages that wait for this session's reply (asks, and owner directives); params: name ×3
  openAsk = `e.needs_reply = 1 AND e.from_name != ? AND (e.to_name IS NULL OR e.to_name = ?)
    AND NOT EXISTS (SELECT 1 FROM events r WHERE r.reply_to = e.seq AND r.from_name = ?)`;
  async inbox(name) {
    return (await this.store.all(`SELECT e.* FROM events e WHERE ${this.openAsk} ORDER BY e.seq`, [name, name, name])).map((r) => this.toEv(r));
  }
  ack(name, seq) {
    return this.serial(async () => {
      const s2 = await this.need(name);
      if (!Number.isInteger(seq) || seq < 0) throw bad("seq must be an integer");
      const top = Math.min(seq, await this.lastSeq());
      if (top > s2.cursor) await this.store.run("UPDATE sessions SET cursor=? WHERE name=?", [top, name]);
      const cursor = Math.max(top, s2.cursor);
      this.emit("ack", { name, cursor });
      return { cursor };
    });
  }
  // Block until (1) a message waits for this session's reply → kind "message"; (2) the first
  // unread event for this session (to it or to everyone) that matches a topic glob → kind "event",
  // with the unread events before it, overheard ones included ("skipped": acking the hit moves the
  // cursor past them); (3) the timeout. A message to another session never wakes this one.
  async wait(name, topics, timeoutS = 0, signal) {
    const before = await this.need(name);
    for (const t of topics) if (!TOPIC_RE.test(t)) throw bad(`bad topic glob ${t}`);
    const check = async () => {
      const ib = await this.inbox(name);
      if (ib.length) return { kind: "message", ...ib[0], more: ib.length - 1 };
      const all = await this.unread(name);
      const i2 = all.findIndex((e) => (!e.to || e.to === name) && globMatch(e.topic, topics));
      if (i2 < 0) return null;
      const sk = all.slice(0, i2);
      return { kind: "event", ...all[i2], skipped: sk.slice(-25).map((e) => ({ seq: e.seq, from: e.from, to: e.to, topic: e.topic, msg: e.msg?.slice(0, 200) ?? null })), skipped_total: sk.length };
    };
    return this.sleep(
      name,
      check,
      timeoutS,
      signal,
      async () => ({ state: "waiting", task: `waiting for ${topics.join(" ") || "any event"}` }),
      async (h) => {
        const s2 = await this.session(name);
        if (s2?.state === "waiting") await this.presence(name, { state: before.state === "waiting" ? "working" : before.state, task: h.kind === "timeout" ? "wait timed out" : "handling a wake-up" });
      }
    );
  }
  // ── the turn: who may work now ──────────────────────────────────────────────
  // turn.pass (to X) gives it to X; turn.take gives it to the sender; a sender's handover topic
  // gives it to that sender's handover target. Kept materialized: O(1) to read.
  async advanceTurn(q, e) {
    const h = this.config().handover;
    let holder = null;
    if (e.topic === "turn.take") holder = e.from;
    else if (e.topic === "turn.pass" && e.to) holder = e.to;
    else if (h[e.from]?.topics.includes(e.topic)) holder = h[e.from].to;
    if (holder) {
      await this.setMeta("turn_holder", holder, q);
      await this.setMeta("turn_seq", String(e.seq), q);
    }
  }
  async turn() {
    const seq = Number(this.meta("turn_seq") ?? 0);
    return { holder: this.meta("turn_holder") ?? this.config().start ?? null, since: seq ? await this.event(seq) : null };
  }
  passTurn(from, to, msg = "") {
    return this.serial(async () => {
      const me = await this.need(from);
      await this.need(to);
      this.mustRun(me, "turn.pass");
      return this.append(from, { topic: "turn.pass", to, msg: msg || `${from} hands the turn to ${to}` });
    });
  }
  takeTurn(from, msg = "") {
    return this.serial(async () => {
      this.mustRun(await this.need(from), "turn.take");
      return this.append(from, { topic: "turn.take", msg: msg || `${from} takes the turn` });
    });
  }
  // recompute the materialized turn from the whole history (after an import)
  replayTurn() {
    return this.serial(() => this.tx(async (q) => {
      await this.setMeta("turn_holder", null, q);
      await this.setMeta("turn_seq", null, q);
      for (const r of await q.all("SELECT * FROM events ORDER BY seq")) await this.advanceTurn(q, this.toEv(r));
    }));
  }
  // ── tasks: the plan, shared by every session ────────────────────────────────
  rawTask(id, q = this.store) {
    return q.get("SELECT * FROM tasks WHERE id=?", [id]);
  }
  async editsBy(q = this.store) {
    const m = /* @__PURE__ */ new Map();
    for (const e of await q.all("SELECT * FROM edits")) (m.get(e.task_id) ?? m.set(e.task_id, []).get(e.task_id)).push(e);
    return m;
  }
  // a task as the views see it: body fields flattened, owner edits applied, depends = after
  effective(r, edits) {
    const body2 = P(r.body, {});
    const out = {
      ...body2,
      id: r.id,
      phase_n: r.phase,
      ord: r.ord,
      title: r.title,
      owner: r.owner,
      status: r.status,
      depends: P(r.after, []),
      origin: r.origin,
      created_by: r.created_by,
      status_at: r.status_at,
      status_by: r.status_by,
      status_note: r.status_note
    };
    for (const f of JSON_FIELDS) out[f] ??= [];
    out.edited = {};
    for (const e of edits) {
      out.edited[e.field] = { original: out[e.field], at: e.at, by: e.by };
      out[e.field] = P(e.value, e.value);
    }
    return out;
  }
  async task(id) {
    const r = await this.rawTask(id);
    if (!r) return null;
    const [edits, comments, all] = await Promise.all([
      this.store.all("SELECT * FROM edits WHERE task_id=?", [id]),
      this.store.all("SELECT * FROM notes WHERE task_id=? ORDER BY created_at, id", [id]),
      this.store.all("SELECT id, after, status, owner, title FROM tasks")
    ]);
    const e = this.effective(r, edits);
    e.comments = comments;
    const st = new Map(all.map((x) => [x.id, x]));
    e.needed_by = all.filter((x) => P(x.after, []).includes(id)).map((x) => x.id);
    e.unmet = e.depends.filter((d) => !FINISHED.has(st.get(d)?.status ?? "todo")).map((d) => ({ id: d, owner: st.get(d)?.owner ?? null, status: st.get(d)?.status ?? "missing", title: st.get(d)?.title ?? null }));
    e.ready = e.unmet.length === 0;
    e.open_notes = e.comments.filter((c) => !c.resolved);
    return e;
  }
  // every task, in plan order, for lists and the kanban (3 queries, no per-row lookups)
  async tasks(o = {}) {
    const [edits, countRows, rows] = await Promise.all([
      this.editsBy(),
      this.store.all(`SELECT task_id, ${COUNT} n, CAST(SUM(CASE WHEN resolved=0 THEN 1 ELSE 0 END) AS INTEGER) open, GROUP_CONCAT(DISTINCT kind) kinds FROM notes GROUP BY task_id`),
      this.store.all("SELECT * FROM tasks ORDER BY phase, ord, id")
    ]);
    const counts = new Map(countRows.map((c) => [c.task_id, c]));
    const status = new Map(rows.map((r) => [r.id, r.status]));
    return rows.filter((r) => (o.owner === void 0 || r.owner === o.owner) && (!o.status || r.status === o.status) && (o.phase === void 0 || r.phase === o.phase)).map((r) => {
      const e = this.effective(r, edits.get(r.id) ?? []);
      const c = counts.get(r.id);
      return {
        id: e.id,
        phase_n: e.phase_n,
        title: e.title,
        owner: e.owner,
        kind: e.kind,
        gate: e.gate,
        risk: e.risk,
        status: e.status,
        value: e.value,
        depends: e.depends,
        status_by: e.status_by,
        blocked_by: e.depends.filter((d) => !FINISHED.has(status.get(d) ?? "todo")),
        comments: c ? { n: c.n, open: c.open, kinds: String(c.kinds ?? "").split(",") } : null,
        edited: Object.keys(e.edited).length > 0
      };
    });
  }
  // the first unfinished task this session should work: its own or an unowned one, in plan order
  async next(name) {
    await this.need(name);
    const r = await this.store.get(`SELECT id FROM tasks WHERE status NOT IN ('done','skipped') AND (owner = ? OR owner IS NULL)
      ORDER BY phase, ord, id LIMIT 1`, [name]);
    return r ? await this.task(r.id) : { done: true };
  }
  async checkAfter(id, after, q = this.store) {
    const graph = new Map((await q.all("SELECT id, after FROM tasks")).map((r) => [r.id, P(r.after, [])]));
    for (const d of after) if (!graph.has(d)) throw bad(`depends on unknown task ${d}`);
    graph.set(id, after);
    const seen = /* @__PURE__ */ new Set(), stack = [...after];
    while (stack.length) {
      const x = stack.pop();
      if (x === id) throw bad(`dependency cycle through ${id}`);
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...graph.get(x) ?? []);
    }
  }
  createTask(by, t) {
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
      const ev2 = await this.tx(async (q) => {
        const ord = (await q.get("SELECT COALESCE(MAX(ord),-1)+1 o FROM tasks WHERE phase=?", [phase])).o;
        await q.run(`INSERT INTO tasks (id, phase, ord, title, owner, status, after, body, origin, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [id, phase, ord, t.title, t.owner ?? null, t.status ?? "todo", J(after), J(t.body ?? {}), by === OWNER ? "owner" : "session", by, now()]);
        return this.insert(q, by, { topic: "task.created", to: t.owner && t.owner !== by ? t.owner : null, ref: id, msg: `${id} ${t.title}${t.owner ? ` \u2192 ${t.owner}` : ""}${after.length ? ` after ${after.join(", ")}` : ""}`, data: { task: id } });
      });
      await this.reindex([id]);
      this.flush();
      this.emit("task", await this.taskBrief(id));
      return { task: await this.task(id), event: ev2 };
    });
  }
  // owner, depends, title or a body field; body fields keep the original for the "edited" view
  updateTask(by, id, f) {
    return this.serial(async () => {
      await this.need(by);
      const r = await this.rawTask(id);
      if (!r) throw new HuddleError(404, `no task ${id}`);
      if (f.owner !== void 0 && f.owner && f.owner !== OWNER) await this.need(f.owner);
      if (f.after !== void 0) await this.checkAfter(id, f.after);
      if (f.field !== void 0 && !EDITABLE.has(f.field)) throw bad(`field ${f.field} is not editable`);
      await this.tx(async (q) => {
        if (f.owner !== void 0) {
          await q.run("UPDATE tasks SET owner=? WHERE id=?", [f.owner, id]);
          await this.insert(q, by, { topic: "task.assigned", to: f.owner && f.owner !== by ? f.owner : null, ref: id, msg: `${id} \u2192 ${f.owner ?? "nobody"}`, data: { task: id, owner: f.owner } });
        }
        if (f.after !== void 0) await q.run("UPDATE tasks SET after=? WHERE id=?", [J(f.after), id]);
        if (f.field !== void 0) {
          if (f.value === null) await q.run("DELETE FROM edits WHERE task_id=? AND field=?", [id, f.field]);
          else await q.run(`INSERT INTO edits (task_id, field, value, by, at) VALUES (?,?,?,?,?)
            ON CONFLICT(task_id, field) DO UPDATE SET value=excluded.value, by=excluded.by, at=excluded.at`, [id, f.field, JSON.stringify(f.value), by, now()]);
        }
        if (f.after !== void 0) await this.releaseReadyTx(q, by, [id]);
      });
      await this.reindex([id]);
      this.flush();
      this.emit("task", await this.taskBrief(id));
      return await this.task(id);
    });
  }
  // Moving a task to done/skipped releases every task that waited only on it: each gets a
  // task.ready event addressed to its owner, so a session blocked on another's work wakes up.
  setStatus(by, id, status, note = "") {
    return this.serial(async () => {
      const me = await this.need(by);
      if (!STATUSES.includes(status)) throw bad(`status must be one of ${STATUSES.join(", ")}`);
      const r = await this.rawTask(id);
      if (!r) throw new HuddleError(404, `no task ${id}`);
      this.mustRun(me, "task status");
      if (status === "doing") {
        const st = await this.statusMap();
        const unmet = P(r.after, []).filter((d) => !FINISHED.has(st.get(d) ?? "todo"));
        if (unmet.length) throw new HuddleError(409, `${id} waits on ${unmet.join(", ")}; wait for task.ready (or the owner edits its dependencies)`);
      }
      await this.tx(async (q) => {
        await q.run("UPDATE tasks SET status=?, status_by=?, status_at=?, status_note=? WHERE id=?", [status, by, now(), note, id]);
        await this.insert(q, by, { topic: "task.status", ref: id, msg: `${id} \u2192 ${status}${note ? ` \xB7 ${note}` : ""}`, data: { task: id, status, note } });
        if (FINISHED.has(status)) {
          const waiting = (await q.all("SELECT id, after FROM tasks WHERE status NOT IN ('done','skipped')")).filter((d) => P(d.after, []).includes(id));
          await this.releaseReadyTx(q, by, waiting.map((d) => d.id));
        }
      });
      this.flush();
      this.emit("task", await this.taskBrief(id));
      return { ok: true, id, status };
    });
  }
  async statusMap(q = this.store) {
    return new Map((await q.all("SELECT id, status FROM tasks")).map((r) => [r.id, r.status]));
  }
  // each of these tasks that is open and has nothing left to wait on gets task.ready
  async releaseReadyTx(q, by, ids) {
    if (!ids.length) return;
    const st = await this.statusMap(q);
    for (const id of ids) {
      const d = await this.rawTask(id, q);
      const deps = P(d.after, []);
      if (deps.length && !FINISHED.has(d.status) && deps.every((x) => FINISHED.has(st.get(x) ?? "todo")))
        await this.insert(q, by, { topic: "task.ready", to: d.owner ?? null, ref: d.id, msg: `${d.id} ${d.title}: everything it waits on is done`, data: { task: d.id, after: deps } });
    }
  }
  // block until a task is done or skipped (a session that needs another's work before its own)
  async waitTask(name, id, timeoutS = 0, signal) {
    await this.need(name);
    if (!await this.rawTask(id)) throw new HuddleError(404, `no task ${id}`);
    const check = async () => {
      const t = await this.rawTask(id);
      return t && FINISHED.has(t.status) ? { kind: "event", task: id, status: t.status, by: t.status_by, note: t.status_note } : null;
    };
    return this.sleep(
      name,
      check,
      timeoutS,
      signal,
      async () => ({ state: "waiting", task: `waiting for task ${id}` }),
      async (h) => {
        if ((await this.session(name))?.state === "waiting") await this.presence(name, { state: "working", task: h.kind === "timeout" ? "wait timed out" : `task ${id} finished` });
      }
    );
  }
  // block until `from` (or anyone it was sent to) answers the message at seq
  async waitReply(name, seq, timeoutS = 0, signal) {
    await this.need(name);
    const check = async () => {
      const r = await this.store.get("SELECT * FROM events WHERE reply_to=? ORDER BY seq LIMIT 1", [seq]);
      return r ? { kind: "event", ...this.toEv(r) } : null;
    };
    return this.sleep(
      name,
      check,
      timeoutS,
      signal,
      async () => ({ state: "waiting", task: `waiting for a reply to #${seq}` }),
      async (h) => {
        if ((await this.session(name))?.state === "waiting") await this.presence(name, { state: "working", task: h.kind === "timeout" ? "no reply yet" : `reply to #${seq} received` });
      }
    );
  }
  // the task a session is working now (its newest "doing" one)
  async current(name) {
    return (await this.store.get("SELECT id FROM tasks WHERE status='doing' AND (owner=? OR status_by=?) ORDER BY status_at DESC LIMIT 1", [name, name]))?.id ?? null;
  }
  note(by, id, kind, body2) {
    return this.serial(async () => {
      if (!await this.rawTask(id)) throw new HuddleError(404, `no task ${id}`);
      if (!NOTE_KINDS.includes(kind)) throw bad(`kind must be one of ${NOTE_KINDS.join(", ")}`);
      if (!body2?.trim() || body2.length > 2e4) throw bad("need body (\u2264 20000 chars)");
      await this.store.run("INSERT INTO notes (task_id, kind, body, by, created_at) VALUES (?,?,?,?,?)", [id, kind, body2.trim(), by, now()]);
      this.emit("task", await this.taskBrief(id));
      return await this.task(id);
    });
  }
  editNote(id, f) {
    return this.serial(async () => {
      const c = await this.store.get("SELECT task_id FROM notes WHERE id=?", [id]);
      if (!c) throw new HuddleError(404, "no such note");
      if (f.remove) await this.store.run("DELETE FROM notes WHERE id=?", [id]);
      else {
        if (typeof f.resolved === "boolean") await this.store.run("UPDATE notes SET resolved=? WHERE id=?", [f.resolved ? 1 : 0, id]);
        if (typeof f.body === "string" && f.body.trim()) await this.store.run("UPDATE notes SET body=? WHERE id=?", [f.body.trim(), id]);
      }
      this.emit("task", await this.taskBrief(c.task_id));
      return await this.task(c.task_id);
    });
  }
  async taskBrief(id) {
    const r = await this.rawTask(id);
    return r ? { id, status: r.status, owner: r.owner, title: r.title } : { id, removed: true };
  }
  // ── phases and the plan import ──────────────────────────────────────────────
  async phases() {
    return (await this.store.all("SELECT * FROM phases ORDER BY n")).map((p) => ({ n: p.n, title: p.title, ...P(p.body, {}) }));
  }
  // Load a plan: phases with their tasks. Content (title, body, order, dependencies) comes from
  // the plan; state (status, owner edits, notes) is kept by id. A task whose title changed under
  // owner state is reported in "moved". Tasks the plan no longer has are removed unless a session
  // or the owner created them.
  importPlan(by, plan, o = {}) {
    return this.serial(async () => {
      const old = new Map((await this.store.all("SELECT id, title FROM tasks")).map((r) => [r.id, r.title]));
      const keep = /* @__PURE__ */ new Set(), errors = [];
      await this.tx(async (q) => {
        await q.run("DELETE FROM phases");
        for (const p of plan.phases ?? []) {
          const { steps, n, title, ...rest } = p;
          await q.run("INSERT INTO phases (n, title, body) VALUES (?,?,?)", [Number(n), String(title ?? `Phase ${n}`), J(rest)]);
          for (const [i2, st] of (steps ?? []).entries()) {
            const { id, title: tt, status, depends, owner, ...body2 } = st;
            const sid = String(id);
            keep.add(sid);
            await q.run(
              `INSERT INTO tasks (id, phase, ord, title, owner, status, after, body, origin, created_by, created_at)
              VALUES (?,?,?,?,?,?,?,?, 'plan', ?, ?)
              ON CONFLICT(id) DO UPDATE SET phase=excluded.phase, ord=excluded.ord, title=excluded.title, after=excluded.after, body=excluded.body, origin='plan'`,
              [
                sid,
                Number(n),
                i2,
                String(tt ?? sid),
                owner ?? o.owner ?? null,
                STATUSES.includes(status) ? status : "todo",
                J(depends ?? []),
                J(body2),
                by,
                now()
              ]
            );
          }
        }
        for (const r of await q.all("SELECT id, status FROM tasks WHERE origin='plan'")) if (!keep.has(r.id)) {
          const owned2 = await q.get("SELECT 1 FROM notes WHERE task_id=? UNION SELECT 1 FROM edits WHERE task_id=?", [r.id, r.id]) || r.status !== "todo";
          if (owned2) errors.push(`${r.id} left the plan but has owner state; kept`);
          else await q.run("DELETE FROM tasks WHERE id=?", [r.id]);
        }
        const rows = await q.all("SELECT id, after FROM tasks");
        const ids = new Set(rows.map((r) => r.id));
        for (const r of rows) for (const d of P(r.after, [])) if (!ids.has(d)) errors.push(`${r.id} depends on unknown ${d}`);
      });
      const owned = new Set((await this.store.all("SELECT task_id id FROM notes UNION SELECT task_id FROM edits UNION SELECT id FROM tasks WHERE status != 'todo'")).map((r) => r.id));
      const nowT = new Map((await this.store.all("SELECT id, title FROM tasks")).map((r) => [r.id, r.title]));
      const moved = P(this.meta("plan_moved"), []).filter((m) => owned.has(m.id) && nowT.get(m.id) !== m.was);
      for (const id of owned) if (old.has(id) && old.get(id) !== nowT.get(id) && !moved.some((m) => m.id === id)) moved.push({ id, was: old.get(id), now: nowT.get(id) ?? null });
      await this.setMeta("plan_moved", JSON.stringify(moved));
      await this.setMeta("plan_at", now());
      await this.reindex();
      this.emit("plan", { tasks: keep.size });
      return { phases: (plan.phases ?? []).length, tasks: keep.size, moved, errors };
    });
  }
  // the search index of the given tasks (all without ids), from their effective text
  reindex(ids) {
    return this.serial(async () => {
      if (!this.fts) return;
      const rows = ids ? (await Promise.all(ids.map((i2) => this.rawTask(i2)))).filter(Boolean) : await this.store.all("SELECT * FROM tasks");
      const edits = await this.editsBy();
      const docs = rows.map((r) => {
        const { id, title, edited, ...rest } = this.effective(r, edits.get(r.id) ?? []);
        return { id, title, body: JSON.stringify(rest) };
      });
      await this.tx((q) => this.store.indexTasks(q, docs, ids));
    });
  }
  async search(q) {
    q = q.trim();
    if (!q) return [];
    const hits = await this.store.searchTasks(q);
    if (hits) return hits;
    const like = `%${q}%`;
    return this.store.all(`SELECT id, title, substr(body,1,140) AS hit FROM tasks WHERE title LIKE ? OR body LIKE ? LIMIT 80`, [like, like]);
  }
  async review() {
    const [open, edits] = await Promise.all([
      this.store.all(`SELECT n.*, n.task_id AS step_id, t.title FROM notes n LEFT JOIN tasks t ON t.id=n.task_id WHERE n.resolved=0 ORDER BY n.task_id, n.id`),
      this.store.all(`SELECT e.task_id AS step_id, e.field, e.at AS updated_at, e.by, t.title FROM edits e LEFT JOIN tasks t ON t.id=e.task_id ORDER BY e.task_id`)
    ]);
    return { open, edits, moved: P(this.meta("plan_moved"), []) };
  }
  // ── knowledge: what one session learned, so the others do not pay for it again ──
  // kinds: fact (true about the code/system), lesson (a mistake not to repeat), decision (made,
  // with why), context (a summary of files/state read), result (output of a finished piece of
  // work), howto (a command sequence that works). supersedes retires an older entry.
  remember(by, k) {
    return this.serial(async () => {
      await this.need(by);
      if (!KB_KINDS.includes(k.kind)) throw bad(`kind must be one of ${KB_KINDS.join(", ")}`);
      if (!k.title?.trim() || !k.body?.trim()) throw bad("need title and body");
      if (k.body.length > 5e4) throw bad("body \u2264 50000 chars; link the rest with refs");
      if (k.task && !await this.rawTask(k.task)) throw new HuddleError(404, `no task ${k.task}`);
      const row = await this.tx(async (q) => {
        const row2 = await q.get(
          `INSERT INTO knowledge (by, kind, title, body, tags, refs, task_id, supersedes, created_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING *`,
          [by, k.kind, k.title.trim().slice(0, 200), k.body.trim(), J(k.tags ?? []), J(k.refs ?? []), k.task ?? null, k.supersedes ?? null, now()]
        );
        await this.store.indexKnowledge(q, row2, k.tags ?? []);
        await this.insert(q, by, { topic: "kb.added", ref: `kb:${row2.id}`, msg: `[${k.kind}] ${row2.title}`, data: { kb: row2.id, kind: k.kind, tags: k.tags ?? [] } });
        return row2;
      });
      this.flush();
      return this.kbRow(row);
    });
  }
  kbRow(r) {
    return { id: r.id, by: r.by, kind: r.kind, title: r.title, body: r.body, tags: P(r.tags, []), refs: P(r.refs, []), task: r.task_id, supersedes: r.supersedes, created_at: r.created_at, hits: r.hits };
  }
  // search first, read second: recall returns titles and a snippet; kb(id) returns the body
  async recall(q, o = {}) {
    const lim = Math.max(1, Math.min(50, o.limit ?? 10));
    const retired = await this.retired();
    let rows;
    if (q.trim() && this.fts) rows = await this.store.searchKnowledge(q.trim(), lim * 3);
    else if (q.trim()) {
      const words2 = q.trim().split(/\s+/).slice(0, 8).map((w) => `%${w.replace(/[\\%_]/g, "\\$&")}%`);
      rows = await this.store.all(
        `SELECT *, substr(body,1,200) hit FROM knowledge WHERE ${words2.map(() => "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')").join(" OR ")} ORDER BY id DESC LIMIT ?`,
        [...words2.flatMap((w) => [w, w, w]), lim * 3]
      );
    } else rows = await this.store.all("SELECT *, substr(body,1,200) hit FROM knowledge ORDER BY id DESC LIMIT ?", [lim * 3]);
    return rows.filter((r) => !retired.has(r.id) && (!o.kind || r.kind === o.kind) && (!o.by || r.by === o.by || r.by.startsWith(o.by + ".")) && (!o.tag || P(r.tags, []).includes(o.tag))).slice(0, lim).map((r) => ({ id: r.id, kind: r.kind, title: r.title, by: r.by, tags: P(r.tags, []), task: r.task_id, created_at: r.created_at, hit: r.hit }));
  }
  kb(id) {
    return this.serial(async () => {
      const r = await this.store.get("UPDATE knowledge SET hits = hits + 1 WHERE id=? RETURNING *", [id]);
      if (!r) throw new HuddleError(404, `no knowledge entry ${id}`);
      const by = await this.store.get("SELECT id FROM knowledge WHERE supersedes=?", [id]);
      return { ...this.kbRow(r), superseded_by: by?.id ?? null };
    });
  }
  // ── what a session sees when it joins ───────────────────────────────────────
  async snapshot(name, j = {}) {
    const [u, ib, control, turn, sessions, total, latest] = await Promise.all([
      this.unread(name),
      this.inbox(name),
      this.controlOf(name),
      this.turn(),
      this.sessions(),
      this.store.get(`SELECT ${COUNT} n FROM knowledge`),
      this.recall("", { limit: 8 })
    ]);
    const n = name === OWNER ? null : await this.next(name);
    return {
      channel: this.name,
      me: name,
      control,
      turn,
      orchestrator: this.config().orchestrator,
      context: j.context ?? null,
      skipped: j.skipped ?? 0,
      brief: j.brief ?? null,
      sessions: sessions.filter((s2) => s2.name !== name && s2.state !== "left").map((s2) => ({ name: s2.name, role: s2.role, state: s2.state, task: s2.task, stale: s2.stale, control: s2.control })),
      knowledge: { total: total.n, latest: latest.map((k) => `#${k.id} [${k.kind}] ${k.title} (${k.by})`) },
      unread: u.slice(-50).map((e) => ({ seq: e.seq, from: e.from, to: e.to, topic: e.topic, msg: e.msg?.slice(0, 300) ?? null })),
      unread_total: u.length,
      inbox: ib.map((e) => ({ seq: e.seq, from: e.from, msg: e.msg, task: e.data?.task ?? null })),
      next: !n || n.done ? null : { id: n.id, title: n.title, ready: n.ready, unmet: n.unmet }
    };
  }
  // Everything that waits on the owner, in one read: asks addressed to the owner (or to all),
  // paused and stale sessions, blocked tasks, and the next tasks gated owner/ask-first that are
  // ready (nothing they wait on is open) and not yet approved.
  async attention() {
    const [inbox, allSess, all, approvedRows, raw, review] = await Promise.all([
      this.inbox(OWNER),
      this.sessions(),
      this.tasks(),
      this.store.all("SELECT DISTINCT task_id FROM notes WHERE kind='direction' AND body LIKE 'Approved by %'"),
      this.store.all("SELECT id, status_note FROM tasks WHERE status='blocked'"),
      this.store.get(`SELECT ${COUNT} n FROM notes WHERE resolved=0`)
    ]);
    const asks = inbox.map((e) => ({ seq: e.seq, from: e.from, msg: e.msg, ts: e.ts, task: e.data?.task ?? null, ref: e.ref }));
    const sess = allSess.filter((s2) => s2.state !== "left");
    const status = new Map(all.map((t) => [t.id, t.status]));
    const approved = new Set(approvedRows.map((r) => r.task_id));
    const notes = new Map(raw.map((r) => [r.id, r.status_note]));
    const gates = all.filter((t) => (t.gate === "owner" || t.gate === "ask-first") && !FINISHED.has(t.status) && !t.blocked_by.length && !approved.has(t.id)).slice(0, 12).map((t) => ({ id: t.id, title: t.title, gate: t.gate, owner: t.owner, status: t.status, phase_n: t.phase_n }));
    const blocked = all.filter((t) => t.status === "blocked").map((t) => ({ id: t.id, title: t.title, owner: t.owner, note: notes.get(t.id) ?? "", waits_on: t.blocked_by }));
    const next = await Promise.all(sess.filter((s2) => !s2.parent).map(async (s2) => {
      const n = await this.next(s2.name);
      return { session: s2.name, task: n.done ? null : { id: n.id, title: n.title, ready: n.ready, unmet: (n.unmet ?? []).map((u) => u.id) } };
    }));
    return {
      asks,
      gates,
      blocked,
      open_notes: review.n,
      paused: sess.filter((s2) => s2.control === "pause").map((s2) => ({ name: s2.name, by: s2.control_by, at: s2.control_at })),
      stale: sess.filter((s2) => s2.stale).map((s2) => ({ name: s2.name, last_seen: s2.last_seen })),
      next,
      unblocked_by: [...new Set(all.flatMap((t) => t.blocked_by))].filter((id) => status.get(id) && !FINISHED.has(status.get(id))).length,
      total: asks.length + gates.length + blocked.length
    };
  }
  // the owner's go-ahead on a gated task: a note on the task plus a message to its owner
  approve(id, msg = "", by = OWNER) {
    return this.serial(async () => {
      const t = await this.rawTask(id);
      if (!t) throw new HuddleError(404, `no task ${id}`);
      await this.note(by, id, "direction", `Approved by ${by === OWNER ? "the owner" : by}${msg ? `: ${msg}` : ""}`);
      const to = t.owner && t.owner !== by && t.owner !== OWNER && await this.session(t.owner) ? t.owner : null;
      const ev2 = await this.append(by, { topic: "msg", to, ref: id, msg: `Approved ${id} ${t.title}${msg ? `: ${msg}` : ""}`, data: { task: id, approved: true } });
      return { ok: true, id, event: ev2.seq };
    });
  }
  // The big picture in one read: each phase's progress, what every session does now and next,
  // and the critical path: the longest chain of unfinished tasks linked by dependencies.
  async map() {
    const [all, phases, sess] = await Promise.all([this.tasks(), this.phases(), this.sessions()]);
    const open = new Map(all.filter((t) => !FINISHED.has(t.status)).map((t) => [t.id, t]));
    const order = new Map(all.map((t, i2) => [t.id, i2]));
    const len = /* @__PURE__ */ new Map(), visiting = /* @__PURE__ */ new Set();
    const L = (id) => {
      if (len.has(id)) return len.get(id);
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const v = 1 + Math.max(0, ...open.get(id).depends.filter((d) => open.has(d)).map(L));
      visiting.delete(id);
      len.set(id, v);
      return v;
    };
    let end = null;
    for (const id of open.keys()) if (!end || L(id) > L(end)) end = id;
    const path = [];
    for (let cur = end; cur; ) {
      path.unshift(cur);
      const want = L(cur) - 1;
      cur = want > 0 ? open.get(cur).depends.filter((d) => open.has(d) && L(d) === want).sort((a, b2) => order.get(a) - order.get(b2))[0] ?? null : null;
    }
    const byPhase = (n) => all.filter((t) => t.phase_n === n);
    const known = new Set(phases.map((p) => p.n));
    const loose = all.filter((t) => !known.has(t.phase_n));
    const sessions = await Promise.all(sess.filter((s2) => !s2.parent && s2.state !== "left").map(async (s2) => {
      const cur = await this.current(s2.name);
      const n = await this.next(s2.name);
      const ct = cur ? all.find((t) => t.id === cur) : null;
      return {
        name: s2.name,
        state: s2.state,
        current: ct ? { id: ct.id, title: ct.title } : null,
        next: n.done || n.id === cur ? null : { id: n.id, title: n.title, ready: n.ready }
      };
    }));
    return {
      title: this.config().title,
      orchestrator: this.config().orchestrator,
      done: all.length - open.size,
      total: all.length,
      phases: [
        ...phases.map((p) => ({ n: p.n, title: p.title, done: byPhase(p.n).filter((t) => FINISHED.has(t.status)).length, total: byPhase(p.n).length })),
        ...loose.length ? [{ n: null, title: "(no phase)", done: loose.filter((t) => FINISHED.has(t.status)).length, total: loose.length }] : []
      ],
      sessions,
      critical_path: path.map((id) => {
        const t = open.get(id);
        return { id, title: t.title, owner: t.owner, status: t.status };
      })
    };
  }
  async stats() {
    const c = async (q) => (await this.store.get(q)).n;
    const [events, tasks, done, sessions, knowledge, open_asks, last] = await Promise.all([
      c(`SELECT ${COUNT} n FROM events`),
      c(`SELECT ${COUNT} n FROM tasks`),
      c(`SELECT ${COUNT} n FROM tasks WHERE status IN ('done','skipped')`),
      c(`SELECT ${COUNT} n FROM sessions WHERE state != 'left'`),
      c(`SELECT ${COUNT} n FROM knowledge`),
      c(`SELECT ${COUNT} n FROM events e WHERE needs_reply=1 AND NOT EXISTS (SELECT 1 FROM events r WHERE r.reply_to=e.seq)`),
      this.lastSeq()
    ]);
    return { events, tasks, done, sessions, knowledge, open_asks, last };
  }
};

// plugin/server/src/store.ts
import { mkdirSync } from "node:fs";
import { dirname as dirname2 } from "node:path";

// plugin/server/src/rt.ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var isBun = typeof Bun !== "undefined";
var SELF = fileURLToPath(import.meta.url);
var BUNDLED = /[\\/]dist[\\/][^\\/]+\.js$/.test(SELF);
function pluginRoot() {
  for (let d = dirname(SELF); d !== dirname(d); d = dirname(d)) if (existsSync(join(d, ".claude-plugin"))) return d;
  return join(dirname(SELF), BUNDLED ? ".." : "../..");
}
var PLUGIN = pluginRoot();
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function stdinText() {
  if (isBun) return Bun.stdin.text();
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))).on("error", reject);
  });
}
var bind = (p) => p.map((v) => v === void 0 ? null : typeof v === "boolean" ? v ? 1 : 0 : v);
async function sqlite(file) {
  if (isBun) {
    const { Database } = await import("bun:sqlite");
    const db2 = new Database(file, { create: true });
    return {
      exec: (s2) => db2.exec(s2),
      all: (s2, p) => db2.query(s2).all(...bind(p)),
      run: (s2, p) => {
        db2.query(s2).run(...bind(p));
      },
      close: () => db2.close()
    };
  }
  let mod;
  try {
    mod = await import("node:sqlite");
  } catch {
    throw new Error(`node:sqlite is missing: Huddle's server needs Node 22.5 or newer (before 22.13 with --experimental-sqlite), or Bun`);
  }
  const db = new mod.DatabaseSync(file);
  const cache3 = /* @__PURE__ */ new Map();
  const st = (s2) => {
    let x = cache3.get(s2);
    if (!x) {
      x = db.prepare(s2);
      cache3.set(s2, x);
    }
    return x;
  };
  return {
    exec: (s2) => db.exec(s2),
    all: (s2, p) => st(s2).all(...bind(p)),
    run: (s2, p) => {
      st(s2).run(...bind(p));
    },
    close: () => {
      cache3.clear();
      db.close();
    }
  };
}
async function serve(o) {
  if (isBun) {
    const s2 = Bun.serve({ hostname: o.hostname, port: o.port, idleTimeout: 0, fetch: o.fetch });
    return { hostname: s2.hostname, port: s2.port, stop: (force) => s2.stop(!!force) };
  }
  const { createServer: createServer2 } = await import("node:http");
  const server2 = createServer2((req, res) => {
    void answer(o.fetch, req, res);
  });
  server2.requestTimeout = 0;
  server2.headersTimeout = 6e4;
  server2.keepAliveTimeout = 5e3;
  server2.timeout = 0;
  await new Promise((resolve, reject) => {
    server2.once("error", reject);
    server2.listen(o.port, o.hostname, () => {
      server2.off("error", reject);
      resolve();
    });
  });
  const addr = server2.address();
  return {
    hostname: o.hostname,
    port: addr.port,
    stop: (force) => {
      server2.close();
      if (force) server2.closeAllConnections();
      else server2.closeIdleConnections();
    }
  };
}
async function answer(fetch2, req, res) {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });
  let response;
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== void 0) for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
    const method = req.method ?? "GET";
    let body2;
    if (method !== "GET" && method !== "HEAD") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body2 = Buffer.concat(chunks);
    }
    const url = `http://${/^[\w.:[\]-]+$/.test(req.headers.host ?? "") ? req.headers.host : "invalid.host"}${req.url ?? "/"}`;
    response = await fetch2(new Request(url, { method, headers, body: body2?.length ? body2 : void 0, signal: ac.signal }));
  } catch (e) {
    response = new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "content-type": "application/json" } });
  }
  const out = {};
  response.headers.forEach((v, k) => {
    if (k !== "set-cookie") out[k] = v;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(response.status, out);
  if (!response.body || req.method === "HEAD") {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  ac.signal.addEventListener("abort", () => {
    reader.cancel().catch(() => {
    });
  }, { once: true });
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((r) => {
        res.once("drain", r);
        res.once("close", r);
      });
    }
    res.end();
  } catch {
    res.destroy();
  }
}

// plugin/server/src/store.ts
var DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  name TEXT PRIMARY KEY, label TEXT, role TEXT, joined_at TEXT NOT NULL, last_seen TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle', task TEXT, step TEXT,
  control TEXT NOT NULL DEFAULT 'run' CHECK (control IN ('run','pause')), control_by TEXT, control_at TEXT,
  cursor INTEGER NOT NULL DEFAULT 0, parent TEXT, context TEXT, brief TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq {ID}, ts TEXT NOT NULL, from_name TEXT NOT NULL, to_name TEXT,
  topic TEXT NOT NULL, ref TEXT, msg TEXT, data TEXT, reply_to INTEGER, needs_reply INTEGER NOT NULL DEFAULT 0, key TEXT
);
CREATE INDEX IF NOT EXISTS events_to ON events(to_name, seq);
CREATE INDEX IF NOT EXISTS events_reply ON events(reply_to, from_name);
CREATE INDEX IF NOT EXISTS events_open ON events(needs_reply, seq) WHERE needs_reply = 1;
CREATE UNIQUE INDEX IF NOT EXISTS events_key ON events(from_name, key) WHERE key IS NOT NULL;
CREATE TABLE IF NOT EXISTS phases (n INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, phase INTEGER NOT NULL DEFAULT 0, ord INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL,
  owner TEXT, status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','blocked','skipped')),
  after TEXT NOT NULL DEFAULT '[]', body TEXT NOT NULL DEFAULT '{}', origin TEXT NOT NULL DEFAULT 'session',
  created_by TEXT, created_at TEXT NOT NULL, status_by TEXT, status_at TEXT, status_note TEXT
);
CREATE INDEX IF NOT EXISTS tasks_order ON tasks(phase, ord);
CREATE TABLE IF NOT EXISTS edits (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, field TEXT NOT NULL, value TEXT NOT NULL,
  by TEXT, at TEXT NOT NULL, PRIMARY KEY (task_id, field)
);
CREATE TABLE IF NOT EXISTS notes (
  id {ID}, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, body TEXT NOT NULL, by TEXT, resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_task ON notes(task_id);
CREATE TABLE IF NOT EXISTS knowledge (
  id {ID}, by TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]', refs TEXT NOT NULL DEFAULT '[]', task_id TEXT, supersedes INTEGER, created_at TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS touches (
  session TEXT NOT NULL, repo TEXT NOT NULL, path TEXT NOT NULL, at TEXT NOT NULL, warned_at TEXT,
  PRIMARY KEY (session, repo, path)
);
CREATE INDEX IF NOT EXISTS touches_path ON touches(repo, path, at);
`;
var ADDED = [
  ["sessions", "parent TEXT"],
  ["sessions", "context TEXT"],
  ["sessions", "brief TEXT"],
  ["knowledge", "verified_by TEXT"],
  ["knowledge", "verified_at TEXT"],
  ["knowledge", "moved_to INTEGER"],
  ["knowledge", "origin TEXT"]
];
var Store = class _Store {
  // open transactions: a transaction inside one is a savepoint
  constructor(db) {
    this.db = db;
    this.q = this.on();
  }
  db;
  fts = true;
  q;
  depth = 0;
  static async sqlite(file) {
    if (file !== ":memory:") mkdirSync(dirname2(file), { recursive: true });
    const s2 = new _Store(await sqlite(file));
    s2.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    return s2;
  }
  on() {
    return {
      all: async (s2, p = []) => this.db.all(s2, p),
      get: async (s2, p = []) => this.db.all(s2, p)[0] ?? null,
      run: async (s2, p = []) => {
        this.db.run(s2, p);
      }
    };
  }
  all(s2, p) {
    return this.q.all(s2, p);
  }
  get(s2, p) {
    return this.q.get(s2, p);
  }
  run(s2, p) {
    return this.q.run(s2, p);
  }
  // one transaction; the callback must use the Q it is given, never the store
  async tx(fn) {
    const sp = this.depth ? `sp${this.depth}` : null;
    this.db.exec(sp ? `SAVEPOINT ${sp}` : "BEGIN");
    this.depth++;
    try {
      const r = await fn(this.q);
      this.depth--;
      this.db.exec(sp ? `RELEASE ${sp}` : "COMMIT");
      return r;
    } catch (e) {
      this.depth--;
      try {
        this.db.exec(sp ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK");
      } catch {
      }
      throw e;
    }
  }
  async close() {
    this.db.close();
  }
  async init() {
    this.db.exec(DDL.replace(/\{ID\}/g, "INTEGER PRIMARY KEY AUTOINCREMENT"));
    for (const [t, c] of ADDED) try {
      this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`);
    } catch {
    }
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(id UNINDEXED, title, body, tokenize='porter unicode61')`);
    } catch {
      this.fts = false;
    }
    if (this.fts) this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(title, body, tags, content='knowledge', content_rowid='id', tokenize='porter unicode61')`);
  }
  // ── full-text search ───────────────────────────────────────────────────────
  // the task index holds each task's effective text (owner edits applied); ids = which tasks, or all
  async indexTasks(q, rows, ids) {
    if (!this.fts) return;
    if (!ids) await q.run("DELETE FROM tasks_fts");
    else for (const i2 of ids) await q.run("DELETE FROM tasks_fts WHERE id=?", [i2]);
    for (const r of rows) await q.run("INSERT INTO tasks_fts (id, title, body) VALUES (?,?,?)", [r.id, r.title, r.body]);
  }
  fts5(q, op) {
    return q.split(/\s+/).map((t) => `"${t.replace(/"/g, '""')}"*`).join(op);
  }
  // tasks matching every word: {id, title, hit}, best first; null when the index cannot answer
  async searchTasks(q) {
    if (!this.fts) return null;
    try {
      return await this.all(`SELECT id, title, snippet(tasks_fts, 2, '\xAB', '\xBB', ' \u2026 ', 14) AS hit FROM tasks_fts WHERE tasks_fts MATCH ? ORDER BY rank LIMIT 80`, [this.fts5(q, " ")]);
    } catch {
      return null;
    }
  }
  // knowledge rows matching any word, with a snippet of the body in hit and a relevance score (higher is better)
  async searchKnowledge(q, limit) {
    try {
      return await this.all(`SELECT k.*, snippet(knowledge_fts, 1, '\xAB', '\xBB', ' \u2026 ', 18) AS hit, -f.rank AS score FROM knowledge_fts f JOIN knowledge k ON k.id = f.rowid
        WHERE knowledge_fts MATCH ? ORDER BY rank LIMIT ?`, [this.fts5(q, " OR "), limit]);
    } catch {
      return [];
    }
  }
  // a new knowledge row joins the index
  async indexKnowledge(q, r, tags) {
    if (this.fts) await q.run("INSERT INTO knowledge_fts (rowid, title, body, tags) VALUES (?,?,?,?)", [r.id, r.title, r.body, tags.join(" ")]);
  }
};

// plugin/server/src/knowledge.ts
import { existsSync as existsSync2, statSync } from "node:fs";
import { isAbsolute } from "node:path";

// plugin/server/src/touches.ts
var WINDOW_MIN = 30;
var KEEP_DAYS = 90;
var iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
var mins = (at) => Math.max(0, Math.round((Date.now() - Date.parse(at)) / 6e4));
var ago = (at) => {
  const m = mins(at);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
var repoName = (repo) => repo.replace(/\/+$/, "").split("/").pop() || repo;
function clean(path, repo) {
  const p = String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  const r = String(repo ?? "");
  if (!p || p.length > 500 || p.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(p) || /[\0\n]/.test(p)) throw new HuddleError(400, "path: a file path relative to its repo");
  if (!r || r.length > 500 || /[\0\n]/.test(r)) throw new HuddleError(400, "repo: the repo the file is in");
  return { path: p, repo: r };
}
function touched(ch, me, a) {
  const { path, repo } = clean(a.path, a.repo);
  const name = parentOf(me) ?? me;
  return ch.serial(async () => {
    if (!await ch.session(name)) throw new HuddleError(404, `"${name}" has not joined channel ${ch.name}`);
    const now3 = Date.now(), at = iso(now3), since = iso(now3 - WINDOW_MIN * 6e4);
    const others = await ch.store.all(`SELECT t.session, t.at FROM touches t JOIN sessions s ON s.name = t.session
      WHERE t.repo=? AND t.path=? AND t.session != ? AND t.at > ? AND s.state != 'left' ORDER BY t.at DESC`, [repo, path, name, since]);
    const mine = await ch.store.get("SELECT warned_at FROM touches WHERE session=? AND repo=? AND path=?", [name, repo, path]);
    const warn = others.length > 0 && !(mine?.warned_at && mine.warned_at > since);
    await ch.store.run(`INSERT INTO touches (session, repo, path, at, warned_at) VALUES (?,?,?,?,?)
      ON CONFLICT(session, repo, path) DO UPDATE SET at=excluded.at, warned_at=COALESCE(excluded.warned_at, touches.warned_at)`, [name, repo, path, at, warn ? at : null]);
    if (Math.random() < 0.02) await ch.store.run("DELETE FROM touches WHERE at < ?", [iso(now3 - KEEP_DAYS * 864e5)]);
    if (others.length) ch.emit("conflict", { repo, path, sessions: [name, ...others.map((o) => o.session)] });
    const who2 = others.map((o) => `${o.session} edited ${path} ${ago(o.at)}`);
    const line = warn ? `Huddle: ${who2.length > 1 ? `${who2[0]}, ${others.slice(1).map((o) => `${o.session} ${ago(o.at)}`).join(", ")}` : who2[0]} \u2014 coordinate with ${others.length > 1 ? "them" : "it"} (send, or ask) before you change more.` : null;
    return { path, repo, others: others.map((o) => ({ session: o.session, at: o.at })), warn: line };
  });
}
async function conflicts(ch) {
  const since = iso(Date.now() - WINDOW_MIN * 6e4);
  const rows = await ch.store.all(`SELECT t.session, t.repo, t.path, t.at FROM touches t JOIN sessions s ON s.name = t.session
    WHERE t.at > ? AND s.state != 'left' ORDER BY t.at DESC`, [since]);
  const by = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const k = `${r.repo}\0${r.path}`;
    const g = by.get(k) ?? { repo: r.repo, repo_name: repoName(r.repo), path: r.path, last: r.at, sessions: [] };
    g.sessions.push({ name: r.session, at: r.at });
    by.set(k, g);
  }
  return { window_min: WINDOW_MIN, conflicts: [...by.values()].filter((g) => g.sessions.length > 1) };
}
async function lastEdit(ch, ref, after) {
  const name = ref.split("/").pop() ?? ref;
  const rows = await ch.store.all("SELECT path, MAX(at) at FROM touches WHERE path LIKE ? ESCAPE '\\' AND at > ? GROUP BY path", [`%${name.replace(/[\\%_]/g, "\\$&")}`, after]);
  const hit = rows.filter((r) => ref === r.path || ref.endsWith(`/${r.path}`)).map((r) => r.at).sort().pop();
  return hit ?? null;
}

// plugin/server/src/knowledge.ts
var SHARED_BASE = 1e5;
var STALE_DAYS = Number(process.env.HUDDLE_KB_STALE_DAYS) > 0 ? Number(process.env.HUDDLE_KB_STALE_DAYS) : 30;
var now2 = () => (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "Z");
var P2 = (v, d) => {
  if (v == null) return d;
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};
var Shared = class _Shared {
  constructor(store) {
    this.store = store;
  }
  store;
  chain = Promise.resolve();
  static async open(file) {
    const store = await Store.sqlite(file);
    await store.init();
    await store.run("INSERT INTO sqlite_sequence (name, seq) SELECT 'knowledge', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='knowledge')", [SHARED_BASE - 1]);
    return new _Shared(store);
  }
  serial(fn) {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {
    });
    return p;
  }
  close() {
    return this.store.close();
  }
};
var shared = /* @__PURE__ */ new WeakMap();
var attachShared = (ch, s2) => {
  shared.set(ch, s2);
};
var sharedOf = (ch) => shared.get(ch) ?? null;
var isShared = (id) => id >= SHARED_BASE;
var needShared = (ch) => sharedOf(ch) ?? (() => {
  throw new HuddleError(400, "this server keeps no server-wide knowledge");
})();
var storeOf = (ch, id) => isShared(id) ? needShared(ch).store : ch.store;
var sharedRetired = async (s2) => new Set((await s2.store.all("SELECT supersedes AS id FROM knowledge WHERE supersedes IS NOT NULL")).map((r) => r.id));
var fileRef = (r) => {
  if (/^[a-z][\w+.-]*:\/\//i.test(r) || /^#?\d+$/.test(r) || /\s/.test(r.trim())) return null;
  return r.trim().replace(/:\d+(-\d+)?$/, "").replace(/^\.\//, "") || null;
};
async function staleness(ch, r) {
  const since = [r.created_at, r.verified_at].filter(Boolean).sort().pop();
  const days = Math.floor((Date.now() - Date.parse(r.created_at)) / 864e5);
  if (Date.now() - Date.parse(since) > STALE_DAYS * 864e5) return { age_days: days, stale: `not verified for over ${STALE_DAYS} days` };
  const repo = ch.config().repo;
  for (const ref of P2(r.refs, []).map(String).map(fileRef).filter(Boolean)) {
    if (await lastEdit(ch, ref, since)) return { age_days: days, stale: `${ref} was edited since` };
    const f = isAbsolute(ref) ? ref : repo ? `${repo}/${ref}` : null;
    try {
      if (f && existsSync2(f) && statSync(f).mtimeMs > Date.parse(since) + 1e3) return { age_days: days, stale: `${ref} changed since` };
    } catch {
    }
  }
  return { age_days: days, stale: null };
}
async function shape(ch, r, hit) {
  const s2 = await staleness(ch, r);
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    by: r.by,
    tags: P2(r.tags, []),
    refs: P2(r.refs, []),
    task: r.task_id ?? null,
    created_at: r.created_at,
    hit: hit ?? r.hit ?? String(r.body ?? "").slice(0, 200),
    scope: isShared(r.id) ? "server" : "channel",
    origin: r.origin ?? null,
    verified_by: r.verified_by ?? null,
    verified_at: r.verified_at ?? null,
    ...s2
  };
}
async function recall(ch, q, o = {}) {
  const lim = Math.max(1, Math.min(50, o.limit ?? 10));
  const mine = await ch.recall(q, { ...o, limit: 50 });
  const rows = new Map((await Promise.all(mine.map((k) => ch.store.get("SELECT * FROM knowledge WHERE id=?", [k.id])))).filter(Boolean).map((r) => [r.id, r]));
  let list = mine.map((k, i2) => ({ row: { ...rows.get(k.id), hit: k.hit }, rank: i2 }));
  const S = sharedOf(ch);
  if (S) {
    const gone2 = await sharedRetired(S);
    const theirs = q.trim() ? S.store.fts ? await S.store.searchKnowledge(q.trim(), 60) : await S.store.all(`SELECT *, substr(body,1,200) hit FROM knowledge WHERE ${q.trim().split(/\s+/).slice(0, 8).map(() => "(title LIKE ? OR body LIKE ?)").join(" OR ")} LIMIT 60`, q.trim().split(/\s+/).slice(0, 8).flatMap((w) => [`%${w}%`, `%${w}%`])) : await S.store.all("SELECT *, substr(body,1,200) hit FROM knowledge ORDER BY id DESC LIMIT 60");
    const ok = theirs.filter((r) => !gone2.has(r.id) && (!o.kind || r.kind === o.kind) && (!o.by || r.by === o.by || String(r.by).startsWith(o.by + ".")) && (!o.tag || P2(r.tags, []).includes(o.tag)));
    list = [...list, ...ok.map((row, i2) => ({ row, rank: i2 + 0.5 }))];
    if (!q.trim()) list.sort((a, b2) => String(b2.row.created_at).localeCompare(String(a.row.created_at)));
    else list.sort((a, b2) => a.rank - b2.rank);
  }
  list.sort((a, b2) => Number(!!b2.row.verified_at) - Number(!!a.row.verified_at));
  return Promise.all(list.slice(0, lim).map((x) => shape(ch, x.row)));
}
async function kb(ch, id) {
  if (!isShared(id)) {
    const k = await ch.kb(id);
    const r2 = await ch.store.get("SELECT * FROM knowledge WHERE id=?", [id]);
    return { ...k, ...await shape(ch, r2), body: k.body, hits: k.hits, superseded_by: k.superseded_by, moved_to: r2.moved_to ?? null };
  }
  const S = needShared(ch);
  const r = await S.serial(() => S.store.get("UPDATE knowledge SET hits = hits + 1 WHERE id=? RETURNING *", [id]));
  if (!r) throw new HuddleError(404, `no knowledge entry ${id}`);
  const by = await S.store.get("SELECT id FROM knowledge WHERE supersedes=?", [id]);
  return { ...await shape(ch, r), body: r.body, hits: r.hits, supersedes: r.supersedes ?? null, superseded_by: by?.id ?? null, moved_to: null };
}
var words = (s2) => new Set(String(s2).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []);
var jaccard = (a, b2) => {
  if (!a.size || !b2.size) return 0;
  let n = 0;
  for (const w of a) if (b2.has(w)) n++;
  return n / (a.size + b2.size - n);
};
async function similar(ch, k) {
  const t = words(k.title), b2 = words(k.body);
  const look = async (store, gone2) => (await store.all("SELECT id, kind, title, body, by FROM knowledge ORDER BY id DESC LIMIT 500")).filter((r) => !gone2.has(r.id));
  const S = sharedOf(ch);
  const rows = [...await look(ch.store, await ch.retired()), ...S ? await look(S.store, await sharedRetired(S)) : []];
  let best = null;
  for (const r of rows) {
    const ts = jaccard(t, words(r.title)), bs = jaccard(b2, words(r.body));
    const dup = ts >= 0.75 || ts >= 0.5 && bs >= 0.5 || bs >= 0.85;
    const score = Math.max(ts, (ts + bs) / 2, bs);
    if (dup && (!best || score > best.score)) best = { row: r, score };
  }
  return best;
}
async function remember(ch, me, k) {
  if (k.scope && !["channel", "server"].includes(k.scope)) throw new HuddleError(400, "scope: channel (default) or server (every channel on this server)");
  if (!k.force && k.supersedes == null && k.title?.trim() && k.body?.trim()) {
    const d = await similar(ch, k);
    if (d) {
      const r = d.row;
      return {
        duplicate: true,
        added: false,
        existing: { id: r.id, kind: r.kind, title: r.title, by: r.by, scope: isShared(r.id) ? "server" : "channel" },
        hint: `#${r.id} [${r.kind}] "${r.title}" (${r.by}) already says this. To replace it, remember again with supersedes=${r.id}; to add yours anyway, force=true; or verify #${r.id} if it is still right.`
      };
    }
  }
  if (k.supersedes != null && isShared(Number(k.supersedes)) !== (k.scope === "server")) throw new HuddleError(400, `#${k.supersedes} is ${isShared(Number(k.supersedes)) ? "server-wide: supersede it with scope=server" : "this channel's: supersede it without scope=server"}`);
  if (k.scope !== "server") return ch.remember(me, k);
  const S = needShared(ch);
  if (!KB_KINDS.includes(k.kind)) throw new HuddleError(400, `kind must be one of ${KB_KINDS.join(", ")}`);
  if (!k.title?.trim() || !k.body?.trim()) throw new HuddleError(400, "need title and body");
  if (k.body.length > 5e4) throw new HuddleError(400, "body \u2264 50000 chars; link the rest with refs");
  if (k.supersedes != null && !await S.store.get("SELECT id FROM knowledge WHERE id=?", [k.supersedes])) throw new HuddleError(404, `no knowledge entry ${k.supersedes}`);
  if (me !== OWNER && !await ch.session(me)) throw new HuddleError(404, `"${me}" has not joined channel ${ch.name} (call join first)`);
  const row = await insertShared(S, { by: me, kind: k.kind, title: k.title.trim().slice(0, 200), body: k.body.trim(), tags: k.tags ?? [], refs: k.refs ?? [], supersedes: k.supersedes ?? null, origin: ch.name, created_at: now2() });
  await ch.append(me, { topic: "kb.added", ref: `kb:${row.id}`, msg: `[${k.kind}] ${row.title} (every channel)`, data: { kb: row.id, kind: k.kind, tags: k.tags ?? [], scope: "server" } });
  return { ...await shape(ch, row), body: row.body, hits: 0, supersedes: row.supersedes ?? null };
}
async function insertShared(S, k) {
  return S.serial(() => S.store.tx(async (q) => {
    const row = await q.get(
      `INSERT INTO knowledge (by, kind, title, body, tags, refs, supersedes, created_at, origin, verified_by, verified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
      [k.by, k.kind, k.title, k.body, JSON.stringify(k.tags), JSON.stringify(k.refs), k.supersedes, k.created_at, k.origin, k.verified_by ?? null, k.verified_at ?? null]
    );
    await S.store.indexKnowledge(q, row, k.tags);
    return row;
  }));
}
async function verify(ch, me, id, undo = false) {
  const store = storeOf(ch, id), run = isShared(id) ? needShared(ch).serial.bind(needShared(ch)) : ch.serial.bind(ch);
  const r = await run(() => store.get(`UPDATE knowledge SET verified_by=?, verified_at=? WHERE id=? RETURNING *`, undo ? [null, null, id] : [me, now2(), id]));
  if (!r) throw new HuddleError(404, `no knowledge entry ${id}`);
  await ch.append(me, { topic: "kb.verified", ref: `kb:${id}`, msg: `${undo ? "unverified" : "verified"} [${r.kind}] ${r.title}`, data: { kb: id, verified: !undo } });
  return shape(ch, r);
}
async function share(ch, me, id) {
  if (isShared(id)) throw new HuddleError(400, `#${id} is already for every channel`);
  const S = needShared(ch);
  const r = await ch.store.get("SELECT * FROM knowledge WHERE id=?", [id]);
  if (!r) throw new HuddleError(404, `no knowledge entry ${id}`);
  if (r.moved_to) return kb(ch, r.moved_to);
  if ((await ch.retired()).has(id)) throw new HuddleError(400, `#${id} was superseded: share the entry that replaced it`);
  const row = await insertShared(S, {
    by: r.by,
    kind: r.kind,
    title: r.title,
    body: r.body,
    tags: P2(r.tags, []),
    refs: P2(r.refs, []),
    supersedes: null,
    origin: ch.name,
    created_at: r.created_at,
    verified_by: r.verified_by,
    verified_at: r.verified_at
  });
  await ch.serial(() => ch.store.run("UPDATE knowledge SET moved_to=? WHERE id=?", [row.id, id]));
  await ch.append(me, { topic: "kb.shared", ref: `kb:${row.id}`, msg: `[${r.kind}] ${r.title} is now for every channel (#${id} \u2192 #${row.id})`, data: { kb: row.id, from: id } });
  return { ...await shape(ch, row), body: row.body, from: id };
}
var HEAD = { lesson: "Lessons", howto: "How-tos", fact: "Facts", decision: "Decisions", context: "Context", result: "Results" };
async function exportMarkdown(ch, o = {}) {
  const S = sharedOf(ch);
  const live2 = async (store, gone2) => (await store.all("SELECT * FROM knowledge ORDER BY id")).filter((r) => !gone2.has(r.id) && (!o.verified || r.verified_at));
  const rows = [...await live2(ch.store, await ch.retired()), ...S ? await live2(S.store, await sharedRetired(S)) : []];
  const L = [
    `## Team knowledge (Huddle channel "${ch.config().title}")`,
    "",
    `<!-- exported from Huddle ${now2()}${o.verified ? ", verified entries only" : ""}: ${rows.length} entr${rows.length === 1 ? "y" : "ies"} -->`,
    ""
  ];
  if (!rows.length) L.push(o.verified ? "_Nothing verified yet._" : "_Nothing remembered yet._", "");
  for (const kind of Object.keys(HEAD)) {
    const of = rows.filter((r) => r.kind === kind);
    if (!of.length) continue;
    L.push(`### ${HEAD[kind]}`, "");
    for (const r of of) {
      const refs = P2(r.refs, []).filter(Boolean);
      const body2 = String(r.body).trim().split("\n");
      const tail = [refs.length ? `see ${refs.map((x) => `\`${x}\``).join(", ")}` : "", isShared(r.id) ? "every channel" : ""].filter(Boolean).join("; ");
      L.push(`- **${String(r.title).replace(/\*/g, "\\*")}**${body2.length === 1 ? `: ${body2[0]}` : ""}${tail ? ` (${tail})` : ""}`);
      if (body2.length > 1) for (const l of body2) L.push(l.trim() ? `  ${l}` : "");
    }
    L.push("");
  }
  return L.join("\n").replace(/\n{3,}/g, "\n\n");
}

// plugin/server/src/hub.ts
var CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
var Hub = class {
  constructor(dir, autoCreate = true) {
    this.dir = dir;
    this.autoCreate = autoCreate;
    mkdirSync2(`${dir}/channels`, { recursive: true });
  }
  dir;
  autoCreate;
  // autoCreate: a session's join creates the channel it names
  open = /* @__PURE__ */ new Map();
  // knowledge for every channel on this server (src/knowledge.ts), opened with the first channel
  shared = null;
  // where the channels live, for logs
  where() {
    return this.dir;
  }
  file(name) {
    return `${this.dir}/channels/${name}.db`;
  }
  async exists(name) {
    return this.open.has(name) || existsSync3(this.file(name));
  }
  async names() {
    try {
      return readdirSync(`${this.dir}/channels`).filter((f) => f.endsWith(".db")).map((f) => f.slice(0, -3)).filter((n) => CHANNEL_RE.test(n)).sort();
    } catch {
      return [];
    }
  }
  async get(name, create = this.autoCreate) {
    if (!CHANNEL_RE.test(name)) throw new HuddleError(400, `channel name must match ${CHANNEL_RE}`);
    let c = this.open.get(name);
    if (c) return c;
    if (!create && !await this.exists(name)) throw new HuddleError(404, `no channel ${name}`);
    c = this.open.get(name);
    if (c) return c;
    c = (async () => {
      const store = await Store.sqlite(this.file(name));
      const ch = await Channel.open(name, store);
      this.shared ??= Shared.open(`${this.dir}/shared.db`);
      const shared2 = await this.shared.catch((e) => {
        console.error(`shared knowledge: ${e.message}`);
        return null;
      });
      if (shared2) attachShared(ch, shared2);
      return ch;
    })();
    this.open.set(name, c);
    c.catch(() => this.open.delete(name));
    return c;
  }
  async list() {
    return Promise.all((await this.names()).map(async (n) => {
      const c = await this.get(n, false);
      const cfg = c.config();
      const [turn, sessions, stats] = await Promise.all([c.turn(), c.sessions(), c.stats()]);
      return {
        name: n,
        title: cfg.title,
        description: cfg.description,
        profile: cfg.profile,
        turn: turn.holder,
        sessions: sessions.filter((s2) => s2.state !== "left").map((s2) => ({ name: s2.name, state: s2.state, stale: s2.stale, control: s2.control })),
        stats
      };
    }));
  }
  async close() {
    for (const c of this.open.values()) await (await c.catch(() => null))?.close();
    this.open.clear();
    await (await this.shared?.catch(() => null))?.close();
    this.shared = null;
  }
};

// plugin/server/src/observatory.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
var TIMEOUT_MS = 800;
var TTL_MS = 5e3;
var cache = /* @__PURE__ */ new Map();
function stateDir(env = process.env) {
  return env.OBSERVATORY_HOME || join2(env.HOME || homedir(), ".local", "state", "observatory");
}
function port(env = process.env) {
  try {
    const p = Number(readFileSync(join2(stateDir(env), "port"), "utf8").trim());
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : null;
  } catch {
    return null;
  }
}
async function get(path) {
  const p = port();
  if (!p) return null;
  const key = `${p}${path}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  let v = null;
  try {
    const r = await fetch(`http://127.0.0.1:${p}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
    if (r.ok) v = await r.json();
  } catch {
    v = null;
  }
  cache.set(key, { at: Date.now(), v });
  return v;
}
async function alerts() {
  const j = await get("/api/alerts");
  if (!j || !Array.isArray(j.alerts)) return null;
  return j.alerts.filter((a) => a && typeof a.sessionId === "string").map((a) => ({
    id: String(a.id ?? ""),
    kind: String(a.kind ?? "alert"),
    sessionId: a.sessionId,
    agentId: a.agentId ?? null,
    project: String(a.project ?? ""),
    since: Number(a.since) || 0,
    detail: String(a.detail ?? ""),
    costUsd: typeof a.costUsd === "number" ? a.costUsd : null
  }));
}
async function costBySession(range = "day") {
  const j = await get(`/api/attribution?by=session&range=${range}`);
  if (!j || !Array.isArray(j.rows)) return null;
  const m = /* @__PURE__ */ new Map();
  for (const r of j.rows) if (r && typeof r.key === "string" && typeof r.costUsd === "number" && Number.isFinite(r.costUsd)) m.set(r.key, (m.get(r.key) ?? 0) + r.costUsd);
  return m;
}

// plugin/server/src/links.ts
var iso2 = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
var ready = /* @__PURE__ */ new WeakSet();
async function ensure(ch) {
  if (ready.has(ch)) return;
  await ch.serial(() => ch.store.run("CREATE TABLE IF NOT EXISTS x_session_links (claude_id TEXT PRIMARY KEY, name TEXT NOT NULL, at TEXT NOT NULL)"));
  ready.add(ch);
}
async function link(ch, name, claudeId) {
  const id = typeof claudeId === "string" ? claudeId : "";
  if (!/^[\w-]{1,128}$/.test(id) || !NAME_RE.test(name) || name === OWNER) return;
  const top = parentOf(name) ?? name;
  try {
    await ensure(ch);
    await ch.serial(() => ch.store.run("INSERT INTO x_session_links (claude_id, name, at) VALUES (?,?,?) ON CONFLICT(claude_id) DO UPDATE SET name=excluded.name, at=excluded.at", [id, top, iso2(Date.now())]));
  } catch {
  }
}
async function links(ch) {
  await ensure(ch);
  return new Map((await ch.store.all("SELECT claude_id, name FROM x_session_links")).map((r) => [r.claude_id, r.name]));
}

// plugin/server/src/digest.ts
var P3 = (v, d = null) => {
  if (v == null) return d;
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};
var iso3 = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
var MAX_MS = 90 * 864e5;
function parseSince(v, now3 = Date.now()) {
  const s2 = String(v ?? "").trim();
  if (!s2) return now3 - 864e5;
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw]?)$/i.exec(s2);
  if (m) {
    const ms = Number(m[1]) * { "": 1e3, s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2].toLowerCase()];
    return now3 - Math.min(ms, MAX_MS);
  }
  const t = Date.parse(s2);
  if (Number.isFinite(t)) return Math.max(t, now3 - MAX_MS);
  throw new HuddleError(400, `since: 24h, 90m, 7d or an ISO date, not ${s2}`);
}
var rangeFor = (ms) => ms <= 864e5 * 1.01 ? "day" : ms <= 7 * 864e5 * 1.01 ? "week" : "month";
async function digest(ch, since, o = {}) {
  const now3 = Date.now(), from = parseSince(since, now3), at = iso3(from);
  const [events, tasks, notes, sessions, open] = await Promise.all([
    ch.store.all("SELECT * FROM events WHERE ts >= ? ORDER BY seq LIMIT 50000", [at]),
    ch.tasks(),
    ch.store.all("SELECT task_id, kind, body, by, created_at FROM notes WHERE created_at >= ? ORDER BY id", [at]),
    ch.sessions(),
    ch.store.all(`SELECT e.* FROM events e WHERE e.needs_reply = 1 AND NOT EXISTS (SELECT 1 FROM events r WHERE r.reply_to = e.seq) ORDER BY e.seq`)
  ]);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const top = (n) => parentOf(n) ?? n;
  const live2 = new Map(sessions.map((s2) => [s2.name, s2]));
  const per = /* @__PURE__ */ new Map();
  const S = (n) => {
    const k = top(n);
    let s2 = per.get(k);
    if (!s2) {
      const x = live2.get(k);
      per.set(k, s2 = { name: k, state: x?.state ?? (k === OWNER ? null : "left"), role: x?.role ?? null, done: [], notes: [], knowledge: [], approvals: [], asked: 0, events: 0, cost: null });
    }
    return s2;
  };
  for (const s2 of sessions) if (!s2.parent && s2.state !== "left") S(s2.name);
  const kbIds = [];
  const finished = /* @__PURE__ */ new Map();
  for (const r of events) {
    const s2 = S(r.from_name), d = P3(r.data, {}) ?? {};
    s2.events++;
    if (r.topic === "task.status" && (d.status === "done" || d.status === "skipped")) {
      const t = byId.get(r.ref ?? d.task);
      finished.set(String(r.ref ?? d.task), { who: s2.name, id: r.ref ?? d.task, title: t?.title ?? null, status: d.status, note: String(d.note ?? "").slice(0, 300), at: r.ts, now: t?.status ?? null });
    } else if (r.topic === "kb.added" && d.kb != null) {
      s2.knowledge.push({ id: d.kb, kind: d.kind ?? null, title: null, at: r.ts });
      kbIds.push(Number(d.kb));
    } else if (r.topic === "approval.request") s2.approvals.push({ seq: r.seq, labels: Array.isArray(d.labels) ? d.labels : [], at: r.ts });
  }
  for (const f of finished.values()) if (f.now == null || f.now === f.status) S(f.who).done.push({ id: f.id, title: f.title, status: f.status, note: f.note, at: f.at });
  if (kbIds.length) {
    const rows = await ch.store.all(`SELECT id, kind, title FROM knowledge WHERE id IN (${kbIds.map(() => "?").join(",")})`, kbIds);
    const t = new Map(rows.map((r) => [r.id, r]));
    for (const s2 of per.values()) for (const k of s2.knowledge) {
      const r = t.get(Number(k.id));
      if (r) {
        k.title = r.title;
        k.kind = r.kind;
      }
    }
  }
  for (const n of notes) S(n.by ?? OWNER).notes.push({ task: n.task_id, title: byId.get(n.task_id)?.title ?? null, kind: n.kind, body: String(n.body).slice(0, 300), at: n.created_at });
  const questions = open.map((r) => ({ seq: r.seq, from: r.from_name, to: r.to_name ?? null, msg: String(r.msg ?? "").slice(0, 300), at: r.ts, task: P3(r.data, {})?.task ?? null }));
  for (const q of questions) if (per.has(top(q.from))) per.get(top(q.from)).asked++;
  const blocked = tasks.filter((t) => t.status === "blocked").map((t) => ({ id: t.id, title: t.title, owner: t.owner, waits_on: t.blocked_by }));
  const notesOf = new Map((await ch.store.all("SELECT id, status_note FROM tasks WHERE status='blocked'")).map((r) => [r.id, r.status_note]));
  for (const b2 of blocked) b2.note = notesOf.get(b2.id) ?? "";
  let cost = { available: false, total: null, range: rangeFor(now3 - from) };
  if (o.cost !== false) {
    const m = await costBySession(cost.range);
    if (m) {
      const L = await links(ch);
      let total = 0;
      for (const [cid, usd2] of m) {
        const n = L.get(cid);
        if (!n) continue;
        const s2 = S(n);
        s2.cost = (s2.cost ?? 0) + usd2;
        total += usd2;
      }
      cost = { ...cost, available: true, total };
    }
  }
  const order = (s2) => s2.name === OWNER ? 1 : 0;
  const list = [...per.values()].filter((s2) => s2.events || s2.notes.length || s2.state && s2.state !== "left" || s2.cost).sort((a, b2) => order(a) - order(b2) || b2.done.length + b2.knowledge.length - (a.done.length + a.knowledge.length) || b2.events - a.events || a.name.localeCompare(b2.name));
  return {
    channel: ch.name,
    title: ch.config().title,
    since: at,
    until: iso3(now3),
    totals: {
      done: list.reduce((n, s2) => n + s2.done.length, 0),
      notes: notes.length,
      knowledge: kbIds.length,
      events: events.length,
      blocked: blocked.length,
      questions: questions.length,
      approvals: list.reduce((n, s2) => n + s2.approvals.length, 0)
    },
    sessions: list,
    blocked,
    questions,
    cost
  };
}
var usd = (n) => n >= 100 ? `$${n.toFixed(0)}` : n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : "$0";
function digestText(r) {
  const T = r.totals;
  const L = [
    `digest: ${r.title} \xB7 since ${r.since}`,
    `${T.done} task${T.done === 1 ? "" : "s"} finished \xB7 ${T.knowledge} knowledge \xB7 ${T.notes} note${T.notes === 1 ? "" : "s"} \xB7 ${T.blocked} blocked \xB7 ${T.questions} open question${T.questions === 1 ? "" : "s"}${r.cost.available ? ` \xB7 est. cost ${usd(r.cost.total ?? 0)} (observatory, this ${r.cost.range})` : ""}`
  ];
  for (const s2 of r.sessions) {
    L.push("", `${s2.name === OWNER ? "owner (you)" : s2.name}${s2.state ? ` (${s2.state})` : ""}${s2.cost != null ? ` \xB7 est. ${usd(s2.cost)}` : ""} \xB7 ${s2.events} event${s2.events === 1 ? "" : "s"}`);
    for (const d of s2.done) L.push(`  ${d.status === "skipped" ? "skipped" : "done"} ${d.id}${d.title ? ` ${d.title}` : ""}${d.note ? ` \u2014 ${d.note.slice(0, 120)}` : ""}`);
    for (const k of s2.knowledge) L.push(`  kb #${k.id} [${k.kind ?? "?"}] ${k.title ?? ""}`);
    for (const n of s2.notes.slice(0, 8)) L.push(`  note on ${n.task} [${n.kind}] ${n.body.replace(/\s+/g, " ").slice(0, 100)}`);
    if (s2.notes.length > 8) L.push(`  \u2026 ${s2.notes.length - 8} more notes`);
    if (s2.approvals.length) L.push(`  asked permission ${s2.approvals.length}\xD7: ${[...new Set(s2.approvals.flatMap((a) => a.labels))].join(", ")}`);
    if (!s2.done.length && !s2.knowledge.length && !s2.notes.length && !s2.approvals.length) L.push("  nothing finished or shared");
  }
  if (r.blocked.length) {
    L.push("", "blocked now:");
    for (const b2 of r.blocked) L.push(`  ${b2.id} ${b2.title}${b2.owner ? ` @${b2.owner}` : ""}${b2.note ? ` \u2014 ${b2.note.slice(0, 120)}` : ""}${b2.waits_on?.length ? ` (waits on ${b2.waits_on.join(", ")})` : ""}`);
  }
  if (r.questions.length) {
    L.push("", "open questions:");
    for (const q of r.questions.slice(0, 20)) L.push(`  #${q.seq} ${q.from} \u2192 ${q.to ?? "everyone"}: ${q.msg.replace(/\s+/g, " ").slice(0, 140)}`);
  }
  return L.join("\n");
}

// plugin/server/src/ops.ts
var s = (description) => ({ type: "string", ...description ? { description } : {} });
var i = (description) => ({ type: "integer", ...description ? { description } : {} });
var b = (description) => ({ type: "boolean", ...description ? { description } : {} });
var arr = (description) => ({ type: "array", items: { type: "string" }, ...description ? { description } : {} });
var en = (vals, description) => ({ type: "string", enum: vals, ...description ? { description } : {} });
var timeout = (c, a) => Math.max(0, Math.min(3600, Number(a.timeout ?? c.waitDefault)));
var OPS = {
  join: {
    desc: "Join the channel (or resume). Returns who else is here, the turn, your pause state, your inbox, your next task and the latest shared knowledge, plus either your unread events (context sync) or a brief instead of the backlog (context fresh). Call first.",
    props: {
      role: s("one line: what you do here"),
      label: s(),
      task: s("what you are doing now"),
      context: en(CONTEXTS, "sync: everything unread since you left; fresh: skip the backlog, get a brief (open asks are kept). Omit it: fresh on a first join, else what the orchestrator set for you, else sync")
    },
    run: (c, a) => c.ch.join(c.me, { role: a.role, label: a.label, task: a.task, context: a.context }),
    text: (r) => snapText(r)
  },
  status: { desc: "The same picture as join, without changing presence.", props: {}, run: (c) => c.ch.snapshot(c.me), text: (r) => snapText(r) },
  leave: { desc: "Leave the channel when your work is finished (subagents: always, with a one-line summary).", props: { summary: s() }, run: (c, a) => c.ch.leave(c.me, a.summary ?? "") },
  sessions: { desc: "Every session and subagent: state, task, pause, unread, open asks, who holds the turn.", props: {}, run: (c) => c.ch.sessions() },
  state: {
    desc: "Say what you are doing (shown live to the owner and the other sessions).",
    props: { state: en(STATES), task: s(), step: s("task id") },
    required: ["state"],
    run: (c, a) => c.ch.presence(c.me, { state: a.state, task: a.task, step: a.step })
  },
  publish: {
    desc: "Publish an event on the channel (to everyone, or to one session with `to`). Durable; wakes whoever waits on the topic. key makes a retry idempotent.",
    props: { topic: s("e.g. finding.ready, build.ready"), msg: s(), to: s("one session; omit for everyone"), ref: s("file or id the event is about"), data: { type: "object" }, ask: b("needs a reply: lands in the recipient's inbox"), key: s("idempotency key") },
    required: ["topic", "msg"],
    run: (c, a) => c.ch.publish(c.me, { topic: a.topic, msg: a.msg, to: a.to, ref: a.ref, data: a.data, needs_reply: a.ask, key: a.key })
  },
  send: {
    desc: "Message one session (to) or everyone. ask=true needs a reply: it sits in their inbox and wakes their wait until they answer.",
    props: { to: s("session name; omit for everyone"), msg: s(), ask: b(), task: s("task id it is about"), key: s() },
    required: ["msg"],
    run: (c, a) => c.ch.send(c.me, a.to ?? null, a.msg, { ask: a.ask, task: a.task, key: a.key })
  },
  reply: { desc: "Answer a message (by seq). Closes it in your inbox.", props: { seq: i(), msg: s() }, required: ["seq", "msg"], run: (c, a) => c.ch.reply(c.me, Number(a.seq), a.msg) },
  inbox: { desc: "Messages waiting for your reply (asks from sessions, the owner's directives).", props: {}, run: (c) => c.ch.inbox(c.me) },
  events: { desc: "Read the channel history (newest last).", props: { after: i(), limit: i(), topic: s("glob"), from: s() }, run: (c, a) => c.ch.events({ after: a.after, limit: a.limit, topic: a.topic, from: a.from }) },
  wait: {
    desc: "Block until (1) a message needs your reply \u2192 kind=message, (2) the first unread event for you (to you or to everyone) matching a topic glob \u2192 kind=event (handle it and its skipped list, which includes messages between other sessions, then ack its seq), or (3) timeout \u2192 call wait again. Use this to stop and listen while another session works.",
    props: { topics: arr("globs, e.g. task.ready build.* turn.pass; empty = any"), timeout: i("seconds; omit it: the default waits as long as the transport allows, and a timeout only means call wait again") },
    blocks: true,
    run: (c, a) => c.ch.wait(c.me, a.topics ?? [], timeout(c, a), c.signal)
  },
  ack: { desc: "Mark everything up to seq as handled (your cursor; never moves back).", props: { seq: i() }, required: ["seq"], run: (c, a) => c.ch.ack(c.me, Number(a.seq)) },
  gate: {
    desc: "Check the pause. block=true (default) waits until you are resumed. Call before any action that changes things; while paused, publish/task changes are refused.",
    props: { block: b(), timeout: i() },
    blocks: true,
    run: async (c, a) => a.block === false ? { control: await c.ch.controlOf(c.me) } : c.ch.gate(c.me, Number(a.timeout ?? 0), c.signal)
  },
  pause: { desc: "Pause another session (it stops at its next gate; its writes are refused until resume).", props: { target: s(), why: s() }, required: ["target"], run: (c, a) => c.ch.control(c.me, a.target, "pause", a.why) },
  resume: { desc: "Resume a paused session.", props: { target: s(), why: s() }, required: ["target"], run: (c, a) => c.ch.control(c.me, a.target, "resume", a.why) },
  turn: { desc: "Who holds the turn (in ping-pong work only the holder acts), and the event that gave it.", props: {}, run: (c) => c.ch.turn() },
  pass: { desc: "Hand the turn to another session, with what it should do next.", props: { to: s(), msg: s() }, required: ["to"], run: (c, a) => c.ch.passTurn(c.me, a.to, a.msg) },
  take: { desc: "Take the turn (only when the owner asked you to, or the channel works in parallel).", props: { msg: s() }, run: (c, a) => c.ch.takeTurn(c.me, a.msg) },
  next: {
    desc: "Your next task in plan order (yours or unowned): what, why, how, checks, the owner's notes (they override the text). ready=false lists what it waits on: wait for task.ready.",
    props: { json: b() },
    run: (c) => c.ch.next(c.me),
    text: (r, c) => r.done ? "every task you can take is done or skipped" : taskText(r, c.ch.name)
  },
  task: {
    desc: "One task as the owner sees it.",
    props: { id: s(), json: b() },
    required: ["id"],
    run: async (c, a) => await c.ch.task(a.id) ?? (() => {
      throw new HuddleError(404, `no task ${a.id}`);
    })(),
    text: (r, c) => taskText(r, c.ch.name)
  },
  map: {
    desc: "The big picture, when you need it: each phase's progress, what every session does now and next, and the critical path (the longest chain of unfinished dependencies).",
    props: { json: b() },
    run: (c) => c.ch.map(),
    text: (r) => mapText(r)
  },
  tasks: {
    desc: "The plan as a list (filter by owner, status, phase).",
    props: { owner: s(), status: en(STATUSES), phase: i() },
    run: (c, a) => c.ch.tasks({ owner: a.owner, status: a.status, phase: a.phase }),
    text: (r) => r.map((t) => `${t.id} [${t.status}]${t.owner ? ` @${t.owner}` : ""} ${t.title}${t.blocked_by.length ? `  \u27F5 waits on ${t.blocked_by.join(", ")}` : ""}`).join("\n") || "(no tasks)"
  },
  task_create: {
    desc: "Create a task, optionally for another session (owner) and after other tasks (after): that session gets task.created now and task.ready when the dependencies finish.",
    props: { title: s(), owner: s(), after: arr("task ids it waits on"), id: s(), phase: i(), what: s(), how: arr(), verify: arr() },
    required: ["title"],
    run: (c, a) => c.ch.createTask(c.me, { id: a.id, title: a.title, owner: a.owner, after: a.after, phase: a.phase, body: { what: a.what ?? "", how: a.how ?? [], verify: (a.verify ?? []).map((v) => ({ cmd: v, expect: "" })) } })
  },
  task_update: {
    desc: "Reassign (owner), change dependencies (after; cycles are refused) or edit a field (field + value; null restores the plan's text).",
    props: { id: s(), owner: s(), after: arr(), field: s(), value: {} },
    required: ["id"],
    run: (c, a) => c.ch.updateTask(c.me, a.id, { owner: a.owner, after: a.after, field: a.field, value: a.value }),
    text: (r, c) => taskText(r, c.ch.name)
  },
  task_status: {
    desc: "Move a task: doing (refused while it waits on unfinished tasks), done (with evidence in note: releases the tasks waiting on it), blocked (why), skipped.",
    props: { id: s(), status: en(STATUSES), note: s("evidence or reason") },
    required: ["id", "status"],
    run: (c, a) => c.ch.setStatus(c.me, a.id, a.status, a.note ?? "")
  },
  wait_task: {
    desc: "Block until a task (usually another session's) is done or skipped.",
    props: { id: s(), timeout: i("seconds; omit it") },
    required: ["id"],
    blocks: true,
    run: (c, a) => c.ch.waitTask(c.me, a.id, timeout(c, a), c.signal)
  },
  note: { desc: "Add a review note to a task.", props: { id: s(), kind: en(NOTE_KINDS), body: s() }, required: ["id", "kind", "body"], run: (c, a) => c.ch.note(c.me, a.id, a.kind, a.body), text: (r, c) => taskText(r, c.ch.name) },
  // ── workflows: the common moves in one call each (fewer turns, fewer tokens) ──
  start: {
    desc: 'Start work: checks the pause, takes the task (id, or your next one), marks it doing and returns its full text. If it still waits on other tasks, says on which and does not start it: then call wait with topics ["task.ready"].',
    props: { id: s("task id; omit for your next task") },
    run: async (c, a) => {
      if (await c.ch.controlOf(c.me) === "pause") return { started: false, paused: true, hint: "paused: call gate" };
      const t = a.id ? await c.ch.task(a.id) : await c.ch.next(c.me);
      if (!t) throw new HuddleError(404, `no task ${a.id}`);
      if (t.done) return { started: false, done: true };
      if (!t.ready) return { started: false, task: t, hint: `waits on ${t.unmet.map((u) => `${u.id} (${u.owner ?? "unowned"}, ${u.status})`).join(", ")}: wait with topics ["task.ready"]` };
      if (t.status !== "doing") await c.ch.setStatus(c.me, t.id, "doing");
      await c.ch.presence(c.me, { state: "working", task: `${t.id} ${t.title}`, step: t.id });
      return { started: true, task: await c.ch.task(t.id) };
    },
    text: (r, c) => r.paused ? "PAUSED: call gate before any work" : r.done ? "every task you can take is done or skipped" : `${r.started ? "STARTED" : `NOT STARTED: ${r.hint}`}

${taskText(r.task, c.ch.name)}`
  },
  finish: {
    desc: "Finish a task: marks it done with your evidence (note), optionally shares its output as a result others can recall, and returns what it released and your next task.",
    props: { id: s("omit for the task you are doing"), note: s("evidence: command + result"), result: s("output another task needs (stored as knowledge kind=result)"), title: s("title for that result") },
    required: ["note"],
    run: async (c, a) => {
      const id = a.id ?? await c.ch.current(c.me);
      if (!id) throw new HuddleError(400, "no task in progress: pass id");
      const before = await c.ch.lastSeq();
      await c.ch.setStatus(c.me, id, "done", a.note);
      const released = (await c.ch.events({ after: before, topic: "task.ready" })).map((e) => ({ task: e.ref, to: e.to }));
      const t = await c.ch.task(id);
      const kb2 = a.result ? await c.ch.remember(c.me, { kind: "result", title: a.title ?? `${id} ${t.title}`, body: a.result, task: id }) : null;
      const n = await c.ch.next(c.me);
      await c.ch.presence(c.me, { state: "working", task: `finished ${id}`, step: null });
      return { done: id, released, knowledge: kb2?.id ?? null, next: n.done ? null : { id: n.id, title: n.title, ready: n.ready, unmet: n.unmet?.map((u) => u.id) } };
    }
  },
  depend: {
    desc: "You need another session's work before yours can go on: creates a task for that session, makes your task wait on it, marks yours blocked, then blocks until it is released (task.ready) \u2014 one call instead of four.",
    props: { owner: s("the session that must do it"), title: s("what they must do"), what: s("details"), id: s("your task; omit for the one you are doing"), wait: b("default true"), timeout: i("seconds; omit it") },
    required: ["owner", "title"],
    blocks: true,
    run: async (c, a) => {
      const mine = a.id ?? await c.ch.current(c.me);
      if (!mine) throw new HuddleError(400, "no task in progress: pass id");
      const t = (await c.ch.createTask(c.me, { title: a.title, owner: a.owner, body: { what: a.what ?? "" } })).task;
      const cur = await c.ch.task(mine);
      await c.ch.updateTask(c.me, mine, { after: [.../* @__PURE__ */ new Set([...cur.depends, t.id])] });
      await c.ch.setStatus(c.me, mine, "blocked", `waits on ${t.id} (${a.owner}): ${a.title}`);
      if (a.wait === false) return { created: t.id, blocked: mine, waiting: false };
      const h = await c.ch.wait(c.me, ["task.ready"], timeout(c, a), c.signal);
      return { created: t.id, blocked: mine, woke: h, hint: h.kind === "event" ? `ack ${h.seq}, then start ${mine}` : 'call wait with topics ["task.ready"]' };
    }
  },
  handoff: {
    desc: "Hand the work to another session in one call: optionally creates a task for it (title, after), passes the turn with your message, then waits for your next wake-up (unless wait=false).",
    props: { to: s(), msg: s("what they should do next"), title: s("create a task for them with this title"), after: arr("their task waits on these"), topics: arr("what to wait for afterwards; default turn.pass task.ready"), wait: b("default true"), timeout: i("seconds; omit it") },
    required: ["to", "msg"],
    blocks: true,
    run: async (c, a) => {
      const task = a.title ? (await c.ch.createTask(c.me, { title: a.title, owner: a.to, after: a.after })).task.id : null;
      const ev2 = await c.ch.passTurn(c.me, a.to, a.msg);
      if (a.wait === false) return { passed: ev2.seq, task };
      const h = await c.ch.wait(c.me, a.topics ?? ["turn.pass", "task.ready"], timeout(c, a), c.signal);
      return { passed: ev2.seq, task, woke: h };
    }
  },
  ask_wait: {
    desc: "Ask one session a question and block until it replies (the answer comes back as the result).",
    props: { to: s(), msg: s(), timeout: i("seconds; omit it") },
    required: ["to", "msg"],
    blocks: true,
    run: async (c, a) => {
      const q = await c.ch.send(c.me, a.to, a.msg, { ask: true });
      const h = await c.ch.waitReply(c.me, q.seq, timeout(c, a), c.signal);
      return h.kind === "event" ? { asked: q.seq, answer: h.msg, from: h.from, seq: h.seq } : { asked: q.seq, ...h, hint: "no reply yet: the ask stays open; wait again later" };
    }
  },
  remember: {
    desc: "Share what you learned so no other session or subagent pays for it again: fact, lesson, decision (with why), context (summary of what you read), result (output of finished work), howto (commands that work). supersedes retires an older entry. If an entry already says the same, nothing is added and you get its id: supersede it, verify it, or pass force. scope=server: for every channel on this server (tool quirks, machine facts).",
    props: {
      kind: en(KB_KINDS),
      title: s("one line, searchable"),
      body: s(),
      tags: arr(),
      refs: arr("files, urls, event seqs (a file that changes later marks the entry may be stale)"),
      task: s(),
      supersedes: i(),
      scope: en(["channel", "server"], "channel (default) or server: every channel on this server"),
      force: b("add it even if a similar entry exists")
    },
    required: ["kind", "title", "body"],
    run: (c, a) => remember(c.ch, c.me, { kind: a.kind, title: a.title, body: a.body, tags: a.tags, refs: a.refs, task: a.task, supersedes: a.supersedes, scope: a.scope, force: !!a.force }),
    text: (r) => r.duplicate ? `not added: ${r.hint}` : `#${r.id} remembered: ${r.title}`
  },
  recall: {
    desc: `Search the shared knowledge (this channel's and the entries for every channel) before reading files or re-deriving anything. Verified entries come first; each shows its age, and "may be stale" when it is old or its files changed. Returns titles and snippets; read one with kb.`,
    props: { q: s("words; empty = latest"), kind: en(KB_KINDS), tag: s(), by: s(), limit: i() },
    run: (c, a) => recall(c.ch, a.q ?? "", { kind: a.kind, tag: a.tag, by: a.by, limit: a.limit }),
    text: (r) => r.map((k) => `#${k.id} [${k.kind}] ${k.title} \u2014 ${k.by}${kbFlags(k)}${k.tags.length ? ` {${k.tags.join(",")}}` : ""}
   ${String(k.hit ?? "").replace(/\s+/g, " ").slice(0, 240)}`).join("\n") || "(nothing yet: remember what you learn)"
  },
  kb: {
    desc: "Read one knowledge entry in full.",
    props: { id: i() },
    required: ["id"],
    run: (c, a) => kb(c.ch, Number(a.id)),
    text: (k) => `#${k.id} [${k.kind}] ${k.title}
by ${k.by} \xB7 ${k.created_at}${kbFlags(k)}${k.task ? ` \xB7 task ${k.task}` : ""}${k.superseded_by ? ` \xB7 SUPERSEDED by #${k.superseded_by}` : ""}${k.moved_to ? ` \xB7 now for every channel as #${k.moved_to}` : ""}
${k.tags.length ? `tags: ${k.tags.join(", ")}
` : ""}${k.refs.length ? `refs: ${k.refs.join(", ")}
` : ""}
${k.body}`
  },
  verify: {
    desc: 'Vouch for a knowledge entry you checked is still right (verified entries come first in recall; verifying also clears "may be stale"). undo=true takes it back.',
    props: { id: i(), undo: b() },
    required: ["id"],
    run: (c, a) => verify(c.ch, c.me, Number(a.id), !!a.undo),
    text: (k) => `#${k.id} ${k.verified_at ? `verified by ${k.verified_by}` : "no longer verified"}: ${k.title}`
  },
  share: {
    desc: "Make one of this channel's knowledge entries one for every channel on this server (a tool quirk, a machine fact); it gets a new id.",
    props: { id: i() },
    required: ["id"],
    run: (c, a) => share(c.ch, c.me, Number(a.id)),
    text: (k) => `#${k.id} is for every channel now${k.from ? ` (was #${k.from})` : ""}: ${k.title}`
  },
  digest: {
    desc: "What happened since a moment (default: the last 24 h), per session: tasks finished, notes, knowledge added, approval requests; what is blocked now and the questions still open; and the estimated cost per session when the Observatory plugin runs. Built from the channel's history, no model calls.",
    props: { since: s("24h, 90m, 7d or an ISO date; default 24h"), json: b() },
    run: (c, a) => digest(c.ch, a.since),
    text: (r) => digestText(r)
  }
};
var OWNER_OPS = {
  configure: {
    desc: "Owner or orchestrator: configure the channel: title, description, start (who holds the turn first), handover ({sender: {to, topics}}), profile, repo; the owner only: members, orchestrator.",
    props: { title: s(), description: s(), start: s(), handover: { type: "object" }, profile: s(), repo: s(), members: arr("who may join; empty = anyone"), orchestrator: s("the session that runs the plan with the owner; empty = none") },
    owner: true,
    run: (c, a) => {
      if (c.me !== OWNER && (a.members !== void 0 || a.orchestrator !== void 0)) throw new HuddleError(403, "only the owner changes members and the orchestrator");
      return c.ch.configure(a);
    }
  },
  import_plan: {
    desc: "Owner or orchestrator: load a plan {phases:[{n,title,\u2026,steps:[{id,title,owner,depends,\u2026}]}]}; merged by task id, keeping status, edits and notes.",
    props: { plan: { type: "object" }, owner: s("owner of steps that name none") },
    required: ["plan"],
    owner: true,
    run: (c, a) => c.ch.importPlan(c.me, a.plan, { owner: a.owner })
  },
  approve: { desc: "Owner or orchestrator: approve a gated task (owner / ask-first): a note on it and a message to its owner.", props: { id: s(), msg: s() }, required: ["id"], owner: true, run: (c, a) => c.ch.approve(a.id, a.msg ?? "", c.me) },
  note_edit: { desc: "Owner or orchestrator: resolve, edit or remove a note.", props: { id: i(), resolved: b(), body: s(), remove: b() }, required: ["id"], owner: true, run: (c, a) => c.ch.editNote(Number(a.id), a) },
  assign: {
    desc: "Owner or orchestrator: how a session joins when it returns (context sync or fresh; null = sync), and optionally a task it now owns.",
    props: { session: s(), context: { type: ["string", "null"], enum: [...CONTEXTS, null] }, task: s("task id to give the session") },
    required: ["session"],
    owner: true,
    run: (c, a) => c.ch.assign(c.me, a.session, a.context ?? null, a.task)
  },
  brief: {
    desc: "Owner or orchestrator: what a session gets on its next fresh join instead of the history (kept until then; also sent now as a message).",
    props: { session: s(), msg: s() },
    required: ["session", "msg"],
    owner: true,
    run: (c, a) => c.ch.brief(c.me, a.session, a.msg)
  }
};
function identity(conn, as) {
  if (as == null || as === "" || as === conn) return conn;
  const a = String(as);
  if (!NAME_RE.test(a) && a !== OWNER) throw new HuddleError(400, `bad identity ${a}`);
  if (conn === OWNER || a.startsWith(conn + ".")) return a;
  throw new HuddleError(403, `${conn} may act only as itself or its subagents (${conn}.<role>), not ${a}`);
}
var HOOK_OPS = {
  touched: {
    desc: "The PostToolUse hook: this session edited a file (path relative to its repo).",
    props: { path: s(), repo: s() },
    required: ["path", "repo"],
    run: (c, a) => touched(c.ch, c.me, a),
    text: (r) => r.warn ?? ""
  }
};
var kbFlags = (k) => [
  k.age_days != null ? ` \xB7 ${k.age_days ? `${k.age_days}d old` : "today"}` : "",
  k.verified_at ? ` \xB7 verified (${k.verified_by})` : "",
  k.scope === "server" ? " \xB7 every channel" : "",
  k.stale ? ` \xB7 MAY BE STALE: ${k.stale}` : ""
].join("");
async function runOp(name, ch, conn, args, o = {}) {
  const op = OPS[name] ?? OWNER_OPS[name] ?? HOOK_OPS[name];
  if (!op) throw new HuddleError(404, `no operation ${name}`);
  const { as, ...a } = args ?? {};
  const me = identity(conn, as);
  if (op.owner && me !== OWNER && me !== ch.config().orchestrator) throw new HuddleError(403, `${name} is the owner's or the orchestrator's`);
  for (const r of op.required ?? []) if (a[r] === void 0 || a[r] === null || a[r] === "") throw new HuddleError(400, `${name}: missing ${r}`);
  if (name !== "join") await ch.touch(me);
  const ctx = { ch, me, signal: o.signal, waitDefault: o.waitDefault ?? 240 };
  const result = await op.run(ctx, a);
  return { result, text: op.text && !a.json ? op.text(result, ctx) : null };
}
function toolDefs() {
  return Object.entries({ ...OPS, ...OWNER_OPS }).map(([name, op]) => ({
    name,
    description: op.desc,
    inputSchema: { type: "object", properties: { ...op.props, as: s("act as one of your subagents: <you>.<role> (join it first)") }, ...op.required?.length ? { required: op.required } : {} }
  }));
}
function snapText(r) {
  const L = [
    `channel ${r.channel} \xB7 you are ${r.me} \xB7 ${r.control === "run" ? "running" : "PAUSED: call gate before any work"}`,
    `turn: ${r.turn.holder ?? "free (parallel)"}${r.turn.since ? ` (since #${r.turn.since.seq} ${r.turn.since.from} ${r.turn.since.topic})` : ""}`
  ];
  if (r.orchestrator) L.push(`orchestrator: ${r.orchestrator}${r.orchestrator === r.me ? " (you: you run the plan with the owner)" : ""}`);
  if (r.context) L.push(r.context === "fresh" ? `context: fresh (${r.skipped} earlier events skipped; asks kept)` : "context: sync (everything unread since you left)");
  if (r.brief) {
    const b2 = r.brief;
    L.push(`brief: ${b2.title}${b2.goal ? ` \xB7 ${b2.goal}` : ""}`);
    if (b2.from_orchestrator) L.push(`from ${b2.from_orchestrator.by} (${b2.from_orchestrator.at}): ${b2.from_orchestrator.msg}`);
    L.push(`your tasks: ${b2.tasks.length ? "" : "none"}${b2.tasks.map((t) => `
  ${t.id} [${t.status}] ${t.title}${t.ready ? "" : ` (waits on ${t.waits_on.join(", ")})`}`).join("")}`);
    if (b2.knowledge.length) L.push(`relevant knowledge (kb <id> to read):${b2.knowledge.map((k) => `
  #${k.id} [${k.kind}] ${k.title} (${k.by})`).join("")}`);
  }
  L.push(`others: ${r.sessions.length ? r.sessions.map((x) => `${x.name}${x.control === "pause" ? "(paused)" : ""} ${x.state}${x.task ? ": " + x.task : ""}${x.stale ? " [stale]" : ""}`).join(" \xB7 ") : "none yet"}`);
  L.push(`inbox: ${r.inbox.length}${r.inbox.map((m) => `
  #${m.seq} from ${m.from}: ${m.msg}`).join("")}`);
  L.push(`unread: ${r.unread_total}${r.unread_total ? " \u2192 " + r.unread.slice(-12).map((e) => `#${e.seq} ${e.from}${e.to ? `\u2192${e.to}` : ""} ${e.topic}`).join(", ") : ""}`);
  if (r.next) L.push(`next task: ${r.next.id} ${r.next.title}${r.next.ready ? "" : ` (waits on ${r.next.unmet.map((u) => `${u.id}@${u.owner ?? "?"}:${u.status}`).join(", ")})`}`);
  if (r.knowledge) L.push(`knowledge: ${r.knowledge.total} entries${r.knowledge.latest.length ? "\n  " + r.knowledge.latest.join("\n  ") : ""} \u2014 recall before you read or re-derive`);
  return L.join("\n");
}
function mapText(r) {
  const L = [`map: ${r.title} \xB7 ${r.done}/${r.total} tasks done${r.orchestrator ? ` \xB7 orchestrator ${r.orchestrator}` : ""}`, "phases:"];
  const ph = r.phases;
  const first = Math.max(0, ph.findIndex((p) => p.done < p.total));
  const shown = ph.length > 14 ? ph.slice(first, first + 12) : ph;
  if (shown[0] !== ph[0] && first > 0) L.push(`  \u2026 ${first} finished phase(s)`);
  for (const p of shown) L.push(`  ${String(p.n ?? "-").padStart(3)} ${p.done === p.total ? "\u2713" : " "} ${p.done}/${p.total}  ${p.title}`);
  const after = ph.length - (ph.indexOf(shown[shown.length - 1]) + 1);
  if (after > 0) L.push(`  \u2026 ${after} more phase(s)`);
  L.push("sessions:");
  for (const s2 of r.sessions.slice(0, 10)) L.push(`  ${s2.name} (${s2.state}): ${s2.current ? `doing ${s2.current.id} ${s2.current.title}` : "nothing in progress"}${s2.next ? ` \xB7 next ${s2.next.id}${s2.next.ready ? "" : " (waits)"}` : ""}`);
  const cp = r.critical_path;
  L.push(`critical path (${cp.length} open task${cp.length === 1 ? "" : "s"} in a chain): ${cp.length ? "" : "none"}`);
  for (const t of cp.slice(0, 10)) L.push(`  ${t.id} [${t.status}]${t.owner ? ` @${t.owner}` : ""} ${t.title}`);
  if (cp.length > 10) L.push(`  \u2026 ${cp.length - 10} more`);
  return L.join("\n");
}
function taskText(t, channel) {
  const L = [];
  const gate = t.gate && t.gate !== "none" ? ` \xB7 gate ${t.gate}` : "";
  L.push(`${t.id}  ${t.title}`, `${t.kind ?? "task"}${t.risk ? ` \xB7 ${t.risk} risk` : ""}${gate} \xB7 ${t.status}${t.owner ? ` \xB7 owner ${t.owner}` : " \xB7 unowned"}${t.status_by ? ` (last by ${t.status_by})` : ""}`);
  if (t.unmet?.length) L.push(`WAITS ON: ${t.unmet.map((u) => `${u.id} (${u.owner ?? "unowned"}, ${u.status})`).join(", ")} \u2192 wait with topics ["task.ready"] or wait_task`);
  const notes = t.open_notes ?? [];
  if (notes.length) L.push("", "OWNER NOTES (read first; they override the text below):", ...notes.map((c) => `  [${c.kind}] ${c.body}${c.by && c.by !== "owner" ? ` \u2014 ${c.by}` : ""}`));
  if (Object.keys(t.edited ?? {}).length) L.push(`(edited: ${Object.keys(t.edited).join(", ")})`);
  if (t.what) L.push("", "WHAT", t.what);
  if (t.why) L.push("", "WHY", t.why);
  if (t.alternatives?.length) L.push("", "NOT THAT WAY", ...t.alternatives.map((a) => `  - ${a.option}: ${a.why_not}`));
  if (t.how?.length) L.push("", "HOW", ...t.how.map((h, n) => `  ${n + 1}. ${h}`));
  for (const sn of t.snippets ?? []) L.push("", `CODE: ${sn.title}${sn.path ? ` (${sn.path})` : ""}${sn.proposed ? " [proposed]" : ""}`, ...String(sn.code).split("\n").map((x) => "    " + x));
  if (t.verify?.length) L.push("", "CHECK", ...t.verify.map((v) => `  $ ${v.cmd}${v.expect ? `
    \u2192 ${v.expect}` : ""}`));
  if (t.value) L.push("", "DONE MEANS", t.value);
  if (t.use) L.push("", "USE", t.use);
  if (t.rollback) L.push("", "ROLLBACK", t.rollback);
  if (t.depends?.length) L.push("", `depends on ${t.depends.join(", ")}`);
  if (t.needed_by?.length) L.push(`needed by ${t.needed_by.join(", ")}`);
  L.push("", `board: /#/c/${channel}/t/${t.id}`);
  return L.join("\n");
}

// plugin/server/src/mcp.ts
import { readFileSync as readFileSync2 } from "node:fs";
var VERSION = (() => {
  try {
    return JSON.parse(readFileSync2(`${PLUGIN}/.claude-plugin/plugin.json`, "utf8")).version ?? "dev";
  } catch {
    return "dev";
  }
})();
var instructions = (ch, me) => `You are "${me}" in Huddle channel "${ch}": every session (and subagent) in this channel sees the same events, tasks and shared knowledge, so act as one team.
Protocol (the huddle skill has the full version):
1. You are already joined (the session start did it): call status to refresh; join only to change your role or context. Tools are mcp__plugin_huddle_huddle__<op>; from Bash, \`huddle <op>\`.
2. recall before reading files or re-deriving anything; remember what you learn (fact, lesson, decision, context, result, howto).
3. gate before any change (paused = stop). Answer every inbox message with reply.
4. Work: start (takes your next task, or the id you name) \u2192 do it \u2192 finish "<command + result>" (releases what waited on it, names your next). When start says the task waits on another session's: wait with topics ["task.ready"] (or wait_task) instead of polling or guessing.
5. Need someone else: send (ask=true for a reply), or task_create with owner and after. Ping-pong work: only the turn holder acts; pass the turn when done.
6. Idle or blocked on others: wait (it returns kind message | event | timeout; on event, handle it and its skipped list, then ack its seq; on timeout, wait again).
7. Subagents you start: they join as "${me}.<role>" (pass as), share results with remember, and leave when done.`;
var ev = (e) => `#${e.seq} ${e.from} \u2192 ${e.to ?? "all"} (${e.topic}): ${String(e.msg ?? "").slice(0, 400)}`;
var SHORT = {
  send: (r) => r?.seq ? `#${r.seq} sent to ${r.to ?? "everyone"}${r.needs_reply ? " (an ask: it waits for a reply)" : ""}` : null,
  publish: (r) => r?.seq ? `#${r.seq} published (${r.topic}) to ${r.to ?? "everyone"}` : null,
  reply: (r) => r?.seq ? `#${r.seq} replied` : null,
  remember: (r) => r?.id ? `#${r.id} remembered: ${r.title}` : null,
  task_create: (r) => r?.task?.id ? `created ${r.task.id} \u2192 ${r.task.owner ?? "unowned"} (${r.task.ready ? "ready" : `waits on ${(r.task.unmet ?? []).map((u) => u.id).join(", ")}`})` : null,
  finish: (r) => r?.done ? `done ${r.done}; released: ${r.released?.length ? r.released.map((x) => `${x.task}\u2192${x.to ?? "?"}`).join(", ") : "none"}${r.knowledge ? `; result #${r.knowledge}` : ""}; next: ${r.next ? `${r.next.id} ${r.next.title}${r.next.ready ? "" : ` (waits on ${(r.next.unmet ?? []).join(", ")})`}` : "none"}` : null,
  wait: (r) => r?.kind === "timeout" ? "timeout: call wait again" : r?.kind && r.seq ? [`${r.kind}: ${ev(r)}${r.needs_reply ? ` [answer: reply seq=${r.seq}]` : ""}${r.more ? ` (+${r.more} more waiting)` : ""} \u2014 ack ${r.seq} once handled`, ...(r.skipped ?? []).map((e) => `  skipped ${ev(e)}`), ...r.skipped_total > (r.skipped?.length ?? 0) ? [`  (${r.skipped_total - r.skipped.length} older skipped: events)`] : []].join("\n") : null
};
var inflight = /* @__PURE__ */ new Map();
async function mcpHandle(hub2, channel, conn, m, signal) {
  const reply = (result) => ({ jsonrpc: "2.0", id: m.id ?? null, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: m.id ?? null, error: { code, message } });
  const key = `${channel}/${conn}/${String(m.params?.requestId ?? m.id)}`;
  if (m.method === "notifications/cancelled") {
    inflight.get(key)?.abort();
    return null;
  }
  if (m.id === void 0 || m.id === null) return null;
  switch (m.method) {
    case "initialize":
      return reply({
        protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {}, experimental: { "claude/channel": {} } },
        serverInfo: { name: "huddle", version: VERSION },
        instructions: instructions(channel, conn)
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: toolDefs() });
    case "tools/call": {
      const ac = new AbortController();
      inflight.set(key, ac);
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort);
      try {
        const ch = await hub2.get(channel);
        const args = { ...m.params?.arguments ?? {} };
        if (["wait", "wait_task", "depend", "handoff", "ask_wait"].includes(String(m.params?.name)) && args.timeout !== void 0) args.timeout = Math.max(60, Number(args.timeout) || 0);
        const { result, text } = await runOp(String(m.params?.name ?? ""), ch, conn, args, { signal: ac.signal, waitDefault: 240 });
        const name = String(m.params?.name ?? "");
        const short = text ?? (args.json ? null : (() => {
          try {
            return SHORT[name]?.(result) ?? null;
          } catch {
            return null;
          }
        })());
        return reply({ content: [{ type: "text", text: short ?? JSON.stringify(result, null, 1) }] });
      } catch (e) {
        const err = e;
        if (err.status === 404 && /no operation/.test(err.message)) return fail(-32602, err.message);
        return reply({ content: [{ type: "text", text: `huddle: ${err.message}` }], isError: true });
      } finally {
        inflight.delete(key);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
  }
  return fail(-32601, `method not found: ${m.method}`);
}

// plugin/server/src/lifecycle.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, rmSync, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";
function readJson(path) {
  let text;
  try {
    text = readFileSync3(path, "utf8");
  } catch (e) {
    return e.code === "ENOENT" ? { state: "missing" } : { state: "unreadable" };
  }
  try {
    return { state: "ok", value: JSON.parse(text) };
  } catch {
    return { state: "unreadable" };
  }
}
var record = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var enabledOf = (s2) => record(s2) && record(s2.enabledPlugins) ? s2.enabledPlugins : null;
function presence(env, plugin, projects) {
  const config = env.CLAUDE_CONFIG_DIR ?? join3(env.HOME ?? homedir2(), ".claude");
  const file = readJson(join3(config, "plugins", "installed_plugins.json"));
  if (file.state !== "ok" || !record(file.value)) return "unknown";
  const table = record(file.value.plugins) ? file.value.plugins : file.value;
  if (!Object.values(table).every(Array.isArray)) return "unknown";
  const keys = Object.keys(table).filter((k) => {
    const at = k.lastIndexOf("@");
    return at > 0 && k.slice(0, at) === plugin;
  });
  if (!keys.length) return "uninstalled";
  const user = readJson(join3(config, "settings.json"));
  if (user.state === "missing") return "present";
  if (user.state !== "ok" || !record(user.value)) return "unknown";
  const userEnabled = enabledOf(user.value);
  if (!userEnabled || keys.some((k) => userEnabled[k] !== false)) return "present";
  for (const p of projects) for (const f of [join3(p, ".claude", "settings.json"), join3(p, ".claude", "settings.local.json")]) {
    const s2 = readJson(f);
    if (s2.state === "ok") {
      const e = enabledOf(s2.value);
      if (e && keys.some((k) => e[k] === true)) return "present";
    }
  }
  return "disabled";
}
function watchRemoval(o) {
  let seen = null, fired = false, timer = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const tick = async () => {
    const p = presence(o.env, o.plugin, o.projects());
    if (p !== "uninstalled" && p !== "disabled") {
      seen = null;
      return;
    }
    if (fired || seen !== p) {
      seen = p;
      return;
    }
    fired = true;
    stop();
    await o.gone(p);
  };
  const ms = typeof o.ms === "number" && o.ms > 0 ? o.ms : 1e4;
  timer = setInterval(() => {
    void tick();
  }, ms);
  timer.unref?.();
  return { tick, stop };
}
function removeRunFiles(home) {
  for (const f of ["huddle.pid", "huddle.log", "hooks.log", "stop-raised.json"]) rmSync(join3(home, f), { force: true });
  rmSync(join3(home, "seen"), { recursive: true, force: true });
}
var leftBehindPath = (home) => join3(home, "LEFT-BEHIND.md");
function writeLeftBehind(home, dataDir) {
  const channels = join3(dataDir, "channels");
  mkdirSync3(home, { recursive: true });
  writeFileSync(
    leftBehindPath(home),
    `Huddle's server stopped itself: the huddle plugin was removed from Claude Code (or
disabled) at ${(/* @__PURE__ */ new Date()).toISOString()}.

The channels are still here \u2014 each file is one channel's whole conversation:
  ${channels}

To delete them:
  rm -rf "${channels}"

Everything else in ${home} (a project's huddle.json, certificates, what each session
has read) is not the server's to delete. This note can go:
  rm "${leftBehindPath(home)}"
`
  );
}

// plugin/server/src/ext/views.ts
import { readdirSync as readdirSync3, statSync as statSync3, existsSync as existsSync5 } from "node:fs";
import { readFile as readFile2 } from "node:fs/promises";

// plugin/server/src/ext/repo.ts
import { readdirSync as readdirSync2, statSync as statSync2, existsSync as existsSync4, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
var SKIP = /* @__PURE__ */ new Set([".git", ".terraform", "node_modules", ".direnv", "result", ".agents"]);
var cache2 = /* @__PURE__ */ new Map();
function repoTools(REPO) {
  if (!existsSync4(REPO)) return null;
  let t = cache2.get(REPO);
  if (!t) {
    t = make(REPO);
    cache2.set(REPO, t);
  }
  return t;
}
function make(REPO) {
  const real = realpathSync(REPO);
  const scratch = existsSync4(`${REPO}/.agents/scratch`) ? realpathSync(`${REPO}/.agents/scratch`) : null;
  const safe = (rel) => {
    if (rel.includes("..") || rel.startsWith("/")) return null;
    if (/(^|\/)secrets(\/|$)/.test(rel)) return null;
    let full = rel ? `${REPO}/${rel}` : REPO;
    if (!existsSync4(full) && scratch && existsSync4(`${scratch}/${rel}`)) full = `${scratch}/${rel}`;
    if (!existsSync4(full)) return null;
    const rp = realpathSync(full);
    if (/(^|\/)secrets(\/|$)/.test(rp)) return null;
    const within = (root) => rp === root || rp.startsWith(root + "/");
    return within(real) || scratch && within(scratch) ? full : null;
  };
  async function tree(rel) {
    const full = safe(rel);
    if (!full) return { error: "not found" };
    if (!statSync2(full).isDirectory()) return { file: true, path: rel };
    const entries = readdirSync2(full).filter((n) => !SKIP.has(n) && !n.startsWith(".DS_Store") && safe(rel ? `${rel}/${n}` : n)).sort((a, b2) => {
      const da = statSync2(`${full}/${a}`).isDirectory(), dbb = statSync2(`${full}/${b2}`).isDirectory();
      return da === dbb ? a.localeCompare(b2) : da ? -1 : 1;
    }).map((n) => {
      const st = statSync2(`${full}/${n}`);
      return { name: n, path: rel ? `${rel}/${n}` : n, dir: st.isDirectory(), size: st.size };
    });
    const readme = entries.find((e) => /^README\.md$/i.test(e.name));
    return { path: rel, entries, readme: readme ? await readFile(`${full}/${readme.name}`, "utf8") : null };
  }
  async function file(rel) {
    const full = safe(rel);
    if (!full || statSync2(full).isDirectory()) return { error: "not a file" };
    const size = statSync2(full).size;
    if (size > 2e6) return { path: rel, size, text: "(file larger than 2 MB)" };
    const text = await readFile(full, "utf8");
    if (/\u0000/.test(text.slice(0, 2e3))) return { path: rel, size, binary: true };
    return { path: rel, size, text };
  }
  async function drift(steps) {
    const out = [];
    const cache3 = /* @__PURE__ */ new Map();
    for (const s2 of steps) for (const [i2, sn] of (s2.snippets ?? []).entries()) {
      if (!sn.path || sn.proposed) continue;
      const path = String(sn.path).replace(/:\d+(-\d+)?$/, "");
      if (!cache3.has(path)) {
        const f = safe(path);
        cache3.set(path, f && !statSync2(f).isDirectory() ? await readFile(f, "utf8") : null);
      }
      const text = cache3.get(path);
      if (text == null) {
        out.push({ step: s2.id, i: i2, path, state: "missing" });
        continue;
      }
      const norm = (l) => l.replace(/\s+/g, " ").trim();
      const flat = norm(text);
      const lines = String(sn.code).split("\n").map((l) => norm(l).replace(/^…\s*|\s*…$/g, "")).filter((l) => l.length > 3 && !/^(#|\/\/)\s*…|^…$|^\.\.\.$/.test(l));
      if (!lines.length) continue;
      const hit = lines.filter((l) => flat.includes(l)).length / lines.length;
      out.push({ step: s2.id, i: i2, path, state: hit >= 0.6 ? "ok" : hit >= 0.3 ? "partial" : "drift", score: Math.round(hit * 100) });
    }
    return out;
  }
  return { tree, file, drift, safe };
}

// plugin/server/src/ext/views.ts
var LOCAL = [`${PLUGIN}/server/src/ext/local/index.js`, `${PLUGIN}/server/src/ext/local/index.ts`].find((f) => existsSync5(f));
var local = LOCAL ? (await import(LOCAL).catch((e) => {
  console.error(`local views: ${e.message}`);
  return {};
})).views ?? {} : {};
var BUILTIN = ["code", "drift", "diagrams"];
var driftCache = /* @__PURE__ */ new Map();
function viewNames(ch) {
  const repo = ch.config().repo;
  return repo && existsSync5(repo) ? [...BUILTIN, ...Object.keys(local)] : [];
}
async function repoRoute(ch, sub, u) {
  const cfg = ch.config();
  const R = cfg.repo ? repoTools(cfg.repo) : null;
  if (!R) return { error: cfg.repo ? `repo ${cfg.repo} is not reachable from Huddle` : "this channel has no repo configured" };
  const all = async () => Promise.all((await ch.tasks()).map(async (t) => await ch.task(t.id)));
  const p = u.searchParams.get("path") ?? "";
  switch (sub) {
    case "tree":
      return R.tree(p);
    case "file":
      return R.file(p);
    case "code": {
      const full = R.safe(p);
      if (!p || !full) return { missing: true, path: p };
      if (statSync3(full).isDirectory()) return { dir: true, path: p, entries: readdirSync3(full).filter((n) => R.safe(`${p}/${n}`)).sort().slice(0, 200) };
      const text = await readFile2(full, "utf8").catch(() => null);
      if (text == null) return { missing: true, path: p };
      const lines = text.split("\n");
      const a = u.searchParams.get("anchor");
      let start = 0;
      if (a) {
        const i2 = lines.findIndex((l) => l.includes(a));
        if (i2 >= 0) start = Math.max(0, i2 - 3);
      }
      return { path: p, from: start + 1, total: lines.length, excerpt: lines.slice(start, start + 80).join("\n") };
    }
    case "refs": {
      const q = p.replace(/\/$/, "");
      if (!q) return [];
      return (await all()).filter((r) => [...r.files ?? [], ...(r.snippets ?? []).map((x) => x.path ?? "")].some((f) => f && (f === q || f.startsWith(q + "/") || f.replace(/:\d.*$/, "") === q))).map((r) => ({ id: r.id, title: r.title, status: r.status }));
    }
    case "drift": {
      const hit = driftCache.get(ch.name);
      if (hit && Date.now() - hit.at < 12e4) return { at: new Date(hit.at).toISOString(), rows: hit.rows };
      const rows = await R.drift(await all());
      driftCache.set(ch.name, { at: Date.now(), rows });
      return { at: (/* @__PURE__ */ new Date()).toISOString(), rows };
    }
    case "diagrams": {
      try {
        return readdirSync3(`${cfg.repo}/docs/architecture`).filter((f) => f.endsWith(".png")).sort();
      } catch {
        return [];
      }
    }
  }
  if (local[sub]) return local[sub](ch, u, R);
  return { error: `no repo view ${sub}` };
}
function diagramFile(ch, name) {
  const repo = ch.config().repo;
  if (!repo || !/^[\w.-]+\.png$/.test(name)) return null;
  return `${repo}/docs/architecture/${name}`;
}
async function exportMd(ch) {
  const out = [`# ${ch.config().title}`, "", `Exported ${(/* @__PURE__ */ new Date()).toISOString()} from Huddle (channel ${ch.name}).`, ""];
  const tasks = await ch.tasks();
  const full = new Map((await Promise.all(tasks.map((t) => ch.task(t.id)))).map((t) => [t.id, t]));
  const phased = /* @__PURE__ */ new Set();
  const step = (id) => {
    const e = full.get(id);
    phased.add(id);
    out.push(`### ${e.id} ${e.title}`, "", `\`${e.kind}\` \xB7 gate \`${e.gate}\` \xB7 risk \`${e.risk}\` \xB7 status **${e.status}**${e.owner ? ` \xB7 owner ${e.owner}` : ""}${Object.keys(e.edited).length ? " \xB7 *edited*" : ""}`, "");
    if (e.what) out.push(`**What.** ${e.what}`, "");
    if (e.why) out.push(`**Why.** ${e.why}`, "");
    if (e.alternatives?.length) {
      out.push("**Not done that way:**", "");
      for (const a of e.alternatives) out.push(`- *${a.option}*: ${a.why_not}`);
      out.push("");
    }
    if (e.how?.length) {
      out.push("**How:**", "");
      e.how.forEach((h, i2) => out.push(`${i2 + 1}. ${h}`));
      out.push("");
    }
    for (const sn of e.snippets ?? []) out.push(`*${sn.title}*${sn.path ? ` \u2014 \`${sn.path}\`` : ""}${sn.proposed ? " (proposed)" : ""}`, "", "```" + (sn.lang || ""), sn.code, "```", "");
    if (e.use) out.push(`**Use.** ${e.use}`, "");
    if (e.verify?.length) {
      out.push("**Verify:**", "");
      for (const v of e.verify) out.push(`- \`${v.cmd}\` \u2192 ${v.expect}`);
      out.push("");
    }
    if (e.value) out.push(`**Value.** ${e.value}`, "");
    if (e.rollback) out.push(`**Rollback.** ${e.rollback}`, "");
    const open = e.comments.filter((c) => !c.resolved);
    if (open.length) {
      out.push("**Owner review:**", "");
      for (const c of open) out.push(`- [${c.kind}] ${c.body}`);
      out.push("");
    }
  };
  for (const p of await ch.phases()) {
    out.push(
      `## Step ${p.n}: ${p.title}`,
      "",
      p.summary || "",
      "",
      `- **Needs:** ${p.needs || "-"}`,
      `- **Make:** ${(p.make || []).map((m) => "`make " + m + "`").join(", ") || "-"}`,
      `- **Value:** ${p.value || "-"}`,
      ""
    );
    for (const s2 of tasks.filter((x) => x.phase_n === p.n)) step(s2.id);
  }
  const loose = tasks.filter((t) => !phased.has(t.id));
  if (loose.length) {
    out.push("## Tasks", "");
    for (const t of loose) step(t.id);
  }
  return out.join("\n");
}

// plugin/server/src/auth.ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync as mkdirSync4, readFileSync as readFileSync4, renameSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname3 } from "node:path";
var HEADER = "x-huddle-token";
var INVITE_RE = /^([a-z0-9]{6})\.([a-z0-9]{16})$/;
var DAY = 86400;
var CODE_MS = 5 * 6e4;
var ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";
function rand36(n) {
  let out = "";
  while (out.length < n) for (const b2 of randomBytes(n * 2)) {
    if (b2 < 252 && out.length < n) out += ALPHA[b2 % 36];
  }
  return out;
}
var credential = () => `hcred_${randomBytes(32).toString("base64url")}`;
var digest2 = (s2) => createHash("sha256").update(s2).digest();
var same = (a, b2) => timingSafeEqual(a, b2);
var hex = (b2) => b2.toString("hex");
var unhex = (s2) => {
  const b2 = Buffer.from(String(s2 ?? ""), "hex");
  return b2.length === 32 ? b2 : null;
};
var ROOTS = 8;
var BROWSERS = 64;
var Auth = class {
  // file: where the digests persist (none: memory only, a restart forgets it all)
  constructor(root, now3 = Date.now, log = () => {
  }, file) {
    this.root = root;
    this.now = now3;
    this.log = log;
    this.file = file;
    this.load();
    const d = digest2(root);
    this.roots = [...this.roots.filter((r) => !same(r, d)), d].slice(-ROOTS);
    this.live.add(root);
    this.save();
  }
  root;
  now;
  log;
  file;
  roots = [];
  invites = /* @__PURE__ */ new Map();
  issued = /* @__PURE__ */ new Set();
  // every invite id of this run, for redaction
  members = /* @__PURE__ */ new Map();
  browsers = [];
  // by: the member who signed it in, null = the root
  codes = [];
  live = /* @__PURE__ */ new Set();
  // every secret handed out: never stored in a channel
  dirty = false;
  flushT;
  // the state file: digests and public metadata only; anything unreadable is a fresh start
  load() {
    if (!this.file) return;
    let j;
    try {
      j = JSON.parse(readFileSync4(this.file, "utf8"));
    } catch {
      return;
    }
    if (!j || j.v !== 1) return;
    this.roots = (Array.isArray(j.roots) ? j.roots : []).map(unhex).filter(Boolean);
    for (const i2 of Array.isArray(j.invites) ? j.invites : []) {
      const secret = unhex(i2?.secret);
      if (!secret || typeof i2.id !== "string") continue;
      this.invites.set(i2.id, {
        id: i2.id,
        secret,
        created: Number(i2.created) || 0,
        expires: i2.expires == null ? null : Number(i2.expires),
        single: !!i2.single,
        uses: Number(i2.uses) || 0,
        invite: !!i2.invite,
        channel: i2.channel || void 0,
        description: i2.description || void 0,
        by: String(i2.by ?? "owner")
      });
    }
    for (const id of Array.isArray(j.issued) ? j.issued : []) if (typeof id === "string") this.issued.add(id);
    for (const m of Array.isArray(j.members) ? j.members : []) {
      const cred = unhex(m?.cred);
      if (!cred || typeof m.name !== "string") continue;
      this.members.set(m.name, { name: m.name, cred, since: Number(m.since) || 0, seen: Number(m.seen) || 0, invite: !!m.invite, via: String(m.via ?? "") });
    }
    for (const b2 of Array.isArray(j.browsers) ? j.browsers : []) {
      const cred = unhex(b2?.cred);
      if (cred) this.browsers.push({ cred, by: typeof b2.by === "string" ? b2.by : null });
    }
    this.sweep();
  }
  save() {
    if (!this.file) return;
    clearTimeout(this.flushT);
    this.flushT = void 0;
    this.dirty = false;
    const j = {
      v: 1,
      note: "Huddle's members, roots, browsers and unused invites: sha256 digests only, never a secret",
      roots: this.roots.map(hex),
      invites: [...this.invites.values()].map((i2) => ({ ...i2, secret: hex(i2.secret) })),
      issued: [...this.issued].slice(-1e3),
      members: [...this.members.values()].map((m) => ({ ...m, cred: hex(m.cred) })),
      browsers: this.browsers.slice(-BROWSERS).map((b2) => ({ cred: hex(b2.cred), by: b2.by }))
    };
    try {
      mkdirSync4(dirname3(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync2(tmp, JSON.stringify(j), { mode: 384 });
      renameSync(tmp, this.file);
      try {
        chmodSync(this.file, 384);
      } catch {
      }
    } catch (e) {
      this.log(`could not save ${this.file}: ${e.message}`);
    }
  }
  // "last seen" changes on every request: written within a minute, not on each one
  later() {
    if (!this.file || this.flushT) return;
    this.dirty = true;
    this.flushT = setTimeout(() => this.flush(), 6e4);
    this.flushT.unref?.();
  }
  /** Write what is pending now (the server calls it when it stops). */
  flush() {
    if (this.dirty || this.flushT) this.save();
  }
  // who a credential is: root (and the browsers, as the owner), a member, or nobody
  who(cred) {
    if (!cred) return null;
    const d = digest2(cred);
    let found = null;
    for (const r of this.roots) if (same(d, r)) found = { name: "owner", root: true, invite: true };
    for (const b2 of this.browsers) if (same(d, b2.cred))
      found = b2.by === null ? { name: "owner", root: true, invite: true } : this.members.has(b2.by) ? { name: "owner", root: false, invite: false, browser: b2.by } : found;
    for (const m of this.members.values()) if (same(d, m.cred)) {
      found = { name: m.name, root: false, invite: m.invite };
      m.seen = this.now();
      this.later();
    }
    return found;
  }
  // a new invite; the whole token is returned once, here
  create(o) {
    let id;
    do
      id = rand36(6);
    while (this.issued.has(id));
    const secret = rand36(16), ttl = o.ttl ?? DAY, created = this.now();
    const inv = {
      id,
      secret: digest2(secret),
      created,
      expires: ttl > 0 ? created + ttl * 1e3 : null,
      single: !!o.single,
      uses: 0,
      invite: !!o.invite,
      channel: o.channel || void 0,
      description: o.description || void 0,
      by: o.by
    };
    this.invites.set(id, inv);
    this.issued.add(id);
    const token = `${id}.${secret}`;
    this.live.add(token);
    this.log(`invite ${id} created by ${o.by}${inv.expires ? `, expires ${new Date(inv.expires).toISOString()}` : ""}${inv.single ? ", single use" : ""}`);
    this.save();
    return { token, ...this.view(inv) };
  }
  view(i2) {
    return {
      id: i2.id,
      created: new Date(i2.created).toISOString(),
      expires: i2.expires ? new Date(i2.expires).toISOString() : null,
      single_use: i2.single,
      uses: i2.uses,
      can_invite: i2.invite,
      channel: i2.channel ?? null,
      description: i2.description ?? null,
      by: i2.by
    };
  }
  list() {
    this.sweep();
    return [...this.invites.values()].map((i2) => this.view(i2));
  }
  revoke(id) {
    const ok = this.invites.delete(id);
    if (ok) {
      this.log(`invite ${id} revoked`);
      this.save();
    }
    return ok;
  }
  sweep() {
    const t = this.now();
    let gone2 = false;
    for (const [id, i2] of this.invites) if (i2.expires !== null && i2.expires <= t) {
      this.invites.delete(id);
      gone2 = true;
    }
    if (gone2) this.save();
  }
  // the live invite a token names, or null (the secret is compared even when the id is unknown,
  // so a miss costs the same)
  valid(token) {
    const m = INVITE_RE.exec(String(token ?? ""));
    const inv = m ? this.invites.get(m[1]) : void 0;
    const ok = same(digest2(m?.[2] ?? String(token ?? "")), inv?.secret ?? digest2("\0no invite"));
    if (!inv || !ok) return null;
    if (inv.expires !== null && inv.expires <= this.now()) {
      this.invites.delete(inv.id);
      this.save();
      return null;
    }
    return inv;
  }
  // before a join that asks for a name of its own: the channel the invite names (null: none) and
  // the member names taken, or null for a token that would not join
  peek(token) {
    const inv = this.valid(token);
    return inv ? { channel: inv.channel ?? null, members: [...this.members.keys()] } : null;
  }
  // present an invite once: a credential of its own for that name (a name joining again gets a
  // new one, and the old one stops working)
  join(token, name) {
    const inv = this.valid(token);
    if (!inv) return { error: "invalid token" };
    const cred = credential();
    this.members.set(name, { name, cred: digest2(cred), since: this.now(), seen: this.now(), invite: inv.invite, via: inv.id });
    this.live.add(cred);
    inv.uses++;
    if (inv.single) this.invites.delete(inv.id);
    this.log(`${name} joined with invite ${inv.id}`);
    this.save();
    return { credential: cred, name, channel: inv.channel ?? null };
  }
  memberList() {
    return [...this.members.values()].map((m) => ({ name: m.name, since: new Date(m.since).toISOString(), seen: new Date(m.seen).toISOString(), can_invite: m.invite, invite: m.via }));
  }
  kick(name) {
    const ok = this.members.delete(name);
    if (ok) {
      this.browsers = this.browsers.filter((b2) => b2.by !== name);
      this.codes = this.codes.filter((c) => c.by !== name);
      this.log(`${name} kicked`);
      this.save();
    }
    return ok;
  }
  // the browser's door: a code good once, for five minutes, redeemed for a cookie credential;
  // by = the member who asks for it (its browser gets no admin rights), null = the root
  loginCode(by = null) {
    const code = randomBytes(18).toString("base64url"), t = this.now();
    this.codes = this.codes.filter((c) => c.expires > t);
    this.codes.push({ code: digest2(code), expires: t + CODE_MS, by });
    this.live.add(code);
    return code;
  }
  redeem(code) {
    const d = digest2(code ?? ""), t = this.now();
    const i2 = this.codes.findIndex((c2) => same(c2.code, d));
    if (i2 < 0) return null;
    const [c] = this.codes.splice(i2, 1);
    if (c.expires <= t || c.by !== null && !this.members.has(c.by)) return null;
    const cred = credential();
    this.browsers.push({ cred: digest2(cred), by: c.by });
    this.live.add(cred);
    if (this.browsers.length > BROWSERS) this.browsers.splice(0, this.browsers.length - BROWSERS);
    this.save();
    return cred;
  }
  // what a session writes into a channel never carries a secret: any credential, code or invite
  // of this run becomes "<redacted>" (an invite keeps its public id)
  redact(v) {
    const scrub = (s2) => {
      let out = s2.replace(/\b([a-z0-9]{6})\.([a-z0-9]{16})\b/g, (all, id) => this.issued.has(id) ? `${id}.<redacted>` : all).replace(/hcred_[A-Za-z0-9_-]+/g, "<redacted>");
      for (const x of this.live) if (x.length >= 8 && out.includes(x)) out = out.split(x).join("<redacted>");
      return out;
    };
    const walk = (x) => typeof x === "string" ? scrub(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
    return walk(v);
  }
};
var mayAct = (w, as) => w.root || !as || as === w.name || as.startsWith(`${w.name}.`);
function given(req, cookie) {
  const h = req.headers.get(HEADER);
  if (h) return h;
  const m = new RegExp(`(?:^|;\\s*)${cookie}=([^;]*)`).exec(req.headers.get("cookie") ?? "");
  return m ? decodeURIComponent(m[1]) : "";
}

// plugin/server/src/port.ts
import { createServer } from "node:net";
var LOW = 1e4;
var HIGH = 65535;
var bindable = (port2, host) => new Promise((res) => {
  const s2 = createServer();
  s2.once("error", () => res(false));
  s2.listen({ port: port2, host, exclusive: true }, () => s2.close(() => res(true)));
});
var portFree = async (port2) => await bindable(port2, "127.0.0.1") && await bindable(port2, "0.0.0.0");
async function randomPort(tries = 200) {
  for (let i2 = 0; i2 < tries; i2++) {
    const p = LOW + Math.floor(Math.random() * (HIGH - LOW + 1));
    if (await portFree(p)) return p;
  }
  throw new Error(`no free port in ${LOW}-${HIGH} after ${tries} tries`);
}

// plugin/server/src/rules.ts
var W = String.raw`(?:^|[;&|(\x60]|\$\(|\bsudo\s+|\bexec\s+|\bthen\s+|\bdo\s+)\s*`;
var E = String.raw`(?![\w-])`;
var git = (sub) => String.raw`${W}git(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+${sub}`;
var RULES = [
  {
    id: "force_push",
    label: "Force push",
    help: "git push --force, -f, --force-with-lease or a +ref",
    on: true,
    re: [new RegExp(git(String.raw`push${E}[^;&|\n]*?(?:\s--force(?:-with-lease)?\b|\s-[a-zA-Z]*f[a-zA-Z]*\b|\s\+\S)`))]
  },
  {
    id: "delete",
    label: "Delete files or branches",
    help: "rm, git rm, git clean, git branch -d/-D, git push --delete, find -delete, rmdir, unlink",
    on: true,
    re: [
      new RegExp(`${W}(?:rm|rmdir|unlink|shred|trash)${E}(?!\\s*=)`),
      new RegExp(git(String.raw`(?:rm|clean)${E}`)),
      new RegExp(git(String.raw`branch${E}[^;&|\n]*\s(?:-[a-zA-Z]*[dD]\b|--delete\b)`)),
      new RegExp(git(String.raw`push${E}[^;&|\n]*(?:\s--delete\b|\s-d\b|\s:\S)`)),
      new RegExp(String.raw`${W}find\b[^;&|\n]*\s-delete\b`)
    ]
  },
  { id: "git_push", label: "Git push", help: "every git push", on: false, re: [new RegExp(git(String.raw`push${E}`))] },
  {
    id: "git_tag",
    label: "Git tag",
    help: "creating, moving or deleting a tag (listing is fine)",
    on: false,
    re: [new RegExp(git(String.raw`tag${E}(?!\s*(?:$|[;&|)]|-l\b|--list\b|-n\d*\b|--contains\b|--points-at\b|--merged\b|--no-merged\b|--sort\b|--format\b|-v\b|--verify\b))`))]
  },
  {
    id: "publish",
    label: "Publish a package",
    help: "npm/pnpm/yarn/bun publish, cargo publish, twine upload, gem push, poetry/uv/flit publish, docker push, gh release create",
    on: false,
    re: [
      new RegExp(`${W}(?:npm|pnpm|yarn|bun|cargo|poetry|uv|flit|vsce|ovsx|hatch)\\s+(?:[\\w-]+\\s+)?publish${E}`),
      new RegExp(`${W}(?:python3?\\s+-m\\s+)?twine\\s+upload${E}`),
      new RegExp(`${W}gem\\s+push${E}`),
      new RegExp(`${W}docker\\s+(?:image\\s+)?push${E}`),
      new RegExp(`${W}gh\\s+release\\s+create${E}`)
    ]
  }
];
var DEFAULTS = Object.fromEntries(RULES.map((r) => [r.id, r.on]));
function matching(command) {
  const c = String(command ?? "");
  if (!c.trim() || c.length > 1e5) return [];
  return RULES.filter((r) => r.re.some((x) => x.test(c)));
}
function effective(stored) {
  const out = { ...DEFAULTS };
  if (stored && typeof stored === "object") {
    for (const [k, v] of Object.entries(stored)) if (k in out && typeof v === "boolean") out[k] = v;
  }
  return out;
}

// plugin/server/src/extras.ts
var P4 = (v, d = null) => {
  if (v == null) return d;
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};
var iso4 = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
var rulesOf = (ch) => effective(P4(ch.meta("approval_rules"), {}));
var rulesList = (ch) => {
  const on = rulesOf(ch);
  return RULES.map((r) => ({ id: r.id, label: r.label, help: r.help, on: on[r.id], default: DEFAULTS[r.id] }));
};
async function setRules(ch, patch) {
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
async function approval(ch, as, b2) {
  if (!as || as === OWNER || !NAME_RE.test(as)) throw new HuddleError(400, "say which session asks: ?as=<session>");
  if (!await ch.session(as)) throw new HuddleError(404, `"${as}" has not joined channel ${ch.name}`);
  void link(ch, as, b2.claude_session);
  const on = rulesOf(ch);
  const hit = matching(String(b2.command ?? "")).filter((r) => on[r.id]);
  if (!hit.length) return { ask: false };
  const labels = hit.map((r) => r.label);
  const ev2 = await ch.append(as, { topic: "approval.request", to: OWNER, msg: `${as} asks permission: ${labels.join(", ")}`, data: { rules: hit.map((r) => r.id), labels } });
  return {
    ask: true,
    rules: hit.map((r) => r.id),
    labels,
    event: ev2.seq,
    reason: `Huddle (channel ${ch.name}): the owner asked to approve ${labels.join(" and ").toLowerCase()} \u2014 allow only if this is intended.`
  };
}
async function approvals(ch) {
  const cleared = Number(ch.meta("approvals_cleared") ?? 0), dismissed = new Set(P4(ch.meta("approvals_dismissed"), []));
  const rows = await ch.store.all("SELECT * FROM events WHERE topic='approval.request' AND seq > ? AND ts >= ? ORDER BY seq DESC LIMIT 50", [cleared, iso4(Date.now() - 864e5)]);
  return rows.filter((r) => !dismissed.has(r.seq)).map((r) => {
    const d = P4(r.data, {}) ?? {};
    return { seq: r.seq, from: r.from_name, ts: r.ts, rules: d.rules ?? [], labels: d.labels ?? [] };
  });
}
async function dismiss(ch, b2) {
  await ch.serial(async () => {
    if (b2.all) await ch.setMeta("approvals_cleared", String(await ch.lastSeq()));
    else {
      const seq = Number(b2.seq);
      if (!Number.isInteger(seq) || seq <= 0) throw new HuddleError(400, "dismiss: {seq} or {all: true}");
      const d = P4(ch.meta("approvals_dismissed"), []).filter(Number.isInteger);
      await ch.setMeta("approvals_dismissed", JSON.stringify([.../* @__PURE__ */ new Set([...d, seq])].slice(-300)));
    }
  });
  return { approvals: await approvals(ch) };
}
async function observatory(ch) {
  const [al, cost] = await Promise.all([alerts(), costBySession("day")]);
  if (al === null && cost === null) return { available: false };
  const L = await links(ch);
  const byName = {};
  let total = 0;
  for (const [cid, usd2] of cost ?? []) {
    const n = L.get(cid);
    if (n) {
      byName[n] = (byName[n] ?? 0) + usd2;
      total += usd2;
    }
  }
  return {
    available: true,
    range: "day",
    alerts: (al ?? []).filter((a) => L.has(a.sessionId)).map((a) => ({ id: a.id, kind: a.kind, session: L.get(a.sessionId), agent: a.agentId, since: a.since, detail: a.detail.slice(0, 300), cost: a.costUsd })),
    cost: cost ? byName : null,
    total: cost ? total : null
  };
}
function needsYou(e, channel) {
  if (!e || e.from === OWNER) return null;
  const title = `Huddle \xB7 ${channel}`;
  if (e.needs_reply && (e.to == null || e.to === OWNER))
    return { kind: "ask", subject: `${channel}/${e.from}`, title, body: `${e.from} asks you a question${e.data?.task ? ` about task ${e.data.task}` : ""}` };
  if (e.topic === "control.pause" && e.to)
    return { kind: "pause", subject: `${channel}/${e.to}`, title, body: `${e.to} was paused by ${e.from}` };
  if (e.topic === "approval.request")
    return {
      kind: "approval",
      subject: `${channel}/${e.from}/${(e.data?.rules ?? []).join(",")}`,
      title,
      body: `${e.from} asks permission: ${(e.data?.labels ?? []).join(", ") || "a command"}. Answer in its Claude Code window.`
    };
  if (e.topic === "task.status" && e.data?.status === "blocked")
    return { kind: "blocked", subject: `${channel}/${e.ref}`, title, body: `Task ${e.ref} is blocked (${e.from})` };
  return null;
}
var watched = /* @__PURE__ */ new WeakSet();
function watch(ch, n) {
  if (watched.has(ch)) return;
  watched.add(ch);
  ch.subscribe((m) => {
    if (m.type !== "event") return;
    const x = needsYou(m.data, ch.config().title || ch.name);
    if (x) n.send(x.kind, x.subject, x.title, x.body);
  });
}
function watchHub(hub2, n) {
  const get2 = hub2.get.bind(hub2);
  hub2.get = async (name, create) => {
    const ch = await (create === void 0 ? get2(name) : get2(name, create));
    watch(ch, n);
    return ch;
  };
}
async function route(ch, rest, req, u, as, body2) {
  const owner = () => {
    if (as !== OWNER) throw new HuddleError(403, "only the owner changes this (the dashboard, or ?as=owner)");
  };
  const post = req.method === "POST";
  if (rest === "rules" && !post) return { rules: rulesList(ch) };
  if (rest === "rules" && post) {
    owner();
    return { rules: await setRules(ch, (await body2()).rules ?? {}) };
  }
  if (rest === "approval" && post) return approval(ch, as, await body2());
  if (rest === "approvals" && !post) return { approvals: await approvals(ch) };
  if (rest === "approvals/dismiss" && post) {
    owner();
    return dismiss(ch, await body2());
  }
  if (rest === "observatory" && !post) return observatory(ch);
  if (rest === "digest" && !post) return digest(ch, u.searchParams.get("since") ?? void 0);
  if (rest === "link" && post) {
    const b2 = await body2();
    await link(ch, as, b2.claude_session);
    return { ok: true };
  }
  return null;
}
async function settings(req, n, me, body2) {
  if (req.method === "POST") {
    if (me.name !== OWNER) throw new HuddleError(403, "only the owner (the dashboard, or the session that started Huddle) changes settings");
    const b2 = await body2();
    if (typeof b2.notify !== "boolean") throw new HuddleError(400, "settings: {notify: true|false}");
    return n.set(b2.notify);
  }
  return n.state();
}

// plugin/server/src/notify.ts
import { spawn } from "node:child_process";
import { appendFileSync, existsSync as existsSync6, mkdirSync as mkdirSync5, readFileSync as readFileSync5, renameSync as renameSync2, statSync as statSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { delimiter, join as join4 } from "node:path";
var WINDOW_MS = () => Number(process.env.HUDDLE_NOTIFY_WINDOW_MS || 10 * 6e4);
var SPAWN_TIMEOUT_MS = 5e3;
function clean2(s2, max = 140) {
  let t = String(s2 ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ");
  t = t.replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|glpat|xox[abpr]|AKIA|ASIA)[-_A-Za-z0-9]{8,}/g, "\u2026").replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, "\u2026").replace(/((?:token|secret|password|passwd|api[-_]?key|key|credential|auth)\s*[=:]\s*)\S+/gi, "$1\u2026");
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "\u2026" : t;
}
function onPath(name) {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (!d) continue;
    const f = join4(d, name);
    try {
      if (existsSync6(f) && statSync4(f).isFile()) return f;
    } catch {
    }
  }
  return null;
}
function notifier() {
  if (process.platform === "darwin") return existsSync6("/usr/bin/osascript") || onPath("osascript") ? "osascript" : null;
  if (process.platform === "linux") return onPath("notify-send") ? "notify-send" : null;
  return null;
}
var Notifier = class {
  constructor(dir) {
    this.dir = dir;
  }
  dir;
  last = /* @__PURE__ */ new Map();
  cache = null;
  file() {
    return join4(this.dir, "settings.json");
  }
  read() {
    try {
      return JSON.parse(readFileSync5(this.file(), "utf8"));
    } catch {
      return {};
    }
  }
  /** Whether notifications are on (the file is read at most every 2 s). */
  enabled() {
    if (process.env.HUDDLE_NOTIFY === "0") return false;
    if (this.cache && Date.now() - this.cache.at < 2e3) return this.cache.on;
    const on = this.read().notify !== false;
    this.cache = { at: Date.now(), on };
    return on;
  }
  set(on) {
    const s2 = { ...this.read(), notify: !!on };
    mkdirSync5(this.dir, { recursive: true });
    const tmp = `${this.file()}.${process.pid}.tmp`;
    writeFileSync3(tmp, JSON.stringify(s2, null, 2) + "\n", { mode: 384 });
    renameSync2(tmp, this.file());
    this.cache = { at: Date.now(), on: !!on };
    return this.state();
  }
  state() {
    return { notify: this.enabled(), notifier: process.env.HUDDLE_NOTIFY_LOG ? "log" : notifier(), forced_off: process.env.HUDDLE_NOTIFY === "0" };
  }
  /** Show one notification, unless it is off or the same kind+subject showed in the last 10 min. Never throws. */
  send(kind, subject, title, body2) {
    try {
      if (!this.enabled()) return false;
      const key = `${kind}\0${subject}`, now3 = Date.now(), w = WINDOW_MS();
      const prev = this.last.get(key);
      if (prev !== void 0 && now3 - prev < w) return false;
      this.last.set(key, now3);
      if (this.last.size > 2e3) {
        for (const [k, t2] of this.last) if (now3 - t2 >= w) this.last.delete(k);
      }
      const t = clean2(title, 80), b2 = clean2(body2, 160);
      const log = process.env.HUDDLE_NOTIFY_LOG;
      if (log) {
        appendFileSync(log, JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), kind, subject, title: t, body: b2 }) + "\n");
        return true;
      }
      const how = notifier();
      if (!how) return false;
      const args = how === "osascript" ? ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", t, b2] : ["-a", "Huddle", t, b2];
      const p = spawn(how === "osascript" ? "osascript" : "notify-send", args, { detached: true, stdio: "ignore" });
      p.on("error", () => {
      });
      const kill = setTimeout(() => {
        try {
          p.kill();
        } catch {
        }
      }, SPAWN_TIMEOUT_MS);
      kill.unref?.();
      p.on("exit", () => clearTimeout(kill));
      p.unref();
      return true;
    } catch {
      return false;
    }
  }
};

// plugin/server/server.ts
import { readFile as readFile3 } from "node:fs/promises";
import { existsSync as existsSync7, rmSync as rmSync2, statSync as statSync5 } from "node:fs";
var ROOT = `${PLUGIN}/server`;
var PORT = process.env.PORT ? Number(process.env.PORT) : await randomPort();
var HOME = process.env.HUDDLE_HOME || `${process.cwd()}/.agents/huddle`;
var DATA = process.env.HUDDLE_DATA || `${HOME}/data`;
var ROOT_CRED = process.env.HUDDLE_TOKEN || (process.env.HUDDLE_ROOT_STDIN === "1" ? (await stdinText().catch(() => "")).split("\n")[0].trim() : "") || crypto.randomUUID() + crypto.randomUUID();
var AUTH_FILE = `${DATA}/auth.json`;
var AUTH = new Auth(ROOT_CRED, Date.now, (s2) => console.log(`huddle: ${s2}`), AUTH_FILE);
var COOKIE = `huddle_session_${PORT}`;
var hub = new Hub(DATA, process.env.HUDDLE_AUTO_CREATE !== "0");
var STARTED = (/* @__PURE__ */ new Date()).toISOString();
var NOTIFY = new Notifier(DATA);
watchHub(hub, NOTIFY);
var VERSION2 = (await readFile3(`${PLUGIN}/.claude-plugin/plugin.json`, "utf8").then(JSON.parse).catch(() => ({}))).version ?? "dev";
var EXTRA_HOSTS = (process.env.HUDDLE_HOSTS ?? "").split(",").map((s2) => s2.trim()).filter(Boolean);
var HOSTS = /* @__PURE__ */ new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...EXTRA_HOSTS]);
function guard(req) {
  if (!HOSTS.has(req.headers.get("host") ?? "")) return new Response("wrong host", { status: 421 });
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;
  const origin = req.headers.get("origin");
  if (origin && !HOSTS.has(origin.replace(/^https?:\/\//, ""))) return new Response("cross-origin write refused", { status: 403 });
  if (req.method !== "DELETE" && !(req.headers.get("content-type") ?? "").startsWith("application/json")) return new Response("writes need content-type: application/json", { status: 415 });
  return null;
}
var json = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...h } });
var STATIC = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8" };
var who = (req, u) => u.searchParams.get("as") ?? req.headers.get("x-huddle-as") ?? "";
var SESSION_401 = "not in this huddle: this session holds no credential for it. In a session that is in it, run /huddle:invite and paste the join line it shows into this session (/huddle:join \u2026)";
var SIGNED_OUT = "This browser is not signed in to Huddle (its sign-in ended, or the link expired). Run /huddle:open in any Claude session in this huddle, or `huddle open` in a terminal, and open the new link.";
var LOGO_SVG = `<svg viewBox="0 0 26 26" width="36" height="36" aria-hidden="true"><path d="M5 17 Q13 2 21 17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.2 2.2" opacity=".75"/><circle cx="13" cy="9.6" r="2.4" fill="currentColor"/><rect x="2.5" y="17" width="5" height="6" rx="2.5" fill="currentColor"/><rect x="18.5" y="17" width="5" height="6" rx="2.5" fill="currentColor"/></svg>`;
var signedOutPage = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Huddle: signed out</title>
<script>try{const t=JSON.parse(localStorage.getItem("huddle:theme")||"null");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch{}</script>
<style>
:root{--bg:#e6e9ef;--panel:#eff1f5;--border:#ccd0da;--border2:#bcc0cc;--text:#4c4f69;--muted:#5c5f77;--faint:#5f627a;--blue:#1e66f5;--blueink:#2e5ec4;--peach:#fe640b;--peachink:#8a5648;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#181825;--panel:#1e1e2e;--border:#313244;--border2:#45475a;--text:#cdd6f4;--muted:#a6adc8;--faint:#9399b2;--blue:#89b4fa;--blueink:#89b4fa;--peach:#fab387;--peachink:#fab387;color-scheme:dark}}
:root[data-theme=dark]{--bg:#181825;--panel:#1e1e2e;--border:#313244;--border2:#45475a;--text:#cdd6f4;--muted:#a6adc8;--faint:#9399b2;--blue:#89b4fa;--blueink:#89b4fa;--peach:#fab387;--peachink:#fab387;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:28rem;display:flex;flex-direction:column;gap:32px}.head{text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px}
.logo{display:inline-flex;width:64px;height:64px;align-items:center;justify-content:center;border-radius:16px;color:var(--blueink);background:color-mix(in srgb,var(--blue) 14%,var(--panel));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--blue) 30%,transparent)}
h1{margin:0;font-size:30px;font-weight:700;letter-spacing:-.02em}.sub{margin:0;color:var(--muted);font-size:15px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:24px;display:flex;flex-direction:column;gap:16px}
.note{display:flex;gap:10px;align-items:flex-start;border:1px solid color-mix(in srgb,var(--peach) 30%,var(--panel));background:color-mix(in srgb,var(--peach) 9%,var(--panel));border-radius:8px;padding:12px;font-size:13px}
.note b{font-weight:600}.note span{color:var(--muted)}.note i{color:var(--peachink);font-style:normal;font-weight:700}
p{margin:0}.muted{color:var(--muted);font-size:13px}.lab{font-size:13px;font-weight:500;margin-bottom:6px}
.field{display:flex;align-items:center;gap:10px;height:40px;padding:0 12px;border:1px solid var(--border2);border-radius:8px;background:var(--bg);font:13px ui-monospace,"SF Mono",Menlo,monospace}
.field::before{content:"\u203A_";color:var(--faint);font-weight:600}
footer{text-align:center;font-size:12px;color:var(--faint)}
</style></head>
<body><main><div class="head"><span class="logo">${LOGO_SVG}</span><h1>Huddle</h1><p class="sub">Sign in to see your channels and sessions</p></div>
<section class="card"><div class="note" role="status"><i aria-hidden="true">!</i><p><b>Signed out.</b> <span>This sign-in link was used or has expired: each link signs in one browser, once.</span></p></div>
<p class="muted">Get a new link from any session in this huddle, then open it here.</p>
<div><div class="lab">In a Claude session</div><div class="field">/huddle:open</div></div>
<div><div class="lab">Or in a terminal</div><div class="field">huddle open</div></div></section>
<footer>Huddle v${VERSION2}</footer></main></body></html>`;
var streams = /* @__PURE__ */ new Set();
function live(ch, as, last) {
  const enc = new TextEncoder();
  let stop = () => {
  };
  const stream = new ReadableStream({
    start(c) {
      const send = (o) => {
        try {
          c.enqueue(enc.encode(`data: ${JSON.stringify(o)}

`));
        } catch {
          stop();
        }
      };
      c.enqueue(enc.encode(`retry: 3000
data: ${JSON.stringify({ ch: ch.name, type: "hello", data: { last } })}

`));
      const off = ch.subscribe((m) => {
        if (as && as !== OWNER) {
          if (m.type !== "event") return;
          const e = m.data;
          if (e.from === as) return;
        }
        send(m);
      });
      const ka = setInterval(() => {
        try {
          c.enqueue(enc.encode(": ping\n\n"));
        } catch {
          stop();
        }
      }, 15e3);
      stop = () => {
        off();
        clearInterval(ka);
        streams.delete(stop);
        try {
          c.close();
        } catch {
        }
      };
      streams.add(stop);
    },
    cancel() {
      stop();
    }
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
}
async function body(req) {
  if (req.method !== "POST" && req.method !== "PATCH") return {};
  const t = await req.text();
  if (!t) return {};
  let v;
  try {
    v = JSON.parse(t);
  } catch {
    throw new HuddleError(400, "body is not JSON");
  }
  return AUTH.redact(v);
}
async function adminRoute(req, path, me) {
  const rootOnly = () => me.root ? null : json({ error: "only the session that started Huddle may do this" }, 403);
  if (path === "/api/whoami") return json(me);
  if (path === "/api/tokens" && req.method === "POST") {
    if (!me.invite) return json({ error: "this credential may not invite" }, 403);
    const b2 = await body(req);
    const ttl = b2.ttl === void 0 ? void 0 : Number(b2.ttl);
    if (ttl !== void 0 && !(Number.isFinite(ttl) && ttl >= 0)) return json({ error: "ttl: seconds, 0 = never expires" }, 400);
    return json(AUTH.create({
      ttl,
      single: !!b2.single_use,
      invite: !!b2.can_invite && me.root,
      channel: typeof b2.channel === "string" ? b2.channel : void 0,
      description: typeof b2.description === "string" ? b2.description.slice(0, 200) : void 0,
      by: me.name
    }));
  }
  if (path === "/api/tokens" && req.method === "GET") return rootOnly() ?? json(AUTH.list());
  let m = /^\/api\/tokens\/([a-z0-9]{6})$/.exec(path);
  if (m && req.method === "DELETE") return rootOnly() ?? (AUTH.revoke(m[1]) ? json({ deleted: m[1] }) : json({ error: `no token ${m[1]}` }, 404));
  if (path === "/api/members" && req.method === "GET") return rootOnly() ?? json(AUTH.memberList());
  m = /^\/api\/members\/([a-z][a-z0-9_-]{0,31})$/.exec(path);
  if (m && req.method === "DELETE") return rootOnly() ?? (AUTH.kick(m[1]) ? json({ kicked: m[1] }) : json({ error: `no member ${m[1]}` }, 404));
  if (path === "/api/login" && req.method === "POST") {
    if (me.browser) return json({ error: "a browser does not sign in other browsers: huddle open (or /huddle:open) in a session" }, 403);
    return json({ code: AUTH.loginCode(me.root ? null : me.name), expires_in: 300 });
  }
  return null;
}
async function channelRoute(req, u, name, rest) {
  const ch = await hub.get(name, false);
  const as = who(req, u);
  if (rest === "") return json({ name, config: ch.config(), stats: await ch.stats(), turn: await ch.turn(), views: viewNames(ch) });
  let m = /^op\/([a-z_]+)$/.exec(rest);
  if (m && req.method === "POST") {
    if (!as) throw new HuddleError(400, "say who you are: ?as=<session> or header x-huddle-as");
    const b2 = await body(req);
    const { result, text } = await runOp(m[1], ch, as, b2, { signal: req.signal, waitDefault: 240 });
    if (m[1] === "join" && b2.claude_session) await link(ch, as, b2.claude_session);
    return json({ result, text });
  }
  if (rest === "live") return live(ch, as, await ch.lastSeq());
  if (rest === "board") return json({ phases: await ch.phases(), steps: await ch.tasks(), meta: { ...ch.config(), fts: ch.fts, plan_at: ch.meta("plan_at") } });
  if (rest === "sessions") return json({ sessions: await ch.sessions(), turn: await ch.turn(), config: ch.config() });
  if (rest === "timeline") return json(await ch.events({ limit: Number(u.searchParams.get("limit") ?? 300), after: Number(u.searchParams.get("after") ?? 0), before: u.searchParams.get("before") ? Number(u.searchParams.get("before")) : void 0, topic: u.searchParams.get("topic") ?? void 0 }));
  if (rest === "search") return json(await ch.search(u.searchParams.get("q") ?? ""));
  if (rest === "review") return json(await ch.review());
  if (rest === "attention") return json(await ch.attention());
  if (rest === "kb") return json(await recall(ch, u.searchParams.get("q") ?? "", { kind: u.searchParams.get("kind") ?? void 0, limit: Number(u.searchParams.get("limit") ?? 50) }));
  if (m = /^kb\/(\d+)$/.exec(rest)) return json(await kb(ch, Number(m[1])));
  if (rest === "knowledge.md") return new Response(await exportMarkdown(ch, { verified: /^(1|true)$/.test(u.searchParams.get("verified") ?? "") }), { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });
  if (rest === "conflicts") return json(await conflicts(ch));
  if (m = /^task\/([\w.-]{1,32})$/.exec(rest)) {
    const t = await ch.task(m[1]);
    return t ? json(t) : json({ error: "no such task" }, 404);
  }
  if (rest === "plan.json") return json({ meta: ch.config(), phases: await ch.phases(), steps: await Promise.all((await ch.tasks()).map((t) => ch.task(t.id))) });
  if (rest === "export.md") return new Response(await exportMd(ch), { headers: { "content-type": "text/markdown; charset=utf-8" } });
  if (m = /^repo\/([a-z]+)$/.exec(rest)) return json(await repoRoute(ch, m[1], u));
  if (rest === "diagram") {
    const f = diagramFile(ch, u.searchParams.get("name") ?? "");
    return f ? new Response(await readFile3(f), { headers: { "content-type": "image/png" } }) : new Response("bad", { status: 400 });
  }
  if (m = /^x\/([a-z/]+)$/.exec(rest)) {
    const r = await route(ch, m[1], req, u, as, () => body(req));
    if (r !== null) return json(r);
  }
  return json({ error: "not found" }, 404);
}
async function handle(req) {
  const bad2 = guard(req);
  if (bad2) return bad2;
  const u = new URL(req.url);
  const path = u.pathname;
  if (path === "/" && u.searchParams.has("code")) {
    const cred = AUTH.redeem(u.searchParams.get("code") ?? "");
    if (!cred) return new Response(signedOutPage(), { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    u.searchParams.delete("code");
    return new Response(null, { status: 303, headers: {
      location: `/${u.search}`,
      "cache-control": "no-store",
      "set-cookie": `${COOKIE}=${encodeURIComponent(cred)}; Path=/; HttpOnly; SameSite=Strict`
    } });
  }
  if (path === "/api/join" && req.method === "POST") {
    const b2 = await req.json().catch(() => ({}));
    let name = String(b2.name ?? "");
    if (!NAME_RE.test(name) || name.includes(".") || name === OWNER) return json({ error: `name must match ${NAME_RE} (no subagent, not owner)` }, 400);
    const p = b2.unique ? AUTH.peek(String(b2.token ?? "")) : null;
    if (p) {
      const ch = p.channel ?? (typeof b2.channel === "string" ? b2.channel : "");
      const taken = /* @__PURE__ */ new Set([...p.members, OWNER]);
      if (ch) try {
        if (await hub.exists(ch)) for (const s2 of await (await hub.get(ch, false)).sessions()) taken.add(String(s2.name));
      } catch {
      }
      for (let i2 = 2, base = name.slice(0, 28); taken.has(name); i2++) name = `${base}-${i2}`;
    }
    const r = AUTH.join(String(b2.token ?? ""), name);
    return "error" in r ? json({ error: "invalid or expired join token: ask the owner for a new join command" }, 401) : json(r);
  }
  let me = null;
  if (path.startsWith("/api/") || path === "/mcp" || path.startsWith("/mcp/")) {
    me = AUTH.who(given(req, COOKIE));
    if (!me) return req.headers.get("x-huddle-token") ? json({ error: SESSION_401 }, 401) : json({ error: SIGNED_OUT, signin: true }, 401);
    const as = who(req, u);
    if (as && !mayAct(me, as)) return json({ error: `this credential is ${me.name}'s: it acts as ${me.name} or ${me.name}.<role>, not ${as}` }, 403);
  }
  try {
    if (me && path === "/api/settings") return json(await settings(req, NOTIFY, me, () => body(req)));
    if (me && path.startsWith("/api/") && !path.startsWith("/api/c/")) {
      const r = await adminRoute(req, path, me);
      if (r) return r;
    }
    if (path === "/health") return json({ ok: true, version: VERSION2, started: STARTED, channels: (await hub.names()).length });
    if (path === "/" || path === "/index.html") return new Response(await readFile3(`${ROOT}/public/index.html`), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (path.startsWith("/static/") && !path.includes("..")) {
      const f = `${ROOT}/public/${path.slice(8)}`;
      if (existsSync7(f) && statSync5(f).isFile()) return new Response(await readFile3(f), { headers: { "content-type": STATIC[path.slice(path.lastIndexOf("."))] ?? "text/plain", "cache-control": "no-store" } });
      return new Response("not found", { status: 404 });
    }
    if (path === "/connect.md") return new Response(await readFile3(`${ROOT}/CONNECT.md`), { headers: { "content-type": STATIC[".md"] } });
    if (path === "/api/channels" && req.method === "GET") return json(await hub.list());
    if (path === "/api/channels" && req.method === "POST") {
      const b2 = await body(req);
      if (await hub.exists(String(b2.name ?? ""))) throw new HuddleError(409, `channel ${b2.name} exists`);
      const ch = await hub.get(String(b2.name ?? ""), true);
      const { name: _n, ...cfg } = b2;
      return json({ name: ch.name, config: await ch.configure(cfg) });
    }
    let m = /^\/api\/c\/([a-z0-9-]{1,40})(?:\/(.*))?$/.exec(path);
    if (m) {
      if (/^op\/join$/.test(m[2] ?? "") && hub.autoCreate && !await hub.exists(m[1])) await hub.get(m[1], true);
      return await channelRoute(req, u, m[1], m[2] ?? "");
    }
    m = /^\/mcp\/([a-z0-9-]{1,40})$/.exec(path);
    if (m || path === "/mcp") {
      const channel = m?.[1] ?? u.searchParams.get("channel") ?? req.headers.get("x-huddle-channel") ?? "";
      const as = who(req, u);
      if (!channel || !as) return json({ error: "use /mcp/<channel>?as=<session>" }, 400);
      if (req.method === "GET") return new Response("this endpoint answers POST; pushes come from bin/huddle-mcp", { status: 405 });
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      if (hub.autoCreate && !await hub.exists(channel)) await hub.get(channel, true);
      const msg = await body(req);
      const batch = Array.isArray(msg) ? msg : [msg];
      const out = (await Promise.all(batch.map((x) => mcpHandle(hub, channel, as, x, req.signal)))).filter(Boolean);
      if (!out.length) return new Response(null, { status: 202 });
      const sid = !Array.isArray(msg) && msg.method === "initialize" ? { "mcp-session-id": crypto.randomUUID() } : {};
      return json(Array.isArray(msg) ? out : out[0], 200, sid);
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    const err = e;
    return json({ error: err.message }, err.status ?? 500);
  }
}
var inFlight = 0;
var wakers = [];
var tracked = (req) => {
  inFlight++;
  return handle(req).finally(() => {
    if (--inFlight === 0) for (const w of wakers.splice(0)) w();
  });
};
var drain = (ms) => new Promise((resolve) => {
  if (inFlight === 0) return resolve();
  const w = () => {
    clearTimeout(t);
    const i2 = wakers.indexOf(w);
    if (i2 >= 0) wakers.splice(i2, 1);
    resolve();
  };
  const t = setTimeout(w, ms);
  wakers.push(w);
});
var server = await serve({ hostname: process.env.HOST ?? "127.0.0.1", port: PORT, fetch: tracked });
if (!PORT) {
  PORT = Number(server.port);
  HOSTS = /* @__PURE__ */ new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...EXTRA_HOSTS]);
  COOKIE = `huddle_session_${PORT}`;
}
var names = await hub.names().catch((e) => {
  console.error(`storage: ${e.message}`);
  return [];
});
console.log(`Huddle ${VERSION2} on http://${server.hostname}:${server.port} \xB7 data ${hub.where()} \xB7 channels ${names.join(", ") || "none"}`);
if (!process.env.HUDDLE_TOKEN && process.env.HUDDLE_ROOT_STDIN !== "1" && process.stdout.isTTY)
  console.log(`root credential (this run only; HUDDLE_TOKEN=\u2026 for the CLI): ${ROOT_CRED}
dashboard: http://127.0.0.1:${server.port}/?code=${AUTH.loginCode()}`);
var shutdown = () => {
  AUTH.flush();
  hub.close().finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
var gone = async () => {
  console.log("huddle: the plugin is gone from Claude Code \u2014 stopping");
  server.stop();
  for (const s2 of [...streams]) s2();
  await drain(3e4);
  await sleep(100);
  server.stop(true);
  for (const n of await hub.names())
    await hub.get(n, false).then((ch) => ch.store.all("PRAGMA wal_checkpoint(TRUNCATE)"), () => {
    });
  await hub.close();
  removeRunFiles(HOME);
  rmSync2(AUTH_FILE, { force: true });
  writeLeftBehind(HOME, hub.where());
  process.exit(0);
};
var PROJECTS = [...new Set([process.env.CLAUDE_PROJECT_DIR, process.cwd()].filter(Boolean))];
var WATCH_MS = Number(process.env.HUDDLE_REMOVAL_MS || 1e4);
if (process.env.HUDDLE_REMOVAL_WATCH === "1")
  watchRemoval({ env: process.env, plugin: "huddle", projects: () => PROJECTS, ms: Number.isFinite(WATCH_MS) && WATCH_MS > 0 ? WATCH_MS : 1e4, gone });
