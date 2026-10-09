// tests/extras.test.ts — the owner's extras: approval rules (and the PreToolUse hook that applies
// them), desktop notifications for what needs the owner, the digest, and Radar's alerts and
// costs. Notifications land in HUDDLE_NOTIFY_LOG (tests/env.ts), never on the desktop; Radar
// is a fake one on a port of its own, found through RADAR_HOME, as the real one would be.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { H } from "./env";
import { startServer } from "./net";
import { freshChannel, cleanup } from "./db";
import { matching, effective, DEFAULTS } from "../plugin/server/src/rules";
import { Notifier, clean } from "../plugin/server/src/notify";
import { needsYou } from "../plugin/server/src/extras";
import { digest, digestText, parseSince } from "../plugin/server/src/digest";
import { resetCache } from "../plugin/server/src/radar";

const ROOT = `${import.meta.dir}/..`;
const LOG = process.env.HUDDLE_NOTIFY_LOG!;
const notes = (): any[] => existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
afterEach(cleanup);

// ── rules ────────────────────────────────────────────────────────────────────
test("approval rules: what each matches, and what it leaves alone", () => {
  const ids = (c: string) => matching(c).map(r => r.id).sort();
  expect(ids("git push --force origin main")).toEqual(["force_push", "git_push"]);
  expect(ids("git push -f")).toEqual(["force_push", "git_push"]);
  expect(ids("git push --force-with-lease")).toEqual(["force_push", "git_push"]);
  expect(ids("git push origin +main")).toEqual(["force_push", "git_push"]);
  expect(ids("cd repo && git -C x push origin main")).toEqual(["git_push"]);
  expect(ids("git push origin --delete old")).toEqual(["delete", "git_push"]);
  expect(ids("git push origin :old")).toEqual(["delete", "git_push"]);
  expect(ids("rm -rf build")).toEqual(["delete"]);
  expect(ids("ls && rm x.txt")).toEqual(["delete"]);
  expect(ids("git rm -r old/")).toEqual(["delete"]);
  expect(ids("git branch -D feature")).toEqual(["delete"]);
  expect(ids("git clean -fdx")).toEqual(["delete"]);
  expect(ids("find . -name '*.o' -delete")).toEqual(["delete"]);
  expect(ids("git tag v1.2.0")).toEqual(["git_tag"]);
  expect(ids("git tag -a v1 -m x")).toEqual(["git_tag"]);
  expect(ids("npm publish --access public")).toEqual(["publish"]);
  expect(ids("cargo publish")).toEqual(["publish"]);
  expect(ids("python -m twine upload dist/*")).toEqual(["publish"]);
  expect(ids("docker push me/app:1")).toEqual(["publish"]);
  expect(ids("gh release create v1")).toEqual(["publish"]);
  for (const c of ["git status", "git log --oneline", "git tag", "git tag -l", "git tag --list 'v*'", "npm run build", "echo pushing", "git branch -a",
    "npm run rm-dist", "ls -la", "bun test", "cat README.md", "", "git push-helper"]) expect(matching(c), c).toEqual([]);
  expect(DEFAULTS).toEqual({ force_push: true, delete: true, git_push: false, git_tag: false, publish: false });
  expect(effective({ git_push: true, bogus: true, delete: "no" })).toEqual({ ...DEFAULTS, git_push: true });
});

// ── the notifier ─────────────────────────────────────────────────────────────
test("the notifier: once per kind and subject in the window, off when switched off, no secrets in the text", () => {
  const dir = mkdtempSync(`${tmpdir()}/huddle-n-`), log = `${dir}/log`, was = process.env.HUDDLE_NOTIFY_LOG;
  process.env.HUDDLE_NOTIFY_LOG = log;
  try {
    const n = new Notifier(dir);
    expect(n.enabled()).toBe(true); // on by default, no settings file
    expect(n.send("ask", "c/a", "Huddle · c", "a asks you a question")).toBe(true);
    expect(n.send("ask", "c/a", "Huddle · c", "a asks you a question")).toBe(false); // same kind+subject: rate-limited
    expect(n.send("ask", "c/b", "Huddle · c", "b asks you a question")).toBe(true);
    expect(n.send("pause", "c/a", "Huddle · c", "a was paused")).toBe(true);
    n.set(false);
    expect(JSON.parse(readFileSync(`${dir}/settings.json`, "utf8")).notify).toBe(false);
    expect(n.send("blocked", "c/t1", "Huddle · c", "t1 blocked")).toBe(false);
    expect(new Notifier(dir).enabled()).toBe(false); // the switch is the file: another process reads it
    n.set(true);
    expect(n.send("blocked", "c/t1", "Huddle · c", "t1 blocked")).toBe(true);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(4);
    const secret = "ghp_" + "A".repeat(36), long = "x".repeat(50);
    const c = clean(`token=abc123 ${secret} key: hunter2 ${long} ok\u0007bell`);
    expect(c).not.toContain("abc123"); expect(c).not.toContain(secret); expect(c).not.toContain("hunter2"); expect(c).not.toContain(long); expect(c).not.toContain("\u0007");
    expect(clean("y".repeat(500)).length).toBeLessThanOrEqual(140);
  } finally { process.env.HUDDLE_NOTIFY_LOG = was; }
});

test("what notifies: a question to the owner, a pause by someone else, an approval request, a blocked task; never the owner's own moves", () => {
  const ev = (o: any) => ({ seq: 1, ts: "", from: "api", to: null, topic: "msg", ref: null, msg: "SECRET body", data: null, reply_to: null, needs_reply: false, ...o });
  expect(needsYou(ev({ topic: "ask", needs_reply: true, to: "owner" }), "shop")).toMatchObject({ kind: "ask", subject: "shop/api", body: "api asks you a question" });
  expect(needsYou(ev({ topic: "ask", needs_reply: true }), "shop")?.kind).toBe("ask");          // to everyone: the owner too
  expect(needsYou(ev({ topic: "ask", needs_reply: true, to: "web" }), "shop")).toBeNull();      // to another session
  expect(needsYou(ev({ topic: "control.pause", to: "web" }), "shop")).toMatchObject({ kind: "pause", body: "web was paused by api" });
  expect(needsYou(ev({ topic: "control.pause", to: "web", from: "owner" }), "shop")).toBeNull();
  expect(needsYou(ev({ topic: "approval.request", to: "owner", data: { rules: ["force_push"], labels: ["Force push"] } }), "shop")).toMatchObject({ kind: "approval", body: expect.stringContaining("Force push") });
  expect(needsYou(ev({ topic: "task.status", ref: "t1", data: { status: "blocked", note: "SECRET" } }), "shop")).toMatchObject({ kind: "blocked", body: "Task t1 is blocked (api)" });
  expect(needsYou(ev({ topic: "task.status", ref: "t1", data: { status: "done" } }), "shop")).toBeNull();
  expect(needsYou(ev({ topic: "msg", to: "owner" }), "shop")).toBeNull();
  for (const t of ["ask", "control.pause", "approval.request", "task.status"]) expect(JSON.stringify(needsYou(ev({ topic: t, needs_reply: t === "ask", to: "x", data: { status: "blocked" } }), "c") ?? "")).not.toContain("SECRET");
});

// ── the digest ───────────────────────────────────────────────────────────────
test("the digest: per session what got done, notes, knowledge, approvals; blocked now; open questions", async () => {
  const ch = await freshChannel("dg");
  for (const n of ["api", "web"]) await ch.join(n, { role: n });
  await ch.join("api.explore");
  await ch.createTask("api", { id: "t1", title: "Ship the API" });
  await ch.createTask("api", { id: "t2", title: "Client", owner: "web" });
  await ch.setStatus("api", "t1", "done", "40 tests green");
  await ch.setStatus("web", "t2", "blocked", "needs the schema");
  await ch.remember("api.explore", { kind: "fact", title: "orders schema", body: "orders(id, total)" });
  await ch.note("web", "t1", "question", "is it paginated?");
  await ch.send("web", "owner", "may I drop the old table?", { ask: true });
  await ch.append("api", { topic: "approval.request", to: "owner", msg: "api asks permission: Force push", data: { rules: ["force_push"], labels: ["Force push"] } });
  const d = await digest(ch, "24h", { cost: false });
  expect(d.totals).toMatchObject({ done: 1, knowledge: 1, notes: 1, blocked: 1, questions: 1, approvals: 1 });
  const api = d.sessions.find(s => s.name === "api")!, web = d.sessions.find(s => s.name === "web")!;
  expect(api.done.map(x => x.id)).toEqual(["t1"]);
  expect(api.knowledge[0]).toMatchObject({ kind: "fact", title: "orders schema" }); // a subagent's work counts for its parent
  expect(api.approvals[0].labels).toEqual(["Force push"]);
  expect(web.notes[0]).toMatchObject({ task: "t1", kind: "question" });
  expect(web.asked).toBe(1);
  expect(d.blocked[0]).toMatchObject({ id: "t2", owner: "web", note: "needs the schema" });
  expect(d.questions[0]).toMatchObject({ from: "web", to: "owner" });
  expect(d.cost.available).toBe(false);
  const txt = digestText(d);
  for (const s of ["done t1 Ship the API", "kb #1 [fact] orders schema", "blocked now:", "t2 Client @web", "open questions:", "asked permission 1×: Force push"]) expect(txt).toContain(s);
  // a window that starts after everything: nothing finished, the present still shown
  const later = await digest(ch, new Date(Date.now() + 60_000).toISOString(), { cost: false });
  expect(later.totals.done).toBe(0); expect(later.blocked).toHaveLength(1);
  expect(parseSince("2h", 10_000_000)).toBe(10_000_000 - 7_200_000);
  expect(() => parseSince("yesterday-ish")).toThrow();
});

// ── against the server ───────────────────────────────────────────────────────
let srv: { p: Subprocess; u: string }, U = "";
let obs: ReturnType<typeof Bun.serve> | null = null;
const OBS = process.env.RADAR_HOME!;
const post = (path: string, body: unknown, as = "owner") => fetch(`${U}${path}${path.includes("?") ? "&" : "?"}as=${as}`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string) => fetch(`${U}${path}`, { headers: H }).then(r => r.json()) as Promise<any>;
const op = (o: string, as: string, body: unknown = {}) => post(`/api/c/shop/op/${o}`, body, as).then(r => r.json()) as Promise<any>;
const until = async <T>(f: () => T, ms = 3000) => { for (const t = Date.now(); Date.now() - t < ms; await Bun.sleep(25)) { const v = f(); if (v) return v; } return f(); };

beforeAll(async () => {
  srv = await startServer({ HUDDLE_DATA: mkdtempSync(`${tmpdir()}/huddle-x-`), HUDDLE_NOTIFY_WINDOW_MS: "600000" });
  U = srv.u;
  for (const n of ["api", "web"]) await op("join", n, { role: n, claude_session: `claude-${n}` });
});
afterAll(() => { srv?.p.kill(); obs?.stop(true); });

test("rules per channel: defaults, the owner switches them, a session may not", async () => {
  let r = await get("/api/c/shop/x/rules");
  expect(Object.fromEntries(r.rules.map((x: any) => [x.id, x.on]))).toEqual(DEFAULTS);
  expect(r.rules.find((x: any) => x.id === "force_push")).toMatchObject({ label: "Force push", default: true });
  expect((await post("/api/c/shop/x/rules", { rules: { git_push: true } }, "api")).status).toBe(403);
  expect((await post("/api/c/shop/x/rules", { rules: { nope: true } })).status).toBe(400);
  r = await (await post("/api/c/shop/x/rules", { rules: { git_push: true } })).json();
  expect(r.rules.find((x: any) => x.id === "git_push").on).toBe(true);
  await post("/api/c/shop/x/rules", { rules: { git_push: false } });
});

test("an approval request: ask with a short reason, an event for the owner, a notification; the command is kept nowhere", async () => {
  const before = notes().length;
  const cmd = "git push --force origin main # token=s3cr3t-value";
  let r = await (await post("/api/c/shop/x/approval", { command: cmd, claude_session: "claude-api" }, "api")).json();
  expect(r).toMatchObject({ ask: true, rules: ["force_push"], labels: ["Force push"] });
  expect(r.reason).toContain("Huddle"); expect(r.reason).not.toContain("s3cr3t");
  r = await (await post("/api/c/shop/x/approval", { command: "git push origin main" }, "api")).json();
  expect(r.ask).toBe(false); // git push is off by default
  expect((await post("/api/c/shop/x/approval", { command: "rm -rf /" }, "ghost")).status).toBe(404);
  const ev = (await get("/api/c/shop/timeline?topic=approval.request")).at(-1);
  expect(ev).toMatchObject({ from: "api", to: "owner", topic: "approval.request" });
  const tl = JSON.stringify(await get("/api/c/shop/timeline?limit=2000"));
  expect(tl).not.toContain("s3cr3t"); expect(tl).not.toContain("--force origin");
  const n = await until(() => notes().slice(before).find(x => x.kind === "approval"));
  expect(n).toMatchObject({ title: "Huddle · shop", body: "api asks permission: Force push. Answer in its Claude Code window." });
  expect(readFileSync(LOG, "utf8")).not.toContain("s3cr3t");
  // the Inbox lists it until the owner dismisses it
  let a = await get("/api/c/shop/x/approvals");
  expect(a.approvals[0]).toMatchObject({ from: "api", labels: ["Force push"] });
  expect((await post("/api/c/shop/x/approvals/dismiss", { seq: a.approvals[0].seq }, "api")).status).toBe(403);
  a = await (await post("/api/c/shop/x/approvals/dismiss", { seq: a.approvals[0].seq })).json();
  expect(a.approvals).toHaveLength(0);
  await post("/api/c/shop/x/approval", { command: "rm x" }, "web");
  expect((await get("/api/c/shop/x/approvals")).approvals).toHaveLength(1);
  await post("/api/c/shop/x/approvals/dismiss", { all: true });
  expect((await get("/api/c/shop/x/approvals")).approvals).toHaveLength(0);
});

test("the server notifies what needs the owner as it happens, once per subject per window, never the owner's own moves", async () => {
  const before = notes().length;
  const fresh = () => notes().slice(before);
  await op("send", "web", { to: "owner", msg: "may I deploy? password=hunter2", ask: true });
  await op("send", "web", { to: "owner", msg: "and now?", ask: true }); // same session, same window: once
  await op("pause", "web", { target: "api", why: "wait" });
  await op("resume", "owner", { target: "api" });
  await op("pause", "owner", { target: "web" }); await op("resume", "owner", { target: "web" }); // the owner's own: nothing
  await op("task_create", "api", { id: "b1", title: "Migrate" });
  await op("task_status", "api", { id: "b1", status: "blocked", note: "disk full" });
  const got = await until(() => fresh().length >= 3 ? fresh() : null);
  await Bun.sleep(200);
  expect(fresh().map(x => x.kind).sort()).toEqual(["ask", "blocked", "pause"]);
  expect(fresh().find(x => x.kind === "ask").body).toBe("web asks you a question");
  expect(fresh().find(x => x.kind === "pause").body).toBe("api was paused by web");
  expect(fresh().find(x => x.kind === "blocked").body).toBe("Task b1 is blocked (api)");
  expect(JSON.stringify(got)).not.toContain("hunter2");
  // the switch: off in the dashboard (the owner only), nothing shows; on again
  expect((await post("/api/settings", { notify: false }, "")).status).toBe(200);
  expect((await get("/api/settings")).notify).toBe(false);
  const n0 = notes().length;
  await op("task_create", "api", { id: "b2", title: "Other" });
  await op("task_status", "api", { id: "b2", status: "blocked" });
  await Bun.sleep(150);
  expect(notes().length).toBe(n0);
  await post("/api/settings", { notify: true }, "");
  expect((await get("/api/settings")).notify).toBe(true);
});

test("the digest over HTTP, the MCP tool and the CLI", async () => {
  const r = await get("/api/c/shop/x/digest?since=1h");
  expect(r.totals.approvals).toBeGreaterThanOrEqual(2);
  expect(r.sessions.map((s: any) => s.name)).toContain("api");
  const mcp = await (await fetch(`${U}/mcp/shop?as=api`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "digest", arguments: { since: "2h" } } }) })).json() as any;
  expect(mcp.result.content[0].text).toContain("digest: shop · since");
  const cli = Bun.spawnSync(["bun", `${ROOT}/plugin/bin/huddle.ts`, "digest", "--since", "24h"], { env: { ...process.env, HUDDLE_URL: U, HUDDLE_CHANNEL: "shop", HUDDLE_AS: "web" } });
  expect(cli.exitCode).toBe(0);
  expect(cli.stdout.toString()).toContain("blocked now:");
  expect((await fetch(`${U}/api/c/shop/x/digest?since=bogus`, { headers: H })).status).toBe(400);
});

test("Radar absent: its parts are simply missing, no error", async () => {
  rmSync(join(OBS, "port"), { force: true }); resetCache();
  expect(await get("/api/c/shop/x/radar")).toEqual({ available: false });
  expect((await get("/api/c/shop/x/digest")).cost.available).toBe(false);
});

test("Radar running: its alerts for this channel's sessions, the cost per session, in the digest too", async () => {
  obs = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => {
    const u = new URL(req.url);
    if (req.headers.get("host") !== `127.0.0.1:${obs!.port}`) return new Response("forbidden host", { status: 403 });
    if (u.pathname === "/api/alerts") return Response.json({ alerts: [
      { id: "a1", kind: "loop", sessionId: "claude-api", agentId: null, project: "shop", since: Date.now() - 60_000, detail: "same tool call 12 times", costUsd: 0.4 },
      { id: "a2", kind: "stuck", sessionId: "claude-elsewhere", agentId: null, project: "other", since: Date.now(), detail: "not ours", costUsd: null }] });
    if (u.pathname === "/api/attribution") return Response.json({ rows: [
      { key: "claude-api", label: "api", requests: 10, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 1.25 },
      { key: "claude-web", label: "web", requests: 3, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.5 },
      { key: "claude-elsewhere", label: "x", requests: 3, tokens: {}, costUsd: 9 }] });
    return new Response("not found", { status: 404 });
  } });
  writeFileSync(join(OBS, "port"), `${obs.port}\n`);
  // nothing was cached while Radar was absent (no port, no request): the server asks it now
  const o = await get("/api/c/shop/x/radar");
  expect(o).toMatchObject({ available: true, cost: { api: 1.25, web: 0.5 }, total: 1.75 });
  expect(o.alerts).toEqual([expect.objectContaining({ id: "a1", kind: "loop", session: "api" })]);
  const d = await get("/api/c/shop/x/digest?since=24h");
  expect(d.cost).toMatchObject({ available: true, total: 1.75, range: "day" });
  expect(d.sessions.find((s: any) => s.name === "api").cost).toBe(1.25);
}, 15_000);

// ── the PreToolUse hook ──────────────────────────────────────────────────────
const hook = async (input: unknown, env: Record<string, string> = {}) => {
  const world = mkdtempSync(`${tmpdir()}/huddle-approve-`);
  const t0 = performance.now();
  const p = Bun.spawn(["bun", `${ROOT}/plugin/dist/approve.js`], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: world, HUDDLE_HOME: world, HUDDLE_CHANNEL: "", HUDDLE_AS: "", HUDDLE_URL: "", ...env },
    cwd: world, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  return { code: await p.exited, out, ms: performance.now() - t0 };
};
const bash = (command: string, session_id = "claude-api") => ({ session_id, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

test("the approval hook: a joined session and a rule that is on → Claude Code's native ask, under a second", async () => {
  const r = await hook(bash("git push --force origin main"), { HUDDLE_URL: U, HUDDLE_CHANNEL: "shop", HUDDLE_AS: "api" });
  expect(r.code).toBe(0);
  expect(r.ms).toBeLessThan(1000);
  const j = JSON.parse(r.out);
  expect(j).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: expect.stringContaining("force push") } });
  expect(j.decision).toBeUndefined(); // never a block, never a deny
});

test("the approval hook is silent: rule off, no rule matches, not in a huddle, not joined, Huddle down or mute — all under a second", async () => {
  const mute = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: () => new Promise<Response>(() => {}) });
  const cases: [string, unknown, Record<string, string>][] = [
    ["rule off", bash("git push origin main"), { HUDDLE_URL: U, HUDDLE_CHANNEL: "shop", HUDDLE_AS: "api" }],
    ["no rule matches", bash("git status"), { HUDDLE_URL: U, HUDDLE_CHANNEL: "shop", HUDDLE_AS: "api" }],
    ["another tool", { tool_name: "Read", tool_input: { file_path: "/x" } }, { HUDDLE_URL: U, HUDDLE_CHANNEL: "shop", HUDDLE_AS: "api" }],
    ["not in a huddle", bash("rm -rf build"), {}],
    ["not joined (no credential)", bash("rm -rf build"), { HUDDLE_URL: U, HUDDLE_CHANNEL: "shop", HUDDLE_AS: "api", HUDDLE_TOKEN: "", XDG_STATE_HOME: mkdtempSync(`${tmpdir()}/huddle-nocred-`) }],
    ["a session that never joined", bash("rm -rf build"), { HUDDLE_URL: U, HUDDLE_CHANNEL: "shop", HUDDLE_AS: "stranger" }],
    ["Huddle down", bash("rm -rf build"), { HUDDLE_URL: "http://127.0.0.1:1", HUDDLE_CHANNEL: "shop", HUDDLE_AS: "api" }],
    ["Huddle mute", bash("rm -rf build"), { HUDDLE_URL: `http://127.0.0.1:${mute.port}`, HUDDLE_CHANNEL: "shop", HUDDLE_AS: "api" }],
    ["garbage on stdin", "not json", { HUDDLE_URL: U, HUDDLE_CHANNEL: "shop", HUDDLE_AS: "api" }],
  ];
  try {
    for (const [why, input, env] of cases) {
      const r = await hook(input, env);
      expect(r.code, why).toBe(0);
      expect(r.out.trim(), why).toBe("");
      expect(r.ms, why).toBeLessThan(1000);
    }
  } finally { mute.stop(true); }
}, 30_000);
