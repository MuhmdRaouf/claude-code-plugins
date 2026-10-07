import { test, expect, beforeEach, afterAll } from "bun:test";
import { Channel, HuddleError } from "../plugin/server/src/channel";
import { runOp, identity } from "../plugin/server/src/ops";
import { freshChannel, cleanup } from "./db";

let ch: Channel;
beforeEach(async () => {
  ch = await freshChannel();
  await ch.join("a", { role: "builds" }); await ch.join("b", { role: "tests" });
});
afterAll(cleanup);
const err = async (f: () => Promise<unknown>) => { try { await f(); } catch (e) { return e as HuddleError; } throw new Error("no error"); };

test("every member sees every event but its own, also those addressed to another session", async () => {
  await ch.publish("a", { topic: "x.all", msg: "1" });
  await ch.publish("a", { topic: "x.b", msg: "2", to: "b" });
  await ch.join("c");
  await ch.publish("a", { topic: "x.c", msg: "3", to: "c" });
  // b joined fresh (a first join), after a's session.joined: it reads on from there
  expect((await ch.unread("b")).map(e => e.topic)).toEqual(["x.all", "x.b", "session.joined", "x.c"]);
  expect((await ch.unread("a")).map(e => e.topic)).toEqual(["session.joined", "session.joined"]);
  expect((await ch.unread("c")).map(e => e.topic)).toContain("x.c");
});

test("a message to another session never wakes this one: it waits on, and sees it in skipped", async () => {
  await ch.join("c");
  await ch.ack("b", await ch.lastSeq());
  const p = ch.wait("b", ["msg"], 5);
  await ch.send("a", "c", "for c only");
  await Bun.sleep(100);
  await ch.send("a", "b", "for b");
  const h: any = await p;
  expect(h.kind).toBe("event");
  expect(h.msg).toBe("for b");
  expect(h.skipped.map((e: any) => [e.to, e.msg])).toEqual([["c", "for c only"]]);
  await ch.ack("b", h.seq);
});

test("wait returns the first match with the skipped events, wakes on publish, and ack never moves back", async () => {
  await ch.ack("b", await ch.lastSeq());
  const p = ch.wait("b", ["build.*"], 5);
  await ch.publish("a", { topic: "note.x", msg: "skip me" });
  await ch.publish("a", { topic: "build.ready", msg: "go" });
  const h: any = await p;
  expect(h.kind).toBe("event"); expect(h.topic).toBe("build.ready");
  expect(h.skipped.map((s: any) => s.topic)).toEqual(["note.x"]);
  expect((await ch.ack("b", h.seq)).cursor).toBe(h.seq);
  expect((await ch.ack("b", 1)).cursor).toBe(h.seq);
});

test("an ask wakes the addressee's wait as a message until answered; answering twice is refused", async () => {
  const ask = await ch.send("a", "b", "ready?", { ask: true });
  const h: any = await ch.wait("b", ["nothing"], 1);
  expect(h.kind).toBe("message"); expect(h.seq).toBe(ask.seq);
  await ch.reply("b", ask.seq, "yes");
  expect(await ch.inbox("b")).toHaveLength(0);
  expect((await err(() => ch.reply("b", ask.seq, "again"))).status).toBe(409);
  expect((await err(() => ch.reply("a", ask.seq, "mine"))).status).toBe(400);
});

test("a broadcast ask needs a reply from each session", async () => {
  await ch.join("c");
  const ask = await ch.send("a", null, "all ok?", { ask: true });
  await ch.reply("b", ask.seq, "ok");
  expect(await ch.inbox("b")).toHaveLength(0);
  expect(await ch.inbox("c")).toHaveLength(1);
});

test("dependencies: doing is refused until deps finish; finishing releases task.ready to the owner", async () => {
  await ch.createTask("a", { id: "build", title: "build", owner: "a" });
  await ch.createTask("a", { id: "test", title: "test", owner: "b", after: ["build"] });
  expect((await err(() => ch.setStatus("b", "test", "doing"))).status).toBe(409);
  await ch.ack("b", await ch.lastSeq());
  const w = ch.wait("b", ["task.ready"], 5);
  await ch.setStatus("a", "build", "done", "ok");
  const h: any = await w;
  expect(h.topic).toBe("task.ready"); expect(h.to).toBe("b"); expect(h.data.task).toBe("test");
  expect((await ch.setStatus("b", "test", "doing")).ok).toBe(true);
});

test("a task waiting on two releases only when both finish", async () => {
  await ch.createTask("a", { id: "x", title: "x" }); await ch.createTask("a", { id: "y", title: "y" });
  await ch.createTask("a", { id: "z", title: "z", owner: "b", after: ["x", "y"] });
  await ch.setStatus("a", "x", "done");
  expect((await ch.unread("b")).filter(e => e.topic === "task.ready")).toHaveLength(0);
  await ch.setStatus("a", "y", "skipped");
  expect((await ch.unread("b")).filter(e => e.topic === "task.ready")).toHaveLength(1);
});

test("cycles and unknown dependencies are refused", async () => {
  await ch.createTask("a", { id: "p", title: "p" });
  await ch.createTask("a", { id: "q", title: "q", after: ["p"] });
  expect((await err(() => ch.updateTask("a", "p", { after: ["q"] }))).message).toMatch(/cycle/);
  expect((await err(() => ch.createTask("a", { id: "r", title: "r", after: ["nope"] }))).message).toMatch(/unknown/);
});

test("wait_task resolves when another session finishes the task", async () => {
  await ch.createTask("a", { id: "k", title: "k", owner: "a" });
  const w = ch.waitTask("b", "k", 5);
  await ch.setStatus("a", "k", "done", "built");
  expect(((await w) as any).status).toBe("done");
});

test("pause: any member pauses another; its writes are refused; gate resolves on resume", async () => {
  await ch.control("b", "a", "pause", "hold on");
  expect((await err(() => ch.publish("a", { topic: "x.y", msg: "m" }))).status).toBe(423);
  let resolved = false;
  const g = ch.gate("a", 5).then(r => { resolved = true; return r; });
  await Bun.sleep(20); expect(resolved).toBe(false);
  await ch.control("owner", "a", "resume");
  expect((await g).control).toBe("run");
  expect((await ch.publish("a", { topic: "x.y", msg: "m" })).topic).toBe("x.y");
});

test("turn: handover topics and explicit pass move it; the materialized turn matches a replay", async () => {
  await ch.configure({ start: "a", handover: { a: { to: "b", topics: ["finding.ready"] }, b: { to: "a", topics: ["build.ready"] } } });
  expect((await ch.turn()).holder).toBe("a");
  await ch.publish("a", { topic: "finding.ready", msg: "f" });
  expect((await ch.turn()).holder).toBe("b");
  await ch.publish("b", { topic: "note.x", msg: "n" });
  expect((await ch.turn()).holder).toBe("b");
  await ch.passTurn("b", "a", "your go");
  expect((await ch.turn()).holder).toBe("a");
  const before = (await ch.turn()).holder; await ch.replayTurn(); expect((await ch.turn()).holder).toBe(before);
});

test("idempotency keys make a retried publish return the first event, also when retried concurrently", async () => {
  const e1 = await ch.publish("a", { topic: "x.y", msg: "m", key: "k1" });
  const e2: any = await ch.publish("a", { topic: "x.y", msg: "m", key: "k1" });
  expect(e2.seq).toBe(e1.seq); expect(e2.duplicate).toBe(true);
  const many = await Promise.all(Array.from({ length: 20 }, () => ch.publish("a", { topic: "x.z", msg: "m", key: "k2" })));
  expect(new Set(many.map(e => e.seq)).size).toBe(1);
  expect((await ch.events({ topic: "x.z" }))).toHaveLength(1);
});

test("subagents: join under a joined parent, start at the present, and only the parent may act as them", async () => {
  await ch.publish("a", { topic: "old.news", msg: "before" });
  expect((await err(() => ch.join("zz.sub"))).message).toMatch(/must join/);
  await ch.join("b.explore", { role: "reads the code" });
  expect(await ch.unread("b.explore")).toHaveLength(0);
  expect(identity("b", "b.explore")).toBe("b.explore");
  expect(() => identity("a", "b.explore")).toThrow();
  const r = await runOp("state", ch, "b", { state: "working", task: "reading", as: "b.explore" });
  expect((r.result as any).name).toBe("b.explore");
  await ch.leave("b.explore", "found it");
  expect((await ch.sessions()).find(s => s.name === "b.explore")!.state).toBe("left");
});

test("members: when set, only members (and their subagents) may join", async () => {
  await ch.configure({ members: ["a", "b"] });
  expect((await err(() => ch.join("c"))).status).toBe(403);
  expect((await ch.join("a.helper")).me).toBe("a.helper");
});

test("knowledge: remember, recall by words, supersede, read with hits", async () => {
  const k1 = await ch.remember("a", { kind: "lesson", title: "ugrep alias recurses", body: "use /usr/bin/grep in pipes", tags: ["shell"] });
  await ch.remember("b", { kind: "fact", title: "Valkey runs on 6379", body: "container cache-1" });
  expect((await ch.recall("grep")).map(k => k.id)).toEqual([k1.id]);
  expect(await ch.recall("", { kind: "fact" })).toHaveLength(1);
  const k3 = await ch.remember("a", { kind: "lesson", title: "grep in pipes", body: "/usr/bin/grep, always", supersedes: k1.id });
  expect((await ch.recall("grep")).map(k => k.id)).toEqual([k3.id]);
  expect((await ch.kb(k1.id)).superseded_by).toBe(k3.id);
  expect((await ch.kb(k3.id)).hits).toBe(1);
  expect((await ch.recall("grep"))[0].hit).toMatch(/«/);
});

test("search finds tasks by prefix with « » snippets, and sees owner edits", async () => {
  await ch.createTask("a", { id: "s1", title: "Configure the firewall", body: { what: "open port 443 for the proxy" } });
  await ch.createTask("a", { id: "s2", title: "Write docs", body: { what: "explain everything" } });
  expect((await ch.search("firew")).map((r: any) => r.id)).toEqual(["s1"]);
  expect((await ch.search("proxy"))[0].hit).toMatch(/«prox/);
  await ch.updateTask("owner", "s2", { field: "what", value: "document the proxy too" });
  expect((await ch.search("proxy")).map((r: any) => r.id).sort()).toEqual(["s1", "s2"]);
});

test("plan import keeps state by id, reports moved titles, and next respects owners", async () => {
  const plan = { phases: [{ n: 0, title: "base", steps: [{ id: "0.01", title: "one" }, { id: "0.02", title: "two", depends: ["0.01"] }] }] };
  await ch.importPlan("owner", plan, { owner: "a" });
  await ch.setStatus("a", "0.01", "done");
  await ch.note("owner", "0.02", "change", "do it differently");
  plan.phases[0].steps[1].title = "two, renamed";
  const r = await ch.importPlan("owner", plan, { owner: "a" });
  expect((await ch.task("0.01"))!.status).toBe("done");
  expect(r.moved.map((m: any) => m.id)).toEqual(["0.02"]);
  const n: any = await ch.next("a");
  expect(n.id).toBe("0.02"); expect(n.ready).toBe(true); expect(n.open_notes).toHaveLength(1);
  expect((await ch.next("b") as any).done).toBe(true);
});

test("a cancelled wait releases its waiter", async () => {
  const ac = new AbortController();
  const w = ch.wait("b", ["never"], 0, ac.signal);
  ac.abort();
  expect(((await w) as any).kind).toBe("cancelled");
});

test("attention gathers what waits on the owner; approve clears a gate and tells the task owner", async () => {
  await ch.importPlan("owner", { phases: [{ n: 0, title: "p", steps: [{ id: "g1", title: "needs a yes", gate: "ask-first" }, { id: "g2", title: "later", gate: "owner", depends: ["g1"] }] }] }, { owner: "a" });
  await ch.send("b", "owner", "which option?", { ask: true });
  await ch.control("owner", "b", "pause");
  let at: any = await ch.attention();
  expect(at.asks.map((x: any) => x.msg)).toEqual(["which option?"]);
  expect(at.gates.map((x: any) => x.id)).toEqual(["g1"]);   // g2 still waits on g1
  expect(at.paused.map((x: any) => x.name)).toEqual(["b"]);
  await ch.approve("g1", "go");
  expect((await ch.unread("a")).some(e => e.data?.approved && e.data.task === "g1")).toBe(true);
  at = await ch.attention();
  expect(at.gates).toHaveLength(0);
});

test("workflows: start, depend (blocks until the other session finishes), finish (shares the result, releases)", async () => {
  await ch.createTask("a", { id: "mine", title: "integrate", owner: "a" });
  const s1: any = (await runOp("start", ch, "a", {})).result;
  expect(s1.started).toBe(true); expect((await ch.task("mine"))!.status).toBe("doing");
  await ch.ack("a", await ch.lastSeq());
  const dep = runOp("depend", ch, "a", { owner: "b", title: "ship the API", timeout: 5 });
  // depend blocks the task before it waits: poll for it (a loaded machine can take longer than a fixed sleep)
  for (let t = Date.now(); Date.now() - t < 4000 && (await ch.task("mine"))!.status !== "blocked"; ) await Bun.sleep(25);
  expect((await ch.task("mine"))!.status).toBe("blocked");
  const theirs = (await ch.tasks({ owner: "b" }))[0];
  await runOp("start", ch, "b", { id: theirs.id });
  const fin: any = (await runOp("finish", ch, "b", { note: "curl /api 200", result: "base url http://api:8080" })).result;
  expect(fin.released.map((r: any) => r.task)).toEqual(["mine"]);
  const woke: any = (await dep).result;
  expect(woke.woke.topic).toBe("task.ready"); expect(woke.woke.ref).toBe("mine");
  expect((await ch.recall("base url"))[0].kind).toBe("result");
  const s2: any = (await runOp("start", ch, "a", { id: "mine" })).result;
  expect(s2.started).toBe(true);
});

test("workflows: start refuses a task that still waits; ask_wait returns the answer; handoff passes the turn", async () => {
  await ch.createTask("a", { id: "x", title: "x", owner: "b" });
  await ch.createTask("a", { id: "y", title: "y", owner: "a", after: ["x"] });
  const r: any = (await runOp("start", ch, "a", { id: "y" })).result;
  expect(r.started).toBe(false); expect(r.hint).toMatch(/waits on x/);
  const q = runOp("ask_wait", ch, "a", { to: "b", msg: "port?", timeout: 5 });
  let ib: any[] = [];
  for (let i = 0; i < 100 && !ib.length; i++) { await Bun.sleep(10); ib = await ch.inbox("b"); }
  await ch.reply("b", ib[0].seq, "8080");
  expect(((await q).result as any).answer).toBe("8080");
  const h: any = (await runOp("handoff", ch, "a", { to: "b", msg: "your go", title: "deploy", wait: false })).result;
  expect((await ch.turn()).holder).toBe("b"); expect((await ch.task(h.task))!.owner).toBe("b");
});
