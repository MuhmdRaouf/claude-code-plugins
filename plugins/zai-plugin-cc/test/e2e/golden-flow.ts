/**
 * The golden transcript: one scripted session through the real CLI (runCli over the real adapters from wire(): git, the
 * fs store, shell gates and the claude-headless worker running the fake claude binary), rendered as plain text. Every
 * user-visible string the plugin prints goes through it: CLI messages and errors, the renderers, the brief template,
 * the prompt the worker receives (its contract footer), the env names the worker sees, branch and trailer names.
 *
 * What would vary between runs is pinned, not masked: a fixed clock, sequential job and session ids, fixed git dates,
 * gate durations zeroed. Drivers run in this process (as `drive <id>` would detached), one at a time, and their output
 * is part of the transcript. Only the sandbox and plugin paths are replaced by <sandbox> and <plugin>.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Deps } from "@muhmdraouf/core/app/deps.ts";
import { runCli } from "@muhmdraouf/core/cli/run.ts";
import { wire } from "@muhmdraouf/core/cli/wire.ts";
import type { JobState } from "@muhmdraouf/core/domain/job.ts";
import { ok } from "@muhmdraouf/core/domain/result.ts";
import type { Clock, Ids, Output } from "@muhmdraouf/core/ports/index.ts";
import { ISOLATED_GIT_ENV, makeRepo, type TestRepo, tempDir, writeAgents } from "@muhmdraouf/core/testing";
import { vi } from "vitest";
import { ZAI_PROVIDER } from "../../src/provider.ts";

const PLUGIN = join(import.meta.dirname, "../..");
const FAKE_CLAUDE = join(import.meta.dirname, "../support/fake-claude.ts");
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
/** Real waits, shortened: polling more often changes nothing a command prints. */
const MAX_SLEEP_MS = 20;

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

/** Swaps parts of the wired Deps (the provider, say) before the session pins its clock, ids and gate timings. */
export type Customize = (deps: Deps) => Deps;

class Recorder implements Output {
  readonly text: string[] = [];
  line(text: string): void {
    this.text.push(text);
  }
  error(text: string): void {
    this.text.push(...text.split("\n").map((line) => `stderr| ${line}`));
  }
}

function fixedClock(): Clock {
  return {
    now: () => NOW,
    iso: () => new Date(NOW).toISOString(),
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = setTimeout(resolve, Math.min(ms, MAX_SLEEP_MS));
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      }),
  };
}

function sequentialIds(): Ids {
  let jobs = 0;
  let sessions = 0;
  return {
    jobId: () => `261006-${String(++jobs).padStart(6, "0")}`,
    sessionId: () => `00000000-0000-4000-8000-${String(++sessions).padStart(12, "0")}`,
  };
}

interface Session {
  readonly repo: TestRepo;
  readonly sandbox: string;
  readonly env: Record<string, string>;
  readonly transcript: string[];
  /** Drivers started and not yet settled; each resolves to its transcript lines. */
  readonly drivers: Promise<readonly string[]>[];
  readonly deps: Deps;
}

/** Runs one CLI command and appends `$ <cli> <args>`, its output and its exit code; returns the output lines. */
async function zai(session: Session, ...argv: string[]): Promise<readonly string[]> {
  const out = new Recorder();
  const code = await runCli(argv, { ...session.deps, out }, session.repo.dir);
  session.transcript.push(
    `$ ${session.deps.provider.name} ${argv.join(" ")}`,
    ...out.text,
    `[exit ${code}]`,
    "",
  );
  return out.text;
}

/** Waits for the drivers started so far and appends what each printed, in the order they were started. */
async function settle(session: Session): Promise<void> {
  for (const driver of session.drivers.splice(0)) session.transcript.push(...(await driver));
}

function note(session: Session, title: string, body: string): void {
  session.transcript.push(`# ${title}`, ...body.trimEnd().split("\n"), "");
}

async function waitForState(session: Session, id: string, state: JobState): Promise<void> {
  for (;;) {
    const job = await session.deps.store.get(id);
    if (job.ok && job.value.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, MAX_SLEEP_MS));
  }
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
  const log = readFileSync(join(session.deps.host.stateRoot, "jobs", id, `attempt-${attempt}.jsonl`), "utf8");
  for (const line of log.split("\n")) {
    const event = line === "" ? undefined : JSON.parse(line);
    if (event?.type === "assistant") return event.message.content[0].text;
  }
  return "(no prompt)";
}

function openSession(customize: Customize): Session {
  for (const [name, value] of Object.entries({ ...ISOLATED_GIT_ENV, ...GIT_DATES })) vi.stubEnv(name, value);
  const repo = makeRepo();
  repo.write(
    "package.json",
    `${JSON.stringify({ name: "golden", private: true, scripts: { check: CHECK } }, null, 2)}\n`,
  );
  repo.write("src/value.txt", "wrong\n");
  repo.commitAll("golden fixture");
  const sandbox = tempDir("zai-golden-");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: sandbox,
    TMPDIR: sandbox,
    ...ISOLATED_GIT_ENV,
    ZAI_STATE_DIR: join(sandbox, "state"),
    ZAI_CLAUDE_BIN: FAKE_CLAUDE,
    ZAI_API_KEY: "zai-golden-fake-key",
    FAKE_CLAUDE_REPORT: JSON.stringify(REPORT),
    FAKE_CLAUDE_DUMP: join(sandbox, "worker-env.json"),
  };
  const drivers: Promise<readonly string[]>[] = [];
  // Setup's wiring reads and rewrites the agents beside the bundle, so the session runs a sandbox copy of the plugin
  // (dist plus agents) and never the shipped files; the router start and its key check are faked below, the router
  // process is not the transcript's subject.
  const bundlePath = join(sandbox, "plugin", "dist", "zai.js");
  const wired = customize(wire({ provider: ZAI_PROVIDER, env, bundlePath, out: new Recorder() }));
  writeAgents(bundlePath, wired.provider);
  const deps: Deps = {
    ...wired,
    clock: fixedClock(),
    ids: sequentialIds(),
    gates: { run: async (...args) => ({ ...(await wired.gates.run(...args)), durationMs: 0 }) },
    host: {
      ...wired.host,
      // Pinned: the runtime under test (and its path) differs per machine and per leg of the runtime matrix.
      runtime: "bun 1.3.14 (/usr/local/bin/bun)",
      ensureRouter: async () =>
        ok(`running on http://127.0.0.1:${wired.provider.router.port} (already running)`),
      retireRouter: async () =>
        ok("retired (pid 4242): keeps Claude working in open sessions, exits when they close"),
      routerKey: async () => ok("ZAI_API_KEY"),
    },
    process: {
      ...wired.process,
      spawnDriver: (id) => {
        const out = new Recorder();
        drivers.push(
          runCli(["drive", id], { ...deps, out }, repo.dir).then((code) => [
            `# driver ${id}`,
            ...out.text,
            `[exit ${code}]`,
            "",
          ]),
        );
        return process.pid;
      },
    },
  };
  return { repo, sandbox, env, transcript: [], drivers, deps };
}

function normalized(session: Session): string {
  return `${session.transcript.join("\n")}\n`
    .replaceAll(session.sandbox, "<sandbox>")
    .replaceAll(session.repo.dir, "<repo>")
    .replaceAll(PLUGIN, "<plugin>");
}

/** The scripted session; returns its normalized transcript. */
export async function goldenTranscript(customize: Customize = (deps) => deps): Promise<string> {
  const s = openSession(customize);
  try {
    await script(s);
  } finally {
    await settle(s);
    vi.unstubAllEnvs();
  }
  return normalized(s);
}

async function script(s: Session): Promise<void> {
  await zai(s, "--help");
  await zai(s);
  await zai(s, "frobnicate");
  await zai(s, "setup");
  await zai(s, "setup", "--ping");
  await zai(s, "setup", "--json");
  await zai(s, "board");
  await zai(s, "board", "--hook");
  await zai(s, "usage");
  await zai(s, "show", "nope");
  await zai(s, "accept");
  await zai(s, "stop", "--all");
  await zai(s, "batch", "missing-dir");

  // brief templates, one per mode
  for (const mode of ["edit", "exec", "readonly"]) {
    const [path = ""] = await zai(s, "brief", "new", `Golden ${mode}`, "--mode", mode);
    note(s, `template ${mode}`, readFileSync(path, "utf8"));
    await zai(s, "brief", "lint", path);
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
  await zai(s, "brief", "lint", edit);
  await zai(s, "run", edit, "--wait");
  await settle(s);
  note(s, "worker env names (attempt 2)", envNames(s));
  await zai(s, "board");
  await zai(s, "board", "--hook");
  await zai(s, "show", "261006-000001");
  await zai(s, "review", "261006-000001");
  await zai(s, "review", "261006-000001", "--diff");
  await zai(s, "wait", "261006-000001");
  await zai(s, "accept", "261006-000001");
  note(s, "commit on main", s.repo.git("log", "-1", "--format=%H%n%B"));
  note(s, "branches", s.repo.git("branch", "--list", "--all") || "(none)");
  await zai(s, "accept", "261006-000001");

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
  await zai(s, "run", exec, "--flash");
  await settle(s);
  note(s, "prompt (attempt 1)", promptOf(s, "261006-000002", 1));
  note(s, "worker env names (attempt 1)", envNames(s));
  await zai(s, "wait", "261006-000002");
  await zai(s, "show", "261006-000002");
  await zai(s, "review", "261006-000002");
  await zai(s, "return", "261006-000002");
  await zai(s, "return", "261006-000002", "Also", "write", "the", "value", "itself.");
  await settle(s);
  note(s, "prompt (attempt 2)", promptOf(s, "261006-000002", 2));
  note(s, "prompt (attempt 3)", promptOf(s, "261006-000002", 3));
  await zai(s, "review", "261006-000002");
  await zai(s, "accept", "261006-000002");
  await zai(s, "discard", "261006-000002", "--reason", "measured elsewhere");

  // 3. readonly: a sleeping worker is stopped mid-run, then discarded.
  scenario(s, { FAKE_CLAUDE_SCENARIO: "sleep" });
  const readonly = brief(
    s,
    "readonly.md",
    ["title: Survey the value", "mode: readonly", "env: [FAKE_CLAUDE_SCENARIO, FAKE_CLAUDE_REPORT]"],
    "Find every use of the value.",
  );
  await zai(s, "run", readonly, "--bg", "--json");
  await waitForState(s, "261006-000003", "running");
  await zai(s, "stop", "261006-000003");
  await settle(s);
  await zai(s, "review", "261006-000003");
  await zai(s, "discard", "261006-000003");

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
  await zai(s, "batch", dir);
  await settle(s);
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
  await zai(s, "run", echo, "--wait");
  await settle(s);
  note(s, "prompt (attempt 1)", promptOf(s, "261006-000005", 1));
  note(s, "branches", s.repo.git("branch", "--list", "--all"));
  await zai(s, "discard", "261006-000005", "--reason", "seen enough");
  note(s, "branches", s.repo.git("branch", "--list", "--all"));

  await zai(s, "board", "--all");
  await zai(s, "usage");
  await zai(s, "usage", "--json");
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
