import { claudeSettingsPath, readBaseUrl } from "../../adapters/claude-settings.ts";
import type { SetupCheck } from "../../app/deps.ts";
import { describeWorkerError } from "../../app/errors.ts";
import { ping } from "../../app/ping.ts";
import { KEPT_PREFIX } from "../../domain/plugin-routers.ts";
import type { Provider } from "../../domain/provider.ts";
import { outcomeText, plural } from "../../render/format.ts";
import { estimateText } from "../../render/prices.ts";
import { routerBaseUrl } from "../../router/process.ts";
import type { Command, Invocation } from "../command.ts";
import { EXIT, type ExitCode } from "../exit.ts";
import {
  agentText,
  applyRouting,
  type RoutingApplied,
  removeRouting,
  restoredAgentText,
  routingHook,
  setupDeps,
} from "../route.ts";
import { ENGINE_OPTIONS, engineSetup, withEngineHook } from "./engine-setup.ts";
import { ensureKey, removeStoredKey } from "./setup-key.ts";

const SILENT = { line: () => {}, error: () => {} };

type Check = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string };

interface SetupReport {
  readonly ready: boolean;
  /** Set up, but the agents stay on Sonnet: Claude Code's base URL is the user's own proxy, not a router of ours. */
  readonly notRouted?: { readonly baseUrl: string; readonly routerUrl: string };
  /** Whether this run changed settings.json or an agent: the running session keeps its old settings until restart. */
  readonly changed?: boolean;
  readonly runtime: string;
  readonly worker: Check & { readonly bin: string };
  readonly extra: readonly SetupCheck[];
  readonly state: string;
  readonly cap: { readonly now: number; readonly max: number };
  readonly ping?: Check;
  readonly router?: Check;
  readonly models?: Check;
  readonly settings?: SettingsCheck;
}

type SettingsCheck = Check & { readonly path: string; readonly changed: boolean };

export const setupCommand: Command = {
  name: "setup",
  synopsis: [
    "setup [--remove] [--json]",
    "setup --engines [--json]",
    "setup --engine-check <omp|opencode|pi> [--json]",
    "setup --engine-enable <omp|opencode|pi> --watcher provider|sonnet",
  ],
  // --ping is an undocumented no-op alias: plain setup always pings.
  options: {
    ping: { type: "boolean" },
    hook: { type: "boolean" },
    remove: { type: "boolean" },
    ...ENGINE_OPTIONS,
  },
  async run(call) {
    // The engines' repairs stay silent like the router's: only a user message (JSON) may reach stdout.
    if (call.flag("hook"))
      return withEngineHook({ ...call.deps, out: SILENT }, () => routingHook(setupDeps(call.deps)));
    const engine = engineSetup(call, setupRun);
    if (engine !== undefined) return engine;
    if (call.flag("remove")) return setupRemove(call);
    return setupRun(call);
  },
};

/** Plain `setup`: the checks and the ping, then — only when both pass — the routing wiring, all of it reported. */
async function setupRun(call: Invocation): Promise<ExitCode> {
  const { deps } = call;
  const keyed = await ensureKey(call);
  if (keyed !== undefined) return keyed;
  const base = await setupBase(call);
  const checked = base.worker.ok && base.extra.every((check) => check.result.ok);
  if (!checked) return finish(call, { ready: false, ...base });
  const pinged = await pingCheck(call);
  if (!pinged.ok) return finish(call, { ready: false, ...base, ping: pinged });
  const applied = await applyRouting(setupDeps(deps));
  const wired = applied.router.ok && applied.settings.ok && applied.agents.ok;
  const notRouted = wired ? notRoutedBy(call, applied) : undefined;
  return finish(call, {
    ready: wired && notRouted === undefined,
    ...(notRouted === undefined ? {} : { notRouted }),
    changed:
      (applied.settings.ok && applied.settings.value.some((line) => !line.startsWith(KEPT_PREFIX))) ||
      (applied.agents.ok && applied.agents.value.some((agent) => agent.changed)),
    ...base,
    ping: pinged,
    router: applied.router,
    models: applied.agents.ok ? { ok: true, value: agentText(applied.agents) } : applied.agents,
    settings: settingsCheck(claudeSettingsPath(deps.env), applied.settings),
  });
}

/** Wired, yet the agents still name Sonnet: the router only routes when Claude Code's base URL is a router of ours,
 *  and setup kept the user's own proxy there. */
function notRoutedBy(call: Invocation, applied: RoutingApplied): SetupReport["notRouted"] {
  if (!applied.agents.ok || applied.agents.value.every((agent) => agent.model !== "sonnet")) return undefined;
  const { provider, env } = call.deps;
  return {
    baseUrl: readBaseUrl(claudeSettingsPath(env)) ?? "unset",
    routerUrl: routerBaseUrl(provider, env),
  };
}

async function setupRemove(call: Invocation): Promise<ExitCode> {
  const { provider, env, out } = call.deps;
  const removed = await removeRouting(setupDeps(call.deps));
  await removeStoredKey(call);
  if (call.flag("json")) call.json(removeJson(claudeSettingsPath(env), removed));
  else out.line(renderRemove(provider, claudeSettingsPath(env), removed));
  return EXIT.ok;
}

function finish(call: Invocation, report: SetupReport): ExitCode {
  if (call.flag("json")) call.json(setupJson(call.deps.provider, report));
  else call.deps.out.line(renderSetup(call.deps.provider, report));
  return report.ready ? EXIT.ok : EXIT.notReady;
}

async function setupBase(
  call: Invocation,
): Promise<Pick<SetupReport, "runtime" | "worker" | "extra" | "state" | "cap">> {
  const { deps } = call;
  const worker = await deps.host.workerVersion();
  const extra = await deps.host.extraChecks();
  const limit = await deps.limiter.limit(deps.clock.now());
  return {
    runtime: deps.host.runtime,
    worker: { ...worker, bin: deps.host.workerBin },
    extra,
    state: deps.host.stateRoot,
    cap: { now: limit.cap, max: limit.max },
  };
}

/** The worker under its label, then each extra check under its own. */
function setupJson(
  provider: Provider,
  {
    ready,
    notRouted,
    changed: _changed,
    runtime,
    worker,
    extra,
    ping,
    router,
    models,
    settings,
    ...rest
  }: SetupReport,
): Record<string, unknown> {
  return {
    ready,
    ...(notRouted === undefined ? {} : { routed: false, baseUrl: notRouted.baseUrl }),
    runtime,
    [provider.workerLabel]: worker,
    ...Object.fromEntries(extra.map((check) => [check.label, check.result])),
    ...rest,
    ...(ping === undefined ? {} : { ping }),
    ...(router === undefined ? {} : { router }),
    ...(models === undefined ? {} : { models }),
    ...(settings === undefined ? {} : { settings }),
  };
}

function removeJson(settingsPath: string, removed: RoutingApplied): Record<string, unknown> {
  return {
    removed: true,
    router: removed.router,
    models: removed.agents.ok ? { ok: true, value: restoredAgentText(removed) } : removed.agents,
    settings: settingsCheck(settingsPath, removed.settings),
  };
}

async function pingCheck(call: Invocation): Promise<Check> {
  const result = await ping(call.deps);
  const { provider } = call.deps;
  if (!result.ok) return { ok: false, error: describeWorkerError(provider, result.error) };
  const { outcome, usage } = result.value;
  if (outcome.kind !== "completed") return { ok: false, error: outcomeText(outcome) };
  const model = provider.catalog[provider.pingTier].id;
  return {
    ok: true,
    value: `ok: ${model} answered (${plural(usage.turns, "turn")}, ${estimateText(model, usage)})`,
  };
}

function settingsCheck(path: string, settings: ResultOfChanges): SettingsCheck {
  return settings.ok
    ? { ok: true, path, changed: settings.value.length > 0, value: settings.value.join("; ") || "no changes" }
    : { ok: false, path, changed: false, error: settings.error };
}

type ResultOfChanges = RoutingApplied["settings"];

/** The checklist labels besides the worker's and the extra checks'; with them they set the column width. */
const LABELS = ["runtime", "ping", "router", "models", "settings"];
const REMOVE_LABELS = ["router", "models", "settings"];

/** The outcome first, in one sentence with the next step, then a short checklist; state dir and cap are in --json. */
function renderSetup(provider: Provider, report: SetupReport): string {
  const labels = [provider.workerLabel, ...report.extra.map((check) => check.label), ...LABELS];
  const width = Math.max(...labels.map((label) => label.length)) + 2;
  const line = (label: string, text: string) => `  ${`${label}:`.padEnd(width)}${text}`;
  const worker = report.worker.ok
    ? `${report.worker.bin} (${report.worker.value})`
    : `${report.worker.bin}: FAILED: ${report.worker.error}`;
  const optional = (label: string, check: Check | undefined): string[] =>
    check === undefined ? [] : [line(label, check.ok ? check.value : `FAILED: ${check.error}`)];
  const settings =
    report.settings === undefined
      ? []
      : [
          line(
            "settings",
            report.settings.ok
              ? report.settings.changed
                ? `${report.settings.path} (updated: ${report.settings.value})`
                : `${report.settings.path} (already set)`
              : `FAILED: ${report.settings.error}`,
          ),
        ];
  return [
    outcomeLine(provider, report),
    line("runtime", report.runtime),
    line(provider.workerLabel, worker),
    ...report.extra.map((check) => line(check.label, check.text)),
    ...optional("ping", report.ping),
    ...optional("router", report.router),
    ...optional("models", report.models),
    ...settings,
    ...restartLine(provider, report),
  ].join("\n");
}

/** The answer, before any detail: ready (and what that gives), set up but not routed (and the fix), or not ready. */
function outcomeLine(provider: Provider, report: SetupReport): string {
  const { name, catalog, agentPrefix, agents } = provider;
  if (report.ready)
    return `${name} setup: ready. ${catalog.main.label} and ${catalog.flash.label} are in /model; ${agentPrefix}${agents.main} and ${agentPrefix}${agents.flash} run on them.`;
  if (report.notRouted !== undefined)
    return `${name} setup: not routed. ANTHROPIC_BASE_URL in settings.json points at your own proxy (${report.notRouted.baseUrl}), so ${provider.display} requests never reach the ${name} router and its agents run on Sonnet. Point that proxy at ${report.notRouted.routerUrl}, or remove the entry and run ${provider.slash}setup again.`;
  return `${name} setup: not ready. The FAILED line below says why.`;
}

/** Claude Code reads its settings when a session starts: this one keeps talking to Anthropic until it restarts. */
function restartLine(provider: Provider, report: SetupReport): string[] {
  if (!report.ready || report.changed !== true) return [];
  return [
    `Restart Claude Code now. This session keeps talking to Anthropic until it restarts; ${provider.catalog.main.label} in /model and the ${provider.name} agents work from the next session.`,
  ];
}

function renderRemove(provider: Provider, settingsPath: string, removed: RoutingApplied): string {
  const width = Math.max(...REMOVE_LABELS.map((label) => label.length)) + 2;
  const line = (label: string, text: string) => `  ${`${label}:`.padEnd(width)}${text}`;
  const settings = settingsCheck(settingsPath, removed.settings);
  const clean = removed.router.ok && removed.agents.ok && settings.ok;
  const { name, catalog } = provider;
  return [
    clean
      ? `${name} removed: its agents are back on their models before setup, ${catalog.main.label} and ${catalog.flash.label} are out of /model, the router is retired and its stored key is removed. Open sessions keep working and new ones start without it; /plugin uninstall is safe now.`
      : `${name} removed, except for the FAILED line below.`,
    line("router", removed.router.ok ? removed.router.value : `FAILED: ${removed.router.error}`),
    line("models", restoredAgentText(removed)),
    line(
      "settings",
      settings.ok
        ? `${settings.path} (${settings.changed ? "restored" : "nothing to undo"})`
        : `FAILED: ${settings.error}`,
    ),
  ].join("\n");
}
