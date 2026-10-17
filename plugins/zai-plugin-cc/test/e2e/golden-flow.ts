/**
 * The golden transcript: one scripted session through the plugin-core binary (`<binary> zai cli <args…>`, one
 * subprocess per command, the Go fake claude as worker), rendered as plain text. Every user-visible string the plugin
 * prints goes through it: CLI messages and errors, the renderers, the brief template, the prompt the worker receives
 * (its contract footer), the env names the worker sees, branch and trailer names.
 *
 * What would vary between runs is pinned, not masked: a fixed clock, sequential job and session ids, fixed git dates,
 * gate durations zeroed. The pins move into the environment the binary reads (PLUGIN_CORE_*); the drivers are the
 * binary's own detached children framing their driver.log. Only the sandbox and plugin paths are replaced by
 * <sandbox> and <plugin>.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Job, JobState } from "@muhmdraouf/plugin-test/testing";
import {
  ISOLATED_GIT_ENV,
  makeRepo,
  type TestRepo,
  tempDir,
  writeAgents,
} from "@muhmdraouf/plugin-test/testing";
import { expect, onTestFinished, vi } from "vite-plus/test";
import { ZAI_PROVIDER } from "../provider.ts";
import { e2eCli, e2eFakeClaude, killDrivers } from "./harness.ts";

const PLUGIN = join(import.meta.dirname, "../..");
const NOW = Date.parse("2026-10-06T12:00:00.000Z");

const CHECK = `node -e "process.exit(require('fs').readFileSync('src/value.txt','utf8').trim() === 'right' ? 0 : 1)"`;
const REPORT = {
  summary: "Set the value to right",
  files: [{ path: "src/value.txt", why: "the check expects right" }],
  tests_added: [],
  open_items: ["the README still says wrong"],
};
const GIT_DATES = {
  GIT_AUTHOR_DATE: "2026-10-06T12:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-06T12:00:00Z",
};

/** One scripted session. */
interface Session {
  readonly repo: TestRepo;
  readonly sandbox: string;
  readonly stateRoot: string;
  readonly env: Record<string, string>;
  readonly transcript: string[];
  /** The provider the session's CLI names in its `$ <name> <args>` lines. */
  readonly providerName: string;
  /** Runs one CLI command and appends `$ zai <args>`, its output and its exit code; returns the output lines. */
  zai(...argv: string[]): Promise<readonly string[]>;
  /** Waits for the drivers started so far and appends what each printed, in the order they were started. */
  settle(): Promise<void>;
  /** Waits until the job's state file reaches state. */
  waitForState(id: string, state: JobState): Promise<void>;
}

/** The sandbox copy of the plugin the session runs against, never the shipped files: a dist stub plus the agents. */
function pluginCopy(bundlePath: string): void {
  mkdirSync(dirname(bundlePath), { recursive: true });
  writeFileSync(bundlePath, "// the sandbox copy's bundle stub: only its path and neighbours matter here\n");
}

function baseEnv(sandbox: string, stateRoot: string, workerBin: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: sandbox,
    TMPDIR: sandbox,
    ...ISOLATED_GIT_ENV,
    ZAI_STATE_DIR: stateRoot,
    ZAI_CLAUDE_BIN: workerBin,
    ZAI_API_KEY: "zai-golden-fake-key",
    FAKE_CLAUDE_REPORT: JSON.stringify(REPORT),
    FAKE_CLAUDE_DUMP: join(sandbox, "worker-env.json"),
  };
}

/** Appends `$ <provider> <args>`, its output lines and its exit code to the transcript. */
function frame(session: Session, argv: readonly string[], out: readonly string[], code: number): void {
  session.transcript.push(`$ ${session.providerName} ${argv.join(" ")}`, ...out, `[exit ${code}]`, "");
}

function note(session: Session, title: string, body: string): void {
  session.transcript.push(`# ${title}`, ...body.trimEnd().split("\n"), "");
}

function brief(session: Session, name: string, front: readonly string[], body: string): string {
  const path = join(session.sandbox, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\n${front.join("\n")}\n---\n${body}\n`);
  return path;
}

function scenario(session: Session, values: Readonly<Record<string, string>>): void {
  Object.assign(session.env, values);
}

/** The text the echo-prompt scenario said: the whole prompt the worker received. */
function promptOf(session: Session, id: string, attempt: number): string {
  const log = readFileSync(join(session.stateRoot, "jobs", id, `attempt-${attempt}.jsonl`), "utf8");
  for (const line of log.split("\n")) {
    const event = line === "" ? undefined : JSON.parse(line);
    if (event?.type === "assistant") return event.message.content[0].text;
  }
  return "(no prompt)";
}

/** The session: one subprocess per command, pins in the environment, real detached drivers. */
function openSession(): Session {
  // The fixture's commits and the notes' git calls run in this process; the CLI children read the
  // same dates from their environment.
  for (const [name, value] of Object.entries(GIT_DATES)) vi.stubEnv(name, value);
  const repo = makeRepo();
  repo.write(
    "package.json",
    `${JSON.stringify({ name: "golden", private: true, scripts: { check: CHECK } }, null, 2)}\n`,
  );
  repo.write("src/value.txt", "wrong\n");
  repo.commitAll("golden fixture");
  const sandbox = tempDir("zai-golden-go-");
  const stateRoot = join(sandbox, "state");
  // Setup's wiring reads and rewrites the agents beside the bundle, so the session runs a sandbox copy of the plugin
  // (dist plus agents) and never the shipped files; the router start and its key check are pinned below, the router
  // process is not the transcript's subject.
  const bundlePath = join(sandbox, "plugin", "dist", "zai.js");
  pluginCopy(bundlePath);
  writeAgents(bundlePath, ZAI_PROVIDER);
  const env: Record<string, string> = {
    ...baseEnv(sandbox, stateRoot, e2eFakeClaude()),
    ...GIT_DATES,
    CLAUDE_PLUGIN_ROOT: join(sandbox, "plugin"),
    // The pins the binary reads: the fixed clock zeroes the gate durations, the sequential ids keep the job and
    // session numbers stable, the runtime and router lines name what the machine would, and the driver children
    // frame their own driver.log.
    PLUGIN_CORE_NOW_MS: String(NOW),
    PLUGIN_CORE_SEQUENTIAL_IDS: "1",
    PLUGIN_CORE_RUNTIME: "bun 1.3.14 (/usr/local/bin/bun)",
    PLUGIN_CORE_ROUTER_LINE: "running on http://127.0.0.1:18787 (already running)",
    PLUGIN_CORE_ROUTER_KEY: "ZAI_API_KEY",
    PLUGIN_CORE_FRAMED_DRIVERS: "1",
  };
  /** Jobs whose drivers were started and not yet settled. */
  const started: string[] = [];
  /** Driver blocks already taken per job: a returned-to job's driver appends to the same log. */
  const settledRuns = new Map<string, number>();
  const session: Session = {
    repo,
    sandbox,
    stateRoot,
    env,
    transcript: [],
    providerName: ZAI_PROVIDER.name,
    async zai(...argv) {
      const run = await runGoCli(e2eCli(), argv, env, repo.dir);
      frame(session, argv, run.lines, run.code);
      started.push(...startedJobs(run.lines, argv));
      return run.lines;
    },
    async settle() {
      for (const id of started.splice(0)) {
        const before = settledRuns.get(id) ?? 0;
        const segment = await driverSegment(stateRoot, id, before);
        settledRuns.set(id, before + 1);
        session.transcript.push(`# driver ${id}`, ...segment, "");
      }
    },
    async waitForState(id, state) {
      await expect.poll(() => readJob(stateRoot, id)?.state, { timeout: 60_000, interval: 50 }).toBe(state);
    },
  };
  // A failed assertion must not leave a detached driver behind: it is this test's own process.
  onTestFinished(() => killDrivers(stateRoot));
  return session;
}

/** The jobs one command started a driver for: their started/returned/submitted lines, or the job a `run --bg --json`
 *  answered with (no started line to read the id from). */
function startedJobs(lines: readonly string[], argv: readonly string[]): readonly string[] {
  const started: string[] = [];
  for (const line of lines) {
    const text = line.startsWith("stderr| ") ? line.slice("stderr| ".length) : line;
    const id = /^zai job (\S+) (?:started|returned)|^submitted (\S+):/.exec(text);
    const job = id?.[1] ?? id?.[2];
    if (job !== undefined) started.push(job);
  }
  if (argv[0] === "run" && argv.includes("--json")) {
    const job = JSON.parse(lines.join("\n")) as { readonly id?: string };
    if (typeof job.id === "string") started.push(job.id);
  }
  return started;
}

interface GoRun {
  readonly code: number;
  readonly lines: readonly string[];
}

/** One plugin-core command, its stdout and stderr merged in arrival order (stderr lines marked). */
function runGoCli(
  bin: string,
  argv: readonly string[],
  env: Record<string, string>,
  cwd: string,
): Promise<GoRun> {
  const child = spawn(bin, ["zai", "cli", ...argv], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  const tails: (() => void)[] = [];
  const read = (stream: NodeJS.ReadableStream | null, mark: boolean): void => {
    let partial = "";
    stream?.setEncoding("utf8").on("data", (chunk: string) => {
      partial += chunk;
      const complete = partial.split("\n");
      partial = complete.pop() ?? "";
      for (const line of complete) lines.push(mark ? `stderr| ${line}` : line);
    });
    tails.push(() => {
      if (partial !== "") lines.push(mark ? `stderr| ${partial}` : partial);
    });
  };
  read(child.stdout, false);
  read(child.stderr, true);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      for (const tail of tails) tail();
      resolve({ code: code ?? -1, lines });
    });
  });
}

/** One framed run of driver.log: the lines after the `before`-th exit line, ending at the next one. A driver a
 * `return` spawned appends to the same log, so each block is the segment between two exit lines. */
async function driverSegment(stateRoot: string, id: string, before: number): Promise<readonly string[]> {
  let segment: readonly string[] = [];
  await expect
    .poll(
      () => {
        try {
          const lines = readFileSync(join(stateRoot, "jobs", id, "driver.log"), "utf8").split("\n");
          const ends = lines.flatMap((line, at) => (/^\[exit \d+\]$/.test(line) ? [at] : []));
          if (ends.length <= before) return 0;
          const from = before === 0 ? 0 : (ends[before - 1] ?? -1) + 1;
          segment = lines.slice(from, (ends[before] ?? -2) + 1);
          return ends.length;
        } catch {
          return 0;
        }
      },
      { timeout: 60_000, interval: 50 },
    )
    .toBeGreaterThan(before);
  return segment;
}

function readJob(stateRoot: string, id: string): Job | undefined {
  try {
    return JSON.parse(readFileSync(join(stateRoot, "jobs", id, "job.json"), "utf8")) as Job;
  } catch {
    return undefined;
  }
}

function normalized(session: Session): string {
  // The Go fake lives outside the plugin; the transcript names the worker the way a TS fake beside the plugin would.
  return `${session.transcript.join("\n")}\n`
    .replaceAll(e2eFakeClaude(), "<plugin>/test/support/fake-claude.ts")
    .replaceAll(session.sandbox, "<sandbox>")
    .replaceAll(session.repo.dir, "<repo>")
    .replaceAll(PLUGIN, "<plugin>");
}

/** The scripted session; returns its normalized transcript. */
export async function goldenTranscript(): Promise<string> {
  const session = openSession();
  try {
    await script(session);
    await session.settle();
  } finally {
    vi.unstubAllEnvs();
  }
  return normalized(session);
}

async function script(s: Session): Promise<void> {
  await s.zai("--help");
  await s.zai();
  await s.zai("frobnicate");
  await s.zai("setup");
  await s.zai("setup", "--ping");
  await s.zai("setup", "--json");
  await s.zai("board");
  await s.zai("board", "--hook");
  await s.zai("usage");
  await s.zai("show", "nope");
  await s.zai("accept");
  await s.zai("stop", "--all");
  await s.zai("batch", "missing-dir");

  // brief templates, one per mode
  for (const mode of ["edit", "exec", "readonly"]) {
    const [path = ""] = await s.zai("brief", "new", `Golden ${mode}`, "--mode", mode);
    note(s, `template ${mode}`, readFileSync(path, "utf8"));
    await s.zai("brief", "lint", path);
  }

  // 1. edit: the first attempt fails its gate, the auto-fix resumes the session and passes; accept lands it.
  scenario(s, {
    FAKE_CLAUDE_SCENARIO: "edit-file",
    FAKE_CLAUDE_EDIT: "src/value.txt:nope\n",
    FAKE_CLAUDE_EDIT_ON_RESUME: "src/value.txt:right\n",
  });
  const edit = brief(
    s,
    "edit.md",
    [
      "title: Fix the value",
      'scope: ["src/**"]',
      'forbid: ["src/secret/**"]',
      "gates: [npm run --silent check]",
      "env: [FAKE_CLAUDE_SCENARIO, FAKE_CLAUDE_EDIT, FAKE_CLAUDE_EDIT_ON_RESUME, FAKE_CLAUDE_REPORT, FAKE_CLAUDE_DUMP]",
    ],
    "Make the check pass.",
  );
  await s.zai("brief", "lint", edit);
  await s.zai("run", edit, "--wait");
  await s.settle();
  note(s, "worker env names (attempt 2)", envNames(s));
  await s.zai("board");
  await s.zai("board", "--hook");
  await s.zai("show", "261006-000001");
  await s.zai("review", "261006-000001");
  await s.zai("review", "261006-000001", "--diff");
  await s.zai("wait", "261006-000001");
  await s.zai("accept", "261006-000001");
  note(s, "commit on main", s.repo.git("log", "-1", "--format=%H%n%B"));
  note(s, "branches", s.repo.git("branch", "--list", "--all") || "(none)");
  await s.zai("accept", "261006-000001");

  // 2. exec: the worker echoes its prompt (the contract footer) and sees the artifacts env; return, then discard.
  scenario(s, { FAKE_CLAUDE_SCENARIO: "echo-prompt" });
  const exec = brief(
    s,
    "exec.md",
    [
      "title: Measure the value",
      "mode: exec",
      'gates: ["true"]',
      "env: [FAKE_CLAUDE_SCENARIO, FAKE_CLAUDE_REPORT, FAKE_CLAUDE_DUMP]",
    ],
    "Write the value's length to a file.",
  );
  await s.zai("run", exec, "--flash");
  await s.settle();
  note(s, "prompt (attempt 1)", promptOf(s, "261006-000002", 1));
  note(s, "worker env names (attempt 1)", envNames(s));
  await s.zai("wait", "261006-000002");
  await s.zai("show", "261006-000002");
  await s.zai("review", "261006-000002");
  await s.zai("return", "261006-000002");
  await s.zai("return", "261006-000002", "Also", "write", "the", "value", "itself.");
  await s.settle();
  note(s, "prompt (attempt 2)", promptOf(s, "261006-000002", 2));
  note(s, "prompt (attempt 3)", promptOf(s, "261006-000002", 3));
  await s.zai("review", "261006-000002");
  await s.zai("accept", "261006-000002");
  await s.zai("discard", "261006-000002", "--reason", "measured elsewhere");

  // 3. readonly: a sleeping worker is stopped mid-run, then discarded.
  scenario(s, { FAKE_CLAUDE_SCENARIO: "sleep" });
  const readonly = brief(
    s,
    "readonly.md",
    ["title: Survey the value", "mode: readonly", "env: [FAKE_CLAUDE_SCENARIO, FAKE_CLAUDE_REPORT]"],
    "Find every use of the value.",
  );
  await s.zai("run", readonly, "--bg", "--json");
  await s.waitForState("261006-000003", "running");
  await s.zai("stop", "261006-000003");
  await s.settle();
  await s.zai("review", "261006-000003");
  await s.zai("discard", "261006-000003");

  // 4. batch: one brief submitted (its worker echoes the readonly prompt), one rejected.
  scenario(s, { FAKE_CLAUDE_SCENARIO: "echo-prompt" });
  const dir = join(s.sandbox, "batch");
  brief(
    s,
    "batch/a-good.md",
    ["title: Batch survey", "mode: readonly", "env: [FAKE_CLAUDE_SCENARIO]"],
    "Look.",
  );
  brief(s, "batch/b-bad.md", ["title: Broken", "mode: sideways"], "Nothing.");
  await s.zai("batch", dir);
  await s.settle();
  note(s, "prompt (attempt 1)", promptOf(s, "261006-000004", 1));

  // 5. edit again: the worker echoes the edit contract; its branch exists until the discard removes it.
  const echo = brief(
    s,
    "echo.md",
    [
      "title: Echo the contract",
      'scope: ["src/**", "docs/*.md"]',
      'forbid: ["src/secret/**"]',
      "env: [FAKE_CLAUDE_SCENARIO, FAKE_CLAUDE_REPORT]",
    ],
    "Say what you were told.",
  );
  await s.zai("run", echo, "--wait");
  await s.settle();
  note(s, "prompt (attempt 1)", promptOf(s, "261006-000005", 1));
  note(s, "branches", s.repo.git("branch", "--list", "--all"));
  await s.zai("discard", "261006-000005", "--reason", "seen enough");
  note(s, "branches", s.repo.git("branch", "--list", "--all"));

  await s.zai("board", "--all");
  await s.zai("usage");
  await s.zai("usage", "--json");
}

/** macOS adds this to every process; it is not the plugin's doing. */
const PLATFORM_ENV = /^__CF_/;

/** Names only (never values) of the env the last worker ran with. */
function envNames(s: Session): string {
  const dump = JSON.parse(readFileSync(join(s.sandbox, "worker-env.json"), "utf8")) as {
    readonly envNames: readonly string[];
  };
  return dump.envNames.filter((name) => !PLATFORM_ENV.test(name)).join("\n");
}
