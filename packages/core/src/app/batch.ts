import type { Job } from "../domain/job.ts";
import type { Deps } from "./deps.ts";
import type { AppError } from "./errors.ts";
import { submit } from "./submit.ts";

export interface BatchItem {
  readonly path: string;
  readonly text: string;
}

interface BatchOutcome {
  readonly submitted: readonly Job[];
  readonly rejected: readonly { readonly path: string; readonly error: AppError }[];
}

/** Submit every brief (all-or-report: invalid ones are listed, valid ones still go) and spawn one detached driver each;
 *  the semaphore + limiter pace them. */
export async function batch(deps: Deps, items: readonly BatchItem[], cwd: string): Promise<BatchOutcome> {
  const submitted: Job[] = [];
  const rejected: { readonly path: string; readonly error: AppError }[] = [];
  for (const item of items) {
    const job = await submit(deps, {
      text: item.text,
      sourcePath: item.path,
      cwd,
      defaultPriority: "normal",
    });
    if (job.ok) {
      deps.process.spawnDriver(job.value.id);
      submitted.push(job.value);
    } else {
      rejected.push({ path: item.path, error: job.error });
    }
  }
  return { submitted, rejected };
}
