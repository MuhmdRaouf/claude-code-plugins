// The files beside a job's record (stateLayout's JobPaths): the stop request, the driver's progress snapshot (written
// often, so it stays out of job.json), the driver lock the store maintains (read here only to tell live drivers from
// dead ones), the engine's process group, the brief, and the accepts' leftover checkouts.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseJson } from "../domain/json.ts";
import { parsePid } from "../domain/pid.ts";
import { err, ok } from "../domain/result.ts";
import { stateLayout } from "../domain/state-layout.ts";
import type { JobFiles } from "../ports/index.ts";
import { errorMessage } from "./fs-errors.ts";

const ProgressSchema = z.object({
  sessionId: z.string().optional(),
  phase: z.enum(["starting", "thinking", "tool", "writing", "rate_limited", "done"]),
  turns: z.number(),
  lastTool: z.string().optional(),
  lastText: z.string(),
  rateLimitRetries: z.number(),
  toolCalls: z.number(),
  toolErrors: z.number(),
});

const Snapshot = z.object({ attempt: z.number(), progress: ProgressSchema });

export function createFsJobFiles(stateRoot: string): JobFiles {
  const { checkouts } = stateLayout(stateRoot);
  return {
    async writeBrief(paths, text) {
      await mkdir(paths.artifacts, { recursive: true });
      await writeFile(paths.brief, text);
    },
    async requestStop(paths) {
      await writeFile(paths.stop, "");
    },
    stopRequested: (paths) =>
      readFile(paths.stop).then(
        () => true,
        () => false,
      ),
    async clearStop(paths) {
      await rm(paths.stop, { force: true });
    },
    async writeProgress(paths, attempt, progress) {
      await writeFile(paths.progress, `${JSON.stringify({ attempt, progress })}\n`);
    },
    async readProgress(paths, attempt) {
      const snapshot = parseJson(await readFile(paths.progress, "utf8").catch(() => ""), Snapshot);
      if (snapshot === undefined || snapshot.attempt !== attempt) return undefined;
      const { sessionId, lastTool, ...rest } = snapshot.progress;
      return {
        ...rest,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(lastTool === undefined ? {} : { lastTool }),
      };
    },
    readText: (path) =>
      readFile(path, "utf8").then(
        (text) => ok(text),
        (error: unknown) => err(errorMessage(error)),
      ),
    driverPid: async (paths) => parsePid(await readFile(paths.driverLock, "utf8").catch(() => "")),
    enginePid: (paths) => readEnginePid(paths.enginePid),
    clearEnginePid: (paths) => clearEnginePid(paths.enginePid),
    checkoutIds: () => (existsSync(checkouts) ? readdirSync(checkouts) : []),
    checkoutRepo,
    exists: (path) => existsSync(path),
    removeTree(path) {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/** `file` is a job's `engine.pid` (JobPaths.enginePid). The engine wiring writes it while the engine runs. */
export function writeEnginePid(file: string, pid: number): void {
  writeFileSync(file, `${pid}\n`, { mode: 0o600 });
}

export function clearEnginePid(file: string): void {
  rmSync(file, { force: true });
}

export function readEnginePid(file: string): number | undefined {
  try {
    return parsePid(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** A detached checkout's `.git` file points at the repo's worktree registration: `<repo>/.git/worktrees/<name>`. */
function checkoutRepo(checkout: string): string | undefined {
  try {
    const git = readFileSync(join(checkout, ".git"), "utf8").trim();
    const gitdir = git.startsWith("gitdir:") ? git.slice("gitdir:".length).trim() : undefined;
    return gitdir === undefined ? undefined : dirname(dirname(gitdir));
  } catch {
    return undefined;
  }
}
