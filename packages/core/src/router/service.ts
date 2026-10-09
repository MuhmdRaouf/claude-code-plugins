// The router bundle's entry: `<name>-router run | start | stop | status`. `run` is the front (it forks itself as the
// worker through node:cluster), `start` brings the router up the way setup and the hooks do, `stop` and `status` are
// for people. No service manager: the plugin starts one detached process and its hooks bring it back. Process glue
// only (excluded from coverage); the logic lives in front.ts, worker.ts, process.ts and uninstall.ts, and the chaos
// suite runs this file for real.
import cluster from "node:cluster";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeModelLine } from "../adapters/agent-files.ts";
import { claudeConfigDir, undoProviderSettings } from "../adapters/claude-settings.ts";
import { createFsStore } from "../adapters/fs-store.ts";
import { createGitCli } from "../adapters/git-cli.ts";
import { platformKeyStore } from "../adapters/keystore/index.ts";
import { isAlive } from "../adapters/process/group.ts";
import { processList } from "../adapters/process/processes.ts";
import { type EnvLookup, modelClaim, type Provider, resolveProvider } from "../domain/provider.ts";
import { RETIRED_CHECK_MS, retiredExit } from "../domain/retirement.ts";
import { stateLayout } from "../domain/state-layout.ts";
import { installCrashHandlers, logCrash, rotatingLog } from "./crashlog.ts";
import { createFront, type FrontKnobs, WORKER_TOKEN_ENV } from "./front.ts";
import type { Ledger } from "./ledger.ts";
import {
  bundleVersion,
  clearRetiredRecord,
  registryEntryFor,
  routerBaseUrl,
  routerPort,
  routerStatus,
  startRouter,
  stopRouter,
} from "./process.ts";
import { createPeerLookup, liveRouters, removeRegistryEntry, saveRegistryEntry } from "./registry.ts";
import { createSpoolWriter, SPOOL_VERSION } from "./spool.ts";
import {
  createUninstallWatch,
  type LeftBehind,
  pluginPresence,
  removeRouterFiles,
  writeLeftBehind,
} from "./uninstall.ts";
import { runWorker } from "./worker.ts";

interface RouterServiceOptions {
  /** Whose router this is: port, health path, model ids, strip list and endpoint all come from it. */
  readonly provider: Provider;
  /** The plugin's state root; the router's copies and log live under `<stateRoot>/router`. */
  readonly stateRoot: string;
  /** This bundle: the front forks it as the worker, and `start` copies it (and its passthrough) from its directory. */
  readonly script: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
}

/** The knobs the chaos suite shrinks (`${envPrefix}_ROUTER_TUNING`, JSON); production never sets it. */
interface Tuning extends Partial<FrontKnobs> {
  readonly idleMs?: number;
  readonly frontVersion?: number;
  readonly startWaitMs?: number;
  readonly watchEveryMs?: number;
  readonly retiredEveryMs?: number;
  readonly retiredMaxMs?: number;
}

function tuning(provider: Provider, env: EnvLookup): Tuning {
  try {
    const value: unknown = JSON.parse(env[`${provider.envPrefix}_ROUTER_TUNING`] ?? "{}");
    return typeof value === "object" && value !== null ? (value as Tuning) : {};
  } catch {
    return {};
  }
}

/** Decided jobs' worktrees and branches go; undecided ones are listed in LEFT-BEHIND.md. */
async function cleanupJobs(options: RouterServiceOptions): Promise<void> {
  const { provider, stateRoot } = options;
  const left: LeftBehind[] = [];
  try {
    const git = createGitCli(provider.name);
    for (const job of await createFsStore(stateRoot, isAlive).list()) {
      const { repoRoot, worktree, branch } = job.workspace;
      const decided = job.state === "accepted" || job.state === "discarded";
      if (decided && worktree !== undefined && branch !== undefined)
        await git.removeWorktree(repoRoot, worktree, branch);
      else if (!decided) left.push({ id: job.id, ...(worktree === undefined ? {} : { worktree }) });
    }
    writeLeftBehind(stateRoot, provider.name, left);
  } catch {
    // The state root may already be gone with the plugin's data dir; nothing is left to clean.
  }
}

/** The agents setup changed, back on the models the ledger recorded before it, when their files are still there (a
 *  disabled plugin keeps them; an uninstall has already deleted them). */
function restoreLedgerAgents(ledger: Ledger): string[] {
  const { agents, agentsDir } = ledger;
  if (agents === undefined || agentsDir === undefined) return [];
  return Object.entries(agents).flatMap(([agent, model]) => {
    const written = writeModelLine(join(agentsDir, `${agent}.md`), model);
    return written.ok && written.value ? [`${agent}: ${model ?? "(none)"}`] : [];
  });
}

/** What the uninstall watch does on this machine: settings, registry, the router's own files, decided jobs. */
function uninstallActions(options: RouterServiceOptions, note: (line: string) => void) {
  const { provider, env, stateRoot } = options;
  return {
    presence: (ledger: Ledger) => pluginPresence(provider.name, claudeConfigDir(env), ledger.marker),
    async undo(ledger: Ledger) {
      const live = (await liveRouters(env, provider.name)).map((entry) => `http://127.0.0.1:${entry.port}`);
      const undone = await undoProviderSettings(
        ledger.settingsPath,
        provider.name,
        ledger.settings,
        ledger.routerUrl,
        live,
      );
      note(
        `plugin removed: ${undone.ok ? undone.value.join("; ") || "settings already clean" : undone.error}`,
      );
      const agents = restoreLedgerAgents(ledger);
      if (agents.length > 0) note(`plugin removed: agents restored (${agents.join(", ")})`);
      rmSync(stateLayout(stateRoot).setupDone, { force: true });
    },
    async remove(ledger: Ledger) {
      removeRegistryEntry(env, provider.name);
      // The OS keystore item goes only when this plugin's setup put it there.
      if (ledger.keystore.created)
        await platformKeyStore(provider, env)
          ?.remove()
          .catch(() => undefined);
      await cleanupJobs(options);
      removeRouterFiles(stateRoot);
    },
  };
}

async function run(options: RouterServiceOptions): Promise<number> {
  const { provider, env, stateRoot } = options;
  const port = routerPort(provider, env);
  const version = bundleVersion(readFileSync(options.script));
  const log = rotatingLog(stateLayout(stateRoot).routerLog);
  const note = (line: string): void => {
    log(line);
    logCrash(stateRoot, { role: "front", version, event: line });
  };
  installCrashHandlers("front", stateRoot, version);
  const knobs = tuning(provider, env);
  const events = createSpoolWriter(env, log);
  let reason: "handover" | "stop" | "uninstall" = "handover";
  const front = createFront({
    name: provider.name,
    display: provider.display,
    healthPath: provider.router.healthPath,
    claim: modelClaim(resolveProvider(provider, env)),
    port,
    listenPort: Number(env[`${provider.envPrefix}_ROUTER_LISTEN_PORT`]) || port,
    anthropic: new URL(env[`${provider.envPrefix}_ROUTER_ANTHROPIC_URL`] ?? "https://api.anthropic.com"),
    env,
    version,
    token: env[`${provider.envPrefix}_ROUTER_TOKEN`] ?? randomBytes(16).toString("hex"),
    exec: options.script,
    knobs,
    ...(knobs.idleMs === undefined ? {} : { idleMs: knobs.idleMs }),
    ...(knobs.frontVersion === undefined ? {} : { frontVersion: knobs.frontVersion }),
    watch: createUninstallWatch({
      stateRoot,
      actions: {
        ...uninstallActions(options, note),
        async remove(ledger: Ledger) {
          reason = "uninstall";
          await uninstallActions(options, note).remove(ledger);
        },
      },
      ...(knobs.watchEveryMs === undefined ? {} : { everyMs: knobs.watchEveryMs }),
    }),
    peers: createPeerLookup(env, provider.name),
    retiredWatch: {
      everyMs: knobs.retiredEveryMs ?? RETIRED_CHECK_MS,
      exit: async (retiredAt) =>
        retiredExit({
          retiredAt,
          now: Date.now(),
          processes: await processList(),
          ...(knobs.retiredMaxMs === undefined ? {} : { maxMs: knobs.retiredMaxMs }),
        }) === "exit",
    },
    onRetire: () => removeRegistryEntry(env, provider.name),
    note,
    log,
    events,
    done: () => {
      if (front.status().mode === "retired") {
        // A retired front already wrote its one spool line, and its registry entry is gone.
        clearRetiredRecord(stateRoot, process.pid);
        process.exit(0);
      }
      events({
        ts: new Date().toISOString(),
        event: "router",
        plugin: provider.name,
        port,
        state: "stop",
        version: SPOOL_VERSION,
      });
      if (reason === "stop") removeRegistryEntry(env, provider.name);
      process.exit(0);
    },
  });
  try {
    await front.start();
  } catch (error) {
    note(`cannot listen: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  // Announce ourselves to the other plugins' routers once listening, so nobody forwards to a closed port.
  await saveRegistryEntry(env, registryEntryFor(provider, env, process.pid)).catch(() => undefined);
  events({
    ts: new Date().toISOString(),
    event: "router",
    plugin: provider.name,
    port,
    state: "start",
    version: SPOOL_VERSION,
  });
  log(`${provider.name}-router listening on ${routerBaseUrl(provider, env)} (version ${version})`);
  const stop = (): void => {
    reason = "stop";
    front.drain();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return new Promise(() => {});
}

function workerOf(options: RouterServiceOptions): Promise<number> {
  const { provider, env, stateRoot } = options;
  const knobs = tuning(provider, env);
  runWorker({
    provider,
    env,
    stateRoot,
    version: bundleVersion(readFileSync(options.script)),
    logFile: stateLayout(stateRoot).routerLog,
    // The front's token, handed over at fork: the worker's data path requires it.
    ...(env[WORKER_TOKEN_ENV] === undefined ? {} : { token: env[WORKER_TOKEN_ENV] }),
    ...(knobs.heartbeatMs === undefined ? {} : { heartbeatMs: knobs.heartbeatMs }),
    ...(knobs.idleMs === undefined ? {} : { idleMs: knobs.idleMs }),
  });
  return new Promise(() => {});
}

/** Runs one router command; the returned number is the process exit code. */
export async function routerService(options: RouterServiceOptions): Promise<number> {
  if (cluster.isWorker) return workerOf(options);
  const { provider, env, stateRoot } = options;
  const commands: Record<string, () => Promise<number>> = {
    run: () => run(options),
    worker: () => workerOf(options),
    start: async () => {
      const result = await startRouter({
        provider,
        env,
        stateRoot,
        distDir: dirname(options.script),
        say: (line) => console.log(line),
        ...(tuning(provider, env).startWaitMs === undefined
          ? {}
          : { healthWaitMs: tuning(provider, env).startWaitMs }),
      });
      console.log(`${provider.name}-router ${result.ok ? result.value : `start failed: ${result.error}`}`);
      return result.ok ? 0 : 1;
    },
    stop: async () => {
      const result = stopRouter({ provider, env, stateRoot });
      console.log(`${provider.name}-router ${result.ok ? result.value : result.error}`);
      return 0;
    },
    status: async () => {
      const { up, line } = await routerStatus(provider, env);
      console.log(line);
      return up ? 0 : 1;
    },
  };
  const command = commands[options.argv[2] ?? ""];
  if (command === undefined) {
    console.error(`usage: ${provider.name}-router run | start | stop | status`);
    return 2;
  }
  return command();
}
