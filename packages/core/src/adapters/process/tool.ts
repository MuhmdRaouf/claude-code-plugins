// A tool run to completion: git, the OS secret store's command, `<engine> --version`, `ps`. No shell, stdin always
// closed (written first when given), output collected, a timeout, and nothing thrown: a tool that cannot start is a
// value like any other outcome.
import { spawn, spawnSync } from "node:child_process";
import { err, ok, type Result } from "../../domain/result.ts";

export interface ToolOptions {
  readonly cwd?: string;
  /** The tool's whole environment; the caller's own when absent. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Written to stdin before it is closed; stdin is closed either way, so the tool never waits on it. */
  readonly stdin?: string | Buffer;
  /** SIGTERM after this long; the result then has `signal` set. */
  readonly timeoutMs?: number;
  /** Past this many bytes of stdout or stderr the tool is killed (default 512 MiB). */
  readonly maxBuffer?: number;
}

export type ToolResult =
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: Buffer;
      readonly stderr: Buffer;
    }
  /** The tool did not start (not on PATH, not executable, a bad cwd). */
  | { readonly kind: "missing"; readonly message: string };

const MAX_BUFFER = 512 * 1024 * 1024;

export function runTool(
  command: string,
  args: readonly string[],
  options: ToolOptions = {},
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      ...spawnOptions(options),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const limit = options.maxBuffer ?? MAX_BUFFER;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > limit) child.kill("SIGKILL");
      else into.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish({ kind: "missing", message: error.message }));
    child.once("close", (code, signal) =>
      finish({ kind: "exited", code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }),
    );
    // A tool that exits before reading stdin closes the pipe under us: EPIPE is that tool's answer, not ours.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
  });
}

/** runTool for the few callers that cannot wait on the event loop (the router starter's service commands, `ps`). */
export function runToolSync(command: string, args: readonly string[], options: ToolOptions = {}): ToolResult {
  const reply = spawnSync(command, [...args], {
    ...spawnOptions(options),
    input: options.stdin ?? "",
    maxBuffer: options.maxBuffer ?? MAX_BUFFER,
  });
  if (reply.error !== undefined && reply.pid === 0) return { kind: "missing", message: reply.error.message };
  return {
    kind: "exited",
    code: reply.status,
    signal: reply.signal,
    stdout: reply.stdout ?? Buffer.alloc(0),
    stderr: reply.stderr ?? Buffer.alloc(0),
  };
}

/** True when the tool ran and exited 0. */
export function succeeded(result: ToolResult): result is Extract<ToolResult, { kind: "exited" }> {
  return result.kind === "exited" && result.code === 0;
}

function spawnOptions(options: ToolOptions) {
  return {
    windowsHide: true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  };
}

/** Bounds a `--version` that hangs (a tool waiting on a first-run prompt). */
const VERSION_TIMEOUT_MS = 10_000;

/** The first line `<bin> --version` prints, or why there is none. */
export async function toolVersion(bin: string): Promise<Result<string, string>> {
  const run = await runTool(bin, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
  if (run.kind === "missing") return err(run.message);
  if (run.code !== 0) return err(`Command failed: ${bin} --version`);
  const first = run.stdout.toString("utf8").trim().split("\n")[0] ?? "";
  return first === "" ? err("printed no version") : ok(first);
}
