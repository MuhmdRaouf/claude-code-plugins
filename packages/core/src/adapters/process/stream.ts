// A model worker's process: headless Claude Code, omp, pi or opencode. Each runs in its own process group (so a stop
// reaches every tool it started) with piped stdio, its stdout read line by line, the end of its stderr kept for the
// crash report, and a wall clock after which the whole group is terminated.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { WriteStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { err, ok, type Result } from "../../domain/result.ts";
import { signalGroup, terminateGroup } from "./group.ts";
import { createQueue, DEFAULT_MAX_LINE_BYTES, eachLine } from "./lines.ts";

/** Keeps the end of stderr, where crash reasons are. */
const STDERR_TAIL_CHARS = 4_000;
/** Grandchildren can hold stdout and stderr open after the leader exits; past this the pipes are dropped. */
const PIPE_DROP_MS = 500;
/** Between a failed soft stop and SIGTERM, and between SIGTERM and SIGKILL, when the caller gives no grace. */
const DEFAULT_GRACE_MS = 5_000;
/** setTimeout turns larger delays into 1 ms, which would time a run out at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface StreamCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Written whole, then stdin is closed (headless Claude Code reads its prompt this way). Without it stdin stays open
   *  for `write` and `endInput` (the RPC engines). */
  readonly stdin?: string;
  /** Raw stdout is appended here byte for byte; the exit resolves only once it is flushed and closed. */
  readonly logPath?: string;
  /** Wall clock after which the run is interrupted with reason "timeout"; absent when the caller owns the deadline. */
  readonly timeoutMs?: number;
  /** Between the soft stop failing and SIGTERM, and between SIGTERM and SIGKILL. */
  readonly graceMs?: number;
  /** The longest acceptable stdout line (default one MiB, omp's frame limit); past it the process is killed, not
   *  buffered. `Infinity` for a stream with no limit. */
  readonly maxLineBytes?: number;
  /** Startup stderr that is not trouble (omp's "Still starting after Ns"): still reported, never kept in the tail. */
  readonly isBenignStderr?: (line: string) => boolean;
  /** The process's own stop request (omp's RPC abort); raced against exit and the grace window before the group dies. */
  readonly soft?: (reason: "timeout" | "stopped") => Promise<void>;
  /**
   * Once the leader exits on its own, terminate the rest of its group (Claude Code's background shells, opencode's
   * server child). Off by default: omp and pi want their grandchildren left alone. Signalling -pid after the leader is
   * gone is safe here because the group id cannot be reused while a member of the group still lives.
   */
  readonly reapGroupOnExit?: boolean;
}

/** How the process ended. */
export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The last stderr lines, benign startup notices left out. */
  readonly stderrTail: string;
  /** The first interrupt reason, when the run did not end on its own. */
  readonly forced: "timeout" | "stopped" | null;
}

/** Every stderr line goes here; `benign` ones are startup progress, not trouble. */
export type StderrListener = (line: string, benign: boolean) => void;

export interface StreamingProcess {
  readonly pid: number;
  /** stdout split into lines (without the newline), always drained even when never iterated; ends at EOF or when the
   *  pipes are dropped. */
  readonly lines: AsyncIterable<string>;
  /** Resolves once the process has exited, its pipes are closed or dropped, any group termination has settled and the
   *  log is flushed. */
  readonly exit: Promise<ProcessExit>;
  /** Writes one line to stdin; false once stdin is closed. */
  write(line: string): boolean;
  /** Closes stdin: an RPC engine then drains, disposes its session and exits 0. */
  endInput(): void;
  /** Signals the process group; a no-op once the leader has exited. */
  signal(signal: NodeJS.Signals): void;
  /** The soft stop first (when there is one), then the group is terminated; the exit reports `forced: reason` unless an
   *  earlier interrupt already set it. */
  interrupt(reason: "timeout" | "stopped", graceMs?: number): Promise<void>;
}

/** Starts the command in its own process group. Start failures (a missing binary, a bad cwd, a log that cannot be
 *  opened) are a Result, not a throw. */
export async function startStreaming(
  cmd: StreamCommand,
  onStderr?: StderrListener,
): Promise<Result<StreamingProcess, string>> {
  const log = cmd.logPath === undefined ? ok(undefined) : await openLog(cmd.logPath);
  if (!log.ok) return log;
  const child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env, detached: true, stdio: "pipe" });
  // A child that exits without reading its input makes writes fail with EPIPE; its exit tells the real story.
  child.stdin.on("error", () => {});
  const pid = await spawned(child);
  if (!pid.ok) {
    await closeLog(log.value);
    return pid;
  }
  let inputOpen = cmd.stdin === undefined;
  if (cmd.stdin !== undefined) child.stdin.end(cmd.stdin);
  const supervised = supervise(child, pid.value, cmd, log.value, onStderr);
  return ok({
    pid: pid.value,
    lines: splitLines(child, pid.value, cmd.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES, log.value),
    ...supervised,
    write(line) {
      if (!inputOpen || !child.stdin.writable) return false;
      child.stdin.write(`${line}\n`);
      return true;
    },
    endInput() {
      inputOpen = false;
      child.stdin.end();
    },
  });
}

function supervise(
  child: ChildProcessWithoutNullStreams,
  pid: number,
  cmd: StreamCommand,
  log: WriteStream | undefined,
  onStderr: StderrListener | undefined,
): Pick<StreamingProcess, "exit" | "signal" | "interrupt"> {
  const defaultGrace = cmd.graceMs ?? DEFAULT_GRACE_MS;
  // Past 'exit' the kernel has reaped the leader and its pid is free for reuse, so signalling it must stop.
  let reaped = false;
  let forced: ProcessExit["forced"] = null;
  let termination: Promise<void> | undefined;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const terminate = (graceMs = defaultGrace): Promise<void> => {
    termination ??= terminateGroup(pid, graceMs);
    return termination;
  };
  const interrupt = async (reason: "timeout" | "stopped", graceMs = defaultGrace): Promise<void> => {
    forced ??= reason;
    // The soft stop is best effort: whatever it does, the group is terminated once it settles or the grace runs out.
    if (cmd.soft !== undefined)
      await Promise.race([cmd.soft(reason).catch(() => {}), exited, delay(graceMs)]);
    await terminate(graceMs);
  };
  const timer =
    cmd.timeoutMs === undefined
      ? undefined
      : setTimeout(() => void interrupt("timeout"), Math.min(cmd.timeoutMs, MAX_TIMER_MS));
  const tail = superviseStderr(child, cmd.isBenignStderr, onStderr);
  child.once("exit", () => {
    reaped = true;
    // The run did end on its own, so the exit stays unforced even when the rest of the group is terminated here.
    if (cmd.reapGroupOnExit) void terminate();
    // Grandchildren can still hold the pipes open after the leader exits; they are dropped, not chased — the group is
    // only ever terminated on request (interrupt, or the opt-in above), never because the leader happened to exit.
    const drop = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, PIPE_DROP_MS);
    child.once("close", () => clearTimeout(drop));
  });
  const exit = new Promise<ProcessExit>((resolve) => {
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      // A group termination under way (an interrupt, the reap above) settles first: nothing the run started is left.
      if (termination !== undefined) await termination;
      // Readers of a finished run see all of its log.
      await closeLog(log);
      resolve({ code, signal, stderrTail: tail(), forced });
    });
  });
  return {
    exit,
    signal(signal) {
      if (!reaped) signalGroup(pid, signal);
    },
    interrupt,
  };
}

/** Spawn errors (missing binary, bad cwd) arrive as an "error" event instead of "spawn". Once "spawn" fired the pid is
 *  set; the -1 only satisfies the type and is refused by every signalling helper. */
function spawned(child: ChildProcessWithoutNullStreams): Promise<Result<number, string>> {
  return new Promise((resolve) => {
    child.once("spawn", () => resolve(ok(child.pid ?? -1)));
    child.once("error", (error) => resolve(err(error.message)));
  });
}

async function openLog(path: string): Promise<Result<WriteStream, string>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a", 0o600);
    return ok(handle.createWriteStream());
  } catch (error) {
    return err(`cannot open log ${path}: ${String(error)}`);
  }
}

function closeLog(log: WriteStream | undefined): Promise<void> {
  return log === undefined ? Promise.resolve() : new Promise((resolve) => log.end(resolve));
}

function splitLines(
  child: ChildProcessWithoutNullStreams,
  pid: number,
  maxLineBytes: number,
  log: WriteStream | undefined,
): AsyncIterable<string> {
  const queue = createQueue<string>();
  if (log !== undefined) child.stdout.on("data", (chunk: Buffer) => log.write(chunk));
  // A peer that streams past the line budget with no newline is broken; kill it, do not buffer it.
  eachLine(
    child.stdout,
    (line) => queue.push(line),
    queue.close,
    () => signalGroup(pid, "SIGKILL"),
    maxLineBytes,
  );
  return queue.items;
}

/** Keeps the end of stderr as written, benign lines left out; the exit reads the tail once the pipes are closed. */
function superviseStderr(
  child: ChildProcessWithoutNullStreams,
  isBenign: ((line: string) => boolean) | undefined,
  onStderr: StderrListener | undefined,
): () => string {
  let tail = "";
  eachLine(
    child.stderr,
    (line, complete) => {
      const benign = isBenign?.(line) ?? false;
      if (!benign) tail = `${tail}${line}${complete ? "\n" : ""}`.slice(-STDERR_TAIL_CHARS);
      onStderr?.(line, benign);
    },
    () => {},
  );
  return () => tail;
}
