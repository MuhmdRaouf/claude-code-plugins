// tests/knowledge.test.ts — knowledge that lasts (plugin/server/src/knowledge.ts): verified first,
// age and "may be stale", duplicates offered for supersede, server-wide entries every channel
// recalls, and the Markdown export for CLAUDE.md.
import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Channel } from "../plugin/server/src/channel";
import { runOp } from "../plugin/server/src/ops";
import * as K from "../plugin/server/src/knowledge";
import { touched } from "../plugin/server/src/touches";
import { freshChannel, cleanup } from "./db";

let a: Channel, b: Channel, shared: K.Shared;
beforeEach(async () => {
  shared = await K.Shared.open(`${mkdtempSync(`${tmpdir()}/huddle-shared-`)}/shared.db`);
  a = await freshChannel("alpha"); b = await freshChannel("beta");
  K.attachShared(a, shared); K.attachShared(b, shared);
  await a.join("x"); await a.join("y"); await b.join("z");
});
afterAll(cleanup);
const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString().replace(/\.\d+Z$/, "Z");

test("verified entries rank first in recall, and anyone can verify or take it back", async () => {
  const k1 = await a.remember("x", { kind: "fact", title: "orders table indexed by created_at", body: "orders paginate by created_at" });
  const k2 = await a.remember("x", { kind: "fact", title: "orders use cursor pagination", body: "the API pages orders by cursor" });
  expect((await K.recall(a, "orders"))[0].id).not.toBe(-1);
  const v = await K.verify(a, "y", k1.id);
  expect(v.verified_by).toBe("y");
  const r = await K.recall(a, "orders");
  expect(r.map(k => k.id)).toEqual([k1.id, k2.id]);
  expect(r[0].verified_at).toBeTruthy();
  await K.verify(a, "owner", k2.id);
  await K.verify(a, "y", k1.id, true);
  expect((await K.recall(a, "orders"))[0].id).toBe(k2.id);
  expect((await a.events({ topic: "kb.verified" })).length).toBe(3);
  const { text } = await runOp("recall", a, "x", { q: "orders" });
  expect(text).toMatch(/verified \(owner\)/);
});

test("staleness: age, older than the default without a verify, or a referenced file edited since", async () => {
  const k = await a.remember("x", { kind: "howto", title: "build the cart", body: "make cart", refs: ["src/cart.ts:10-20", "https://example.com/doc"] });
  let [r] = await K.recall(a, "cart");
  expect(r.age_days).toBe(0); expect(r.stale).toBeNull();
  // another session edits the file the entry cites
  await Bun.sleep(1100);
  await touched(a, "y", { repo: "/r/shop", path: "src/cart.ts" });
  [r] = await K.recall(a, "cart");
  expect(r.stale).toMatch(/src\/cart\.ts was edited since/);
  // verifying it after the edit: fresh again
  await Bun.sleep(1100);
  await K.verify(a, "x", k.id);
  expect((await K.recall(a, "cart"))[0].stale).toBeNull();
  // an old entry nobody verified
  await a.store.run("UPDATE knowledge SET created_at=?, verified_at=NULL WHERE id=?", [ago(K.STALE_DAYS + 3), k.id]);
  [r] = await K.recall(a, "cart");
  expect(r.age_days).toBe(K.STALE_DAYS + 3);
  expect(r.stale).toMatch(/not verified for over 30 days/);
  expect((await runOp("recall", a, "x", { q: "cart" })).text).toMatch(/33d old.*MAY BE STALE/);
});

test("staleness: a referenced file on disk (in the channel's repo) that changed since", async () => {
  const repo = mkdtempSync(`${tmpdir()}/huddle-repo-`);
  writeFileSync(`${repo}/schema.sql`, "create table t();");
  await a.configure({ repo });
  await a.remember("x", { kind: "context", title: "the schema", body: "one table", refs: ["schema.sql"] });
  expect((await K.recall(a, "schema"))[0].stale).toBeNull();
  const later = new Date(Date.now() + 60_000);
  utimesSync(`${repo}/schema.sql`, later, later);
  expect((await K.recall(a, "schema"))[0].stale).toMatch(/schema\.sql changed since/);
});

test("duplicates: remember returns the existing entry and adds nothing; supersede or force adds", async () => {
  const k = await a.remember("x", { kind: "lesson", title: "ugrep alias recurses in pipes", body: "use /usr/bin/grep in pipes, the alias recurses" });
  const d = await K.remember(a, "y", { kind: "lesson", title: "ugrep alias recurses in pipes!", body: "the alias recurses; use /usr/bin/grep in pipes" }) as any;
  expect(d.duplicate).toBe(true);
  expect(d.existing.id).toBe(k.id);
  expect(d.hint).toContain(`supersedes=${k.id}`);
  expect((await a.recall("")).length).toBe(1);
  const text = (await runOp("remember", a, "y", { kind: "fact", title: "ugrep alias recurses in pipes", body: "use /usr/bin/grep in pipes, the alias recurses" })).text;
  expect(text).toMatch(/^not added: #\d+ .*supersedes=/);
  const s = await K.remember(a, "y", { kind: "lesson", title: "ugrep alias recurses in pipes", body: "use /usr/bin/grep", supersedes: k.id }) as any;
  expect(s.id).toBeGreaterThan(k.id);
  expect((await K.recall(a, "ugrep")).map(r => r.id)).toEqual([s.id]);
  const f = await K.remember(a, "y", { kind: "lesson", title: "ugrep alias recurses in pipes", body: "use /usr/bin/grep", force: true }) as any;
  expect(f.duplicate).toBeUndefined();
  // something different is never a duplicate
  expect((await K.remember(a, "y", { kind: "fact", title: "valkey runs on 6379", body: "container cache-1" }) as any).duplicate).toBeUndefined();
});

test("scope server: every channel recalls it, by its own id range; share moves a channel entry there", async () => {
  const g = await K.remember(a, "x", { kind: "lesson", title: "bun test needs --preload for env", body: "set it in bunfig.toml", scope: "server" }) as any;
  expect(g.id).toBeGreaterThanOrEqual(K.SHARED_BASE);
  expect(g.scope).toBe("server");
  const fromB = await K.recall(b, "preload");
  expect(fromB.map(k => k.id)).toEqual([g.id]);
  expect(fromB[0].origin).toBe("alpha");
  expect((await K.kb(b, g.id)).body).toBe("set it in bunfig.toml");
  // and a duplicate of it, written in another channel, is caught
  expect((await K.remember(b, "z", { kind: "lesson", title: "bun test needs --preload for env", body: "bunfig.toml sets it" }) as any).duplicate).toBe(true);
  // share: a channel entry goes server-wide; the channel's copy leaves recall and points at it
  const k = await a.remember("x", { kind: "fact", title: "the CI runner is arm64", body: "macos-14" });
  await K.verify(a, "y", k.id);
  const s = await K.share(a, "x", k.id) as any;
  expect(s.id).toBeGreaterThanOrEqual(K.SHARED_BASE);
  expect(s.verified_by).toBe("y");
  expect((await K.recall(a, "runner")).map(r => r.id)).toEqual([s.id]);
  expect((await K.recall(b, "runner")).map(r => r.id)).toEqual([s.id]);
  expect((await K.kb(a, k.id)).moved_to).toBe(s.id);
  expect((await a.recall("runner")).length).toBe(0);
  // verify works on a server-wide entry from any channel
  expect((await K.verify(b, "z", g.id)).verified_by).toBe("z");
  // empty recall: the newest of both stores
  expect((await K.recall(b, "")).map(r => r.id)).toContain(g.id);
});

test("export: Markdown grouped by kind for CLAUDE.md, verified only on request, server-wide included", async () => {
  const k = await a.remember("x", { kind: "lesson", title: "never run migrations twice", body: "line one\nline two", refs: ["db/migrate.ts"] });
  await a.remember("x", { kind: "howto", title: "run the tests", body: "bun test" });
  await K.remember(a, "x", { kind: "fact", title: "the box has 64 GB", body: "plenty", scope: "server" });
  await K.verify(a, "y", k.id);
  const md = await K.exportMarkdown(a);
  expect(md).toContain('## Team knowledge (Huddle channel "alpha")');
  expect(md.indexOf("### Lessons")).toBeLessThan(md.indexOf("### How-tos"));
  expect(md).toContain("- **never run migrations twice** (see `db/migrate.ts`)\n  line one\n  line two");
  expect(md).toContain("- **run the tests**: bun test");
  expect(md).toContain("- **the box has 64 GB**: plenty (every channel)");
  const v = await K.exportMarkdown(a, { verified: true });
  expect(v).toContain("never run migrations twice");
  expect(v).not.toContain("run the tests");
  expect(v).not.toContain("### How-tos");
});
