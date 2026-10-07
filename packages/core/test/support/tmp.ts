/**
 * Temp directories and throwaway git repositories for adapter integration tests. Everything lives under os.tmpdir()
 * and is removed when the current test finishes. Git never sees the developer's global/system config or hooks.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished, vi } from "vitest";

/** A fresh directory (realpath, so it compares equal to what git reports), removed after the current test. */
export function tempDir(prefix = "zai-test-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Process env for git: no global or system config, so the developer's settings and hooks cannot leak in. */
export const ISOLATED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** Applies ISOLATED_GIT_ENV to process.env (which the adapter inherits) until the current test finishes. */
export function isolateGitConfig(): void {
  for (const [name, value] of Object.entries(ISOLATED_GIT_ENV)) vi.stubEnv(name, value);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
}

const SAFE_GIT = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotepath=off"];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...SAFE_GIT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...ISOLATED_GIT_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface TestRepo {
  readonly dir: string;
  git(...args: string[]): string;
  write(path: string, content: string): void;
  read(path: string): string;
  remove(path: string): void;
  /** `git add -A && git commit`; returns the new HEAD sha. */
  commitAll(message: string): string;
  head(): string;
}

export function repoAt(dir: string): TestRepo {
  const repo: TestRepo = {
    dir,
    git: (...args) => git(dir, ...args),
    write: (path, content) => {
      const file = join(dir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
    read: (path) => readFileSync(join(dir, path), "utf8"),
    remove: (path) => rmSync(join(dir, path), { recursive: true, force: true }),
    commitAll: (message) => {
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", message);
      return repo.head();
    },
    head: () => repo.git("rev-parse", "HEAD").trim(),
  };
  return repo;
}

/** `git init` on branch main with a local identity, signing and hooks off, and one initial commit (README.md). */
export function makeRepo(): TestRepo {
  const repo = repoAt(join(tempDir("zai-repo-"), "repo"));
  mkdirSync(repo.dir);
  repo.git("init", "-q", "-b", "main");
  repo.git("config", "user.name", "Zai Test");
  repo.git("config", "user.email", "zai-test@example.invalid");
  repo.git("config", "commit.gpgsign", "false");
  repo.git("config", "core.hooksPath", "/dev/null");
  repo.write("README.md", "# test repo\n");
  repo.commitAll("init");
  return repo;
}

/** The pid of a process that has already exited (and been reaped). */
export function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) throw new Error("could not spawn a short-lived process");
  return pid;
}
