import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { freshChannel, cleanup } from "./db";
import { repoTools } from "../plugin/server/src/ext/repo";
import { viewNames, repoRoute, exportMd } from "../plugin/server/src/ext/views";

const tmp = () => mkdtempSync(`${tmpdir()}/huddle-views-`);
afterAll(cleanup);

test("repo views appear only for a channel with a reachable repo", async () => {
  const ch = await freshChannel("v");
  expect(viewNames(ch)).toEqual([]);
  expect(await repoRoute(ch, "code", new URL("http://x/?path=a"))).toMatchObject({ error: "this channel has no repo configured" });
  const repo = tmp(); writeFileSync(`${repo}/a.txt`, "line one\nline two\n");
  await ch.configure({ repo });
  expect(viewNames(ch)).toEqual(expect.arrayContaining(["code", "drift", "diagrams"]));
  expect(await repoRoute(ch, "code", new URL("http://x/?path=a.txt"))).toMatchObject({ path: "a.txt", total: 3 });
  expect(await repoRoute(ch, "nope", new URL("http://x/"))).toMatchObject({ error: "no repo view nope" });
});

test("safe() stays inside the repo and never serves secrets", () => {
  const base = tmp(), repo = `${base}/repo`;
  mkdirSync(`${repo}/secrets`, { recursive: true }); writeFileSync(`${repo}/secrets/k`, "x");
  mkdirSync(`${base}/repo-other`); writeFileSync(`${base}/repo-other/f`, "x");
  symlinkSync(`${base}/repo-other`, `${repo}/link`);
  const R = repoTools(repo)!;
  expect(R.safe("secrets/k")).toBeNull();
  expect(R.safe("../repo-other/f")).toBeNull();
  expect(R.safe("link/f")).toBeNull(); // a sibling with the repo's name as prefix
  writeFileSync(`${repo}/ok`, "x");
  expect(R.safe("ok")).toBe(`${repo}/ok`);
});

test("exportMd lists tasks outside any phase", async () => {
  const ch = await freshChannel("e");
  await ch.createTask("owner", { id: "t1", title: "Loose task", body: { what: "do it" } });
  const md = await exportMd(ch);
  expect(md).toContain("## Tasks");
  expect(md).toContain("### t1 Loose task");
});
