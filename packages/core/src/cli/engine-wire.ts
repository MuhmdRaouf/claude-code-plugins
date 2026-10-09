// The delegation engines as Workers: the plugin
// does not own omp, opencode or pi. Each runs exactly as the user set it up — its own login, provider, default model
// and config — with the user's own environment, minus what belongs to this plugin's provider (its key variables and
// every `<PREFIX>_` knob) and Claude Code's routing. The adapters only bridge: the job's worktree as the cwd, the brief
// as the prompt, the events translated, the access narrowed, the deadline kept and the process group reaped.
import { OmpRpcWorker } from "../adapters/engines/omp-rpc/worker.ts";
import { OpenCodeWorker } from "../adapters/engines/opencode/worker.ts";
import { PiRpcWorker } from "../adapters/engines/pi-rpc/worker.ts";
import { clearEnginePid, writeEnginePid } from "../adapters/fs-job-files.ts";
import type { EngineWorkers } from "../app/deps.ts";
import type { EngineTool } from "../domain/engine.ts";
import type { EnvLookup, Provider } from "../domain/provider.ts";
import type { Result } from "../domain/result.ts";
import { enginePidBeside } from "../domain/state-layout.ts";
import type { Worker, WorkerError, WorkerRun, WorkerSpec } from "../ports/index.ts";

/** omp and pi answer the RPC handshake within seconds; a cold first start (omp's "Still starting after 10s") gets
 *  a minute before the attempt counts as an infrastructure failure. */
const HANDSHAKE_TIMEOUT_MS = 60_000;

interface EngineWireOptions {
  /** The provider: only its names, to withhold its variables from the tools and name the bin overrides. */
  readonly provider: Provider;
  readonly env: EnvLookup;
  readonly stopGraceMs: number;
}

/** The variable naming a tool's binary, for tests and unusual installs: `${envPrefix}_OMP_BIN` and so on. */
function engineBinEnv(provider: Provider, tool: EngineTool): string {
  return `${provider.envPrefix}_${tool.toUpperCase()}_BIN`;
}

/** Whether a variable is this plugin's provider's own (its key variables, its `<PREFIX>_` knobs): never a tool's. */
function providerVar(provider: Provider): (name: string) => boolean {
  const keys = new Set(provider.keyEnv);
  return (name) => keys.has(name) || name.startsWith(`${provider.envPrefix}_`);
}

export function engineWorkers(options: EngineWireOptions): EngineWorkers {
  const { provider, env } = options;
  const bin = (tool: EngineTool): string => env[engineBinEnv(provider, tool)] || tool;
  return {
    bin,
    worker: (tool) => tracked(build(tool, bin(tool), options)),
  };
}

function build(tool: EngineTool, bin: string, options: EngineWireOptions): Worker {
  const common = {
    bin,
    parentEnv: options.env,
    withheld: providerVar(options.provider),
    stopGraceMs: options.stopGraceMs,
  };
  switch (tool) {
    case "omp":
      return new OmpRpcWorker({ ...common, handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS });
    case "pi":
      return new PiRpcWorker({ ...common, handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS });
    case "opencode":
      return new OpenCodeWorker(common);
  }
}

/**
 * The engine as the core sees it: its process group recorded beside the attempt log while it runs, so a stop or discard
 * after the driver died can still terminate it.
 */
function tracked(inner: Worker): Worker {
  return {
    caps: inner.caps,
    preflight: () => inner.preflight(),
    parseLine: (line) => inner.parseLine(line),
    dispose: () => inner.dispose(),
    async start(spec: WorkerSpec): Promise<Result<WorkerRun, WorkerError>> {
      const started = await inner.start(spec);
      if (!started.ok) return started;
      const file = enginePidBeside(spec.logPath);
      writeEnginePid(file, started.value.pid);
      const forget = (): void => clearEnginePid(file);
      void started.value.exit.then(forget, forget);
      return started;
    },
  };
}
