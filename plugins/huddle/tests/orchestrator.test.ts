// The orchestrator, the map and the two join contexts (fresh and sync).
import { test, expect, beforeEach, afterAll } from "bun:test";
import { Channel, HuddleError } from "../plugin/server/src/channel";
import { runOp } from "../plugin/server/src/ops";
import { freshChannel, cleanup } from "./db";

let ch: Channel;
beforeEach(async () => {
  ch = await freshChannel();
  await ch.join("lead", { role: "runs the plan" }); await ch.join("api", { role: "builds the orders API" }); await ch.join("web", { role: "builds the client" });
  await ch.configure({ title: "Shop", description: "ship orders end to end", orchestrator: "lead" });
});
afterAll(cleanup);
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { return (e as HuddleError).status; } };

test("a fresh join skips the backlog but keeps open asks; sync replays it", async () => {
  for (let i = 0; i < 5; i++) await ch.publish("web", { topic: "note.x", msg: `n${i}` });
  await ch.send("web", "api", "which port?", { ask: true });
  const f: any = await ch.join("api", { context: "fresh" });
  expect(f.context).toBe("fresh");
  expect(f.skipped).toBeGreaterThanOrEqual(6);
  expect(f.unread_total).toBe(0);
  expect(f.inbox.map((m: any) => m.msg)).toEqual(["which port?"]);
  expect(f.brief.asks.map((m: any) => m.msg)).toEqual(["which port?"]);
  await ch.publish("web", { topic: "note.y", msg: "later" });
  const s: any = await ch.join("api", { context: "sync" });
  expect(s.context).toBe("sync"); expect(s.brief).toBeNull();
  expect(s.unread.map((e: any) => e.msg)).toEqual(["later"]);
});

test("defaults: a first join and a subagent are fresh; a return is sync unless assign says fresh", async () => {
  await ch.publish("web", { topic: "note.x", msg: "before" });
  expect((await ch.join("docs") as any).context).toBe("fresh");
  expect((await ch.join("api.explore") as any).context).toBe("fresh");
  expect((await ch.join("api") as any).context).toBe("sync");
  await ch.assign("lead", "api", "fresh");
  expect((await ch.join("api") as any).context).toBe("fresh");
  await ch.assign("owner", "api", null);
  expect((await ch.join("api") as any).context).toBe("sync");
});

test("a brief appears on the next fresh join exactly once, and is sent as a message now", async () => {
  await ch.importPlan("lead", { phases: [{ n: 1, title: "build", steps: [{ id: "orders", title: "Ship the orders API", owner: "api", what: "cursor pagination" }, { id: "client", title: "Client", owner: "web", depends: ["orders"] }] }] });
  await ch.remember("lead", { kind: "decision", title: "orders paginate by cursor", body: "?after=<id>&limit<=100", tags: ["orders"] });
  await ch.remember("lead", { kind: "fact", title: "unrelated cache note", body: "valkey on 6379" });
  const r: any = (await runOp("brief", ch, "lead", { session: "api", msg: "Start with the orders API; ignore the old thread." })).result;
  expect((await ch.event(r.event))!.to).toBe("api");
  expect((await ch.presenceOf("api"))!.brief_waiting).toBe(true);
  const j1: any = await ch.join("api", { context: "fresh" });
  expect(j1.brief.from_orchestrator.msg).toMatch(/orders API/);
  expect(j1.brief.tasks.map((t: any) => t.id)).toEqual(["orders"]);
  expect(j1.brief.knowledge[0].title).toBe("orders paginate by cursor");
  expect(j1.brief.goal).toBe("ship orders end to end");
  expect((await ch.presenceOf("api"))!.brief_waiting).toBe(false);
  const j2: any = await ch.join("api", { context: "fresh" });
  expect(j2.brief.from_orchestrator).toBeNull();
  const w: any = await ch.join("web", { context: "fresh" });
  expect(w.brief.tasks).toEqual([{ id: "client", title: "Client", status: "todo", ready: false, waits_on: ["orders"] }]);
  expect((await runOp("status", ch, "api", {})).text).toMatch(/orchestrator: lead/);
});

test("only the owner or the orchestrator may import_plan, assign, brief, approve; only the owner names the orchestrator", async () => {
  const plan = { phases: [{ n: 1, title: "p", steps: [{ id: "a1", title: "a1" }] }] };
  expect(await status(runOp("import_plan", ch, "api", { plan }))).toBe(403);
  expect(await status(runOp("assign", ch, "api", { session: "web", context: "fresh" }))).toBe(403);
  expect(await status(runOp("brief", ch, "web", { session: "api", msg: "x" }))).toBe(403);
  expect(await status(runOp("import_plan", ch, "lead", { plan }))).toBe(200);
  expect(await status(runOp("assign", ch, "lead", { session: "web", context: "fresh", task: "a1" }))).toBe(200);
  expect((await ch.task("a1"))!.owner).toBe("web");
  expect(await status(runOp("approve", ch, "lead", { id: "a1" }))).toBe(200);
  expect(await status(runOp("configure", ch, "lead", { title: "Shop 2" }))).toBe(200);
  expect(await status(runOp("configure", ch, "lead", { orchestrator: "api" }))).toBe(403);
  expect(await status(runOp("configure", ch, "lead", { members: ["lead"] }))).toBe(403);
  expect(await status(runOp("configure", ch, "owner", { orchestrator: "api" }))).toBe(200);
  expect(await status(runOp("import_plan", ch, "lead", { plan }))).toBe(403);
});

test("map: phases, sessions and the critical path of a diamond", async () => {
  // a → b → d and a → c → c2 → d: the longest open chain is a, c, c2, d
  await ch.importPlan("owner", { phases: [
    { n: 1, title: "one", steps: [{ id: "a", title: "A", owner: "api" }, { id: "b", title: "B", owner: "web", depends: ["a"] }, { id: "c", title: "C", owner: "api", depends: ["a"] }] },
    { n: 2, title: "two", steps: [{ id: "c2", title: "C2", depends: ["c"] }, { id: "d", title: "D", owner: "web", depends: ["b", "c2"] }, { id: "x", title: "X" }] },
  ] });
  let m: any = await ch.map();
  expect(m.critical_path.map((t: any) => t.id)).toEqual(["a", "c", "c2", "d"]);
  expect(m.phases.map((p: any) => [p.n, p.done, p.total])).toEqual([[1, 0, 3], [2, 0, 3]]);
  await ch.setStatus("api", "a", "done"); await ch.setStatus("api", "c", "doing");
  m = await ch.map();
  expect(m.critical_path.map((t: any) => t.id)).toEqual(["c", "c2", "d"]);
  expect(m.sessions.find((s: any) => s.name === "api").current.id).toBe("c");
  expect(m.phases[0].done).toBe(1);
  const t = (await runOp("map", ch, "web", {})).text!;
  expect(t.split("\n").length).toBeLessThanOrEqual(40);
  expect(t).toMatch(/critical path \(3 open tasks/);
});

test("every start is on the timeline: joined or returned, with its context and what it skipped", async () => {
  await ch.send("lead", "api", "one"); await ch.send("web", null, "two");
  await ch.join("api", { context: "fresh" });
  const [e]: any[] = await ch.events({ topic: "session.joined", from: "api" }).then(r => r.slice(-1));
  expect(e.msg).toBe("api returned");
  expect(e.data).toEqual({ context: "fresh", skipped: 3, returning: true }); // web joining after it, and the two messages
  const n: any[] = await ch.events({ topic: "session.joined", from: "docs" });
  expect(n).toEqual([]);
  await ch.join("docs", { role: "writes docs" });
  const [d]: any[] = await ch.events({ topic: "session.joined", from: "docs" });
  expect(d.msg).toBe("docs joined: writes docs");
  expect(d.data.returning).toBe(false);
});
