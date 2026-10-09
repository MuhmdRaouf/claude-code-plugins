#!/usr/bin/env node
import { createRequire as __zaiCreateRequire } from "node:module";
const require = __zaiCreateRequire(import.meta.url);

// ../../node_modules/@muhmdraouf/core/src/domain/provider.ts
function defineProvider(spec) {
  return { ...spec, agents: { main: spec.catalog.main.id, flash: spec.catalog.flash.id } };
}
function modelEnvName(provider2, tier) {
  return `${provider2.envPrefix}_MODEL_${tier.toUpperCase()}`;
}
function resolveProvider(provider2, env) {
  const withId = (tier, id) => ({ ...provider2.catalog[tier], id });
  const catalog = {
    main: withId("main", env[modelEnvName(provider2, "main")] ?? provider2.catalog.main.id),
    flash: withId("flash", env[modelEnvName(provider2, "flash")] ?? provider2.catalog.flash.id)
  };
  const baseUrl = env[`${provider2.envPrefix}_BASE_URL`] ?? provider2.baseUrl;
  return { ...provider2, catalog, baseUrl };
}
function modelClaim(provider2) {
  return {
    ids: [provider2.catalog.main.id, provider2.catalog.flash.id],
    prefixes: provider2.router.modelPrefixes
  };
}
function claims(claim, model) {
  if (model === "") return false;
  return claim.ids.includes(model) || claim.prefixes.some((prefix) => model.startsWith(prefix));
}

// ../../node_modules/@muhmdraouf/core/src/router/emergency.ts
import http2 from "node:http";

// ../../node_modules/@muhmdraouf/core/src/domain/route-events.ts
function healthEvent(plugin, event, reason, model, ts) {
  return { kind: "router.event", plugin, event, reason, model: model === "" ? null : model, ts };
}

// ../../node_modules/@muhmdraouf/core/src/domain/state-layout.ts
import { dirname, join } from "node:path";
var ENGINE_PID = "engine.pid";
function stateLayout(root) {
  const routerDir = join(root, "router");
  const jobs = join(root, "jobs");
  const checkouts = join(root, "checkouts");
  return {
    root,
    setupDone: join(root, "setup-done"),
    legacyRouteMark: join(root, "route"),
    engines: join(root, "engines.json"),
    ledger: join(root, "ledger.json"),
    disabledLedger: join(root, "ledger.disabled.json"),
    routerDir,
    routerLog: join(routerDir, "router.log"),
    routerPid: join(root, "router.pid"),
    routerRetired: join(root, "router.retired"),
    routerLock: join(root, "router.lock"),
    crashLog: join(root, "router-crash.log"),
    leftBehind: join(root, "LEFT-BEHIND.md"),
    claudeHome: join(root, "claude-home"),
    limiter: join(root, "limiter.json"),
    slots: join(root, "slots"),
    jobs,
    checkouts,
    job(id) {
      const dir = join(jobs, id);
      return {
        dir,
        record: join(dir, "job.json"),
        brief: join(dir, "brief.md"),
        artifacts: join(dir, "artifacts"),
        attemptLog: (n) => join(dir, `attempt-${n}.jsonl`),
        gateLog: (n, gate) => join(dir, `gate-${n}-${gate}.log`),
        regenerateLog: (n) => join(dir, `regenerate-${n}.log`),
        landCheckLog: (n) => join(dir, `land-check-${n}.log`),
        driverLog: join(dir, "driver.log"),
        stop: join(dir, "stop"),
        progress: join(dir, "progress.json"),
        driverLock: join(dir, "driver.lock"),
        enginePid: join(dir, ENGINE_PID),
        worktree: join(root, "worktrees", id),
        checkout: join(checkouts, id)
      };
    }
  };
}

// ../../node_modules/@muhmdraouf/core/src/router/crashlog.ts
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
var diskFs = {
  append: (path, text) => appendFileSync(path, text, { mode: 384 }),
  size: (path) => statSync(path).size,
  read: (path) => readFileSync(path),
  write: (path, data) => writeFileSync(path, data, { mode: 384 }),
  rename: (from, to) => renameSync(from, to)
};
var CRASH_LOG_LIMIT = 1024 * 1024;
function logCrash(stateRoot, entry, fs = diskFs, limit = CRASH_LOG_LIMIT) {
  const path = stateLayout(stateRoot).crashLog;
  try {
    fs.append(path, `${JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), pid: process.pid, ...entry })}
`);
    if (fs.size(path) <= limit) return;
    const data = fs.read(path);
    const tail = data.subarray(data.length - limit);
    const start = tail.indexOf(10) + 1;
    fs.write(path, tail.subarray(start));
  } catch {
  }
}
function describe(error) {
  if (error instanceof Error)
    return { error: error.message, ...error.stack === void 0 ? {} : { stack: error.stack } };
  return { error: String(error) };
}
function installCrashHandlers(role, stateRoot, version, exit = (code) => process.exit(code), fs = diskFs) {
  const crash = (event) => (error) => {
    logCrash(stateRoot, { role, version, event, ...describe(error) }, fs);
    exit(1);
  };
  process.on("uncaughtException", crash("uncaughtException"));
  process.on("unhandledRejection", crash("unhandledRejection"));
}
var ROUTER_LOG_LIMIT = 4 * 1024 * 1024;
function rotatingLog(path, fs = diskFs, limit = ROUTER_LOG_LIMIT) {
  let written = 0;
  try {
    written = fs.size(path);
  } catch {
    written = 0;
  }
  return (line) => {
    try {
      const text = `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`;
      if (written + text.length > limit) {
        fs.rename(path, `${path}.1`);
        written = 0;
      }
      fs.append(path, text);
      written += text.length;
    } catch {
    }
  };
}

// ../../node_modules/@muhmdraouf/core/src/router/upstream.ts
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
var BODY_LIMIT_BYTES = 64 * 1024 * 1024;
var IDLE_TIMEOUT_MS = 10 * 6e4;
var HOP_BY_HOP = /* @__PURE__ */ new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
function anthropicError(res, status, type, message) {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}
function harden(server) {
  server.keepAliveTimeout = 12e4;
  server.headersTimeout = 125e3;
  server.requestTimeout = 0;
  server.timeout = 0;
  return server;
}
function trackConnections(closed = () => void 0) {
  const sockets = /* @__PURE__ */ new Map();
  let draining = false;
  const closeIdle = () => {
    for (const [socket, inFlight] of sockets) if (inFlight === 0) socket.destroy();
  };
  const opened = (socket) => {
    sockets.set(socket, 0);
    socket.on("close", () => {
      sockets.delete(socket);
      closed(sockets.size);
    });
  };
  const responded = (socket) => {
    const inFlight = sockets.get(socket);
    if (inFlight === void 0) return;
    sockets.set(socket, Math.max(0, inFlight - 1));
    if (draining && inFlight <= 1) setImmediate(closeIdle);
  };
  const requested = (req, res) => {
    const socket = req.socket;
    sockets.set(socket, (sockets.get(socket) ?? 0) + 1);
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      responded(socket);
    };
    res.on("finish", end);
    res.on("close", end);
  };
  return {
    watch(server) {
      server.on("connection", opened);
      server.on("request", requested);
    },
    get size() {
      return sockets.size;
    },
    drain() {
      draining = true;
      closeIdle();
    },
    closeAll() {
      for (const socket of sockets.keys()) socket.destroy();
    }
  };
}
function safePath(path) {
  if (path === void 0 || !path.startsWith("/") || path.startsWith("//")) return void 0;
  return path;
}
function upstreamUrl(target, path) {
  return new URL(`${target.origin}${target.pathname.replace(/\/$/, "")}${path}`);
}
function readBody(req, limit = BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) over = true;
      if (!over) chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? "too-large" : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
var TOKEN_HEADER = "x-provider-router-token";
function refuseHost(req, res, name, ports) {
  const host = req.headers.host ?? "";
  if (ports.some((port) => host === `127.0.0.1:${port}` || host === `localhost:${port}`)) return false;
  anthropicError(res, 421, "invalid_request_error", `${name} router: wrong Host`);
  return true;
}
function receive(req, res, name, limit, then) {
  if (safePath(req.url) === void 0) {
    anthropicError(res, 400, "invalid_request_error", `${name} router: bad request path`);
    return;
  }
  readBody(req, limit).then(
    (body) => {
      if (body !== "too-large") return then(body);
      res.setHeader("connection", "close");
      anthropicError(res, 413, "request_too_large", `${name} router: request body over 64 MiB`);
    },
    () => res.destroy()
  );
}
function requestModel(body) {
  try {
    const model = JSON.parse(body.toString("utf8"))?.model;
    return typeof model === "string" ? model : "";
  } catch {
    return "";
  }
}
function forwardHeaders(incoming, target, length) {
  const out = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== void 0 && !HOP_BY_HOP.has(name)) out[name] = value;
  }
  out.host = target.host;
  out["content-length"] = String(length);
  return out;
}
var RESPONSE_HOP = /* @__PURE__ */ new Set(["connection", "keep-alive", "transfer-encoding"]);
function responseHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== void 0 && !RESPONSE_HOP.has(name)) out[name] = value;
  }
  return out;
}
function envValue(env, name) {
  const value = env[name.toLowerCase()] ?? env[name.toUpperCase()];
  return value === void 0 || value.trim() === "" ? void 0 : value.trim();
}
function noProxy(host, port, env) {
  const list = envValue(env, "NO_PROXY");
  if (list === void 0) return false;
  return list.split(/[\s,]+/).filter((entry) => entry !== "").some((entry) => {
    if (entry === "*") return true;
    const [name = "", only] = entry.split(":");
    if (only !== void 0 && only !== port) return false;
    const domain = name.replace(/^\*?\./, "").toLowerCase();
    const lower = host.toLowerCase();
    return lower === domain || lower.endsWith(`.${domain}`);
  });
}
function proxyFor(target, env) {
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  if (noProxy(target.hostname.replace(/^\[|\]$/g, ""), port, env)) return void 0;
  const raw = envValue(env, target.protocol === "https:" ? "HTTPS_PROXY" : "HTTP_PROXY");
  if (raw === void 0) return void 0;
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return void 0;
  }
}
function builtinProxy(env) {
  return env.NODE_USE_ENV_PROXY === "1";
}
function tunnel(proxy, secure) {
  return (options, done) => {
    const host = String(options.host ?? options.hostname ?? "");
    const port = Number(options.port) || (secure ? 443 : 80);
    const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
    const headers = { host: authority };
    if (proxy.username !== "")
      headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    const { tunnel: tunnel2 } = options;
    const connect = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: "CONNECT",
      path: authority,
      headers,
      agent: false
    });
    const settle = () => {
      clearTimeout(guard);
      if (tunnel2 !== void 0) tunnel2.connect = void 0;
    };
    let guard;
    if (tunnel2 !== void 0) {
      tunnel2.connect = connect;
      guard = setTimeout(() => {
        connect.destroy(Object.assign(new Error("proxy CONNECT timed out"), { code: "ETIMEDOUT" }));
      }, tunnel2.idleMs);
    }
    connect.once("connect", (answer, socket) => {
      settle();
      if (answer.statusCode !== 200) {
        socket.destroy();
        done(new Error(`proxy CONNECT ${authority} answered ${answer.statusCode}`));
        return;
      }
      if (!secure) return done(null, socket);
      const { host: _host, port: _port, path: _path, ...rest } = options;
      done(null, tls.connect({ ...rest, socket, servername: String(options.servername ?? host) }));
    });
    connect.once("error", (error) => {
      settle();
      done(error);
    });
    connect.end();
  };
}
var agents = /* @__PURE__ */ new Map();
function bunProxiesItself(bun = process.versions.bun) {
  if (bun === void 0) return false;
  const [major = 0, minor = 0] = bun.split(".").map(Number);
  return major < 1 || major === 1 && minor < 4;
}
var BUN_PROXIES_ITSELF = bunProxiesItself();
function agentFor(target, env, fresh = false) {
  const secure = target.protocol === "https:";
  const proxy = proxyFor(target, env);
  const key = `${target.protocol}|${proxy?.href ?? "direct"}|${builtinProxy(env)}`;
  const cached = fresh ? void 0 : agents.get(key);
  if (cached !== void 0) return cached;
  const Agent = secure ? https.Agent : http.Agent;
  const options = { keepAlive: !fresh, maxSockets: 256 };
  if (proxy !== void 0 && builtinProxy(env)) options.proxyEnv = { ...env };
  const agent = new Agent(options);
  if (proxy !== void 0 && !builtinProxy(env) && !BUN_PROXIES_ITSELF) {
    agent.createConnection = tunnel(proxy, secure);
  }
  if (!fresh) agents.set(key, agent);
  return agent;
}
var STALE_SOCKET = /* @__PURE__ */ new Set(["ECONNRESET", "EPIPE"]);
var INSPECT_LIMIT_BYTES = 64 * 1024;
function sendUpstream(call, res, hooks) {
  let settled = false;
  let rewrite;
  let contentType;
  let atBoundary = true;
  const fail = (code, afterHeaders) => {
    if (settled) return;
    settled = true;
    if (afterHeaders)
      endFailed(res, contentType, rewrite, atBoundary, `upstream connection failed (${code})`);
    hooks.failed({ code, afterHeaders });
  };
  const attempt = (retry) => {
    const secure = call.url.protocol === "https:";
    const agent = call.direct === true ? void 0 : agentFor(call.url, call.env, retry);
    const client = secure ? https : http;
    const idle = call.idleMs ?? IDLE_TIMEOUT_MS;
    const tunnel2 = { idleMs: idle };
    const options = {
      method: call.method,
      headers: call.headers,
      ...agent === void 0 ? { agent: false } : { agent },
      tunnel: tunnel2
    };
    const upstream = client.request(call.url, options);
    let errored = false;
    const onError = (error) => {
      if (errored) return;
      errored = true;
      const code = error.code ?? "EUPSTREAM";
      if (res.headersSent) fail(code, true);
      else if (!retry && upstream.reusedSocket && STALE_SOCKET.has(code)) attempt(true);
      else fail(code, false);
    };
    upstream.setTimeout(idle, () => {
      const error = Object.assign(new Error("idle"), { code: "ETIMEDOUT" });
      upstream.destroy(error);
      onError(error);
    });
    upstream.on("response", (answer) => {
      if (settled) {
        answer.destroy();
        return;
      }
      const judge = hooks.inspect?.(answer);
      hooks.answered?.(answer);
      contentType = answer.headers["content-type"];
      answer.on("data", (chunk) => {
        if (chunk.length > 0) atBoundary = chunk.subarray(-2).toString("latin1") === "\n\n";
      });
      answer.on("error", () => fail("EABORTED", res.headersSent));
      answer.on("aborted", () => fail("EABORTED", res.headersSent));
      answer.on("close", () => {
        if (!answer.complete) fail("EABORTED", res.headersSent);
      });
      if (judge === void 0) res.writeHead(answer.statusCode ?? 502, responseHeaders(answer.headers));
      else holdBack(answer, res, judge, () => hooks.oversize?.(answer));
      answer.on("end", () => {
        settled = true;
        hooks.finished?.(answer);
      });
      rewrite = hooks.rewrite?.(answer);
      if (judge === void 0) pipeThrough(answer, res, rewrite, fail);
    });
    upstream.on("error", onError);
    res.on("close", () => {
      if (!res.writableFinished) {
        tunnel2.connect?.destroy();
        upstream.destroy();
      }
    });
    upstream.end(call.body);
  };
  attempt(false);
}
function endFailed(res, contentType, rewrite, atBoundary, message) {
  rewrite?.destroy();
  if (!res.headersSent || res.destroyed || res.writableEnded) {
    if (!res.writableEnded) res.destroy();
    return;
  }
  if (String(contentType).includes("text/event-stream")) {
    const event = JSON.stringify({ type: "error", error: { type: "api_error", message } });
    res.write(`${atBoundary ? "" : "\n\n"}event: error
data: ${event}

`);
    res.end();
    return;
  }
  res.destroy();
}
function pipeThrough(answer, res, rewrite, fail) {
  if (rewrite === void 0) {
    answer.pipe(res);
    return;
  }
  rewrite.on("error", () => fail("EABORTED", true));
  answer.pipe(rewrite).pipe(res);
}
function holdBack(answer, res, judge, released) {
  const chunks = [];
  let size = 0;
  const release = () => {
    answer.removeListener("data", collect);
    answer.removeListener("end", decide);
    released();
    res.writeHead(answer.statusCode ?? 502, responseHeaders(answer.headers));
    for (const chunk of chunks.splice(0)) res.write(chunk);
    answer.pipe(res);
  };
  const collect = (chunk) => {
    chunks.push(chunk);
    size += chunk.length;
    if (size > INSPECT_LIMIT_BYTES) release();
  };
  const decide = () => {
    if (res.destroyed) return;
    const body = Buffer.concat(chunks);
    const replacement = judge(body);
    if (replacement === void 0) {
      res.writeHead(answer.statusCode ?? 502, responseHeaders(answer.headers));
      res.end(body);
      return;
    }
    res.writeHead(replacement.status, replacement.headers);
    res.end(replacement.body);
  };
  answer.on("data", collect);
  answer.on("end", decide);
}

// ../../node_modules/@muhmdraouf/core/src/router/passthrough.ts
function degradedMessage(options) {
  return `${options.display} router ${options.state}; Claude models still work. Run /${options.name}:setup.`;
}
function passThrough(options, req, res, body) {
  const path = safePath(req.url);
  if (path === void 0) {
    anthropicError(res, 400, "invalid_request_error", "bad request path");
    return;
  }
  const model = requestModel(body);
  if (claims(options.claim, model)) {
    options.log?.(`${req.method} ${path} model=${model} \u2192 refused (${options.state})`);
    anthropicError(res, 503, "api_error", degradedMessage(options));
    return;
  }
  const url = upstreamUrl(options.anthropic, path);
  sendUpstream(
    {
      url,
      method: req.method ?? "POST",
      headers: forwardHeaders(req.headers, url, body.length),
      body,
      env: options.env,
      ...options.idleMs === void 0 ? {} : { idleMs: options.idleMs }
    },
    res,
    {
      answered: (answer) => options.log?.(
        `${req.method} ${path} model=${model || "-"} \u2192 anthropic ${answer.statusCode} (passthrough)`
      ),
      failed: ({ code, afterHeaders }) => {
        options.log?.(`${req.method} ${path} model=${model || "-"} \u2192 anthropic error ${code} (passthrough)`);
        if (!afterHeaders)
          anthropicError(res, 502, "api_error", `${options.name} router: anthropic unreachable (${code})`);
      }
    }
  );
}

// ../../node_modules/@muhmdraouf/core/src/router/spool-write.ts
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { join as join3 } from "node:path";

// ../../node_modules/@muhmdraouf/core/src/adapters/state-migrate.ts
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync as renameSync2, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
function legacyStateDir(env, name) {
  return join2(env.XDG_STATE_HOME ?? join2(env.HOME ?? homedir(), ".local", "state"), name);
}
function agentsStateDir(env, name) {
  return join2(env.HOME ?? homedir(), ".agents", name);
}
function lostRace(error) {
  const code = error.code;
  return code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY";
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function occupied(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function entriesOf(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return void 0;
  }
}
function migrateStateDir(name, env, log = console.error) {
  const from = legacyStateDir(env, name);
  const to = agentsStateDir(env, name);
  if (from === to || !existsSync(from)) return;
  try {
    mkdirSync(to, { recursive: true, mode: 448 });
  } catch (error) {
    log(`state migrate: cannot create ${to} (${messageOf(error)}); ${name}'s state stays in ${from}`);
    return;
  }
  if (moveEntries(name, from, to, log)) return;
  settleOldDir(from, to, log);
}
function moveEntries(name, from, to, log) {
  for (const entry of entriesOf(from) ?? []) {
    if (occupied(join2(to, entry))) continue;
    try {
      renameSync2(join2(from, entry), join2(to, entry));
    } catch (error) {
      if (lostRace(error)) continue;
      log(
        `state migrate: cannot move ${join2(from, entry)} (${messageOf(error)}); ${name}'s state stays in ${from}`
      );
      return true;
    }
  }
  return false;
}
function settleOldDir(from, to, log) {
  const left = entriesOf(from);
  if (left === void 0) return;
  if (left.length === 0) {
    try {
      rmdirSync(from);
    } catch {
    }
    return;
  }
  log(`state migrate: ${left.join(", ")} left in ${from} because ${to} already had entries of those names`);
}

// ../../node_modules/@muhmdraouf/core/src/router/spool-write.ts
function radarHome(env) {
  if (env.RADAR_HOME !== void 0) return env.RADAR_HOME;
  migrateStateDir("radar", env);
  return agentsStateDir(env, "radar");
}
function spoolFile(env, now) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return join3(radarHome(env), "spool", `${now.getFullYear()}-${month}-${day}.jsonl`);
}
function createSpoolWriter(env, warn = console.error, now = () => /* @__PURE__ */ new Date()) {
  let ensured = false;
  const append = (event) => {
    if (!ensured) {
      mkdirSync2(join3(radarHome(env), "spool"), { recursive: true, mode: 448 });
      ensured = true;
    }
    appendFileSync2(spoolFile(env, now()), `${JSON.stringify(event)}
`, { mode: 384 });
  };
  return (event) => {
    try {
      append(event);
    } catch (error) {
      try {
        if (error.code !== "ENOENT") throw error;
        ensured = false;
        append(event);
      } catch (again) {
        warn(`route spool: ${again instanceof Error ? again.message : String(again)}`);
      }
    }
  };
}

// ../../node_modules/@muhmdraouf/core/src/router/emergency.ts
async function startEmergency(options) {
  let accepting = true;
  const connections = trackConnections((open) => {
    if (!accepting && open === 0) options.done?.();
  });
  const passthrough = {
    name: options.name,
    display: options.display,
    claim: options.claim,
    anthropic: options.anthropic,
    env: options.env,
    state: "in emergency passthrough (the main router could not start)",
    ...options.log === void 0 ? {} : { log: options.log }
  };
  const handover = (req, res) => {
    if (req.headers[TOKEN_HEADER] !== options.token) {
      anthropicError(res, 403, "permission_error", `${options.name} router: control refused`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end('{"ok":true}');
    accepting = false;
    server.close();
    connections.drain();
    if (connections.size === 0) options.done?.();
  };
  const server = harden(
    http2.createServer((req, res) => {
      if (refuseHost(req, res, options.name, [options.port])) return;
      if (!accepting) res.setHeader("connection", "close");
      if (req.method === "GET" && req.url === options.healthPath) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: true, mode: "emergency", name: options.name, provider: options.display })
        );
      } else if (req.method === "POST" && req.url === `${options.healthPath}/handover`) handover(req, res);
      else
        receive(req, res, options.name, BODY_LIMIT_BYTES, (body) => {
          options.events?.(
            healthEvent(options.name, "fallback", "emergency passthrough", requestModel(body), Date.now())
          );
          passThrough(passthrough, req, res, body);
        });
    })
  );
  connections.watch(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}
async function runEmergency(provider2, env) {
  const prefix = provider2.envPrefix;
  const stateRoot = env[`${prefix}_STATE_DIR`] ?? ".";
  installCrashHandlers("emergency", stateRoot, "emergency");
  const log = rotatingLog(stateLayout(stateRoot).routerLog);
  await startEmergency({
    name: provider2.name,
    display: provider2.display,
    healthPath: provider2.healthPath,
    claim: provider2.claim,
    port: Number(env[`${prefix}_ROUTER_PORT`]) || provider2.port,
    anthropic: new URL(env[`${prefix}_ROUTER_ANTHROPIC_URL`] ?? "https://api.anthropic.com"),
    env,
    token: env[`${prefix}_ROUTER_TOKEN`] ?? "",
    log,
    events: createSpoolWriter(env, log),
    done: () => process.exit(0)
  });
  log(`${provider2.name}-router emergency passthrough listening on 127.0.0.1`);
  process.on("SIGTERM", () => process.exit(0));
}

// src/provider.ts
var ZAI_PROVIDER = defineProvider({
  name: "zai",
  display: "Z.ai GLM",
  slash: "/zai:",
  agentPrefix: "zai:",
  branchPrefix: "zai/",
  harness: "zai",
  artifactsEnv: "ZAI_ARTIFACTS",
  envPrefix: "ZAI",
  catalog: {
    main: {
      tier: "main",
      id: "glm-5.3",
      label: "GLM 5.3",
      behavesAs: "claude-opus-5-5",
      maxOutputTokens: 131072,
      defaultEffort: "xhigh"
    },
    flash: {
      tier: "flash",
      id: "glm-5.3-flash",
      label: "GLM 5.3 Flash",
      behavesAs: "claude-opus-5-5",
      maxOutputTokens: 131072,
      defaultEffort: "xhigh"
    }
  },
  tierNames: { main: "glm", flash: "flash" },
  defaultTier: { edit: "main", exec: "flash", readonly: "flash" },
  pingTier: "flash",
  workerLabel: "claude",
  baseUrl: "https://api.z.ai/api/anthropic",
  auth: "bearer",
  keyEnv: ["ZAI_API_KEY"],
  keyFile: "~/.config/zai-plugin-cc/env",
  billingUrl: "https://z.ai/manage-apikey/billing",
  keysUrl: "https://z.ai/manage-apikey/apikey-list",
  strip: [],
  /** Z.ai's probe: the web_search server tool answers 500 on glm-5.3-flash and works on glm-5.3. */
  webSearchModel: "glm-5.3",
  caveats: [],
  router: {
    port: 18787,
    label: "dev.muhmdraouf.zai-router",
    healthPath: "/zai-router/health",
    modelPrefixes: ["glm-"]
  }
});

// src/router/passthrough.ts
var provider = resolveProvider(ZAI_PROVIDER, process.env);
await runEmergency(
  {
    name: provider.name,
    display: provider.display,
    envPrefix: provider.envPrefix,
    healthPath: provider.router.healthPath,
    port: provider.router.port,
    claim: modelClaim(provider)
  },
  process.env
);
