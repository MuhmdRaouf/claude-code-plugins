// Waiters on an async database: a waiter registers before it queries, and re-queries after every
// wake-up, so a publish that lands at any point of a wait's life wakes it, and exactly once.
import { test, expect, afterAll } from "bun:test";
import { freshChannel, cleanup } from "./db";

afterAll(cleanup);

test("every wait wakes when publishes race with the waits (hundreds of iterations)", async () => {
  const ch = await freshChannel();
  const N = 40, ROUNDS = 12; // 480 waits, each racing a publish
  for (let i = 0; i < N; i++) await ch.join(`w${i}`);
  await ch.join("pub");
  let woke = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const last = await ch.lastSeq();
    await Promise.all(Array.from({ length: N }, (_, i) => ch.ack(`w${i}`, last)));
    // each waiter starts at a different moment relative to its publish: before, during, after
    const waits = Array.from({ length: N }, async (_, i) => {
      if (i % 3 === 1) await Promise.resolve();
      if (i % 3 === 2) await Bun.sleep(0);
      return ch.wait(`w${i}`, [`go.r${r}`], 10);
    });
    const pubs = Array.from({ length: N }, (_, i) => (i % 2 ? Bun.sleep(0) : Promise.resolve()).then(() =>
      ch.publish("pub", { topic: `go.r${r}`, msg: `${i}`, to: `w${i}` })));
    const [hits] = await Promise.all([Promise.all(waits), Promise.all(pubs)]);
    for (const [i, h] of hits.entries()) {
      expect(h.kind).toBe("event");
      expect((h as any).to).toBe(`w${i}`);
      woke++;
    }
  }
  expect(woke).toBe(N * ROUNDS);
}, 30_000); // a correctness check, not a speed one: a loaded machine needs the room

test("waitReply, waitTask and gate wake when the answer races the wait", async () => {
  const ch = await freshChannel();
  await ch.join("a"); await ch.join("b");
  for (let i = 0; i < 100; i++) {
    const q = await ch.send("a", "b", `q${i}`, { ask: true });
    const [h] = await Promise.all([ch.waitReply("a", q.seq, 10), ch.reply("b", q.seq, `r${i}`)]);
    expect((h as any).msg).toBe(`r${i}`);
    await ch.createTask("b", { id: `t${i}`, title: `t${i}` });
    const [t] = await Promise.all([ch.waitTask("a", `t${i}`, 10), ch.setStatus("b", `t${i}`, "done")]);
    expect((t as any).status).toBe("done");
    await ch.control("a", "b", "pause");
    const [g] = await Promise.all([ch.gate("b", 10), ch.control("a", "b", "resume")]);
    expect(g.control).toBe("run");
  }
}, 30_000); // 100 rounds of three races: a lost wake-up fails an expect (each wait has 10 s), slowness must not

test("a waiter resolves once, even when many publishes wake it at the same time", async () => {
  const ch = await freshChannel();
  await ch.join("a"); await ch.join("b");
  await ch.ack("b", await ch.lastSeq());
  let settled = 0;
  const w = ch.wait("b", ["burst.*"], 10).then(h => { settled++; return h; });
  await Promise.all(Array.from({ length: 200 }, (_, i) => ch.publish("a", { topic: "burst.x", msg: `${i}` })));
  const h: any = await w;
  await Bun.sleep(20);
  expect(settled).toBe(1);
  expect(h.kind).toBe("event");
  expect((ch as any).waiters.size).toBe(0);
});
