import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { parsePid } from "../../domain/pid.ts";
import { err, ok, type Result } from "../../domain/result.ts";

/**
 * Double fork: a short-lived launcher (`<runtime> -e LAUNCHER`, bun or node, whichever runs this code) spawns the real process detached (own session and process
 * group, the process as its leader) with stdio on fd 3, prints its pid and exits. The process is then reparented to
 * PID 1, so nothing that kills the caller's process tree (Claude Code cleaning up a background shell) reaches it.
 * The launcher is plain JS with no imports beyond node builtins, so it starts in tens of milliseconds and cannot drift
 * from a bundle it never loads.
 */
const LAUNCHER = `
const { spawn } = process.getBuiltinModule("node:child_process");
const [command, ...args] = process.argv.slice(1);
const child = spawn(command, args, { detached: true, stdio: ["ignore", 3, 3] });
child.once("error", () => {});
if (child.pid === undefined) {
  process.stderr.write("cannot start " + command);
  process.exit(1);
}
child.unref();
process.stdout.write(String(child.pid));
`;

/** Bounds a launcher that never answers; a healthy one exits within a few hundred ms even on a loaded machine. */
const LAUNCH_TIMEOUT_MS = 15_000;

/** What spawnSync reports about the launcher. */
interface LaunchReply {
  readonly error?: Error | undefined;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The orphan's pid from the launcher's reply, or why there is none. */
export function launchedPid(command: string, reply: LaunchReply): Result<number, string> {
  if (reply.error !== undefined) return err(`cannot start ${command}: ${reply.error.message}`);
  const stderr = reply.stderr.trim();
  if (reply.status !== 0) return err(stderr === "" ? `cannot start ${command}` : stderr);
  const pid = parsePid(reply.stdout);
  return pid === undefined ? err(`cannot start ${command}: no pid`) : ok(pid);
}

/** Starts `command args` as an orphaned process-group leader with stdout and stderr appended to `log`; returns its
 *  pid. Throws when it cannot be started. */
export function spawnOrphan(command: string, args: readonly string[], log: string): number {
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a", 0o600);
  try {
    const reply = spawnSync(process.execPath, ["-e", LAUNCHER, command, ...args], {
      stdio: ["ignore", "pipe", "pipe", fd],
      encoding: "utf8",
      timeout: LAUNCH_TIMEOUT_MS,
    });
    const pid = launchedPid(command, reply);
    if (!pid.ok) throw new Error(pid.error);
    return pid.value;
  } finally {
    closeSync(fd);
  }
}
