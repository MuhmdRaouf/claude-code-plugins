/**
 * Optional source: jobs recorded by the provider plugins under their state dirs. Each job becomes an external
 * agent on its own pseudo session (`<provider>:<job id>`); attempt files are `claude --output-format stream-json`
 * events, which are the same shapes transcript parsing already understands. A missing directory is normal and
 * silent.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { providerStateDir } from "../shared/paths.ts";

export const JOB_PLUGINS = ["zai", "kimi", "deepseek", "minimax", "qwen"] as const;
export type JobPlugin = (typeof JOB_PLUGINS)[number];

export type JobAttempt = {
  /** The attempt's stream file, attempt-<n>.jsonl. */
  file: string;
  n: number;
  /** The session id the job engine recorded for this attempt, when job.json says one. */
  sessionId: string | null;
};

export type PluginJob = {
  id: string;
  plugin: JobPlugin;
  /** The pseudo session every record of this job lands on: `<plugin>:<id>`. */
  sessionId: string;
  title: string | null;
  state: string | null;
  live: boolean;
  model: string | null;
  updatedAt: number | null;
  dir: string;
  attempts: JobAttempt[];
  /** Where the job's requests go: the plugin's Anthropic-compatible API, when radar knows it. */
  upstream: string;
  /** The checkout the job runs in, and the branch it pushes to (edit mode only). */
  repoRoot: string | null;
  branch: string | null;
  /** The Claude Code session that submitted the job, when there was one. */
  parentSessionId: string | null;
};

/** zai's Anthropic-compatible base URL for jobs (plugins/zai-plugin-cc/src/provider.ts, baseUrl). */
export const ZAI_JOB_UPSTREAM = "https://api.z.ai/api/anthropic";

/**
 * The states a job is actually running in. The engines' own active sets agree (zai: queued, running,
 * verifying); a job that landed — awaiting review, accepted, returned to its queue's floor, discarded,
 * failed — is not running, and an unknown state never poses as a running one.
 */
const LIVE_JOB_STATES = new Set(["queued", "running", "verifying"]);

/** The config dir every attempt of a plugin's jobs runs `claude` with: its transcripts live under here. */
export function jobClaudeHome(env: NodeJS.ProcessEnv, plugin: JobPlugin): string {
  return join(providerStateDir(env, plugin), "claude-home");
}

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

/** attempts[n - 1] when the array lines up with the stream files; anything else reads as unknown. */
function recordedSessionId(attempts: unknown, n: number): string | null {
  if (!Array.isArray(attempts)) return null;
  for (const entry of attempts) {
    if (typeof entry !== "object" || entry === null) continue;
    if ((entry as Record<string, unknown>).n !== n) continue;
    const sessionId = (entry as Record<string, unknown>).sessionId;
    return typeof sessionId === "string" && sessionId !== "" ? sessionId : null;
  }
  return null;
}

function attemptsOf(dir: string, raw: unknown): JobAttempt[] {
  return listAttemptFiles(dir).map((file) => {
    const n = attemptNumber(basename(file));
    return { file, n, sessionId: recordedSessionId(raw, n) };
  });
}

const objectOf = (job: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = job[key];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
};

const knownString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** Live only while the engine is still working the job; every landed or unknown state reads as finished. */
const stillLive = (state: unknown): boolean => typeof state === "string" && LIVE_JOB_STATES.has(state);

/** The run's last update: its recorded updatedAt, or the newest attempt file's mtime. */
function updatedAtOf(attempts: JobAttempt[], raw: unknown): number | null {
  const parsed = typeof raw === "string" ? Date.parse(raw) : NaN;
  return newestMtime(
    attempts.map((attempt) => attempt.file),
    Number.isFinite(parsed) ? parsed : null,
  );
}

function jobFromDir(
  plugin: JobPlugin,
  upstreamOf: (plugin: JobPlugin) => string,
  root: string,
  id: string,
): PluginJob | null {
  const dir = join(root, id);
  const job = readJson(join(dir, "job.json"));
  if (job === null) return null;
  const brief = objectOf(job, "brief");
  const attempts = attemptsOf(dir, job.attempts);
  const model = knownString(brief.model);
  return {
    id: typeof job.id === "string" ? job.id : id,
    plugin,
    sessionId: `${plugin}:${id}`,
    title: knownString(brief.title),
    state: typeof job.state === "string" ? job.state : null,
    live: stillLive(job.state),
    model: model === null ? null : `${plugin}:${model}`,
    updatedAt: updatedAtOf(attempts, job.updatedAt),
    dir,
    attempts,
    upstream: plugin === "zai" ? ZAI_JOB_UPSTREAM : upstreamOf(plugin),
    repoRoot: knownString(objectOf(job, "workspace").repoRoot),
    branch: knownString(objectOf(job, "workspace").branch),
    parentSessionId: knownString(objectOf(job, "origin").sessionId),
  };
}

/** All jobs under every provider's state dir, newest update first. Missing dirs → empty list. */
export function readJobs(
  env: NodeJS.ProcessEnv,
  upstreamOf: (plugin: JobPlugin) => string = () => "",
): PluginJob[] {
  const jobs: PluginJob[] = [];
  for (const plugin of JOB_PLUGINS) {
    const root = join(providerStateDir(env, plugin), "jobs");
    let ids: string[];
    try {
      ids = readdirSync(root);
    } catch {
      continue;
    }
    for (const id of ids) {
      const job = jobFromDir(plugin, upstreamOf, root, id);
      if (job !== null) jobs.push(job);
    }
  }
  return jobs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The `<sessionId>/subagents/*.jsonl` transcripts beside a session transcript, sorted, [] when none. */
export function listSubagents(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

export type AttemptTranscript = {
  /** The attempt's own transcript, <claudeHome>/projects/<project>/<sessionId>.jsonl. */
  file: string;
  /** The subagents that attempt spawned, <same project dir>/<sessionId>/subagents/*.jsonl. */
  subagents: string[];
};

/** The transcript one attempt wrote under the plugin's claude-home, or null when there is none (older jobs). */
export function attemptTranscript(claudeHome: string, sessionId: string): AttemptTranscript | null {
  const projects = join(claudeHome, "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(projects, entry.name));
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = join(dir, `${sessionId}.jsonl`);
    if (!isFile(file)) continue;
    return { file, subagents: listSubagents(join(dir, sessionId, "subagents")) };
  }
  return null;
}
