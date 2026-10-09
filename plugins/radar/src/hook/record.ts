/**
 * The hook turns one Claude Code payload into one spool line. It must never break Claude Code: any failure is
 * swallowed (logged to the state dir, capped), nothing is printed, and the process exits 0 fast. The only write
 * is a single append of one JSON line — O_APPEND keeps concurrent sessions from clobbering each other.
 */
import { appendFileSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpoolLine } from "../shared/model.ts";
import { ensureStateDirs, hookErrorLog, spoolDir } from "../shared/paths.ts";
import { DEFAULT_UPSTREAM } from "../shared/provider.ts";
import { scrub, scrubText } from "../shared/redact.ts";

/** Env vars whose values are model ids worth recording on session start (values are masked anyway). */
const MODEL_ENV = /^(ANTHROPIC|CLAUDE_CODE)_[A-Z0-9_]*MODEL[A-Z0-9_]*$/;

/** Keys the hook sets itself; unknown payload keys ride along scrubbed, these never duplicate. */
const OWNED_KEYS = new Set([
  "ts",
  "event",
  "session_id",
  "transcript_path",
  "cwd",
  "agent_id",
  "agent_type",
  "tool_name",
  "tool_use_id",
  "tool_input",
  "tool_response",
  "prompt",
  "source",
  "reason",
  "trigger",
  "pid",
  "ppid",
  "base_url",
  "model_env",
  "cc_version",
  "hook_event_name",
]);

/** String keys copied straight from the payload when present. */
const STRING_KEYS = [
  "session_id",
  "transcript_path",
  "cwd",
  "agent_type",
  "tool_name",
  "tool_use_id",
  "source",
  "reason",
  "trigger",
] as const;

export type HookIo = {
  env: NodeJS.ProcessEnv;
  now: () => Date;
  pid: number;
  ppid: number;
  /** Append one line to a path, creating the spool dir first. Implementations may throw; that is caught. */
  appendLine: (path: string, line: string) => void;
  /** Best-effort error log; implementations swallow their own failures. */
  logError: (path: string, line: string) => void;
};

export function parsePayload(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return null;
  }
}

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

/** Model-id env vars set in this hook's environment, masked like every other string. */
export function collectModelEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const found: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (MODEL_ENV.test(key) && typeof value === "string" && value !== "") {
      found[key] = scrubText(value) ?? "";
    }
  }
  return Object.keys(found).length > 0 ? found : undefined;
}

function applyStringKeys(line: SpoolLine, payload: Record<string, unknown>): void {
  for (const key of STRING_KEYS) {
    const value = str(payload, key);
    if (value !== undefined) line[key] = value;
  }
  const agentId = str(payload, "agent_id") ?? str(payload, "agentId");
  if (agentId !== undefined) line.agent_id = agentId;
}

function applyScrubbedFields(line: SpoolLine, payload: Record<string, unknown>): void {
  const prompt = scrubText(payload.prompt);
  if (prompt !== undefined) line.prompt = prompt;
  const toolInput = payload.tool_input ?? payload.toolInput;
  if (toolInput !== undefined) line.tool_input = scrub(toolInput);
  const toolResponse = payload.tool_response ?? payload.toolResponse;
  if (toolResponse !== undefined) line.tool_response = scrub(toolResponse);
}

/** SessionStart lines carry the upstream and model environment so the dashboard can attribute requests. */
function applySessionExtras(line: SpoolLine, io: HookIo): void {
  if (line.event !== "SessionStart") return;
  line.base_url = io.env.ANTHROPIC_BASE_URL ?? DEFAULT_UPSTREAM;
  const modelEnv = collectModelEnv(io.env);
  if (modelEnv !== undefined) line.model_env = modelEnv;
  const version = io.env.CLAUDE_CODE_VERSION;
  if (typeof version === "string" && version !== "") line.cc_version = version;
}

function applyUnknownKeys(line: SpoolLine, payload: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(payload)) {
    if (!OWNED_KEYS.has(key) && !(key in line)) line[key] = scrub(value);
  }
}

/** Build the spool line for one payload: known fields mapped, everything unknown kept but scrubbed. */
export function buildSpoolLine(payload: Record<string, unknown>, io: HookIo): SpoolLine {
  const line: SpoolLine = { ts: io.now().toISOString(), event: str(payload, "hook_event_name") ?? "unknown" };
  applyStringKeys(line, payload);
  applyScrubbedFields(line, payload);
  line.pid = io.pid;
  line.ppid = io.ppid;
  applySessionExtras(line, io);
  applyUnknownKeys(line, payload);
  return line;
}

/**
 * Parse, build, append. Returns the recorded event name, or null when nothing reached the spool (the error log
 * saw it instead) — the caller uses the name to decide about autostart, and nothing else.
 */
export function runHook(raw: string, io: HookIo): string | null {
  try {
    const payload = parsePayload(raw);
    if (payload === null) {
      io.logError(hookErrorLog(io.env), `unparseable stdin (${raw.length} bytes)`);
      return null;
    }
    const line = buildSpoolLine(payload, io);
    const date = line.ts.slice(0, 10);
    io.appendLine(`${spoolDir(io.env)}/${date}.jsonl`, `${JSON.stringify(line)}\n`);
    return line.event;
  } catch (error) {
    io.logError(hookErrorLog(io.env), String(error instanceof Error ? error.message : error));
    return null;
  }
}

const ERROR_LOG_CAP = 1_048_576;
const ERROR_LOG_TAIL = 524_288;

/** The spool's whole budget: past it, the oldest day goes first; a single day past it keeps its newer half. */
export const SPOOL_CAP = 64 * 1_048_576;
const SPOOL_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Rewrite a file to its last `keep` bytes, cut at a line boundary, so no line is left half there. */
function keepTail(path: string, size: number, keep: number): void {
  const tail = readFileSync(path).subarray(Math.max(0, size - keep));
  const cut = tail.indexOf(10);
  writeFileSync(path, cut >= 0 ? tail.subarray(cut + 1) : tail, { mode: 0o600 });
}

/**
 * Bound the spool: while its dated files add up past `cap`, delete the oldest; when one file alone is past it, keep
 * its newer half. Never throws — a spool that cannot be pruned is still better than a hook that fails.
 */
export function pruneSpool(dir: string, cap = SPOOL_CAP): void {
  try {
    const files = readdirSync(dir)
      .filter((name) => SPOOL_FILE.test(name))
      .sort()
      .map((name) => ({ path: join(dir, name), size: statSync(join(dir, name)).size }));
    let total = files.reduce((sum, file) => sum + file.size, 0);
    while (total > cap && files.length > 1) {
      const oldest = files.shift() as { path: string; size: number };
      unlinkSync(oldest.path);
      total -= oldest.size;
    }
    const last = files[0];
    if (last !== undefined && last.size > cap) keepTail(last.path, last.size, Math.floor(cap / 2));
  } catch {
    // retention is a courtesy; the append that follows must still be tried
  }
}

/** The real IO: 0700 state dirs, a bounded spool, one 0600 append, error log capped at 1 MB (keeps the newer half). */
export function makeIo(env: NodeJS.ProcessEnv, now: () => Date, pid: number, ppid: number): HookIo {
  return {
    env,
    now,
    pid,
    ppid,
    appendLine: (path, text) => {
      ensureStateDirs(env);
      appendFileSync(path, text, { mode: 0o600 });
      pruneSpool(spoolDir(env));
    },
    logError: (path, text) => {
      try {
        const line = `${now().toISOString()} ${text}\n`;
        try {
          const size = statSync(path).size;
          if (size > ERROR_LOG_CAP) keepTail(path, size, ERROR_LOG_TAIL);
        } catch {
          // no file yet, or unreadable — appending is still the best we can do
        }
        appendFileSync(path, line, { mode: 0o600 });
      } catch {
        // the error log is a courtesy; if even it fails, silence is correct
      }
    },
  };
}
