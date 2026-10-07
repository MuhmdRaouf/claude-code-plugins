#!/usr/bin/env bun
// generated from plugin/bin/huddle-mcp.ts by scripts/build.mjs (bun run build): edit the source

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
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      for (let i2 = 0; i2 < res.rawHeaders.length; i2 += 2) h.append(res.rawHeaders[i2], res.rawHeaders[i2 + 1]);
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
var tokenFor = (url, sid) => process.env.HUDDLE_TOKEN || loadCred(url, sid)?.credential || "";
async function hfetch(url, init = {}, sid) {
  const base = new URL(url).origin;
  const { timeout: timeout2, ...rest } = init;
  const go = (t2) => (timeout2 === false ? fetchUntimed : fetch)(url, { ...rest, headers: { ...init.headers ?? {}, ...t2 ? { [HEADER]: t2 } : {} } });
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
        const i2 = gd.lastIndexOf("/.git/worktrees/");
        main = i2 >= 0 ? gd.slice(0, i2) : d;
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
var portFile = (home = homeOf()) => join3(home, "huddle.json");
function savedPort(home = homeOf()) {
  const c = load(portFile(home))?.cfg, p = Number(c?.port);
  return Number.isInteger(p) && p > 0 && p < 65536 ? { port: p, auto: c.port_auto === true } : null;
}
function savePort(port2, auto, home = homeOf()) {
  const f = portFile(home), c = load(f)?.cfg ?? {};
  c.port = port2;
  if (auto) c.port_auto = true;
  else delete c.port_auto;
  mkdirSync2(home, { recursive: true });
  writeFileSync2(`${f}.${process.pid}.tmp`, JSON.stringify(c, null, 2) + "\n");
  renameSync2(`${f}.${process.pid}.tmp`, f);
  return f;
}
var local = (port2) => `http://127.0.0.1:${port2}`;
var slug = (dir, or = "session") => (dir.split("/").filter(Boolean).pop() ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 32).replace(/-+$/, "") || or;
function runningPid(home = homeOf()) {
  let pid;
  try {
    pid = Number(readFileSync2(join3(home, "huddle.pid"), "utf8").trim());
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
function homeUrl(home) {
  const s2 = savedPort(home);
  if (s2) return { url: local(s2.port), source: "saved" };
  const pid = runningPid(home), port2 = pid ? listeningPort(pid) : null;
  if (!port2) return null;
  try {
    savePort(port2, false, home);
  } catch {
  }
  return { url: local(port2), source: "running" };
}
function identity(sid) {
  const found = findConfig();
  const c = found?.cfg ?? {};
  const given = String(env("HUDDLE_URL") ?? c.url ?? "").replace(/\/$/, "");
  const port2 = Number(env("HUDDLE_PORT"));
  const url = given || (Number.isInteger(port2) && port2 > 0 && port2 < 65536 ? local(port2) : "");
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

// plugin/server/src/knowledge.ts
import { existsSync as existsSync3, statSync as statSync3 } from "node:fs";
import { isAbsolute } from "node:path";

// plugin/server/src/channel.ts
import { AsyncLocalStorage } from "node:async_hooks";
var OWNER = "owner";
var parentOf = (n) => n.includes(".") ? n.slice(0, n.indexOf(".")) : null;
var STATES = ["working", "waiting", "paused", "idle", "blocked", "left"];
var KB_KINDS = ["fact", "lesson", "decision", "context", "result", "howto"];
var STATUSES = ["todo", "doing", "done", "blocked", "skipped"];
var NOTE_KINDS = ["note", "change", "optimize", "enhance", "direction", "question"];
var CONTEXTS = ["sync", "fresh"];
var STOP = new Set("the and for with from that this into what when then than have has are was were will not but you your our its any all each per via use uses using".split(" "));
var HuddleError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
var JSON_FIELDS = ["alternatives", "how", "snippets", "verify", "files", "refs"];
var TEXT_FIELDS = ["what", "why", "use", "value", "rollback", "notes", "kind", "gate", "risk"];
var EDITABLE = /* @__PURE__ */ new Set(["title", ...JSON_FIELDS, ...TEXT_FIELDS]);
var held = new AsyncLocalStorage();

// plugin/server/src/touches.ts
var WINDOW_MIN = 30;
var KEEP_DAYS = 90;
var iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
var mins = (at) => Math.max(0, Math.round((Date.now() - Date.parse(at)) / 6e4));
var ago = (at) => {
  const m = mins(at);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
function clean2(path, repo) {
  const p = String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  const r = String(repo ?? "");
  if (!p || p.length > 500 || p.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(p) || /[\0\n]/.test(p)) throw new HuddleError(400, "path: a file path relative to its repo");
  if (!r || r.length > 500 || /[\0\n]/.test(r)) throw new HuddleError(400, "repo: the repo the file is in");
  return { path: p, repo: r };
}
function touched(ch, me, a) {
  const { path, repo } = clean2(a.path, a.repo);
  const name = parentOf(me) ?? me;
  return ch.serial(async () => {
    if (!await ch.session(name)) throw new HuddleError(404, `"${name}" has not joined channel ${ch.name}`);
    const now2 = Date.now(), at = iso(now2), since = iso(now2 - WINDOW_MIN * 6e4);
    const others = await ch.store.all(`SELECT t.session, t.at FROM touches t JOIN sessions s ON s.name = t.session
      WHERE t.repo=? AND t.path=? AND t.session != ? AND t.at > ? AND s.state != 'left' ORDER BY t.at DESC`, [repo, path, name, since]);
    const mine = await ch.store.get("SELECT warned_at FROM touches WHERE session=? AND repo=? AND path=?", [name, repo, path]);
    const warn = others.length > 0 && !(mine?.warned_at && mine.warned_at > since);
    await ch.store.run(`INSERT INTO touches (session, repo, path, at, warned_at) VALUES (?,?,?,?,?)
      ON CONFLICT(session, repo, path) DO UPDATE SET at=excluded.at, warned_at=COALESCE(excluded.warned_at, touches.warned_at)`, [name, repo, path, at, warn ? at : null]);
    if (Math.random() < 0.02) await ch.store.run("DELETE FROM touches WHERE at < ?", [iso(now2 - KEEP_DAYS * 864e5)]);
    if (others.length) ch.emit("conflict", { repo, path, sessions: [name, ...others.map((o) => o.session)] });
    const who = others.map((o) => `${o.session} edited ${path} ${ago(o.at)}`);
    const line = warn ? `Huddle: ${who.length > 1 ? `${who[0]}, ${others.slice(1).map((o) => `${o.session} ${ago(o.at)}`).join(", ")}` : who[0]} \u2014 coordinate with ${others.length > 1 ? "them" : "it"} (send, or ask) before you change more.` : null;
    return { path, repo, others: others.map((o) => ({ session: o.session, at: o.at })), warn: line };
  });
}
async function lastEdit(ch, ref, after) {
  const name = ref.split("/").pop() ?? ref;
  const rows = await ch.store.all("SELECT path, MAX(at) at FROM touches WHERE path LIKE ? ESCAPE '\\' AND at > ? GROUP BY path", [`%${name.replace(/[\\%_]/g, "\\$&")}`, after]);
  const hit = rows.filter((r) => ref === r.path || ref.endsWith(`/${r.path}`)).map((r) => r.at).sort().pop();
  return hit ?? null;
}

// plugin/server/src/knowledge.ts
var SHARED_BASE = 1e5;
var STALE_DAYS = Number(process.env.HUDDLE_KB_STALE_DAYS) > 0 ? Number(process.env.HUDDLE_KB_STALE_DAYS) : 30;
var now = () => (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "Z");
var P = (v, d) => {
  if (v == null) return d;
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};
var shared = /* @__PURE__ */ new WeakMap();
var sharedOf = (ch) => shared.get(ch) ?? null;
var isShared = (id) => id >= SHARED_BASE;
var needShared = (ch) => sharedOf(ch) ?? (() => {
  throw new HuddleError(400, "this server keeps no server-wide knowledge");
})();
var storeOf = (ch, id) => isShared(id) ? needShared(ch).store : ch.store;
var sharedRetired = async (s2) => new Set((await s2.store.all("SELECT supersedes AS id FROM knowledge WHERE supersedes IS NOT NULL")).map((r) => r.id));
var fileRef = (r) => {
  if (/^[a-z][\w+.-]*:\/\//i.test(r) || /^#?\d+$/.test(r) || /\s/.test(r.trim())) return null;
  return r.trim().replace(/:\d+(-\d+)?$/, "").replace(/^\.\//, "") || null;
};
async function staleness(ch, r) {
  const since = [r.created_at, r.verified_at].filter(Boolean).sort().pop();
  const days = Math.floor((Date.now() - Date.parse(r.created_at)) / 864e5);
  if (Date.now() - Date.parse(since) > STALE_DAYS * 864e5) return { age_days: days, stale: `not verified for over ${STALE_DAYS} days` };
  const repo = ch.config().repo;
  for (const ref of P(r.refs, []).map(String).map(fileRef).filter(Boolean)) {
    if (await lastEdit(ch, ref, since)) return { age_days: days, stale: `${ref} was edited since` };
    const f = isAbsolute(ref) ? ref : repo ? `${repo}/${ref}` : null;
    try {
      if (f && existsSync3(f) && statSync3(f).mtimeMs > Date.parse(since) + 1e3) return { age_days: days, stale: `${ref} changed since` };
    } catch {
    }
  }
  return { age_days: days, stale: null };
}
async function shape(ch, r, hit) {
  const s2 = await staleness(ch, r);
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    by: r.by,
    tags: P(r.tags, []),
    refs: P(r.refs, []),
    task: r.task_id ?? null,
    created_at: r.created_at,
    hit: hit ?? r.hit ?? String(r.body ?? "").slice(0, 200),
    scope: isShared(r.id) ? "server" : "channel",
    origin: r.origin ?? null,
    verified_by: r.verified_by ?? null,
    verified_at: r.verified_at ?? null,
    ...s2
  };
}
async function recall(ch, q, o = {}) {
  const lim = Math.max(1, Math.min(50, o.limit ?? 10));
  const mine = await ch.recall(q, { ...o, limit: 50 });
  const rows = new Map((await Promise.all(mine.map((k) => ch.store.get("SELECT * FROM knowledge WHERE id=?", [k.id])))).filter(Boolean).map((r) => [r.id, r]));
  let list = mine.map((k, i2) => ({ row: { ...rows.get(k.id), hit: k.hit }, rank: i2 }));
  const S = sharedOf(ch);
  if (S) {
    const gone = await sharedRetired(S);
    const theirs = q.trim() ? S.store.fts ? await S.store.searchKnowledge(q.trim(), 60) : await S.store.all(`SELECT *, substr(body,1,200) hit FROM knowledge WHERE ${q.trim().split(/\s+/).slice(0, 8).map(() => "(title LIKE ? OR body LIKE ?)").join(" OR ")} LIMIT 60`, q.trim().split(/\s+/).slice(0, 8).flatMap((w) => [`%${w}%`, `%${w}%`])) : await S.store.all("SELECT *, substr(body,1,200) hit FROM knowledge ORDER BY id DESC LIMIT 60");
    const ok = theirs.filter((r) => !gone.has(r.id) && (!o.kind || r.kind === o.kind) && (!o.by || r.by === o.by || String(r.by).startsWith(o.by + ".")) && (!o.tag || P(r.tags, []).includes(o.tag)));
    list = [...list, ...ok.map((row, i2) => ({ row, rank: i2 + 0.5 }))];
    if (!q.trim()) list.sort((a, b2) => String(b2.row.created_at).localeCompare(String(a.row.created_at)));
    else list.sort((a, b2) => a.rank - b2.rank);
  }
  list.sort((a, b2) => Number(!!b2.row.verified_at) - Number(!!a.row.verified_at));
  return Promise.all(list.slice(0, lim).map((x) => shape(ch, x.row)));
}
async function kb(ch, id) {
  if (!isShared(id)) {
    const k = await ch.kb(id);
    const r2 = await ch.store.get("SELECT * FROM knowledge WHERE id=?", [id]);
    return { ...k, ...await shape(ch, r2), body: k.body, hits: k.hits, superseded_by: k.superseded_by, moved_to: r2.moved_to ?? null };
  }
  const S = needShared(ch);
  const r = await S.serial(() => S.store.get("UPDATE knowledge SET hits = hits + 1 WHERE id=? RETURNING *", [id]));
  if (!r) throw new HuddleError(404, `no knowledge entry ${id}`);
  const by = await S.store.get("SELECT id FROM knowledge WHERE supersedes=?", [id]);
  return { ...await shape(ch, r), body: r.body, hits: r.hits, supersedes: r.supersedes ?? null, superseded_by: by?.id ?? null, moved_to: null };
}
var words = (s2) => new Set(String(s2).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []);
var jaccard = (a, b2) => {
  if (!a.size || !b2.size) return 0;
  let n = 0;
  for (const w of a) if (b2.has(w)) n++;
  return n / (a.size + b2.size - n);
};
async function similar(ch, k) {
  const t = words(k.title), b2 = words(k.body);
  const look = async (store, gone) => (await store.all("SELECT id, kind, title, body, by FROM knowledge ORDER BY id DESC LIMIT 500")).filter((r) => !gone.has(r.id));
  const S = sharedOf(ch);
  const rows = [...await look(ch.store, await ch.retired()), ...S ? await look(S.store, await sharedRetired(S)) : []];
  let best = null;
  for (const r of rows) {
    const ts = jaccard(t, words(r.title)), bs = jaccard(b2, words(r.body));
    const dup = ts >= 0.75 || ts >= 0.5 && bs >= 0.5 || bs >= 0.85;
    const score = Math.max(ts, (ts + bs) / 2, bs);
    if (dup && (!best || score > best.score)) best = { row: r, score };
  }
  return best;
}
async function remember(ch, me, k) {
  if (k.scope && !["channel", "server"].includes(k.scope)) throw new HuddleError(400, "scope: channel (default) or server (every channel on this server)");
  if (!k.force && k.supersedes == null && k.title?.trim() && k.body?.trim()) {
    const d = await similar(ch, k);
    if (d) {
      const r = d.row;
      return {
        duplicate: true,
        added: false,
        existing: { id: r.id, kind: r.kind, title: r.title, by: r.by, scope: isShared(r.id) ? "server" : "channel" },
        hint: `#${r.id} [${r.kind}] "${r.title}" (${r.by}) already says this. To replace it, remember again with supersedes=${r.id}; to add yours anyway, force=true; or verify #${r.id} if it is still right.`
      };
    }
  }
  if (k.supersedes != null && isShared(Number(k.supersedes)) !== (k.scope === "server")) throw new HuddleError(400, `#${k.supersedes} is ${isShared(Number(k.supersedes)) ? "server-wide: supersede it with scope=server" : "this channel's: supersede it without scope=server"}`);
  if (k.scope !== "server") return ch.remember(me, k);
  const S = needShared(ch);
  if (!KB_KINDS.includes(k.kind)) throw new HuddleError(400, `kind must be one of ${KB_KINDS.join(", ")}`);
  if (!k.title?.trim() || !k.body?.trim()) throw new HuddleError(400, "need title and body");
  if (k.body.length > 5e4) throw new HuddleError(400, "body \u2264 50000 chars; link the rest with refs");
  if (k.supersedes != null && !await S.store.get("SELECT id FROM knowledge WHERE id=?", [k.supersedes])) throw new HuddleError(404, `no knowledge entry ${k.supersedes}`);
  if (me !== OWNER && !await ch.session(me)) throw new HuddleError(404, `"${me}" has not joined channel ${ch.name} (call join first)`);
  const row = await insertShared(S, { by: me, kind: k.kind, title: k.title.trim().slice(0, 200), body: k.body.trim(), tags: k.tags ?? [], refs: k.refs ?? [], supersedes: k.supersedes ?? null, origin: ch.name, created_at: now() });
  await ch.append(me, { topic: "kb.added", ref: `kb:${row.id}`, msg: `[${k.kind}] ${row.title} (every channel)`, data: { kb: row.id, kind: k.kind, tags: k.tags ?? [], scope: "server" } });
  return { ...await shape(ch, row), body: row.body, hits: 0, supersedes: row.supersedes ?? null };
}
async function insertShared(S, k) {
  return S.serial(() => S.store.tx(async (q) => {
    const row = await q.get(
      `INSERT INTO knowledge (by, kind, title, body, tags, refs, supersedes, created_at, origin, verified_by, verified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
      [k.by, k.kind, k.title, k.body, JSON.stringify(k.tags), JSON.stringify(k.refs), k.supersedes, k.created_at, k.origin, k.verified_by ?? null, k.verified_at ?? null]
    );
    await S.store.indexKnowledge(q, row, k.tags);
    return row;
  }));
}
async function verify(ch, me, id, undo = false) {
  const store = storeOf(ch, id), run = isShared(id) ? needShared(ch).serial.bind(needShared(ch)) : ch.serial.bind(ch);
  const r = await run(() => store.get(`UPDATE knowledge SET verified_by=?, verified_at=? WHERE id=? RETURNING *`, undo ? [null, null, id] : [me, now(), id]));
  if (!r) throw new HuddleError(404, `no knowledge entry ${id}`);
  await ch.append(me, { topic: "kb.verified", ref: `kb:${id}`, msg: `${undo ? "unverified" : "verified"} [${r.kind}] ${r.title}`, data: { kb: id, verified: !undo } });
  return shape(ch, r);
}
async function share(ch, me, id) {
  if (isShared(id)) throw new HuddleError(400, `#${id} is already for every channel`);
  const S = needShared(ch);
  const r = await ch.store.get("SELECT * FROM knowledge WHERE id=?", [id]);
  if (!r) throw new HuddleError(404, `no knowledge entry ${id}`);
  if (r.moved_to) return kb(ch, r.moved_to);
  if ((await ch.retired()).has(id)) throw new HuddleError(400, `#${id} was superseded: share the entry that replaced it`);
  const row = await insertShared(S, {
    by: r.by,
    kind: r.kind,
    title: r.title,
    body: r.body,
    tags: P(r.tags, []),
    refs: P(r.refs, []),
    supersedes: null,
    origin: ch.name,
    created_at: r.created_at,
    verified_by: r.verified_by,
    verified_at: r.verified_at
  });
  await ch.serial(() => ch.store.run("UPDATE knowledge SET moved_to=? WHERE id=?", [row.id, id]));
  await ch.append(me, { topic: "kb.shared", ref: `kb:${row.id}`, msg: `[${r.kind}] ${r.title} is now for every channel (#${id} \u2192 #${row.id})`, data: { kb: row.id, from: id } });
  return { ...await shape(ch, row), body: row.body, from: id };
}

// plugin/server/src/observatory.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join4 } from "node:path";
var TIMEOUT_MS = 800;
var TTL_MS = 5e3;
var cache = /* @__PURE__ */ new Map();
function stateDir(env2 = process.env) {
  return env2.OBSERVATORY_HOME || join4(env2.HOME || homedir3(), ".local", "state", "observatory");
}
function port(env2 = process.env) {
  try {
    const p = Number(readFileSync3(join4(stateDir(env2), "port"), "utf8").trim());
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : null;
  } catch {
    return null;
  }
}
async function get(path) {
  const p = port();
  if (!p) return null;
  const key = `${p}${path}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  let v = null;
  try {
    const r = await fetch(`http://127.0.0.1:${p}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
    if (r.ok) v = await r.json();
  } catch {
    v = null;
  }
  cache.set(key, { at: Date.now(), v });
  return v;
}
async function costBySession(range = "day") {
  const j = await get(`/api/attribution?by=session&range=${range}`);
  if (!j || !Array.isArray(j.rows)) return null;
  const m = /* @__PURE__ */ new Map();
  for (const r of j.rows) if (r && typeof r.key === "string" && typeof r.costUsd === "number" && Number.isFinite(r.costUsd)) m.set(r.key, (m.get(r.key) ?? 0) + r.costUsd);
  return m;
}

// plugin/server/src/links.ts
var ready = /* @__PURE__ */ new WeakSet();
async function ensure(ch) {
  if (ready.has(ch)) return;
  await ch.serial(() => ch.store.run("CREATE TABLE IF NOT EXISTS x_session_links (claude_id TEXT PRIMARY KEY, name TEXT NOT NULL, at TEXT NOT NULL)"));
  ready.add(ch);
}
async function links(ch) {
  await ensure(ch);
  return new Map((await ch.store.all("SELECT claude_id, name FROM x_session_links")).map((r) => [r.claude_id, r.name]));
}

// plugin/server/src/digest.ts
var P2 = (v, d = null) => {
  if (v == null) return d;
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};
var iso2 = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
var MAX_MS = 90 * 864e5;
function parseSince(v, now2 = Date.now()) {
  const s2 = String(v ?? "").trim();
  if (!s2) return now2 - 864e5;
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw]?)$/i.exec(s2);
  if (m) {
    const ms = Number(m[1]) * { "": 1e3, s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2].toLowerCase()];
    return now2 - Math.min(ms, MAX_MS);
  }
  const t = Date.parse(s2);
  if (Number.isFinite(t)) return Math.max(t, now2 - MAX_MS);
  throw new HuddleError(400, `since: 24h, 90m, 7d or an ISO date, not ${s2}`);
}
var rangeFor = (ms) => ms <= 864e5 * 1.01 ? "day" : ms <= 7 * 864e5 * 1.01 ? "week" : "month";
async function digest(ch, since, o = {}) {
  const now2 = Date.now(), from = parseSince(since, now2), at = iso2(from);
  const [events, tasks, notes, sessions, open] = await Promise.all([
    ch.store.all("SELECT * FROM events WHERE ts >= ? ORDER BY seq LIMIT 50000", [at]),
    ch.tasks(),
    ch.store.all("SELECT task_id, kind, body, by, created_at FROM notes WHERE created_at >= ? ORDER BY id", [at]),
    ch.sessions(),
    ch.store.all(`SELECT e.* FROM events e WHERE e.needs_reply = 1 AND NOT EXISTS (SELECT 1 FROM events r WHERE r.reply_to = e.seq) ORDER BY e.seq`)
  ]);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const top = (n) => parentOf(n) ?? n;
  const live = new Map(sessions.map((s2) => [s2.name, s2]));
  const per = /* @__PURE__ */ new Map();
  const S = (n) => {
    const k = top(n);
    let s2 = per.get(k);
    if (!s2) {
      const x = live.get(k);
      per.set(k, s2 = { name: k, state: x?.state ?? (k === OWNER ? null : "left"), role: x?.role ?? null, done: [], notes: [], knowledge: [], approvals: [], asked: 0, events: 0, cost: null });
    }
    return s2;
  };
  for (const s2 of sessions) if (!s2.parent && s2.state !== "left") S(s2.name);
  const kbIds = [];
  const finished = /* @__PURE__ */ new Map();
  for (const r of events) {
    const s2 = S(r.from_name), d = P2(r.data, {}) ?? {};
    s2.events++;
    if (r.topic === "task.status" && (d.status === "done" || d.status === "skipped")) {
      const t = byId.get(r.ref ?? d.task);
      finished.set(String(r.ref ?? d.task), { who: s2.name, id: r.ref ?? d.task, title: t?.title ?? null, status: d.status, note: String(d.note ?? "").slice(0, 300), at: r.ts, now: t?.status ?? null });
    } else if (r.topic === "kb.added" && d.kb != null) {
      s2.knowledge.push({ id: d.kb, kind: d.kind ?? null, title: null, at: r.ts });
      kbIds.push(Number(d.kb));
    } else if (r.topic === "approval.request") s2.approvals.push({ seq: r.seq, labels: Array.isArray(d.labels) ? d.labels : [], at: r.ts });
  }
  for (const f of finished.values()) if (f.now == null || f.now === f.status) S(f.who).done.push({ id: f.id, title: f.title, status: f.status, note: f.note, at: f.at });
  if (kbIds.length) {
    const rows = await ch.store.all(`SELECT id, kind, title FROM knowledge WHERE id IN (${kbIds.map(() => "?").join(",")})`, kbIds);
    const t = new Map(rows.map((r) => [r.id, r]));
    for (const s2 of per.values()) for (const k of s2.knowledge) {
      const r = t.get(Number(k.id));
      if (r) {
        k.title = r.title;
        k.kind = r.kind;
      }
    }
  }
  for (const n of notes) S(n.by ?? OWNER).notes.push({ task: n.task_id, title: byId.get(n.task_id)?.title ?? null, kind: n.kind, body: String(n.body).slice(0, 300), at: n.created_at });
  const questions = open.map((r) => ({ seq: r.seq, from: r.from_name, to: r.to_name ?? null, msg: String(r.msg ?? "").slice(0, 300), at: r.ts, task: P2(r.data, {})?.task ?? null }));
  for (const q of questions) if (per.has(top(q.from))) per.get(top(q.from)).asked++;
  const blocked = tasks.filter((t) => t.status === "blocked").map((t) => ({ id: t.id, title: t.title, owner: t.owner, waits_on: t.blocked_by }));
  const notesOf = new Map((await ch.store.all("SELECT id, status_note FROM tasks WHERE status='blocked'")).map((r) => [r.id, r.status_note]));
  for (const b2 of blocked) b2.note = notesOf.get(b2.id) ?? "";
  let cost = { available: false, total: null, range: rangeFor(now2 - from) };
  if (o.cost !== false) {
    const m = await costBySession(cost.range);
    if (m) {
      const L = await links(ch);
      let total = 0;
      for (const [cid, usd2] of m) {
        const n = L.get(cid);
        if (!n) continue;
        const s2 = S(n);
        s2.cost = (s2.cost ?? 0) + usd2;
        total += usd2;
      }
      cost = { ...cost, available: true, total };
    }
  }
  const order = (s2) => s2.name === OWNER ? 1 : 0;
  const list = [...per.values()].filter((s2) => s2.events || s2.notes.length || s2.state && s2.state !== "left" || s2.cost).sort((a, b2) => order(a) - order(b2) || b2.done.length + b2.knowledge.length - (a.done.length + a.knowledge.length) || b2.events - a.events || a.name.localeCompare(b2.name));
  return {
    channel: ch.name,
    title: ch.config().title,
    since: at,
    until: iso2(now2),
    totals: {
      done: list.reduce((n, s2) => n + s2.done.length, 0),
      notes: notes.length,
      knowledge: kbIds.length,
      events: events.length,
      blocked: blocked.length,
      questions: questions.length,
      approvals: list.reduce((n, s2) => n + s2.approvals.length, 0)
    },
    sessions: list,
    blocked,
    questions,
    cost
  };
}
var usd = (n) => n >= 100 ? `$${n.toFixed(0)}` : n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : "$0";
function digestText(r) {
  const T = r.totals;
  const L = [
    `digest: ${r.title} \xB7 since ${r.since}`,
    `${T.done} task${T.done === 1 ? "" : "s"} finished \xB7 ${T.knowledge} knowledge \xB7 ${T.notes} note${T.notes === 1 ? "" : "s"} \xB7 ${T.blocked} blocked \xB7 ${T.questions} open question${T.questions === 1 ? "" : "s"}${r.cost.available ? ` \xB7 est. cost ${usd(r.cost.total ?? 0)} (observatory, this ${r.cost.range})` : ""}`
  ];
  for (const s2 of r.sessions) {
    L.push("", `${s2.name === OWNER ? "owner (you)" : s2.name}${s2.state ? ` (${s2.state})` : ""}${s2.cost != null ? ` \xB7 est. ${usd(s2.cost)}` : ""} \xB7 ${s2.events} event${s2.events === 1 ? "" : "s"}`);
    for (const d of s2.done) L.push(`  ${d.status === "skipped" ? "skipped" : "done"} ${d.id}${d.title ? ` ${d.title}` : ""}${d.note ? ` \u2014 ${d.note.slice(0, 120)}` : ""}`);
    for (const k of s2.knowledge) L.push(`  kb #${k.id} [${k.kind ?? "?"}] ${k.title ?? ""}`);
    for (const n of s2.notes.slice(0, 8)) L.push(`  note on ${n.task} [${n.kind}] ${n.body.replace(/\s+/g, " ").slice(0, 100)}`);
    if (s2.notes.length > 8) L.push(`  \u2026 ${s2.notes.length - 8} more notes`);
    if (s2.approvals.length) L.push(`  asked permission ${s2.approvals.length}\xD7: ${[...new Set(s2.approvals.flatMap((a) => a.labels))].join(", ")}`);
    if (!s2.done.length && !s2.knowledge.length && !s2.notes.length && !s2.approvals.length) L.push("  nothing finished or shared");
  }
  if (r.blocked.length) {
    L.push("", "blocked now:");
    for (const b2 of r.blocked) L.push(`  ${b2.id} ${b2.title}${b2.owner ? ` @${b2.owner}` : ""}${b2.note ? ` \u2014 ${b2.note.slice(0, 120)}` : ""}${b2.waits_on?.length ? ` (waits on ${b2.waits_on.join(", ")})` : ""}`);
  }
  if (r.questions.length) {
    L.push("", "open questions:");
    for (const q of r.questions.slice(0, 20)) L.push(`  #${q.seq} ${q.from} \u2192 ${q.to ?? "everyone"}: ${q.msg.replace(/\s+/g, " ").slice(0, 140)}`);
  }
  return L.join("\n");
}

// plugin/server/src/ops.ts
var s = (description) => ({ type: "string", ...description ? { description } : {} });
var i = (description) => ({ type: "integer", ...description ? { description } : {} });
var b = (description) => ({ type: "boolean", ...description ? { description } : {} });
var arr = (description) => ({ type: "array", items: { type: "string" }, ...description ? { description } : {} });
var en = (vals, description) => ({ type: "string", enum: vals, ...description ? { description } : {} });
var timeout = (c, a) => Math.max(0, Math.min(3600, Number(a.timeout ?? c.waitDefault)));
var OPS = {
  join: {
    desc: "Join the channel (or resume). Returns who else is here, the turn, your pause state, your inbox, your next task and the latest shared knowledge, plus either your unread events (context sync) or a brief instead of the backlog (context fresh). Call first.",
    props: {
      role: s("one line: what you do here"),
      label: s(),
      task: s("what you are doing now"),
      context: en(CONTEXTS, "sync: everything unread since you left; fresh: skip the backlog, get a brief (open asks are kept). Omit it: fresh on a first join, else what the orchestrator set for you, else sync")
    },
    run: (c, a) => c.ch.join(c.me, { role: a.role, label: a.label, task: a.task, context: a.context }),
    text: (r) => snapText(r)
  },
  status: { desc: "The same picture as join, without changing presence.", props: {}, run: (c) => c.ch.snapshot(c.me), text: (r) => snapText(r) },
  leave: { desc: "Leave the channel when your work is finished (subagents: always, with a one-line summary).", props: { summary: s() }, run: (c, a) => c.ch.leave(c.me, a.summary ?? "") },
  sessions: { desc: "Every session and subagent: state, task, pause, unread, open asks, who holds the turn.", props: {}, run: (c) => c.ch.sessions() },
  state: {
    desc: "Say what you are doing (shown live to the owner and the other sessions).",
    props: { state: en(STATES), task: s(), step: s("task id") },
    required: ["state"],
    run: (c, a) => c.ch.presence(c.me, { state: a.state, task: a.task, step: a.step })
  },
  publish: {
    desc: "Publish an event on the channel (to everyone, or to one session with `to`). Durable; wakes whoever waits on the topic. key makes a retry idempotent.",
    props: { topic: s("e.g. finding.ready, build.ready"), msg: s(), to: s("one session; omit for everyone"), ref: s("file or id the event is about"), data: { type: "object" }, ask: b("needs a reply: lands in the recipient's inbox"), key: s("idempotency key") },
    required: ["topic", "msg"],
    run: (c, a) => c.ch.publish(c.me, { topic: a.topic, msg: a.msg, to: a.to, ref: a.ref, data: a.data, needs_reply: a.ask, key: a.key })
  },
  send: {
    desc: "Message one session (to) or everyone. ask=true needs a reply: it sits in their inbox and wakes their wait until they answer.",
    props: { to: s("session name; omit for everyone"), msg: s(), ask: b(), task: s("task id it is about"), key: s() },
    required: ["msg"],
    run: (c, a) => c.ch.send(c.me, a.to ?? null, a.msg, { ask: a.ask, task: a.task, key: a.key })
  },
  reply: { desc: "Answer a message (by seq). Closes it in your inbox.", props: { seq: i(), msg: s() }, required: ["seq", "msg"], run: (c, a) => c.ch.reply(c.me, Number(a.seq), a.msg) },
  inbox: { desc: "Messages waiting for your reply (asks from sessions, the owner's directives).", props: {}, run: (c) => c.ch.inbox(c.me) },
  events: { desc: "Read the channel history (newest last).", props: { after: i(), limit: i(), topic: s("glob"), from: s() }, run: (c, a) => c.ch.events({ after: a.after, limit: a.limit, topic: a.topic, from: a.from }) },
  wait: {
    desc: "Block until (1) a message needs your reply \u2192 kind=message, (2) the first unread event for you (to you or to everyone) matching a topic glob \u2192 kind=event (handle it and its skipped list, which includes messages between other sessions, then ack its seq), or (3) timeout \u2192 call wait again. Use this to stop and listen while another session works.",
    props: { topics: arr("globs, e.g. task.ready build.* turn.pass; empty = any"), timeout: i("seconds; omit it: the default waits as long as the transport allows, and a timeout only means call wait again") },
    blocks: true,
    run: (c, a) => c.ch.wait(c.me, a.topics ?? [], timeout(c, a), c.signal)
  },
  ack: { desc: "Mark everything up to seq as handled (your cursor; never moves back).", props: { seq: i() }, required: ["seq"], run: (c, a) => c.ch.ack(c.me, Number(a.seq)) },
  gate: {
    desc: "Check the pause. block=true (default) waits until you are resumed. Call before any action that changes things; while paused, publish/task changes are refused.",
    props: { block: b(), timeout: i() },
    blocks: true,
    run: async (c, a) => a.block === false ? { control: await c.ch.controlOf(c.me) } : c.ch.gate(c.me, Number(a.timeout ?? 0), c.signal)
  },
  pause: { desc: "Pause another session (it stops at its next gate; its writes are refused until resume).", props: { target: s(), why: s() }, required: ["target"], run: (c, a) => c.ch.control(c.me, a.target, "pause", a.why) },
  resume: { desc: "Resume a paused session.", props: { target: s(), why: s() }, required: ["target"], run: (c, a) => c.ch.control(c.me, a.target, "resume", a.why) },
  turn: { desc: "Who holds the turn (in ping-pong work only the holder acts), and the event that gave it.", props: {}, run: (c) => c.ch.turn() },
  pass: { desc: "Hand the turn to another session, with what it should do next.", props: { to: s(), msg: s() }, required: ["to"], run: (c, a) => c.ch.passTurn(c.me, a.to, a.msg) },
  take: { desc: "Take the turn (only when the owner asked you to, or the channel works in parallel).", props: { msg: s() }, run: (c, a) => c.ch.takeTurn(c.me, a.msg) },
  next: {
    desc: "Your next task in plan order (yours or unowned): what, why, how, checks, the owner's notes (they override the text). ready=false lists what it waits on: wait for task.ready.",
    props: { json: b() },
    run: (c) => c.ch.next(c.me),
    text: (r, c) => r.done ? "every task you can take is done or skipped" : taskText(r, c.ch.name)
  },
  task: {
    desc: "One task as the owner sees it.",
    props: { id: s(), json: b() },
    required: ["id"],
    run: async (c, a) => await c.ch.task(a.id) ?? (() => {
      throw new HuddleError(404, `no task ${a.id}`);
    })(),
    text: (r, c) => taskText(r, c.ch.name)
  },
  map: {
    desc: "The big picture, when you need it: each phase's progress, what every session does now and next, and the critical path (the longest chain of unfinished dependencies).",
    props: { json: b() },
    run: (c) => c.ch.map(),
    text: (r) => mapText(r)
  },
  tasks: {
    desc: "The plan as a list (filter by owner, status, phase).",
    props: { owner: s(), status: en(STATUSES), phase: i() },
    run: (c, a) => c.ch.tasks({ owner: a.owner, status: a.status, phase: a.phase }),
    text: (r) => r.map((t) => `${t.id} [${t.status}]${t.owner ? ` @${t.owner}` : ""} ${t.title}${t.blocked_by.length ? `  \u27F5 waits on ${t.blocked_by.join(", ")}` : ""}`).join("\n") || "(no tasks)"
  },
  task_create: {
    desc: "Create a task, optionally for another session (owner) and after other tasks (after): that session gets task.created now and task.ready when the dependencies finish.",
    props: { title: s(), owner: s(), after: arr("task ids it waits on"), id: s(), phase: i(), what: s(), how: arr(), verify: arr() },
    required: ["title"],
    run: (c, a) => c.ch.createTask(c.me, { id: a.id, title: a.title, owner: a.owner, after: a.after, phase: a.phase, body: { what: a.what ?? "", how: a.how ?? [], verify: (a.verify ?? []).map((v) => ({ cmd: v, expect: "" })) } })
  },
  task_update: {
    desc: "Reassign (owner), change dependencies (after; cycles are refused) or edit a field (field + value; null restores the plan's text).",
    props: { id: s(), owner: s(), after: arr(), field: s(), value: {} },
    required: ["id"],
    run: (c, a) => c.ch.updateTask(c.me, a.id, { owner: a.owner, after: a.after, field: a.field, value: a.value }),
    text: (r, c) => taskText(r, c.ch.name)
  },
  task_status: {
    desc: "Move a task: doing (refused while it waits on unfinished tasks), done (with evidence in note: releases the tasks waiting on it), blocked (why), skipped.",
    props: { id: s(), status: en(STATUSES), note: s("evidence or reason") },
    required: ["id", "status"],
    run: (c, a) => c.ch.setStatus(c.me, a.id, a.status, a.note ?? "")
  },
  wait_task: {
    desc: "Block until a task (usually another session's) is done or skipped.",
    props: { id: s(), timeout: i("seconds; omit it") },
    required: ["id"],
    blocks: true,
    run: (c, a) => c.ch.waitTask(c.me, a.id, timeout(c, a), c.signal)
  },
  note: { desc: "Add a review note to a task.", props: { id: s(), kind: en(NOTE_KINDS), body: s() }, required: ["id", "kind", "body"], run: (c, a) => c.ch.note(c.me, a.id, a.kind, a.body), text: (r, c) => taskText(r, c.ch.name) },
  // ── workflows: the common moves in one call each (fewer turns, fewer tokens) ──
  start: {
    desc: 'Start work: checks the pause, takes the task (id, or your next one), marks it doing and returns its full text. If it still waits on other tasks, says on which and does not start it: then call wait with topics ["task.ready"].',
    props: { id: s("task id; omit for your next task") },
    run: async (c, a) => {
      if (await c.ch.controlOf(c.me) === "pause") return { started: false, paused: true, hint: "paused: call gate" };
      const t = a.id ? await c.ch.task(a.id) : await c.ch.next(c.me);
      if (!t) throw new HuddleError(404, `no task ${a.id}`);
      if (t.done) return { started: false, done: true };
      if (!t.ready) return { started: false, task: t, hint: `waits on ${t.unmet.map((u) => `${u.id} (${u.owner ?? "unowned"}, ${u.status})`).join(", ")}: wait with topics ["task.ready"]` };
      if (t.status !== "doing") await c.ch.setStatus(c.me, t.id, "doing");
      await c.ch.presence(c.me, { state: "working", task: `${t.id} ${t.title}`, step: t.id });
      return { started: true, task: await c.ch.task(t.id) };
    },
    text: (r, c) => r.paused ? "PAUSED: call gate before any work" : r.done ? "every task you can take is done or skipped" : `${r.started ? "STARTED" : `NOT STARTED: ${r.hint}`}

${taskText(r.task, c.ch.name)}`
  },
  finish: {
    desc: "Finish a task: marks it done with your evidence (note), optionally shares its output as a result others can recall, and returns what it released and your next task.",
    props: { id: s("omit for the task you are doing"), note: s("evidence: command + result"), result: s("output another task needs (stored as knowledge kind=result)"), title: s("title for that result") },
    required: ["note"],
    run: async (c, a) => {
      const id = a.id ?? await c.ch.current(c.me);
      if (!id) throw new HuddleError(400, "no task in progress: pass id");
      const before = await c.ch.lastSeq();
      await c.ch.setStatus(c.me, id, "done", a.note);
      const released = (await c.ch.events({ after: before, topic: "task.ready" })).map((e) => ({ task: e.ref, to: e.to }));
      const t = await c.ch.task(id);
      const kb2 = a.result ? await c.ch.remember(c.me, { kind: "result", title: a.title ?? `${id} ${t.title}`, body: a.result, task: id }) : null;
      const n = await c.ch.next(c.me);
      await c.ch.presence(c.me, { state: "working", task: `finished ${id}`, step: null });
      return { done: id, released, knowledge: kb2?.id ?? null, next: n.done ? null : { id: n.id, title: n.title, ready: n.ready, unmet: n.unmet?.map((u) => u.id) } };
    }
  },
  depend: {
    desc: "You need another session's work before yours can go on: creates a task for that session, makes your task wait on it, marks yours blocked, then blocks until it is released (task.ready) \u2014 one call instead of four.",
    props: { owner: s("the session that must do it"), title: s("what they must do"), what: s("details"), id: s("your task; omit for the one you are doing"), wait: b("default true"), timeout: i("seconds; omit it") },
    required: ["owner", "title"],
    blocks: true,
    run: async (c, a) => {
      const mine = a.id ?? await c.ch.current(c.me);
      if (!mine) throw new HuddleError(400, "no task in progress: pass id");
      const t = (await c.ch.createTask(c.me, { title: a.title, owner: a.owner, body: { what: a.what ?? "" } })).task;
      const cur = await c.ch.task(mine);
      await c.ch.updateTask(c.me, mine, { after: [.../* @__PURE__ */ new Set([...cur.depends, t.id])] });
      await c.ch.setStatus(c.me, mine, "blocked", `waits on ${t.id} (${a.owner}): ${a.title}`);
      if (a.wait === false) return { created: t.id, blocked: mine, waiting: false };
      const h = await c.ch.wait(c.me, ["task.ready"], timeout(c, a), c.signal);
      return { created: t.id, blocked: mine, woke: h, hint: h.kind === "event" ? `ack ${h.seq}, then start ${mine}` : 'call wait with topics ["task.ready"]' };
    }
  },
  handoff: {
    desc: "Hand the work to another session in one call: optionally creates a task for it (title, after), passes the turn with your message, then waits for your next wake-up (unless wait=false).",
    props: { to: s(), msg: s("what they should do next"), title: s("create a task for them with this title"), after: arr("their task waits on these"), topics: arr("what to wait for afterwards; default turn.pass task.ready"), wait: b("default true"), timeout: i("seconds; omit it") },
    required: ["to", "msg"],
    blocks: true,
    run: async (c, a) => {
      const task = a.title ? (await c.ch.createTask(c.me, { title: a.title, owner: a.to, after: a.after })).task.id : null;
      const ev = await c.ch.passTurn(c.me, a.to, a.msg);
      if (a.wait === false) return { passed: ev.seq, task };
      const h = await c.ch.wait(c.me, a.topics ?? ["turn.pass", "task.ready"], timeout(c, a), c.signal);
      return { passed: ev.seq, task, woke: h };
    }
  },
  ask_wait: {
    desc: "Ask one session a question and block until it replies (the answer comes back as the result).",
    props: { to: s(), msg: s(), timeout: i("seconds; omit it") },
    required: ["to", "msg"],
    blocks: true,
    run: async (c, a) => {
      const q = await c.ch.send(c.me, a.to, a.msg, { ask: true });
      const h = await c.ch.waitReply(c.me, q.seq, timeout(c, a), c.signal);
      return h.kind === "event" ? { asked: q.seq, answer: h.msg, from: h.from, seq: h.seq } : { asked: q.seq, ...h, hint: "no reply yet: the ask stays open; wait again later" };
    }
  },
  remember: {
    desc: "Share what you learned so no other session or subagent pays for it again: fact, lesson, decision (with why), context (summary of what you read), result (output of finished work), howto (commands that work). supersedes retires an older entry. If an entry already says the same, nothing is added and you get its id: supersede it, verify it, or pass force. scope=server: for every channel on this server (tool quirks, machine facts).",
    props: {
      kind: en(KB_KINDS),
      title: s("one line, searchable"),
      body: s(),
      tags: arr(),
      refs: arr("files, urls, event seqs (a file that changes later marks the entry may be stale)"),
      task: s(),
      supersedes: i(),
      scope: en(["channel", "server"], "channel (default) or server: every channel on this server"),
      force: b("add it even if a similar entry exists")
    },
    required: ["kind", "title", "body"],
    run: (c, a) => remember(c.ch, c.me, { kind: a.kind, title: a.title, body: a.body, tags: a.tags, refs: a.refs, task: a.task, supersedes: a.supersedes, scope: a.scope, force: !!a.force }),
    text: (r) => r.duplicate ? `not added: ${r.hint}` : `#${r.id} remembered: ${r.title}`
  },
  recall: {
    desc: `Search the shared knowledge (this channel's and the entries for every channel) before reading files or re-deriving anything. Verified entries come first; each shows its age, and "may be stale" when it is old or its files changed. Returns titles and snippets; read one with kb.`,
    props: { q: s("words; empty = latest"), kind: en(KB_KINDS), tag: s(), by: s(), limit: i() },
    run: (c, a) => recall(c.ch, a.q ?? "", { kind: a.kind, tag: a.tag, by: a.by, limit: a.limit }),
    text: (r) => r.map((k) => `#${k.id} [${k.kind}] ${k.title} \u2014 ${k.by}${kbFlags(k)}${k.tags.length ? ` {${k.tags.join(",")}}` : ""}
   ${String(k.hit ?? "").replace(/\s+/g, " ").slice(0, 240)}`).join("\n") || "(nothing yet: remember what you learn)"
  },
  kb: {
    desc: "Read one knowledge entry in full.",
    props: { id: i() },
    required: ["id"],
    run: (c, a) => kb(c.ch, Number(a.id)),
    text: (k) => `#${k.id} [${k.kind}] ${k.title}
by ${k.by} \xB7 ${k.created_at}${kbFlags(k)}${k.task ? ` \xB7 task ${k.task}` : ""}${k.superseded_by ? ` \xB7 SUPERSEDED by #${k.superseded_by}` : ""}${k.moved_to ? ` \xB7 now for every channel as #${k.moved_to}` : ""}
${k.tags.length ? `tags: ${k.tags.join(", ")}
` : ""}${k.refs.length ? `refs: ${k.refs.join(", ")}
` : ""}
${k.body}`
  },
  verify: {
    desc: 'Vouch for a knowledge entry you checked is still right (verified entries come first in recall; verifying also clears "may be stale"). undo=true takes it back.',
    props: { id: i(), undo: b() },
    required: ["id"],
    run: (c, a) => verify(c.ch, c.me, Number(a.id), !!a.undo),
    text: (k) => `#${k.id} ${k.verified_at ? `verified by ${k.verified_by}` : "no longer verified"}: ${k.title}`
  },
  share: {
    desc: "Make one of this channel's knowledge entries one for every channel on this server (a tool quirk, a machine fact); it gets a new id.",
    props: { id: i() },
    required: ["id"],
    run: (c, a) => share(c.ch, c.me, Number(a.id)),
    text: (k) => `#${k.id} is for every channel now${k.from ? ` (was #${k.from})` : ""}: ${k.title}`
  },
  digest: {
    desc: "What happened since a moment (default: the last 24 h), per session: tasks finished, notes, knowledge added, approval requests; what is blocked now and the questions still open; and the estimated cost per session when the Observatory plugin runs. Built from the channel's history, no model calls.",
    props: { since: s("24h, 90m, 7d or an ISO date; default 24h"), json: b() },
    run: (c, a) => digest(c.ch, a.since),
    text: (r) => digestText(r)
  }
};
var OWNER_OPS = {
  configure: {
    desc: "Owner or orchestrator: configure the channel: title, description, start (who holds the turn first), handover ({sender: {to, topics}}), profile, repo; the owner only: members, orchestrator.",
    props: { title: s(), description: s(), start: s(), handover: { type: "object" }, profile: s(), repo: s(), members: arr("who may join; empty = anyone"), orchestrator: s("the session that runs the plan with the owner; empty = none") },
    owner: true,
    run: (c, a) => {
      if (c.me !== OWNER && (a.members !== void 0 || a.orchestrator !== void 0)) throw new HuddleError(403, "only the owner changes members and the orchestrator");
      return c.ch.configure(a);
    }
  },
  import_plan: {
    desc: "Owner or orchestrator: load a plan {phases:[{n,title,\u2026,steps:[{id,title,owner,depends,\u2026}]}]}; merged by task id, keeping status, edits and notes.",
    props: { plan: { type: "object" }, owner: s("owner of steps that name none") },
    required: ["plan"],
    owner: true,
    run: (c, a) => c.ch.importPlan(c.me, a.plan, { owner: a.owner })
  },
  approve: { desc: "Owner or orchestrator: approve a gated task (owner / ask-first): a note on it and a message to its owner.", props: { id: s(), msg: s() }, required: ["id"], owner: true, run: (c, a) => c.ch.approve(a.id, a.msg ?? "", c.me) },
  note_edit: { desc: "Owner or orchestrator: resolve, edit or remove a note.", props: { id: i(), resolved: b(), body: s(), remove: b() }, required: ["id"], owner: true, run: (c, a) => c.ch.editNote(Number(a.id), a) },
  assign: {
    desc: "Owner or orchestrator: how a session joins when it returns (context sync or fresh; null = sync), and optionally a task it now owns.",
    props: { session: s(), context: { type: ["string", "null"], enum: [...CONTEXTS, null] }, task: s("task id to give the session") },
    required: ["session"],
    owner: true,
    run: (c, a) => c.ch.assign(c.me, a.session, a.context ?? null, a.task)
  },
  brief: {
    desc: "Owner or orchestrator: what a session gets on its next fresh join instead of the history (kept until then; also sent now as a message).",
    props: { session: s(), msg: s() },
    required: ["session", "msg"],
    owner: true,
    run: (c, a) => c.ch.brief(c.me, a.session, a.msg)
  }
};
var HOOK_OPS = {
  touched: {
    desc: "The PostToolUse hook: this session edited a file (path relative to its repo).",
    props: { path: s(), repo: s() },
    required: ["path", "repo"],
    run: (c, a) => touched(c.ch, c.me, a),
    text: (r) => r.warn ?? ""
  }
};
var kbFlags = (k) => [
  k.age_days != null ? ` \xB7 ${k.age_days ? `${k.age_days}d old` : "today"}` : "",
  k.verified_at ? ` \xB7 verified (${k.verified_by})` : "",
  k.scope === "server" ? " \xB7 every channel" : "",
  k.stale ? ` \xB7 MAY BE STALE: ${k.stale}` : ""
].join("");
function toolDefs() {
  return Object.entries({ ...OPS, ...OWNER_OPS }).map(([name, op2]) => ({
    name,
    description: op2.desc,
    inputSchema: { type: "object", properties: { ...op2.props, as: s("act as one of your subagents: <you>.<role> (join it first)") }, ...op2.required?.length ? { required: op2.required } : {} }
  }));
}
function snapText(r) {
  const L = [
    `channel ${r.channel} \xB7 you are ${r.me} \xB7 ${r.control === "run" ? "running" : "PAUSED: call gate before any work"}`,
    `turn: ${r.turn.holder ?? "free (parallel)"}${r.turn.since ? ` (since #${r.turn.since.seq} ${r.turn.since.from} ${r.turn.since.topic})` : ""}`
  ];
  if (r.orchestrator) L.push(`orchestrator: ${r.orchestrator}${r.orchestrator === r.me ? " (you: you run the plan with the owner)" : ""}`);
  if (r.context) L.push(r.context === "fresh" ? `context: fresh (${r.skipped} earlier events skipped; asks kept)` : "context: sync (everything unread since you left)");
  if (r.brief) {
    const b2 = r.brief;
    L.push(`brief: ${b2.title}${b2.goal ? ` \xB7 ${b2.goal}` : ""}`);
    if (b2.from_orchestrator) L.push(`from ${b2.from_orchestrator.by} (${b2.from_orchestrator.at}): ${b2.from_orchestrator.msg}`);
    L.push(`your tasks: ${b2.tasks.length ? "" : "none"}${b2.tasks.map((t) => `
  ${t.id} [${t.status}] ${t.title}${t.ready ? "" : ` (waits on ${t.waits_on.join(", ")})`}`).join("")}`);
    if (b2.knowledge.length) L.push(`relevant knowledge (kb <id> to read):${b2.knowledge.map((k) => `
  #${k.id} [${k.kind}] ${k.title} (${k.by})`).join("")}`);
  }
  L.push(`others: ${r.sessions.length ? r.sessions.map((x) => `${x.name}${x.control === "pause" ? "(paused)" : ""} ${x.state}${x.task ? ": " + x.task : ""}${x.stale ? " [stale]" : ""}`).join(" \xB7 ") : "none yet"}`);
  L.push(`inbox: ${r.inbox.length}${r.inbox.map((m) => `
  #${m.seq} from ${m.from}: ${m.msg}`).join("")}`);
  L.push(`unread: ${r.unread_total}${r.unread_total ? " \u2192 " + r.unread.slice(-12).map((e) => `#${e.seq} ${e.from}${e.to ? `\u2192${e.to}` : ""} ${e.topic}`).join(", ") : ""}`);
  if (r.next) L.push(`next task: ${r.next.id} ${r.next.title}${r.next.ready ? "" : ` (waits on ${r.next.unmet.map((u) => `${u.id}@${u.owner ?? "?"}:${u.status}`).join(", ")})`}`);
  if (r.knowledge) L.push(`knowledge: ${r.knowledge.total} entries${r.knowledge.latest.length ? "\n  " + r.knowledge.latest.join("\n  ") : ""} \u2014 recall before you read or re-derive`);
  return L.join("\n");
}
function mapText(r) {
  const L = [`map: ${r.title} \xB7 ${r.done}/${r.total} tasks done${r.orchestrator ? ` \xB7 orchestrator ${r.orchestrator}` : ""}`, "phases:"];
  const ph = r.phases;
  const first = Math.max(0, ph.findIndex((p) => p.done < p.total));
  const shown = ph.length > 14 ? ph.slice(first, first + 12) : ph;
  if (shown[0] !== ph[0] && first > 0) L.push(`  \u2026 ${first} finished phase(s)`);
  for (const p of shown) L.push(`  ${String(p.n ?? "-").padStart(3)} ${p.done === p.total ? "\u2713" : " "} ${p.done}/${p.total}  ${p.title}`);
  const after = ph.length - (ph.indexOf(shown[shown.length - 1]) + 1);
  if (after > 0) L.push(`  \u2026 ${after} more phase(s)`);
  L.push("sessions:");
  for (const s2 of r.sessions.slice(0, 10)) L.push(`  ${s2.name} (${s2.state}): ${s2.current ? `doing ${s2.current.id} ${s2.current.title}` : "nothing in progress"}${s2.next ? ` \xB7 next ${s2.next.id}${s2.next.ready ? "" : " (waits)"}` : ""}`);
  const cp = r.critical_path;
  L.push(`critical path (${cp.length} open task${cp.length === 1 ? "" : "s"} in a chain): ${cp.length ? "" : "none"}`);
  for (const t of cp.slice(0, 10)) L.push(`  ${t.id} [${t.status}]${t.owner ? ` @${t.owner}` : ""} ${t.title}`);
  if (cp.length > 10) L.push(`  \u2026 ${cp.length - 10} more`);
  return L.join("\n");
}
function taskText(t, channel) {
  const L = [];
  const gate = t.gate && t.gate !== "none" ? ` \xB7 gate ${t.gate}` : "";
  L.push(`${t.id}  ${t.title}`, `${t.kind ?? "task"}${t.risk ? ` \xB7 ${t.risk} risk` : ""}${gate} \xB7 ${t.status}${t.owner ? ` \xB7 owner ${t.owner}` : " \xB7 unowned"}${t.status_by ? ` (last by ${t.status_by})` : ""}`);
  if (t.unmet?.length) L.push(`WAITS ON: ${t.unmet.map((u) => `${u.id} (${u.owner ?? "unowned"}, ${u.status})`).join(", ")} \u2192 wait with topics ["task.ready"] or wait_task`);
  const notes = t.open_notes ?? [];
  if (notes.length) L.push("", "OWNER NOTES (read first; they override the text below):", ...notes.map((c) => `  [${c.kind}] ${c.body}${c.by && c.by !== "owner" ? ` \u2014 ${c.by}` : ""}`));
  if (Object.keys(t.edited ?? {}).length) L.push(`(edited: ${Object.keys(t.edited).join(", ")})`);
  if (t.what) L.push("", "WHAT", t.what);
  if (t.why) L.push("", "WHY", t.why);
  if (t.alternatives?.length) L.push("", "NOT THAT WAY", ...t.alternatives.map((a) => `  - ${a.option}: ${a.why_not}`));
  if (t.how?.length) L.push("", "HOW", ...t.how.map((h, n) => `  ${n + 1}. ${h}`));
  for (const sn of t.snippets ?? []) L.push("", `CODE: ${sn.title}${sn.path ? ` (${sn.path})` : ""}${sn.proposed ? " [proposed]" : ""}`, ...String(sn.code).split("\n").map((x) => "    " + x));
  if (t.verify?.length) L.push("", "CHECK", ...t.verify.map((v) => `  $ ${v.cmd}${v.expect ? `
    \u2192 ${v.expect}` : ""}`));
  if (t.value) L.push("", "DONE MEANS", t.value);
  if (t.use) L.push("", "USE", t.use);
  if (t.rollback) L.push("", "ROLLBACK", t.rollback);
  if (t.depends?.length) L.push("", `depends on ${t.depends.join(", ")}`);
  if (t.needed_by?.length) L.push(`needed by ${t.needed_by.join(", ")}`);
  L.push("", `board: /#/c/${channel}/t/${t.id}`);
  return L.join("\n");
}

// plugin/server/src/mcp.ts
import { readFileSync as readFileSync4 } from "node:fs";
var VERSION = (() => {
  try {
    return JSON.parse(readFileSync4(`${PLUGIN}/.claude-plugin/plugin.json`, "utf8")).version ?? "dev";
  } catch {
    return "dev";
  }
})();
var instructions = (ch, me) => `You are "${me}" in Huddle channel "${ch}": every session (and subagent) in this channel sees the same events, tasks and shared knowledge, so act as one team.
Protocol (the huddle skill has the full version):
1. You are already joined (the session start did it): call status to refresh; join only to change your role or context. Tools are mcp__plugin_huddle_huddle__<op>; from Bash, \`huddle <op>\`.
2. recall before reading files or re-deriving anything; remember what you learn (fact, lesson, decision, context, result, howto).
3. gate before any change (paused = stop). Answer every inbox message with reply.
4. Work: start (takes your next task, or the id you name) \u2192 do it \u2192 finish "<command + result>" (releases what waited on it, names your next). When start says the task waits on another session's: wait with topics ["task.ready"] (or wait_task) instead of polling or guessing.
5. Need someone else: send (ask=true for a reply), or task_create with owner and after. Ping-pong work: only the turn holder acts; pass the turn when done.
6. Idle or blocked on others: wait (it returns kind message | event | timeout; on event, handle it and its skipped list, then ack its seq; on timeout, wait again).
7. Subagents you start: they join as "${me}.<role>" (pass as), share results with remember, and leave when done.`;

// plugin/bin/huddle-mcp.ts
var { url: URL_, channel: CH, as: ME, push: PUSH, wait: WAIT } = identity();
var refresh = () => {
  ({ url: URL_, channel: CH, as: ME } = identity());
};
var write = (m) => process.stdout.write(JSON.stringify(m) + "\n");
var log = (...a) => console.error("huddle-mcp:", ...a);
var BLOCKING = ["wait", "wait_task", "gate", "depend", "handoff", "ask_wait"];
var CALL_MS = Number(process.env.HUDDLE_CALL_TIMEOUT_MS || 1e4);
var match = (t) => PUSH[0] !== "off" && PUSH.some((g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(t));
var NOT_IN = "not in a huddle yet: run /huddle:setup in this project (the first session), or paste the /huddle:join line that /huddle:invite shows in a session that is in one";
var isIn = () => !!(CH && ME && URL_ && tokenFor(URL_));
var listedIn = null;
var OUT_TOOLS = [
  { name: "status", description: "Is this session in a Huddle? (Until it is, only this and join are listed.)", inputSchema: { type: "object", properties: {} } },
  { name: "join", description: "Join a Huddle with an invite: the host:port and token from the /huddle:join line the user pasted.", inputSchema: { type: "object", properties: {
    host_port: { type: "string", description: "e.g. 127.0.0.1:41873" },
    token: { type: "string", description: "<id>.<secret> from the join line" },
    as: { type: "string", description: "your name (default: the project folder's)" }
  }, required: ["host_port", "token"] } }
];
setInterval(() => {
  if (listedIn !== false) return;
  refresh();
  if (isIn()) {
    listedIn = null;
    write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }
}, 3e3).unref?.();
async function outside(m) {
  if (m.method !== "tools/call" || isIn()) return false;
  const text = (t, isError = false) => {
    if (m.id !== void 0) write({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: t }], ...isError ? { isError } : {} } });
    return true;
  };
  const a = m.params?.arguments ?? {};
  if (m.params?.name !== "join") return text(`huddle: ${NOT_IN}`, m.params?.name !== "status");
  const host = String(a.host_port ?? "").trim(), url = (/^https?:\/\//.test(host) ? host : `http://${host}`).replace(/\/$/, "");
  if (!/^https?:\/\/[\w.-]+:\d+$/.test(url) || typeof a.token !== "string") return text("huddle: join needs host_port (host:port) and token", true);
  const wish = String(a.as || (ME ? ME.split(".")[0] : slug(process.env.CLAUDE_PROJECT_DIR || process.cwd())));
  try {
    const r = await fetch(`${url}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(CALL_MS),
      body: JSON.stringify({ token: a.token, name: wish, unique: !a.as, channel: CH || void 0 })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.credential) return text(`huddle: ${j.error ?? `HTTP ${r.status}`}`, true);
    const channel = String(j.channel || CH || "");
    if (!channel) return text("huddle: joined, but the invite names no channel: ask for an invite made in a channel", true);
    saveCred({ url, channel, as: j.name, credential: j.credential });
  } catch {
    return text(`huddle: Huddle unreachable at ${url}`, true);
  }
  refresh();
  try {
    await hfetch(`${URL_}/api/c/${CH}/op/join?as=${encodeURIComponent(ME)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(CALL_MS) });
  } catch {
  }
  listedIn = null;
  write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  return text(`joined ${url}, channel ${CH}, as ${ME}; this project's next sessions are in it too. Every Huddle tool is listed now: call status for the picture. (/huddle:open signs the user's browser in to the dashboard.)`);
}
function local2(m) {
  const ok = (result) => {
    if (m.id !== void 0) write({ jsonrpc: "2.0", id: m.id, result });
    return true;
  };
  switch (m.method) {
    case "initialize":
      return ok({
        protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {}, experimental: { "claude/channel": {} } },
        serverInfo: { name: "huddle", version: VERSION },
        instructions: CH && ME ? instructions(CH, ME) : `Huddle: this session is ${NOT_IN}. Its tools (mcp__plugin_huddle_huddle__*) are listed once it is in.`
      });
    case "ping":
      return ok({});
    case "tools/list":
      listedIn = isIn();
      return ok({ tools: listedIn ? toolDefs() : OUT_TOOLS });
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
  }
  return false;
}
var initialized = false;
async function forward(m) {
  refresh();
  if (initialized && CH && ME && URL_) push();
  if (local2(m)) return;
  if (await outside(m)) return;
  if (!CH || !ME) {
    if (m.id !== void 0) write({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `huddle: ${NOT_IN}` }], isError: true } });
    return;
  }
  if (!URL_) {
    if (m.id !== void 0) write({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "huddle: this project's Huddle has no port yet: start it with huddle up (it picks one and saves it). Treat yourself as paused and retry." }], isError: true } });
    return;
  }
  const blocking = m.method === "tools/call" && BLOCKING.includes(m.params?.name);
  if (blocking && m.params.arguments?.timeout === void 0)
    m.params.arguments = { ...m.params.arguments ?? {}, timeout: m.params.name === "gate" ? 0 : WAIT };
  const ms = blocking ? (Math.min(3600, Number(m.params.arguments.timeout) || 3600) + 30) * 1e3 : CALL_MS;
  try {
    const res = await hfetch(`${URL_}/mcp/${CH}?as=${encodeURIComponent(ME)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(m),
      signal: AbortSignal.timeout(ms),
      // @ts-ignore Bun: the signal above is the deadline, not Bun's default client timeout
      timeout: false
    });
    if (res.status === 202) return;
    if (res.status === 401 || res.status === 403) {
      const e = await res.json().catch(() => ({}));
      if (m.id !== void 0) write({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `huddle: ${e.error ?? `HTTP ${res.status}`}` }], isError: true } });
      return;
    }
    const j = await res.json();
    write(j);
  } catch (e) {
    const late = e?.name === "TimeoutError";
    if (m.id !== void 0) write({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: late ? `huddle: no answer from ${URL_} within ${ms / 1e3} s. Treat yourself as paused and retry.` : `huddle: service unreachable at ${URL_} (start it: huddle up). Treat yourself as paused and retry.` }], isError: true } });
  }
}
var lastSeq = 0;
var pushing = false;
var pushed = /* @__PURE__ */ new Set();
var deliver = (e, advance = true) => {
  if (pushed.has(e.seq) || advance && e.seq <= lastSeq) return;
  if (advance) lastSeq = e.seq;
  else pushed.add(e.seq);
  if (e.from === ME) return;
  const overheard = !!e.to && e.to !== ME;
  if (overheard ? !["msg", "ask", "reply"].includes(e.topic) : !(e.to === ME || e.needs_reply || match(e.topic))) return;
  write({ jsonrpc: "2.0", method: "notifications/claude/channel", params: {
    content: `${e.from} \u2192 ${e.to ?? "all"} \xB7 ${e.topic} #${e.seq}${e.ref ? ` (${e.ref})` : ""}: ${e.msg ?? ""}${overheard ? "\n(overheard: between other sessions, for your knowledge)" : e.needs_reply ? `
(needs your reply: tool reply seq=${e.seq})` : ""}`,
    meta: { channel: CH, seq: String(e.seq), topic: e.topic.replace(/\./g, "_"), from: e.from.replace(/\./g, "_") }
  } });
};
var op = async (name, args) => {
  const r = await hfetch(`${URL_}/api/c/${CH}/op/${name}?as=${encodeURIComponent(ME)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(CALL_MS)
  });
  return (await r.json()).result;
};
async function catchUp(last) {
  try {
    if (lastSeq) for (const e of await op("events", { after: lastSeq, limit: 500 })) deliver(e);
    else for (const e of await op("inbox", {})) deliver(e, false);
  } catch (e) {
    log("catch-up:", e.message);
  }
  lastSeq = Math.max(lastSeq, last);
}
async function push() {
  if (pushing || PUSH[0] === "off" || !CH || !ME || !URL_) return;
  pushing = true;
  for (let backoff = 1e3; ; backoff = Math.min(backoff * 2, 3e4)) {
    try {
      const res = await hfetch(`${URL_}/api/c/${CH}/live?as=${encodeURIComponent(ME)}`, {
        headers: { accept: "text/event-stream" },
        // @ts-ignore
        timeout: false
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      backoff = 1e3;
      let buf2 = "";
      for await (const chunk of res.body) {
        buf2 += new TextDecoder().decode(chunk);
        let i2;
        while ((i2 = buf2.indexOf("\n\n")) >= 0) {
          const frame = buf2.slice(0, i2);
          buf2 = buf2.slice(i2 + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const m = JSON.parse(line.slice(6));
          if (m.type === "hello") {
            await catchUp(m.data.last);
            continue;
          }
          if (m.type === "event") deliver(m.data);
        }
      }
      throw new Error("stream ended");
    } catch (e) {
      log("live stream:", e.message, `retry in ${backoff / 1e3}s`);
      await sleep(backoff);
    }
  }
}
var buf = "";
for await (const chunk of process.stdin) {
  buf += new TextDecoder().decode(chunk);
  let i2;
  while ((i2 = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i2).trim();
    buf = buf.slice(i2 + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    if (m.method === "notifications/initialized") {
      initialized = true;
      push();
    }
    forward(m);
  }
}
process.exit(0);
