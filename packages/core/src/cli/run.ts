import { cleanupWorkspace } from "../app/cleanup.ts";
import type { Deps } from "../app/deps.ts";
import type { Provider } from "../domain/provider.ts";
import { parse } from "./args.ts";
import { type Command, failWith, type Invocation, usageLines } from "./command.ts";
import { authServeCommand } from "./commands/auth-serve.ts";
import { batchCommand } from "./commands/batch.ts";
import { briefCommand } from "./commands/brief.ts";
import { acceptCommand, discardCommand, returnCommand, stopCommand } from "./commands/decide.ts";
import { boardCommand, reviewCommand, showCommand, usageCommand } from "./commands/queries.ts";
import { driveCommand, runCommand } from "./commands/run.ts";
import { setupCommand } from "./commands/setup.ts";
import { waitCommand } from "./commands/wait.ts";
import { EXIT, type ExitCode } from "./exit.ts";

const COMMANDS: readonly Command[] = [
  runCommand,
  waitCommand,
  batchCommand,
  boardCommand,
  showCommand,
  reviewCommand,
  acceptCommand,
  returnCommand,
  discardCommand,
  stopCommand,
  usageCommand,
  setupCommand,
  briefCommand,
  driveCommand,
  authServeCommand,
];

const COMMON = { json: { type: "boolean" }, help: { type: "boolean" } } as const;

/**
 * Commands (all accept --json for machine output):
 *   run <brief.md|-> [--flash] [--mode edit|exec|readonly] [--engine claude|omp|opencode|pi] [--wait|--bg]   submit, detached driver (--wait follows it)
 *   wait <id> [<id>…]                                                      follow jobs to review (Ctrl-C only detaches)
 *   batch <dir|glob|manifest.txt> [--wait]                                 submit many, detached drivers (--wait follows them)
 *   drive <id>                                                             internal: detached driver entry
 *   board [--all] [--hook] [--watch]                                       what runs on the provider now: sessions, subagents, jobs
 *   show <id> [--follow]   review <id> [--diff|--summary]
 *   accept <id> [--no-commit] [--force] [--no-verify]   return <id> <feedback…>   discard <id> [--reason <text>]
 *   stop <id|--all>   usage [--hook]   setup [--hook]   setup [--remove]   brief new <title> [--mode]
 *   setup [--engine-check <omp|opencode|pi>]   setup [--engine-enable <omp|opencode|pi>] [--watcher provider|sonnet]
 *   setup [--engines]                                                      read-only: setup done?, each tool's binary, provider, watcher
 *   brief lint <path>
 * Exit codes per EXIT; usage errors print the command's synopsis.
 */
export async function runCli(argv: readonly string[], deps: Deps, cwd: string): Promise<ExitCode> {
  const [name, ...rest] = argv;
  if (!isAgentHook(name, rest)) await cleanupWorkspace(deps);
  if (isHelp(name)) {
    for (const line of synopsis(deps.provider)) deps.out.line(line);
    return EXIT.ok;
  }
  const cli = deps.provider.name;
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (command === undefined) {
    deps.out.error(name === undefined ? `${cli}: which command?` : `${cli}: unknown command "${name}"`);
    for (const line of synopsis(deps.provider)) deps.out.error(line);
    return EXIT.usage;
  }
  try {
    return await invoke(command, rest, deps, cwd);
  } catch (error) {
    deps.out.error(`${cli}: unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.unexpected;
  }
}

function isHelp(name: string | undefined): boolean {
  return name === "--help" || name === "-h" || name === "help";
}

/** The SubagentStop hook has under a second: cleanup waits for the next real command. */
function isAgentHook(name: string | undefined, rest: readonly string[]): boolean {
  return name === "usage" && rest.includes("--hook");
}

/** The help: every public command's synopsis, under a header saying how they are reached (there is no `<provider>`
 *  command on PATH; the plugin's slash commands run them). */
function synopsis(provider: Provider): readonly string[] {
  const lines = COMMANDS.filter((command) => command.hidden !== true).flatMap((command) =>
    command.synopsis.map((line) => `  ${line}`),
  );
  return [
    `usage: <command> [--json]   (the ${provider.slash} slash commands run these; there is no ${provider.name} command on PATH)`,
    ...lines,
  ];
}

async function invoke(command: Command, argv: readonly string[], deps: Deps, cwd: string): Promise<ExitCode> {
  const usage = (message: string): ExitCode => {
    deps.out.error(`${deps.provider.name}: ${message}`);
    for (const line of usageLines(deps.provider, command)) deps.out.error(line);
    return EXIT.usage;
  };
  const parsed = parse(argv, { ...command.options, ...COMMON });
  if (!parsed.ok) return usage(parsed.error);
  const { values, positionals } = parsed.value;
  if (values.help === true) {
    for (const line of usageLines(deps.provider, command)) deps.out.line(line);
    return EXIT.ok;
  }
  const call: Invocation = {
    deps,
    cwd,
    positionals,
    flag: (flag) => values[flag] === true,
    text: (option) => {
      const value = values[option];
      return typeof value === "string" ? value : undefined;
    },
    usage,
    fail: (error) => failWith(deps, error),
    json: (value) => deps.out.line(JSON.stringify(value, null, 2)),
  };
  return command.run(call);
}
