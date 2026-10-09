#!/usr/bin/env node
// End-to-end smoke against the built artifacts, entirely inside temp dirs: fixture transcript → started
// server → API answers → hook payload lands on /api/events → rebinding Host refused → stop leaves the
// port free → the server removes itself when Claude Code's registry drops the plugin. Nothing real
// is read, written, or left behind.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "plugin/dist/radar.js");
const hook = join(root, "plugin/dist/hook.js");

function fail(message) {
  throw new Error(message);
}

for (const artifact of [cli, hook, join(root, "plugin/public/app.css"), join(root, "plugin/public/app.js")]) {
  if (!existsSync(artifact)) fail(`missing ${artifact} — run: npm run build -w radar`);
}

const tempHome = mkdtempSync(join(tmpdir(), "radar-smoke-"));
const configDir = mkdtempSync(join(tmpdir(), "radar-claude-"));
const env = {
  ...process.env,
  HOME: tempHome,
  RADAR_HOME: join(tempHome, "state"),
  CLAUDE_CONFIG_DIR: configDir,
  ZAI_STATE_DIR: join(tempHome, "no-such-zai"),
  RADAR_AUTOSTART: "",
  RADAR_NOTIFY: "0", // never a real desktop notification from a test run
};

/* ------------------------------- fixture transcript ------------------------------- */

const t0 = Date.now() - 90_000;
const iso = (offset) => new Date(t0 + offset).toISOString();
const projectDir = join(configDir, "projects", "-Users-smoke-fixture");
mkdirSync(projectDir, { recursive: true });
const transcript = [
  {
    type: "user",
    timestamp: iso(0),
    sessionId: "smoke-session",
    cwd: "/Users/smoke/fixture",
    version: "9.9.9",
    message: { content: [{ type: "text", text: "run the thing" }] },
  },
  {
    type: "assistant",
    timestamp: iso(1200),
    sessionId: "smoke-session",
    requestId: "req_smoke_1",
    message: {
      model: "claude-sonnet-5-5",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
      },
      content: [{ type: "tool_use", id: "toolu_smoke_1", name: "Bash", input: { command: "echo hi" } }],
    },
  },
  {
    type: "user",
    timestamp: iso(2600),
    sessionId: "smoke-session",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_smoke_1", is_error: false }] },
  },
  {
    type: "assistant",
    timestamp: iso(4200),
    sessionId: "smoke-session",
    requestId: "req_smoke_2",
    message: {
      model: "claude-sonnet-5-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 30, output_tokens: 5 },
      content: [],
    },
  },
]
  .map((line) => JSON.stringify(line))
  .join("\n");

writeFileSync(join(projectDir, "session-alpha.jsonl"), `${transcript}\n`, { mode: 0o600 });

/* ----------------------------------- helpers ----------------------------------- */

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Status line of one hand-written request over a raw socket (the HTTP client would fix the Host header). */
function rawStatus(port, hostHeader) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const failOnce = (error) => reject(error);
    socket.on("error", failOnce);
    socket.on("connect", () => {
      socket.write(`GET /api/health HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      resolve(chunk.toString("latin1").split("\r\n", 1)[0]);
      socket.destroy();
    });
    socket.on("close", () => reject(new Error("socket closed before a status line")));
  });
}

async function waitFor(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== false) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
    await new Promise((sleep) => setTimeout(sleep, 250));
  }
}

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, args, {
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    timeout: 30_000,
  });
}

/* ------------------------------------ the run ----------------------------------- */

let port = 0;
try {
  const started = run([cli, "start"]);
  if (started.status !== 0)
    fail(`start exited ${started.status}\nstdout: ${started.stdout}\nstderr: ${started.stderr}`);
  const expectedLine = /^radar: http:\/\/127\.0\.0\.1:(\d{5})\r?$/;
  const lines = started.stdout.trim().split("\n");
  const match = lines.length === 1 && expectedLine.exec(lines[0]);
  if (!match) fail(`start printed unexpected output: ${JSON.stringify(started.stdout)}`);
  port = Number(match[1]);
  if (port < 10000 || port > 65535) fail(`port ${port} outside 10000-65535`);
  console.log(`start ok — http://127.0.0.1:${port} (one line, 5-digit port)`);

  const index = await get(port, "/");
  if (index.status !== 200 || !index.body.includes("<!doctype html>")) fail("GET / did not serve the page");
  const css = await get(port, "/app.css");
  if (css.status !== 200 || css.body.length < 1000) fail("GET /app.css missing or truncated");
  const js = await get(port, "/app.js");
  if (js.status !== 200 || js.body.length < 1000) fail("GET /app.js missing or truncated");
  console.log("static ok — /, /app.css, /app.js");

  const summary = await waitFor("fixture in /api/summary", 5_000, async () => {
    const response = await get(port, "/api/summary");
    if (response.status !== 200) return null;
    const parsed = JSON.parse(response.body).summary;
    return parsed !== undefined && parsed.requests >= 2 ? parsed : null;
  });
  if (summary.sessions < 1 || summary.toolCalls < 1)
    fail(`fixture not aggregated: ${JSON.stringify(summary)}`);
  console.log(
    `summary ok — ${summary.sessions} session(s), ${summary.requests} request(s), ${summary.toolCalls} tool call(s)`,
  );

  const hookPayload = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "smoke-session",
    tool_name: "Bash",
    tool_input: { command: "echo smoke" },
  });
  const hooked = spawnSync(process.execPath, [hook], {
    env,
    input: hookPayload,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (hooked.status !== 0) fail(`hook exited ${hooked.status}\nstderr: ${hooked.stderr}`);
  if (hooked.stdout !== "") fail(`hook wrote to stdout: ${JSON.stringify(hooked.stdout)}`);
  await waitFor("hook event on /api/events", 8_000, async () => {
    const response = await get(port, "/api/events?limit=50");
    if (response.status !== 200) return null;
    const events = JSON.parse(response.body).events ?? [];
    return events.some((event) => event.kind === "PostToolUse");
  });
  console.log("hook ok — payload spooled and visible on /api/events");

  const forbidden = await rawStatus(port, "evil.example");
  if (!forbidden.includes("403")) fail(`rebinding Host got "${forbidden}", expected 403`);
  console.log("host guard ok — evil.example refused");

  const stopped = run([cli, "stop"]);
  if (stopped.status !== 0 || stopped.stdout.trim() !== "radar: stopped") {
    fail(`stop printed ${JSON.stringify(stopped.stdout)} (exit ${stopped.status})`);
  }
  const again = run([cli, "stop"]);
  if (again.status !== 0 || again.stdout.trim() !== "radar: not running") {
    fail(`second stop printed ${JSON.stringify(again.stdout)} (exit ${again.status})`);
  }
  console.log("stop ok — idempotent");

  await waitFor(
    "port free",
    5_000,
    () =>
      new Promise((resolve) => {
        const probe = connect(port, "127.0.0.1");
        probe.on("error", () => resolve(true));
        probe.on("connect", () => {
          probe.destroy();
          resolve(false);
        });
      }),
  );
  console.log("port free ok");

  /* --------------------- self-removal: the server outlives the plugin --------------------- */

  const KEY = "radar@muhmdraouf";
  const ENTRY = [{ scope: "user", installPath: "/nowhere", version: "0.0.1" }];

  // One foreground server per scenario: healthy with the plugin installed, then the registry says
  // it is gone — uninstalled deletes the state dir, disabled keeps it — and the process exits 0.
  async function removalScenario(kind) {
    const home = mkdtempSync(join(tmpdir(), "radar-self-"));
    const config = mkdtempSync(join(tmpdir(), "radar-self-claude-"));
    const state = join(home, "state");
    const registry = join(config, "plugins", "installed_plugins.json");
    mkdirSync(join(config, "plugins"), { recursive: true });
    writeFileSync(registry, JSON.stringify({ version: 2, plugins: { [KEY]: ENTRY } }));
    const child = spawn(process.execPath, [cli, "start", "--foreground"], {
      env: {
        ...env,
        HOME: home,
        RADAR_HOME: state,
        CLAUDE_CONFIG_DIR: config,
        RADAR_REMOVAL_MS: "100",
      },
      stdio: "ignore",
    });
    try {
      const port = await waitFor("self-removal server.json", 10_000, () => {
        try {
          return JSON.parse(readFileSync(join(state, "server.json"), "utf8")).port;
        } catch {
          return null;
        }
      });
      const health = await get(port, "/api/health");
      if (health.status !== 200) fail(`self-removal server unhealthy: ${health.status}`);
      if (kind === "uninstalled") {
        writeFileSync(registry, JSON.stringify({ version: 2, plugins: { "other@market": ENTRY } }));
      } else {
        writeFileSync(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { [KEY]: false } }));
      }
      const code = await Promise.race([
        new Promise((resolve) => child.on("exit", resolve)),
        new Promise((resolve) => setTimeout(() => resolve("timed out"), 15_000)),
      ]);
      if (code !== 0) fail(`self-removal (${kind}): exited with ${JSON.stringify(code)}, expected 0`);
      if (kind === "uninstalled" && existsSync(state)) fail("self-removal: an uninstall left the state dir");
      if (kind === "disabled" && !existsSync(state)) fail("self-removal: a disable deleted the state dir");
      console.log(
        `self-removal ok — ${kind}: exit 0, state dir ${kind === "uninstalled" ? "removed" : "kept"}`,
      );
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
      rmSync(config, { recursive: true, force: true });
    }
  }

  await removalScenario("uninstalled");
  await removalScenario("disabled");

  console.log("smoke passed");
} finally {
  if (port !== 0) run([cli, "stop"]);
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
}
