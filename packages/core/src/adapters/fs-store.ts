import { access, mkdir, readdir, readFile } from "node:fs/promises";
import { z } from "zod";
import type { Job } from "../domain/job.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { stateLayout } from "../domain/state-layout.ts";
import type { JobStore, StoreError } from "../ports/index.ts";
import { errnoCode, errorMessage } from "./fs-errors.ts";
import { writeFileAtomic } from "./fs-files.ts";
import { type IsAlive, tryLock, waitLock } from "./fs-lock.ts";

/** job.json writes hold this lock only for read-compare-rename; waiting longer means something is wrong. */
const WRITE_LOCK_TIMEOUT_MS = 10_000;

/** Ids become directory names: no separators, no dot-dirs. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Shallow shape check of a stored job: enough to tell our file from a foreign or truncated one. */
const StoredJob = z.looseObject({
  id: z.string(),
  version: z.number().int().nonnegative(),
  state: z.enum(["queued", "running", "verifying", "awaiting_review", "accepted", "discarded"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  brief: z.looseObject({ title: z.string() }),
  workspace: z.looseObject({ repoRoot: z.string() }),
  attempts: z.array(z.unknown()),
});

function parseJob(text: string): Result<Job, string> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return err(errorMessage(error));
  }
  const checked = StoredJob.safeParse(value);
  if (!checked.success) return err(checked.error.message);
  // The shape was validated just above; the stored file is written only by this store from a Job.
  return ok(upgradeTier(value as Job));
}

/** A stored job may name zai's main tier "glm" (the tiers are main and flash); it reads as "main". */
function upgradeTier(job: Job): Job {
  const model: string = job.brief.model;
  return model === "glm" ? { ...job, brief: { ...job.brief, model: "main" } } : job;
}

/** Code-unit order (ISO timestamps and ids sort correctly; locale collation is not guaranteed to). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function newestFirst(a: Job, b: Job): number {
  return compareText(b.createdAt, a.createdAt) || compareText(b.id, a.id);
}

const io = (message: string): StoreError => ({ kind: "io", message });

/** Unexpected filesystem failures become `io` values instead of escaping the port. */
async function guarded<T>(fn: () => Promise<Result<T, StoreError>>): Promise<Result<T, StoreError>> {
  try {
    return await fn();
  } catch (error) {
    return err(io(errorMessage(error)));
  }
}

/** Layout: <root>/jobs/<id>/{job.json, brief.md, attempt-<n>.jsonl, gate-<n>-<i>.log, artifacts/, driver.lock, stop}.
 *  job.json writes are atomic (write tmp + rename) under a short lock; version checked before rename. */
export function createFsStore(root: string, isAlive: IsAlive): JobStore {
  const layout = stateLayout(root);
  const jobFile = (id: string) => layout.job(id).record;

  async function ids(): Promise<string[]> {
    try {
      const entries = await readdir(layout.jobs, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return [];
      throw error;
    }
  }

  async function read(id: string): Promise<Result<Job, StoreError>> {
    if (!SAFE_ID.test(id)) return err({ kind: "not_found", id });
    let text: string;
    try {
      text = await readFile(jobFile(id), "utf8");
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return err({ kind: "not_found", id });
      throw error;
    }
    const job = parseJob(text);
    return job.ok ? job : err(io(`job ${id}: unreadable job.json: ${job.error}`));
  }

  /** Runs fn holding the job's write lock, so read-compare-write sequences of concurrent writers never interleave. */
  async function exclusively<T>(
    id: string,
    fn: () => Promise<Result<T, StoreError>>,
  ): Promise<Result<T, StoreError>> {
    const lock = await waitLock(`${jobFile(id)}.lock`, process.pid, isAlive, WRITE_LOCK_TIMEOUT_MS);
    if (!lock.ok) return err(io(`job ${id}: write lock still held by pid ${lock.error.holderPid}`));
    try {
      return await fn();
    } finally {
      await lock.value();
    }
  }

  async function write(job: Job): Promise<Job> {
    const stored = { ...job, version: job.version + 1 };
    await writeFileAtomic(jobFile(job.id), `${JSON.stringify(stored, null, 2)}\n`);
    return stored;
  }

  return {
    create: (job) =>
      guarded(async () => {
        if (!SAFE_ID.test(job.id)) return err(io(`invalid job id ${JSON.stringify(job.id)}`));
        await mkdir(layout.job(job.id).artifacts, { recursive: true });
        return exclusively(job.id, async () => {
          const exists = await access(jobFile(job.id)).then(
            () => true,
            () => false,
          );
          return exists ? err(io(`job ${job.id} already exists`)) : ok(await write(job));
        });
      }),
    get: (id) => guarded(() => read(id)),
    find: (idOrPrefix) =>
      guarded(async () => {
        const all = await ids();
        if (all.includes(idOrPrefix)) return read(idOrPrefix);
        const matches = idOrPrefix === "" ? [] : all.filter((id) => id.startsWith(idOrPrefix));
        const [only, ...others] = matches;
        return only !== undefined && others.length === 0
          ? read(only)
          : err({ kind: "not_found", id: idOrPrefix });
      }),
    update: (job) =>
      guarded(async () => {
        // Checked before locking too: the lock file lives in the job's directory.
        const exists = await read(job.id);
        if (!exists.ok) return exists;
        return exclusively(job.id, async () => {
          const current = await read(job.id);
          if (!current.ok) return current;
          if (current.value.version !== job.version) {
            return err({
              kind: "version_conflict",
              id: job.id,
              expected: job.version,
              actual: current.value.version,
            });
          }
          return ok(await write(job));
        });
      }),
    async list(filter) {
      const reads = await Promise.all((await ids()).map((id) => guarded(() => read(id))));
      // Half-created or corrupt entries are skipped: one bad directory must not hide every other job.
      const jobs = reads.flatMap((job) => (job.ok ? [job.value] : []));
      const repoRoot = filter?.repoRoot;
      return jobs
        .filter((job) => repoRoot === undefined || job.workspace.repoRoot === repoRoot)
        .sort(newestFirst);
    },
    paths: (id) => layout.job(id),
    lock: (id, pid) =>
      guarded(async () => {
        const exists = await read(id);
        if (!exists.ok) return exists;
        const lock = await tryLock(layout.job(id).driverLock, pid, isAlive);
        return lock.ok ? lock : err({ kind: "locked", id, holderPid: lock.error.holderPid });
      }),
  };
}
