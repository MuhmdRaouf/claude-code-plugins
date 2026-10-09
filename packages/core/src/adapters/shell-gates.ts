import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { GateResult } from "../domain/job.ts";
import type { GateRunner } from "../ports/index.ts";
import { pickAllowlisted } from "./env.ts";

const TAIL_LINES = 60;
const TAIL_CHARS = 8000;
/** SIGTERM first; whatever is still alive this long after a timeout gets SIGKILL. */
const KILL_GRACE_MS = 2000;
/** After the shell exits, how long a stray holder of its pipes may delay the result. */
const DRAIN_MS = 1000;

/** The last `count` lines of text (a trailing newline does not start an extra line). */
export function lastLines(text: string, count: number): string {
  let start = text.endsWith("\n") ? text.length - 1 : text.length;
  for (let line = 0; line < count; line++) {
    const newline = start > 0 ? text.lastIndexOf("\n", start - 1) : -1;
    if (newline < 0) return text;
    start = newline;
  }
  return text.slice(start + 1);
}

/** Rolling window over combined output: enough to cut the final tail from, never the whole output in memory. */
class Tail {
  private text = "";

  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > 2 * TAIL_CHARS) this.text = this.text.slice(-TAIL_CHARS);
  }

  value(): string {
    return lastLines(this.text.slice(-TAIL_CHARS), TAIL_LINES);
  }
}

function gateEnv(passEnv: Readonly<Record<string, string>>): Record<string, string> {
  return { ...pickAllowlisted(process.env), ...passEnv };
}

/** Signals the whole process group led by pid; a group that is already gone is fine. */
function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: nothing left in the group.
  }
}

interface GateExit {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly spawnError?: string;
}

/** Resolves once the shell has exited and its output is drained. On timeout the group gets SIGTERM, then SIGKILL after
 *  the grace period; after a normal exit, leftovers of the group (background jobs) are killed too. */
function awaitGate(child: ChildProcess, timeoutMs: number): Promise<GateExit> {
  return new Promise((resolve) => {
    let timedOut = false;
    let code: number | null = null;
    const timers: NodeJS.Timeout[] = [];
    const finish = (spawnError?: string) => {
      for (const timer of timers) clearTimeout(timer);
      resolve(spawnError === undefined ? { code, timedOut } : { code, timedOut, spawnError });
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        signalGroup(child.pid, "SIGTERM");
        timers.push(setTimeout(() => signalGroup(child.pid, "SIGKILL"), KILL_GRACE_MS));
      }, timeoutMs),
    );
    child.once("error", (error) => finish(error.message));
    child.once("exit", (exitCode) => {
      code = exitCode;
      signalGroup(child.pid, "SIGKILL");
      timers.push(
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish();
        }, DRAIN_MS),
      );
    });
    child.once("close", () => finish());
  });
}

async function runGate(
  provider: string,
  cwd: string,
  gate: { readonly run: string; readonly timeoutMs: number },
  passEnv: Readonly<Record<string, string>>,
  logPath: string,
): Promise<GateResult> {
  await mkdir(dirname(logPath), { recursive: true }).catch(() => undefined);
  const log = createWriteStream(logPath);
  log.on("error", () => {
    // An unwritable log must not fail the gate; the tail still reaches the result.
  });
  const tail = new Tail();
  const started = performance.now();
  const child = spawn("sh", ["-c", gate.run], {
    cwd,
    env: gateEnv(passEnv),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder("utf8");
    stream.on("data", (chunk: Buffer) => {
      log.write(chunk);
      tail.push(decoder.write(chunk));
    });
  }
  const exit = await awaitGate(child, gate.timeoutMs);
  if (exit.spawnError !== undefined) {
    const message = `${provider}: could not start gate: ${exit.spawnError}\n`;
    log.write(message);
    tail.push(message);
  }
  await new Promise<void>((resolve) => log.end(resolve));
  return {
    run: gate.run,
    exitCode: exit.timedOut ? null : exit.code,
    timedOut: exit.timedOut,
    durationMs: Math.round(performance.now() - started),
    tail: tail.value(),
  };
}

/** Gates run as `sh -c` in their own process group with ENV_ALLOWLIST + passEnv; full output to the gate log; the tail
 *  kept in GateResult is the last 60 lines / 8000 chars. A gate that cannot start says so under `provider`'s name. */
export function createShellGates(provider: string): GateRunner {
  return { run: (...args) => runGate(provider, ...args) };
}
