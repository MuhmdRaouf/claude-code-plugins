/**
 * The worker port: what the core needs from whatever runs the model (headless Claude Code on the provider's endpoint,
 * or a delegation tool: omp or pi over RPC, opencode over its event stream). Everything worker-specific (argv, wire
 * format, session storage, auth) stays behind it.
 */
import type { WorkerTerms } from "../domain/brief.ts";
import type { ReportCheck } from "../domain/job.ts";
import type { ModelRef } from "../domain/model.ts";
import type { Result } from "../domain/result.ts";
import type { WorkerEvent } from "../domain/worker-events.ts";

/** What the worker may do to the workspace: brief mode edit → write, exec → exec, readonly → readonly. */
export type Access = "write" | "exec" | "readonly";

/** The structured report the run must end with. */
export interface ReportContract {
  /** A builtin's name (change, sweep, notes) or the schema file's path. */
  readonly name: string;
  /** Draft-07, for every worker. */
  readonly jsonSchema: Record<string, unknown>;
  /** The core's own check; a worker without native schema enforcement calls it before it accepts a report. */
  readonly validate: (value: unknown) => ReportCheck;
}

export interface WorkerSpec {
  readonly cwd: string;
  readonly model: ModelRef;
  /** One of caps.efforts (checked when the brief is parsed). */
  readonly effort?: string;
  readonly access: Access;
  readonly prompt: string;
  /**
   * The plugin-assigned session key (Attempt.sessionId): a new session under that key, or the one to resume. Each
   * worker maps it to its own storage.
   */
  readonly session: { readonly kind: "new" | "resume"; readonly key: string };
  readonly report: ReportContract;
  readonly addDirs: readonly string[];
  /** Honoured only when caps.budget. */
  readonly budgetUsd?: number;
  /** Extra environment for the worker: values already resolved from the brief's `env` names. */
  readonly passEnv: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** The worker's raw output is appended here (one file per attempt); parseLine reads it back. */
  readonly logPath: string;
}

export interface WorkerExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderrTail: string;
  readonly forced: "timeout" | "stopped" | null;
  /** A resume found no session under its key; the core then starts a new session with a self-contained prompt. */
  readonly sessionMissing: boolean;
}

export interface WorkerRun {
  /** Leader of the worker's process group, killed as a last resort. */
  readonly pid: number;
  readonly events: AsyncIterable<WorkerEvent>;
  readonly exit: Promise<WorkerExit>;
  /** Ask the worker to stop, then kill its process group if it does not; exit reports `forced: reason`. */
  interrupt(reason: "stopped" | "timeout"): Promise<void>;
}

/** What a worker can do, for the core to adapt to; the brief-facing part (efforts, budget) is WorkerTerms. */
export interface WorkerCapabilities extends WorkerTerms {
  /** The engine this adapter runs, one per engine the core knows. */
  readonly name: "claude-headless" | "omp-rpc" | "pi-rpc" | "opencode";
  /** Who owns the session id: "caller" — the plugin assigns it and passes it in; "engine" — the engine assigns it and
   *  the adapter announces it as a `session` event; "none" — no session to resume. */
  readonly sessionKey: "caller" | "engine" | "none";
  /** The worker enforces ReportContract.jsonSchema itself; when false, the report is checked by ReportContract.validate. */
  readonly nativeSchema: boolean;
}

export type WorkerError =
  | { readonly kind: "no_key"; readonly message: string }
  /** `label` names the file in the provider's own terms; the plugin supplies it. */
  | {
      readonly kind: "insecure_key_file";
      readonly label: string;
      readonly path: string;
      readonly mode: string;
    }
  | { readonly kind: "spawn_failed"; readonly message: string }
  /** The worker answered, but not as its protocol says (handshake, version). */
  | { readonly kind: "protocol"; readonly message: string }
  /** The spec asks for something this worker cannot do. */
  | { readonly kind: "unsupported"; readonly message: string };

export interface Worker {
  readonly caps: WorkerCapabilities;
  /** Cheap, offline readiness (binary resolvable, key present). */
  preflight(): Promise<Result<void, WorkerError>>;
  start(spec: WorkerSpec): Promise<Result<WorkerRun, WorkerError>>;
  /** One line of an attempt log → its events (none for a line it cannot read); folds logs for show and the board. */
  parseLine(line: string): readonly WorkerEvent[];
  /** Releases long-lived processes once the driver is done. */
  dispose(): Promise<void>;
}
