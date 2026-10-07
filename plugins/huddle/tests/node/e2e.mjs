// tests/node/e2e.mjs — the node leg: Huddle as installed (plugin/dist/), every entry launched under
// Node, no Bun involved (`node --test tests/node/e2e.mjs`; npm run test:node). A server, the
// creator's invite and two members joining with it, events and a long-poll, tasks across sessions,
// knowledge search (FTS5 through node:sqlite), the dashboard sign-in, a live stream, the MCP bridge,
// the hooks exactly as hooks.json runs them with only node on PATH, and huddle up/down.
// Throwaway everything: temp HOME and XDG_STATE_HOME, random ports, temp data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemPath } from "./system-path.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = `${ROOT}/plugin/dist`;
const NODE = process.execPath;
// node:sqlite sits behind a flag before Node 22.13 (huddle up adds it the same way, src/rt.ts runtimeArgs)
const [MAJ, MIN] = process.versions.node.split(".").map(Number);
const FLAGS = MAJ < 22 || (MAJ === 22 && MIN < 13) ? ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"] : [];
const TMPS = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), `huddle-node-${p}-`)); TMPS.push(d); return d; };
const HOME = tmp("home"), STATE = tmp("state"), DATA = tmp("data");
const ROOTCRED = `node-leg-${crypto.randomUUID()}`;
// a port to name in advance (huddle up): below every OS's ephemeral range, checked free, never twice;
// the server this file starts itself takes PORT=0 and says which port it got (no bind-close-reuse race)
const GIVEN = new Set();
const bindable = (p) => new Promise(r => { const s = createServer(); s.once("error", () => r(false)); s.listen({ port: p, host: "127.0.0.1", exclusive: true }, () => s.close(() => r(true))); });
const freePort = async () => { for (;;) { const p = 20000 + Math.floor(Math.random() * 12000); if (GIVEN.has(p)) continue; GIVEN.add(p); if (await bindable(p)) return p; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// a clean environment: nothing of the real machine's Huddle or Claude session leaks in
const BASE = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HUDDLE_|CLAUDE)/.test(k)));
// one state dir for every session here: no project-wide credential, each session holds its own
Object.assign(BASE, { HOME, XDG_STATE_HOME: STATE, HUDDLE_NO_PROJECT_CRED: "1", HUDDLE_NOTIFY_LOG: `${tmp("notify")}/notify.log`, OBSERVATORY_HOME: tmp("obs") });
let PORT, URL_, srv;
const env = (o = {}) => ({ ...BASE, HUDDLE_URL: URL_, HUDDLE_CHANNEL: "nodeleg", ...o });
// the CLI as a member session (its own credential, kept under XDG_STATE_HOME by session)
const cli = (who, args, o = {}) => {
  const r = spawnSync(NODE, [`${DIST}/huddle.js`, ...args], { env: env({ HUDDLE_SESSION: who.split(".")[0], HUDDLE_AS: who, ...o }), encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const owner = (args) => cli("owner", args, { HUDDLE_TOKEN: ROOTCRED });
const api = async (path, init = {}, token = ROOTCRED) => fetch(`${URL_}${path}`, { ...init, headers: { "content-type": "application/json", "x-huddle-token": token, ...(init.headers ?? {}) } });
const health = async (u) => { try { return (await fetch(`${u}/health`)).ok; } catch { return false; } };
const until = async (f, ms = 8000) => { for (const t = Date.now(); Date.now() - t < ms; await sleep(25)) { const v = await f(); if (v) return v; } return undefined; };

before(async () => {
  srv = spawn(NODE, [...FLAGS, `${DIST}/server.js`], { env: { ...BASE, PORT: "0", HUDDLE_DATA: DATA, HUDDLE_TOKEN: ROOTCRED }, stdio: ["ignore", "pipe", "inherit"] });
  let said = "";
  srv.stdout.on("data", c => { said += c; });
  PORT = Number((await until(() => /on http:\/\/[\d.]+:(\d+)/.exec(said), 30_000))?.[1]);
  assert.ok(PORT, `the server says its port: ${said}`);
  URL_ = `http://127.0.0.1:${PORT}`;
  assert.ok(await until(() => health(URL_), 30_000), "the server answers /health");
});
after(async () => {
  if (srv && srv.exitCode === null) { srv.kill("SIGTERM"); await new Promise(r => srv.once("exit", r)); }
  for (const d of TMPS) rmSync(d, { recursive: true, force: true });
});

test("the server runs under node, from dist, with its version", async () => {
  const h = await (await fetch(`${URL_}/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.version, JSON.parse(readFileSync(`${ROOT}/plugin/.claude-plugin/plugin.json`, "utf8")).version);
  // the guard (fetch will not send a Host of our choosing; node:http will)
  const status = await new Promise((r, j) => request(`${URL_}/health`, { headers: { host: `evil.test:${PORT}` } }, res => { res.resume(); r(res.statusCode); }).on("error", j).end());
  assert.equal(status, 421);
});

test("members join with the creator's invite and get their own credentials", () => {
  const inv = owner(["token", "create", "--print-join-command"]);
  assert.equal(inv.code, 0, inv.err);
  const line = inv.out.split("\n")[0];
  assert.match(line, /^huddle join 127\.0\.0\.1:\d+ --token [a-z0-9]{6}\.[a-z0-9]+$/);
  const [, , host, , token] = line.split(" ");
  for (const who of ["alpha", "beta"]) {
    const r = cli(who, ["join", host, "--token", token, "--as", who, "--channel", "nodeleg"], { HUDDLE_URL: "" });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, new RegExp(`joined ${URL_.replace(/\./g, "\\.")} as ${who}`));
    assert.ok(existsSync(`${STATE}/huddle/sessions/${who}.json`));
  }
  assert.match(owner(["members"]).out, /alpha[\s\S]*beta/);
  assert.notEqual(cli("intruder", ["status"]).code, 0); // no credential: not in this huddle
});

test("events: a message, an ask that wakes a long-poll, the reply", async () => {
  const w = spawn(NODE, [`${DIST}/huddle.js`, "wait", "--timeout", "30"], { env: env({ HUDDLE_SESSION: "beta", HUDDLE_AS: "beta" }) });
  let out = ""; w.stdout.on("data", c => out += c);
  const code = new Promise(r => w.once("exit", r));
  await sleep(500);
  assert.equal(cli("alpha", ["send", "beta", "ready for the schema?", "--ask"]).code, 0);
  assert.equal(await code, 3, "wait exits 3 on a message for you");
  const ev = JSON.parse(out);
  assert.equal(ev.msg, "ready for the schema?");
  assert.equal(cli("beta", ["reply", String(ev.seq), "yes"]).code, 0);
  assert.equal(cli("alpha", ["pub", "build.ready", "api", "green"]).code, 0);
  const evs = await (await api("/api/c/nodeleg/timeline?after=0")).json();
  assert.ok(evs.some(e => e.topic === "build.ready" && e.from === "alpha"), JSON.stringify(evs));
  assert.equal(cli("beta", ["wait", "nothing.*", "--timeout", "1"]).code, 124);
});

test("tasks: one waits on another session's, and is released when it finishes", () => {
  assert.equal(cli("alpha", ["new", "Ship the API", "--id", "api"]).code, 0);
  assert.equal(cli("alpha", ["new", "Client", "--id", "client", "--owner", "beta", "--after", "api"]).code, 0);
  assert.match(cli("beta", ["start", "client"]).out, /NOT STARTED: waits on api/);
  assert.equal(cli("alpha", ["start", "api"]).code, 0);
  const fin = cli("alpha", ["finish", "tests green", "--result", "GET /orders, cursor-based"]);
  assert.equal(fin.code, 0, fin.err);
  assert.match(fin.out, /client/);
  assert.equal(cli("beta", ["start", "client"]).code, 0);
  assert.match(cli("beta", ["tasks"]).out, /api \[done\]/);
});

// FTS5 is in node:sqlite from about Node 22.13; before, search falls back to LIKE (README)
test("knowledge: remember, then recall it (ranked FTS5 where node:sqlite has it, LIKE before), and read it", async () => {
  const { meta } = await (await api("/api/c/nodeleg/board")).json();
  assert.equal(meta.fts, !FLAGS.length, "FTS5 on every Node that needs no flag for node:sqlite");
  assert.equal(cli("alpha.explore", ["join", "--role", "maps the schema"]).code, 0);
  assert.equal(cli("alpha.explore", ["remember", "context", "orders schema", "orders are indexed and paginated by created_at", "--tags", "orders"]).code, 0);
  const hit = cli("beta", ["recall", meta.fts ? "paginating" : "unrelated paginated"]); // FTS: porter stems paginating ~ paginated; LIKE: any word
  assert.equal(hit.code, 0, hit.err);
  assert.match(hit.out, /orders schema/);
  const kb = await (await api("/api/c/nodeleg/kb?q=index")).json();
  assert.ok(kb.some(k => k.title === "orders schema" && (!meta.fts || /«/.test(k.hit ?? ""))), JSON.stringify(kb));
  const tasks = await (await api("/api/c/nodeleg/search?q=api")).json();
  assert.ok(tasks.some(t => t.id === "api"), JSON.stringify(tasks));
});

test("knowledge that lasts under node: a duplicate is refused, server-wide entries reach another channel, verify, export", async () => {
  const dup = cli("alpha.explore", ["remember", "context", "orders schema", "orders are indexed and paginated by created_at"]);
  assert.equal(dup.code, 0, dup.err);
  assert.match(dup.out, /^not added: #\d+ .*supersedes=/);
  const g = cli("beta", ["remember", "lesson", "node sqlite needs a flag before 22.13", "pass --experimental-sqlite", "--scope", "server"]);
  assert.match(g.out, /^#1\d{5} remembered/, g.err);
  const id = Number(/#(\d+)/.exec(g.out)[1]);
  assert.equal(cli("beta", ["verify", String(id)]).code, 0);
  const other = await (await api("/api/c/elsewhere/op/join?as=gamma", { method: "POST", body: "{}" })).json();
  assert.ok(!other.error, JSON.stringify(other));
  const there = await (await api(`/api/c/elsewhere/kb?q=${encodeURIComponent("sqlite flag")}`)).json();
  assert.ok(there.some(k => k.id === id && k.scope === "server" && k.verified_by === "beta"), JSON.stringify(there));
  const md = cli("beta", ["knowledge", "export", "--verified"]);
  assert.equal(md.code, 0, md.err);
  assert.match(md.out, /### Lessons\n\n- \*\*node sqlite needs a flag before 22\.13\*\*: pass --experimental-sqlite \(every channel\)/);
  assert.doesNotMatch(md.out, /orders schema/);
});

test("the dashboard: a one-time sign-in code becomes a cookie, then the UI and the API", async () => {
  const { code } = await (await api("/api/login", { method: "POST", body: "{}" })).json();
  const r = await fetch(`${URL_}/?code=${encodeURIComponent(code)}`, { redirect: "manual" });
  assert.equal(r.status, 303);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, new RegExp(`^huddle_session_${PORT}=`));
  assert.equal((await fetch(`${URL_}/?code=${encodeURIComponent(code)}`, { redirect: "manual" })).status, 401); // used once
  const who = await fetch(`${URL_}/api/whoami`, { headers: { cookie } });
  assert.equal(who.status, 200);
  const html = await fetch(`${URL_}/`);
  assert.match(html.headers.get("content-type"), /text\/html/);
  assert.match(await html.text(), /<html/i);
  assert.equal((await fetch(`${URL_}/static/app.css`)).status, 200);
  assert.equal((await fetch(`${URL_}/static/nope.css`)).status, 404);
  assert.match(await (await fetch(`${URL_}/connect.md`)).text(), /Huddle/);
});

test("a live stream (SSE) streams events, and a dropped long-poll frees its waiter", async () => {
  const ac = new AbortController();
  const res = await api("/api/c/nodeleg/live", { signal: ac.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body.getReader(); let buf = "";
  const read = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; buf += new TextDecoder().decode(value); } })().catch(() => {});
  assert.ok(await until(() => buf.includes('"hello"')));
  assert.equal(cli("alpha", ["pub", "deploy.done", "prod", "shipped over sse"]).code, 0);
  assert.ok(await until(() => buf.includes("shipped over sse")), buf);
  ac.abort(); await read;
  // a wait whose client goes away: the server must not hang on to it
  const ac2 = new AbortController();
  const p = api("/api/c/nodeleg/op/wait?as=beta", { method: "POST", body: JSON.stringify({ topics: ["never.*"], timeout: 30 }), signal: ac2.signal }).catch(e => e.name);
  await sleep(300); ac2.abort();
  assert.equal(await p, "AbortError");
  assert.ok(await health(URL_));
});

test("the MCP bridge runs under node: initialize, a tool call, a push", async () => {
  const p = spawn(NODE, [`${DIST}/huddle-mcp.js`], { env: env({ HUDDLE_SESSION: "beta", HUDDLE_AS: "beta" }), stdio: ["pipe", "pipe", "ignore"] });
  const lines = []; let buf = "";
  p.stdout.on("data", c => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } });
    assert.equal((await until(() => lines.find(l => l.id === 1)))?.result.serverInfo.name, "huddle");
    assert.match((await until(() => lines.find(l => l.id === 2)))?.result.content[0].text, /you are beta/);
    await sleep(500); // the push stream connects
    assert.equal(cli("alpha", ["send", "beta", "pushed to you?", "--ask"]).code, 0);
    const push = await until(() => lines.find(l => l.method === "notifications/claude/channel" && /pushed to you\?/.test(l.params.content)));
    assert.equal(push?.params.meta.topic, "ask");
  } finally { p.kill(); }
});

// the hooks as hooks.json runs them, through /bin/sh, with only node on PATH (no bun): the else branch
const HOOKS = JSON.parse(readFileSync(`${ROOT}/plugin/hooks/hooks.json`, "utf8")).hooks;
const nodeOnly = (() => { const d = tmp("path"); symlinkSync(NODE, `${d}/node`); return `${d}:${systemPath(tmp("sys"))}`; })();
// one world per session: its Huddle home keeps what the feed already showed (bin/feed.ts)
const WORLD = tmp("hook");
const hook = (event, input, o = {}, world = WORLD) => {
  const r = spawnSync("/bin/sh", ["-c", HOOKS[event][0].hooks[0].command], {
    env: { ...env({ HUDDLE_HOME: world, CLAUDE_PROJECT_DIR: world, HUDDLE_AUTOSTART: "0", ...o }), PATH: nodeOnly, CLAUDE_PLUGIN_ROOT: `${ROOT}/plugin` },
    cwd: world, input: JSON.stringify(input), encoding: "utf8", timeout: HOOKS[event][0].hooks[0].timeout * 1000 });
  const log = existsSync(`${world}/hooks.log`) ? readFileSync(`${world}/hooks.log`, "utf8") : "";
  return { code: r.status, out: r.stdout, err: r.stderr, log };
};

test("hooks under node: session start joins, listen brings new messages, stop blocks on an open ask", () => {
  assert.notEqual(spawnSync("/bin/sh", ["-c", "command -v bun"], { env: { PATH: nodeOnly } }).status, 0, "no bun on this PATH");
  const envFile = `${tmp("envfile")}/env.sh`;
  const start = hook("SessionStart", { source: "startup", session_id: "beta" }, { HUDDLE_AS: "beta", CLAUDE_ENV_FILE: envFile });
  assert.equal(start.code, 0, start.err);
  assert.ok(start.out, start.log);
  const s = JSON.parse(start.out);
  assert.match(s.hookSpecificOutput.additionalContext, /You are in Huddle channel "nodeleg" as "beta"/);
  assert.match(s.hookSpecificOutput.additionalContext, /`huddle` from Bash \(on PATH/); // the CLI it names: on PATH, no long path
  assert.equal(readFileSync(envFile, "utf8"), `export PATH="${ROOT}/plugin/bin:$PATH"\n`); // through CLAUDE_ENV_FILE, once
  assert.match(s.systemMessage, new RegExp(`Huddle dashboard .*http://127\\.0\\.0\\.1:${PORT}/\\?code=`));
  assert.equal(cli("alpha", ["send", "beta", "a note after your start"]).code, 0);
  const listen = hook("PostToolUse", { session_id: "beta", hook_event_name: "PostToolUse" }, { HUDDLE_AS: "beta" });
  assert.equal(listen.code, 0, listen.err);
  assert.match(JSON.parse(listen.out).hookSpecificOutput.additionalContext, /a note after your start/);
  assert.equal(cli("alpha", ["send", "beta", "still need an answer", "--ask"]).code, 0);
  const stop = hook("Stop", { session_id: "beta" }, { HUDDLE_AS: "beta" });
  assert.equal(stop.code, 0, stop.err);
  const j = JSON.parse(stop.out);
  assert.equal(j.decision, "block");
  assert.match(j.reason, /still need an answer/);
  // down: silence and exit 0
  const down = hook("Stop", { session_id: "beta" }, { HUDDLE_AS: "beta", HUDDLE_URL: "http://127.0.0.1:9" });
  assert.deepEqual([down.code, down.out, down.err], [0, "", ""]);
  assert.match(down.log, /stop: /); // the failure went to hooks.log, not the session
});

test("the launcher runs node when bun is missing, and huddle up starts the bundled server under node", async () => {
  const proj = tmp("proj"); mkdirSync(`${proj}/.git`);
  const port = await freePort(), u = `http://127.0.0.1:${port}`;
  const e = { ...BASE, PATH: nodeOnly, HUDDLE_HOME: `${proj}/.agents/huddle`, HUDDLE_URL: u, HUDDLE_CHANNEL: "up", HUDDLE_AS: "boss", HUDDLE_SESSION: "boss", CLAUDE_PROJECT_DIR: proj };
  const run = (...a) => spawnSync(`${ROOT}/bin/huddle`, a, { env: e, cwd: proj, encoding: "utf8", timeout: 60_000 }); // the repo's link to plugin/bin/huddle
  let pid = 0;
  try {
    const up = run("up");
    assert.equal(up.status, 0, up.stdout + up.stderr);
    assert.match(up.stdout, /Huddle started at/);
    pid = Number(readFileSync(`${proj}/.agents/huddle/huddle.pid`, "utf8"));
    const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
    assert.match(ps, /node .*dist\/server\.js/);
    assert.match(run("server").stdout, /started by huddle up/);
    assert.equal(run("join").status, 0);
    assert.equal(run("down").status, 0);
    assert.equal(await health(u), false);
    pid = 0;
  } finally { if (pid) try { process.kill(pid, "SIGTERM"); } catch {} }
});
