// The composition every plugin's cli/main.ts is: real adapters over the provider's state root, handed to runCli.
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ClaudeHeadlessWorker } from "../adapters/claude-headless.ts";
import { createFsEngineConfig } from "../adapters/fs-engine-config.ts";
import { createFsJobFiles } from "../adapters/fs-job-files.ts";
import { createFsLimiter } from "../adapters/fs-limiter.ts";
import { createFsSemaphore } from "../adapters/fs-semaphore.ts";
import { createFsStore } from "../adapters/fs-store.ts";
import { createGitCli } from "../adapters/git-cli.ts";
import { keySource, loadKey } from "../adapters/key.ts";
import { isAlive } from "../adapters/process/group.ts";
import { toolVersion } from "../adapters/process/tool.ts";
import { runtimeLabel } from "../adapters/runtime.ts";
import { createShellGates } from "../adapters/shell-gates.ts";
import { stateRoot } from "../adapters/state-root.ts";
import { createIds, createProcessControl, createSystemClock } from "../adapters/system.ts";
import type { Deps, SetupCheck } from "../app/deps.ts";
import { describeWorkerError } from "../app/errors.ts";
import { createKeyEntry } from "../auth-page/entry.ts";
import { DEFAULT_LIMITER } from "../domain/limiter.ts";
import { DEFAULT_LIMITS } from "../domain/prompt.ts";
import { type Provider, resolveProvider } from "../domain/provider.ts";
import { err, type Result } from "../domain/result.ts";
import { stateLayout } from "../domain/state-layout.ts";
import type { Output, WorkerError } from "../ports/index.ts";
import { routerKeyCheck, startRouter, stopRouter } from "../router/process.ts";
import { createSpoolReader } from "../router/spool.ts";
import { engineWorkers } from "./engine-wire.ts";

const STOP_GRACE_MS = 10_000;
const PRIVATE = 0o700;

interface WireOptions {
  readonly provider: Provider;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** This bundle (or src/cli/main.ts), re-run detached as `drive <id>`. */
  readonly bundlePath: string;
  readonly out: Output;
}

function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: PRIVATE });
  chmodSync(path, PRIVATE);
  return path;
}

/** Real adapters over the provider's state root (and its claude-home config dir), both created mode 0700. */
export function wire(options: WireOptions): Deps {
  const { provider, env } = options;
  const root = privateDir(stateRoot(provider, env));
  const configDir = privateDir(stateLayout(root).claudeHome);
  const bin = env[`${provider.envPrefix}_CLAUDE_BIN`] || "claude";
  const key = () => loadKey(provider, env);
  const clock = createSystemClock();
  const store = createFsStore(root, isAlive);
  const config = { limiter: DEFAULT_LIMITER, prompt: DEFAULT_LIMITS, stopGraceMs: STOP_GRACE_MS };
  const limiter = createFsLimiter(root, config.limiter);
  // Env overrides (model ids, endpoint, region) reach the jobs, as they reach the router: the catalog the app and the
  // worker read is the resolved one, while names, labels and the key loader stay the shipped provider's.
  const resolved = resolveProvider(provider, env);
  return {
    worker: new ClaudeHeadlessWorker({
      provider: resolved,
      bin,
      configDir,
      loadKey: key,
      parentEnv: env,
      stopGraceMs: STOP_GRACE_MS,
    }),
    engines: engineWorkers({ provider: resolved, env, stopGraceMs: STOP_GRACE_MS }),
    git: createGitCli(provider.name),
    gates: createShellGates(provider.name),
    store,
    files: createFsJobFiles(root),
    engineConfig: createFsEngineConfig(root),
    spool: createSpoolReader(env),
    semaphore: createFsSemaphore(root, () => limiter.capacity(clock.now()), isAlive, clock.sleep, clock.now),
    limiter,
    clock,
    ids: createIds(),
    process: createProcessControl(options.bundlePath, (id) => store.paths(id).driverLog),
    out: options.out,
    host: {
      stateRoot: root,
      workerBin: bin,
      runtime: runtimeLabel(),
      workerVersion: () => toolVersion(bin),
      loadKey: key,
      ensureRouter: () =>
        startRouter({
          provider,
          env,
          stateRoot: root,
          // The router bundles the start copies into the state root sit beside this CLI bundle.
          distDir: dirname(options.bundlePath),
          budgetMs: 4000,
          say: (line) => options.out.line(line),
        }),
      stopRouter: async () => stopRouter({ provider, env, stateRoot: root }),
      routerKey: () => routerKeyCheck(provider, env, root),
      extraChecks: async () => [keyCheck(provider, keySource(await key()))],
      keyEntry: createKeyEntry({ provider: resolved, env, bundlePath: options.bundlePath }),
    },
    bundlePath: options.bundlePath,
    provider: resolved,
    env,
    config,
  };
}

/** The `key` setup line: where the provider's key comes from (an env name or the key file path), never the key itself. */
export function keyCheck(provider: Provider, source: Result<string, WorkerError>): SetupCheck {
  if (source.ok) return { label: "key", result: source, text: `present (${source.value})` };
  const error = describeWorkerError(provider, source.error);
  return { label: "key", result: err(error), text: `MISSING: ${error}` };
}
