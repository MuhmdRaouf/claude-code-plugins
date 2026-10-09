/**
 * CLI logic, dependency-injected so tests drive it without processes or sockets. `start` reuses a healthy
 * server recorded in server.json; otherwise it spawns itself detached — the child binds the port and writes
 * server.json itself, which makes the parent's view race-free — then the parent polls health briefly and
 * prints exactly one line. `watch` polls the running server's alerts and prints one line per new alert id.
 * Exit codes: 0 ok, 1 start failed, 3 wanted-a-server-and-found-none.
 */
import { readServerInfo, removeServerInfo, type ServerInfo, startApp } from "../server/app.ts";
import { rememberAutostart, savedPort } from "../shared/paths.ts";
import { VERSION } from "../shared/version.ts";

export type FetchResult = { ok: boolean; body: Record<string, unknown> | null };

export type CliDeps = {
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  err(line: string): void;
  /** Fetch a health endpoint with a short timeout; never throws — network trouble is `ok: false`. */
  fetchJson(url: string): Promise<FetchResult>;
  /** Wait between polls; injected so the start and watch loops run instantly in tests. */
  sleep(ms: number): Promise<void>;
  /** Checked before every watch poll: true ends the loop quietly. Tests end it; production never does. */
  shouldStop(): boolean;
  /** Spawn this CLI again detached with the given sub-args; returns the child pid. */
  spawnDetached(args: string[]): number;
  signal(pid: number, signal: NodeJS.Signals): boolean;
  isAlive(pid: number): boolean;
  openBrowser(url: string): void;
  now(): number;
  sinceMs: number;
};

export type ParsedArgs = {
  command: string;
  port?: number;
  sinceMs: number;
  /** --since was given (not the default): a running server cannot take it */
  sinceGiven?: boolean;
  foreground: boolean;
  bad: string | null;
};

type FlagResult = { ok: true; next: number } | { ok: false; bad: string };

function applyPort(parsed: ParsedArgs, argv: string[], i: number): FlagResult {
  const value = argv[i + 1];
  const port = value === undefined ? NaN : Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    return { ok: false, bad: `--port needs a number in 1024..65535, got: ${value ?? "nothing"}` };
  }
  parsed.port = port;
  return { ok: true, next: i + 2 };
}

function applySince(parsed: ParsedArgs, argv: string[], i: number): FlagResult {
  const value = argv[i + 1];
  const ms = parseSince(value);
  if (ms === null) {
    return { ok: false, bad: `--since needs a duration like 30m, 24h or 7d, got: ${value ?? "nothing"}` };
  }
  parsed.sinceMs = ms;
  parsed.sinceGiven = true;
  return { ok: true, next: i + 2 };
}

function applyFlag(parsed: ParsedArgs, argv: string[], i: number): FlagResult {
  const arg = argv[i] ?? "";
  if (arg === "--foreground") {
    parsed.foreground = true;
    return { ok: true, next: i + 1 };
  }
  if (arg === "--port") return applyPort(parsed, argv, i);
  if (arg === "--since") return applySince(parsed, argv, i);
  return { ok: false, bad: `unknown argument: ${arg}` };
}

/** Parse `start|stop|status|url|open|watch [--port N] [--since 24h] [--foreground]`. */
export function parseArgs(argv: string[], defaultSinceMs: number): ParsedArgs {
  const parsed: ParsedArgs = {
    command: argv[0] ?? "",
    sinceMs: defaultSinceMs,
    foreground: false,
    bad: null,
  };
  let i = 1;
  while (i < argv.length) {
    const result = applyFlag(parsed, argv, i);
    if (!result.ok) {
      parsed.bad = result.bad;
      return parsed;
    }
    i = result.next;
  }
  return parsed;
}

/** Unit suffix → milliseconds; the fallback is hours, so a bare number means hours. */
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `Ns`, `Nm`, `Nh`, `Nd` (case-insensitive); a bare number counts as hours. */
export function parseSince(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const match = /^(\d+)\s*([smhd]?)[a-z]*$/i.exec(raw.trim());
  if (match === null) return null;
  const amount = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (match[2] ?? "").toLowerCase(); // the capture is "" when no unit was given, not undefined
  return amount * (UNIT_MS[unit] ?? 3_600_000);
}

const START_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

async function healthy(deps: CliDeps, info: ServerInfo): Promise<FetchResult> {
  return deps.fetchJson(`http://127.0.0.1:${info.port}/api/health`);
}

function fmtUptime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** Run one CLI invocation; the returned code is the process exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseArgs(argv, deps.sinceMs);
  if (parsed.bad !== null) {
    deps.err(`radar: ${parsed.bad}`);
    deps.err("usage: radar start|stop|status|url|open|watch [--port N] [--since 24h]");
    return 1;
  }
  switch (parsed.command) {
    case "start":
      return parsed.foreground ? runForeground(parsed, deps) : runStart(parsed, deps);
    case "stop":
      return runStop(deps);
    case "status":
      return runStatus(deps);
    case "watch":
      return runWatch(deps);
    case "url":
      return runUrl(deps);
    case "open": {
      // "start if needed, then open": a first /radar:open must not answer "not running"
      const started = await runStart(parsed, deps);
      const info = started === 0 ? readServerInfo(deps.env) : null;
      if (info !== null) deps.openBrowser(info.url);
      return started;
    }
    case "help":
    case "--help":
    case "-h":
      deps.out("usage: radar start|stop|status|url|open|watch [--port N] [--since 24h]");
      deps.out("start runs the dashboard server on 127.0.0.1 on a random port unless --port is given");
      return 0;
    default:
      deps.err(`radar: unknown command: ${parsed.command || "(none)"}`);
      deps.err("usage: radar start|stop|status|url|open|watch [--port N] [--since 24h]");
      return 1;
  }
}

/** A healthy server already runs: its url, and the flags it cannot take until it stops. */
function reportRunning(parsed: ParsedArgs, deps: CliDeps, recorded: ServerInfo): void {
  rememberAutostart(deps.env, true);
  deps.out(`radar: ${recorded.url}`);
  const asked: string[] = [];
  if (parsed.sinceGiven === true) asked.push(`--since ${sinceArg(parsed.sinceMs)}`);
  if (parsed.port !== undefined && parsed.port !== recorded.port) asked.push(`--port ${parsed.port}`);
  if (asked.length > 0) deps.out(`radar: already running; ${asked.join(" and ")} applies after /radar:stop`);
}

/** A server this start launched answers: its url, and a word when it could not have its saved port. */
function reportStarted(deps: CliDeps, info: ServerInfo, before: number | null): void {
  deps.out(`radar: ${info.url}`);
  if (before !== null && before !== info.port)
    deps.out(`radar: port ${before} was taken; moved to ${info.port}`);
}

async function runStart(parsed: ParsedArgs, deps: CliDeps): Promise<number> {
  const recorded = readServerInfo(deps.env);
  if (recorded !== null && deps.isAlive(recorded.pid)) {
    const health = await healthy(deps, recorded);
    if (health.ok) {
      reportRunning(parsed, deps, recorded);
      return 0;
    }
    removeServerInfo(deps.env);
  }
  // Remembered before the launch, not once it answers: a stop in between (the server takes a moment) must win.
  rememberAutostart(deps.env, true);
  const before = parsed.port === undefined ? savedPort(deps.env) : null;
  const args = ["start", "--foreground", "--since", sinceArg(parsed.sinceMs)];
  if (parsed.port !== undefined) args.push("--port", String(parsed.port));
  deps.spawnDetached(args);
  const deadline = deps.now() + START_TIMEOUT_MS;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    const info = readServerInfo(deps.env);
    if (info === null) continue;
    const health = await healthy(deps, info);
    if (health.ok) {
      reportStarted(deps, info, before);
      return 0;
    }
  }
  deps.err(`radar: server did not become healthy within ${START_TIMEOUT_MS / 1000}s`);
  return 1;
}

/** Round ms back to a compact flag value the child re-parses to the same window. */
function sinceArg(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

async function runForeground(parsed: ParsedArgs, deps: CliDeps): Promise<number> {
  const app = await startApp({
    env: deps.env,
    version: VERSION,
    sinceMs: parsed.sinceMs,
    ...(parsed.port !== undefined ? { port: parsed.port } : {}),
  });
  deps.out(`radar: ${app.url}`);
  if (app.movedFrom !== undefined) deps.out(`radar: port ${app.movedFrom} was taken; moved to ${app.port}`);
  // Serve until SIGTERM: this promise never settles, so runCli never resolves and the shim's
  // process.exit never fires. The listener alone also holds the loop open; this makes it explicit.
  await new Promise<void>(() => {});
  return 0;
}

async function runStop(deps: CliDeps): Promise<number> {
  rememberAutostart(deps.env, false);
  const info = readServerInfo(deps.env);
  if (info === null) {
    deps.out("radar: not running");
    return 0;
  }
  if (deps.isAlive(info.pid)) deps.signal(info.pid, "SIGTERM");
  removeServerInfo(deps.env);
  deps.out("radar: stopped");
  return 0;
}

async function runStatus(deps: CliDeps): Promise<number> {
  const info = readServerInfo(deps.env);
  if (info === null || !deps.isAlive(info.pid)) {
    deps.out(NOT_RUNNING);
    return 3;
  }
  const health = await healthy(deps, info);
  if (!health.ok) {
    deps.out(NOT_RUNNING);
    return 3;
  }
  const sessions = typeof health.body?.sessions === "number" ? health.body.sessions : 0;
  const uptime =
    typeof health.body?.uptimeMs === "number" ? health.body.uptimeMs : deps.now() - info.startedAt;
  deps.out(`radar: ${info.url}`);
  deps.out(`  up ${fmtUptime(uptime)}, ${sessions} session${sessions === 1 ? "" : "s"} tracked, v${VERSION}`);
  return 0;
}

async function runUrl(deps: CliDeps): Promise<number> {
  const info = readServerInfo(deps.env);
  if (info === null) {
    deps.out(NOT_RUNNING);
    return 3;
  }
  const health = await healthy(deps, info);
  if (!health.ok) {
    deps.out(NOT_RUNNING);
    return 3;
  }
  deps.out(`radar: ${info.url}`);
  return 0;
}

const NOT_RUNNING = "radar: not running — /radar:start (or /radar:open) starts it";

/** Poll cadence and failure budget of `watch`: three missed polls in a row mean the server is gone. */
const WATCH_INTERVAL_MS = 15_000;
const WATCH_MAX_MISSES = 3;

/** The words the dashboard's alert strip shows for each kind; an unknown kind prints as itself. */
const KIND_LABEL: Record<string, string> = {
  stuck: "Stuck",
  loop: "Loop",
  retry_storm: "Retry storm",
  context: "Context nearly full",
  budget: "Budget",
};

/** One alert as `watch` prints it: the id it dedupes on, and the three parts of its line. */
type WatchedAlert = { id: string; kind: string; project: string; sessionId: string; message: string };

/** The alerts of a /api/alerts body, read leniently; null when the answer is not an alert list. */
function readAlerts(body: Record<string, unknown> | null): WatchedAlert[] | null {
  const raw = body?.alerts;
  if (!Array.isArray(raw)) return null;
  const alerts: WatchedAlert[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const alert = item as Record<string, unknown>;
    if (typeof alert.id !== "string" || typeof alert.kind !== "string" || typeof alert.detail !== "string")
      continue;
    alerts.push({
      id: alert.id,
      kind: alert.kind,
      project: typeof alert.project === "string" ? alert.project : "",
      sessionId: typeof alert.sessionId === "string" ? alert.sessionId : "",
      message: alert.detail,
    });
  }
  return alerts;
}

/** The middle of a watch line: the project, else a short session id, else the scope the alert covers. */
function whereText(alert: WatchedAlert): string {
  if (alert.project !== "") return alert.project;
  if (alert.sessionId !== "") return alert.sessionId.slice(0, 8);
  return alert.kind === "budget" ? "All sessions" : "Router";
}

/** Print one line per alert id not seen before. */
function printNewAlerts(deps: CliDeps, alerts: WatchedAlert[], seen: Set<string>): void {
  for (const alert of alerts) {
    if (seen.has(alert.id)) continue;
    seen.add(alert.id);
    deps.out(`radar: ${KIND_LABEL[alert.kind] ?? alert.kind} · ${whereText(alert)} · ${alert.message}`);
  }
}

/**
 * Poll the running server's alerts every 15 s and print one line per alert id not seen before, alerts already
 * current at the first poll included. Quiet otherwise; three missed polls in a row end it with exit 0, since
 * the server it watched is gone and a Monitor would only start the watch again.
 */
async function runWatch(deps: CliDeps): Promise<number> {
  const info = readServerInfo(deps.env);
  if (info === null || !deps.isAlive(info.pid)) {
    deps.out("radar: not running");
    return 3;
  }
  if (!(await healthy(deps, info)).ok) {
    deps.out("radar: not running");
    return 3;
  }
  deps.out(`radar: watching alerts at ${info.url}`);
  const seen = new Set<string>();
  let misses = 0;
  while (!deps.shouldStop()) {
    await deps.sleep(WATCH_INTERVAL_MS);
    const result = await deps.fetchJson(`${info.url}/api/alerts`);
    const alerts = result.ok ? readAlerts(result.body) : null;
    if (alerts === null) {
      misses += 1;
      if (misses >= WATCH_MAX_MISSES) {
        deps.out("radar: server stopped");
        return 0;
      }
      continue;
    }
    misses = 0;
    printNewAlerts(deps, alerts, seen);
  }
  return 0;
}
