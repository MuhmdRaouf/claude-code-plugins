#!/usr/bin/env bun
// generated from plugin/hooks/approve.ts by scripts/build.mjs (bun run build): edit the source
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
var HEADER, CODE_MS;
var init_auth = __esm({
  "plugin/server/src/auth.ts"() {
    HEADER = "x-huddle-token";
    CODE_MS = 5 * 6e4;
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
function stdinText() {
  if (isBun) return Bun.stdin.text();
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))).on("error", reject);
  });
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
var isBun, SELF, BUNDLED, PLUGIN, SOURCES, entry, sleep, stdoutWrite;
var init_rt = __esm({
  "plugin/server/src/rt.ts"() {
    isBun = typeof Bun !== "undefined";
    SELF = fileURLToPath(import.meta.url);
    BUNDLED = /[\\/]dist[\\/][^\\/]+\.js$/.test(SELF);
    PLUGIN = pluginRoot();
    SOURCES = { huddle: "bin/huddle.ts", "huddle-mcp": "bin/huddle-mcp.ts", server: "server/server.ts" };
    entry = (name) => join(PLUGIN, BUNDLED ? `dist/${name}.js` : SOURCES[name]);
    sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    stdoutWrite = (s) => new Promise((r) => {
      process.stdout.write(s, () => r());
    });
  }
});

// plugin/bin/creds.ts
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
import { createHash } from "node:crypto";
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
  try {
    if (d) d = realpathSync(d);
  } catch {
  }
  return d ? `project-${createHash("sha1").update(d).digest("hex").slice(0, 16)}` : null;
}
function loadCred(url, sid) {
  for (const k of sessionKeys(sid)) {
    const c = read(join2(sessionsDir(), `${k}.json`));
    if (c && (!url || norm(c.url) === norm(url))) return c;
  }
  return null;
}
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
var identity_exports = {};
__export(identity_exports, {
  FILE: () => FILE,
  LEGACY: () => LEGACY,
  contextFor: () => contextFor,
  findConfig: () => findConfig,
  hfetch: () => hfetch,
  homeOf: () => homeOf,
  identity: () => identity,
  listeningPort: () => listeningPort,
  local: () => local,
  mainCheckout: () => mainCheckout,
  portFile: () => portFile,
  runningPid: () => runningPid,
  savePort: () => savePort,
  savedPort: () => savedPort,
  slug: () => slug,
  tokenFor: () => tokenFor
});
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
function contextFor(source, setting = "auto") {
  if (setting === "sync" || setting === "fresh") return setting;
  if (source === "resume") return "sync";
  if (source === "clear" || source === "compact") return "fresh";
  return void 0;
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

// plugin/server/src/rules.ts
var W = String.raw`(?:^|[;&|(\x60]|\$\(|\bsudo\s+|\bexec\s+|\bthen\s+|\bdo\s+)\s*`;
var E = String.raw`(?![\w-])`;
var git = (sub) => String.raw`${W}git(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+${sub}`;
var RULES = [
  {
    id: "force_push",
    label: "Force push",
    help: "git push --force, -f, --force-with-lease or a +ref",
    on: true,
    re: [new RegExp(git(String.raw`push${E}[^;&|\n]*?(?:\s--force(?:-with-lease)?\b|\s-[a-zA-Z]*f[a-zA-Z]*\b|\s\+\S)`))]
  },
  {
    id: "delete",
    label: "Delete files or branches",
    help: "rm, git rm, git clean, git branch -d/-D, git push --delete, find -delete, rmdir, unlink",
    on: true,
    re: [
      new RegExp(`${W}(?:rm|rmdir|unlink|shred|trash)${E}(?!\\s*=)`),
      new RegExp(git(String.raw`(?:rm|clean)${E}`)),
      new RegExp(git(String.raw`branch${E}[^;&|\n]*\s(?:-[a-zA-Z]*[dD]\b|--delete\b)`)),
      new RegExp(git(String.raw`push${E}[^;&|\n]*(?:\s--delete\b|\s-d\b|\s:\S)`)),
      new RegExp(String.raw`${W}find\b[^;&|\n]*\s-delete\b`)
    ]
  },
  { id: "git_push", label: "Git push", help: "every git push", on: false, re: [new RegExp(git(String.raw`push${E}`))] },
  {
    id: "git_tag",
    label: "Git tag",
    help: "creating, moving or deleting a tag (listing is fine)",
    on: false,
    re: [new RegExp(git(String.raw`tag${E}(?!\s*(?:$|[;&|)]|-l\b|--list\b|-n\d*\b|--contains\b|--points-at\b|--merged\b|--no-merged\b|--sort\b|--format\b|-v\b|--verify\b))`))]
  },
  {
    id: "publish",
    label: "Publish a package",
    help: "npm/pnpm/yarn/bun publish, cargo publish, twine upload, gem push, poetry/uv/flit publish, docker push, gh release create",
    on: false,
    re: [
      new RegExp(`${W}(?:npm|pnpm|yarn|bun|cargo|poetry|uv|flit|vsce|ovsx|hatch)\\s+(?:[\\w-]+\\s+)?publish${E}`),
      new RegExp(`${W}(?:python3?\\s+-m\\s+)?twine\\s+upload${E}`),
      new RegExp(`${W}gem\\s+push${E}`),
      new RegExp(`${W}docker\\s+(?:image\\s+)?push${E}`),
      new RegExp(`${W}gh\\s+release\\s+create${E}`)
    ]
  }
];
var DEFAULTS = Object.fromEntries(RULES.map((r) => [r.id, r.on]));
function matching(command) {
  const c = String(command ?? "");
  if (!c.trim() || c.length > 1e5) return [];
  return RULES.filter((r) => r.re.some((x) => x.test(c)));
}

// plugin/hooks/quiet.ts
import { appendFileSync, existsSync as existsSync3, statSync as statSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { tmpdir } from "node:os";

// plugin/bin/serve.ts
init_identity();
init_creds();
init_auth();
init_rt();
var home_;
var home = () => home_ ??= homeOf();
var SERVER = entry("server");

// plugin/hooks/quiet.ts
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

// plugin/hooks/approve.ts
init_rt();
await run("approve", async () => {
  const input = await Promise.race([stdinText(), sleep(300).then(() => "")]).then((t) => JSON.parse(t || "{}")).catch(() => ({}));
  if (input.tool_name && input.tool_name !== "Bash") return;
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (!matching(command).length) return;
  if (input.session_id) process.env.HUDDLE_SESSION = String(input.session_id);
  const { identity: identity2, hfetch: hfetch2 } = await Promise.resolve().then(() => (init_identity(), identity_exports));
  const id = identity2();
  if (!id.channel || !id.as || !id.url) return;
  const r = await hfetch2(`${id.url}/api/c/${encodeURIComponent(id.channel)}/x/approval?as=${encodeURIComponent(id.as)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, claude_session: input.session_id }),
    signal: AbortSignal.timeout(600)
  });
  if (!r.ok) return;
  const j = await r.json();
  if (j.ask !== true) return;
  await stdoutWrite(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: String(j.reason ?? "Huddle: the owner asked to approve this command").slice(0, 300)
  } }) + "\n");
});
