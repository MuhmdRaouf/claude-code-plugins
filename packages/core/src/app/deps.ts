import type { EngineTool } from "../domain/engine.ts";
import type { LimiterConfig } from "../domain/limiter.ts";
import type { PromptLimits } from "../domain/prompt.ts";
import type { Provider } from "../domain/provider.ts";
import type { Result } from "../domain/result.ts";
import type {
  Clock,
  EngineConfigStore,
  GateRunner,
  Git,
  Ids,
  JobFiles,
  JobStore,
  LimiterStore,
  Output,
  ProcessControl,
  RouteSpool,
  Semaphore,
  Worker,
  WorkerError,
} from "../ports/index.ts";
import type { KeyEntry, ProviderKey } from "../ports/keys.ts";

/** One `setup` line of the plugin's own (e.g. where the key comes from); setup is not ready while one fails. */
export interface SetupCheck {
  /** The line's label and its key in `setup --json`. */
  readonly label: string;
  /** What `setup --json` reports. */
  readonly result: Result<string, string>;
  /** The line's text after the label. */
  readonly text: string;
}

/** Facts about the host that only `setup` and `brief new` need. */
export interface HostInfo {
  /** Absolute state root (jobs, worktrees, slots, briefs). */
  readonly stateRoot: string;
  /** The binary that runs the model, as configured. */
  readonly workerBin: string;
  /** The runtime this CLI runs on (bun by default, node as the fallback), e.g. `bun 1.3.14 (/usr/local/bin/bun)`. */
  readonly runtime: string;
  workerVersion(): Promise<Result<string, string>>;
  extraChecks(): Promise<readonly SetupCheck[]>;
  /** The provider key loader; the setup wiring checks it (only its source is ever printed). */
  loadKey(): Promise<Result<ProviderKey, WorkerError>>;
  /** Starts this plugin's own router when it is down (a detached process the hooks keep alive); ok says where it runs. */
  ensureRouter(): Promise<Result<string, string>>;
  /** Stops the router process; ok carries the one-line outcome. */
  stopRouter(): Promise<Result<string, string>>;
  /** Setup's way to get a key in without the chat (the OS store and the one-time page); absent: setup only reports. */
  readonly keyEntry?: KeyEntry;
  /** Whether the running router can read the provider key itself (its source, never the key). */
  routerKey(): Promise<Result<string, string>>;
}

/** The delegation engines' workers, built from the provider: each tool runs as the user set it up, the plugin only bridges a job to it. */
export interface EngineWorkers {
  /** The tool's worker: the tool as the user set it up, bridged to a job. */
  worker(tool: EngineTool): Worker;
  /** The tool's binary as configured: an override path, or the name looked up on PATH. */
  bin(tool: EngineTool): string;
}

/** Everything a use case may touch. Built once in cli/main.ts from adapters; tests build it from test/support fakes. */
export interface Deps {
  /** The claude engine's worker; a job on another engine runs on `engines.worker(tool)` instead. */
  readonly worker: Worker;
  /** omp, opencode and pi; absent where only claude runs. */
  readonly engines?: EngineWorkers;
  readonly git: Git;
  readonly gates: GateRunner;
  readonly store: JobStore;
  /** The files beside each job's record, and the ones a job names. */
  readonly files: JobFiles;
  /** Which delegation engines setup enabled. */
  readonly engineConfig: EngineConfigStore;
  /** What the routers served, for the board and the usage windows. */
  readonly spool: RouteSpool;
  readonly semaphore: Semaphore;
  readonly limiter: LimiterStore;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly process: ProcessControl;
  readonly out: Output;
  readonly host: HostInfo;
  /** This plugin's CLI bundle: the detached driver re-runs it, and the router copy and the agents sit beside it. */
  readonly bundlePath: string;
  /** Every name the plugin shows its users. */
  readonly provider: Provider;
  /** The orchestrator's environment, read only for brief `env` names. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly config: {
    readonly limiter: LimiterConfig;
    readonly prompt: PromptLimits;
    readonly stopGraceMs: number;
  };
}
