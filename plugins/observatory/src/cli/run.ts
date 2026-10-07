/**
 * CLI logic, dependency-injected so tests drive it without processes or sockets. `start` reuses a healthy
 * server recorded in server.json; otherwise it spawns itself detached — the child binds the port and writes
 * server.json itself, which makes the parent's view race-free — then the parent polls health briefly and
 * prints exactly one line. Exit codes: 0 ok, 1 start failed, 3 wanted-a-server-and-found-none.
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

/** Parse `start|stop|status|url|open [--port N] [--since 24h] [--foreground]`. */
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
    deps.err(`observatory: ${parsed.bad}`);
    deps.err("usage: observatory start|stop|status|url|open [--port N] [--since 24h]");
    return 1;
  }
  switch (parsed.command) {
    case "start":
      return parsed.foreground ? runForeground(parsed, deps) : runStart(parsed, deps);
    case "stop":
      return runStop(deps);
    case "status":
      return runStatus(deps);
    case "url":
      return runUrl(deps);
    case "open": {
      // "start if needed, then open": a first /observatory:open must not answer "not running"
      const started = await runStart(parsed, deps);
      const info = started === 0 ? readServerInfo(deps.env) : null;
      if (info !== null) deps.openBrowser(info.url);
      return started;
    }
    case "help":
    case "--help":
    case "-h":
      deps.out("usage: observatory start|stop|status|url|open [--port N] [--since 24h]");
      deps.out("start runs the dashboard server on 127.0.0.1 on a random port unless --port is given");
      return 0;
    default:
      deps.err(`observatory: unknown command: ${parsed.command || "(none)"}`);
      deps.err("usage: observatory start|stop|status|url|open [--port N] [--since 24h]");
      return 1;
  }
}

/** A healthy server already runs: its url, and the flags it cannot take until it stops. */
function reportRunning(parsed: ParsedArgs, deps: CliDeps, recorded: ServerInfo): void {
  rememberAutostart(deps.env, true);
  deps.out(`observatory: ${recorded.url}`);
  const asked: string[] = [];
  if (parsed.sinceGiven === true) asked.push(`--since ${sinceArg(parsed.sinceMs)}`);
  if (parsed.port !== undefined && parsed.port !== recorded.port) asked.push(`--port ${parsed.port}`);
  if (asked.length > 0)
    deps.out(`observatory: already running; ${asked.join(" and ")} applies after /observatory:stop`);
}

/** A server this start launched answers: its url, and a word when it could not have its saved port. */
function reportStarted(deps: CliDeps, info: ServerInfo, before: number | null): void {
  deps.out(`observatory: ${info.url}`);
  if (before !== null && before !== info.port)
    deps.out(`observatory: port ${before} was taken; moved to ${info.port}`);
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
    await sleep(POLL_INTERVAL_MS);
    const info = readServerInfo(deps.env);
    if (info === null) continue;
    const health = await healthy(deps, info);
    if (health.ok) {
      reportStarted(deps, info, before);
      return 0;
    }
  }
  deps.err(`observatory: server did not become healthy within ${START_TIMEOUT_MS / 1000}s`);
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
  deps.out(`observatory: ${app.url}`);
  if (app.movedFrom !== undefined)
    deps.out(`observatory: port ${app.movedFrom} was taken; moved to ${app.port}`);
  // Serve until SIGTERM: this promise never settles, so runCli never resolves and the shim's
  // process.exit never fires. The listener alone also holds the loop open; this makes it explicit.
  await new Promise<void>(() => {});
  return 0;
}

async function runStop(deps: CliDeps): Promise<number> {
  rememberAutostart(deps.env, false);
  const info = readServerInfo(deps.env);
  if (info === null) {
    deps.out("observatory: not running");
    return 0;
  }
  if (deps.isAlive(info.pid)) deps.signal(info.pid, "SIGTERM");
  removeServerInfo(deps.env);
  deps.out("observatory: stopped");
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
  deps.out(`observatory: ${info.url}`);
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
  deps.out(`observatory: ${info.url}`);
  return 0;
}

const NOT_RUNNING = "observatory: not running — /observatory:start (or /observatory:open) starts it";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
