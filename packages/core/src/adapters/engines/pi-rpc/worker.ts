/**
 * The pi RPC engine as a `Worker`: one pi process per attempt, driven over its RPC protocol (pi 1.0.4). The process
 * plumbing lives in the client; this adapter owns the argv, the environment, the session key the caller assigns, and
 * the fold from frames to WorkerEvents. pi runs as the user set it up — its own login, provider, default model,
 * extensions, skills and context files; the adapter names no model and writes no config, and only narrows the tools of
 * a readonly job. pi has no native schema, so the report rides in the final assistant text and is checked here (and
 * again by the core) before it is accepted.
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
import { type PiRpcClient, type RpcError, startPiRpc, type TurnEnd } from "./client.ts";
import type { Frame } from "./frames.ts";
import { isResponse } from "./messages.ts";

const PI_RPC_CAPS: WorkerCapabilities = {
  name: "pi-rpc",
  /** The caller owns the session: its key is passed as --session-id, which pi creates when missing. */
  sessionKey: "caller",
  nativeSchema: false,
  budget: false,
  efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  briefNotes: {
    effort: "Passed to pi as --thinking (off, minimal, low, medium, high, xhigh or max).",
    addDirs: "pi has no extra mounts; directories beyond the job's own are not passed on.",
    budgetUsd: "pi has no budget control; a brief that sets a budget is refused before the run starts.",
    readonly: "pi has no readonly mode; the tool allowlist is narrowed to read,grep,find,ls instead.",
  },
};

interface PiRpcOptions {
  /** The pi binary; `pi` from PATH unless given. */
  readonly bin?: string;
  /** The orchestrator's environment: the user's own, passed on so pi finds its own setup. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** Names kept from pi: the plugin's own provider variables (its key, its `<PREFIX>_` knobs). */
  readonly withheld: (name: string) => boolean;
  readonly stopGraceMs: number;
  readonly handshakeTimeoutMs: number;
}

/** The tools a readonly run narrows to; exec and write keep pi's own default toolset. */
function readonlyTools(): readonly string[] {
  return ["read", "grep", "find", "ls"];
}

/** No --model: pi runs on whatever model its own setup defaults to. */
function buildPiArgs(spec: WorkerSpec): string[] {
  const args = ["--mode", "rpc", ...(spec.effort === undefined ? [] : ["--thinking", spec.effort])];
  if (spec.access === "readonly") args.push("--tools", readonlyTools().join(","));
  args.push("--session-id", spec.session.key);
  return args;
}

/** A brief `env` name must not be able to re-route pi's own setup or hand it a key. */
function reservedName(name: string): boolean {
  return name.startsWith("PI_") || name.endsWith("_API_KEY");
}

/** The user's own environment for pi, nothing of the plugin's provider added or kept. */
function buildPiEnv(spec: WorkerSpec, options: PiRpcOptions): Record<string, string> {
  return toolEnv(options.parentEnv, spec.passEnv, options.withheld, reservedName);
}

/** The commands log sits beside the frames log, named after it. */
function commandsLog(logPath: string): string {
  return logPath.replace(/\.jsonl$/, ".rpc-in.jsonl");
}

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
    case ENGINE_RESULT:
      return foldEngineResult(frame);
    default:
      return [];
  }
}

function foldResponse(frame: Frame): readonly WorkerEvent[] {
  if (!isResponse(frame)) return [];
  if (!frame.success) {
    return [{ type: "error", message: frame.error ?? `pi refused ${frame.command}`, status: null }];
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
      message: asString(message.errorMessage) ?? "pi ended an assistant message in error",
      status: null,
    });
  }
  return events;
}

function foldToolStart(frame: Frame): readonly WorkerEvent[] {
  const name = asString(frame.toolName);
  if (name === undefined) return [];
  return [{ type: "tool_use", name, summary: firstStringValue(asRecord(frame.args)) ?? "" }];
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
        cacheWriteTokens: asCount(usage.writeTokens ?? usage.cacheWriteTokens),
      },
      apiErrorStatus: typeof frame.apiErrorStatus === "number" ? frame.apiErrorStatus : null,
      ...(typeof frame.model === "string" ? { model: frame.model } : {}),
    },
  ];
}

export class PiRpcWorker implements Worker {
  readonly caps = PI_RPC_CAPS;
  // A plain field, not a parameter property: Node runs src/ with type stripping, which only erases syntax.
  private readonly options: PiRpcOptions;

  constructor(options: PiRpcOptions) {
    this.options = options;
  }

  parseLine(line: string): readonly WorkerEvent[] {
    const frame = parseJsonLine(line);
    return frame === undefined ? [] : foldFrame(frame as Frame);
  }

  /** pi brings its own login; there is nothing of the plugin's to check before it starts. */
  async preflight(): Promise<Result<void, WorkerError>> {
    return ok(undefined);
  }

  async start(spec: WorkerSpec): Promise<Result<WorkerRun, WorkerError>> {
    const started = await startPiRpc({
      command: this.options.bin ?? "pi",
      args: buildPiArgs(spec),
      cwd: spec.cwd,
      env: buildPiEnv(spec, this.options),
      timeoutMs: spec.timeoutMs,
      graceMs: this.options.stopGraceMs,
      log: { stdout: spec.logPath, stdin: commandsLog(spec.logPath), promptRef: "job.json#prompt" },
    });
    if (!started.ok) return err({ kind: "spawn_failed", message: started.error.message });
    const client = started.value;
    const shake = await client.handshake({ timeoutMs: this.options.handshakeTimeoutMs });
    if (shake.ok) return ok(drive(client, spec));
    const failed = handshakeError(shake.error);
    return failed === undefined ? ok(finishedRun(client)) : err(failed);
  }

  async dispose(): Promise<void> {}
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

function workerExit(ended: ProcessExit): WorkerExit {
  return {
    code: ended.code,
    signal: ended.signal,
    stderrTail: ended.stderrTail,
    forced: ended.forced,
    // pi creates the session id it is handed, so a resume never finds nothing.
    sessionMissing: false,
  };
}

/** Sums over the assistant messages the run has folded so far; the driver reads it once the turns are over. */
interface TurnTally {
  /** Text of the last assistant message_end (where the report rides). */
  finalText: string;
  lastStopReason: string;
  /** The last assistant errorMessage, when a message ended in error. */
  lastError: string;
  turns: number;
  /** The model the tool stamped on its last assistant message. */
  model: string | undefined;
  readonly usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  /** The message still streaming: pi reports its usage cumulatively on every message_update. */
  pending: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
}

function emptyTally(): TurnTally {
  return {
    finalText: "",
    lastStopReason: "",
    lastError: "",
    turns: 0,
    model: undefined,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    pending: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  };
}

/** pi streams the running usage on every message_update and seals it in the assistant message end; both carry the same
 *  numbers, so the tally takes whichever the frame offers (the cost is `usage.cost.total`). */
function tallyFrame(tally: TurnTally, frame: Frame): void {
  if (frame.type === "message_update") {
    const usage = asRecord(frame.usage);
    tally.pending.input = asCount(usage.input);
    tally.pending.output = asCount(usage.output);
    tally.pending.cacheRead = asCount(usage.cacheRead);
    tally.pending.cacheWrite = asCount(usage.cacheWrite);
    tally.pending.costUsd = asCount(asRecord(usage.cost).total);
    return;
  }
  if (frame.type !== "message_end") return;
  const message = asRecord(frame.message);
  if (message.role !== "assistant") return;
  tally.turns += 1;
  tally.model = reportedModel(message) ?? tally.model;
  tally.finalText = textOf(message.content);
  tally.lastStopReason = asString(message.stopReason) ?? "";
  if (message.stopReason === "error") {
    tally.lastError = asString(message.errorMessage) ?? "pi ended an assistant message in error";
  }
  const usage = asRecord(message.usage);
  tally.usage.input += pick(usage.input, tally.pending.input);
  tally.usage.output += pick(usage.output, tally.pending.output);
  tally.usage.cacheRead += pick(usage.cacheRead, tally.pending.cacheRead);
  tally.usage.cacheWrite += pick(usage.cacheWrite, tally.pending.cacheWrite);
  tally.costUsd += pick(asRecord(usage.cost).total, tally.pending.costUsd);
  tally.pending = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
}

function pick(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The eager run: frames are folded and queued from the moment `start` returns, whatever the caller does with them. */
function drive(client: PiRpcClient, spec: WorkerSpec): WorkerRun {
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
    exit: client.exit.then(workerExit),
    interrupt: (reason) => client.interrupt(reason),
  };
}

/** pi's last assistant message can end with no text parts although the session holds one; pi keeps the answer itself. */
async function recoverFinalText(client: PiRpcClient, tally: TurnTally): Promise<void> {
  if (tally.lastStopReason !== "stop" || tally.finalText !== "") return;
  const text = await client.lastAssistantText();
  if (text.ok && text.value !== "") tally.finalText = text.value;
}

/**
 * Drives the run to its end: the turns, then stdin closed so pi saves its session and exits, then every remaining
 * frame folded (the exit promise resolves with the logs closed, and `pumped` ends with the frames), and only then the
 * synthesized result, as the last event and as one synthetic line in the log.
 */
async function driveRun(
  client: PiRpcClient,
  spec: WorkerSpec,
  events: Queue<WorkerEvent>,
  tally: TurnTally,
  pumped: Promise<void>,
): Promise<void> {
  const span = await runReportTurns<TurnEnd>(
    {
      prompt: async (text) => {
        const turn = await client.prompt(text);
        if (!turn.ok) return undefined;
        await recoverFinalText(client, tally);
        return turn.value;
      },
      finalText: () => tally.finalText,
      // pi reports engine failures on the message stream; there is nothing to correct after one.
      failed: () => tally.lastStopReason === "error",
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
  const error = tally.lastStopReason === "error";
  const unfinished = !error && tally.lastStopReason !== "stop";
  const status = error ? HTTP_STATUS.exec(tally.lastError)?.[0] : undefined;
  return {
    type: "result",
    isError: error || unfinished,
    text: error
      ? tally.lastError
      : unfinished
        ? `worker stopped without finishing (stopReason ${tally.lastStopReason})`
        : tally.finalText,
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
    apiErrorStatus: status === undefined ? null : Number(status),
    ...(tally.model === undefined ? {} : { model: tally.model }),
  };
}

/** A pi that died before the handshake ran nothing: no events, the exit carries the whole story. */
function finishedRun(client: PiRpcClient): WorkerRun {
  const events = createQueue<WorkerEvent>();
  events.close();
  // The client's frame queue must always be drained; the events queue is closed, so the folds go nowhere.
  void (async () => {
    for await (const frame of client.frames) for (const event of foldFrame(frame)) events.push(event);
  })();
  return {
    pid: client.pid,
    events: events.items,
    exit: client.exit.then(workerExit),
    interrupt: (reason) => client.interrupt(reason),
  };
}
