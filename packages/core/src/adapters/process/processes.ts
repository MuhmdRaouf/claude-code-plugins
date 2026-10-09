// The machine's process list, for the retired router's exit check: `ps -axo pid=,lstart=,args=` on macOS and Linux,
// under LC_ALL=C so the start times parse. Undefined when it cannot be read (Windows, no `ps`, a failure).
import { type ProcessStart, parseProcessList } from "../../domain/retirement.ts";
import { runTool, succeeded, type ToolResult } from "./tool.ts";

type Run = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<ToolResult>;

export async function processList(
  platform: NodeJS.Platform = process.platform,
  run: Run = runTool,
): Promise<ProcessStart[] | undefined> {
  if (platform === "win32") return undefined;
  const ps = await run("ps", ["-axo", "pid=,lstart=,args="], {
    env: { ...process.env, LC_ALL: "C" },
    timeoutMs: 10_000,
  });
  return succeeded(ps) ? parseProcessList(ps.stdout.toString("utf8")) : undefined;
}
