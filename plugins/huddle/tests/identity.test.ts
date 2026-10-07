import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const run = (cwd: string, env: Record<string, string> = {}) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HUDDLE_") && k !== "CLAUDE_PROJECT_DIR"));
  const r = Bun.spawnSync(["bun", "-e", `import { identity } from "${import.meta.dir}/../plugin/bin/identity.ts"; import { homeOf } from "${import.meta.dir}/../plugin/bin/identity.ts"; console.log(JSON.stringify({ ...identity(), home: homeOf() }))`], { cwd, env: { ...clean, ...env } as any });
  return JSON.parse(r.stdout.toString());
};

test("env wins; else the nearest .agents/huddle/huddle.json up from the cwd; else defaults", () => {
  const root = mkdtempSync(`${tmpdir()}/huddle-id-`);
  mkdirSync(`${root}/.agents/huddle`, { recursive: true }); mkdirSync(`${root}/a/b`, { recursive: true });
  writeFileSync(`${root}/.agents/.huddle.json`, JSON.stringify({ channel: "legacy", as: "old" })); // .agents/huddle/huddle.json wins over it
  writeFileSync(`${root}/.agents/huddle/huddle.json`, JSON.stringify({ channel: "shop", as: "api", role: "fixes", url: "http://127.0.0.1:9000/", push: ["ask", "task.ready"], wait: 600 }));
  const f = run(`${root}/a/b`);
  expect(f).toMatchObject({ channel: "shop", as: "api", role: "fixes", url: "http://127.0.0.1:9000", push: ["ask", "task.ready"], wait: 600, home: `${realpathSync(root)}/.agents/huddle` });
  expect(run(`${root}/a/b`, { HUDDLE_HOME: "/elsewhere" }).home).toBe("/elsewhere");
  const shared = mkdtempSync(`${tmpdir()}/huddle-shared-`);
  mkdirSync(`${shared}/.agents/huddle`, { recursive: true });
  writeFileSync(`${shared}/.agents/huddle/huddle.json`, JSON.stringify({ channel: "c", as: "x", home: "~/one/place" }));
  expect(run(shared).home).toBe(`${process.env.HOME}/one/place`); // a repo can share another's data
  const e = run(`${root}/a/b`, { HUDDLE_AS: "api.explore", HUDDLE_PUSH: "off", HUDDLE_WAIT: "60" });
  expect(e).toMatchObject({ channel: "shop", as: "api.explore", push: ["off"], wait: 60 });
  const blank = run(`${root}/a/b`, { HUDDLE_URL: "", HUDDLE_AS: "", HUDDLE_WAIT: "" });
  expect(blank).toMatchObject({ as: "api", url: "http://127.0.0.1:9000", wait: 600 }); // empty = unset
  const none = run(mkdtempSync(`${tmpdir()}/huddle-none-`));
  expect(none).toMatchObject({ channel: "", as: "", url: "", source: "none", wait: 1500 }); // no fixed port: none until huddle up picks one
}, 30_000); // spawns a cold `bun` per case

test("a git worktree outside its repo shares the main checkout's settings and files", () => {
  const base = mkdtempSync(`${tmpdir()}/huddle-wt-`);
  const repo = `${base}/repo`, wt = `${base}/elsewhere/wt`;
  mkdirSync(`${repo}/.agents/huddle`, { recursive: true });
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-q"); git("commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "x"); git("worktree", "add", "-q", wt);
  writeFileSync(`${repo}/.agents/huddle/huddle.json`, JSON.stringify({ channel: "shop", as: "shop" }));
  const shared = run(wt);
  expect(shared).toMatchObject({ channel: "shop", as: "shop" });
  expect(shared.home).toEndWith("/repo/.agents/huddle"); // the main checkout's data, not a copy per worktree
  mkdirSync(`${wt}/.agents`); writeFileSync(`${wt}/.agents/.huddle.json`, JSON.stringify({ channel: "other", as: "x" }));
  expect(run(wt)).toMatchObject({ channel: "other", as: "x" });
}, 30_000); // spawns a cold `bun` per step

test("the join context: HUDDLE_CONTEXT or the file's context wins; auto maps the SessionStart source", async () => {
  const { contextFor } = await import("../plugin/bin/identity");
  expect(["startup", "resume", "clear", "compact", undefined].map(s => contextFor(s, "auto"))).toEqual([undefined, "sync", "fresh", "fresh", undefined]);
  expect(contextFor("clear", "sync")).toBe("sync");
  expect(contextFor("resume", "fresh")).toBe("fresh");
  const root = mkdtempSync(`${tmpdir()}/huddle-ctx-`);
  mkdirSync(`${root}/.agents`);
  writeFileSync(`${root}/.agents/.huddle.json`, JSON.stringify({ channel: "shop", as: "api", context: "fresh" }));
  expect(run(root)).toMatchObject({ context: "fresh" });
  expect(run(root, { HUDDLE_CONTEXT: "sync" })).toMatchObject({ context: "sync" });
  expect(run(mkdtempSync(`${tmpdir()}/huddle-none-`))).toMatchObject({ context: "auto" });
}, 30_000);
