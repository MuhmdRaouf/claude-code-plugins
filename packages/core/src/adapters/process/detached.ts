// Node built-ins only: the ensure hook's bundle imports this and must stay tiny.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

/** A process started to outlive its caller, as the caller sees it. */
export interface Detached {
  readonly pid: number | undefined;
  exited(): boolean;
  kill(): void;
}

export interface DetachedOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** stdout and stderr are appended here (0600); without it, or when it cannot be opened, they are discarded. */
  readonly logFile?: string;
  /** Pass the arguments to Windows as they are (`cmd /c start "" <url>` must not have its quotes escaped). */
  readonly verbatim?: boolean;
}

/** `command args` in its own process group, no console window, not waited for: a start failure (a missing binary) is
 *  swallowed, and the caller learns about it only from what the process was meant to do. */
export function startDetached(
  command: string,
  args: readonly string[],
  options: DetachedOptions = {},
): Detached {
  let out: number | "ignore" = "ignore";
  if (options.logFile !== undefined) {
    try {
      out = openSync(options.logFile, "a", 0o600);
    } catch {
      out = "ignore";
    }
  }
  const child = spawn(command, [...args], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  // The child holds its own copy of the log descriptor.
  if (typeof out === "number") closeSync(out);
  child.on("error", () => undefined);
  child.unref();
  return {
    pid: child.pid,
    exited: () => child.exitCode !== null || child.signalCode !== null,
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    },
  };
}
