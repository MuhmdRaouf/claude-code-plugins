// `ensure`: the UserPromptSubmit and SubagentStart hooks' check that the router is still there, so one that died
// mid-session is back before the next prompt or subagent. It must cost nothing when all is well: a 100 ms TCP connect,
// and only when that is refused does it start `<name>-router.js start` detached and return at once. It never prints,
// and it never throws (the plugin entry exits 0 whatever happens). Node built-ins only: its bundle stays tiny.
import { existsSync } from "node:fs";
import { startDetached } from "../adapters/process/detached.ts";
import { portAnswers } from "../adapters/process/port.ts";
import { resolveStateRoot, stateRootRule } from "../adapters/state-root.ts";
import { stateLayout } from "../domain/state-layout.ts";

interface EnsureOptions {
  /** The plugin's short name and env prefix, e.g. zai / ZAI. */
  readonly name: string;
  readonly envPrefix: string;
  readonly defaultPort: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The router bundle beside this one, run as `start`. */
  readonly routerScript: string;
  readonly node?: string;
  readonly connectMs?: number;
  /** Starts the router; tests record the call instead. */
  readonly start?: (
    node: string,
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
  ) => void;
}

/** "up" when the router answers, "skipped" when this plugin was never set up, "started" when a start went out. */
export async function ensureRouter(options: EnsureOptions): Promise<"up" | "skipped" | "started"> {
  const { env } = options;
  const root = resolveStateRoot(env, stateRootRule(options));
  if (!existsSync(stateLayout(root).setupDone) && !existsSync(stateLayout(root).routerPid)) return "skipped";
  const port = Number(env[`${options.envPrefix}_ROUTER_PORT`]) || options.defaultPort;
  if (await portAnswers(port, options.connectMs ?? 100)) return "up";
  const start =
    options.start ?? ((node, args, startEnv) => void startDetached(node, args, { env: startEnv }));
  start(options.node ?? process.execPath, [options.routerScript, "start"], env);
  return "started";
}
