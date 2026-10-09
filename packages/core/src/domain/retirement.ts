// When a retired router exits. A router retires when its plugin is removed (setup --remove, an uninstall or a disable):
// Claude Code sessions read ANTHROPIC_BASE_URL once at start, so every session already open keeps sending to the
// router until it exits. The router therefore stays up, as a passthrough, while any `claude` process that started
// before the retirement still runs, and never longer than 7 days. Pure: the process list comes in as data.

/** The longest a retired router stays up, whatever runs: 7 days. */
export const RETIRED_MAX_MS = 7 * 24 * 60 * 60_000;

/** How often a retired router looks at the process list: 30 s. */
export const RETIRED_CHECK_MS = 30_000;

/** One running process: its pid, its start time (epoch ms, to the second) and its command line. */
export interface ProcessStart {
  readonly pid: number;
  readonly startedAt: number;
  readonly command: string;
}

export interface RetiredExitInput {
  readonly retiredAt: number;
  readonly now: number;
  /** The running processes, or undefined when the list could not be read (then only the cap ends the wait). */
  readonly processes: readonly ProcessStart[] | undefined;
  readonly maxMs?: number;
}

/** Whether a command line is a Claude Code session: its program is named `claude` (the native install, or the npm
 *  bin), or it runs the npm package's entry point under node or bun. The command line, not the process name: Linux
 *  names a Node process's main thread `MainThread`. The desktop app's `Claude` never matches. */
export function isClaudeCode(commandLine: string): boolean {
  const [program = "", ...args] = commandLine.trim().split(/\s+/);
  if ((program.split("/").pop() ?? program) === "claude") return true;
  return args.some((arg) => /\/@anthropic-ai\/claude-code\/cli\.m?js$/.test(arg));
}

/** True when a `claude` executable started at or before the retirement still runs. `ps` reports start times to the
 *  second, so a session started in the same second as the retirement counts as older: the router waits for it. */
export function claudeFromBefore(processes: readonly ProcessStart[], retiredAt: number): boolean {
  const retiredSecond = Math.floor(retiredAt / 1000) * 1000;
  return processes.some((process) => isClaudeCode(process.command) && process.startedAt <= retiredSecond);
}

/** "exit" once the cap has passed, or once no `claude` process from before the retirement is left. */
export function retiredExit(input: RetiredExitInput): "stay" | "exit" {
  if (input.now - input.retiredAt >= (input.maxMs ?? RETIRED_MAX_MS)) return "exit";
  if (input.processes === undefined) return "stay";
  return claudeFromBefore(input.processes, input.retiredAt) ? "stay" : "exit";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `<pid> <weekday> <month> <day> <hh>:<mm>:<ss> <year> <command>`, as `ps -axo pid=,lstart=,args=` prints it under
 *  LC_ALL=C on macOS and Linux. */
const PS_LINE =
  /^\s*(\d+)\s+[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+?)\s*$/;

/** The processes in `ps -axo pid=,lstart=,args=` output, start times read as local time; other lines are skipped. */
export function parseProcessList(stdout: string): ProcessStart[] {
  return stdout.split("\n").flatMap((line) => {
    const match = PS_LINE.exec(line);
    if (match === null) return [];
    const [, pid, month, day, hours, minutes, seconds, year, command] = match;
    const monthIndex = MONTHS.indexOf(month ?? "");
    if (monthIndex < 0 || command === undefined) return [];
    const startedAt = new Date(
      Number(year),
      monthIndex,
      Number(day),
      Number(hours),
      Number(minutes),
      Number(seconds),
    ).getTime();
    return [{ pid: Number(pid), startedAt, command }];
  });
}
