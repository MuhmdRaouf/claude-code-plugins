import type { BriefError } from "../domain/brief.ts";
import type { EngineTool } from "../domain/engine.ts";
import type { JobState, Verdict } from "../domain/job.ts";
import type { LifecycleError } from "../domain/lifecycle.ts";
import type { Provider } from "../domain/provider.ts";
import type { GitError, StoreError, WorkerError } from "../ports/index.ts";

export type AppError =
  | { readonly kind: "brief"; readonly errors: readonly BriefError[] }
  | { readonly kind: "brief_unreadable"; readonly path: string; readonly message: string }
  | { readonly kind: "missing_env"; readonly names: readonly string[] }
  | {
      readonly kind: "wrong_state";
      readonly id: string;
      readonly state: JobState;
      readonly allowed: readonly JobState[];
    }
  | { readonly kind: "lifecycle"; readonly error: LifecycleError }
  | { readonly kind: "git"; readonly error: GitError }
  | { readonly kind: "store"; readonly error: StoreError }
  | { readonly kind: "worker"; readonly error: WorkerError }
  | { readonly kind: "empty_feedback" }
  /** accept without force on a job whose last verdict is not pass. */
  | { readonly kind: "not_pass"; readonly id: string; readonly verdict: Verdict | null }
  /** accept could not rebase the job branch onto the branch tip; nothing was applied. */
  | { readonly kind: "land_conflict"; readonly paths: readonly string[] }
  /** accept could not verify the exact commit to land in a fresh checkout; nothing was applied. */
  | { readonly kind: "land_verify_failed"; readonly command: string; readonly tail: string }
  /** The job asks for a delegation engine its setup command has not enabled. */
  | { readonly kind: "engine_not_enabled"; readonly engine: EngineTool };

/** One line for a worker that could not start; the key itself never appears. */
export function describeWorkerError(provider: Provider, error: WorkerError): string {
  switch (error.kind) {
    case "no_key":
      return error.message;
    case "insecure_key_file":
      return `${error.label} ${error.path} has mode ${error.mode}: run chmod 600 on it`;
    case "spawn_failed":
      return `cannot start ${provider.workerLabel}: ${error.message}`;
    case "protocol":
      return `${provider.workerLabel} does not speak the expected protocol: ${error.message}`;
    case "unsupported":
      return `${provider.workerLabel} cannot do this: ${error.message}`;
  }
}

/** One line for a git failure. */
export function describeGitError(error: GitError): string {
  switch (error.kind) {
    case "not_a_repo":
      return `not a git repository: ${error.path}`;
    case "bad_ref":
      return `unknown git ref: ${error.ref}`;
    case "conflict":
      return `conflict in ${error.paths.join(", ")}`;
    case "dirty":
      return `uncommitted changes in the way: ${error.paths.join(", ")}`;
    case "git_failed":
      return `${error.command}: ${error.stderr}`;
  }
}
