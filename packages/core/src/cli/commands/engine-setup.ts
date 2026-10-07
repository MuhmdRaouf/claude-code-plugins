// `/<p>:setup:<engine>`: `setup --engine-check
// <tool>` does everything plain `setup` does, then checks the tool as the user set it up (binary on PATH, its version,
// a one-word smoke run on the tool's own login, provider and default model — never this plugin's provider) and changes
// nothing about the engine; `setup --engine-enable <tool> --watcher provider|sonnet` records the engine and the watcher
// the user picked and points the tool's wrapper agent at that model; `setup --engines` reads, changing nothing, what
// plain `/<p>:setup` asks from: whether setup ran, and each tool's binary and recorded watcher.
// The CLI never asks: the command files ask (what to set up, who watches), every time, and pass the answers. The
// SessionStart hook re-applies the recorded watchers.
import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { toolVersion } from "../../adapters/process/tool.ts";
import type { Deps } from "../../app/deps.ts";
import { describeWorkerError } from "../../app/errors.ts";
import { builtinContract } from "../../app/report-schema.ts";
import type { EngineConfig, Watcher } from "../../domain/engine.ts";
import { ENGINE_TOOLS, type EngineTool, isEngineTool, withEngine } from "../../domain/engine.ts";
import type { Provider } from "../../domain/provider.ts";
import { err, ok, type Result } from "../../domain/result.ts";
import { finalizeWorker, type WorkerEvent } from "../../domain/worker-events.ts";
import type { Output, Worker } from "../../ports/index.ts";
import { outcomeText, plural, usd } from "../../render/format.ts";
import type { Invocation } from "../command.ts";
import { EXIT, type ExitCode } from "../exit.ts";
import { agentsDir, readSetupDone } from "../route.ts";

/** A cold first start of a tool, plus one short answer from whatever model it defaults to. */
const SMOKE_TIMEOUT_MS = 120_000;
const SMOKE_PROMPT =
  'This is a check that you run. Use no tools. End at once with a notes report whose summary is the one word "ok", with no findings and no open items.';
const WATCHERS: readonly Watcher[] = ["provider", "sonnet"];

type Check = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string };

/** setup's internal engine flags, for the command files and tests; never documented as user arguments. */
export const ENGINE_OPTIONS = {
  engines: { type: "boolean" },
  "engine-check": { type: "string" },
  "engine-enable": { type: "string" },
  watcher: { type: "string" },
} as const;

/** Plain setup's own run, reused as the first half of the engine check. */
type BaseSetup = (call: Invocation) => Promise<ExitCode>;

/** setup's engine flags; undefined when the call has none, so plain setup runs. */
export function engineSetup(call: Invocation, base: BaseSetup): Promise<ExitCode> | undefined {
  if (call.flag("engines")) return Promise.resolve(engineStatus(call));
  const check = call.text("engine-check");
  if (check !== undefined) return engineCheck(call, check, base);
  const enable = call.text("engine-enable");
  if (enable !== undefined) return engineEnable(call, enable, call.text("watcher"));
  if (call.text("watcher") !== undefined)
    return Promise.resolve(call.usage("--watcher goes with --engine-enable"));
  return undefined;
}

// ── --engines ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One tool as plain setup's menu offers it: found or not, enabled or not. */
interface EngineStatus {
  readonly engine: EngineTool;
  readonly binary: Check;
  /** The recorded watcher while the engine is enabled, null while it is not. */
  readonly watcher: Watcher | null;
}

/** What `/<p>:setup` asks from, read-only: whether setup ran, and every tool's status. */
function engineStatus(call: Invocation): ExitCode {
  if (["engine-check", "engine-enable", "watcher"].some((flag) => call.text(flag) !== undefined))
    return call.usage("--engines takes no other setup flag");
  const { deps } = call;
  const setup = readSetupDone(deps.host.stateRoot);
  const recorded = deps.engineConfig.read().engines;
  const engines: EngineStatus[] = ENGINE_TOOLS.map((tool) => ({
    engine: tool,
    binary: findBinary(deps.engines?.bin(tool) ?? tool, deps.env.PATH),
    watcher: recorded[tool]?.watcher ?? null,
  }));
  if (call.flag("json")) call.json({ setup, engines });
  else deps.out.line(renderStatus(deps.provider, setup, engines));
  return EXIT.ok;
}

function renderStatus(provider: Provider, setup: boolean, engines: readonly EngineStatus[]): string {
  const width = Math.max(...ENGINE_TOOLS.map((tool) => tool.length)) + 2;
  const lines = engines.map(({ engine, binary, watcher }) => {
    const found = binary.ok ? `installed (${binary.value})` : `not found: ${binary.error}`;
    const state =
      watcher === null ? "not enabled" : `enabled, watched by ${watcherLabels(provider)[watcher]}`;
    return `  ${`${engine}:`.padEnd(width)}${found}; ${state}`;
  });
  return [`${provider.name} setup: ${setup ? "done" : "not run yet"}`, ...lines].join("\n");
}

// ── --engine-check ───────────────────────────────────────────────────────────────────────────────────────────────────

/** One engine's setup lines; `ready` only when plain setup passed too. */
interface EngineReport {
  readonly engine: EngineTool;
  readonly ready: boolean;
  readonly binary: Check;
  readonly version: Check;
  /** A one-word run of the tool on its own setup: proves it is logged in and configured. */
  readonly smoke: Check;
  /** The recorded watcher, or null before the engine was first enabled. */
  readonly watcher: Watcher | null;
  /** What the command's question offers, by answer. */
  readonly watchers: Readonly<Record<Watcher, string>>;
}

async function engineCheck(call: Invocation, name: string, base: BaseSetup): Promise<ExitCode> {
  if (!isEngineTool(name)) return call.usage("--engine-check takes omp, opencode or pi");
  const captured = capturing(call);
  const baseReady = (await base(captured.call)) === EXIT.ok;
  const report = await engineReport(call.deps, name, baseReady);
  if (call.flag("json")) {
    const baseJson = captured.json();
    const fields = typeof baseJson === "object" && baseJson !== null ? baseJson : {};
    call.json({ ...fields, ready: report.ready, engine: report });
  } else {
    for (const line of captured.lines) call.deps.out.line(line);
    call.deps.out.line(renderEngine(call.deps.provider, report));
  }
  return report.ready ? EXIT.ok : EXIT.notReady;
}

/** The invocation plain setup runs with: its lines and its JSON kept for the combined report. */
function capturing(call: Invocation): {
  readonly call: Invocation;
  readonly lines: readonly string[];
  json(): unknown;
} {
  const lines: string[] = [];
  let json: unknown;
  const out: Output = { line: (text) => lines.push(text), error: (text) => call.deps.out.error(text) };
  return {
    call: {
      ...call,
      deps: { ...call.deps, out },
      json: (value) => {
        json = value;
      },
    },
    lines,
    json: () => json,
  };
}

/** The tool's lines: the smoke run needs only the tool, so it runs whether plain setup passed or not. */
async function engineReport(deps: Deps, tool: EngineTool, baseReady: boolean): Promise<EngineReport> {
  const binary = findBinary(deps.engines?.bin(tool) ?? tool, deps.env.PATH);
  const version = binary.ok ? await toolVersion(binary.value) : failed("not run: no binary");
  const worker = deps.engines?.worker(tool);
  const linesOk = binary.ok && version.ok && worker !== undefined;
  const smoke = linesOk ? await smokeRun(deps, worker, tool) : failed("not run: fix the lines above first");
  return {
    engine: tool,
    ready: baseReady && linesOk && smoke.ok,
    binary,
    version,
    smoke,
    watcher: deps.engineConfig.read().engines[tool]?.watcher ?? null,
    watchers: watcherLabels(deps.provider),
  };
}

/** The tool's binary: an explicit path as given, a bare name the first executable match on PATH. */
export function findBinary(bin: string, path: string | undefined): Check {
  const candidates = bin.includes("/")
    ? [bin]
    : (path ?? "")
        .split(delimiter)
        .filter((dir) => dir !== "")
        .map((dir) => join(dir, bin));
  const found = candidates.find(isExecutable);
  if (found !== undefined) return { ok: true, value: found };
  return failed(bin.includes("/") ? `${bin} is not an executable file` : `${bin} is not on PATH`);
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** What a failed smoke run tells the user: the plugin does not set the tool up, the user does, once. */
function notConfigured(tool: EngineTool, reason: string): Check {
  return failed(`${reason}; run ${tool} once and log in / configure it; the plugin uses it as it is`);
}

/**
 * One tiny real run of the tool through its bridge, on the tool's own login, provider and default model (readonly, in
 * the state root, a notes report). The plugin's provider plays no part; the line reports the model the tool says it
 * used, and its numbers as the tool reports them.
 */
async function smokeRun(deps: Deps, worker: Worker, tool: EngineTool): Promise<Check> {
  const root = deps.host.stateRoot;
  const started = await worker.start({
    cwd: root,
    // The tool ignores this: it runs on its own default model.
    model: deps.provider.catalog[deps.provider.pingTier],
    access: "readonly",
    prompt: SMOKE_PROMPT,
    session: { kind: "new", key: deps.ids.sessionId() },
    report: builtinContract("notes"),
    addDirs: [],
    passEnv: {},
    timeoutMs: SMOKE_TIMEOUT_MS,
    logPath: join(root, `setup-${tool}-smoke.jsonl`),
  });
  if (!started.ok) return notConfigured(tool, describeWorkerError(deps.provider, started.error));
  const events: WorkerEvent[] = [];
  for await (const event of started.value.events) events.push(event);
  const exit = await started.value.exit;
  const { outcome, usage } = finalizeWorker(events, exit, exit.forced);
  if (outcome.kind !== "completed") return notConfigured(tool, outcomeText(outcome));
  const on = usage.model === undefined ? "" : ` on ${usage.model}`;
  return {
    ok: true,
    value: `ok: ${tool} answered${on} (${tool}'s own numbers: ${plural(usage.turns, "turn")}, ${usd(usage.costUsd)})`,
  };
}

/** The two answers to "Who should watch <engine> runs?", as the command offers them. */
function watcherLabels(provider: Provider): Readonly<Record<Watcher, string>> {
  return { provider: `${provider.catalog.main.label} (${provider.display})`, sonnet: "Claude Sonnet" };
}

const ENGINE_LABELS = ["binary", "version", "smoke", "watcher"];

function renderEngine(provider: Provider, report: EngineReport): string {
  const width = Math.max(...ENGINE_LABELS.map((label) => label.length)) + 2;
  const line = (label: string, check: Check) =>
    `  ${`${label}:`.padEnd(width)}${check.ok ? check.value : `FAILED: ${check.error}`}`;
  const watcher = report.watcher === null ? "not chosen yet" : `${report.watchers[report.watcher]} (current)`;
  return [
    `${provider.name} setup: ${report.engine} engine`,
    line("binary", report.binary),
    line("version", report.version),
    line("smoke", report.smoke),
    line("watcher", { ok: true, value: watcher }),
    report.ready ? "ready" : "not ready",
  ].join("\n");
}

function failed(error: string): Check {
  return { ok: false, error };
}

// ── --engine-enable ──────────────────────────────────────────────────────────────────────────────────────────────────

async function engineEnable(call: Invocation, name: string, watcher: string | undefined): Promise<ExitCode> {
  if (!isEngineTool(name)) return call.usage("--engine-enable takes omp, opencode or pi");
  if (!isWatcher(watcher)) return call.usage("--engine-enable needs --watcher provider or --watcher sonnet");
  const { deps } = call;
  const binary = findBinary(deps.engines?.bin(name) ?? name, deps.env.PATH);
  const version = binary.ok ? await toolVersion(binary.value) : binary;
  const blocker = [binary, version].find((check) => !check.ok);
  if (blocker !== undefined && !blocker.ok) {
    deps.out.error(`${deps.provider.name}: cannot enable ${name}: ${blocker.error}`);
    return EXIT.notReady;
  }
  const model = watcherModel(deps.provider, watcher);
  const agent = applyEngineAgent(deps.bundlePath, name, model);
  if (!agent.ok) {
    deps.out.error(`${deps.provider.name}: cannot enable ${name}: ${agent.error}`);
    return EXIT.notReady;
  }
  const config = withEngine(deps.engineConfig.read(), name, {
    watcher,
    version: version.ok ? version.value : "",
    path: binary.ok ? binary.value : name,
  });
  deps.engineConfig.write(config);
  return reportEnabled(call, name, watcher, model);
}

function reportEnabled(call: Invocation, tool: EngineTool, watcher: Watcher, model: string): ExitCode {
  const { provider } = call.deps;
  const agent = `${provider.agentPrefix}${tool}`;
  if (call.flag("json")) call.json({ engine: tool, enabled: true, watcher, agent, model });
  else
    call.deps.out.line(
      `${provider.name}: ${tool} enabled; ${agent} runs on ${model} (watcher: ${watcherLabels(provider)[watcher]})`,
    );
  return EXIT.ok;
}

function isWatcher(value: string | undefined): value is Watcher {
  return WATCHERS.some((watcher) => watcher === value);
}

/** The model the wrapper agent's `model:` line names: the provider's main model, or Sonnet. */
function watcherModel(provider: Provider, watcher: Watcher): string {
  return watcher === "provider" ? provider.catalog.main.id : "sonnet";
}

/** Rewrites the engine wrapper agent's first `model:` line; `changed` says whether the file was rewritten. */
function applyEngineAgent(bundlePath: string, tool: EngineTool, model: string): Result<boolean, string> {
  return rewriteModelLine(join(agentsDir(bundlePath), `${tool}.md`), model);
}

function rewriteModelLine(file: string, model: string): Result<boolean, string> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return err(`${file}: not found`);
  }
  if (!/^model:.*$/m.test(text)) return err(`${file}: no model: line`);
  const next = text.replace(/^model:.*$/m, `model: ${model}`);
  if (next !== text) writeFileSync(file, next);
  return ok(next !== text);
}

// ── SessionStart ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Runs the setup hook, then re-applies each enabled engine's watcher a plugin update may have reset. Never fails. */
export async function withEngineHook(deps: Deps, hook: () => Promise<ExitCode>): Promise<ExitCode> {
  const code = await hook();
  try {
    const repaired = reapplyWatchers(deps, deps.engineConfig.read());
    if (repaired.length > 0) deps.out.line(`${deps.provider.name}: repaired — ${repaired.join(", ")}`);
  } catch {
    // A hook must never disturb the session it starts.
  }
  return code;
}

/**
 * A provider watcher follows the main agent: it runs on the provider's model exactly while the routing hook keeps the
 * main agent there, and falls back to Sonnet with it when the router is down or the key is gone.
 */
function reapplyWatchers(deps: Deps, config: EngineConfig): readonly string[] {
  const { provider, bundlePath } = deps;
  const main = provider.catalog.main.id;
  const routed = modelLine(join(agentsDir(bundlePath), `${provider.agents.main}.md`)) === main;
  const repaired: string[] = [];
  for (const [tool, setting] of Object.entries(config.engines)) {
    if (!isEngineTool(tool) || setting === undefined) continue;
    const model = setting.watcher === "provider" && routed ? main : "sonnet";
    const applied = applyEngineAgent(bundlePath, tool, model);
    if (applied.ok && applied.value) repaired.push(`${provider.agentPrefix}${tool} → ${model}`);
  }
  return repaired;
}

function modelLine(file: string): string | undefined {
  try {
    return /^model:\s*(.*)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim();
  } catch {
    return undefined;
  }
}
