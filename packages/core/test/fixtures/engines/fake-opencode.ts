#!/usr/bin/env node
/**
 * Executable stand-in for `opencode run --format json` (Node 24 runs it with type stripping). One process per run,
 * no stdin: it writes the JSONL lines of a fixture file to stdout verbatim — malformed lines included — then exits the
 * way the real run did. Event shapes are the ones recorded from opencode 1.18.34 (test/fixtures/engines/opencode/).
 *
 * Environment:
 * - FAKE_OPENCODE_FIXTURE   a .jsonl file whose lines are written to stdout, verbatim (required)
 * - FAKE_OPENCODE_EXIT      the exit code once every line is out (default 0)
 * - FAKE_OPENCODE_HANG      "1": after the last line the process stays up in silence (the dead-endpoint hang)
 * - FAKE_OPENCODE_LINE_MS   a delay before every line, so a run can be interrupted mid-stream
 * - FAKE_OPENCODE_STDERR    a line written to stderr before the first stdout line
 * - FAKE_OPENCODE_CHILD_PIDFILE  starts a child in opencode's process group that outlives this process (the leftover
 *                               server child, holding no pipes); its pid is written here
 * - FAKE_OPENCODE_RESUME_MISSING "1": with --session, opencode's "Error: Session not found" on stderr and exit 1,
 *                               with no stdout at all
 * - FAKE_OPENCODE_ARGV_LOG  a file the command line is written to as a one-line JSON array
 * - FAKE_OPENCODE_ENV_LOG   a file the whole environment (FAKE_* names left out) is written to as one JSON object
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const argv = process.argv.slice(2);
const env = process.env;

const VALUE_FLAGS = new Set(["--format", "-m", "--model", "--variant", "--session", "--agent"]);
const BOOLEAN_FLAGS = new Set(["--auto", "--print-logs", "-c", "--continue"]);

/** `run`'s flags, and its free arguments: the subcommand first, then the prompt. */
function parseArgs(): { flags: Map<string, string>; positionals: string[] } {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (BOOLEAN_FLAGS.has(arg)) flags.set(arg, "");
    else if (VALUE_FLAGS.has(arg) && argv[i + 1] !== undefined) {
      flags.set(arg, argv[i + 1] ?? "");
      i += 1;
    } else if (arg.startsWith("-") && arg !== "-") {
      process.stderr.write(`Error: Unknown option: ${arg}\n`);
      process.exit(2);
    } else positionals.push(arg);
  }
  return { flags, positionals };
}

function exitAfterFlush(code: number): void {
  process.stdout.write("", () => process.exit(code));
}

/** opencode's server child: in the run's process group, holding no pipes, still there after the run has exited. */
function startChild(pidFile: string): void {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
}

const { flags, positionals } = parseArgs();
if (positionals[0] !== "run") {
  process.stderr.write("fake opencode: only `run` is supported\n");
  process.exit(2);
}
if (env.FAKE_OPENCODE_FIXTURE === undefined) {
  process.stderr.write("fake opencode: FAKE_OPENCODE_FIXTURE is not set\n");
  process.exit(2);
}
if (env.FAKE_OPENCODE_ARGV_LOG !== undefined) {
  writeFileSync(env.FAKE_OPENCODE_ARGV_LOG, `${JSON.stringify(argv)}\n`);
}
if (env.FAKE_OPENCODE_ENV_LOG !== undefined) {
  writeFileSync(
    env.FAKE_OPENCODE_ENV_LOG,
    `${JSON.stringify(Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("FAKE_"))))}
`,
  );
}
if (env.FAKE_OPENCODE_RESUME_MISSING === "1" && flags.get("--session") !== undefined) {
  // What the real run prints (ANSI red included), with no stdout at all.
  process.stderr.write("\u001b[91m\u001b[1mError: \u001b[0mSession not found\n");
  process.exit(1);
}
if (env.FAKE_OPENCODE_CHILD_PIDFILE !== undefined) startChild(env.FAKE_OPENCODE_CHILD_PIDFILE);
if (env.FAKE_OPENCODE_STDERR !== undefined) process.stderr.write(`${env.FAKE_OPENCODE_STDERR}\n`);
const lineMs = Number(env.FAKE_OPENCODE_LINE_MS ?? 0);
for (const line of readFileSync(env.FAKE_OPENCODE_FIXTURE, "utf8")
  .split("\n")
  .filter((line) => line !== "")) {
  await delay(lineMs);
  process.stdout.write(`${line}\n`);
}
if (env.FAKE_OPENCODE_HANG === "1") {
  // A pending promise alone does not keep Node alive; the interval does, and only a signal ends it.
  await new Promise<void>(() => setInterval(() => {}, 60_000));
}
exitAfterFlush(Number(env.FAKE_OPENCODE_EXIT ?? 0));
