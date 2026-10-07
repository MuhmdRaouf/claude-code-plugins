// The setup wiring: plain `setup` starts the plugin's router (a background process
// its hooks keep alive), adds the provider's two models to `/model` and points Claude Code at the router, so picking
// one routes through it while every `claude-*` request still reaches Anthropic untouched. Every change it makes outside
// the plugin goes into the ledger, so the router can undo exactly those when the plugin is uninstalled. `setup
// --remove` undoes all of it; the SessionStart hook re-applies it after plugin updates (and after a re-enable), never
// pings the provider, and falls back to Sonnet when the router cannot come back.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  applyProviderSettings,
  claudeSettingsPath,
  clearBaseUrl,
  readBaseUrl,
  removeProviderSettings,
  type SettingsDelta,
  undoProviderSettings,
} from "../adapters/claude-settings.ts";
import { writeFileAtomicSync } from "../adapters/fs-files.ts";
import { platformKeyStore } from "../adapters/keystore/index.ts";
import type { Deps } from "../app/deps.ts";
import type { ModelTier } from "../domain/model.ts";
import { KEPT_PREFIX, PLUGIN_ROUTERS, portOf } from "../domain/plugin-routers.ts";
import type { EnvLookup, Provider } from "../domain/provider.ts";
import { resolveProvider } from "../domain/provider.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { stateLayout } from "../domain/state-layout.ts";
import type { Output, WorkerError } from "../ports/index.ts";
import type { ProviderKey } from "../ports/keys.ts";
import { type Ledger, mergeSettingsUndo, readLedger, removeLedger, writeLedger } from "../router/ledger.ts";
import { ourHealth, registryEntryFor, routerBaseUrl } from "../router/process.ts";
import { liveRouters, removeRegistryEntry, saveRegistryEntry } from "../router/registry.ts";
import { EXIT, type ExitCode } from "./exit.ts";

// The plugin router registry's port map lives with the registry; re-exported here for the setup report's callers.

/** Both tiers always get a `model:` line: the agents are the only thing the choice rewrites. */
const TIERS: readonly ModelTier[] = ["main", "flash"];

/** Whose models the agents' `model:` lines name: this provider's ids, or Sonnet (works with no key and no router). */
type AgentModels = "provider" | "sonnet";

/** Whether setup has run: the `setup-done` mark, or the `route: provider` record an older install carries. */
export function readSetupDone(stateRoot: string): boolean {
  if (existsSync(stateLayout(stateRoot).setupDone)) return true;
  try {
    return readFileSync(stateLayout(stateRoot).legacyRouteMark, "utf8").trim() === "provider";
  } catch {
    return false;
  }
}

export function recordSetupDone(stateRoot: string): void {
  rmSync(stateLayout(stateRoot).legacyRouteMark, { force: true });
  writeFileSync(stateLayout(stateRoot).setupDone, "true\n", { mode: 0o600 });
}

export function clearSetupDone(stateRoot: string): void {
  rmSync(stateLayout(stateRoot).setupDone, { force: true });
  rmSync(stateLayout(stateRoot).legacyRouteMark, { force: true });
}

/** The agents sit beside the dist bundle: `<plugin>/agents` above `<plugin>/dist/<name>.js`. */
export function agentsDir(bundlePath: string): string {
  return join(dirname(bundlePath), "..", "agents");
}

function modelLineFor(tier: ModelTier, provider: Provider, models: AgentModels, env: EnvLookup): string {
  return models === "provider" ? resolveProvider(provider, env).catalog[tier].id : "sonnet";
}

/** One agent's `model:` line, as the setup report names it; `changed` says whether this run rewrote it. */
interface AgentModel {
  readonly tier: ModelTier;
  readonly agent: string;
  readonly model: string;
  readonly changed: boolean;
}

/** Rewrites each agent's first `model:` line for the choice; the result lists what was applied. */
export function applyAgentModels(
  bundlePath: string,
  provider: Provider,
  models: AgentModels,
  env: EnvLookup,
): Result<readonly AgentModel[], string> {
  const applied: AgentModel[] = [];
  for (const tier of TIERS) {
    const agent = provider.agents[tier];
    const file = join(agentsDir(bundlePath), `${agent}.md`);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return err(`${file}: not found`);
    }
    const model = modelLineFor(tier, provider, models, env);
    if (!/^model:.*$/m.test(text)) return err(`${file}: no model: line`);
    const next = text.replace(/^model:.*$/m, `model: ${model}`);
    // Atomic: a hook killed mid-write must never leave a truncated agent file.
    if (next !== text) writeFileAtomicSync(file, next, { mode: "preserve" });
    applied.push({ tier, agent, model, changed: next !== text });
  }
  return ok(applied);
}

/** The `models` report line, one entry per tier: the model alone when the agent named after it runs it, else
 *  `agent → model` (on Sonnet, or an env override's id), or the failure. */
export function agentText(applied: Result<readonly AgentModel[], string>): string {
  return applied.ok
    ? applied.value.map(({ agent, model }) => (agent === model ? model : `${agent} → ${model}`)).join(", ")
    : `FAILED: ${applied.error}`;
}

/** Whether this plugin's router answers its health path with its own name (any other 200 is someone else). */
export async function routerUp(provider: Provider, env: EnvLookup): Promise<boolean> {
  try {
    const url = `${routerBaseUrl(provider, env)}${provider.router.healthPath}`;
    const answer = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return answer.ok && ourHealth(await answer.text(), provider.name, provider.display) !== undefined;
  } catch {
    return false;
  }
}

/** What ANTHROPIC_BASE_URL points at: ok only when it is this plugin's router; the text always names the line to
 *  export. */
export function baseUrlReport(
  provider: Provider,
  env: EnvLookup,
): { readonly ok: boolean; readonly text: string } {
  const expected = routerBaseUrl(provider, env);
  const actual = env.ANTHROPIC_BASE_URL;
  if (actual === expected) return { ok: true, text: `points at the ${provider.name} router (${expected})` };
  const other = actual === undefined ? undefined : PLUGIN_ROUTERS.get(portOf(actual));
  if (other !== undefined)
    return {
      ok: false,
      text: `points at the ${other} plugin's router; run: export ANTHROPIC_BASE_URL=${expected}`,
    };
  return { ok: false, text: `unset or elsewhere; run: export ANTHROPIC_BASE_URL=${expected}` };
}

/** The slice `setup`, `setup --remove` and their hook need; the CLI maps it out of Deps, tests build it directly. */
export interface SetupDeps {
  readonly provider: Provider;
  readonly env: EnvLookup;
  readonly stateRoot: string;
  readonly bundlePath: string;
  readonly out: Output;
  /** The Claude Code settings file the merge owns its own entries in. */
  readonly settingsPath: string;
  loadKey(): Promise<Result<ProviderKey, WorkerError>>;
  ensureRouter(): Promise<Result<string, string>>;
  stopRouter(): Promise<Result<string, string>>;
  /** The running router's own view of the key: its source, or why it cannot read one. */
  routerKey(): Promise<Result<string, string>>;
}

export function setupDeps(deps: Deps): SetupDeps {
  return {
    provider: deps.provider,
    env: deps.env,
    stateRoot: deps.host.stateRoot,
    bundlePath: deps.bundlePath,
    out: deps.out,
    settingsPath: claudeSettingsPath(deps.env),
    loadKey: () => deps.host.loadKey(),
    ensureRouter: () => deps.host.ensureRouter(),
    stopRouter: () => deps.host.stopRouter(),
    routerKey: () => deps.host.routerKey(),
  };
}

/** What one wiring pass did: where the router runs (or why it does not), what changed in settings, which agents were
 *  rewritten. */
export interface RoutingApplied {
  readonly router: Result<string, string>;
  readonly settings: Result<readonly string[], string>;
  readonly agents: Result<readonly AgentModel[], string>;
}

/** The live plugin routers other than this one, as base URLs. */
async function liveOthers(deps: SetupDeps): Promise<string[]> {
  return (await liveRouters(deps.env, deps.provider.name)).map((entry) => `http://127.0.0.1:${entry.port}`);
}

/** Where Claude Code's settings point now, and whether that is a router of ours that will route the provider's ids:
 *  this plugin's (when it is up) or another live plugin router (which forwards them here). */
function routesProvider(deps: SetupDeps, routerOk: boolean, live: readonly string[]): boolean {
  const current = readBaseUrl(deps.settingsPath);
  if (current === undefined) return false;
  return (current === routerBaseUrl(deps.provider, deps.env) && routerOk) || live.includes(current);
}

/** `${CLAUDE_PLUGIN_DATA}/installed` when the data dir is this plugin's own: Claude Code deletes it on uninstall,
 *  which is how the router tells an uninstall from an update. */
function installedMarker(deps: SetupDeps): string | undefined {
  const data = deps.env.CLAUDE_PLUGIN_DATA;
  if (data === undefined || data === "" || !basename(data).startsWith(`${deps.provider.name}-`))
    return undefined;
  const marker = join(data, "installed");
  try {
    mkdirSync(data, { recursive: true, mode: 0o700 });
    if (!existsSync(marker)) writeFileSync(marker, "installed by setup\n", { mode: 0o600 });
    return marker;
  } catch {
    return undefined;
  }
}

/** Folds what this run changed into the ledger, so the router can undo exactly that on uninstall. */
function recordLedger(deps: SetupDeps, delta: SettingsDelta | undefined, storedKey: boolean): void {
  const path = stateLayout(deps.stateRoot).ledger;
  const previous = readLedger(path) ?? readLedger(stateLayout(deps.stateRoot).disabledLedger);
  const marker = installedMarker(deps) ?? previous?.marker;
  const ledger: Ledger = {
    version: 1,
    plugin: deps.provider.name,
    routerUrl: routerBaseUrl(deps.provider, deps.env),
    settingsPath: deps.settingsPath,
    settings: mergeSettingsUndo(previous?.settings, delta),
    keystore: { created: previous?.keystore.created === true || storedKey },
    routerFiles: [stateLayout(deps.stateRoot).routerDir],
    ...(previous?.legacyRemoved === undefined ? {} : { legacyRemoved: previous.legacyRemoved }),
    ...(marker === undefined ? {} : { marker }),
    stateRoot: deps.stateRoot,
  };
  try {
    mkdirSync(deps.stateRoot, { recursive: true, mode: 0o700 });
    writeLedger(path, ledger);
    removeLedger(stateLayout(deps.stateRoot).disabledLedger);
  } catch {
    // Without a ledger the router has nothing to undo on uninstall; setup itself still worked.
  }
}

/** Settings merged under the shared lock, the ledger updated with exactly what changed. */
async function mergeSettings(
  deps: SetupDeps,
  live: readonly string[],
): Promise<Result<readonly string[], string>> {
  let delta: SettingsDelta | undefined;
  const settings = await applyProviderSettings(
    deps.settingsPath,
    deps.provider,
    routerBaseUrl(deps.provider, deps.env),
    {
      livePluginUrls: live,
      record: (recorded) => {
        delta = recorded;
      },
    },
  );
  if (settings.ok) recordLedger(deps, delta, await keyInStore(deps));
  return settings;
}

/** Whether the key comes from this plugin's own entry in the OS store: only setup's key page and its move from the
 *  key file write there, so the router may delete it when the plugin is uninstalled. */
async function keyInStore(deps: SetupDeps): Promise<boolean> {
  const label = platformKeyStore(deps.provider, deps.env)?.label;
  if (label === undefined) return false;
  const key = await deps.loadKey();
  return key.ok && key.value.source === label;
}

/** The router line, told whether the router itself can read the key: setup must not say ready when it cannot. */
async function withRouterKey(
  deps: SetupDeps,
  router: Result<string, string>,
): Promise<Result<string, string>> {
  if (!router.ok) return router;
  const key = await deps.routerKey();
  if (key.ok) return router;
  return err(
    `${router.value}, but it cannot read the ${deps.provider.display} key (${key.error}): ${deps.provider.display} models are not ready; put the key where setup finds it (${deps.provider.keyEnv.join(" or ")} in the environment Claude Code starts from, or ${deps.provider.keyFile})`,
  );
}

/** `setup`'s wiring, in order: router, registry, settings merge (and ledger), agents, the setupDone mark.
 *  The agents name the provider's ids only when Claude Code's base URL is a router of ours that can route them. */
export async function applyRouting(deps: SetupDeps): Promise<RoutingApplied> {
  const { provider, env } = deps;
  const started = await deps.ensureRouter();
  if (started.ok) {
    try {
      await saveRegistryEntry(env, registryEntryFor(provider, env));
    } catch {
      // The router announces itself when it starts; setup's copy only covers the installed-but-not-running case.
    }
  }
  const live = await liveOthers(deps);
  const settings = await mergeSettings(deps, live);
  const router = await withRouterKey(deps, started);
  const models: AgentModels = router.ok && routesProvider(deps, started.ok, live) ? "provider" : "sonnet";
  const agents = applyAgentModels(deps.bundlePath, provider, models, env);
  if (started.ok && agents.ok) recordSetupDone(deps.stateRoot);
  return { router, settings, agents };
}

/** `setup --remove`: agents back on Sonnet, this plugin's entries out of settings and the registry, router stopped,
 *  the ledger gone (nothing is left for the router to undo). */
export async function removeRouting(deps: SetupDeps): Promise<RoutingApplied> {
  const { provider, env } = deps;
  const others = await liveOthers(deps);
  // With a ledger, setup's own record is undone, so settings.json ends as it was before setup (byte for byte when
  // nothing else changed it); without one (an install set up before setup kept a ledger), this provider's entries are taken out.
  const ledger =
    readLedger(stateLayout(deps.stateRoot).ledger) ?? readLedger(stateLayout(deps.stateRoot).disabledLedger);
  const settings =
    ledger !== undefined && ledger.settingsPath === deps.settingsPath
      ? await undoProviderSettings(
          deps.settingsPath,
          provider.name,
          ledger.settings,
          ledger.routerUrl,
          others,
        )
      : await removeProviderSettings(deps.settingsPath, provider, routerBaseUrl(provider, env), others);
  const agents = applyAgentModels(deps.bundlePath, provider, "sonnet", env);
  const router = await deps.stopRouter();
  clearSetupDone(deps.stateRoot);
  removeRegistryEntry(env, provider.name);
  removeLedger(stateLayout(deps.stateRoot).ledger);
  removeLedger(stateLayout(deps.stateRoot).disabledLedger);
  return { router, settings, agents };
}

/** A hook's message for the user: Claude Code shows a `systemMessage` to the user and keeps it out of Claude's
 *  context, where a warning would only be noise Claude may or may not pass on. */
export function userMessage(out: Output, text: string): void {
  out.line(JSON.stringify({ systemMessage: text }));
}

/** The SessionStart hook: brings the router up first (every Claude request depends on it), then re-applies the wiring
 *  a plugin update undid (agents rewritten, settings reshaped), silently: a repair is nobody's business. It never pings
 *  the provider. A plugin re-enabled after the router cleaned up for its disable is set up again. When the router
 *  cannot start, it falls back to Sonnet (the start's own guard already took the base URL off it) and tells the user. */
export async function routingHook(deps: SetupDeps): Promise<ExitCode> {
  const { provider } = deps;
  if (!readSetupDone(deps.stateRoot)) return reEnable(deps);
  const router = await deps.ensureRouter();
  if (!router.ok)
    return hookFallback(
      deps,
      `the ${provider.name} router could not start, so the ${provider.name} agents run on Sonnet this session. Run ${provider.slash}setup to see why.`,
    );
  const live = await liveOthers(deps);
  const settings = await mergeSettings(deps, live);
  const repaired = settings.ok ? settings.value.filter((line) => !line.startsWith(KEPT_PREFIX)) : [];
  const loaded = await deps.loadKey();
  if (!loaded.ok)
    return hookFallback(
      deps,
      `no ${provider.display} key found, so the ${provider.name} agents run on Sonnet. Run ${provider.slash}setup to enter it.`,
      repaired,
      false,
    );
  const models: AgentModels = routesProvider(deps, true, live) ? "provider" : "sonnet";
  applyAgentModels(deps.bundlePath, provider, models, deps.env);
  return EXIT.ok;
}

/** A plugin the router cleaned up after its disable, enabled again: set up again, said in one line to the user. */
async function reEnable(deps: SetupDeps): Promise<ExitCode> {
  if (readLedger(stateLayout(deps.stateRoot).disabledLedger) === undefined) return EXIT.ok;
  const applied = await applyRouting(deps);
  const { name, slash } = deps.provider;
  userMessage(
    deps.out,
    applied.router.ok
      ? `${name}: enabled again and set up again; restart Claude Code to route through the ${name} router.`
      : `${name}: enabled again, but the ${name} router could not start; run ${slash}setup to see why.`,
  );
  return EXIT.ok;
}

/** Agents back on Sonnet; with the router down, the base URL also comes off it (onto another live plugin router when
 *  there is one). A missing key leaves the router and the base URL alone: Claude traffic does not need the key. The
 *  user hears why, once something actually changed. */
async function hookFallback(
  deps: SetupDeps,
  message: string,
  repaired: readonly string[] = [],
  routerDown = true,
): Promise<ExitCode> {
  const { provider, env, out } = deps;
  const agents = applyAgentModels(deps.bundlePath, provider, "sonnet", env);
  if (routerDown) {
    await clearBaseUrl(
      deps.settingsPath,
      routerBaseUrl(provider, env),
      await liveOthers(deps),
      provider.name,
    );
  }
  const changed = agents.ok && agents.value.some(({ changed: moved }) => moved);
  if (changed || routerDown || repaired.length > 0) userMessage(out, `${provider.name}: ${message}`);
  return EXIT.ok;
}
