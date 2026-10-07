// The router's own records: a crash log (`<state>/router-crash.log`, one JSON line per crash or supervision event,
// the last 1 MiB kept) and the rotating `router.log`. Never a header or a body. Every write is best effort: a full
// disk, a missing directory or a read-only file costs the line, never the request. Node built-ins only, so the
// emergency passthrough can log too.
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { stateLayout } from "../domain/state-layout.ts";

/** The file operations the logs use; tests inject failing ones (ENOSPC) to prove nothing propagates. */
export interface LogFs {
  append(path: string, text: string): void;
  size(path: string): number;
  read(path: string): Buffer;
  write(path: string, data: Buffer): void;
  rename(from: string, to: string): void;
}

/** Appends only where the directory already exists: a router whose state was removed (an uninstall) must not bring
 *  the directory back by logging. */
export const diskFs: LogFs = {
  append: (path, text) => appendFileSync(path, text, { mode: 0o600 }),
  size: (path) => statSync(path).size,
  read: (path) => readFileSync(path),
  write: (path, data) => writeFileSync(path, data, { mode: 0o600 }),
  rename: (from, to) => renameSync(from, to),
};

export const CRASH_LOG_LIMIT = 1024 * 1024;

/** Who wrote a crash-log line. */
type LogRole = "front" | "worker" | "emergency";

interface CrashEntry {
  readonly role: LogRole;
  readonly version: string;
  readonly event?: string;
  readonly error?: string;
  readonly stack?: string;
}

/** Appends one line, then trims the file to its last `limit` bytes (cut at a line start). Never throws. */
export function logCrash(
  stateRoot: string,
  entry: CrashEntry,
  fs: LogFs = diskFs,
  limit = CRASH_LOG_LIMIT,
): void {
  const path = stateLayout(stateRoot).crashLog;
  try {
    fs.append(path, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
    if (fs.size(path) <= limit) return;
    const data = fs.read(path);
    const tail = data.subarray(data.length - limit);
    const start = tail.indexOf(10) + 1;
    fs.write(path, tail.subarray(start));
  } catch {
    // A crash log that cannot be written must not become the next crash.
  }
}

/** What an error looks like in the crash log. */
function describe(error: unknown): { readonly error: string; readonly stack?: string } {
  if (error instanceof Error)
    return { error: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }) };
  return { error: String(error) };
}

/** Logs an uncaught exception or unhandled rejection, then exits 1, so the supervisor (or the next hook) replaces the
 *  process with a clean one. */
export function installCrashHandlers(
  role: LogRole,
  stateRoot: string,
  version: string,
  exit: (code: number) => void = (code) => process.exit(code),
  fs: LogFs = diskFs,
): void {
  const crash = (event: string) => (error: unknown) => {
    logCrash(stateRoot, { role, version, event, ...describe(error) }, fs);
    exit(1);
  };
  process.on("uncaughtException", crash("uncaughtException"));
  process.on("unhandledRejection", crash("unhandledRejection"));
}

const ROUTER_LOG_LIMIT = 4 * 1024 * 1024;

/** A line logger appending to `path`, rotated to `<path>.1` once it passes `limit` bytes. Never throws. */
export function rotatingLog(
  path: string,
  fs: LogFs = diskFs,
  limit = ROUTER_LOG_LIMIT,
): (line: string) => void {
  let written = 0;
  try {
    written = fs.size(path);
  } catch {
    written = 0;
  }
  return (line) => {
    try {
      const text = `${new Date().toISOString()} ${line}\n`;
      if (written + text.length > limit) {
        fs.rename(path, `${path}.1`);
        written = 0;
      }
      fs.append(path, text);
      written += text.length;
    } catch {
      // A full disk costs the line, nothing else.
    }
  };
}
