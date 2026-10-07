/**
 * The omp RPC engine as a `Worker`: one omp process per attempt, driven over its RPC protocol. The
 * process plumbing lives in the client; this adapter owns the argv, the environment, the session key omp assigns, and
 * the fold from frames to WorkerEvents. omp runs as the user set it up — its own login, provider, default model,
 * extensions and rules; the adapter names no model and writes no config, and only narrows the tools to the job's
 * access. omp has no native schema, so the report rides in the final assistant text and is checked here (and again by
 * the core) before it is accepted.
 */
import { appendFile } from "node:fs/promises";
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
import type { ProcessExit } from "../../process/stream.ts";
import { toolEnv } from "../shared/env.ts";
import { asCount, asRecord, asString, firstStringValue, textOf } from "../shared/fields.ts";
import { parseJsonLine } from "../shared/jsonl.ts";
import { reportedModel } from "../shared/model.ts";
import { type ReportTurns, runReportTurns } from "../shared/report-turns.ts";
import { type EventFilter, type OmpRpcClient, type RpcError, startOmpRpc, type TurnEnd } from "./client.ts";
import type { Frame } from "./frames.ts";
import { isPromptResult, isResponse, type PromptError, type PromptResult } from "./messages.ts";

const OMP_RPC_CAPS: WorkerCapabilities = {
  name: "omp-rpc",
  /** omp owns the session: get_state reports the id, --resume takes it back. */
  sessionKey: "engine",
  nativeSchema: false,
  budget: false,
  efforts: ["low", "high", "max"],
  briefNotes: {
    effort: "Passed to omp as --thinking (low, high or max).",
    addDirs: "Each additional directory is passed as its own --add-dir.",
    budgetUsd: "omp has no budget control; a brief that sets a budget is refused before the run starts.",
    readonly: "omp has no readonly mode; the tool allowlist is narrowed to read,grep,glob instead.",
  },
};

interface OmpRpcOptions {
  /** The omp binary; `omp` from PATH unless given. */
  readonly bin?: string;
  /** The orchestrator's environment: the user's own, passed on so omp finds its own setup. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** Names kept from omp: the plugin's own provider variables (its key, its `<PREFIX>_` knobs). */
  readonly withheld: (name: string) => boolean;
  readonly stopGraceMs: number;
  readonly handshakeTimeoutMs: number;
}

/** The tools each access runs with; omp's `--tools` is a plain allowlist, so write also drops the approvals gate. */
function toolsFor(access: WorkerSpec["access"]): readonly string[] {
  return access === "readonly"
    ? ["read", "grep", "glob"]
    : ["read", "grep", "glob", "edit", "write", "bash", "todo"];
}

/** No --model: omp runs on whatever model its own setup defaults to. */
function buildOmpArgs(spec: WorkerSpec): string[] {
  const args = [
    "--mode",
    "rpc",
    "--no-ui",
    ...(spec.effort === undefined ? [] : ["--thinking", spec.effort]),
    "--tools",
    toolsFor(spec.access).join(","),
    ...(spec.access === "readonly" ? [] : ["--approval-mode", "yolo"]),
    "--no-title",
  ];
  for (const dir of spec.addDirs) args.push("--add-dir", dir);
  if (spec.session.kind === "resume") args.push("--resume", spec.session.key);
  return args;
}

/** A brief `env` name must not be able to re-route omp's own setup or hand it a key. */
function reservedName(name: string): boolean {
  return name.startsWith("PI_") || name.startsWith("OMP_") || name.endsWith("_API_KEY");
}

/** The user's own environment for omp, nothing of the plugin's provider added or kept. */
function buildOmpEnv(spec: WorkerSpec, options: OmpRpcOptions): Record<string, string> {
  return toolEnv(options.parentEnv, spec.passEnv, options.withheld, reservedName);
}

/** The commands log sits beside the frames log, named after it. */
function commandsLog(logPath: string): string {
  return logPath.replace(/\.jsonl$/, ".rpc-in.jsonl");
}

/** The frames the fold reads; message updates as deltas, not full rewrites. */
const EVENT_FILTER: EventFilter = {
  events: [
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "auto_retry_start",
    "auto_retry_end",
    "retry_fallback_applied",
    "auto_compaction_start",
    "auto_compaction_end",
    "notice",
  ],
  messageUpdates: "delta",
};

const SESSION_MISSING = /Session ".*" not found/i;
/** The synthetic log line appended after the run, which parseLine folds back into the result event. */
const ENGINE_RESULT = "engine_result";

type ResultEvent = Extract<WorkerEvent, { type: "result" }>;

/** "429 High concurrency…" → 429; anything else (or nothing) is not an HTTP status. */
const HTTP_STATUS = /^\d{3}/;

function foldFrame(frame: Frame): readonly WorkerEvent[] {
  switch (frame.type) {
    case "response":
      return foldResponse(frame);
    case "message_update":
      return foldUpdate(frame);
    case "message_end":
      return foldMessageEnd(frame);
    case "tool_execution_start":
      return foldToolStart(frame);
    case "tool_execution_end":
      return [{ type: "tool_result", isError: frame.isError === true }];
    case "auto_retry_start":
      return foldRetry(frame);
    case "prompt_result":
      return foldPromptResult(frame);
    case ENGINE_RESULT:
      return foldEngineResult(frame);
    default:
      return [];
  }
}

function foldResponse(frame: Frame): readonly WorkerEvent[] {
  if (!isResponse(frame)) return [];
  if (!frame.success) {
    return [{ type: "error", message: frame.error ?? `omp refused ${frame.command}`, status: null }];
  }
  const sessionId = asString(asRecord(frame.data).sessionId);
  return frame.command === "get_state" && sessionId !== undefined ? [{ type: "session", sessionId }] : [];
}

function foldUpdate(frame: Frame): readonly WorkerEvent[] {
  const update = asRecord(frame.assistantMessageEvent);
  const text = update.type === "text_delta" ? asString(update.delta) : undefined;
  return text === undefined ? [] : [{ type: "text_delta", text }];
}

function foldMessageEnd(frame: Frame): readonly WorkerEvent[] {
  const message = asRecord(frame.message);
  if (message.role !== "assistant") return [];
  const events: WorkerEvent[] = [];
  const text = textOf(message.content);
  if (text !== "") events.push({ type: "assistant_text", text });
  if (message.stopReason === "error") {
    events.push({
      type: "error",
      message: asString(message.errorMessage) ?? "omp ended an assistant message in error",
      status: null,
    });
  }
  return events;
}

function foldToolStart(frame: Frame): readonly WorkerEvent[] {
  const name = asString(frame.toolName);
  if (name === undefined) return [];
  const summary = firstStringValue(asRecord(frame.args)) ?? asString(frame.intent) ?? "";
  return [{ type: "tool_use", name, summary }];
}

function foldRetry(frame: Frame): readonly WorkerEvent[] {
  const status = HTTP_STATUS.exec(asString(frame.errorMessage) ?? "")?.[0];
  return [
    {
      type: "api_retry",
      attempt: asCount(frame.attempt),
      maxRetries: asCount(frame.maxAttempts),
      status: status === undefined ? null : Number(status),
    },
  ];
}

function foldPromptResult(frame: Frame): readonly WorkerEvent[] {
  if (!isPromptResult(frame) || frame.status !== "error" || frame.error === undefined) return [];
  return [{ type: "error", message: frame.error.message, status: frame.error.httpStatus ?? null }];
}

function foldEngineResult(frame: Frame): readonly WorkerEvent[] {
  const usage = asRecord(frame.usage);
  return [
    {
      type: "result",
      isError: frame.isError === true,
      text: asString(frame.text) ?? "",
      structuredOutput: frame.structuredOutput ?? null,
      turns: asCount(frame.turns),
      durationMs: asCount(frame.durationMs),
      costUsd: asCount(frame.costUsd),
      usage: {
        inputTokens: asCount(usage.inputTokens),
        outputTokens: asCount(usage.outputTokens),
        cacheReadTokens: asCount(usage.cacheReadTokens),
        cacheWriteTokens: asCount(usage.cacheWriteTokens),
      },
      apiErrorStatus: typeof frame.apiErrorStatus === "number" ? frame.apiErrorStatus : null,
      ...(typeof frame.model === "string" ? { model: frame.model } : {}),
    },
  ];
}

export class OmpRpcWorker implements Worker {
  readonly caps = OMP_RPC_CAPS;
  // A plain field, not a parameter property: Node runs src/ with type stripping, which only erases syntax.
  private readonly options: OmpRpcOptions;

  constructor(options: OmpRpcOptions) {
    this.options = options;
  }

  parseLine(line: string): readonly WorkerEvent[] {
    const frame = parseJsonLine(line);
    return frame === undefined ? [] : foldFrame(frame as Frame);
  }

  /** omp brings its own login; there is nothing of the plugin's to check before it starts. */
  async preflight(): Promise<Result<void, WorkerError>> {
    return ok(undefined);
  }

  async dispose(): Promise<void> {}

  async start(spec: WorkerSpec): Promise<Result<WorkerRun, WorkerError>> {
    const started = await startOmpRpc({
      command: this.options.bin ?? "omp",
      args: buildOmpArgs(spec),
      cwd: spec.cwd,
      env: buildOmpEnv(spec, this.options),
      timeoutMs: spec.timeoutMs,
      graceMs: this.options.stopGraceMs,
      log: { stdout: spec.logPath, stdin: commandsLog(spec.logPath), promptRef: "job.json#prompt" },
    });
    if (!started.ok) return err({ kind: "spawn_failed", message: started.error.message });
    const client = started.value;
    const shake = await client.handshake({
      eventFilter: EVENT_FILTER,
      timeoutMs: this.options.handshakeTimeoutMs,
      expectTools: toolsFor(spec.access),
    });
    if (shake.ok) return ok(drive(client, spec));
    const failed = handshakeError(shake.error);
    return failed === undefined ? ok(finishedRun(client, spec)) : err(failed);
  }
}

/** The handshake's RpcError in the port's terms; `exited` is not a WorkerError (the run finished without starting). */
function handshakeError(error: RpcError): WorkerError | undefined {
  switch (error.kind) {
    case "start":
      return { kind: "spawn_failed", message: error.message };
    case "protocol":
    case "rejected":
    case "timeout":
    case "closed":
      return { kind: "protocol", message: error.message };
    case "exited":
      return undefined;
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

/** Sums over the assistant messages the run has folded so far; the driver reads it once the turns are over. */
interface TurnTally {
  /** Text of the last assistant message_end (where the report rides). */
  finalText: string;
  lastStopReason: string;
  turns: number;
  /** The model the tool stamped on its last assistant message. */
  model: string | undefined;
  readonly usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
}

function emptyTally(): TurnTally {
  return {
    finalText: "",
    lastStopReason: "",
    turns: 0,
    model: undefined,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
  };
}

function tallyFrame(tally: TurnTally, frame: Frame): void {
  if (frame.type !== "message_end") return;
  const message = asRecord(frame.message);
  if (message.role !== "assistant") return;
  tally.turns += 1;
  tally.model = reportedModel(message) ?? tally.model;
  tally.finalText = textOf(message.content);
  tally.lastStopReason = asString(message.stopReason) ?? "";
  const usage = asRecord(message.usage);
  tally.usage.input += asCount(usage.input);
  tally.usage.output += asCount(usage.output);
  tally.usage.cacheRead += asCount(usage.cacheRead);
  tally.usage.cacheWrite += asCount(usage.cacheWrite);
  tally.costUsd += asCount(asRecord(usage.cost).total);
}

/** The eager run: frames are folded and queued from the moment `start` returns, whatever the caller does with them. */
function drive(client: OmpRpcClient, spec: WorkerSpec): WorkerRun {
  const events = createQueue<WorkerEvent>();
  const tally = emptyTally();
  const pumped = (async () => {
    for await (const frame of client.frames) {
      tallyFrame(tally, frame);
      for (const event of foldFrame(frame)) events.push(event);
    }
  })();
  void driveRun(client, spec, events, tally, pumped).catch(() => events.close());
  return {
    pid: client.pid,
    events: events.items,
    exit: client.exit.then((ended) => workerExit(ended, spec)),
    interrupt: (reason) => client.interrupt(reason),
  };
}

/**
 * Drives the run to its end: the turns, then stdin closed so omp drains and exits, then every remaining frame folded
 * (the exit promise resolves with the logs closed, and `pumped` ends with the frames), and only then the synthesized
 * result, as the last event and as one synthetic line in the log.
 */
async function driveRun(
  client: OmpRpcClient,
  spec: WorkerSpec,
  events: Queue<WorkerEvent>,
  tally: TurnTally,
  pumped: Promise<void>,
): Promise<void> {
  const span = await runReportTurns<TurnEnd>(
    {
      prompt: async (text) => {
        const turn = await client.prompt(text);
        return turn.ok ? turn.value : undefined;
      },
      finalText: () => tally.finalText,
      // A turn omp ended in error has nothing to correct.
      failed: (turn) => turn.result.status !== "completed",
    },
    spec,
  );
  await client.close();
  await pumped;
  if (span !== undefined) {
    const result = synthesizeResult(span, tally);
    events.push(result);
    await appendFile(spec.logPath, `${JSON.stringify({ ...result, type: ENGINE_RESULT })}\n`);
  }
  events.close();
}

function synthesizeResult(span: ReportTurns<TurnEnd>, tally: TurnTally): ResultEvent {
  const failure = promptFailure(span.last.result);
  const unfinished = span.last.result.status === "completed" && tally.lastStopReason !== "stop";
  return {
    type: "result",
    isError: failure !== undefined || unfinished,
    text:
      failure?.message ??
      (unfinished
        ? `worker stopped without finishing (stopReason ${tally.lastStopReason})`
        : tally.finalText),
    structuredOutput: span.value,
    turns: tally.turns,
    durationMs: span.endedAt - span.startedAt,
    costUsd: tally.costUsd,
    usage: {
      inputTokens: tally.usage.input,
      outputTokens: tally.usage.output,
      cacheReadTokens: tally.usage.cacheRead,
      cacheWriteTokens: tally.usage.cacheWrite,
    },
    apiErrorStatus: failure?.httpStatus ?? null,
    ...(tally.model === undefined ? {} : { model: tally.model }),
  };
}

function promptFailure(result: PromptResult): PromptError | undefined {
  return result.status === "error"
    ? (result.error ?? { message: "omp ended the turn in error without saying why" })
    : undefined;
}

/** An omp that died before the handshake ran nothing: no events, the exit carries the whole story. */
function finishedRun(client: OmpRpcClient, spec: WorkerSpec): WorkerRun {
  const events = createQueue<WorkerEvent>();
  events.close();
  // The client's frame queue must always be drained; the events queue is closed, so the folds go nowhere.
  void (async () => {
    for await (const frame of client.frames) for (const event of foldFrame(frame)) events.push(event);
  })();
  return {
    pid: client.pid,
    events: events.items,
    exit: client.exit.then((ended) => workerExit(ended, spec)),
    interrupt: (reason) => client.interrupt(reason),
  };
}
