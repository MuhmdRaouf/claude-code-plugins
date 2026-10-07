import { existsSync } from "node:fs";
import { err, ok, type Result } from "../domain/result.ts";
import type { GitError } from "../ports/index.ts";
import { chompNewline } from "./git-parse.ts";
import { runTool } from "./process/tool.ts";

type GitRun =
  | { readonly ok: true; readonly stdout: Buffer }
  | { readonly ok: false; readonly code: number | null; readonly stderr: string };

interface GitRunOptions {
  /** Written to stdin; stdin is closed either way so git never waits on it. */
  readonly input?: Buffer | string;
  readonly env?: Readonly<Record<string, string>>;
}

/** Variables that would point git at another repository, index or work tree than the `cwd` we pass explicitly
 *  (set, for example, when running inside a git hook). */
const LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

function gitEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of LOCATION_VARS) delete env[name];
  // English messages (classification reads stderr); never prompt, never open an editor.
  return { ...env, LC_ALL: "C", LANGUAGE: "", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", ...extra };
}

/** `git -c core.quotepath=off <args>` in cwd, without a shell. Expected failures come back as values. */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<GitRun> {
  const run = await runTool("git", ["-c", "core.quotepath=off", ...args], {
    cwd,
    env: gitEnv(options.env ?? {}),
    ...(options.input === undefined ? {} : { stdin: options.input }),
  });
  if (run.kind === "missing") return { ok: false, code: null, stderr: run.message };
  if (run.code === 0) return { ok: true, stdout: run.stdout };
  // `commit` with nothing to commit explains itself on stdout only.
  const output = run.stderr.length > 0 ? run.stderr : run.stdout;
  const text = output.length > 0 ? output.toString("utf8") : `git ${args.join(" ")} failed`;
  return { ok: false, code: run.code, stderr: text.trim() };
}

/** Maps a failed run to the port's error union. */
export function gitError(
  cwd: string,
  args: readonly string[],
  run: Extract<GitRun, { ok: false }>,
): GitError {
  if (!existsSync(cwd) || /not a git repository/i.test(run.stderr)) return { kind: "not_a_repo", path: cwd };
  return { kind: "git_failed", command: `git ${args.join(" ")}`, stderr: run.stderr };
}

/** Runs git and returns stdout as text, or the mapped error. */
export async function gitText(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<Result<string, GitError>> {
  const run = await runGit(cwd, args, options);
  return run.ok ? ok(run.stdout.toString("utf8")) : err(gitError(cwd, args, run));
}

export async function gitVoid(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<Result<void, GitError>> {
  const run = await runGit(cwd, args, options);
  return run.ok ? ok(undefined) : err(gitError(cwd, args, run));
}

/** For commands whose output is one value (a sha, a path) on one line. */
export async function gitValue(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<Result<string, GitError>> {
  const text = await gitText(cwd, args, options);
  return text.ok ? ok(chompNewline(text.value)) : text;
}
