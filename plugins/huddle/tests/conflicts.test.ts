// tests/conflicts.test.ts — conflict warnings (plugin/server/src/touches.ts, plugin/bin/touch.ts):
// edits recorded as repo-relative paths; a session that edits a file another live session edited in
// the last 30 minutes hears it once per file per window; the panel lists both; nothing blocks.
import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Channel } from "../plugin/server/src/channel";
import { runOp } from "../plugin/server/src/ops";
import { touched, conflicts, WINDOW_MIN } from "../plugin/server/src/touches";
import { touchOf } from "../plugin/bin/touch";
import { freshChannel, cleanup } from "./db";

let ch: Channel;
beforeEach(async () => { ch = await freshChannel(); for (const n of ["payments", "cart", "docs"]) await ch.join(n); });
afterAll(cleanup);
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

test("the second session to edit a file hears who edited it, once per file per window; the first is not told", async () => {
  const first = await touched(ch, "payments", { repo: "/r/shop", path: "src/cart.ts" });
  expect(first.warn).toBeNull();
  const second = await touched(ch, "cart", { repo: "/r/shop", path: "src/cart.ts" });
  expect(second.warn).toMatch(/^Huddle: payments edited src\/cart\.ts (just now|\d+ min ago) — coordinate with it/);
  expect((await touched(ch, "cart", { repo: "/r/shop", path: "src/cart.ts" })).warn).toBeNull(); // once per window
  // a subagent's edit is its session's
  expect((await touched(ch, "cart.helper", { repo: "/r/shop", path: "src/cart.ts" })).warn).toBeNull();
  // the window passed for the warning: told again
  await ch.store.run("UPDATE touches SET warned_at=? WHERE session='cart'", [iso(Date.now() - (WINDOW_MIN + 1) * 60_000)]);
  expect((await touched(ch, "cart", { repo: "/r/shop", path: "src/cart.ts" })).warn).toMatch(/payments edited/);
  // the first session editing again now hears about the second
  expect((await touched(ch, "payments", { repo: "/r/shop", path: "src/cart.ts" })).warn).toMatch(/cart edited src\/cart\.ts/);
});

test("only the same repo, only live sessions, only within the window", async () => {
  await touched(ch, "payments", { repo: "/r/shop", path: "README.md" });
  expect((await touched(ch, "cart", { repo: "/r/other", path: "README.md" })).warn).toBeNull();
  await ch.leave("payments", "done");
  expect((await touched(ch, "docs", { repo: "/r/shop", path: "README.md" })).warn).toBeNull();
  await touched(ch, "cart", { repo: "/r/shop", path: "old.ts" });
  await ch.store.run("UPDATE touches SET at=? WHERE path='old.ts'", [iso(Date.now() - (WINDOW_MIN + 5) * 60_000)]);
  expect((await touched(ch, "docs", { repo: "/r/shop", path: "old.ts" })).warn).toBeNull();
});

test("the Conflicts panel lists every file two live sessions edited lately, with who and when", async () => {
  await touched(ch, "payments", { repo: "/r/shop", path: "src/cart.ts" });
  await touched(ch, "cart", { repo: "/r/shop", path: "src/cart.ts" });
  await touched(ch, "docs", { repo: "/r/shop", path: "docs/a.md" });
  const c = await conflicts(ch);
  expect(c.window_min).toBe(30);
  expect(c.conflicts).toHaveLength(1);
  expect(c.conflicts[0]).toMatchObject({ repo_name: "shop", path: "src/cart.ts" });
  expect(c.conflicts[0].sessions.map((s: any) => s.name).sort()).toEqual(["cart", "payments"]);
});

test("the touched op: the hook's text is the warning; bad paths are refused, contents never asked for", async () => {
  await runOp("touched", ch, "payments", { repo: "/r/shop", path: "a.ts" });
  expect((await runOp("touched", ch, "cart", { repo: "/r/shop", path: "a.ts" })).text).toMatch(/payments edited a\.ts/);
  for (const path of ["/etc/passwd", "../up.ts", "a/../../b"]) await expect(runOp("touched", ch, "cart", { repo: "/r/shop", path })).rejects.toThrow(/relative/);
  // not a tool: agents never see it
  const { toolDefs } = await import("../plugin/server/src/ops");
  expect(toolDefs().map(t => t.name)).not.toContain("touched");
});

test("touchOf: only edit tools; the path relative to the repo root; worktrees of one repo are one repo", () => {
  const top = realpathSync(mkdtempSync(`${tmpdir()}/huddle-touch-`));
  mkdirSync(`${top}/main/.git/worktrees/feat`, { recursive: true });
  mkdirSync(`${top}/main/src`, { recursive: true });
  mkdirSync(`${top}/feat/src`, { recursive: true });
  writeFileSync(`${top}/feat/.git`, `gitdir: ${top}/main/.git/worktrees/feat\n`);
  writeFileSync(`${top}/main/.git/worktrees/feat/commondir`, "../..\n");
  expect(touchOf({ tool_name: "Edit", tool_input: { file_path: `${top}/main/src/cart.ts`, old_string: "x", new_string: "y" } })).toEqual({ repo: `${top}/main`, path: "src/cart.ts" });
  expect(touchOf({ tool_name: "Write", tool_input: { file_path: `${top}/feat/src/cart.ts`, content: "secret" } })).toEqual({ repo: `${top}/main`, path: "src/cart.ts" });
  expect(touchOf({ tool_name: "NotebookEdit", tool_input: { notebook_path: `${top}/main/n.ipynb` } })).toEqual({ repo: `${top}/main`, path: "n.ipynb" });
  expect(touchOf({ tool_name: "Read", tool_input: { file_path: `${top}/main/src/cart.ts` } })).toBeNull();
  expect(touchOf({ tool_name: "Bash", tool_input: { command: "rm -rf /" } })).toBeNull();
  // no git: within the session's cwd, else nothing
  const plain = realpathSync(mkdtempSync(`${tmpdir()}/huddle-plain-`));
  expect(touchOf({ tool_name: "Edit", tool_input: { file_path: `${plain}/notes.md` }, cwd: plain })).toEqual({ repo: plain, path: "notes.md" });
  expect(touchOf({ tool_name: "Edit", tool_input: { file_path: "/somewhere/else.md" }, cwd: plain })).toBeNull();
});
