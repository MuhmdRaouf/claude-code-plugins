import type { Brief } from "./brief.ts";

export type JobState = "queued" | "running" | "verifying" | "awaiting_review" | "accepted" | "discarded";

export type AttemptKind = "initial" | "auto_fix" | "review_fix" | "infra_retry";

export type WorkerOutcome =
  | { readonly kind: "completed" }
  | {
      readonly kind: "api_error";
      readonly message: string;
      readonly status?: number;
      /** The provider says the account has no balance or quota left: no retry can succeed until the user tops up. */
      readonly quota?: true;
    }
  | { readonly kind: "timeout" }
  | {
      readonly kind: "crashed";
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly stderrTail: string;
    }
  | { readonly kind: "stopped" };

export interface Usage {
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly rateLimitRetries: number;
  readonly durationMs: number;
  /** A delegation engine's attempts only: the model the tool reported running on, in the tool's own naming (it runs
   *  on its own setup's default, so this is the only place the job learns which). */
  readonly model?: string;
}

export interface GateResult {
  readonly run: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Last lines of combined stdout/stderr, bounded. */
  readonly tail: string;
}

export interface ChangeSet {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  /** Renames are recorded as delete(from) + add(to) by the git adapter. */
  readonly untracked: readonly string[];
}

export interface ScopeCheck {
  readonly outOfScope: readonly string[];
  readonly forbidden: readonly string[];
  /** exec/readonly: the repository must not change at all. */
  readonly repoChanged: boolean;
}

export interface ReportCheck {
  readonly present: boolean;
  readonly valid: boolean;
  readonly problems: readonly string[];
}

export interface Verification {
  readonly gates: readonly GateResult[];
  readonly changes: ChangeSet;
  readonly scope: ScopeCheck;
  readonly report: ReportCheck;
}

export type Verdict =
  | "pass"
  | "gate_fail"
  | "scope_violation"
  | "report_invalid"
  | "worker_error"
  | "quota"
  | "timeout"
  | "stopped";

export interface Attempt {
  readonly n: number;
  readonly kind: AttemptKind;
  readonly prompt: string;
  /** Reviewer feedback that triggered a review_fix attempt. */
  readonly feedback?: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly outcome?: WorkerOutcome;
  readonly usage?: Usage;
  readonly report?: unknown;
  readonly verification?: Verification;
  readonly verdict?: Verdict;
}

export interface Workspace {
  readonly repoRoot: string;
  readonly baseSha: string;
  /** edit mode only. */
  readonly worktree?: string;
  readonly branch?: string;
  readonly artifactsDir: string;
}

export type Decision =
  | { readonly kind: "accepted"; readonly at: string; readonly commit?: string }
  | { readonly kind: "discarded"; readonly at: string; readonly reason?: string };

export interface Job {
  readonly id: string;
  readonly brief: Brief;
  readonly state: JobState;
  readonly workspace: Workspace;
  readonly attempts: readonly Attempt[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decision?: Decision;
  /** Optimistic-concurrency counter, bumped by every store write. */
  readonly version: number;
}
