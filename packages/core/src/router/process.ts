// Starting, updating and stopping the router as one plain background process the plugin owns: the same code on macOS,
// Linux and Windows, no service manager. `startRouter` is what setup, the SessionStart hook and the per-prompt
// `ensure` run. In order: retire a legacy OS service (only once the new router answers on the same port); probe the
// port, and never touch what someone else owns; take an atomic lock so concurrent hooks start exactly one router;
// copy the bundles into the state root so a plugin update or uninstall never deletes the running code; spawn it
// detached and wait for its health; fall back to the emergency passthrough when it will not start. A running router
// of an older version gets a hot update (its worker is re-pointed, the port never closes); one with another front
// protocol, the emergency passthrough, or a retired router, is handed over to a fresh front. When nothing of ours can
// hold the port, the base URL guard takes this router out of Claude Code's settings so the next session talks to
// Anthropic directly. `retireRouter` is what setup --remove runs: the router keeps serving the sessions already open.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeSettingsPath, clearBaseUrl, readBaseUrl } from "../adapters/claude-settings.ts";
import { writeFileAtomicSync } from "../adapters/fs-files.ts";
import { createExclusive } from "../adapters/fs-lock.ts";
import type { Detached } from "../adapters/process/detached.ts";
import { startDetached } from "../adapters/process/detached.ts";
import { portAnswers } from "../adapters/process/port.ts";
import { runToolSync, succeeded } from "../adapters/process/tool.ts";
import { isPluginRouterUrl, portOf } from "../domain/plugin-routers.ts";
import {
  type EnvLookup,
  modelClaim,
  type Provider,
  resolveProvider,
  routerEnvName,
} from "../domain/provider.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { stateLayout } from "../domain/state-layout.ts";
import { FRONT_VERSION, NO_WORKER, TOKEN_HEADER } from "./front.ts";
import { type CommandRunner, findLegacyService, migrateLegacyService } from "./legacy.ts";
import {
  type PidRecord,
  readPidFile,
  readRetiredFile,
  removePidFile,
  removeRetiredFile,
  retirePidFile,
  writePidFile,
} from "./pidfile.ts";
import { liveRouters, type RegisteredRouter, readRegistry, removeRegistryEntry } from "./registry.ts";
import { exemptLoopback } from "./upstream.ts";

// ── where the router lives ──────────────────────────────────────────────────────────────────────────────────────────

/** The port the router takes: `${envPrefix}_ROUTER_PORT`, else the provider's router port. */
export function routerPort(provider: Provider, env: EnvLookup): number {
  return Number(env[routerEnvName(provider, "PORT")]) || provider.router.port;
}

/** The router's base URL, the one ANTHROPIC_BASE_URL must point at. */
export function routerBaseUrl(provider: Provider, env: EnvLookup): string {
  return `http://127.0.0.1:${routerPort(provider, env)}`;
}

/** This plugin's registry entry: its resolved catalog ids (env overrides included) and the pid when it is known. */
export function registryEntryFor(provider: Provider, env: EnvLookup, pid?: number): RegisteredRouter {
  const claim = modelClaim(resolveProvider(provider, env));
  return {
    name: provider.name,
    port: routerPort(provider, env),
    modelPrefixes: claim.prefixes,
    catalogIds: claim.ids,
    ...(pid === undefined ? {} : { pid }),
    updatedAt: new Date().toISOString(),
  };
}

/** A bundle's version: the first 12 hex digits of its SHA-256, so any change to the code is a new version. */
export function bundleVersion(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** The bundle names: `<name>-router.js` (front and worker) and `<name>-passthrough.js` (emergency). */
function bundleNames(name: string): { readonly router: string; readonly passthrough: string } {
  return { router: `${name}-router.js`, passthrough: `${name}-passthrough.js` };
}

/** `<state>/router/package.json`: the copied bundles are ESM, and Node must load them as such whatever package.json sits
 *  above the state root (the plugin's own dist/package.json does the same for the bundles it ships). */
export const ROUTER_PACKAGE_JSON = `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`;

/** The stable copies under `<state>/router`. */
interface RouterFiles {
  readonly dir: string;
  readonly router: string;
  readonly passthrough: string;
  readonly version: string;
}

/** Copies the plugin's bundles into `<state>/router` (0700) when they differ, by temp file and rename, so a plugin
 *  update or uninstall that deletes the plugin cache never deletes the running router's code and a running process
 *  never reads a half-written file. */
export function copyRouterFiles(
  distDir: string,
  stateRoot: string,
  name: string,
): Result<RouterFiles, string> {
  const dir = stateLayout(stateRoot).routerDir;
  const names = bundleNames(name);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of [names.router, names.passthrough]) {
      const from = join(distDir, file);
      const to = join(dir, file);
      const fresh = readFileSync(from);
      let same = false;
      try {
        same = readFileSync(to).equals(fresh);
      } catch {
        same = false;
      }
      if (same) continue;
      writeFileAtomicSync(to, fresh, { mode: statSync(from).mode & 0o777 });
    }
    const manifest = join(dir, "package.json");
    if (readTextOr(manifest) !== ROUTER_PACKAGE_JSON) writeFileAtomicSync(manifest, ROUTER_PACKAGE_JSON);
    return ok({
      dir,
      router: join(dir, names.router),
      passthrough: join(dir, names.passthrough),
      version: bundleVersion(readFileSync(join(dir, names.router))),
    });
  } catch (error) {
    return err(
      `copying the router into ${dir} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** A file's text, or undefined when it cannot be read. */
function readTextOr(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// ── probing the port ────────────────────────────────────────────────────────────────────────────────────────────────

/** What a health answer of ours carries. */
interface RouterHealth {
  readonly ok: true;
  readonly name: string;
  readonly provider: string;
  readonly mode?: string;
  readonly version?: string;
  readonly frontVersion?: number;
  readonly pid?: number;
}

/** none: nothing listens; ours: our health answered (name and provider match); foreign: something else holds the
 *  port; silent: something accepts connections but its health never answered. */
type Probe =
  | { readonly state: "none" }
  | { readonly state: "ours"; readonly health: RouterHealth }
  | { readonly state: "foreign" }
  | { readonly state: "silent" };

/** Parses a health body; ours only when it carries our name and provider. */
export function ourHealth(body: string, name: string, display: string): RouterHealth | undefined {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    return record.ok === true && record.name === name && record.provider === display
      ? (value as RouterHealth)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Probes the router port: a 200 ms connect, then the health path (1 s), whose body must name us. */
export async function probeRouter(
  port: number,
  provider: Pick<Provider, "name" | "display" | "router">,
  connectMs = 200,
): Promise<Probe> {
  if (!(await portAnswers(port, connectMs))) return { state: "none" };
  try {
    const answer = await fetch(`http://127.0.0.1:${port}${provider.router.healthPath}`, {
      signal: AbortSignal.timeout(1000),
    });
    const health = answer.ok ? ourHealth(await answer.text(), provider.name, provider.display) : undefined;
    return health === undefined ? { state: "foreign" } : { state: "ours", health };
  } catch (error) {
    return (error as Error).name === "TimeoutError" ? { state: "silent" } : { state: "foreign" };
  }
}

// ── spawning ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type SpawnDetached = (
  node: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  logFile: string,
) => Detached;

/** `node <args>` detached from the caller, its output in the router log. */
const spawnDetached: SpawnDetached = (node, args, env, logFile) =>
  startDetached(node, args, { env, logFile });

/** The environment the router runs with: what it needs to find its state, its key and the network (the caller's
 *  proxy and certificate settings, in any case), and nothing else. */
export function childEnv(
  provider: Provider,
  env: EnvLookup,
  stateRoot: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const exact = new Set([
    "HOME",
    "USERPROFILE",
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "APPDATA",
    "LOCALAPPDATA",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_USE_ENV_PROXY",
    "CLAUDE_CONFIG_DIR",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "RADAR_HOME",
    "PROVIDER_ROUTERS_HOME",
    ...provider.keyEnv,
  ]);
  const proxies = new Set(["https_proxy", "http_proxy", "no_proxy"]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (exact.has(key) || proxies.has(key.toLowerCase()) || key.startsWith(`${provider.envPrefix}_`))
      out[key] = value;
  }
  out[routerEnvName(provider, "PORT")] = String(routerPort(provider, env));
  out[`${provider.envPrefix}_STATE_DIR`] = stateRoot;
  return exemptLoopback({ ...out, ...extra });
}

// ── the starter ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface StartOptions {
  readonly provider: Provider;
  readonly env: EnvLookup;
  readonly stateRoot: string;
  /** The plugin's dist dir: `<name>-router.js` and `<name>-passthrough.js` are copied from here. */
  readonly distDir: string;
  readonly node?: string;
  readonly spawn?: SpawnDetached;
  /** The legacy migration's command runner; tests record calls instead. */
  readonly run?: CommandRunner;
  readonly uid?: number;
  /** The whole start's budget (the SessionStart hook passes 4 s). */
  readonly budgetMs?: number;
  /** How long a fresh router gets to answer health before the emergency passthrough takes over (default 3 s). */
  readonly healthWaitMs?: number;
  /** Whether a port accepts connections (the guard's check on another plugin's router); tests pin it. */
  readonly answers?: (port: number) => Promise<boolean>;
  /** One line each for what the guard did. */
  readonly say?: (line: string) => void;
}

const LOCK_STALE_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const defaultRun: CommandRunner = (bin, args) => succeeded(runToolSync(bin, args, { timeoutMs: 10_000 }));

interface Ctx {
  readonly o: StartOptions;
  readonly port: number;
  readonly url: string;
  readonly deadline: number;
  readonly spawn: SpawnDetached;
  readonly node: string;
}

/** Waits for our health on the port until the deadline, giving up early when the child exits. */
async function waitOurs(
  ctx: Ctx,
  port: number,
  child: Detached | undefined,
  until: number,
): Promise<RouterHealth | undefined> {
  for (;;) {
    const probe = await probeRouter(port, ctx.o.provider, 100);
    if (probe.state === "ours") return probe.health;
    if (child?.exited() === true || Date.now() >= until) return undefined;
    await sleep(50);
  }
}

/** The router up on this plugin's port, one way or another; ok says how. */
export async function startRouter(o: StartOptions): Promise<Result<string, string>> {
  const port = routerPort(o.provider, o.env);
  const ctx: Ctx = {
    o,
    port,
    url: routerBaseUrl(o.provider, o.env),
    deadline: Date.now() + (o.budgetMs ?? 8000),
    spawn: o.spawn ?? spawnDetached,
    node: o.node ?? process.execPath,
  };
  let result: Result<string, string>;
  try {
    result = await bringUp(ctx);
  } catch (error) {
    result = err(error instanceof Error ? error.message : String(error));
  }
  await guardBaseUrl(o, result.ok);
  return result;
}

async function bringUp(ctx: Ctx): Promise<Result<string, string>> {
  const { o } = ctx;
  const legacy = findLegacyService(o.provider.router.label, o.env.HOME ?? homedir());
  if (legacy !== undefined) {
    let started: Result<string, string> = err("not started");
    const migrated = await migrateLegacyService(
      legacy,
      o.run ?? defaultRun,
      async () => {
        started = await startFresh(ctx);
        return started.ok;
      },
      o.uid ?? process.getuid?.() ?? 0,
    );
    return started.ok ? ok(`${started.value}; ${migrated.line}`) : err(migrated.line);
  }
  const probe = await probeRouter(ctx.port, o.provider);
  if (probe.state === "foreign")
    return err(
      `port ${ctx.port} is held by another program; it was left alone and Claude Code no longer uses it`,
    );
  if (probe.state === "silent") return replaceSilent(ctx);
  if (probe.state === "none") return startFresh(ctx);
  return update(ctx, probe.health);
}

/** Something accepts on the port but never answers health: when the pid file says it is our router, it is hung and
 *  is replaced; anything else is left alone. */
async function replaceSilent(ctx: Ctx): Promise<Result<string, string>> {
  const record = readPidFile(ctx.o.stateRoot);
  if (record === undefined || record.port !== ctx.port || !isOurProcess(record.pid, ctx.o.provider.name))
    return err(`port ${ctx.port} accepts connections but does not answer; it was left alone`);
  try {
    process.kill(record.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  await sleep(100);
  return startFresh(ctx);
}

/** A router of ours runs: nothing to do, a hot update (same front protocol, another version), or a handover (another
 *  front protocol, the emergency passthrough, or a retired router). */
async function update(ctx: Ctx, health: RouterHealth): Promise<Result<string, string>> {
  const { o } = ctx;
  if (health.mode === "retired") return takeOverRetired(ctx, health);
  const files = copyRouterFiles(o.distDir, o.stateRoot, o.provider.name);
  if (!files.ok) return ok(`running on ${ctx.url} (already running; ${files.error})`);
  if (health.mode !== "emergency" && health.frontVersion === FRONT_VERSION) {
    if (health.version === files.value.version) return ok(`running on ${ctx.url} (already running)`);
    const record = readPidFile(o.stateRoot);
    if (record === undefined)
      return ok(`running on ${ctx.url} (already running; no pid file to update it with)`);
    const reloaded = await control(ctx.port, o.provider.router.healthPath, record.token, "reload", {
      exec: files.value.router,
      version: files.value.version,
    });
    if (reloaded?.ok !== true) return ok(`running on ${ctx.url} (already running; the update was refused)`);
    writePidFile(o.stateRoot, { ...record, version: files.value.version });
    return ok(`running on ${ctx.url} (updated to ${files.value.version} without closing the port)`);
  }
  return handover(
    ctx,
    files.value,
    health.mode === "emergency" ? "the emergency passthrough" : "an older front",
  );
}

/** A retired router holds the port (the plugin was removed, then set up again): a fresh front takes the port over by
 *  the handover, so the sessions it still serves never see the port close. Without a record to hand over with, the
 *  retired router is stopped and a fresh one started. */
async function takeOverRetired(ctx: Ctx, health: RouterHealth): Promise<Result<string, string>> {
  const { o } = ctx;
  const files = copyRouterFiles(o.distDir, o.stateRoot, o.provider.name);
  if (!files.ok) return err(`a retired router holds ${ctx.url}, and ${files.error}`);
  const old = readRetiredFile(o.stateRoot) ?? readPidFile(o.stateRoot);
  if (old !== undefined) {
    const handed = await handoverWith(ctx, files.value, "a retired router", old);
    if (!handed.replaced) return err(`a retired router holds the port: ${handed.line}`);
    removeRetiredFile(o.stateRoot);
    return ok(handed.line);
  }
  const pid = health.pid;
  if (pid === undefined || !isOurProcess(pid, o.provider.name))
    return err(`a retired router holds ${ctx.url} and cannot be identified; it was left alone`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  const until = Math.max(ctx.deadline, Date.now() + 3000);
  while ((await probeRouter(ctx.port, o.provider, 100)).state !== "none") {
    if (Date.now() >= until) return err(`the retired router on ${ctx.url} did not stop`);
    await sleep(50);
  }
  return startFresh(ctx);
}

/** One control call to a router; undefined when it cannot be reached. */
async function control(
  port: number,
  healthPath: string,
  token: string,
  action: string,
  body: Record<string, unknown>,
  ms = 2000,
): Promise<Record<string, unknown> | undefined> {
  try {
    const answer = await fetch(`http://127.0.0.1:${port}${healthPath}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    const value: unknown = await answer.json();
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A free loopback port for the new front to prove itself on before it takes the real one. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

/** Restarts the front without the port ever being free for long: the new front starts on a temporary port and must
 *  answer health there; then it is told to take the real port (it retries the bind for up to 2 s) while the old one
 *  stops accepting and finishes its streams. If the new front never comes up, the old one is left running. */
async function handover(ctx: Ctx, files: RouterFiles, what: string): Promise<Result<string, string>> {
  const old = readPidFile(ctx.o.stateRoot);
  if (old === undefined) return ok(`running on ${ctx.url} (${what}; no pid file to hand it over with)`);
  const handed = await handoverWith(ctx, files, what, old);
  return handed.replaced || handed.kept ? ok(handed.line) : err(handed.line);
}

/** A handover's outcome: replaced (the new front holds the port), kept (the old one stays), or neither (failed). */
interface Handed {
  readonly replaced: boolean;
  readonly kept: boolean;
  readonly line: string;
}

async function handoverWith(ctx: Ctx, files: RouterFiles, what: string, old: PidRecord): Promise<Handed> {
  const { o } = ctx;
  const temporary = await freePort();
  const token = randomBytes(16).toString("hex");
  const child = ctx.spawn(
    ctx.node,
    [files.router, "run"],
    childEnv(o.provider, o.env, o.stateRoot, {
      [`${o.provider.envPrefix}_ROUTER_LISTEN_PORT`]: String(temporary),
      [`${o.provider.envPrefix}_ROUTER_TOKEN`]: token,
    }),
    stateLayout(o.stateRoot).routerLog,
  );
  const fresh = await waitOurs(ctx, temporary, child, Math.max(ctx.deadline, Date.now() + 3000));
  if (fresh === undefined || child.pid === undefined) {
    child.kill();
    return {
      replaced: false,
      kept: true,
      line: `running on ${ctx.url} (${what}; the new router did not start, so the running one stays)`,
    };
  }
  const adopting = control(temporary, o.provider.router.healthPath, token, "adopt", {}, 4000);
  await control(ctx.port, o.provider.router.healthPath, old.token, "handover", {});
  const adopted = await adopting;
  if (adopted?.ok !== true) {
    child.kill();
    return { replaced: false, kept: false, line: `handing ${ctx.url} over to a new router failed` };
  }
  writePidFile(o.stateRoot, pidRecord(child.pid, ctx.port, files.version, ctx.node, "router", token));
  return { replaced: true, kept: false, line: `running on ${ctx.url} (replaced ${what}, pid ${child.pid})` };
}

function pidRecord(
  pid: number,
  port: number,
  version: string,
  node: string,
  mode: PidRecord["mode"],
  token: string,
): PidRecord {
  return {
    pid,
    port,
    startedAt: new Date().toISOString(),
    node,
    version,
    frontVersion: FRONT_VERSION,
    mode,
    token,
  };
}

/** Takes `<state>/router.lock` (atomic create; a lock older than 10 s is stale and taken over). */
async function takeLock(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await createExclusive(path, `${process.pid}\n`)) return true;
    try {
      if (Date.now() - statSync(path).mtimeMs <= LOCK_STALE_MS) return false;
    } catch {
      continue;
    }
    rmSync(path, { force: true });
  }
  return false;
}

/** Nothing on the port: start the router (or wait for the starter that holds the lock), else the emergency
 *  passthrough. */
async function startFresh(ctx: Ctx): Promise<Result<string, string>> {
  const { o } = ctx;
  mkdirSync(o.stateRoot, { recursive: true, mode: 0o700 });
  const lock = stateLayout(o.stateRoot).routerLock;
  if (!(await takeLock(lock))) {
    const health = await waitOurs(ctx, ctx.port, undefined, Math.max(ctx.deadline, Date.now() + 3000));
    return health === undefined
      ? err("another start of the router holds the lock and did not bring it up")
      : ok(`running on ${ctx.url} (started by another session)`);
  }
  try {
    // Re-probe under the lock: a starter that just finished may already have it up.
    const again = await probeRouter(ctx.port, o.provider);
    if (again.state === "ours") return ok(`running on ${ctx.url} (started by another session)`);
    if (again.state !== "none") return err(`port ${ctx.port} is held by another program; it was left alone`);
    const files = copyRouterFiles(o.distDir, o.stateRoot, o.provider.name);
    if (!files.ok) return startEmergencyFrom(ctx, undefined, files.error);
    const token = randomBytes(16).toString("hex");
    const child = ctx.spawn(
      ctx.node,
      [files.value.router, "run"],
      childEnv(o.provider, o.env, o.stateRoot, { [`${o.provider.envPrefix}_ROUTER_TOKEN`]: token }),
      stateLayout(o.stateRoot).routerLog,
    );
    const until = Math.min(Date.now() + (o.healthWaitMs ?? 3000), ctx.deadline - 1500);
    const health = await waitOurs(ctx, ctx.port, child, until);
    if (health !== undefined && health.pid === child.pid && child.pid !== undefined) {
      writePidFile(
        o.stateRoot,
        pidRecord(child.pid, ctx.port, files.value.version, ctx.node, "router", token),
      );
      return ok(`running on ${ctx.url} (pid ${child.pid})`);
    }
    if (health !== undefined) return ok(`running on ${ctx.url} (started by another session)`);
    child.kill();
    return startEmergencyFrom(ctx, files.value, "the router did not start");
  } finally {
    rmSync(lock, { force: true });
  }
}

/** The emergency passthrough: Claude traffic keeps flowing even when the main router cannot start. */
async function startEmergencyFrom(
  ctx: Ctx,
  files: RouterFiles | undefined,
  why: string,
): Promise<Result<string, string>> {
  const { o } = ctx;
  const script = files?.passthrough ?? join(o.distDir, bundleNames(o.provider.name).passthrough);
  const token = randomBytes(16).toString("hex");
  const child = ctx.spawn(
    ctx.node,
    [script],
    childEnv(o.provider, o.env, o.stateRoot, { [`${o.provider.envPrefix}_ROUTER_TOKEN`]: token }),
    stateLayout(o.stateRoot).routerLog,
  );
  const health = await waitOurs(ctx, ctx.port, child, Math.max(ctx.deadline, Date.now() + 1500));
  if (health?.mode !== "emergency" || child.pid === undefined) {
    child.kill();
    return err(
      `${why}, and neither did the emergency passthrough (see ${stateLayout(o.stateRoot).routerLog})`,
    );
  }
  writePidFile(
    o.stateRoot,
    pidRecord(child.pid, ctx.port, files?.version ?? "emergency", ctx.node, "emergency", token),
  );
  return ok(
    `running on ${ctx.url} as the emergency passthrough (${why}): Claude models work, ${o.provider.display} models do not until the next start`,
  );
}

// ── the base URL guard ──────────────────────────────────────────────────────────────────────────────────────────────

/** The live plugin routers other than this one, as base URLs. */
async function liveOthers(provider: Provider, env: EnvLookup): Promise<string[]> {
  return (await liveRouters(env, provider.name)).map((entry) => `http://127.0.0.1:${entry.port}`);
}

/** Keeps Claude Code's base URL on something that answers: when it names this router and the router could not be
 *  brought up, or names another plugin's router that is dead and no longer registered (that plugin was uninstalled),
 *  it is repointed at a live plugin router or removed. A base URL that is not one of the plugin routers is never
 *  touched. Says one line when it changed something: the running session keeps its URL until restarted. */
export async function guardBaseUrl(o: StartOptions, up: boolean): Promise<void> {
  const path = claudeSettingsPath(o.env);
  const current = readBaseUrl(path);
  if (current === undefined) return;
  const ours = routerBaseUrl(o.provider, o.env);
  let dead = false;
  if (current === ours) dead = !up;
  else if (isPluginRouterUrl(current)) {
    const port = portOf(current);
    const registered = readRegistry(o.env).some((entry) => entry.port === port);
    dead = !registered && !(await (o.answers ?? ((other: number) => portAnswers(other, 200)))(port));
  }
  if (!dead) return;
  const others = (await liveOthers(o.provider, o.env)).filter((url) => url !== current);
  const changed = await clearBaseUrl(path, current, others, o.provider.name);
  if (changed.ok && changed.value.length > 0)
    o.say?.(
      `${o.provider.name}: ${current === ours ? "the router could not start" : `the router at ${current} is gone`}; ${changed.value.join("; ")}. Restart Claude Code sessions that still fail to connect.`,
    );
}

// ── stop and status ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The pid's command line (from /proc, else `ps`), or undefined when neither can say. */
export function commandLineOf(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
  } catch {
    const ps = runToolSync("ps", ["-p", String(pid), "-o", "command="], { timeoutMs: 2000 });
    return succeeded(ps) ? ps.stdout.toString("utf8").trim() : undefined;
  }
}

/** True when the pid runs one of our router bundles. */
export function isOurProcess(
  pid: number,
  name: string,
  read: (pid: number) => string | undefined = commandLineOf,
): boolean {
  const command = read(pid);
  return (
    command !== undefined &&
    (command.includes(`${name}-router.js`) || command.includes(`${name}-passthrough.js`))
  );
}

interface StopOptions {
  readonly provider: Provider;
  readonly env: EnvLookup;
  readonly stateRoot: string;
  readonly commandLine?: (pid: number) => string | undefined;
}

/** Stops the router (a retired one included): SIGTERM only a pid whose command line is one of our bundles; a stale
 *  pid file just goes. */
export function stopRouter(o: StopOptions): Result<string, string> {
  const record = readPidFile(o.stateRoot) ?? readRetiredFile(o.stateRoot);
  let line = "stopped (was not running)";
  if (record !== undefined) {
    if (isOurProcess(record.pid, o.provider.name, o.commandLine)) {
      try {
        process.kill(record.pid, "SIGTERM");
        line = `stopped (pid ${record.pid})`;
      } catch {
        line = "stopped (was not running)";
      }
    } else line = `stopped (pid ${record.pid} is not our router; removed the stale record)`;
  }
  removePidFile(o.stateRoot);
  removeRetiredFile(o.stateRoot);
  rmSync(stateLayout(o.stateRoot).routerLock, { force: true });
  removeRegistryEntry(o.env, o.provider.name);
  return ok(line);
}

interface RetireOptions extends StopOptions {
  readonly platform?: NodeJS.Platform;
}

/** The remove report's router line for a retired router. */
function retiredLine(pid: number): string {
  return `retired (pid ${pid}): keeps Claude working in open sessions, exits when they close`;
}

/** setup --remove's router step. Claude Code sessions keep the base URL they started with, so stopping the router
 *  would cut every open session off: the router is told to retire instead (see front.ts), and its record moves to
 *  `router.retired` so the hooks stop bringing it back while a later setup can still take the port over. A router
 *  that is already retired is left as it is. On Windows (no `ps` for the exit check), for the emergency passthrough,
 *  or when the retire call fails, the router is stopped as before. */
export async function retireRouter(o: RetireOptions): Promise<Result<string, string>> {
  if ((o.platform ?? process.platform) === "win32") return stopRouter(o);
  const record = readPidFile(o.stateRoot);
  if (record === undefined) {
    const retired = readRetiredFile(o.stateRoot);
    if (retired !== undefined && isOurProcess(retired.pid, o.provider.name, o.commandLine))
      return ok(retiredLine(retired.pid));
    return stopRouter(o);
  }
  if (record.mode === "emergency" || !isOurProcess(record.pid, o.provider.name, o.commandLine))
    return stopRouter(o);
  const answer = await control(record.port, o.provider.router.healthPath, record.token, "retire", {});
  if (answer?.ok !== true) return stopRouter(o);
  retirePidFile(o.stateRoot, record);
  rmSync(stateLayout(o.stateRoot).routerLock, { force: true });
  removeRegistryEntry(o.env, o.provider.name);
  return ok(retiredLine(record.pid));
}

/** The retired router's own exit: its record goes, unless it already names another process. */
export function clearRetiredRecord(stateRoot: string, pid: number): void {
  if (readRetiredFile(stateRoot)?.pid === pid) removeRetiredFile(stateRoot);
}

/** Asks the running router whether its worker can read the provider key (the source, never the key), waiting up to
 *  `waitMs` for a worker that is still starting. */
export async function routerKeyCheck(
  provider: Provider,
  env: EnvLookup,
  stateRoot: string,
  waitMs = 8000,
): Promise<Result<string, string>> {
  const record = readPidFile(stateRoot);
  if (record === undefined) return err("no router is running");
  // A router setup has just started answers before its worker is up: that is a wait, not a failure.
  const deadline = Date.now() + waitMs;
  for (;;) {
    const answer = await askKey(provider, env, record.token);
    if (answer.ok || answer.error !== NO_WORKER || Date.now() >= deadline) return answer;
    await new Promise((resolve) => setTimeout(resolve, KEY_CHECK_POLL_MS));
  }
}

const KEY_CHECK_POLL_MS = 100;

async function askKey(provider: Provider, env: EnvLookup, token: string): Promise<Result<string, string>> {
  try {
    const answer = await fetch(`${routerBaseUrl(provider, env)}${provider.router.healthPath}/key`, {
      headers: { [TOKEN_HEADER]: token },
      signal: AbortSignal.timeout(4000),
    });
    const value = (await answer.json()) as Record<string, unknown>;
    if (value.ok === true && typeof value.source === "string") return ok(value.source);
    return err(typeof value.error === "string" ? value.error : "the router cannot read the key");
  } catch {
    return err("the router did not answer the key check");
  }
}

/** The status line: what runs on the port, and whether this session uses it. */
export async function routerStatus(
  provider: Provider,
  env: EnvLookup,
): Promise<{ readonly up: boolean; readonly line: string }> {
  const url = routerBaseUrl(provider, env);
  const probe = await probeRouter(routerPort(provider, env), provider);
  const uses = env.ANTHROPIC_BASE_URL === url ? "uses" : "does not use";
  const mode = probe.state === "ours" && probe.health.mode !== undefined ? ` (${probe.health.mode})` : "";
  const what =
    probe.state === "ours"
      ? `running${mode}`
      : probe.state === "none"
        ? "not running"
        : "port held by another program";
  return {
    up: probe.state === "ours",
    line: `${provider.name}-router ${what} on ${url}; this session ${uses} it`,
  };
}
