/**
 * The job as its state root's `jobs/<id>/job.json` records it: the fields the end-to-end tests read. The plugin-core
 * binary writes the same field names and values the state root has always carried.
 */
export type JobState = "queued" | "running" | "verifying" | "awaiting_review" | "accepted" | "discarded";

export type AttemptKind = "initial" | "auto_fix" | "review_fix" | "infra_retry";

/** One worker run at a job, as job.json records it. */
export interface Attempt {
  readonly n: number;
  readonly kind: AttemptKind;
  readonly prompt: string;
  /** Reviewer feedback that triggered a review_fix attempt. */
  readonly feedback?: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly verdict?: string;
}

export interface Job {
  readonly id: string;
  readonly title?: string;
  readonly state: JobState;
  readonly attempts: readonly Attempt[];
}
