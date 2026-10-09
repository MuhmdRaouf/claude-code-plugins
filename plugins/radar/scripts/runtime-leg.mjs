#!/usr/bin/env node
// One runtime leg: run this file with `bun` or with `node` and it drives the committed bundle under that
// very runtime (process.execPath), entirely inside temp dirs and on a random port, from an installed copy:
// plugin/ copied alone into a temp HOME's plugin cache, the way Claude Code installs it, and driven through
// the exact command lines of hooks.json and commands/*.md with only this runtime on PATH:
//   a hook before anything starts nothing → /radar:start → dashboard page + assets → live /api/stream
//   (snapshot, a delta after a transcript append, the stream cut by `stop`) → hooks → /radar:stop →
//   port free → /radar:open starts and opens it → after a "reboot" the next SessionStart brings it
//   back → /radar:stop, and the next SessionStart starts nothing.
// Nothing real is read or written: HOME, state and the Claude config dir are all temp.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = process.versions.bun !== undefined ? "bun" : "node";
const label = `${runtime} ${process.versions.bun ?? process.versions.node}`;

function fail(message) {
  throw new Error(`[${label}] ${message}`);
}

const tempHome = mkdtempSync(join(tmpdir(), "radar-leg-"));
// the installed copy: only plugin/ (the marketplace source), nothing of the repo around it
const pluginRoot = join(tempHome, ".claude", "plugins", "cache", "muhmdraouf", "radar", "0.0.1");
cpSync(join(root, "plugin"), pluginRoot, { recursive: true });
const cli = join(pluginRoot, "dist/radar.js");
for (const artifact of [
  cli,
  join(pluginRoot, "dist/hook.js"),
  join(pluginRoot, "dist/package.json"),
  join(pluginRoot, "public/index.html"),
  join(pluginRoot, "public/app.css"),
  join(pluginRoot, "public/app.js"),
]) {
  if (!existsSync(artifact)) fail(`the installed copy lacks ${artifact} — run: npm run build -w radar`);
}
// PATH as a fresh user's Claude Code has it: this runtime, a stand-in browser opener, the system dirs
const bin = mkdtempSync(join(tmpdir(), "radar-leg-bin-"));
symlinkSync(process.execPath, join(bin, runtime));
const openedLog = join(bin, "opened.log");
for (const opener of ["open", "xdg-open"]) {
  writeFileSync(join(bin, opener), `#!/bin/sh\necho "$*" >> "${openedLog}"\n`);
  chmodSync(join(bin, opener), 0o755);
}
const userPath = `${bin}:/usr/bin:/bin`;
const configDir = mkdtempSync(join(tmpdir(), "radar-leg-claude-"));
const env = {
  ...process.env,
  HOME: tempHome,
  RADAR_HOME: join(tempHome, "state"),
  CLAUDE_CONFIG_DIR: configDir,
  ZAI_STATE_DIR: join(tempHome, "no-such-zai"),
  CLAUDE_PLUGIN_ROOT: pluginRoot,
  RADAR_NOTIFY: "0", // never a real desktop notification from a test run
};
delete env.RADAR_AUTOSTART; // a fresh user sets nothing

const projectDir = join(configDir, "projects", "-Users-leg-fixture");
mkdirSync(projectDir, { recursive: true });
const transcriptFile = join(projectDir, "session-leg.jsonl");
const now = Date.now();
const line = (value) => `${JSON.stringify(value)}\n`;
writeFileSync(
  transcriptFile,
  line({
    type: "user",
    timestamp: new Date(now - 5000).toISOString(),
    sessionId: "leg-session",
    cwd: "/Users/leg/fixture",
    message: { content: [{ type: "text", text: "hello" }] },
  }),
  { mode: 0o600 },
);

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, args, {
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    timeout: 30_000,
  });
}

/** A slash command, as Claude Code runs it: the !`…` line of commands/<name>.md in the installed copy, at expansion. */
function slash(name, args = "") {
  const md = readFileSync(join(pluginRoot, "commands", `${name}.md`), "utf8");
  const block = /^!`(.*)`$/m.exec(md);
  if (block === null) fail(`commands/${name}.md has no !\`…\` line`);
  return spawnSync(
    "/bin/sh",
    ["-c", block[1].replaceAll("$ARGUMENTS", args).replaceAll(`$${"{"}CLAUDE_PLUGIN_ROOT}`, pluginRoot)],
    {
      env: { ...env, PATH: userPath },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

const hooks = JSON.parse(readFileSync(join(pluginRoot, "hooks/hooks.json"), "utf8"));
const command = hooks.hooks.SessionStart[0].hooks[0].command;
/** A hook, as Claude Code runs it: the hooks.json command line, the event on stdin. */
function hook(event, sessionId, path = userPath, said = "") {
  const result = spawnSync("/bin/sh", ["-c", command], {
    env: { ...env, PATH: path },
    input: JSON.stringify({ hook_event_name: event, session_id: sessionId }),
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.status !== 0 || result.stdout !== said || result.stderr !== "")
    fail(`${event} hook not silent${said ? " but for its one line" : ""}: ${JSON.stringify(result)}`);
}
const serverJson = join(tempHome, "state", "server.json");
// A server that answers on the port in server.json; with `notPid`, only once a process other than that one wrote it
// (a restarted server answers on the same port a moment before it replaces the dead one's file).
async function liveServer(timeoutMs, notPid) {
  return waitFor("the server", timeoutMs, async () => {
    try {
      const info = JSON.parse(readFileSync(serverJson, "utf8"));
      if (notPid !== undefined && info.pid === notPid) return null;
      return (await getText(info.port, "/api/health")).status === 200 ? info : null;
    } catch {
      return null;
    }
  });
}
const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));

async function waitFor(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== false) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await new Promise((sleep) => setTimeout(sleep, 100));
  }
}

async function getText(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
}

/** Split an SSE byte stream into parsed `data:` frames, calling `onFrame` for each. Resolves when it closes. */
async function readFrames(body, onFrame) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    for (let at = buffer.indexOf("\n\n"); at !== -1; at = buffer.indexOf("\n\n")) {
      const chunk = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      if (chunk.startsWith("data: ")) onFrame(JSON.parse(chunk.slice(6)));
    }
  }
}

/** Open the SSE stream; `next(pred)` resolves with the first parsed frame that matches. */
function openStream(port) {
  const controller = new AbortController();
  const frames = [];
  const waiters = [];
  let ended = null;
  const wakeAll = () => {
    for (const wake of waiters.splice(0)) wake();
  };
  const pump = (async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: controller.signal });
    if (response.status !== 200) fail(`/api/stream answered ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("text/event-stream")) fail(`/api/stream content-type ${type}`);
    await readFrames(response.body, (frame) => {
      frames.push(frame);
      wakeAll();
    });
    return "closed";
  })().then(
    (how) => {
      ended = how;
      wakeAll();
    },
    (error) => {
      ended = error.name === "AbortError" ? "aborted" : `error: ${error.message}`;
      wakeAll();
    },
  );
  return {
    frames,
    ended: () => ended,
    async next(predicate, what, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = frames.find(predicate);
        if (hit !== undefined) return hit;
        if (ended !== null) fail(`stream ended (${ended}) before ${what}`);
        if (Date.now() > deadline) fail(`timed out waiting for stream ${what}`);
        await new Promise((wake) => {
          waiters.push(wake);
          setTimeout(wake, 200);
        });
      }
    },
    abort: () => controller.abort(),
    done: pump,
  };
}

let port = 0;
try {
  // installed and never started: a session's hooks record, and start nothing
  hook("SessionStart", "leg-fresh");
  await sleep(1500);
  if (existsSync(serverJson)) fail("a SessionStart hook started the server before /radar:start");
  console.log(`[${label}] fresh install ok — hooks silent, nothing started`);

  const started = slash("start");
  if (started.status !== 0) fail(`start exited ${started.status}\n${started.stdout}\n${started.stderr}`);
  const match = /^radar: http:\/\/127\.0\.0\.1:(\d{5})\r?$/.exec(started.stdout.trim());
  if (match === null) fail(`start printed ${JSON.stringify(started.stdout)}`);
  port = Number(match[1]);
  console.log(`[${label}] start ok — port ${port}`);

  const page = await getText(port, "/");
  if (page.status !== 200 || !page.type.startsWith("text/html") || !page.body.includes("<!doctype html>"))
    fail("dashboard page not served");
  for (const [path, type] of [
    ["/app.css", "text/css"],
    ["/app.js", "text/javascript"],
  ]) {
    const asset = await getText(port, path);
    if (asset.status !== 200 || !asset.type.startsWith(type) || asset.body.length < 1000)
      fail(`${path} missing, wrong type (${asset.type}) or truncated`);
  }
  const health = await getText(port, "/api/health");
  if (health.status !== 200) fail(`/api/health ${health.status}`);
  console.log(`[${label}] page + assets ok`);

  // live stream: snapshot first, then a delta for a line appended to the transcript afterwards
  const stream = openStream(port);
  const snapshot = await stream.next((frame) => frame.type === "snapshot", "snapshot");
  if (snapshot.summary === undefined) fail("snapshot without summary");
  appendFileSync(
    transcriptFile,
    line({
      type: "assistant",
      timestamp: new Date().toISOString(),
      sessionId: "leg-session",
      requestId: "req_leg_live",
      message: {
        model: "claude-sonnet-5-5",
        stop_reason: "end_turn",
        usage: { input_tokens: 11, output_tokens: 7 },
        content: [],
      },
    }),
  );
  await stream.next(
    (frame) => frame.type === "request" && frame.request?.id === "req_leg_live",
    "a live request delta",
    15_000,
  );
  console.log(`[${label}] live stream ok — snapshot, then a delta after a transcript append`);

  // the hooks.json command, with only this runtime on PATH, then with nothing on PATH
  hook("Stop", "leg-hook");
  hook("Stop", "leg-hook", "/var/empty");
  await stream.next(
    (frame) =>
      frame.type === "event" && frame.event?.kind === "Stop" && frame.event?.sessionId === "leg-hook",
    "the hook event on the stream",
    10_000,
  );
  console.log(`[${label}] hooks ok — ${basename(bin)}/${runtime} records, no runtime exits 0 silently`);

  // stop with the stream still open: the server must cut it and free the port
  const serverPid = JSON.parse(readFileSync(serverJson, "utf8")).pid;
  const stopped = slash("stop");
  if (stopped.status !== 0 || stopped.stdout.trim() !== "radar: stopped")
    fail(`stop printed ${JSON.stringify(stopped.stdout)} (exit ${stopped.status})`);
  await waitFor("the stream to be cut", 10_000, () => stream.ended() !== null);
  await waitFor("the server process to exit", 10_000, () => {
    try {
      process.kill(serverPid, 0);
      return false;
    } catch {
      return true;
    }
  });
  stream.abort();
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
  console.log(`[${label}] stop ok — open stream cut, port free`);

  // /radar:open on a stopped dashboard starts it, then opens it
  const opened = slash("open");
  const openMatch = /^radar: (http:\/\/127\.0\.0\.1:(\d{5}))\r?$/.exec(opened.stdout.trim());
  if (opened.status !== 0 || openMatch === null) fail(`open printed ${JSON.stringify(opened)}`);
  if (Number(openMatch[2]) !== port)
    fail(`the dashboard moved from port ${port} to ${openMatch[2]} across a stop`);
  port = Number(openMatch[2]);
  await waitFor("the browser opener", 5_000, () => existsSync(openedLog));
  if (readFileSync(openedLog, "utf8").trim() !== openMatch[1]) fail("open did not open the dashboard's url");
  console.log(`[${label}] open ok — started the stopped dashboard and opened it`);

  // a reboot: the server is gone, nothing stopped it on purpose; the next SessionStart brings it back
  // (spawned detached, it must outlive the hook process), with nothing configured
  const before = JSON.parse(readFileSync(serverJson, "utf8"));
  process.kill(before.pid, "SIGKILL");
  await waitFor("the killed server to be gone", 10_000, () => {
    try {
      process.kill(before.pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  hook(
    "SessionStart",
    "leg-after-reboot",
    userPath,
    `${JSON.stringify({ systemMessage: `radar: dashboard at http://127.0.0.1:${port}` })}\n`,
  );
  const back = await liveServer(15_000, before.pid);
  if (back.pid === before.pid) fail("the server did not come back as a new process");
  if (back.port !== port) fail(`the dashboard moved from port ${port} to ${back.port} across a reboot`);
  port = back.port;
  console.log(
    `[${label}] autostart ok — the next session brought the dashboard back on its port, and told the user`,
  );

  // stopped on purpose: it stays stopped
  const stopped2 = slash("stop");
  if (stopped2.status !== 0 || stopped2.stdout.trim() !== "radar: stopped")
    fail(`stop after autostart printed ${JSON.stringify(stopped2.stdout)}`);
  port = 0;
  hook("SessionStart", "leg-after-stop");
  await sleep(1500);
  if (existsSync(serverJson)) fail("a SessionStart hook restarted a dashboard the user stopped");
  console.log(`[${label}] stop ok — a stopped dashboard stays stopped`);
  console.log(`[${label}] runtime leg passed`);
} finally {
  if (port !== 0) run([cli, "stop"]);
  rmSync(bin, { recursive: true, force: true });
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
}
