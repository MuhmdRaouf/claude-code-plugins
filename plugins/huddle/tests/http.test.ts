// Integration: the real server on a spare port with a throwaway data dir, driven over HTTP, MCP
// and the stdio bridge.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";
import { H } from "./env";

import { freePort, startServer, until } from "./net";
let PORT = 0, U = "";
const ROOT = `${import.meta.dir}/..`;
let srv: Subprocess;

beforeAll(async () => {
  const s = await startServer({ HUDDLE_DATA: mkdtempSync(`${tmpdir()}/huddle-http-`) });
  srv = s.p; PORT = s.port; U = s.u;
}, 40_000);
afterAll(async () => { srv.kill(); await srv.exited; }, 20_000);

const op = async (ch: string, name: string, as: string, body: unknown = {}, signal?: AbortSignal) => {
  const r = await fetch(`${U}/api/c/${ch}/op/${name}?as=${as}`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body), signal });
  return { status: r.status, ...(await r.json() as any) };
};
const rpc = async (ch: string, as: string, method: string, params: unknown = {}, id = 1) =>
  (await fetch(`${U}/mcp/${ch}?as=${as}`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json() as any;

test("/health reports the plugin's version", async () => {
  const want = (await Bun.file(`${ROOT}/plugin/.claude-plugin/plugin.json`).json()).version;
  expect(want).toMatch(/^\d+\.\d+\.\d+$/);
  expect((await (await fetch(`${U}/health`)).json() as any).version).toBe(want);
});

test("guard: wrong Host 421, form post 415, foreign Origin 403", async () => {
  expect((await fetch(`${U}/health`, { headers: { host: "evil.example:80" } })).status).toBe(421);
  expect((await fetch(`${U}/health`, { headers: { host: `localhost:${PORT}` } })).status).toBe(200);
  expect((await fetch(`${U}/health`, { headers: { host: "localhost:1" } })).status).toBe(421); // only for our port
  expect((await fetch(`${U}/api/c/g/op/join?as=a`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
  expect((await fetch(`${U}/api/c/g/op/join?as=a`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
});

test("guard: HUDDLE_HOSTS adds hosts; loopback for the port always passes", async () => {
  const { p: s2, port, u } = await startServer({ HUDDLE_DATA: mkdtempSync(`${tmpdir()}/huddle-h-`), HUDDLE_HOSTS: "huddle.test" }, { stderr: "ignore" });
  try {
    expect((await fetch(`${u}/health`)).status).toBe(200);
    expect((await fetch(`${u}/health`, { headers: { host: `localhost:${port}` } })).status).toBe(200);
    expect((await fetch(`${u}/health`, { headers: { host: "huddle.test" } })).status).toBe(200);
    expect((await fetch(`${u}/health`, { headers: { host: "evil.example" } })).status).toBe(421);
  } finally { s2.kill(); }
}, 40_000);

test("join creates the channel; ops need an identity; unknown channel 404 for reads", async () => {
  expect((await op("c1", "join", "alpha", { role: "builds" })).result.me).toBe("alpha");
  expect((await fetch(`${U}/api/c/c1/op/status`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: "{}" })).status).toBe(400);
  expect((await fetch(`${U}/api/c/nope/board`, { headers: H })).status).toBe(404);
  const list = await (await fetch(`${U}/api/channels`, { headers: H })).json() as any[];
  expect(list.map(c => c.name)).toContain("c1");
});

test("a long-poll wait is woken by another client's publish in milliseconds", async () => {
  await op("c2", "join", "a"); await op("c2", "join", "b");
  await op("c2", "ack", "b", { seq: 1000 });
  const t0 = Date.now();
  const w = op("c2", "wait", "b", { topics: ["go.*"], timeout: 10 });
  await Bun.sleep(50);
  await op("c2", "publish", "a", { topic: "go.now", msg: "x" });
  const r = await w;
  expect(r.result.kind).toBe("event"); expect(r.result.topic).toBe("go.now");
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("a client that drops its wait frees the waiter (no leak, no stale wake)", async () => {
  await op("c3", "join", "a"); await op("c3", "join", "b");
  const ac = new AbortController();
  const p = op("c3", "wait", "b", { topics: ["never"], timeout: 30 }, ac.signal).catch(e => e.name);
  await Bun.sleep(50); ac.abort();
  expect(await p).toBe("AbortError");
  await Bun.sleep(50);
  const s = (await (await fetch(`${U}/api/c/c3/sessions`, { headers: H })).json() as any).sessions.find((x: any) => x.name === "b");
  expect(s.state).not.toBe("waiting");
});

test("MCP: initialize, tools/list, tools/call, errors as tool results", async () => {
  const init = await rpc("c4", "alpha", "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  expect(init.result.serverInfo.name).toBe("huddle");
  expect(init.result.capabilities.experimental["claude/channel"]).toBeDefined();
  const tools = (await rpc("c4", "alpha", "tools/list")).result.tools.map((t: any) => t.name);
  for (const t of ["join", "wait", "gate", "task_create", "remember", "recall", "pause", "pass"]) expect(tools).toContain(t);
  const j = await rpc("c4", "alpha", "tools/call", { name: "join", arguments: { role: "r" } });
  expect(j.result.content[0].text).toMatch(/channel c4 · you are alpha/);
  const bad = await rpc("c4", "alpha", "tools/call", { name: "reply", arguments: { seq: 999, msg: "x" } });
  expect(bad.result.isError).toBe(true);
  const unknown = await rpc("c4", "alpha", "tools/call", { name: "nope", arguments: {} });
  expect(unknown.error.code).toBe(-32602);
});

test("SSE with ?as= carries everyone else's events, also those addressed to another session", async () => {
  await op("c5", "join", "a"); await op("c5", "join", "b"); await op("c5", "join", "c");
  const ac = new AbortController();
  const res = await fetch(`${U}/api/c/c5/live?as=b`, { headers: H, signal: ac.signal });
  const got: any[] = [];
  const reader = (async () => { let buf = ""; for await (const ch of res.body as any) { buf += new TextDecoder().decode(ch); for (const f of buf.split("\n\n").slice(0, -1)) { const l = f.split("\n").find(x => x.startsWith("data: ")); if (l) got.push(JSON.parse(l.slice(6))); } buf = buf.slice(buf.lastIndexOf("\n\n") + 2); } })().catch(() => {});
  await Bun.sleep(100);
  await op("c5", "send", "a", { to: "c", msg: "private to c" });
  await op("c5", "send", "a", { to: "b", msg: "for b" });
  await op("c5", "publish", "b", { topic: "mine.x", msg: "own" });
  await Bun.sleep(150); ac.abort(); await reader;
  const msgs = got.filter(m => m.type === "event").map(m => m.data.msg);
  expect(msgs).toEqual(["private to c", "for b"]);
});

// a bridge on channel ch as b; collects every JSON-RPC line it writes
const bridge = (ch: string, env: Record<string, string> = {}) => {
  const p = Bun.spawn(["bun", `${ROOT}/plugin/bin/huddle-mcp.ts`], { env: { ...process.env, HUDDLE_URL: U, HUDDLE_CHANNEL: ch, HUDDLE_AS: "b", ...env }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const lines: any[] = [];
  (async () => { let buf = ""; for await (const c of p.stdout as any) { buf += new TextDecoder().decode(c); let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } } })();
  const send = (m: unknown) => { p.stdin.write(JSON.stringify(m) + "\n"); p.stdin.flush(); };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  // poll instead of sleeping a fixed time: a cold `bun` start can take longer than any guess
  const until = async (f: () => unknown, ms = 4000) => { for (const t = Date.now(); Date.now() - t < ms; await Bun.sleep(25)) { const v = f(); if (v) return v; } return undefined; };
  const pushes = () => lines.filter(l => l.method === "notifications/claude/channel");
  return { p, lines, send, until, pushes };
};

test("stdio bridge: proxies tools and pushes an ask as a claude/channel notification", async () => {
  await op("c6", "join", "a"); await op("c6", "join", "b");
  const B = bridge("c6");
  B.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } });
  expect((await B.until(() => B.lines.find(l => l.id === 1)) as any)?.result.serverInfo.name).toBe("huddle");
  expect((await B.until(() => B.lines.find(l => l.id === 2)) as any)?.result.content[0].text).toMatch(/you are b/);
  await op("c6", "send", "a", { to: "b", msg: "are you there?", ask: true });
  const push = await B.until(() => B.pushes().find(l => /are you there\?/.test(l.params.content))) as any;
  B.p.kill();
  expect(push?.params.meta.topic).toBe("ask");
});

test("stdio bridge: an ask sent before the bridge connects is pushed on connect, once", async () => {
  await op("c8", "join", "a"); await op("c8", "join", "b");
  await op("c8", "send", "a", { to: "b", msg: "asked while you were away", ask: true });
  const B = bridge("c8");
  const push = await B.until(() => B.pushes().find(l => /while you were away/.test(l.params.content))) as any;
  await op("c8", "send", "a", { to: "b", msg: "and one more", ask: true });
  await B.until(() => B.pushes().find(l => /one more/.test(l.params.content)));
  B.p.kill();
  expect(push?.params.meta.topic).toBe("ask");
  expect(B.pushes().filter(l => /while you were away/.test(l.params.content))).toHaveLength(1);
});

test("CLI: join, wait exit 3 on an ask, reply, gate exit 4 when paused", async () => {
  const env = { ...process.env, HUDDLE_URL: U, HUDDLE_CHANNEL: "c7" };
  const cli = (as: string, ...a: string[]) => Bun.spawnSync(["bun", `${ROOT}/plugin/bin/huddle.ts`, ...a], { env: { ...env, HUDDLE_AS: as } });
  expect(cli("a", "join", "--role", "x").exitCode).toBe(0);
  expect(cli("b", "join").exitCode).toBe(0);
  cli("a", "send", "b", "ping?", "--ask");
  const w = cli("b", "wait", "nothing.*", "--timeout", "2");
  expect(w.exitCode).toBe(3);
  const seq = JSON.parse(w.stdout.toString()).seq;
  expect(cli("b", "reply", String(seq), "pong").exitCode).toBe(0);
  expect(cli("b", "wait", "nothing.*", "--timeout", "1").exitCode).toBe(124);
  cli("a", "pause", "b", "hold");
  expect(cli("b", "gate", "--no-block").exitCode).toBe(4);
  expect(cli("b", "pub", "x.y", "ref", "msg").exitCode).toBe(4);
}, 30_000); // spawns a cold `bun` per step

test("SessionStart hook: resume joins sync, clear and compact join fresh, startup leaves it to the server", async () => {
  await op("c9", "join", "a");
  const hook = async (source: string, env: Record<string, string> = {}) => {
    const p = Bun.spawn(["bun", `${ROOT}/plugin/hooks/session-start.ts`], { env: { ...process.env, HUDDLE_URL: U, HUDDLE_CHANNEL: "c9", HUDDLE_AS: "h", HUDDLE_CONTEXT: "", ...env }, stdin: new Blob([JSON.stringify({ hook_event_name: "SessionStart", source })]), stdout: "pipe", stderr: "ignore" });
    const out = JSON.parse(await new Response(p.stdout).text()).hookSpecificOutput.additionalContext as string;
    return /context: (\w+)/.exec(out)?.[1];
  };
  expect(await hook("startup")).toBe("fresh"); // a first join: the server's default
  expect(await hook("resume")).toBe("sync");
  expect(await hook("clear")).toBe("fresh");
  expect(await hook("compact")).toBe("fresh");
  expect(await hook("startup")).toBe("sync");  // a return: the server's default
  expect(await hook("clear", { HUDDLE_CONTEXT: "sync" })).toBe("sync");
}, 40_000);

test("huddle up, server and down run the bundled server from HUDDLE_HOME, and leave a foreign one alone", async () => {
  const port = await freePort(), home = mkdtempSync(`${tmpdir()}/huddle-home-`);
  const env = { ...process.env, HUDDLE_HOME: home, HUDDLE_DATA: "", HUDDLE_URL: `http://127.0.0.1:${port}`, HUDDLE_CHANNEL: "up", HUDDLE_AS: "a" };
  const cli = (...a: string[]) => { const r = Bun.spawnSync(["bun", `${ROOT}/plugin/bin/huddle.ts`, ...a], { env }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  try {
    expect(cli("server")).toMatchObject({ code: 5, out: expect.stringContaining("down") });
    expect(cli("up")).toMatchObject({ code: 0, out: expect.stringContaining("started") });
    expect(cli("up")).toMatchObject({ code: 0, out: expect.stringContaining("is up") });
    expect(cli("join").code).toBe(0);
    expect(cli("server").out).toContain("started by huddle up");
    expect(await Bun.file(`${home}/data/channels/up.db`).exists()).toBe(true);
    expect(cli("down")).toMatchObject({ code: 0, out: expect.stringContaining("stopped") });
    expect(cli("down")).toMatchObject({ code: 0, out: expect.stringContaining("not running") });
    // a pid file left behind for some other process: never signalled
    await Bun.write(`${home}/huddle.pid`, String(process.pid));
    expect(cli("down").out).toContain("not running");
    // a server huddle up did not start is not stopped
    expect(Bun.spawnSync(["bun", `${ROOT}/plugin/bin/huddle.ts`, "down"], { env: { ...env, HUDDLE_URL: U } })).toMatchObject({ exitCode: 2 });
    expect(Bun.spawnSync(["bun", `${ROOT}/plugin/bin/huddle.ts`, "up"], { env: { ...env, HUDDLE_URL: "http://10.255.255.1:41234" } }).exitCode).toBe(5);
  } finally { cli("down"); }
}, 40_000);

test("huddle setup: everything in the project's .agents/huddle, kept out of git; a .agents/.huddle.json is folded in", async () => {
  const port = await freePort(), proj = mkdtempSync(`${tmpdir()}/huddle-proj-`);
  Bun.spawnSync(["git", "init", "-q"], { cwd: proj });
  mkdirSync(`${proj}/.agents`); writeFileSync(`${proj}/.agents/.huddle.json`, JSON.stringify({ channel: "old", as: "alpha", role: "kept" }));
  const env = { ...process.env, HUDDLE_HOME: "", HUDDLE_DATA: "", HUDDLE_URL: `http://127.0.0.1:${port}`, HUDDLE_CHANNEL: "", HUDDLE_AS: "", CLAUDE_PROJECT_DIR: proj };
  const cli = (...a: string[]) => { const r = Bun.spawnSync(["bun", `${ROOT}/plugin/bin/huddle.ts`, ...a], { env, cwd: proj }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  try {
    const r = cli("setup", "--channel", "s1", "--as", "alpha", "--autostart", "--start");
    expect(r.code).toBe(0); expect(r.out).toContain("started");
    expect(JSON.parse(await Bun.file(`${proj}/.agents/huddle/huddle.json`).text())).toEqual({ channel: "s1", as: "alpha", role: "kept", autostart: true });
    expect(await Bun.file(`${proj}/.agents/.huddle.json`).exists()).toBe(false);
    expect((await Bun.file(`${proj}/.git/info/exclude`).text()).split("\n")).toContain(".agents/huddle/");
    expect(cli("join").out).toContain("you are alpha");
    expect(cli("send", "kept").code).toBe(0);
    expect(await Bun.file(`${proj}/.agents/huddle/data/channels/s1.db`).exists()).toBe(true);
    expect(await Bun.file(`${proj}/.agents/huddle/huddle.pid`).exists()).toBe(true);
    expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: proj }).stdout.toString()).toBe(""); // nothing to commit
    expect(cli("setup", "show").out).toContain(`${proj}/.agents/huddle`);
    expect(cli("setup", "--channel", "x").code).toBe(2);
    expect(cli("setup", "nope").code).toBe(2);
  } finally { cli("down"); }
}, 60_000);

test("huddle setup --start joins the channel itself and prints the join line and the dashboard link, also with CLAUDECODE=1", async () => {
  const proj = mkdtempSync(`${tmpdir()}/huddle-repro-`), state = mkdtempSync(`${tmpdir()}/huddle-repro-state-`);
  Bun.spawnSync(["git", "init", "-q"], { cwd: proj });
  const env = { ...process.env, HUDDLE_TOKEN: "", HUDDLE_URL: "", HUDDLE_CHANNEL: "", HUDDLE_AS: "", HUDDLE_HOME: "", HUDDLE_DATA: "",
    HUDDLE_NO_PROJECT_CRED: "", CLAUDE_PROJECT_DIR: proj, XDG_STATE_HOME: state, HUDDLE_SESSION: "s-1", CLAUDECODE: "1" };
  const cli = (...a: string[]) => { const r = Bun.spawnSync(["bun", `${ROOT}/plugin/bin/huddle.ts`, ...a], { env, cwd: proj }); return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }; };
  try {
    const set = cli("setup", "--start");
    expect(set.code, set.out + set.err).toBe(0);
    const port = /Huddle started at http:\/\/127\.0\.0\.1:(\d+)/.exec(set.out)?.[1];
    expect(port ?? "").toMatch(/^\d+$/);
    expect(set.out).toMatch(new RegExp(`^join: +/huddle:join 127\\.0\\.0\\.1:${port} --token [a-z0-9]{6}\\.[a-z0-9]{16}   \\(valid`, "m")); // a fresh invite, printed
    const d = new RegExp(`^dashboard: (http://127\\.0\\.0\\.1:${port}/\\?code=\\S+)`, "m").exec(set.out);
    expect(d).not.toBeNull();                                  // a fresh sign-in link, printed
    expect((await fetch(d![1]!, { redirect: "manual" })).status).toBe(303); // the code signs a browser in
    const st = cli("status");
    expect(st.code, st.out + st.err).toBe(0);                  // the channel exists: setup joined it
    expect(st.out).toContain("you are ");
  } finally { cli("down"); }
}, 60_000);

test("huddle listen streams every message from the others as JSON lines, and replays from --after", async () => {
  await op("l1", "join", "a"); await op("l1", "join", "b"); await op("l1", "join", "c");
  const env = { ...process.env, HUDDLE_URL: U, HUDDLE_CHANNEL: "l1", HUDDLE_AS: "b" };
  const before = (await op("l1", "send", "a", { to: "b", msg: "earlier" })).result.seq;
  const p = Bun.spawn(["bun", `${ROOT}/plugin/bin/huddle.ts`, "listen", "--after", String(before - 1)], { env, stdout: "pipe", stderr: "ignore" });
  const got: any[] = [];
  (async () => { let buf = ""; for await (const c of p.stdout as any) { buf += new TextDecoder().decode(c); let i; while ((i = buf.indexOf("\n")) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } } })();
  try {
    for (const t = Date.now(); Date.now() - t < 8000 && !got.length; ) await Bun.sleep(25);
    await op("l1", "send", "a", { to: "c", msg: "for c" });
    await op("l1", "publish", "b", { topic: "mine.x", msg: "own" });
    await op("l1", "send", "c", { to: "b", msg: "for b", ask: true });
    for (const t = Date.now(); Date.now() - t < 8000 && got.length < 3; ) await Bun.sleep(25);
    expect(got.map(e => [e.from, e.to, e.msg])).toEqual([["a", "b", "earlier"], ["a", "c", "for c"], ["c", "b", "for b"]]);
    expect(got[2].needs_reply).toBe(true);
    expect(got[0].channel).toBe("l1");
  } finally { p.kill(); await p.exited; }
}, 40_000);

test("huddle listen follows the channel and its listen channels together", async () => {
  await op("m1", "join", "a"); await op("m2", "join", "a");
  const env = { ...process.env, HUDDLE_URL: U, HUDDLE_CHANNEL: "m1", HUDDLE_AS: "b", HUDDLE_LISTEN: "m2" };
  await op("m1", "send", "a", { msg: "old, before listen" });
  const p = Bun.spawn(["bun", `${ROOT}/plugin/bin/huddle.ts`, "listen"], { env, stdout: "pipe", stderr: "ignore" });
  const got: any[] = [];
  (async () => { let buf = ""; for await (const c of p.stdout as any) { buf += new TextDecoder().decode(c); let i; while ((i = buf.indexOf("\n")) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } } })();
  try {
    await Bun.sleep(1500); // both streams connect
    await op("m1", "send", "a", { msg: "in m1" });
    await op("m2", "send", "a", { msg: "in m2" });
    for (const t = Date.now(); Date.now() - t < 8000 && got.length < 2; ) await Bun.sleep(25);
    expect(got.map(e => [e.channel, e.msg]).sort()).toEqual([["m1", "in m1"], ["m2", "in m2"]]);
  } finally { p.kill(); await p.exited; }
}, 40_000);

test("huddle listen --state resumes where the last listen stopped, missing nothing in between", async () => {
  await op("r1", "join", "a");
  const env = { ...process.env, HUDDLE_URL: U, HUDDLE_CHANNEL: "r1", HUDDLE_AS: "b", HUDDLE_LISTEN: "" };
  const state = `${mkdtempSync(`${tmpdir()}/huddle-st-`)}/lanes.json`;
  const first = (await op("r1", "send", "a", { msg: "one" })).result.seq;
  const listen = async (until: number) => {
    const p = Bun.spawn(["bun", `${ROOT}/plugin/bin/huddle.ts`, "listen", "--after", String(first - 1), "--state", state], { env, stdout: "pipe", stderr: "ignore" });
    const got: any[] = [];
    (async () => { let buf = ""; for await (const c of p.stdout as any) { buf += new TextDecoder().decode(c); let i; while ((i = buf.indexOf("\n")) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } } })();
    for (const t = Date.now(); Date.now() - t < 8000 && got.length < until; ) await Bun.sleep(25);
    p.kill(); await p.exited;
    return got.map(e => e.msg);
  };
  expect(await listen(1)).toEqual(["one"]);
  await op("r1", "send", "a", { msg: "two, while nobody listens" });
  expect(await listen(1)).toEqual(["two, while nobody listens"]); // not "one" again
}, 40_000);

test("the listen hook brings new messages of the channel and of HUDDLE_LISTEN into the session, once", async () => {
  await op("h1", "join", "a"); await op("h1", "join", "b"); await op("h1", "join", "c"); await op("h2", "join", "a");
  const env = { ...process.env, HUDDLE_URL: U, HUDDLE_CHANNEL: "h1", HUDDLE_AS: "b", HUDDLE_LISTEN: "h2", HUDDLE_HOME: mkdtempSync(`${tmpdir()}/huddle-hook-`) };
  const hook = async () => {
    const p = Bun.spawn(["bun", `${ROOT}/plugin/hooks/listen.ts`], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    p.stdin.write(JSON.stringify({ session_id: "s-1", hook_event_name: "PostToolUse" })); p.stdin.end();
    const out = await new Response(p.stdout).text(); await p.exited;
    return out.trim() ? JSON.parse(out).hookSpecificOutput : null;
  };
  expect(await hook()).toBeNull(); // the first look marks now
  await op("h1", "send", "a", { to: "c", msg: "between a and c" });
  await op("h1", "send", "a", { to: "b", msg: "can you check?", ask: true });
  await op("h1", "publish", "a", { topic: "build.done", msg: "its own topic" });
  await op("h1", "join", "d"); // session.* stays out
  await op("h2", "send", "a", { msg: "over in h2" });
  const h = await hook();
  expect(h.hookEventName).toBe("PostToolUse");
  const t: string = h.additionalContext;
  expect(t).toContain('new in "h1" (you are b)');
  expect(t).toMatch(/a → c \(msg\): between a and c \[overheard/);
  expect(t).toMatch(/a → b \(ask\): can you check\? \[answer: reply seq=\d+\]/);
  expect(t).not.toContain("/");                       // no long paths in the hints
  expect(t).not.toContain("its own topic");           // other events: one count line
  expect(t).toMatch(/\+1 other event \(events after=\d+ for them\)/);
  expect(t).not.toContain("session.joined");
  expect(t).toContain('new in "h2"');
  expect(t).toContain("over in h2");
  expect(await hook()).toBeNull(); // shown once
  // task updates and knowledge fold into counts; the session's own subagents stay out
  await op("h1", "task_create", "a", { title: "build it", owner: "c" });
  await op("h1", "remember", "a", { kind: "fact", title: "a fact", body: "x" });
  await op("h1", "join", "b.explore"); await op("h1", "send", "b.explore", { msg: "from my own subagent" });
  const d: string = (await hook()).additionalContext;
  expect(d).toMatch(/\+\d+ task updates?, \+1 knowledge entry/);
  expect(d).not.toContain("from my own subagent");
  // a subagent's tool call never takes the parent's feed
  await op("h1", "send", "a", { to: "b", msg: "for the parent" });
  const sub = Bun.spawn(["bun", `${ROOT}/plugin/hooks/listen.ts`], { env, stdin: new Blob([JSON.stringify({ session_id: "s-1", agent_id: "ag-1", hook_event_name: "PostToolUse" })]), stdout: "pipe", stderr: "ignore" });
  expect((await new Response(sub.stdout).text()).trim()).toBe(""); await sub.exited;
  expect((await hook()).additionalContext).toContain("for the parent");
}, 40_000);

test("huddle listen survives a stream that goes quiet: it reconnects, and re-reads what it missed", async () => {
  // a server whose live stream says hello and then nothing, ever; the timeline has the events
  let events: any[] = [], streams = 0;
  const fake = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.endsWith("/live")) {
      streams++;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "hello", data: {} })}\n\n`)); } }),
        { headers: { "content-type": "text/event-stream" } });
    }
    if (u.pathname.endsWith("/timeline")) return Response.json(events.filter(e => e.seq > Number(u.searchParams.get("after") ?? 0)));
    return new Response("no", { status: 404 });
  } });
  const env = { ...process.env, HUDDLE_URL: `http://127.0.0.1:${fake.port}`, HUDDLE_CHANNEL: "q", HUDDLE_AS: "b", HUDDLE_LISTEN: "",
    HUDDLE_LISTEN_RESYNC_MS: "300", HUDDLE_LISTEN_QUIET_MS: "800" };
  const p = Bun.spawn(["bun", `${ROOT}/plugin/bin/huddle.ts`, "listen", "--after", "1"], { env, stdout: "pipe", stderr: "ignore" });
  const got: any[] = [];
  (async () => { let buf = ""; for await (const c of p.stdout as any) { buf += new TextDecoder().decode(c); let i; while ((i = buf.indexOf("\n")) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } } })();
  try {
    for (const t = Date.now(); Date.now() - t < 8000 && streams < 1; ) await Bun.sleep(25);
    events = [{ seq: 2, from: "a", to: null, topic: "msg", msg: "sent while the stream was quiet" }];
    for (const t = Date.now(); Date.now() - t < 8000 && !got.length; ) await Bun.sleep(25);
    expect(got.map(e => e.msg)).toEqual(["sent while the stream was quiet"]); // the periodic re-read
    for (const t = Date.now(); Date.now() - t < 8000 && streams < 2; ) await Bun.sleep(25);
    expect(streams).toBeGreaterThanOrEqual(2); // the quiet stream was dropped and opened again
    await Bun.sleep(700);
    expect(got.length).toBe(1); // re-reads and reconnects show nothing twice
  } finally { p.kill(); await p.exited; fake.stop(true); }
}, 40_000);

// a server whose root credential is `root`, and a CLI that runs as one Claude session (its own
// state dir and session id, no HUDDLE_TOKEN unless given)
async function authServer(root: string) {
  return startServer({ HUDDLE_TOKEN: root, HUDDLE_DATA: mkdtempSync(`${tmpdir()}/huddle-auth-`) }, { stderr: "ignore" });
}
const session = (state: string, sid: string, env: Record<string, string> = {}) => (...a: string[]) => {
  const r = Bun.spawnSync(["bun", `${ROOT}/plugin/bin/huddle.ts`, ...a], { env: { ...process.env, HUDDLE_TOKEN: "", HUDDLE_URL: "", HUDDLE_CHANNEL: "", HUDDLE_AS: "",
    HUDDLE_HOME: `${state}/home`, CLAUDE_PROJECT_DIR: state, XDG_STATE_HOME: state, HUDDLE_SESSION: sid, ...env }, cwd: state });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
// the /huddle:join line a command printed, as `huddle` arguments ("join", host, "--token", t), and the token in it
const joinArgs = (out: string): string[] => {
  const m = /\/huddle:join (\S+) --token (\S+)/.exec(out);
  if (!m) throw new Error(`no join line in the output: ${out}`);
  return ["join", m[1]!, "--token", m[2]!];
};
const tokenOf = (out: string): string => /--token ([a-z0-9]{6}\.[a-z0-9]{16})/.exec(out)![1]!;

test("the API and MCP answer only a credential; /health and the page stay open; a wrong token is a 401", async () => {
  const s = await authServer("root-a-very-long-credential");
  try {
    const join = (h: Record<string, string>, as = "a") => fetch(`${s.u}/api/c/sec/op/join?as=${as}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: "{}" });
    expect((await join({})).status).toBe(401);
    expect((await join({ "x-huddle-token": "wrong" })).status).toBe(401);
    expect((await fetch(`${s.u}/api/channels`)).status).toBe(401);
    expect((await fetch(`${s.u}/api/c/sec/timeline`)).status).toBe(401);
    expect((await fetch(`${s.u}/mcp/sec?as=a`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status).toBe(401);
    expect((await join({ "x-huddle-token": "root-a-very-long-credential" })).status).toBe(200);
    expect((await fetch(`${s.u}/health`)).status).toBe(200);
    expect((await fetch(`${s.u}/`)).status).toBe(200);
    // an invite: a wrong secret, an unknown id and garbage all get the same 401
    const inv = await (await fetch(`${s.u}/api/tokens`, { method: "POST", headers: { "x-huddle-token": "root-a-very-long-credential", "content-type": "application/json" }, body: "{}" })).json() as any;
    expect(inv.token).toMatch(/^[a-z0-9]{6}\.[a-z0-9]{16}$/);
    for (const token of [`${inv.id}.0000000000000000`, "zzzzzz.0123456789abcdef", "junk"]) {
      const r = await fetch(`${s.u}/api/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, name: "x" }) });
      expect(r.status, token).toBe(401);
    }
  } finally { s.p.kill(); await s.p.exited; }
}, 40_000);

test("an invite from the creator lets another session join under its own name; kick revokes it; tokens never reach the channel", async () => {
  const root = "root-for-the-invite-story", s = await authServer(root);
  const owner = session(mkdtempSync(`${tmpdir()}/huddle-own-`), "s-owner", { HUDDLE_TOKEN: root, HUDDLE_URL: s.u, HUDDLE_CHANNEL: "team", HUDDLE_AS: "lead" });
  const stateB = mkdtempSync(`${tmpdir()}/huddle-b-`), b = session(stateB, "s-b");
  try {
    expect(owner("join").code).toBe(0);
    const made = owner("token", "create", "--print-join-command");
    expect(made.code).toBe(0);
    expect(made.out).toMatch(/^join: \/huddle:join 127\.0\.0\.1:\d+ --token [a-z0-9]{6}\.[a-z0-9]{16}   \(valid/m);
    const token = tokenOf(made.out), id = token.split(".")[0];
    expect(made.out).toContain(`/huddle:join 127.0.0.1:${s.port} --token ${token}`);
    expect(b("send", "hello").code).toBe(2);                  // not in a huddle yet
    const joined = b(...joinArgs(made.out), "--as", "dev");
    expect(joined.code, joined.err).toBe(0);
    expect(joined.out).toContain("you are dev");               // the invite's channel, joined
    // its own credential, per session, 0600; never the invite
    const file = `${stateB}/huddle/sessions/s-b.json`;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const cred = JSON.parse(readFileSync(file, "utf8"));
    expect(cred).toMatchObject({ url: s.u, channel: "team", as: "dev" });
    expect(readFileSync(file, "utf8")).not.toContain(token.split(".")[1]);
    expect(b("send", `the join line was ${token} and my credential ${cred.credential}`).code).toBe(0);
    expect(b("join", "--as", "dev.explore").code).toBe(0);           // its subagents, too
    expect(b("send", "--as", "dev.explore", "from my subagent").code).toBe(0);
    // bound to its name: not another session, not the owner
    for (const as of ["lead", "owner"])
      expect((await fetch(`${s.u}/api/c/team/op/status?as=${as}`, { method: "POST", headers: { "x-huddle-token": cred.credential, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${s.u}/api/tokens`, { headers: { "x-huddle-token": cred.credential } })).status).toBe(403);
    // what reached the channel carries no secret
    const tl = JSON.stringify(await (await fetch(`${s.u}/api/c/team/timeline`, { headers: { "x-huddle-token": root } })).json());
    expect(tl).toContain(`${id}.<redacted>`);
    expect(tl).not.toContain(token.split(".")[1]);
    expect(tl).not.toContain(cred.credential);
    expect(owner("token", "list").out).toContain(id);
    expect(owner("token", "list").out).not.toContain(token.split(".")[1]);
    expect(owner("members").out).toContain("dev");
    expect(owner("kick", "dev").code).toBe(0);
    expect(b("send", "still here?")).toMatchObject({ code: 2, err: expect.stringContaining("not in this huddle") });
    expect(owner("token", "delete", id).code).toBe(0);
    expect(b(...joinArgs(made.out), "--as", "dev").code).toBe(2); // a revoked invite
    expect(owner("token", "list").out).toContain("no tokens");
  } finally { s.p.kill(); await s.p.exited; }
}, 60_000);

test("a dashboard link signs the browser in once: cookie, then the clean URL", async () => {
  const root = "root-for-the-browser-story", s = await authServer(root);
  try {
    const login = await (await fetch(`${s.u}/api/login`, { method: "POST", headers: { "x-huddle-token": root, "content-type": "application/json" }, body: "{}" })).json() as any;
    const signin = await fetch(`${s.u}/?code=${encodeURIComponent(login.code)}`, { redirect: "manual" });
    expect(signin.status).toBe(303);
    expect(signin.headers.get("location")).toBe("/");
    const set = String(signin.headers.get("set-cookie"));
    expect(set).toContain("HttpOnly"); expect(set).toContain("SameSite=Strict"); expect(set).not.toContain("Max-Age");
    const cookie = set.split(";")[0];
    expect(cookie.startsWith(`huddle_session_${s.port}=`)).toBe(true);
    expect((await fetch(`${s.u}/api/channels`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${s.u}/?code=${encodeURIComponent(login.code)}`, { redirect: "manual" })).status).toBe(401); // used
    expect((await fetch(`${s.u}/?code=nope`, { redirect: "manual" })).status).toBe(401);
  } finally { s.p.kill(); await s.p.exited; }
}, 40_000);

test("every member signs its own browser in; that browser runs the dashboard but nothing of the creator's", async () => {
  const root = "root-for-the-member-browser", s = await authServer(root);
  const owner = session(mkdtempSync(`${tmpdir()}/huddle-own-`), "s-owner", { HUDDLE_TOKEN: root, HUDDLE_URL: s.u, HUDDLE_CHANNEL: "team", HUDDLE_AS: "lead" });
  const b = session(mkdtempSync(`${tmpdir()}/huddle-b-`), "s-b"), out = session(mkdtempSync(`${tmpdir()}/huddle-x-`), "s-x", { HUDDLE_URL: s.u });
  try {
    expect(owner("join").code).toBe(0);
    const made = owner("token", "create", "--print-join-command");
    const joined = b(...joinArgs(made.out), "--as", "dev");
    expect(joined.code, joined.err).toBe(0);
    expect(joined.err).toMatch(new RegExp(`dashboard: http://127\\.0\\.0\\.1:${s.port}/\\?code=`)); // the link itself, printed for the user
    const opened = b("open");
    expect(opened.code, opened.err).toBe(0);
    const code = /\?code=([^\s]+)/.exec(opened.out)![1];
    const signin = await fetch(`${s.u}/?code=${code}`, { redirect: "manual" });
    expect(signin.status).toBe(303);
    const cookie = String(signin.headers.get("set-cookie")).split(";")[0], C = { cookie, "content-type": "application/json" };
    // what the dashboard does: read, and act as the owner in the channels
    expect((await fetch(`${s.u}/api/channels`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${s.u}/api/c/team/board`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${s.u}/api/c/team/op/send?as=owner`, { method: "POST", headers: C, body: JSON.stringify({ to: "dev", msg: "from the dashboard" }) })).status).toBe(200);
    // not a session, and none of the creator's: invites, members, kicks, more browsers
    expect((await fetch(`${s.u}/api/c/team/op/send?as=lead`, { method: "POST", headers: C, body: JSON.stringify({ msg: "x" }) })).status).toBe(403);
    expect((await fetch(`${s.u}/api/tokens`, { headers: { cookie } })).status).toBe(403);
    expect((await fetch(`${s.u}/api/tokens`, { method: "POST", headers: C, body: "{}" })).status).toBe(403);
    expect((await fetch(`${s.u}/api/members`, { headers: { cookie } })).status).toBe(403);
    expect((await fetch(`${s.u}/api/members/dev`, { method: "DELETE", headers: { cookie } })).status).toBe(403);
    expect((await fetch(`${s.u}/api/login`, { method: "POST", headers: C, body: "{}" })).status).toBe(403);
    expect(await (await fetch(`${s.u}/api/whoami`, { headers: { cookie } })).json()).toEqual({ name: "owner", root: false, invite: false, browser: "dev" });
    // the creator's own browser keeps the creator's rights
    const rc = await (await fetch(`${s.u}/api/login`, { method: "POST", headers: { "x-huddle-token": root, "content-type": "application/json" }, body: "{}" })).json() as any;
    const rcookie = String((await fetch(`${s.u}/?code=${rc.code}`, { redirect: "manual" })).headers.get("set-cookie")).split(";")[0];
    expect((await fetch(`${s.u}/api/tokens`, { headers: { cookie: rcookie } })).status).toBe(200);
    // a session that never joined gets no link
    const none = out("open");
    expect(none.code).toBe(2);
    expect(none.out).not.toContain("code=");
    // no code reached the channel or the server's answers to it
    const tl = JSON.stringify(await (await fetch(`${s.u}/api/c/team/timeline`, { headers: { "x-huddle-token": root } })).json());
    expect(tl).not.toContain(code);
    // a kick ends the member's browser too
    expect(owner("kick", "dev").code).toBe(0);
    expect((await fetch(`${s.u}/api/channels`, { headers: { cookie } })).status).toBe(401);
  } finally { s.p.kill(); await s.p.exited; }
}, 60_000);

test("inside Claude Code the join and open print the dashboard link themselves, and the hook carries no systemMessage", async () => {
  const root = "root-for-the-claude-story", s = await authServer(root);
  const owner = session(mkdtempSync(`${tmpdir()}/huddle-own-`), "s-owner", { HUDDLE_TOKEN: root, HUDDLE_URL: s.u, HUDDLE_CHANNEL: "team", HUDDLE_AS: "lead" });
  const stateB = mkdtempSync(`${tmpdir()}/huddle-b-`), b = session(stateB, "s-b", { CLAUDECODE: "1" });
  const hook = async () => {
    const p = Bun.spawn(["bun", `${ROOT}/plugin/hooks/listen.ts`], { env: { ...process.env, HUDDLE_TOKEN: "", HUDDLE_URL: "", HUDDLE_CHANNEL: "", HUDDLE_AS: "", HUDDLE_LISTEN: "",
      HUDDLE_HOME: `${stateB}/home`, CLAUDE_PROJECT_DIR: stateB, XDG_STATE_HOME: stateB }, cwd: stateB,
      stdin: new Blob([JSON.stringify({ session_id: "s-b", hook_event_name: "PostToolUse" })]), stdout: "pipe", stderr: "pipe" });
    const t = await new Response(p.stdout).text(); await p.exited;
    return t.trim() ? JSON.parse(t) : {};
  };
  try {
    expect(owner("join").code).toBe(0);
    const line = owner("token", "create", "--print-join-command").out;
    const joined = b(...joinArgs(line), "--as", "dev");
    expect(joined.code, joined.err).toBe(0);
    const code = /\?code=(\S+)/.exec(joined.err)![1];          // the link, printed to Claude's output too
    expect((await fetch(`${s.u}/?code=${code}`, { redirect: "manual" })).status).toBe(303);
    const first = await hook();                                // PostToolUse, right after that command
    expect(first.systemMessage).toBeUndefined();               // no link or token through a hook any more
    expect(JSON.stringify(first)).not.toContain("--token");
    expect((await hook()).systemMessage).toBeUndefined();
    const opened = b("open");                                  // /huddle:setup's other way in: huddle open
    expect(opened.code, opened.err).toBe(0);
    expect(opened.out).toMatch(/\?code=/);
    expect((await hook()).systemMessage).toBeUndefined();
  } finally { s.p.kill(); await s.p.exited; }
}, 60_000);

test("huddle up makes its session the creator; a restart keeps every member, browser and unused invite (digests only), a kick still revokes", async () => {
  const port = await freePort(), u = `http://127.0.0.1:${port}`;
  const stateA = mkdtempSync(`${tmpdir()}/huddle-ca-`), stateB = mkdtempSync(`${tmpdir()}/huddle-cb-`), stateC = mkdtempSync(`${tmpdir()}/huddle-cc-`);
  const a = session(stateA, "s-a", { HUDDLE_URL: u, HUDDLE_CHANNEL: "reset", HUDDLE_AS: "lead", HUDDLE_DATA: "" });
  const b = session(stateB, "s-b"), c = session(stateC, "s-c");
  try {
    const up = a("up");
    expect(up.code, up.err).toBe(0);
    expect(up.out).toMatch(new RegExp(`^join: +/huddle:join 127\\.0\\.0\\.1:${port} --token [a-z0-9]{6}\\.[a-z0-9]{16}`, "m"));
    expect(up.out).toMatch(new RegExp(`^dashboard: http://127\\.0\\.0\\.1:${port}/\\?code=\\S+`, "m"));
    expect(JSON.parse(readFileSync(`${stateA}/huddle/sessions/s-a.json`, "utf8")).root).toBe(true);
    expect(readdirSync(`${stateA}/huddle`).sort()).toEqual(["servers.json", "sessions"]); // no shared token file
    expect(a("join").code).toBe(0);
    const login = /\?code=(\S+)/.exec(a("open").out)![1];
    const cookie = String((await fetch(`${u}/?code=${login}`, { redirect: "manual" })).headers.get("set-cookie")).split(";")[0];
    const line = joinArgs(up.out);
    expect(b(...line, "--as", "dev").code).toBe(0);
    expect(b("send", "before").code).toBe(0);
    const spare = joinArgs(a("token", "create", "--print-join-command").out);
    const gone = joinArgs(a("token", "create", "--print-join-command", "--ttl", "1").out);
    // what the server keeps: digests, 0600, no secret
    const auth = `${stateA}/home/data/auth.json`;
    expect(statSync(auth).mode & 0o777).toBe(0o600);
    const kept = readFileSync(auth, "utf8"), credB = JSON.parse(readFileSync(`${stateB}/huddle/sessions/s-b.json`, "utf8")).credential;
    for (const secret of [credB, tokenOf(up.out).split(".")[1], tokenOf(spare.join(" ")).split(".")[1], JSON.parse(readFileSync(`${stateA}/huddle/sessions/s-a.json`, "utf8")).credential])
      expect(kept).not.toContain(secret);
    expect(a("down").code).toBe(0);
    await Bun.sleep(1100);                                     // the one-second invite runs out
    const again = a("up");
    expect(again.code, again.err).toBe(0);                     // the creator keeps its root
    expect(a("send", "after").code).toBe(0);
    expect(b("send", "after").code).toBe(0);                   // a member stays in across the restart
    expect((await fetch(`${u}/api/channels`, { headers: { cookie } })).status).toBe(200); // so does a browser
    expect(c(...spare, "--as", "late").code).toBe(0);          // an unused invite still works
    expect(c(...gone, "--as", "later").code).toBe(2);          // an expired one does not
    expect(a("kick", "dev").code).toBe(0);
    expect(b("send", "still?")).toMatchObject({ code: 2, err: expect.stringContaining("/huddle:invite") }); // a kick revokes, with a way back
    expect(a("down").code).toBe(0);
    expect(a("up").code).toBe(0);
    expect(b("send", "after the kick").code).toBe(2);          // and stays revoked across a restart
  } finally { a("down"); }
}, 60_000);

test("stdio bridge: a call to a Huddle that never answers gets an error back, not a hang", async () => {
  const mute = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: () => new Promise<Response>(() => {}) });
  try {
    const B = bridge("c10", { HUDDLE_URL: `http://127.0.0.1:${mute.port}`, HUDDLE_PUSH: "off", HUDDLE_CALL_TIMEOUT_MS: "500" });
    B.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } });
    const late = await B.until(() => B.lines.find(l => l.id === 2), 8000) as any;
    B.p.kill();
    expect(late?.result.isError).toBe(true);
    expect(late?.result.content[0].text).toMatch(/no answer/);
  } finally { mute.stop(true); }
}, 20_000);


test("a project's credential: the next Claude session in a project that joined is in too; another project is not; the invite's channel wins", async () => {
  const root = "root-for-the-project-story", s = await authServer(root);
  const projA = mkdtempSync(`${tmpdir()}/huddle-pa-`), projB = mkdtempSync(`${tmpdir()}/huddle-pb-`), state = mkdtempSync(`${tmpdir()}/huddle-ps-`);
  for (const p of [projA, projB]) Bun.spawnSync(["git", "init", "-q"], { cwd: p });
  mkdirSync(`${projA}/.agents/huddle`, { recursive: true });
  writeFileSync(`${projA}/.agents/huddle/huddle.json`, JSON.stringify({ channel: "mine", as: "web" })); // the project's file names another channel
  const sess = (proj: string, sid: string, env: Record<string, string> = {}) => (...a: string[]) => {
    const r = Bun.spawnSync(["bun", `${ROOT}/plugin/bin/huddle.ts`, ...a], { env: { ...process.env, HUDDLE_TOKEN: "", HUDDLE_URL: "", HUDDLE_CHANNEL: "", HUDDLE_AS: "", HUDDLE_NO_PROJECT_CRED: "",
      HUDDLE_HOME: `${proj}/.agents/huddle`, CLAUDE_PROJECT_DIR: proj, XDG_STATE_HOME: state, HUDDLE_SESSION: sid, ...env }, cwd: proj });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const owner = session(mkdtempSync(`${tmpdir()}/huddle-own-`), "s-owner", { HUDDLE_TOKEN: root, HUDDLE_URL: s.u, HUDDLE_CHANNEL: "team", HUDDLE_AS: "lead" });
  try {
    expect(owner("join").code).toBe(0);
    const made = owner("token", "create", "--print-join-command");
    const first = sess(projA, "a-1");
    const joined = first(...joinArgs(made.out));
    expect(joined.code, joined.err).toBe(0);
    expect(joined.err).toContain("joined channel team (the invite's); this project's file named mine");
    expect(joined.out).toContain("channel team");
    expect(first("status").out).toContain("channel team");
    const next = sess(projA, "a-2");                           // a new Claude session, same project
    expect(next("send", "a new session, still in").code).toBe(0);
    expect(next("status").out).toContain("you are web");
    const other = sess(projB, "b-1");                          // another project: not in
    expect(other("send", "me too?")).toMatchObject({ code: 2, err: expect.stringContaining("/huddle:invite") });
  } finally { s.p.kill(); await s.p.exited; }
}, 60_000);

test("/huddle:invite inside Claude Code prints the join line itself, and the hook carries no systemMessage", async () => {
  const root = "root-for-the-invite-in-claude", s = await authServer(root);
  const state = mkdtempSync(`${tmpdir()}/huddle-ic-`);
  const owner = session(state, "s-owner", { HUDDLE_TOKEN: root, HUDDLE_URL: s.u, HUDDLE_CHANNEL: "team", HUDDLE_AS: "lead", CLAUDECODE: "1" });
  const hook = async () => {
    const p = Bun.spawn(["bun", `${ROOT}/plugin/hooks/listen.ts`], { env: { ...process.env, HUDDLE_TOKEN: root, HUDDLE_URL: s.u, HUDDLE_CHANNEL: "team", HUDDLE_AS: "lead", HUDDLE_LISTEN: "",
      HUDDLE_HOME: `${state}/home`, CLAUDE_PROJECT_DIR: state, XDG_STATE_HOME: state }, cwd: state,
      stdin: new Blob([JSON.stringify({ session_id: "s-owner", hook_event_name: "PostToolUse" })]), stdout: "pipe", stderr: "pipe" });
    const t = await new Response(p.stdout).text(); await p.exited;
    return t.trim() ? JSON.parse(t) : {};
  };
  try {
    expect(owner("join").code).toBe(0);
    const made = owner("token", "create", "--print-join-command", "--single-use");
    expect(made.code, made.err).toBe(0);
    expect(made.out).toContain(`/huddle:join 127.0.0.1:${s.port} --token ${tokenOf(made.out)}`); // printed, not hidden
    expect(made.out).toMatch(/^join: \/huddle:join \S+ --token [a-z0-9]{6}\.[a-z0-9]{16}   \(valid .*single use\)$/m);
    const h = await hook();
    expect(h.systemMessage).toBeUndefined();                   // no invite through a hook any more
    const b = session(mkdtempSync(`${tmpdir()}/huddle-icb-`), "s-b");
    expect(b(...joinArgs(made.out), "--as", "dev").code).toBe(0);
    expect(readFileSync(`${ROOT}/plugin/commands/invite.md`, "utf8")).toContain('"${CLAUDE_PLUGIN_ROOT}/bin/huddle" token create --print-join-command $ARGUMENTS');
  } finally { s.p.kill(); await s.p.exited; }
}, 60_000);

test("huddle setup in a second project joins the Huddle this user already runs, instead of starting another; --new starts one anyway", async () => {
  const state = mkdtempSync(`${tmpdir()}/huddle-two-`), port = await freePort(), u = `http://127.0.0.1:${port}`;
  const api = mkdtempSync(`${tmpdir()}/huddle-api-`), web = mkdtempSync(`${tmpdir()}/huddle-web-`);
  for (const p of [api, web]) Bun.spawnSync(["git", "init", "-q"], { cwd: p });
  const sess = (proj: string, sid: string, env: Record<string, string> = {}) => (...a: string[]) => {
    const r = Bun.spawnSync(["bun", `${ROOT}/plugin/bin/huddle.ts`, ...a], { env: { ...process.env, HUDDLE_TOKEN: "", HUDDLE_URL: "", HUDDLE_CHANNEL: "", HUDDLE_AS: "", HUDDLE_HOME: "", HUDDLE_DATA: "",
      HUDDLE_NO_PROJECT_CRED: "", CLAUDE_PROJECT_DIR: proj, XDG_STATE_HOME: state, HUDDLE_SESSION: sid, ...env }, cwd: proj });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const A = sess(api, "s-api"), W = sess(web, "s-web");
  try {
    const set = A("setup", "--port", String(port), "--start");
    expect(set.code, set.out + set.err).toBe(0);
    expect(set.out).toContain("started");
    const w = W("setup", "--start");
    expect(w.code, w.out + w.err).toBe(0);
    expect(w.out).toContain(`Joined the Huddle that already runs for ${api}: ${u}, channel ${A("whoami").out.match(/"channel":"([^"]+)"/)![1]}`);
    expect(existsSync(`${web}/.agents/huddle/huddle.pid`)).toBe(false);   // no second server
    expect(W("send", "hello from web").code).toBe(0);
    expect(sess(web, "s-web-2")("status").out).toContain("you are"); // and its next session is in too
    expect(W("setup")).toMatchObject({ code: 0, out: expect.stringContaining("already in the Huddle") });
    const docs = mkdtempSync(`${tmpdir()}/huddle-docs-`); Bun.spawnSync(["git", "init", "-q"], { cwd: docs });
    const D = sess(docs, "s-docs"), sep = D("setup", "--new", "--start");
    expect(sep.code, sep.out + sep.err).toBe(0);
    expect(sep.out).toContain("Huddle started at");                  // --new: a separate one
    expect(existsSync(`${docs}/.agents/huddle/huddle.pid`)).toBe(true);
    D("down");
  } finally { A("down"); }
}, 60_000);

test("a browser without a working sign-in gets a Signed out answer; a session gets a way back in", async () => {
  const s = await authServer("root-for-the-signed-out-story");
  try {
    const browser = await fetch(`${s.u}/api/channels`, { headers: { cookie: `huddle_session_${s.port}=stale` } });
    expect(browser.status).toBe(401);
    expect(await browser.json()).toMatchObject({ signin: true, error: expect.stringContaining("huddle open") });
    const sess = await (await fetch(`${s.u}/api/channels`, { headers: { "x-huddle-token": "stale" } })).json() as any;
    expect(sess.signin).toBeUndefined();
    expect(sess.error).toContain("/huddle:invite");
    const page = await fetch(`${s.u}/?code=used-or-old`, { redirect: "manual" });
    expect(page.status).toBe(401);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Signed out"); expect(html).toContain("huddle open"); expect(html).toContain("/huddle:setup");
    expect(readFileSync(`${ROOT}/plugin/server/public/app.js`, "utf8")).toContain("Signed out");
  } finally { s.p.kill(); await s.p.exited; }
}, 40_000);

test("stdio bridge: a session not in a huddle lists two tools; once it is in, list_changed and every tool", async () => {
  const root = "root-for-the-short-list", s = await authServer(root);
  const state = mkdtempSync(`${tmpdir()}/huddle-mcpl-`);
  const p = Bun.spawn(["bun", `${ROOT}/plugin/bin/huddle-mcp.ts`], { env: { ...process.env, HUDDLE_TOKEN: "", HUDDLE_URL: "", HUDDLE_CHANNEL: "", HUDDLE_AS: "",
    HUDDLE_HOME: `${state}/home`, CLAUDE_PROJECT_DIR: state, XDG_STATE_HOME: state, HUDDLE_SESSION: "s-m", HUDDLE_PUSH: "off" }, cwd: state, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const lines: any[] = [];
  (async () => { let buf = ""; for await (const c of p.stdout as any) { buf += new TextDecoder().decode(c); let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } } })();
  const send = (m: unknown) => { p.stdin.write(JSON.stringify(m) + "\n"); p.stdin.flush(); };
  const at = (id: number) => until(() => lines.find(l => l.id === id), 8000) as Promise<any>;
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    expect((await at(1)).result.instructions).toContain("mcp__plugin_huddle_huddle__");
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await at(2)).result.tools.map((t: any) => t.name)).toEqual(["status", "join"]);
    const inv = await (await fetch(`${s.u}/api/tokens`, { method: "POST", headers: { "x-huddle-token": root, "content-type": "application/json" }, body: JSON.stringify({ channel: "short" }) })).json() as any;
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "join", arguments: { host_port: `127.0.0.1:${s.port}`, token: inv.token, as: "mcpuser" } } });
    expect((await at(3)).result.content[0].text).toContain("as mcpuser");
    expect(await until(() => lines.find(l => l.method === "notifications/tools/list_changed"), 8000)).toBeTruthy();
    send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    expect((await at(4)).result.tools.length).toBeGreaterThan(20);
    send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "status", arguments: {} } });
    expect((await at(5)).result.content[0].text).toContain("you are mcpuser");
  } finally { p.kill(); s.p.kill(); await s.p.exited; }
}, 60_000);

test("MCP: ops without a text of their own answer in one line, not a JSON object (json: true still gives it)", async () => {
  await op("c11", "join", "a"); await op("c11", "join", "b");
  const call = async (name: string, args: unknown) => (await rpc("c11", "a", "tools/call", { name, arguments: args })).result.content[0].text as string;
  expect(await call("send", { to: "b", msg: "hi", ask: true })).toMatch(/^#\d+ sent to b \(an ask/);
  expect(await call("remember", { kind: "fact", title: "short answers", body: "one line each" })).toMatch(/^#\d+ remembered: short answers$/);
  expect(await call("task_create", { title: "ship it", owner: "b", id: "ship" })).toBe("created ship → b (ready)");
  expect(await call("finish", { id: "ship", note: "done by a" })).toMatch(/^done ship; released: none; next: /);
  expect(JSON.parse(await call("send", { to: "b", msg: "full", json: true })).seq).toBeGreaterThan(0);
});
