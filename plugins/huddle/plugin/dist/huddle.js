#!/usr/bin/env bun
// generated from plugin/bin/huddle.ts by scripts/build.mjs (bun run build): edit the source
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// plugin/server/src/auth.ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
var HEADER, CODE_MS, credential;
var init_auth = __esm({
  "plugin/server/src/auth.ts"() {
    HEADER = "x-huddle-token";
    CODE_MS = 5 * 6e4;
    credential = () => `hcred_${randomBytes(32).toString("base64url")}`;
  }
});

// plugin/server/src/rt.ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
function pluginRoot() {
  for (let d = dirname(SELF); d !== dirname(d); d = dirname(d)) if (existsSync(join(d, ".claude-plugin"))) return d;
  return join(dirname(SELF), BUNDLED ? ".." : "../..");
}
function runtimeArgs() {
  if (isBun) return [];
  const [maj, min] = process.versions.node.split(".").map(Number);
  return maj < 22 || maj === 22 && min < 13 ? ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"] : [];
}
async function fetchUntimed(url, init = {}) {
  if (isBun) return fetch(url, { ...init, timeout: false });
  const u = new URL(url);
  const { request } = u.protocol === "https:" ? await import("node:https") : await import("node:http");
  const { Readable } = await import("node:stream");
  const headers = {};
  new Headers(init.headers).forEach((v, k) => {
    headers[k] = v;
  });
  const method = init.method ?? "GET";
  return new Promise((resolve, reject) => {
    const req = request(u, { method, headers, signal: init.signal ?? void 0 }, (res) => {
      const h = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) h.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      const status = res.statusCode ?? 502;
      const empty = method === "HEAD" || status === 204 || status === 304;
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res), { status, statusText: res.statusMessage, headers: h }));
    });
    req.on("error", (e) => reject(init.signal?.aborted ? init.signal.reason : e));
    req.end(init.body == null ? void 0 : String(init.body));
  });
}
var isBun, SELF, BUNDLED, PLUGIN, SOURCES, entry, sleep;
var init_rt = __esm({
  "plugin/server/src/rt.ts"() {
    isBun = typeof Bun !== "undefined";
    SELF = fileURLToPath(import.meta.url);
    BUNDLED = /[\\/]dist[\\/][^\\/]+\.js$/.test(SELF);
    PLUGIN = pluginRoot();
    SOURCES = { huddle: "bin/huddle.ts", "huddle-mcp": "bin/huddle-mcp.ts", server: "server/server.ts" };
    entry = (name) => join(PLUGIN, BUNDLED ? `dist/${name}.js` : SOURCES[name]);
    sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  }
});

// plugin/bin/creds.ts
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
import { createHash as createHash2 } from "node:crypto";
function sessionKeys(sid, env2 = process.env) {
  const ks = [sid, env2.HUDDLE_SESSION, env2.CLAUDE_CODE_SESSION_ID].map((k) => clean(String(k ?? ""))).filter(Boolean);
  if (env2.CLAUDE_PID) ks.push(`pid-${clean(env2.CLAUDE_PID)}`);
  if (!ks.length) ks.push("terminal");
  const p = projectKey(env2);
  if (p) ks.push(p);
  return [...new Set(ks)];
}
function projectKey(env2 = process.env) {
  if (env2.HUDDLE_NO_PROJECT_CRED === "1") return null;
  let d = null;
  try {
    d = projectDir(env2);
  } catch {
  }
  return d ? `project-${createHash2("sha1").update(d).digest("hex").slice(0, 16)}` : null;
}
function loadCred(url, sid) {
  for (const k of sessionKeys(sid)) {
    const c = read(join2(sessionsDir(), `${k}.json`));
    if (c && (!url || norm(c.url) === norm(url))) return c;
  }
  return null;
}
function saveCred(c, sid) {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true, mode: 448 });
  try {
    chmodSync(dir, 448);
  } catch {
  }
  for (const k of sessionKeys(sid)) {
    const f = join2(dir, `${k}.json`), tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...c, url: norm(c.url) }), { mode: 384 });
    renameSync(tmp, f);
  }
  try {
    for (const f of readdirSync(dir)) if (!f.startsWith("project-") && Date.now() - statSync(join2(dir, f)).mtimeMs > 7 * 864e5) rmSync(join2(dir, f), { force: true });
  } catch {
  }
}
function forgetCred(sid) {
  for (const k of sessionKeys(sid)) rmSync(join2(sessionsDir(), `${k}.json`), { force: true });
}
function projectCred(dir, url) {
  const c = read(join2(sessionsDir(), `project-${createHash2("sha1").update(dir).digest("hex").slice(0, 16)}.json`));
  return c && (!url || norm(c.url) === norm(url)) ? c : null;
}
function requestLink(sid) {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true, mode: 448 });
  for (const k of sessionKeys(sid).filter((k2) => !k2.startsWith("project-"))) writeFileSync(join2(dir, `${k}.link`), "", { mode: 384 });
}
function requestInvite(o, sid) {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true, mode: 448 });
  for (const k of sessionKeys(sid).filter((k2) => !k2.startsWith("project-"))) writeFileSync(join2(dir, `${k}.invite`), JSON.stringify(o), { mode: 384 });
}
async function hfetch(url, init = {}, sid) {
  const base = new URL(url).origin;
  const { timeout, ...rest2 } = init;
  const go = (t2) => (timeout === false ? fetchUntimed : fetch)(url, { ...rest2, headers: { ...init.headers ?? {}, ...t2 ? { [HEADER]: t2 } : {} } });
  const t = tokenFor(base, sid);
  const r = await go(t);
  if (r.status !== 401) return r;
  const again = tokenFor(base, sid);
  return again && again !== t ? go(again) : r;
}
var sessionsDir, clean, projectDir, setProjectDir, read, norm, tokenFor;
var init_creds = __esm({
  "plugin/bin/creds.ts"() {
    init_auth();
    init_rt();
    sessionsDir = (env2 = process.env) => env2.HUDDLE_SESSIONS_DIR || join2(env2.XDG_STATE_HOME || join2(env2.HOME || homedir(), ".local", "state"), "huddle", "sessions");
    clean = (k) => k.replace(/[^\w.-]/g, "");
    projectDir = (env2) => env2.CLAUDE_PROJECT_DIR || null;
    setProjectDir = (f) => {
      projectDir = f;
    };
    read = (f) => {
      try {
        const c = JSON.parse(readFileSync(f, "utf8"));
        return c && typeof c.credential === "string" && typeof c.url === "string" ? c : null;
      } catch {
        return null;
      }
    };
    norm = (u) => u.replace(/\/$/, "");
    tokenFor = (url, sid) => process.env.HUDDLE_TOKEN || loadCred(url, sid)?.credential || "";
  }
});

// plugin/bin/identity.ts
import { spawnSync } from "node:child_process";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, statSync as statSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
import { homedir as homedir2 } from "node:os";
function mainCheckout(dir = start()) {
  if (mains.has(dir)) return mains.get(dir);
  let main = null;
  for (let d = dir; ; d = dirname2(d)) {
    const g = join3(d, ".git");
    if (existsSync2(g)) {
      if (statSync2(g).isDirectory()) main = d;
      else {
        const gd = /^gitdir:\s*(.+)$/m.exec(readFileSync2(g, "utf8"))?.[1]?.trim() ?? "";
        const i = gd.lastIndexOf("/.git/worktrees/");
        main = i >= 0 ? gd.slice(0, i) : d;
      }
      break;
    }
    if (dirname2(d) === d) break;
  }
  mains.set(dir, main);
  return main;
}
function findConfig(from = start()) {
  const at = (d) => {
    for (const f of [FILE, LEGACY]) {
      const p = join3(d, f);
      if (existsSync2(p)) {
        const l = load(p);
        return l && { ...l, root: d };
      }
    }
    return void 0;
  };
  for (let d = from; ; d = dirname2(d)) {
    const r = at(d);
    if (r !== void 0) return r;
    if (dirname2(d) === d) break;
  }
  const main = mainCheckout(from);
  return main && at(main) || null;
}
function homeOf(found = findConfig()) {
  const h = env("HUDDLE_HOME") ?? (typeof found?.cfg?.home === "string" ? found.cfg.home.replace(/^~(?=\/|$)/, homedir2()) : void 0);
  return h ?? join3(found?.root ?? mainCheckout() ?? start(), ".agents", "huddle");
}
function savedPort(home2 = homeOf()) {
  const c = load(portFile(home2))?.cfg, p = Number(c?.port);
  return Number.isInteger(p) && p > 0 && p < 65536 ? { port: p, auto: c.port_auto === true } : null;
}
function savePort(port, auto, home2 = homeOf()) {
  const f = portFile(home2), c = load(f)?.cfg ?? {};
  c.port = port;
  if (auto) c.port_auto = true;
  else delete c.port_auto;
  mkdirSync2(home2, { recursive: true });
  writeFileSync2(`${f}.${process.pid}.tmp`, JSON.stringify(c, null, 2) + "\n");
  renameSync2(`${f}.${process.pid}.tmp`, f);
  return f;
}
function runningPid(home2 = homeOf()) {
  let pid;
  try {
    pid = Number(readFileSync2(join3(home2, "huddle.pid"), "utf8").trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return ps.status === 0 && /server\.ts|dist\/server\.js/.test(ps.stdout) ? pid : null;
}
function listeningPort(pid) {
  const r = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" });
  const m = /^n(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)$/m.exec(r.stdout ?? "");
  return m ? Number(m[1]) : null;
}
function homeUrl(home2) {
  const s = savedPort(home2);
  if (s) return { url: local(s.port), source: "saved" };
  const pid = runningPid(home2), port = pid ? listeningPort(pid) : null;
  if (!port) return null;
  try {
    savePort(port, false, home2);
  } catch {
  }
  return { url: local(port), source: "running" };
}
function identity(sid) {
  const found = findConfig();
  const c = found?.cfg ?? {};
  const given = String(env("HUDDLE_URL") ?? c.url ?? "").replace(/\/$/, "");
  const port = Number(env("HUDDLE_PORT"));
  const url = given || (Number.isInteger(port) && port > 0 && port < 65536 ? local(port) : "");
  const j = loadCred(url || void 0, sid);
  const h = url || j?.url ? null : homeUrl(homeOf(found));
  return {
    url: url || j?.url || h?.url || "",
    source: given ? env("HUDDLE_URL") ? "env" : "config" : url ? "port" : j?.url ? "credential" : h?.source ?? "none",
    // a member's credential is bound to the channel its invite named, too: that one wins over the file's
    channel: String(env("HUDDLE_CHANNEL") ?? (j && !j.root ? j.channel : void 0) ?? c.channel ?? j?.channel ?? ""),
    // a member's credential is bound to the name it joined as (huddle join may have made the
    // project's name unique for it): that name wins over the project's; a root one acts as anyone
    as: String(env("HUDDLE_AS") ?? (j && !j.root ? j.as : void 0) ?? c.as ?? j?.as ?? ""),
    role: env("HUDDLE_ROLE") ?? c.role,
    push: (env("HUDDLE_PUSH") ?? (Array.isArray(c.push) ? c.push.join(",") : c.push) ?? "task.ready,turn.pass,ask,msg,control.*").split(",").map((x) => x.trim()).filter(Boolean),
    // more channels whose messages the hooks bring into the session (it need not have joined them)
    listen: (env("HUDDLE_LISTEN") ?? (Array.isArray(c.listen) ? c.listen.join(",") : c.listen) ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    wait: Number(env("HUDDLE_WAIT") ?? c.wait ?? 1500),
    context: String(env("HUDDLE_CONTEXT") ?? c.context ?? "auto"),
    // what the hooks bring in after each tool call: messages in full and the rest as one count line
    // (digest), or every event in full (all; HUDDLE_LISTEN_DETAIL, "listen_detail" in the file)
    detail: String(env("HUDDLE_LISTEN_DETAIL") ?? c.listen_detail ?? "digest") === "all" ? "all" : "digest",
    autostart: ["1", "true"].includes(String(env("HUDDLE_AUTOSTART") ?? c.autostart ?? "").toLowerCase()),
    file: found?.file
  };
}
var FILE, LEGACY, load, env, start, mains, portFile, local, slug;
var init_identity = __esm({
  "plugin/bin/identity.ts"() {
    init_creds();
    init_creds();
    FILE = join3(".agents", "huddle", "huddle.json");
    LEGACY = join3(".agents", ".huddle.json");
    load = (f) => {
      try {
        return { file: f, cfg: JSON.parse(readFileSync2(f, "utf8")) };
      } catch {
        return null;
      }
    };
    env = (k) => process.env[k] || void 0;
    start = () => process.env.CLAUDE_PROJECT_DIR || process.cwd();
    mains = /* @__PURE__ */ new Map();
    setProjectDir((env2) => {
      const d = env2.CLAUDE_PROJECT_DIR || process.cwd();
      return mainCheckout(d) ?? env2.CLAUDE_PROJECT_DIR ?? null;
    });
    portFile = (home2 = homeOf()) => join3(home2, "huddle.json");
    local = (port) => `http://127.0.0.1:${port}`;
    slug = (dir, or = "session") => (dir.split("/").filter(Boolean).pop() ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 32).replace(/-+$/, "") || or;
  }
});

// plugin/server/src/port.ts
import { createServer } from "node:net";
async function randomPort(tries = 200) {
  for (let i = 0; i < tries; i++) {
    const p = LOW + Math.floor(Math.random() * (HIGH - LOW + 1));
    if (await portFree(p)) return p;
  }
  throw new Error(`no free port in ${LOW}-${HIGH} after ${tries} tries`);
}
var LOW, HIGH, bindable, portFree;
var init_port = __esm({
  "plugin/server/src/port.ts"() {
    LOW = 1e4;
    HIGH = 65535;
    bindable = (port, host) => new Promise((res) => {
      const s = createServer();
      s.once("error", () => res(false));
      s.listen({ port, host, exclusive: true }, () => s.close(() => res(true)));
    });
    portFree = async (port) => await bindable(port, "127.0.0.1") && await bindable(port, "0.0.0.0");
  }
});

// plugin/bin/serve.ts
var serve_exports = {};
__export(serve_exports, {
  dashboard: () => dashboard,
  dashboardFor: () => dashboardFor,
  dataDir: () => dataDir,
  down: () => down,
  healthy: () => healthy,
  home: () => home,
  inClaude: () => inClaude,
  info: () => info,
  invite: () => invite,
  joinLine: () => joinLine,
  keepOutOfGit: () => keepOutOfGit,
  pidOf: () => pidOf,
  registryFile: () => registryFile,
  servers: () => servers,
  up: () => up
});
import { spawn } from "node:child_process";
import { appendFileSync, existsSync as existsSync3, mkdirSync as mkdirSync3, openSync, readFileSync as readFileSync3, renameSync as renameSync3, rmSync as rmSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3 } from "node:path";
function keepOutOfGit(dir = home()) {
  if (!dir.endsWith("/.agents/huddle")) return null;
  const main = mainCheckout(dirname3(dirname3(dir)));
  if (!main) return null;
  const ex = `${main}/.git/info/exclude`, line = ".agents/huddle/";
  if (existsSync3(ex) && readFileSync3(ex, "utf8").split("\n").includes(line)) return null;
  mkdirSync3(dirname3(ex), { recursive: true });
  appendFileSync(ex, `
${line}
`);
  return ex;
}
async function healthy(url, ms = 1500) {
  if (!url) return false;
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(ms) })).ok;
  } catch {
    return false;
  }
}
async function settled(port) {
  for (let i = 0; i < 5; i++) {
    if (await portFree(port)) return true;
    await sleep(200);
  }
  return false;
}
async function place(url, sid) {
  if (!url) {
    const pid2 = pidOf();
    if (pid2) return { error: `a Huddle server (pid ${pid2}) runs from ${home()} but its port is unknown: save it with huddle setup --port <its port>` };
    const p = await randomPort(), f = savePort(p, true, home());
    return { url: local(p), note: `Huddle picked port ${p} for this project (saved in ${f})` };
  }
  const u = new URL(url);
  if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname)) return { error: `${url} is not a local http address: huddle up only starts a server on this machine` };
  const port = Number(u.port || 80), me = identity(sid), s = savedPort(home());
  if (await settled(port)) {
    if (me.url === url && me.source === "port" && (s?.port !== port || s.auto)) savePort(port, false, home());
    return { url };
  }
  const pid = pidOf();
  if (pid) return { error: `Huddle (pid ${pid}) runs from ${home()} but does not answer at ${url} yet; try again, or see ${LOG()}` };
  if (me.url === url && me.source === "saved" && s?.auto && s.port === port) {
    const p = await randomPort(), f = savePort(p, true, home());
    return { url: local(p), note: `port ${port} is taken by another program: Huddle moved to port ${p} (saved in ${f})` };
  }
  return { error: `port ${port} is taken by another program, not Huddle: free it, or choose another port with huddle setup --port <n>` };
}
async function up(url, budgetMs = 35e3, sid) {
  const deadline = Date.now() + budgetMs, rest2 = () => deadline - Date.now();
  url = url.replace(/\/$/, "");
  if (await healthy(url, Math.max(1, Math.min(1500, rest2())))) return { ok: true, url, msg: `Huddle is up at ${url}` };
  const at = await place(url, sid);
  if ("error" in at) return { ok: false, url, msg: at.error };
  url = at.url;
  const said = at.note ? `${at.note}
` : "";
  const u = new URL(url);
  mkdirSync3(home(), { recursive: true });
  keepOutOfGit();
  const log = openSync(LOG(), "a");
  const held = loadCred(url, sid), first = !existsSync3(`${dataDir()}/auth.json`);
  const root = process.env.HUDDLE_TOKEN || (held?.root ? held.credential : "") || credential();
  const { HUDDLE_TOKEN: _t, ...rest_ } = process.env;
  const child = spawn(process.execPath, [...runtimeArgs(), SERVER], {
    detached: true,
    stdio: ["pipe", log, log],
    env: { ...process.env.HUDDLE_TOKEN ? process.env : rest_, PORT: u.port || "80", HOST: "127.0.0.1", HUDDLE_DATA: dataDir(), HUDDLE_HOME: home(), HUDDLE_REMOVAL_WATCH: "1", HUDDLE_ROOT_STDIN: "1" }
  });
  child.stdin?.on("error", () => {
  });
  child.stdin?.end(`${root}
`);
  child.unref();
  writeFileSync3(PID(), String(child.pid));
  const me = identity(sid);
  if (!process.env.HUDDLE_TOKEN) try {
    saveCred({ url: url.replace(/\/$/, ""), channel: me.channel || void 0, as: me.as || void 0, credential: root, root: true }, sid);
  } catch {
  }
  while (child.exitCode === null && rest2() > 0) {
    if (await healthy(url, Math.max(1, Math.min(500, rest2())))) {
      noteServer(home(), { url, channel: me.channel || void 0, project: mainCheckout() ?? process.env.CLAUDE_PROJECT_DIR ?? void 0, pid: child.pid });
      return { ok: true, created: true, first, url, msg: `${said}Huddle started at ${url}, UI ${url} (pid ${child.pid}; data: ${dataDesc()}; log: ${LOG()}); this session started it and holds its root credential` };
    }
    await sleep(Math.max(0, Math.min(200, rest2())));
  }
  if (child.exitCode !== null && !held?.root && loadCred(url.replace(/\/$/, ""), sid)?.credential === root) forgetCred(sid);
  return { ok: false, url, msg: `${said}Huddle did not come up at ${url}${child.exitCode === null ? ` within ${Math.round(budgetMs / 100) / 10} s (still starting)` : ""}; see ${LOG()}` };
}
async function down(url) {
  if (!url && !pidOf()) return { ok: true, msg: "Huddle is not running" };
  const pid = pidOf();
  if (!pid) {
    rmSync2(PID(), { force: true });
    return await healthy(url) ? { ok: false, msg: `Huddle at ${url} was not started by huddle up: stop it where it runs` } : { ok: true, msg: "Huddle is not running" };
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      rmSync2(PID(), { force: true });
      return { ok: true, msg: `Huddle stopped (pid ${pid})` };
    }
    await sleep(100);
  }
  return { ok: false, msg: `pid ${pid} did not stop; see ${LOG()}` };
}
async function info(url, sid) {
  if (!url) return { ok: false, msg: `Huddle has no port here yet: huddle up picks a random five-digit one and saves it in ${home()}/huddle.json
data: ${dataDesc()}
log:  ${LOG()}` };
  const pid = pidOf(), ok = await healthy(url);
  const who = pid ? `pid ${pid}, started by huddle up` : ok ? "not started by huddle up" : "";
  const link = ok && !inClaude() ? await dashboard(url, sid) : null;
  const hint = link ? "  (signs you in once, for 5 minutes)" : ok && inClaude() ? "  (to sign your browser in: /huddle:open)" : "";
  return { ok, msg: `Huddle is ${ok ? "up" : "down"} at ${url}${who ? ` (${who})` : ""}
UI:   ${link ?? url}${hint}
data: ${dataDesc()}
log:  ${LOG()}` };
}
async function dashboard(url, sid, ms = 1500) {
  try {
    const r = await hfetch(`${url}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(ms) }, sid);
    const j = r.ok ? await r.json() : null;
    return j?.code ? `${url}/?code=${encodeURIComponent(j.code)}` : null;
  } catch {
    return null;
  }
}
async function dashboardFor(url, sid) {
  if (!inClaude()) {
    const d = await dashboard(url, sid);
    return d && `${d}   (signs your browser in once, within 5 min)`;
  }
  try {
    if (!(await hfetch(`${url}/api/whoami`, { signal: AbortSignal.timeout(1500) }, sid)).ok) return null;
  } catch {
    return null;
  }
  requestLink(sid);
  return `${url}   (your sign-in link shows to you, not to Claude, right after this command; /huddle:open makes another)`;
}
async function joinLine(url, o, sid) {
  if (!inClaude()) {
    const inv = await invite(url, o, sid);
    return inv.ok ? { ok: true, claude: false, line: `/huddle:join ${inv.join.slice("huddle join ".length)}` } : inv;
  }
  try {
    const r = await hfetch(`${url}/api/whoami`, { signal: AbortSignal.timeout(1500) }, sid);
    const w = r.ok ? await r.json() : null;
    if (!w) return { ok: false, error: "this session is not in this huddle" };
    if (!w.invite) return { ok: false, error: "this session may not invite: only the session that started Huddle (or one invited with --can-invite) can" };
  } catch {
    return { ok: false, error: `Huddle unreachable at ${url}` };
  }
  requestInvite(o, sid);
  return { ok: true, claude: true, line: "shows to the user (not to you) right after this command, from the plugin's hook; /huddle:invite makes another" };
}
function servers() {
  try {
    const j = JSON.parse(readFileSync3(registryFile(), "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}
function noteServer(home_2, e) {
  try {
    const all = servers();
    all[home_2] = { ...e, at: (/* @__PURE__ */ new Date()).toISOString() };
    mkdirSync3(dirname3(registryFile()), { recursive: true, mode: 448 });
    const f = registryFile();
    writeFileSync3(`${f}.${process.pid}.tmp`, JSON.stringify(all, null, 2));
    renameSync3(`${f}.${process.pid}.tmp`, f);
  } catch {
  }
}
async function invite(url, o = {}, sid, ms = 5e3) {
  try {
    const r = await hfetch(`${url}/api/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o), signal: AbortSignal.timeout(ms) }, sid);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) return { ok: false, error: j.error ?? `HTTP ${r.status}` };
    return { ok: true, token: j.token, id: j.id, expires: j.expires, join: `huddle join ${new URL(url).host} --token ${j.token}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
var home_, home, dataDir, PID, LOG, SERVER, dataDesc, LOOPBACK, pidOf, inClaude, registryFile;
var init_serve = __esm({
  "plugin/bin/serve.ts"() {
    init_identity();
    init_creds();
    init_auth();
    init_port();
    init_rt();
    home = () => home_ ??= homeOf();
    dataDir = () => process.env.HUDDLE_DATA || `${home()}/data`;
    PID = () => `${home()}/huddle.pid`;
    LOG = () => `${home()}/huddle.log`;
    SERVER = entry("server");
    dataDesc = () => `${dataDir()}/channels`;
    LOOPBACK = /* @__PURE__ */ new Set(["127.0.0.1", "localhost"]);
    pidOf = () => runningPid(home());
    inClaude = () => process.env.CLAUDECODE === "1" && !process.stdout.isTTY;
    registryFile = () => `${dirname3(sessionsDir())}/servers.json`;
  }
});

// plugin/server/src/notify.ts
import { spawn as spawn2 } from "node:child_process";
import { appendFileSync as appendFileSync2, existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync4, renameSync as renameSync4, statSync as statSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { delimiter, join as join4 } from "node:path";
function clean2(s, max = 140) {
  let t = String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ");
  t = t.replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|glpat|xox[abpr]|AKIA|ASIA)[-_A-Za-z0-9]{8,}/g, "\u2026").replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, "\u2026").replace(/((?:token|secret|password|passwd|api[-_]?key|key|credential|auth)\s*[=:]\s*)\S+/gi, "$1\u2026");
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "\u2026" : t;
}
function onPath(name) {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (!d) continue;
    const f = join4(d, name);
    try {
      if (existsSync4(f) && statSync3(f).isFile()) return f;
    } catch {
    }
  }
  return null;
}
function notifier() {
  if (process.platform === "darwin") return existsSync4("/usr/bin/osascript") || onPath("osascript") ? "osascript" : null;
  if (process.platform === "linux") return onPath("notify-send") ? "notify-send" : null;
  return null;
}
var WINDOW_MS, SPAWN_TIMEOUT_MS, Notifier;
var init_notify = __esm({
  "plugin/server/src/notify.ts"() {
    WINDOW_MS = () => Number(process.env.HUDDLE_NOTIFY_WINDOW_MS || 10 * 6e4);
    SPAWN_TIMEOUT_MS = 5e3;
    Notifier = class {
      constructor(dir) {
        this.dir = dir;
      }
      dir;
      last = /* @__PURE__ */ new Map();
      cache = null;
      file() {
        return join4(this.dir, "settings.json");
      }
      read() {
        try {
          return JSON.parse(readFileSync4(this.file(), "utf8"));
        } catch {
          return {};
        }
      }
      /** Whether notifications are on (the file is read at most every 2 s). */
      enabled() {
        if (process.env.HUDDLE_NOTIFY === "0") return false;
        if (this.cache && Date.now() - this.cache.at < 2e3) return this.cache.on;
        const on = this.read().notify !== false;
        this.cache = { at: Date.now(), on };
        return on;
      }
      set(on) {
        const s = { ...this.read(), notify: !!on };
        mkdirSync4(this.dir, { recursive: true });
        const tmp = `${this.file()}.${process.pid}.tmp`;
        writeFileSync4(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 384 });
        renameSync4(tmp, this.file());
        this.cache = { at: Date.now(), on: !!on };
        return this.state();
      }
      state() {
        return { notify: this.enabled(), notifier: process.env.HUDDLE_NOTIFY_LOG ? "log" : notifier(), forced_off: process.env.HUDDLE_NOTIFY === "0" };
      }
      /** Show one notification, unless it is off or the same kind+subject showed in the last 10 min. Never throws. */
      send(kind, subject, title, body) {
        try {
          if (!this.enabled()) return false;
          const key = `${kind}\0${subject}`, now = Date.now(), w = WINDOW_MS();
          const prev = this.last.get(key);
          if (prev !== void 0 && now - prev < w) return false;
          this.last.set(key, now);
          if (this.last.size > 2e3) {
            for (const [k, t2] of this.last) if (now - t2 >= w) this.last.delete(k);
          }
          const t = clean2(title, 80), b = clean2(body, 160);
          const log = process.env.HUDDLE_NOTIFY_LOG;
          if (log) {
            appendFileSync2(log, JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), kind, subject, title: t, body: b }) + "\n");
            return true;
          }
          const how = notifier();
          if (!how) return false;
          const args = how === "osascript" ? ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", t, b] : ["-a", "Huddle", t, b];
          const p = spawn2(how === "osascript" ? "osascript" : "notify-send", args, { detached: true, stdio: "ignore" });
          p.on("error", () => {
          });
          const kill = setTimeout(() => {
            try {
              p.kill();
            } catch {
            }
          }, SPAWN_TIMEOUT_MS);
          kill.unref?.();
          p.on("exit", () => clearTimeout(kill));
          p.unref();
          return true;
        } catch {
          return false;
        }
      }
    };
  }
});

// plugin/bin/setup.ts
var setup_exports = {};
__export(setup_exports, {
  setup: () => setup
});
import { existsSync as existsSync5, mkdirSync as mkdirSync5, readFileSync as readFileSync5, rmSync as rmSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname4, join as join5 } from "node:path";
async function setup(sub, o, url) {
  try {
    const found = findConfig();
    if (sub === "show") {
      say(`settings: ${found ? `${found.file} ${JSON.stringify(found.cfg)}` : "none yet (run huddle setup)"}`);
      say(`files:    ${home()}`);
      const sp = savedPort(home());
      say(`port:     ${sp ? `${sp.port}${sp.auto ? " (picked at random by huddle up)" : ""}` : "none yet (huddle up picks a random five-digit one)"}`);
      say(`notify:   desktop notifications ${new Notifier(dataDir()).enabled() ? "on" : "off"} (huddle setup --no-notify | --notify)`);
      say((await info(url)).msg);
      return 0;
    }
    if (sub) fail(`unknown setup ${sub}: use show, or flags only`);
    if (o.no_notify || o.notify === true) say(await notify(!o.no_notify, url));
    if (!found && !o.new && !o.port) {
      const n = await joinRunning(o);
      if (n !== null) return n;
    }
    if (o.channel && !o.as || o.as && !o.channel) fail("--channel and --as go together");
    const port = o.port === void 0 ? void 0 : Number(o.port);
    if (port !== void 0 && !(Number.isInteger(port) && port > 0 && port < 65536)) fail(`--port ${o.port}: a port number`);
    const root = found?.root ?? mainCheckout() ?? (process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const file = join5(root, FILE), legacy = join5(root, LEGACY);
    const next = { ...read2(legacy), ...read2(file) };
    if (o.channel) Object.assign(next, { channel: String(o.channel), as: String(o.as) });
    else if (!next.channel || !next.as) {
      const n = slug(root, "huddle");
      next.channel ||= n;
      next.as ||= n;
    }
    if (o.role) next.role = String(o.role);
    if (o.autostart === true || next.autostart === void 0 && !o.no_autostart) next.autostart = true;
    if (o.no_autostart) next.autostart = false;
    if (typeof o.listen === "string") next.listen = o.listen.split(",").map((x) => x.trim()).filter(Boolean);
    if (o.no_listen) delete next.listen;
    mkdirSync5(dirname4(file), { recursive: true });
    writeFileSync5(file, JSON.stringify(next, null, 2) + "\n");
    say(`${file}: ${JSON.stringify(next)}`);
    if (existsSync5(legacy)) {
      rmSync3(legacy);
      say(`folded ${legacy} into it`);
    }
    const ex = keepOutOfGit(join5(root, ".agents", "huddle"));
    if (ex) say(`kept .agents/huddle/ out of git (${ex})`);
    say(`channels: ${dataDir()}/channels`);
    if (port !== void 0) {
      const was = url;
      say(`port:     ${port} (saved in ${savePort(port, false, home())})`);
      const me = identity();
      url = ["env", "config", "port"].includes(me.source) ? me.url : `http://127.0.0.1:${port}`;
      if (url !== `http://127.0.0.1:${port}`) say(`note:     ${me.source === "port" ? "HUDDLE_PORT" : me.source === "env" ? "HUDDLE_URL" : "huddle.json's url"} wins: the server stays at ${url}`);
      if (o.start && pidOf() !== null && was && was !== url) say((await down(was)).msg);
    }
    if (o.restart && pidOf() !== null) {
      say((await down(url)).msg);
      o.start = true;
    }
    if (o.start) {
      const r = await up(url);
      say(r.msg);
      if (!r.ok) return 5;
      url = r.url;
      if (r.created) {
        const inv = await joinLine(url, { channel: next.channel, description: "made by huddle setup" });
        if (inv.ok) say(inv.claude ? `join:     the line to paste into another Claude session ${inv.line}` : `join:     ${inv.line}   (paste into another Claude session; valid 24 h)`);
        const d = await dashboardFor(url);
        if (d) say(`UI:       ${d}`);
      }
    } else if (!(await info(url)).ok) say("start it with: huddle up");
    return 0;
  } catch (e) {
    if (e instanceof SetupError) {
      console.error(`huddle setup: ${e.message}`);
      return 2;
    }
    throw e;
  }
}
async function joinRunning(o) {
  const mine = home();
  const live = [];
  for (const [h, e2] of Object.entries(servers())) if (h !== mine && e2?.url && await healthy(e2.url, 800)) live.push({ home: h, ...e2 });
  if (!live.length) return null;
  const e = live[0], where = e.project ?? e.home;
  const held = loadCred(e.url);
  if (held) {
    say(`This project is already in the Huddle at ${e.url} (channel ${held.channel ?? e.channel}, as ${held.as}). To start a separate one: /huddle:setup --new`);
    return 0;
  }
  const c = e.project ? projectCred(e.project, e.url) : null;
  if (!c) {
    say(`A Huddle already runs for ${where} at ${e.url} (channel ${e.channel ?? "?"}). To join it, run /huddle:invite in a session there and paste its join line here (/huddle:join \u2026). To start a separate one anyway: /huddle:setup --new`);
    return 0;
  }
  const made = await fetch(`${e.url}/api/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", [HEADER]: c.credential },
    body: JSON.stringify({ ttl: 120, single_use: true, channel: e.channel, description: "huddle setup in another project" }),
    signal: AbortSignal.timeout(5e3)
  }).catch(() => null);
  const tk = made?.ok ? await made.json().catch(() => ({})) : {};
  if (!tk.token) {
    say(`A Huddle already runs for ${where} at ${e.url}, but this machine holds no credential there that may invite. Run /huddle:invite in a session there and paste its join line here, or /huddle:setup --new for a separate one.`);
    return 0;
  }
  const root = mainCheckout() ?? (process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const wish = o.as ? String(o.as) : slug(root);
  const r = await fetch(`${e.url}/api/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: tk.token, name: wish, unique: !o.as, channel: e.channel })
  }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!r?.ok || !j.credential) {
    say(`A Huddle already runs for ${where} at ${e.url}, but joining it failed (${j.error ?? "unreachable"}). /huddle:setup --new starts a separate one.`);
    return 5;
  }
  const channel = String(o.channel ?? j.channel ?? e.channel ?? "");
  saveCred({ url: e.url, channel, as: j.name, credential: j.credential });
  await fetch(`${e.url}/api/c/${channel}/op/join?as=${encodeURIComponent(j.name)}`, {
    method: "POST",
    headers: { "content-type": "application/json", [HEADER]: j.credential },
    body: JSON.stringify({ role: o.role, task: "set up" }),
    signal: AbortSignal.timeout(5e3)
  }).catch(() => {
  });
  say(`Joined the Huddle that already runs for ${where}: ${e.url}, channel ${channel}, as ${j.name}. This project's sessions are in it from now on (no second Huddle started; /huddle:setup --new starts a separate one).`);
  const d = await dashboardFor(e.url);
  if (d) say(`UI:       ${d}`);
  return 0;
}
async function notify(on, url) {
  new Notifier(dataDir()).set(on);
  let there = "";
  if (url) {
    const r = await hfetch(`${url}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notify: on }), signal: AbortSignal.timeout(3e3) }).catch(() => null);
    if (r?.ok) there = ` (also on the running Huddle at ${url})`;
  }
  return `notify:   desktop notifications ${on ? "on" : "off"}${there}`;
}
var say, SetupError, fail, read2;
var init_setup = __esm({
  "plugin/bin/setup.ts"() {
    init_identity();
    init_serve();
    init_creds();
    init_auth();
    init_notify();
    init_creds();
    say = (s) => console.log(s);
    SetupError = class extends Error {
    };
    fail = (m) => {
      throw new SetupError(m);
    };
    read2 = (f) => {
      try {
        return JSON.parse(readFileSync5(f, "utf8"));
      } catch {
        return {};
      }
    };
  }
});

// plugin/bin/huddle.ts
init_identity();
init_creds();
init_rt();
import { readFileSync as readFileSync6 } from "node:fs";
var argv = process.argv.slice(2);
var opt = {};
var pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2).replace(/-/g, "_");
    if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opt[k] = argv[++i];
    else opt[k] = true;
  } else pos.push(a);
}
var ID = identity();
var URL_ = ID.url;
var CH = String(opt.channel ?? ID.channel);
var ME = String(opt.as_session ?? ID.as);
var RAW = { ...opt };
var AS = opt.as ? String(opt.as) : void 0;
delete opt.as;
delete opt.channel;
var cmd = pos.shift() ?? "help";
var die = (m, code = 2) => {
  console.error(`huddle: ${m}`);
  process.exit(code);
};
var NO_PORT = "Huddle has no port here yet: start it with huddle up (it picks a random five-digit port and saves it)";
if (cmd === "help" || cmd === "-h") {
  const lines = readFileSync6(`${PLUGIN}/bin/huddle.ts`, "utf8").split("\n").slice(1);
  console.log(lines.slice(1, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
if (cmd === "setup") process.exit(await (await Promise.resolve().then(() => (init_setup(), setup_exports))).setup(pos.shift(), RAW, URL_));
if (cmd === "up" || cmd === "down" || cmd === "server") {
  const S = await Promise.resolve().then(() => (init_serve(), serve_exports));
  if (cmd === "up" && opt.port !== void 0) {
    const p = Number(opt.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) die(`--port ${opt.port}: a port number`);
    process.env.HUDDLE_PORT = String(p);
    delete process.env.HUDDLE_URL;
    URL_ = `http://127.0.0.1:${p}`;
  }
  const r = await (cmd === "up" ? S.up : cmd === "down" ? S.down : S.info)(URL_);
  if (r.url) URL_ = r.url;
  (r.ok ? console.log : console.error)(r.msg);
  if (r.created) {
    const inv = await S.joinLine(URL_, { channel: CH || void 0, description: "made by huddle up" });
    if (inv.ok) console.log(inv.claude ? `join:  the line another Claude session pastes ${inv.line}` : `join:  huddle join ${inv.line.slice("/huddle:join ".length)}   (valid 24 h; in a Claude session: ${inv.line})`);
    const d = await S.dashboardFor(URL_);
    if (d) console.log(`UI:    ${d}`);
  }
  process.exit(r.ok ? 0 : cmd === "down" ? 2 : 5);
}
var admin = async (method, path, b) => {
  if (!URL_) die(NO_PORT, 5);
  const r = await hfetch(`${URL_}${path}`, { method, headers: { "content-type": "application/json" }, ...b === void 0 ? {} : { body: JSON.stringify(b) } }).catch(() => die(`Huddle unreachable at ${URL_} (start it: huddle up)`, 5));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) die(j.error ?? `HTTP ${r.status}`);
  return j;
};
var seconds = (v) => {
  const m = /^(\d+)([smhd]?)$/.exec(String(v ?? "").trim());
  return m ? Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] : die(`--ttl ${v}: a number with s, m, h or d (0 = never expires)`);
};
if (cmd === "token") {
  const sub = pos.shift() ?? "list";
  if (sub === "create") {
    const S = await Promise.resolve().then(() => (init_serve(), serve_exports));
    if (!URL_) die(NO_PORT, 5);
    const o = {
      ttl: opt.ttl === void 0 ? void 0 : seconds(opt.ttl),
      single_use: !!opt.single_use,
      can_invite: !!opt.can_invite,
      channel: CH || void 0,
      description: typeof opt.description === "string" ? opt.description : void 0
    };
    if (opt.print_join_command && S.inClaude()) {
      const l = await S.joinLine(URL_, o);
      if (!l.ok) die(l.error);
      console.log(`invite made for channel ${CH || "(the joiner's)"}: the /huddle:join line ${l.line}`);
      process.exit(0);
    }
    const inv = await S.invite(URL_, o);
    if (!inv.ok) die(inv.error);
    if (opt.print_join_command) console.log(`${inv.join}
# in another Claude session: /huddle:join ${inv.join.slice("huddle join ".length)}`);
    else console.log(`${inv.token}  (id ${inv.id}, expires ${inv.expires ?? "never"})`);
  } else if (sub === "list") {
    const l = await admin("GET", "/api/tokens");
    console.log(l.length ? l.map((t) => `${t.id}  expires ${t.expires ?? "never"}  ${t.single_use ? "single-use" : "multi-use"}  uses ${t.uses}${t.can_invite ? "  can-invite" : ""}${t.channel ? `  channel ${t.channel}` : ""}${t.description ? `  ${t.description}` : ""}`).join("\n") : "no tokens");
  } else if (sub === "delete") {
    const id = pos[0] ?? die("token delete <id>");
    await admin("DELETE", `/api/tokens/${encodeURIComponent(id.split(".")[0])}`);
    console.log(`token ${id.split(".")[0]} deleted`);
  } else die("token create|list|delete");
  process.exit(0);
}
if (cmd === "members") {
  const l = await admin("GET", "/api/members");
  console.log(l.length ? l.map((m) => `${m.name}  since ${m.since}  last seen ${m.seen}  invite ${m.invite}${m.can_invite ? "  can-invite" : ""}`).join("\n") : "no members (the creator holds the root credential)");
  process.exit(0);
}
if (cmd === "kick") {
  const n = pos[0] ?? die("kick <name>");
  await admin("DELETE", `/api/members/${encodeURIComponent(n)}`);
  console.log(`${n} kicked: its credential no longer works`);
  process.exit(0);
}
if (cmd === "open") {
  if (!URL_) die(NO_PORT, 5);
  const d = await (await Promise.resolve().then(() => (init_serve(), serve_exports))).dashboardFor(URL_);
  if (!d) die("this session is not in a huddle here: join with the command its owner gives you (/huddle:join <host:port> --token \u2026)");
  console.log(`dashboard: ${d}`);
  process.exit(0);
}
if (cmd === "join" && (opt.token || /^(https?:\/\/)?[\w.-]+:\d+\/?$/.test(pos[0] ?? ""))) {
  const host = pos.shift() ?? die("join <host:port> --token <id.secret>");
  const url = (/^https?:\/\//.test(host) ? host : `http://${host}`).replace(/\/$/, "");
  if (typeof opt.token !== "string") die("join <host:port> --token <id.secret>");
  const fallback = slug(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const given = RAW.as ?? opt.name, prev = loadCred(url);
  const wish = String(given ?? (prev && !prev.root && prev.as) ?? (ID.as ? ID.as.split(".")[0] : fallback));
  const r = await fetch(`${url}/api/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: opt.token, name: wish, unique: !given && !(prev && !prev.root && prev.as), channel: ID.channel || void 0 })
  }).catch(() => die(`Huddle unreachable at ${url}`, 5));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) die(j.error ?? `HTTP ${r.status}`);
  const name = String(j.name ?? wish);
  const channel = String(RAW.channel ?? (j.channel || ID.channel || ""));
  if (!channel) die("joined, but the invite names no channel: run join again with --channel <c>");
  if (!RAW.channel && j.channel && ID.channel && ID.channel !== j.channel) console.error(`huddle: joined channel ${j.channel} (the invite's); this project's file named ${ID.channel}`);
  saveCred({ url, channel, as: name, credential: j.credential });
  console.error(`huddle: joined ${url} as ${name}; this project's next sessions are in it too (the invite is not kept)`);
  URL_ = url;
  CH = channel;
  ME = name;
  delete opt.token;
  delete opt.name;
  const d = await (await Promise.resolve().then(() => (init_serve(), serve_exports))).dashboardFor(url);
  if (d) console.error(`huddle: dashboard ${d}`);
}
if (cmd === "whoami") {
  console.log(JSON.stringify(ID));
  process.exit(0);
}
if (!CH || !ME) die("not in a huddle: in a session that is in one, run /huddle:invite and paste its join line here (/huddle:join \u2026); or run /huddle:setup to start one");
if (!URL_) die(NO_PORT, 5);
async function call(op, args) {
  let res;
  try {
    res = await hfetch(`${URL_}/api/c/${CH}/op/${op}?as=${encodeURIComponent(ME)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...args, ...AS ? { as: AS } : {} }),
      // @ts-ignore Bun: no client-side timeout; waits are bounded by their own timeout
      timeout: false
    });
  } catch {
    return die(`Huddle unreachable at ${URL_} (start it: huddle up)`, 5);
  }
  const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || j.error) die(/^no operation /.test(String(j.error)) && op === cmd.replace(/-/g, "_") ? `no command or operation "${cmd}" (huddle help lists them)` : j.error ?? `HTTP ${res.status}`, res.status === 423 ? 4 : 2);
  return j;
}
var out = (r) => console.log(r.text ?? JSON.stringify(r.result, null, opt.pretty ? 1 : 0));
var list = (v) => v === void 0 ? void 0 : Array.isArray(v) ? v : String(v).split(",").map((s) => s.trim()).filter(Boolean);
var rest = () => pos.join(" ");
switch (cmd) {
  case "listen": {
    const chans = RAW.channel ? [CH] : [CH, ...ID.listen.filter((c) => c !== CH)];
    const { readFileSync: readFileSync7, writeFileSync: writeFileSync6 } = await import("node:fs");
    const state = opt.state ? (() => {
      try {
        return JSON.parse(readFileSync7(String(opt.state), "utf8"));
      } catch {
        return {};
      }
    })() : {};
    const follow = async (ch) => {
      let last = state[ch] ?? (chans.length === 1 ? Number(opt.after ?? 0) : 0), connected = false;
      const print = (e) => {
        if (e.seq <= last) return;
        last = e.seq;
        if (opt.state) {
          state[ch] = last;
          writeFileSync6(String(opt.state), JSON.stringify(state));
        }
        if (e.from !== ME || opt.all) console.log(JSON.stringify({ channel: ch, ...e }));
      };
      if (!last && chans.length > 1 && opt.after == null) {
        const r = await hfetch(`${URL_}/api/c/${ch}/timeline?limit=1`, { headers: {} }).catch(() => null);
        if (r?.ok) last = (await r.json()).at(-1)?.seq ?? 0;
      }
      const replay = async () => {
        if (!last) return;
        const r = await hfetch(`${URL_}/api/c/${ch}/timeline?after=${last}&limit=2000`, { headers: {} });
        if (r.ok) for (const e of await r.json()) print(e);
      };
      setInterval(() => {
        if (connected) replay().catch(() => {
        });
      }, Number(process.env.HUDDLE_LISTEN_RESYNC_MS || 3e4));
      for (; ; ) {
        const ac = new AbortController();
        let quiet;
        const alive = () => {
          clearTimeout(quiet);
          quiet = setTimeout(() => ac.abort(), Number(process.env.HUDDLE_LISTEN_QUIET_MS || 45e3));
        };
        try {
          alive();
          const res = await hfetch(`${URL_}/api/c/${ch}/live${opt.all ? "" : `?as=${encodeURIComponent(ME)}`}`, {
            headers: { accept: "text/event-stream" },
            signal: ac.signal,
            // @ts-ignore Bun: a stream has no client timeout
            timeout: false
          });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          connected = true;
          const dec = new TextDecoder();
          let buf = "";
          for await (const chunk of res.body) {
            alive();
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
              if (!data) continue;
              const m = JSON.parse(data);
              if (m.type === "hello") await replay();
              else if (m.type === "event") print(m.data);
              else if (opt.all) console.log(JSON.stringify(m));
            }
          }
        } catch {
          if (!connected) die(`Huddle unreachable at ${URL_} (start it: huddle up)`, 5);
        } finally {
          clearTimeout(quiet);
        }
        await sleep(2e3);
      }
    };
    await Promise.all(chans.map(follow));
    break;
  }
  case "join": {
    const context = opt.fresh ? "fresh" : opt.sync ? "sync" : ["sync", "fresh"].includes(ID.context) ? ID.context : void 0;
    out(await call("join", { role: opt.role ?? ID.role, label: opt.label, task: opt.task ?? (rest() || void 0), context }));
    break;
  }
  case "map":
    out(await call("map", { json: opt.json }));
    break;
  case "assign": {
    const session = pos[0] ?? die("assign <session> --fresh|--sync|--default [--task id]");
    out(await call("assign", { session, context: opt.fresh ? "fresh" : opt.sync ? "sync" : null, task: opt.task }));
    break;
  }
  case "brief": {
    const session = pos.shift() ?? die("brief <session> <text>");
    out(await call("brief", { session, msg: rest() || die("brief <session> <text>") }));
    break;
  }
  case "wait": {
    const timeout = Number(opt.timeout ?? 0);
    const topics = pos.length ? pos : list(opt.topics) ?? [];
    for (const end = timeout > 0 ? Date.now() + timeout * 1e3 : Infinity; ; ) {
      const left = end === Infinity ? 600 : Math.max(1, Math.ceil((end - Date.now()) / 1e3));
      const r = await call("wait", { topics, timeout: Math.min(600, left) });
      if (r.result.kind === "timeout" && Date.now() < end) continue;
      console.log(JSON.stringify(r.result));
      process.exit(r.result.kind === "event" ? 0 : r.result.kind === "message" ? 3 : 124);
    }
  }
  case "wait-task": {
    const id = pos[0] ?? die("wait-task <id>");
    for (; ; ) {
      const r = await call("wait_task", { id, timeout: 600 });
      if (r.result.kind !== "timeout") {
        console.log(JSON.stringify(r.result));
        process.exit(0);
      }
    }
  }
  case "gate": {
    if (opt.no_block) {
      const r = await call("gate", { block: false });
      console.log(JSON.stringify(r.result));
      process.exit(r.result.control === "run" ? 0 : 4);
    }
    for (; ; ) {
      const res = await hfetch(`${URL_}/api/c/${CH}/op/gate?as=${encodeURIComponent(ME)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeout: 600, ...AS ? { as: AS } : {} }),
        // @ts-ignore
        timeout: false
      }).then((r) => r.json()).catch(() => null);
      if (res?.result?.control === "run") {
        console.log(JSON.stringify(res.result));
        process.exit(0);
      }
      if (res?.error) die(res.error);
      if (!res) {
        console.error("huddle: unreachable; treated as paused, retrying in 5 s");
        await sleep(5e3);
      }
    }
  }
  case "ack":
    out(await call("ack", { seq: Number(pos[0] ?? die("ack <seq>")) }));
    break;
  case "send": {
    const to = pos.length > 1 && /^[a-z][a-z0-9_.-]*$/.test(pos[0]) && opt.all === void 0 ? pos.shift() : void 0;
    out(await call("send", { to: opt.to ?? to, msg: rest(), ask: !!opt.ask, task: opt.task }));
    break;
  }
  case "reply": {
    const seq = Number(pos.shift() ?? die("reply <seq> <msg>"));
    out(await call("reply", { seq, msg: rest() || "ack" }));
    break;
  }
  case "pub": {
    const [topic, ref, ...m] = pos;
    if (!topic || !ref || !m.length) die("pub <topic> <ref> <msg>");
    out(await call("publish", { topic, ref, msg: m.join(" "), to: opt.to, ask: !!opt.ask, key: opt.key }));
    break;
  }
  case "doing":
  case "done":
  case "blocked":
  case "skipped":
  case "todo": {
    const id = pos.shift() ?? die(`${cmd} <task id> [note]`);
    out(await call("task_status", { id, status: cmd, note: rest() }));
    break;
  }
  case "new":
    out(await call("task_create", { title: rest(), owner: opt.owner, after: list(opt.after), id: opt.id, what: opt.what }));
    break;
  case "start":
    out(await call("start", { id: pos[0] }));
    break;
  case "finish":
    out(await call("finish", { id: opt.id, note: rest() || die("finish <evidence>"), result: opt.result, title: opt.title }));
    break;
  case "depend": {
    const owner = pos.shift() ?? die("depend <session> <title>");
    const r = await call("depend", { owner, title: rest() || die("depend <session> <title>"), what: opt.what, id: opt.id, timeout: 600 });
    console.log(JSON.stringify(r.result));
    process.exit(r.result.woke?.kind === "event" ? 0 : r.result.woke ? 124 : 0);
  }
  case "handoff": {
    const to = pos.shift() ?? die("handoff <to> <msg>");
    const r = await call("handoff", { to, msg: rest() || die("handoff <to> <msg>"), title: opt.title, after: list(opt.after), wait: opt.no_wait ? false : void 0, timeout: 600 });
    console.log(JSON.stringify(r.result));
    process.exit(!r.result.woke || r.result.woke.kind === "event" ? 0 : r.result.woke.kind === "message" ? 3 : 124);
  }
  case "ask": {
    const to = pos.shift() ?? die("ask <session> <question>");
    const r = await call("ask_wait", { to, msg: rest() || die("ask <session> <question>"), timeout: Number(opt.timeout ?? 600) });
    if (r.result.answer !== void 0) {
      console.log(r.result.answer);
      process.exit(0);
    }
    console.log(JSON.stringify(r.result));
    process.exit(124);
  }
  case "remember": {
    const [kind, title, ...b] = pos;
    if (!kind || !title || !b.length) die("remember <kind> <title> <body>");
    out(await call("remember", { kind, title, body: b.join(" "), tags: list(opt.tags), refs: list(opt.refs), task: opt.task, supersedes: opt.supersedes ? Number(opt.supersedes) : void 0, scope: opt.scope, force: !!opt.force }));
    break;
  }
  case "verify":
    out(await call("verify", { id: Number(pos[0] ?? die("verify <id> [--undo]")), undo: !!opt.undo }));
    break;
  case "share":
    out(await call("share", { id: Number(pos[0] ?? die("share <id>")) }));
    break;
  case "knowledge": {
    if (pos[0] !== "export") die("knowledge export [--verified]");
    const r = await hfetch(`${URL_}/api/c/${CH}/knowledge.md${opt.verified ? "?verified=1" : ""}`, { headers: {} }).catch(() => die(`Huddle unreachable at ${URL_} (start it: huddle up)`, 5));
    if (!r.ok) die((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    process.stdout.write(await r.text());
    break;
  }
  case "recall":
    out(await call("recall", { q: rest(), kind: opt.kind, tag: opt.tag, limit: opt.limit ? Number(opt.limit) : void 0 }));
    break;
  case "kb":
    out(await call("kb", { id: Number(pos[0] ?? die("kb <id>")) }));
    break;
  case "task":
    out(await call("task", { id: pos[0] ?? die("task <id>"), json: opt.json }));
    break;
  case "pause":
  case "resume": {
    const target = pos.shift() ?? die(`${cmd} <session>`);
    out(await call(cmd, { target, why: rest() }));
    break;
  }
  case "pass": {
    const to = pos.shift() ?? die("pass <to> [msg]");
    out(await call("pass", { to, msg: rest() }));
    break;
  }
  case "leave":
    out(await call("leave", { summary: rest() }));
    break;
  case "ops": {
    const res = await hfetch(`${URL_}/mcp/${CH}?as=${encodeURIComponent(ME)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }).then((r) => r.json()).catch(() => die("unreachable", 5));
    for (const t of res.result.tools) console.log(`${t.name.padEnd(12)} ${t.description}`);
    break;
  }
  default: {
    const args = {};
    for (const [k, v] of Object.entries(opt)) args[k] = typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v === "true" ? true : v === "false" ? false : v;
    for (const k of ["topics", "after", "tags", "refs", "members"]) if (typeof args[k] === "string") args[k] = list(args[k]);
    if (pos.length && args.msg === void 0) args.msg = rest();
    out(await call(cmd.replace(/-/g, "_"), args));
  }
}
process.exit(0);
