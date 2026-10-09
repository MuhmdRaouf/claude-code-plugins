/**
 * The opencode engine as a `Worker`: one `opencode run --format json` per attempt, the prompt as its last argv and
 * every event on stdout as one JSON object per line (shapes recorded from opencode 1.18.34). There is no RPC and no
 * stdin: the process exits when the run ends, so the exit is the turn boundary and exiting without a finished step is
 * a failure. opencode runs as the user set it up — its own login, provider, default model and config dirs; the adapter
 * names no model, provider, endpoint or key. The one thing it adds is the job's access: OPENCODE_CONFIG_CONTENT carries
 * only the edit and bash permissions, which opencode merges over the user's config. opencode leaves a server child
 * behind, so the rest of its group is reaped once the run's own process has exited.
 */
import { appendFile } from "node:fs/promises";
import { extractReport, reportInstructions } from "../../../domain/report-capture.ts";
import { err, ok, type Result } from "../../../domain/result.ts";
import type { WorkerEvent } from "../../../domain/worker-events.ts";
import type {
  Worker,
  WorkerCapabilities,
  WorkerError,
  WorkerExit,
  WorkerRun,
  WorkerSpec,
} from "../../../ports/worker.ts";
import { createQueue, type Queue } from "../../process/lines.ts";
import { type ProcessExit, type StreamingProcess, startStreaming } from "../../process/stream.ts";
import { toolEnv } from "../shared/env.ts";
import { asCount, asRecord, asString, firstStringValue } from "../shared/fields.ts";
import { parseJsonLine } from "../shared/jsonl.ts";

const OPENCODE_CAPS: WorkerCapabilities = {
  name: "opencode",
  /** opencode owns the session: every event carries the id, `--session` takes it back. */
  sessionKey: "engine",
  nativeSchema: false,
  budget: false,
  efforts: ["low", "high", "max"],
  briefNotes: {
    effort: "Passed to opencode as --variant (low, high or max).",
    addDirs:
      "opencode has no directory mounts; additional directories are ignored, the cwd is the workspace.",
    budgetUsd: "opencode has no budget control; a brief that sets a budget is refused before the run starts.",
    readonly: "opencode's edit and bash permissions are denied, so the model is never offered those tools.",
  },
};

interface OpenCodeOptions {
  /** The opencode binary; `opencode` from PATH unless given. */
  readonly bin?: string;
  /** The orchestrator's environment: the user's own, passed on so opencode finds its own setup. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** Names kept from opencode: the plugin's own provider variables (its key, its `<PREFIX>_` knobs). */
  readonly withheld: (name: string) => boolean;
  readonly stopGraceMs: number;
}

/** No -m: opencode runs on whatever model its own setup defaults to. */
function buildOpenCodeArgs(spec: WorkerSpec): string[] {
  return [
    "run",
    "--format",
    "json",
    ...(spec.effort === undefined ? [] : ["--variant", spec.effort]),
    // Denying a permission removes the tool entirely; `--auto` approves whatever the config leaves open.
    ...(spec.access === "readonly" ? [] : ["--auto"]),
    ...(spec.session.kind === "resume" ? ["--session", spec.session.key] : []),
    // Last: `run` takes the prompt as a free argument, so nothing that follows can be mistaken for an option.
    reportInstructions(spec.prompt, spec.report.jsonSchema),
  ];
}

/** The permission config per access: edit for changes, bash for running anything. */
function permissionsFor(access: WorkerSpec["access"]): { edit: string; bash: string } {
  if (access === "readonly") return { edit: "deny", bash: "deny" };
  return access === "exec" ? { edit: "deny", bash: "allow" } : { edit: "allow", bash: "allow" };
}

/** The job's access, handed over as OPENCODE_CONFIG_CONTENT (merged over the user's own config): permissions only. */
function configContent(spec: WorkerSpec): string {
  return JSON.stringify({ permission: permissionsFor(spec.access) });
}

/** A brief `env` name must not be able to re-route opencode's own setup or hand it a key. */
function reservedName(name: string): boolean {
  return name.startsWith("OPENCODE_") || name.startsWith("XDG_") || name.endsWith("_API_KEY");
}

/** The user's own environment for opencode — its own config, data and state dirs — plus the job's permissions. */
function buildOpenCodeEnv(spec: WorkerSpec, options: OpenCodeOptions): Record<string, string> {
  return {
    ...toolEnv(options.parentEnv, spec.passEnv, options.withheld, reservedName),
    OPENCODE_CONFIG_CONTENT: configContent(spec),
  };
}

/** What opencode says on stderr when `--session` names a session it does not have (ANSI colours around it). */
const SESSION_MISSING = /session not found/i;
/** The synthetic log line appended after the run, which parseLine folds back into the result event. */
const ENGINE_RESULT = "engine_result";

type ResultEvent = Extract<WorkerEvent, { type: "result" }>;
/** One stdout line as parsed: opencode's events are JSON objects, so anything else is not an event. */
type WireEvent = Readonly<Record<string, unknown>>;

/** opencode stamps every event with epoch milliseconds; anything else is not a time. */
function stampOf(event: WireEvent): number | undefined {
  return typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
    ? event.timestamp
    : undefined;
}

/** One stdout event → its WorkerEvents; types we do not track fold to nothing, they stay in the raw log. */
function foldEvent(event: WireEvent): readonly WorkerEvent[] {
  switch (asString(event.type)) {
    case "step_start":
      return sessionEvent(event);
    case "text": {
      const text = asString(asRecord(event.part).text);
      return text === undefined || text === "" ? [] : [{ type: "assistant_text", text }];
    }
    case "tool_use":
      return foldToolUse(event);
    case "error":
      return [{ type: "error", message: errorMessage(event), status: null }];
    case ENGINE_RESULT:
      return foldEngineResult(event);
    default:
      // step_finish is accounting the tally reads; reasoning and whatever else opencode adds stays raw.
      return [];
  }
}

/** The session id rides on every event; step_start opens a step, so it is where the id is first heard. */
function sessionEvent(event: WireEvent): readonly WorkerEvent[] {
  const sessionId = asString(event.sessionID);
  return sessionId === undefined ? [] : [{ type: "session", sessionId }];
}

/** A tool part carries its own outcome: the state's title or first input value says what the call was about. */
function foldToolUse(event: WireEvent): readonly WorkerEvent[] {
  const part = asRecord(event.part);
  const name = asString(part.tool);
  if (name === undefined) return [];
  const state = asRecord(part.state);
  const summary = asString(state.title) ?? firstStringValue(asRecord(state.input)) ?? "";
  if (state.status !== "completed" && state.status !== "error") return [{ type: "tool_use", name, summary }];
  return [
    { type: "tool_use", name, summary },
    { type: "tool_result", isError: state.status === "error" },
  ];
}

/** opencode nests the reason under the error's data; its name is the fallback. */
function errorMessage(event: WireEvent): string {
  const error = asRecord(event.error);
  return asString(asRecord(error.data).message) ?? asString(error.name) ?? "opencode reported an error";
}

function foldEngineResult(event: WireEvent): readonly WorkerEvent[] {
  const usage = asRecord(event.usage);
  return [
    {
      type: "result",
      isError: event.isError === true,
      text: asString(event.text) ?? "",
      structuredOutput: event.structuredOutput ?? null,
      turns: asCount(event.turns),
      durationMs: asCount(event.durationMs),
      costUsd: asCount(event.costUsd),
      usage: {
        inputTokens: asCount(usage.inputTokens),
        outputTokens: asCount(usage.outputTokens),
        cacheReadTokens: asCount(usage.cacheReadTokens),
        cacheWriteTokens: asCount(usage.cacheWriteTokens),
      },
      apiErrorStatus: typeof event.apiErrorStatus === "number" ? event.apiErrorStatus : null,
    },
  ];
}

export class OpenCodeWorker implements Worker {
  readonly caps = OPENCODE_CAPS;
  // A plain field, not a parameter property: Node runs src/ with type stripping, which only erases syntax.
  private readonly options: OpenCodeOptions;

  constructor(options: OpenCodeOptions) {
    this.options = options;
  }

  parseLine(line: string): readonly WorkerEvent[] {
    const event = parseJsonLine(line);
    return event === undefined ? [] : foldEvent(event);
  }

  /** opencode brings its own login; there is nothing of the plugin's to check before it starts. */
  async preflight(): Promise<Result<void, WorkerError>> {
    return ok(undefined);
  }

  async dispose(): Promise<void> {}

  async start(spec: WorkerSpec): Promise<Result<WorkerRun, WorkerError>> {
    const started = await startStreaming({
      command: this.options.bin ?? "opencode",
      args: buildOpenCodeArgs(spec),
      cwd: spec.cwd,
      env: buildOpenCodeEnv(spec, this.options),
      ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      graceMs: this.options.stopGraceMs,
      // opencode's happy runs print nothing on stderr; blank lines are terminal noise, not trouble.
      isBenignStderr: (line) => line.trim() === "",
      // opencode leaves its server child behind; the rest of the group is reaped once the leader has exited.
      reapGroupOnExit: true,
    });
    if (!started.ok) return err({ kind: "spawn_failed", message: started.error });
    // The prompt rides in argv; stdin is closed at once so nothing can wait on it.
    started.value.endInput();
    return ok(drive(started.value, spec));
  }
}

function workerExit(ended: ProcessExit, spec: WorkerSpec): WorkerExit {
  return {
    code: ended.code,
    signal: ended.signal,
    stderrTail: ended.stderrTail,
    forced: ended.forced,
    sessionMissing: spec.session.kind === "resume" && SESSION_MISSING.test(ended.stderrTail),
  };
}

/** Sums over the events the run has streamed so far; the driver reads it once the process has exited. */
interface RunTally {
  /** Text of the last text part (where the report rides). */
  finalText: string;
  /** The stream's own error message, when it reported one. */
  errorText: string | undefined;
  /** Whether any step finished: opencode's own marker that the model was done. */
  finished: boolean;
  turns: number;
  startedAt: number | undefined;
  endedAt: number | undefined;
  readonly usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
}

function emptyTally(): RunTally {
  return {
    finalText: "",
    errorText: undefined,
    finished: false,
    turns: 0,
    startedAt: undefined,
    endedAt: undefined,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
  };
}

function tallyEvent(tally: RunTally, event: WireEvent): void {
  const stamp = stampOf(event);
  if (stamp !== undefined) {
    tally.startedAt ??= stamp;
    tally.endedAt = stamp;
  }
  const type = asString(event.type);
  if (type === "text") {
    const text = asString(asRecord(event.part).text);
    if (text !== undefined && text !== "") tally.finalText = text;
    return;
  }
  if (type === "error") {
    tally.errorText ??= errorMessage(event);
    return;
  }
  if (type !== "step_finish") return;
  tally.finished = true;
  tally.turns += 1;
  const part = asRecord(event.part);
  const tokens = asRecord(part.tokens);
  const cache = asRecord(tokens.cache);
  tally.usage.input += asCount(tokens.input);
  tally.usage.output += asCount(tokens.output);
  tally.usage.cacheRead += asCount(cache.read);
  tally.usage.cacheWrite += asCount(cache.write);
  tally.costUsd += asCount(part.cost);
}

/** The eager run: lines are logged, tallied and folded from the moment `start` returns, whatever the caller does. */
function drive(proc: StreamingProcess, spec: WorkerSpec): WorkerRun {
  const events = createQueue<WorkerEvent>();
  const tally = emptyTally();
  const pumped = (async () => {
    for await (const line of proc.lines) {
      await appendFile(spec.logPath, `${line}\n`);
      const event = parseJsonLine(line);
      if (event === undefined) continue;
      tallyEvent(tally, event);
      for (const folded of foldEvent(event)) events.push(folded);
    }
  })();
  void driveRun(proc, spec, events, tally, pumped).catch(() => events.close());
  return {
    pid: proc.pid,
    events: events.items,
    exit: proc.exit.then((ended) => workerExit(ended, spec)),
    // opencode has no stop request: the group is terminated, the grace lets a tool's child die with it.
    interrupt: (reason) => proc.interrupt(reason),
  };
}

/**
 * Waits the run out: the exit (pipes closed or dropped), then the drained lines. A forced exit ran nothing to
 * completion, so the events close with no result — the exit tells the story. A natural exit always gets a result:
 * when the stream reported the failure itself that message stands, and when no step ever finished one error event
 * says so, so the log and the events carry the whole story either way.
 */
async function driveRun(
  proc: StreamingProcess,
  spec: WorkerSpec,
  events: Queue<WorkerEvent>,
  tally: RunTally,
  pumped: Promise<void>,
): Promise<void> {
  const ended = await proc.exit;
  await pumped;
  if (ended.forced !== null) {
    events.close();
    return;
  }
  if (!tally.finished && tally.errorText === undefined) {
    events.push({ type: "error", message: unfinishedMessage(ended), status: null });
  }
  const result = synthesizeResult(tally, ended);
  events.push(result);
  await appendFile(spec.logPath, `${JSON.stringify({ ...result, type: ENGINE_RESULT })}\n`);
  events.close();
}

function synthesizeResult(tally: RunTally, ended: ProcessExit): ResultEvent {
  const failure = tally.errorText ?? (tally.finished ? undefined : unfinishedMessage(ended));
  return {
    type: "result",
    isError: failure !== undefined,
    text: failure ?? tally.finalText,
    structuredOutput: failure === undefined ? extractReport(tally.finalText) : null,
    turns: tally.turns,
    durationMs:
      tally.startedAt === undefined || tally.endedAt === undefined ? 0 : tally.endedAt - tally.startedAt,
    costUsd: tally.costUsd,
    usage: {
      inputTokens: tally.usage.input,
      outputTokens: tally.usage.output,
      cacheReadTokens: tally.usage.cacheRead,
      cacheWriteTokens: tally.usage.cacheWrite,
    },
    // opencode reports failures as events, not HTTP statuses; there is no status to pass on.
    apiErrorStatus: null,
  };
}

function unfinishedMessage(ended: ProcessExit): string {
  return `opencode exited without a finished step (${ended.signal ?? `exit ${ended.code}`})`;
}
