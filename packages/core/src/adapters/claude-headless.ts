import type { ModelRef } from "../domain/model.ts";
import type { Provider } from "../domain/provider.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseStreamLine } from "../domain/stream-parse.ts";
import type { WorkerEvent } from "../domain/worker-events.ts";
import type {
  Access,
  Worker,
  WorkerCapabilities,
  WorkerError,
  WorkerExit,
  WorkerRun,
  WorkerSpec,
} from "../ports/index.ts";
import type { ProviderKey } from "../ports/keys.ts";
import { pickAllowlisted, withoutReserved } from "./env.ts";
import { type ProcessExit, startStreaming } from "./process/stream.ts";

export const CLAUDE_CAPS: WorkerCapabilities = {
  name: "claude-headless",
  sessionKey: "caller",
  nativeSchema: true,
  budget: true,
  efforts: ["low", "high", "max"],
  briefNotes: {
    effort: "passed to claude --effort",
    addDirs: "passed as --add-dir",
    budgetUsd: "passed as --max-budget-usd",
    readonly: "plan mode, read tools only",
  },
};

/**
 * main runs on Claude Code's `sonnet` alias mapped to the provider's main model through
 * ANTHROPIC_DEFAULT_SONNET_MODEL, because a raw provider id makes Claude Code log `unrecognized_model`. flash passes
 * its full id: plan mode (readonly) resolves the `haiku` alias to sonnet, so `--model haiku --permission-mode plan`
 * runs every assistant message on the main model, while `--model <flash id>` runs on flash. That argv also logs
 * `unrecognized_model` on stderr; the run succeeds.
 */
/** The `--model` value per tier: main uses the sonnet alias, flash its own catalog id (see above). */
function modelArg(model: ModelRef): string {
  return model.tier === "main" ? "sonnet" : model.id;
}

/** The alias mapping, from the provider's catalog: every alias Claude Code may pick lands on one of its models. */
function aliasEnv(provider: Provider): Readonly<Record<string, string>> {
  return {
    ANTHROPIC_DEFAULT_OPUS_MODEL: provider.catalog.main.id,
    ANTHROPIC_DEFAULT_SONNET_MODEL: provider.catalog.main.id,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: provider.catalog.flash.id,
  };
}

/** Read-only work runs in plan mode; edit and exec may change and run anything (the plugin verifies afterwards). */
const PERMISSION_MODE: Readonly<Record<Access, "bypassPermissions" | "plan">> = {
  write: "bypassPermissions",
  exec: "bypassPermissions",
  readonly: "plan",
};

/** What Claude Code prints when `--resume` names a session it does not have. */
const NO_SUCH_SESSION = /no conversation found/i;

/** A resume whose session Claude Code does not have: it says so on stderr and exits. */
export function claudeSessionMissing(session: WorkerSpec["session"], stderrTail: string): boolean {
  return session.kind === "resume" && NO_SUCH_SESSION.test(stderrTail);
}

/** Every CLAUDE* name a worker must never inherit, from the parent or from a brief's `env`, grouped by why. An entry
 *  ending in `*` denies that prefix; credential-shaped names are denied by rule (CREDENTIAL_WORDS), not listed. The
 *  plugin's own values, applied after everything else, win regardless. */
export const CLAUDE_ENV_DENYLIST = [
  // The isolated per-worker config dir; the worker always sets it.
  "CLAUDE_CONFIG_DIR",
  // The orchestrator's credentials must never reach a worker routed to the provider.
  "CLAUDE_CODE_OAUTH_TOKEN",
  // These would route the worker away from the provider.
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  // The orchestrator's plugin and project context (Claude Code leaks these into Bash calls).
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_PROJECT_DIR",
  // Marks of the orchestrator's own session and its IDE connection.
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_*",
  // The worker sets this itself.
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
] as const;

/** Credential words, matched as whole `_`-separated segments: `CLAUDE_CODE_OAUTH_TOKEN` is denied while
 *  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (a size, not a credential) passes. */
const CREDENTIAL_WORDS = ["TOKEN", "KEY", "SECRET"] as const;

/** Claude Code gets this long after SIGTERM to stop its tools before the group is killed. */
const KILL_GRACE_MS = 5_000;

/** argv for `claude` (prompt goes to stdin, never argv). */
export function buildClaudeArgs(spec: WorkerSpec): readonly string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    modelArg(spec.model),
    spec.session.kind === "new" ? "--session-id" : "--resume",
    spec.session.key,
    "--permission-mode",
    PERMISSION_MODE[spec.access],
    "--json-schema",
    JSON.stringify(spec.report.jsonSchema),
    ...(spec.effort === undefined ? [] : ["--effort", spec.effort]),
    ...(spec.budgetUsd === undefined ? [] : ["--max-budget-usd", String(spec.budgetUsd)]),
    // Last: `--add-dir` is variadic in Claude Code, so nothing that follows may be mistaken for another directory.
    ...spec.addDirs.flatMap((dir) => ["--add-dir", dir]),
  ];
}

/** Allowlisted parent env + the parent's CLAUDE* settings + spec.passEnv + provider routing + alias mapping + isolated
 *  CLAUDE_CONFIG_DIR + the key. Later layers win, so the plugin's own values always beat anything passed through. */
export function buildWorkerEnv(
  provider: Provider,
  spec: WorkerSpec,
  key: string,
  parent: Readonly<Record<string, string | undefined>>,
  configDir: string,
): Record<string, string> {
  return {
    ...pickAllowlisted(parent),
    ...pickClaudeSettings(parent),
    ...withoutReserved(spec.passEnv, reservedName(provider)),
    ANTHROPIC_BASE_URL: provider.baseUrl,
    ANTHROPIC_AUTH_TOKEN: key,
    ...aliasEnv(provider),
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CONFIG_DIR: configDir,
  };
}

/** True for a CLAUDE* name on CLAUDE_ENV_DENYLIST (exact entry, or a `PREFIX_*` entry) or a credential-shaped one. */
function isDeniedClaudeName(name: string): boolean {
  if (!name.startsWith("CLAUDE")) return false;
  const denied = CLAUDE_ENV_DENYLIST.some((entry) =>
    entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : entry === name,
  );
  return denied || CREDENTIAL_WORDS.some((word) => name.split("_").includes(word));
}

/** The orchestrator's CLAUDE* settings (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, …), minus the denylist. Nothing is defaulted:
 *  a variable the parent did not set stays unset in the worker. */
export function pickClaudeSettings(
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (name.startsWith("CLAUDE") && value !== undefined && !isDeniedClaudeName(name)) env[name] = value;
  }
  return env;
}

/** Brief `env` names are orchestrator-written, so a typo like `env: [ANTHROPIC_API_KEY]` must not be able to send the
 *  orchestrator's Anthropic credentials to the provider, nor re-route or re-configure the worker. CLAUDE* settings may
 *  be named, except CLAUDE_ENV_DENYLIST, credential-shaped ones and the provider's own key names. */
function reservedName(provider: Provider): (name: string) => boolean {
  const keyNames = new Set(provider.keyEnv);
  return (name: string) =>
    name.startsWith("ANTHROPIC_") ||
    isDeniedClaudeName(name) ||
    name === "API_TIMEOUT_MS" ||
    keyNames.has(name);
}

export interface ClaudeHeadlessOptions {
  /** Whose models the worker runs and how it is reached: routing, alias mapping and reserved names come from it. */
  readonly provider: Provider;
  /** `claude` by default; tests point it at test/support/fake-claude.ts. */
  readonly bin: string;
  readonly configDir: string;
  /** The provider key loader's result; the worker uses the value, the host reports the source. */
  readonly loadKey: () => Promise<Result<ProviderKey, WorkerError>>;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** Between SIGTERM and SIGKILL when the run is stopped. */
  readonly stopGraceMs: number;
  /** stream-json line parser; domain/stream-parse.ts parseStreamLine by default. Injectable so the process plumbing
   *  can be tested on its own. */
  readonly parse?: (line: string) => Result<readonly WorkerEvent[], string>;
}

/** Spawns detached (own process group), writes the prompt to stdin, tees stdout to spec.logPath, yields parsed events,
 *  enforces spec.timeoutMs by terminating the group. One process per attempt, so there is nothing to dispose. */
export class ClaudeHeadlessWorker implements Worker {
  readonly caps = CLAUDE_CAPS;
  // A plain field, not a parameter property: Node runs src/ with type stripping, which only erases syntax.
  private readonly options: ClaudeHeadlessOptions;

  constructor(options: ClaudeHeadlessOptions) {
    this.options = options;
  }

  /** The key loads; the binary is only found by starting it. */
  async preflight(): Promise<Result<void, WorkerError>> {
    const key = await this.options.loadKey();
    return key.ok ? ok(undefined) : key;
  }

  parseLine(line: string): readonly WorkerEvent[] {
    const events = (this.options.parse ?? parseStreamLine)(line);
    return events.ok ? events.value : [];
  }

  async dispose(): Promise<void> {}

  async start(spec: WorkerSpec): Promise<Result<WorkerRun, WorkerError>> {
    const key = await this.options.loadKey();
    if (!key.ok) return key;
    const child = await startStreaming({
      command: this.options.bin,
      args: buildClaudeArgs(spec),
      cwd: spec.cwd,
      env: buildWorkerEnv(
        this.options.provider,
        spec,
        key.value.value,
        this.options.parentEnv,
        this.options.configDir,
      ),
      stdin: spec.prompt,
      logPath: spec.logPath,
      timeoutMs: spec.timeoutMs,
      graceMs: KILL_GRACE_MS,
      // Its stream-json lines carry whole tool results: no line is too long to keep.
      maxLineBytes: Number.POSITIVE_INFINITY,
      // Background shells it started would outlive it and hold stdout open: the group goes with its leader.
      reapGroupOnExit: true,
    });
    if (!child.ok) return err({ kind: "spawn_failed", message: child.error });
    const { pid, lines, exit, interrupt } = child.value;
    const { stopGraceMs } = this.options;
    return ok({
      pid,
      events: this.parsed(lines),
      exit: exit.then((ended) => withSession(spec, ended)),
      // Claude Code has no stop request: SIGTERM lets it stop its tools, then the group is killed.
      interrupt: (reason) => interrupt(reason, reason === "stopped" ? stopGraceMs : KILL_GRACE_MS),
    });
  }

  /** Lines the parser rejects are skipped: they stay in the raw log, and one bad line must not end the stream. */
  private async *parsed(lines: AsyncIterable<string>): AsyncGenerator<WorkerEvent> {
    for await (const line of lines) yield* this.parseLine(line);
  }
}

function withSession(spec: WorkerSpec, exit: ProcessExit): WorkerExit {
  return { ...exit, sessionMissing: claudeSessionMissing(spec.session, exit.stderrTail) };
}
