#!/usr/bin/env bun
// generated from plugin/hooks/session-start.ts by scripts/build.mjs (bun run build): edit the source

// plugin/bin/identity.ts
import { spawnSync } from "node:child_process";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, statSync as statSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
import { homedir as homedir2 } from "node:os";

// plugin/bin/creds.ts
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
import { createHash as createHash2 } from "node:crypto";

// plugin/server/src/auth.ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
var HEADER = "x-huddle-token";
var CODE_MS = 5 * 6e4;
var credential = () => `hcred_${randomBytes(32).toString("base64url")}`;

// plugin/server/src/rt.ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var isBun = typeof Bun !== "undefined";
var SELF = fileURLToPath(import.meta.url);
var BUNDLED = /[\\/]dist[\\/][^\\/]+\.js$/.test(SELF);
function pluginRoot() {
  for (let d = dirname(SELF); d !== dirname(d); d = dirname(d)) if (existsSync(join(d, ".claude-plugin"))) return d;
  return join(dirname(SELF), BUNDLED ? ".." : "../..");
}
var PLUGIN = pluginRoot();
var SOURCES = { huddle: "bin/huddle.ts", "huddle-mcp": "bin/huddle-mcp.ts", server: "server/server.ts" };
var entry = (name) => join(PLUGIN, BUNDLED ? `dist/${name}.js` : SOURCES[name]);
function runtimeArgs() {
  if (isBun) return [];
  const [maj, min] = process.versions.node.split(".").map(Number);
  return maj < 22 || maj === 22 && min < 13 ? ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"] : [];
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function stdinText() {
  if (isBun) return Bun.stdin.text();
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))).on("error", reject);
  });
}
var stdoutWrite = (s) => new Promise((r) => {
  process.stdout.write(s, () => r());
});
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

// plugin/bin/creds.ts
var sessionsDir = (env2 = process.env) => env2.HUDDLE_SESSIONS_DIR || join2(env2.XDG_STATE_HOME || join2(env2.HOME || homedir(), ".local", "state"), "huddle", "sessions");
var clean = (k) => k.replace(/[^\w.-]/g, "");
function sessionKeys(sid, env2 = process.env) {
  const ks = [sid, env2.HUDDLE_SESSION, env2.CLAUDE_CODE_SESSION_ID].map((k) => clean(String(k ?? ""))).filter(Boolean);
  if (env2.CLAUDE_PID) ks.push(`pid-${clean(env2.CLAUDE_PID)}`);
  if (!ks.length) ks.push("terminal");
  const p = projectKey(env2);
  if (p) ks.push(p);
  return [...new Set(ks)];
}
var projectDir = (env2) => env2.CLAUDE_PROJECT_DIR || null;
var setProjectDir = (f) => {
  projectDir = f;
};
function projectKey(env2 = process.env) {
  if (env2.HUDDLE_NO_PROJECT_CRED === "1") return null;
  let d = null;
  try {
    d = projectDir(env2);
  } catch {
  }
  return d ? `project-${createHash2("sha1").update(d).digest("hex").slice(0, 16)}` : null;
}
var read = (f) => {
  try {
    const c = JSON.parse(readFileSync(f, "utf8"));
    return c && typeof c.credential === "string" && typeof c.url === "string" ? c : null;
  } catch {
    return null;
  }
};
var norm = (u) => u.replace(/\/$/, "");
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
function takeLinkRequest(sid) {
  let asked = false;
  for (const k of sessionKeys(sid).filter((k2) => !k2.startsWith("project-"))) {
    const f = join2(sessionsDir(), `${k}.link`);
    try {
      statSync(f);
      asked = true;
      rmSync(f, { force: true });
    } catch {
    }
  }
  return asked;
}
var tokenFor = (url, sid) => process.env.HUDDLE_TOKEN || loadCred(url, sid)?.credential || "";
async function hfetch(url, init = {}, sid) {
  const base = new URL(url).origin;
  const { timeout, ...rest } = init;
  const go = (t2) => (timeout === false ? fetchUntimed : fetch)(url, { ...rest, headers: { ...init.headers ?? {}, ...t2 ? { [HEADER]: t2 } : {} } });
  const t = tokenFor(base, sid);
  const r = await go(t);
  if (r.status !== 401) return r;
  const again = tokenFor(base, sid);
  return again && again !== t ? go(again) : r;
}

// plugin/bin/identity.ts
var FILE = join3(".agents", "huddle", "huddle.json");
var LEGACY = join3(".agents", ".huddle.json");
var load = (f) => {
  try {
    return { file: f, cfg: JSON.parse(readFileSync2(f, "utf8")) };
  } catch {
    return null;
  }
};
var env = (k) => process.env[k] || void 0;
var start = () => process.env.CLAUDE_PROJECT_DIR || process.cwd();
var mains = /* @__PURE__ */ new Map();
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
setProjectDir((env2) => {
  const d = env2.CLAUDE_PROJECT_DIR || process.cwd();
  return mainCheckout(d) ?? env2.CLAUDE_PROJECT_DIR ?? null;
});
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
var portFile = (home2 = homeOf()) => join3(home2, "huddle.json");
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
var local = (port) => `http://127.0.0.1:${port}`;
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
function contextFor(source, setting = "auto") {
  if (setting === "sync" || setting === "fresh") return setting;
  if (source === "resume") return "sync";
  if (source === "clear" || source === "compact") return "fresh";
  return void 0;
}

// plugin/bin/serve.ts
import { spawn } from "node:child_process";
import { appendFileSync, existsSync as existsSync3, mkdirSync as mkdirSync3, openSync, readFileSync as readFileSync3, renameSync as renameSync3, rmSync as rmSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3 } from "node:path";

// plugin/server/src/port.ts
import { createServer } from "node:net";
var LOW = 1e4;
var HIGH = 65535;
var bindable = (port, host) => new Promise((res) => {
  const s = createServer();
  s.once("error", () => res(false));
  s.listen({ port, host, exclusive: true }, () => s.close(() => res(true)));
});
var portFree = async (port) => await bindable(port, "127.0.0.1") && await bindable(port, "0.0.0.0");
async function randomPort(tries = 200) {
  for (let i = 0; i < tries; i++) {
    const p = LOW + Math.floor(Math.random() * (HIGH - LOW + 1));
    if (await portFree(p)) return p;
  }
  throw new Error(`no free port in ${LOW}-${HIGH} after ${tries} tries`);
}

// plugin/bin/serve.ts
var home_;
var home = () => home_ ??= homeOf();
var dataDir = () => process.env.HUDDLE_DATA || `${home()}/data`;
var PID = () => `${home()}/huddle.pid`;
var LOG = () => `${home()}/huddle.log`;
var SERVER = entry("server");
var dataDesc = () => `${dataDir()}/channels`;
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
var LOOPBACK = /* @__PURE__ */ new Set(["127.0.0.1", "localhost"]);
async function healthy(url, ms = 1500) {
  if (!url) return false;
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(ms) })).ok;
  } catch {
    return false;
  }
}
var pidOf = () => runningPid(home());
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
  const deadline = Date.now() + budgetMs, rest = () => deadline - Date.now();
  url = url.replace(/\/$/, "");
  if (await healthy(url, Math.max(1, Math.min(1500, rest())))) return { ok: true, url, msg: `Huddle is up at ${url}` };
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
  while (child.exitCode === null && rest() > 0) {
    if (await healthy(url, Math.max(1, Math.min(500, rest())))) {
      noteServer(home(), { url, channel: me.channel || void 0, project: mainCheckout() ?? process.env.CLAUDE_PROJECT_DIR ?? void 0, pid: child.pid });
      return { ok: true, created: true, first, url, msg: `${said}Huddle started at ${url}, UI ${url} (pid ${child.pid}; data: ${dataDesc()}; log: ${LOG()}); this session started it and holds its root credential` };
    }
    await sleep(Math.max(0, Math.min(200, rest())));
  }
  if (child.exitCode !== null && !held?.root && loadCred(url.replace(/\/$/, ""), sid)?.credential === root) forgetCred(sid);
  return { ok: false, url, msg: `${said}Huddle did not come up at ${url}${child.exitCode === null ? ` within ${Math.round(budgetMs / 100) / 10} s (still starting)` : ""}; see ${LOG()}` };
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
var registryFile = () => `${dirname3(sessionsDir())}/servers.json`;
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

// plugin/bin/feed.ts
import { mkdirSync as mkdirSync4, readdirSync as readdirSync2, readFileSync as readFileSync4, renameSync as renameSync4, rmSync as rmSync3, statSync as statSync3, writeFileSync as writeFileSync4 } from "node:fs";
var LIMIT = 30;
var read2 = (f) => {
  try {
    return JSON.parse(readFileSync4(f, "utf8"));
  } catch {
    return {};
  }
};
var timeline = async (url, ch, after, limit, ms) => {
  try {
    const r = await hfetch(`${url}/api/c/${encodeURIComponent(ch)}/timeline?after=${after}&limit=${limit}`, { headers: {}, signal: AbortSignal.timeout(ms) });
    const j = r.ok ? await r.json() : null;
    return Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
};
async function feed(id, home2, session, o) {
  const ms = Math.max(1, Math.min(1500, o.ms ?? 1500));
  const sid = session.replace(/[^\w.-]/g, "");
  if (!id.channel || !id.as || !sid) return "";
  const dir = `${home2}/seen`, file = `${dir}/${sid}.json`;
  const seen = o.start ? {} : read2(file);
  const chans = [id.channel, ...id.listen.filter((c) => c !== id.channel)];
  const parts = await Promise.all(chans.map(async (ch) => {
    const from = seen[ch];
    if (from == null) {
      const last = await timeline(id.url, ch, 0, 1, ms);
      if (last) seen[ch] = last.at(-1)?.seq ?? 0;
      return "";
    }
    const evs = await timeline(id.url, ch, from, LIMIT, ms);
    if (!evs?.length) return "";
    seen[ch] = evs.at(-1).seq;
    const mine = (f) => f === id.as || String(f).startsWith(`${id.as}.`);
    const shown = evs.filter((e) => !mine(e.from) && !e.topic.startsWith("session."));
    if (!shown.length) return "";
    const other = ch === id.channel ? "" : ` (channel ${ch})`;
    const talk = (e) => id.detail === "all" || ["msg", "ask", "reply"].includes(e.topic) || e.needs_reply || e.to === id.as;
    const full = shown.filter(talk), rest = shown.filter((e) => !talk(e));
    const lines = full.map((e) => {
      const to = e.to ?? "all", over = e.to && e.to !== id.as;
      const tail = over ? " [overheard: between other sessions]" : e.needs_reply ? ` [answer: reply seq=${e.seq}${other}]` : "";
      return `#${e.seq} ${e.from} \u2192 ${to} (${e.topic}): ${String(e.msg ?? "").slice(0, 600)}${tail}`;
    });
    if (rest.length) {
      const n = (p) => rest.filter((e) => e.topic.startsWith(p)).length, t = n("task."), k = n("kb."), x = rest.length - t - k;
      const parts2 = [t && `${t} task update${t > 1 ? "s" : ""}`, k && `${k} knowledge entr${k > 1 ? "ies" : "y"}`, x && `${x} other event${x > 1 ? "s" : ""}`].filter(Boolean);
      lines.push(`+${parts2.join(", +")} (events after=${rest[0].seq - 1} for them)`);
    }
    const older = evs.length === LIMIT ? `
(older ones: events after=${from})` : "";
    return `Huddle, new in "${ch}" (you are ${id.as}):
${lines.join("\n")}${older}`;
  }));
  try {
    mkdirSync4(dir, { recursive: true });
    writeFileSync4(`${file}.tmp`, JSON.stringify(seen));
    renameSync4(`${file}.tmp`, file);
    if (o.start) {
      for (const f of readdirSync2(dir))
        if (Date.now() - statSync3(`${dir}/${f}`).mtimeMs > 7 * 864e5) rmSync3(`${dir}/${f}`, { force: true });
    }
  } catch {
  }
  return parts.filter(Boolean).join("\n\n");
}

// plugin/hooks/quiet.ts
import { appendFileSync as appendFileSync2, existsSync as existsSync4, statSync as statSync4, writeFileSync as writeFileSync5 } from "node:fs";
import { tmpdir } from "node:os";
var CAP = 256 * 1024;
function logHookError(hook, e) {
  try {
    let dir = tmpdir();
    try {
      if (existsSync4(home())) dir = home();
    } catch {
    }
    const f = `${dir}/hooks.log`;
    try {
      if (statSync4(f).size > CAP) writeFileSync5(f, "");
    } catch {
    }
    appendFileSync2(f, `${(/* @__PURE__ */ new Date()).toISOString()} ${hook}: ${e instanceof Error ? e.message : String(e)}
`);
  } catch {
  }
}
async function run(hook, body) {
  const out = (e) => {
    logHookError(hook, e);
    process.exit(0);
  };
  process.on("uncaughtException", out);
  process.on("unhandledRejection", out);
  try {
    await body();
  } catch (e) {
    logHookError(hook, e);
  }
  process.exit(0);
}

// plugin/hooks/session-start.ts
import { appendFileSync as appendFileSync3, readFileSync as readFileSync5 } from "node:fs";
var BUDGET = 3e3;
var T0 = Date.now();
var left = () => Math.max(1, BUDGET - (Date.now() - T0));
var stdin = () => Promise.race([stdinText(), sleep(500).then(() => "")]);
await run("session-start", async () => {
  const input = process.stdin.isTTY ? {} : await stdin().then((t) => JSON.parse(t || "{}")).catch(() => ({}));
  if (input.session_id) process.env.HUDDLE_SESSION = String(input.session_id);
  onPath();
  let { url: URL_, channel: CH, as: ME, role: ROLE, context: SETTING, autostart, listen } = identity();
  if (!CH || !ME) return;
  const context = contextFor(input.source, SETTING);
  const CLI = "huddle";
  const out = (s, owner) => stdoutWrite(JSON.stringify({ ...owner ? { systemMessage: owner } : {}, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: s } }) + "\n");
  const join4 = async (ms) => {
    if (!URL_) throw new Error("no port yet");
    const r = await hfetch(`${URL_}/api/c/${CH}/op/join?as=${encodeURIComponent(ME)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: ROLE, task: "session started", ...context ? { context } : {}, ...input.session_id ? { claude_session: input.session_id } : {} }),
      signal: AbortSignal.timeout(ms)
    });
    return { status: r.status, ...await r.json() };
  };
  let j = await join4(Math.min(autostart ? 1e3 : 2500, left())).catch(() => null), started = "", created = false;
  if (!j && autostart && left() > 300) {
    const u = await up(URL_, left());
    started = u.ok ? `Huddle started (port ${new URL(u.url).port})` : u.msg;
    created = !!u.first;
    URL_ = u.url;
    if (u.ok && left() > 50) j = await join4(left()).catch(() => null);
  }
  if (!j) {
    await out(`Huddle channel "${CH}" is configured but the service at ${URL_ || "its address (none yet: huddle up picks a port)"} does not answer${started ? ` (${started})` : ""}. Treat yourself as paused for shared work: tell the user to start it (/huddle:setup, or \`${CLI} up\`), then call status.`);
  } else if (j.status === 401) {
    await out(`Huddle "${CH}" runs at ${URL_}, but this session holds no credential for it (it was never invited here, or it was kicked). To get in: in a session that is in it, the user runs /huddle:invite and pastes its join line here (/huddle:join \u2026); if no such session is left, /huddle:setup --restart in the project that started it. Until then, leave Huddle alone.`);
  } else if (j.error) {
    await out(`Huddle: joining channel ${CH} as ${ME} failed: ${j.error}. Tell the owner; do not work around it.`);
  } else {
    await feed(identity(), home(), String(input.session_id ?? ""), { cli: CLI, start: true, ms: left() });
    let invited = "", owner = [];
    if (created) {
      const inv = await invite(URL_, { channel: CH, description: "made at server start" }, void 0, left());
      if (inv.ok) {
        invited = " The user got a join line for other Claude sessions (valid 24 h; /huddle:invite makes more).";
        owner.push(`Huddle: to add another Claude session, paste into it: /huddle:join ${new URL(URL_).host} --token ${inv.token}  (valid 24 h; /huddle:invite makes more)`);
      }
    }
    const asked = takeLinkRequest(input.session_id);
    if ((asked || !input.source || input.source === "startup") && left() > 50) {
      const d = await dashboard(URL_, input.session_id, left());
      if (d) owner.push(`Huddle dashboard (signs your browser in once, within 5 min; expired? /huddle:open makes another): ${d}`);
    }
    await out(`You are in Huddle channel "${CH}" as "${ME}" (already joined: call status to refresh, join only to change your role).${started ? ` ${started}.` : ""}${invited} Use the huddle skill: tools mcp__plugin_huddle_huddle__*, or \`${CLI}\` from Bash (on PATH; subagents use it with HUDDLE_AS=${ME}.<role>). New messages in the channel${listen.length ? ` and in ${listen.join(", ")}` : ""} arrive in your context after each tool call, also those between other sessions (overheard: knowledge, not yours to answer). Joined just now:
${j.text}`, owner.join("\n") || void 0);
  }
});
function onPath() {
  const f = process.env.CLAUDE_ENV_FILE;
  if (!f) return;
  const bin = `${PLUGIN}/bin`, line = `export PATH="${bin}:$PATH"`;
  try {
    if (readFileSync5(f, "utf8").includes(line)) return;
  } catch {
  }
  try {
    appendFileSync3(f, `${line}
`);
  } catch {
  }
}
