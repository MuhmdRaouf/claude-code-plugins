#!/usr/bin/env bun
// generated from plugin/hooks/stop.ts by scripts/build.mjs (bun run build): edit the source

// plugin/hooks/stop.ts
import { readFileSync as readFileSync3, renameSync as renameSync3, writeFileSync as writeFileSync4, mkdirSync as mkdirSync3 } from "node:fs";

// plugin/bin/identity.ts
import { spawnSync } from "node:child_process";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, statSync as statSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
import { homedir as homedir2 } from "node:os";

// plugin/bin/creds.ts
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
import { createHash } from "node:crypto";

// plugin/server/src/auth.ts
var HEADER = "x-huddle-token";
var CODE_MS = 5 * 6e4;

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
  return d ? `project-${createHash("sha1").update(d).digest("hex").slice(0, 16)}` : null;
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

// plugin/bin/serve.ts
var home_;
var home = () => home_ ??= homeOf();
var SERVER = entry("server");

// plugin/hooks/quiet.ts
import { appendFileSync, existsSync as existsSync3, statSync as statSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { tmpdir } from "node:os";
var CAP = 256 * 1024;
function logHookError(hook, e) {
  try {
    let dir = tmpdir();
    try {
      if (existsSync3(home())) dir = home();
    } catch {
    }
    const f = `${dir}/hooks.log`;
    try {
      if (statSync3(f).size > CAP) writeFileSync3(f, "");
    } catch {
    }
    appendFileSync(f, `${(/* @__PURE__ */ new Date()).toISOString()} ${hook}: ${e instanceof Error ? e.message : String(e)}
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

// plugin/hooks/stop.ts
var KEEP = 500;
await run("stop", async () => {
  const input = await Promise.race([stdinText(), sleep(500).then(() => "")]).then((t) => JSON.parse(t || "{}")).catch(() => ({}));
  if (input.session_id) process.env.HUDDLE_SESSION = String(input.session_id);
  const { url: URL_, channel: CH, as: ME } = identity();
  if (!CH || !ME) return;
  if (input.stop_hook_active || input.agent_id) return;
  const r = await hfetch(`${URL_}/api/c/${CH}/op/inbox?as=${encodeURIComponent(ME)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(5e3)
  });
  const j = await r.json();
  const maxAge = Number(process.env.HUDDLE_STOP_MAX_AGE || 3600) * 1e3;
  const fresh = (m) => {
    const t = Date.parse(String(m?.ts ?? ""));
    return Number.isFinite(t) && Date.now() - t <= maxAge;
  };
  const file = `${home()}/stop-raised.json`, key = `${CH}/${ME}`;
  let raised = {};
  try {
    raised = JSON.parse(readFileSync3(file, "utf8"));
  } catch {
  }
  const seen = new Set(Array.isArray(raised[key]) ? raised[key] : []);
  const open = (Array.isArray(j.result) ? j.result : []).filter((m) => fresh(m) && !seen.has(m.seq));
  if (!open.length) return;
  raised[key] = [...seen, ...open.map((m) => m.seq)].slice(-KEEP);
  mkdirSync3(home(), { recursive: true });
  writeFileSync4(`${file}.tmp`, JSON.stringify(raised));
  renameSync3(`${file}.tmp`, file);
  await stdoutWrite(JSON.stringify({ decision: "block", reason: `Huddle: ${open.length} message(s) wait for your reply before you stop:
${open.map((m) => `  #${m.seq} from ${m.from}: ${m.msg}`).join("\n")}
Answer each with reply (seq, msg). If the work continues after you, wait on the channel instead of stopping.` }) + "\n");
});
