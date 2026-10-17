#!/usr/bin/env node
/**
 * Executable stand-in for `claude -p --output-format stream-json` in adapter and end-to-end tests (Node 24 runs it with
 * type stripping). It reads the prompt from stdin, then plays a scenario, emitting events shaped like the live stream
 * (see test/fixtures/stream/).
 *
 * Environment (reaches it through the worker's passEnv, like any brief `env` name):
 * - FAKE_CLAUDE_SCENARIO  ok (default) | sleep | crash | echo-prompt | edit-file | no-session (Claude Code's answer
 *                         to a --resume it has no session for)
 * - FAKE_CLAUDE_FIXTURE   NDJSON file replayed verbatim instead of a scenario
 * - FAKE_CLAUDE_EDIT      `path:content` written relative to the cwd by edit-file
 * - FAKE_CLAUDE_EDIT_ON_RESUME  used instead of FAKE_CLAUDE_EDIT when the run resumes a session (--resume), so a first
 *                         run can fail a gate and the fix attempt pass it
 * `--version` prints a version line and exits, like the real binary.
 * - FAKE_CLAUDE_REPORT    JSON for the result's structured_output (default {"summary":"fake run"})
 * - FAKE_CLAUDE_DUMP      file receiving {argv, envNames, authTokenSha256}: env NAMES only, the token only hashed
 * - FAKE_CLAUDE_PIDFILE   start a grandchild in the same process group that holds stdout open and outlives this
 *                         process; "<own pid> <grandchild pid>" is written here once it runs
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { text } from "node:stream/consumers";

const argv = process.argv.slice(2);
const env = process.env;

function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const sessionId = flag("--session-id") ?? flag("--resume") ?? "fake-session";
const alias = flag("--model") ?? "sonnet";
const model = env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`] ?? alias;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ...event, session_id: sessionId })}\n`);
}

function init(): void {
  emit({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    model,
    permissionMode: flag("--permission-mode") ?? "default",
    apiKeySource: "ANTHROPIC_AUTH_TOKEN",
  });
}

function say(message: string): void {
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: message }] } });
}

function result(message: string): void {
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: message,
    structured_output: JSON.parse(env.FAKE_CLAUDE_REPORT ?? '{"summary":"fake run"}'),
    num_turns: 1,
    duration_ms: 12,
    total_cost_usd: 0.0012,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
    },
  });
}

function dump(path: string): void {
  const token = env.ANTHROPIC_AUTH_TOKEN;
  const authTokenSha256 = token === undefined ? null : createHash("sha256").update(token).digest("hex");
  writeFileSync(path, JSON.stringify({ argv, envNames: Object.keys(env).sort(), authTokenSha256 }));
}

function startGrandchild(pidFile: string): void {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  grandchild.unref();
  writeFileSync(pidFile, `${process.pid} ${grandchild.pid}`);
}

function editFile(spec: string): string {
  const colon = spec.indexOf(":");
  const path = spec.slice(0, colon);
  const target = resolve(process.cwd(), path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, spec.slice(colon + 1));
  return path;
}

function editSpec(): string {
  const resumed = flag("--resume") !== undefined ? env.FAKE_CLAUDE_EDIT_ON_RESUME : undefined;
  return resumed ?? env.FAKE_CLAUDE_EDIT ?? "";
}

function play(scenario: string, prompt: string): void {
  if (env.FAKE_CLAUDE_FIXTURE !== undefined) {
    process.stdout.write(readFileSync(env.FAKE_CLAUDE_FIXTURE));
    return;
  }
  if (scenario === "no-session") {
    process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
    process.exitCode = 1;
    return;
  }
  init();
  switch (scenario) {
    case "ok":
      say("done");
      result("done");
      return;
    case "echo-prompt":
      say(prompt);
      result("echoed");
      return;
    case "edit-file":
      say(`edited ${editFile(editSpec())}`);
      result("edited");
      return;
    case "sleep":
      setInterval(() => {}, 1000);
      return;
    case "crash":
      process.stderr.write("fake claude: simulated crash\n");
      process.exitCode = 3;
      return;
    default:
      process.stderr.write(`fake claude: unknown scenario ${scenario}\n`);
      process.exitCode = 2;
  }
}

if (argv.includes("--version")) {
  process.stdout.write("2.1.289 (Claude Code, fake)\n");
  process.exit(0);
}
const prompt = await text(process.stdin);
if (env.FAKE_CLAUDE_DUMP !== undefined) dump(env.FAKE_CLAUDE_DUMP);
if (env.FAKE_CLAUDE_PIDFILE !== undefined) startGrandchild(env.FAKE_CLAUDE_PIDFILE);
play(env.FAKE_CLAUDE_SCENARIO ?? "ok", prompt);
