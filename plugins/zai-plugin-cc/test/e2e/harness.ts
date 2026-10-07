/**
 * End-to-end harness: a throwaway repository with a package.json gate, a temp state root, and the real CLI entry
 * (`node src/cli/main.ts` with Node 24 type stripping, or `bun src/cli/main.ts` under TEST_RUNTIME=bun) with the fake
 * claude binary as worker. Every detached driver a test
 * started is killed when the test finishes; the temp dirs go too.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Job, JobState } from "@muhmdraouf/core/domain/job.ts";
import {
  ISOLATED_GIT_ENV,
  isPidAlive,
  makeRepo,
  type TestRepo,
  tempDir,
  testRuntime,
} from "@muhmdraouf/core/testing";
import { expect, onTestFinished } from "vitest";

const MAIN = join(import.meta.dirname, "../../src/cli/main.ts");
/** The runtime the CLI (and so every driver it spawns) runs on: TEST_RUNTIME=bun runs the e2e suite on bun. */
const RUNTIME = testRuntime();
const FAKE_CLAUDE = join(import.meta.dirname, "../support/fake-claude.ts");

export const ZAI_REPORT = {
  summary: "Set the value to right",
  files: [{ path: "src/value.txt", why: "the check expects right" }],
  tests_added: [],
  open_items: [],
};

const CHECK = `node -e "process.exit(require('fs').readFileSync('src/value.txt','utf8').trim() === 'right' ? 0 : 1)"`;

export interface E2E {
  readonly repo: TestRepo;
  readonly stateRoot: string;
  readonly env: Readonly<Record<string, string>>;
  /** Writes a brief whose worker edits per `edit` (and `editOnResume` when resumed); returns its path. `scenario` picks
   *  the fake claude's scenario, `front` adds front matter lines. */
  brief(opts: {
    readonly edit: string;
    readonly editOnResume?: string;
    readonly scenario?: string;
    readonly front?: readonly string[];
  }): string;
  /** Polls the job's state file until it reaches `state`. */
  waitForState(id: string, state: JobState): Promise<Job>;
}

export function e2eRepo(): E2E {
  const repo = makeRepo();
  repo.write(
    "package.json",
    `${JSON.stringify({ name: "e2e", private: true, scripts: { check: CHECK } }, null, 2)}\n`,
  );
  repo.write("src/value.txt", "wrong\n");
  repo.commitAll("e2e fixture");
  const sandbox = tempDir("zai-e2e-");
  const stateRoot = join(sandbox, "state");
  onTestFinished(() => killDrivers(stateRoot));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: sandbox,
    TMPDIR: sandbox,
    ...ISOLATED_GIT_ENV,
    ZAI_STATE_DIR: stateRoot,
    ZAI_CLAUDE_BIN: FAKE_CLAUDE,
    ZAI_API_KEY: "zai-e2e-fake-key",
    FAKE_CLAUDE_SCENARIO: "edit-file",
    FAKE_CLAUDE_REPORT: JSON.stringify(ZAI_REPORT),
  };
  return {
    repo,
    stateRoot,
    env,
    brief(opts) {
      env.FAKE_CLAUDE_EDIT = opts.edit;
      env.FAKE_CLAUDE_EDIT_ON_RESUME = opts.editOnResume ?? opts.edit;
      env.FAKE_CLAUDE_SCENARIO = opts.scenario ?? "edit-file";
      const front = [
        "title: Fix the value",
        'scope: ["src/**"]',
        "gates: [npm run --silent check]",
        "env: [FAKE_CLAUDE_SCENARIO, FAKE_CLAUDE_EDIT, FAKE_CLAUDE_EDIT_ON_RESUME, FAKE_CLAUDE_REPORT]",
        ...(opts.front ?? []),
      ];
      // The brief is the orchestrator's file, outside the repository.
      const path = join(sandbox, "brief.md");
      writeFileSync(path, `---\n${front.join("\n")}\n---\nMake the check pass.\n`);
      return path;
    },
    async waitForState(id, state) {
      let job: Job | undefined;
      await expect
        .poll(
          () => {
            job = readJob(stateRoot, id);
            return job?.state;
          },
          { timeout: 30_000, interval: 50 },
        )
        .toBe(state);
      if (job === undefined) throw new Error(`job ${id} vanished`);
      return job;
    },
  };
}

function readJob(stateRoot: string, id: string): Job | undefined {
  try {
    return JSON.parse(readFileSync(join(stateRoot, "jobs", id, "job.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** Detached drivers still holding a job lock when the test ends. */
function killDrivers(stateRoot: string): void {
  let ids: string[];
  try {
    ids = readdirSync(join(stateRoot, "jobs"));
  } catch {
    return;
  }
  for (const id of ids) {
    let pid = Number.NaN;
    try {
      pid = Number(readFileSync(join(stateRoot, "jobs", id, "driver.lock"), "utf8").trim());
    } catch {
      continue;
    }
    if (Number.isSafeInteger(pid) && pid > 0 && isPidAlive(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  }
}

export interface ZaiRun {
  readonly code: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the real CLI in the repository with the harness environment. */
export function runZai(e2e: E2E, args: readonly string[]): Promise<ZaiRun> {
  return startZai(e2e, args).done;
}

export interface StartedZai {
  readonly child: ChildProcess;
  /** Resolves with the first stdout line (or "" if the process closes first). */
  readonly firstLine: Promise<string>;
  readonly done: Promise<ZaiRun>;
}

/** Starts the real CLI without waiting for it, so a test can signal it mid-run. */
export function startZai(e2e: E2E, args: readonly string[]): StartedZai {
  const child = spawn(RUNTIME, [MAIN, ...args], {
    cwd: e2e.repo.dir,
    env: e2e.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let gotLine: (line: string) => void = () => {};
  const firstLine = new Promise<string>((resolve) => (gotLine = resolve));
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.includes("\n")) gotLine(stdout.slice(0, stdout.indexOf("\n")));
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const done = new Promise<ZaiRun>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      gotLine("");
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, firstLine, done };
}
