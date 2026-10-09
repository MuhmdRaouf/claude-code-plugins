/**
 * Process-level wiring for the foreground server: create the store, start the watcher (which does one
 * synchronous ingest pass before anything listens), bind loopback with port retry, publish server.json
 * (0600 — the child writes it itself so the parent never races a bind it does not own), own shutdown,
 * and watch for the plugin's own removal (lifecycle/removal.ts) — this process outlives its plugin.
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import type { Server } from "node:http";
import { type History, openHistory } from "../history/history.ts";
import { schedulePrunes } from "../history/retention.ts";
import { attachHistoryWriter, type HistoryWriter } from "../history/writer.ts";
import { startWatcher, type Watcher } from "../ingest/watch.ts";
import { removalIntervalMs, removeStateTree, watchRemoval } from "../lifecycle/removal.ts";
import { ensureStateDirs, historyPath, savedPort, savePort, serverInfoPath } from "../shared/paths.ts";
import { createStore, type Store } from "../store/store.ts";
import { createHttpServer } from "./http.ts";
import { createInsights, type Insights } from "./insights.ts";
import { type ListenResult, listenLocal, type RandomSource } from "./port.ts";

/** How long shutdown waits for requests it already took before it cuts the connections. */
const DRAIN_MS = 30_000;

export type ServerInfo = { pid: number; port: number; url: string; startedAt: number };

export function writeServerInfo(env: NodeJS.ProcessEnv, info: ServerInfo): boolean {
  const path = serverInfoPath(env);
  // a first-ever start has no state dir yet; openSync would ENOENT and the parent would wait out its poll
  ensureStateDirs(env);
  try {
    const fd = openSync(path, "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(info)}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

export function readServerInfo(env: NodeJS.ProcessEnv): ServerInfo | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(serverInfoPath(env), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.pid !== "number" || typeof record.port !== "number") return null;
    return {
      pid: record.pid,
      port: record.port,
      url: typeof record.url === "string" ? record.url : `http://127.0.0.1:${record.port}`,
      startedAt: typeof record.startedAt === "number" ? record.startedAt : 0,
    };
  } catch {
    return null;
  }
}

export function removeServerInfo(env: NodeJS.ProcessEnv): void {
  try {
    unlinkSync(serverInfoPath(env));
  } catch {
    // nothing to remove is the common case after a crash
  }
}

export type AppOptions = {
  env: NodeJS.ProcessEnv;
  version: string;
  sinceMs: number;
  port?: number;
  random?: RandomSource;
  intervalMs?: number;
  /** Removal-check interval; defaults to `RADAR_REMOVAL_MS`, then 10 s (tests shorten it). */
  removalIntervalMs?: number;
  /** How the process ends when the server removes itself; tests observe instead of exiting. */
  exit?: (code: number) => void;
  /** How a desktop notification is shown; tests capture instead of notifying. */
  notifyRunner?: (command: string, args: string[]) => void;
  /** Insights tick (ledger flush, budget status, notifications); defaults to 10 s. */
  insightsTickMs?: number;
};

export type App = {
  server: Server;
  store: Store;
  watcher: Watcher;
  insights: Insights;
  /** The store's persistent counterpart; null when the history file could not be opened. */
  writer: HistoryWriter | null;
  port: number;
  url: string;
  /** The saved port this start could not have (another program held it), when it moved. */
  movedFrom?: number;
  stop(): Promise<void>;
};

/**
 * Bind loopback. No --port: the port the dashboard had last time, so a bookmark survives a stop or a
 * reboot; a new random one only when another program holds it now (movedFrom says which it was).
 */
async function bindSticky(
  server: Server,
  options: AppOptions,
): Promise<{ bound: ListenResult; movedFrom?: number }> {
  const listenOptions: { port?: number; random?: RandomSource } = {};
  if (options.port !== undefined) listenOptions.port = options.port;
  if (options.random !== undefined) listenOptions.random = options.random;
  const saved = options.port === undefined ? savedPort(options.env) : null;
  if (saved === null) return { bound: await listenLocal(server, listenOptions) };
  const first = await listenLocal(server, { port: saved });
  if (first.ok) return { bound: first };
  const code = (first.error as NodeJS.ErrnoException).code;
  if (code !== "EADDRINUSE" && code !== "EACCES") return { bound: first };
  return { bound: await listenLocal(server, listenOptions), movedFrom: saved };
}

/** Bind and serve; resolves once listening. The pid in server.json is this process. */
export async function startApp(options: AppOptions): Promise<App> {
  const store = createStore();
  // the writer must exist before the watcher's first pass: everything ingest sees, history sees too
  let writer: HistoryWriter | null = null;
  let history: History | null = null;
  try {
    history = await openHistory(historyPath(options.env));
    writer = attachHistoryWriter({ store, history });
  } catch (e) {
    console.error(
      `radar: history unavailable, running without it (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const prunes = history === null ? null : schedulePrunes(history, options.env);
  const watcherOptions: { env: NodeJS.ProcessEnv; store: Store; sinceMs: number; intervalMs?: number } = {
    env: options.env,
    store,
    sinceMs: options.sinceMs,
  };
  if (options.intervalMs !== undefined) watcherOptions.intervalMs = options.intervalMs;
  const watcher = startWatcher(watcherOptions);
  const insights = createInsights({
    env: options.env,
    store,
    ...(options.notifyRunner === undefined ? {} : { runner: options.notifyRunner }),
    ...(options.insightsTickMs === undefined ? {} : { tickMs: options.insightsTickMs }),
  });
  const startedAt = Date.now();
  const { server, state, whenIdle, closeStreams } = createHttpServer({
    store,
    version: options.version,
    startedAt,
    insights,
    history,
    watcher,
  });
  const { bound, movedFrom } = await bindSticky(server, options);
  if (!bound.ok) {
    watcher.stop();
    insights.stop();
    prunes?.stop();
    writer?.stop();
    throw bound.error;
  }
  state.port = bound.port;
  const url = `http://127.0.0.1:${bound.port}`;
  writeServerInfo(options.env, { pid: process.pid, port: bound.port, url, startedAt });
  savePort(options.env, bound.port);

  // Two agreeing checks that the plugin is gone stop the server: uninstalled takes the state dir
  // with it, disabled keeps it for the reinstall. Either way the requests already taken finish.
  const exit = options.exit ?? process.exit;
  const removal = watchRemoval({
    env: options.env,
    plugin: "radar",
    projectDirs: () => projectDirsOf(store),
    intervalMs: removalIntervalMs(options.env, options.removalIntervalMs),
    onRemove: (kind) =>
      stop().then(() => {
        if (kind === "uninstalled") removeStateTree(options.env);
        exit(0);
      }),
  });

  const stop = async (): Promise<void> => {
    watcher.stop();
    removal.stop();
    insights.stop();
    prunes?.stop();
    writer?.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve()); // no new connections from here on
      void whenIdle(DRAIN_MS).then(() => {
        closeStreams(); // streams first: under bun closeAllConnections() alone leaves them open
        server.closeAllConnections(); // then the idle keep-alives
      });
    });
    removeServerInfo(options.env);
  };

  process.on("SIGTERM", () => {
    void stop().finally(() => process.exit(0));
  });

  return {
    server,
    store,
    watcher,
    insights,
    writer,
    port: bound.port,
    url,
    stop,
    ...(movedFrom !== undefined ? { movedFrom } : {}),
  };
}

/** The projects this server has tracked sessions in — their settings can re-enable the plugin. */
function projectDirsOf(store: Store): string[] {
  const cwds = new Set<string>();
  for (const session of store.sessionList()) {
    if (session.cwd !== null) cwds.add(session.cwd);
  }
  return [...cwds];
}
