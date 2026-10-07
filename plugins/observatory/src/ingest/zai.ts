/**
 * Optional source: jobs recorded by the zai plugin under ~/.local/state/zai/jobs. Each job becomes an external
 * agent on its own pseudo-session; attempt files are `claude --output-format stream-json` events, which are the
 * same shapes transcript parsing already understands. A missing directory is normal and silent.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { zaiStateDir } from "../shared/paths.ts";

export type ZaiJob = {
  id: string;
  sessionId: string;
  title: string | null;
  state: string | null;
  live: boolean;
  model: string | null;
  updatedAt: number | null;
  dir: string;
  attemptFiles: string[];
};

const TERMINAL_STATES = new Set(["accepted", "discarded", "failed"]);

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function attemptNumber(name: string): number {
  const match = /^attempt-(\d+)\.jsonl$/.exec(name);
  return match === null ? -1 : Number.parseInt(match[1] ?? "0", 10);
}

function listAttemptFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => attemptNumber(name) >= 0)
      .sort((a, b) => attemptNumber(a) - attemptNumber(b))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function newestMtime(files: string[], updatedAt: number | null): number | null {
  let newest = updatedAt;
  for (const file of files) {
    try {
      const mtime = statSync(file).mtimeMs;
      if (newest === null || mtime > newest) newest = mtime;
    } catch {
      // an unreadable attempt file just does not contribute its mtime
    }
  }
  return newest;
}

function jobFromDir(root: string, id: string): ZaiJob | null {
  const dir = join(root, id);
  const job = readJson(join(dir, "job.json"));
  if (job === null) return null;
  const attemptFiles = listAttemptFiles(dir);
  const brief =
    typeof job.brief === "object" && job.brief !== null ? (job.brief as Record<string, unknown>) : {};
  const state = typeof job.state === "string" ? job.state : null;
  const updatedRaw = typeof job.updatedAt === "string" ? Date.parse(job.updatedAt) : NaN;
  return {
    id: typeof job.id === "string" ? job.id : id,
    sessionId: `zai:${id}`,
    title: typeof brief.title === "string" ? brief.title : null,
    state,
    live: state === null || !TERMINAL_STATES.has(state),
    model: typeof brief.model === "string" ? `zai:${brief.model}` : null,
    updatedAt: newestMtime(attemptFiles, Number.isFinite(updatedRaw) ? updatedRaw : null),
    dir,
    attemptFiles,
  };
}

/** All jobs under the zai state dir, newest update first. Missing dir → empty list. */
export function readZaiJobs(env: NodeJS.ProcessEnv): ZaiJob[] {
  const root = join(zaiStateDir(env), "jobs");
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch {
    return [];
  }
  const jobs: ZaiJob[] = [];
  for (const id of ids) {
    const job = jobFromDir(root, id);
    if (job !== null) jobs.push(job);
  }
  return jobs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
