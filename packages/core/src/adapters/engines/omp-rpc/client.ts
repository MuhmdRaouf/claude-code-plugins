/**
 * A client for one `omp --mode rpc --no-ui` process: frame decoding, command/response correlation, the
 * handshake, the host-tool sub-protocol, prompt completion and close semantics. Every inbound frame is also passed
 * through, in order, on `frames`, which is what the attempt log holds and what the event fold reads.
 */
import { err, ok, type Result } from "../../../domain/result.ts";
import { createQueue } from "../../process/lines.ts";
import {
  type ProcessExit,
  type StderrListener,
  type StreamingProcess,
  startStreaming,
} from "../../process/stream.ts";
import { asRecord } from "../shared/fields.ts";
import { logText, openRpcLogs, type RpcLogPaths, type RpcLogs } from "../shared/rpc-log.ts";
import { createFrameDecoder, type Decoded, type Frame, MAX_FRAME_BYTES } from "./frames.ts";
import {
  type HostToolCall,
  isHostToolCall,
  isHostToolCancel,
  isPromptResult,
  isReady,
  isResponse,
  type PromptResult,
  type ReadyFrame,
  type RpcResponse,
} from "./messages.ts";

/** O0 measured a solo `ready` at 1.6–8 s and 15–18 s under 12–16 concurrent spawns. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 45_000;

/** How omp is started. A bare client applies no wall clock of its own; the worker always passes one. */
interface OmpCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Wall clock after which the run is interrupted with reason "timeout". */
  readonly timeoutMs?: number;
  /** Between the RPC abort and SIGTERM, and between SIGTERM and SIGKILL. */
  readonly graceMs?: number;
}

/** omp prints these while a slow startup phase runs (O0: up to 18 s under 16 concurrent spawns). */
const BENIGN_STDERR = /^Still starting after \d+s\b/;

function isBenignStderr(line: string): boolean {
  return BENIGN_STDERR.test(line);
}

export type RpcError =
  /** The binary could not be started, or a log could not be opened. */
  | { readonly kind: "start"; readonly message: string }
  /** The process ended (or its output did) before the answer came. */
  | { readonly kind: "exited"; readonly message: string; readonly exit: ProcessExit }
  | { readonly kind: "timeout"; readonly message: string }
  /** omp spoke something the client cannot trust: no protocol 2, a broken chunk sequence, unexpected tools. */
  | { readonly kind: "protocol"; readonly message: string }
  /** omp answered `success: false`. */
  | { readonly kind: "rejected"; readonly message: string; readonly command: string }
  /** stdin was already closed. */
  | { readonly kind: "closed"; readonly message: string };

export interface HostToolSpec {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** "essential" mounts the tool directly; the default ("discoverable") adds `write` to a read-only worker (O0 P3). */
  readonly loadMode?: "essential" | "discoverable";
}

export interface EventFilter {
  readonly events: readonly string[];
  readonly messageUpdates?: string;
}

export interface HostToolReply {
  readonly text: string;
  readonly isError?: boolean;
}

/** Runs a host tool. `signal` aborts when omp sends `host_tool_cancel`; nothing is replied after that. */
export type HostToolHandler = (
  call: HostToolCall,
  signal: AbortSignal,
) => HostToolReply | Promise<HostToolReply>;

export interface OmpRpcOptions extends OmpCommand {
  readonly log?: RpcLogPaths;
  readonly onHostToolCall?: HostToolHandler;
  readonly onStderr?: StderrListener;
}

export interface HandshakeOptions {
  /** Mounted during the handshake; when empty `set_host_tools` is not sent and omp keeps its built-in tools. */
  readonly hostTools?: readonly HostToolSpec[];
  readonly eventFilter: EventFilter;
  /** Covers waiting for `ready` and every handshake response. */
  readonly timeoutMs: number;
  /** When given, `get_state.dumpTools[].name` must be exactly this set. */
  readonly expectTools?: readonly string[];
}

interface Handshake {
  readonly ready: ReadyFrame;
  /** `get_state`'s data: sessionId, sessionFile, model, dumpTools, systemPrompt… */
  readonly state: Readonly<Record<string, unknown>>;
}

export interface TurnEnd {
  readonly result: PromptResult;
  /** Epoch ms when the prompt was written, and when the turn was settled. */
  readonly promptSentAt: number;
  readonly endedAt: number;
}

/** A command as sent, without its id (the client assigns ids). */
export type RpcCommand = { readonly type: string } & Readonly<Record<string, unknown>>;

export interface OmpRpcClient {
  readonly pid: number;
  /** Every inbound frame in arrival order (chunked frames reassembled); ends with stdout. Must be kept draining:
   *  the queue buffers unread frames in memory without bound. */
  readonly frames: AsyncIterable<Frame>;
  /** Resolves once stdout is drained, the process has exited and the logs are closed. */
  readonly exit: Promise<ProcessExit>;
  /** On failure omp is killed: a peer that failed the handshake must not keep running unwatched. */
  handshake(options: HandshakeOptions): Promise<Result<Handshake, RpcError>>;
  /** Sends a command and waits for its response. */
  request(command: RpcCommand): Promise<Result<RpcResponse, RpcError>>;
  /** Runs one turn: the ack, then `prompt_result`, then `session_settled` only when `sessionSettled` is false. */
  prompt(message: string): Promise<Result<TurnEnd, RpcError>>;
  /** RPC `abort`: omp cancels the running tool and ends the turn with `prompt_result{aborted}`. */
  abort(): Promise<Result<RpcResponse, RpcError>>;
  /** Closes stdin and keeps reading until EOF: omp drains, disposes the session and exits 0. */
  close(): Promise<ProcessExit>;
  /** RPC `abort` and stdin closed first (the soft stop), then omp's process group is terminated. */
  interrupt(reason: "timeout" | "stopped"): Promise<void>;
  /** Signals omp's process group. */
  kill(signal: NodeJS.Signals): void;
}

/** `OMPCC_HANDSHAKE_TIMEOUT_MS` when it is a positive integer, else the default. */
export function handshakeTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const value = Number(env.OMPCC_HANDSHAKE_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_HANDSHAKE_TIMEOUT_MS;
}

export async function startOmpRpc(options: OmpRpcOptions): Promise<Result<OmpRpcClient, RpcError>> {
  const logs = await openRpcLogs(options.log);
  if (!logs.ok) return err({ kind: "start", message: logs.error });
  // The soft stop is omp's own cancel, so it only exists once the client does: the hook looks it up when fired.
  let softStop: () => Promise<void> = async () => {};
  const proc = await startStreaming(
    {
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      // omp's own frame budget, which happens to equal the shared default; frames.ts owns the number.
      maxLineBytes: MAX_FRAME_BYTES,
      isBenignStderr,
      soft: () => softStop(),
    },
    options.onStderr,
  );
  if (!proc.ok) {
    await logs.value.close();
    return err({ kind: "start", message: `cannot start ${options.command}: ${proc.error}` });
  }
  const client = connect(proc.value, logs.value, options.onHostToolCall);
  softStop = async () => {
    // The abort ends the running turn; closing stdin then lets omp drain and exit on its own.
    await client.abort();
    proc.value.endInput();
  };
  return ok(client);
}

interface PendingTurn {
  readonly resolve: (result: Result<TurnEnd, RpcError>) => void;
  readonly promptSentAt: number;
  /** Set once `prompt_result` said the session is not settled yet. */
  awaitingSettle?: PromptResult;
}

type Respond = (result: Result<RpcResponse, RpcError>) => void;

function connect(
  proc: StreamingProcess,
  logs: RpcLogs,
  onHostToolCall: HostToolHandler | undefined,
): OmpRpcClient {
  const frames = createQueue<Frame>();
  const pending = new Map<string, Respond>();
  const turns = new Map<string, PendingTurn>();
  const hostCalls = new Map<string, AbortController>();
  let nextId = 0;
  let inputClosed = false;
  let terminal: RpcError | undefined;
  let readyFrame: (result: Result<ReadyFrame, RpcError>) => void = () => {};
  const ready = new Promise<Result<ReadyFrame, RpcError>>((resolve) => {
    readyFrame = resolve;
  });

  const fail = (error: RpcError): void => {
    terminal ??= error;
    readyFrame(err(terminal));
    for (const respond of pending.values()) respond(err(terminal));
    pending.clear();
    for (const turn of turns.values()) turn.resolve(err(terminal));
    turns.clear();
    for (const controller of hostCalls.values()) controller.abort();
  };

  const send = (frame: RpcCommand): boolean => {
    if (inputClosed || terminal !== undefined) return false;
    logs.outbound(frame);
    return proc.write(JSON.stringify(frame));
  };

  const unavailable = (): RpcError =>
    terminal ?? { kind: "closed", message: "omp's stdin is closed; no further commands can be sent" };

  const call = (id: string, command: RpcCommand): Promise<Result<RpcResponse, RpcError>> => {
    if (inputClosed || terminal !== undefined) return Promise.resolve(err(unavailable()));
    const answer = new Promise<Result<RpcResponse, RpcError>>((resolve) => pending.set(id, resolve));
    send({ id, ...command });
    return answer;
  };

  const settle = (id: string, turn: PendingTurn, result: PromptResult): void => {
    turns.delete(id);
    turn.resolve(ok({ result, promptSentAt: turn.promptSentAt, endedAt: Date.now() }));
  };

  const onResponse = (response: RpcResponse): void => {
    const respond = response.id === undefined ? undefined : pending.get(response.id);
    if (respond === undefined || response.id === undefined) return;
    pending.delete(response.id);
    respond(
      response.success
        ? ok(response)
        : err({
            kind: "rejected",
            command: response.command,
            message: response.error ?? `omp refused ${response.command}`,
          }),
    );
  };

  const onPromptResult = (result: PromptResult): void => {
    const turn = turns.get(result.id);
    if (turn === undefined) return;
    if (result.sessionSettled || !result.agentInvoked) settle(result.id, turn, result);
    else turn.awaitingSettle = result;
  };

  const onSessionSettled = (): void => {
    for (const [id, turn] of turns)
      if (turn.awaitingSettle !== undefined) settle(id, turn, turn.awaitingSettle);
  };

  const onHostCall = (hostCall: HostToolCall): void => {
    const controller = new AbortController();
    hostCalls.set(hostCall.id, controller);
    runHostTool(onHostToolCall, hostCall, controller.signal)
      .then((reply) => {
        hostCalls.delete(hostCall.id);
        if (controller.signal.aborted) return;
        send({
          type: "host_tool_result",
          id: hostCall.id,
          result: { content: [{ type: "text", text: reply.text }] },
          ...(reply.isError === true ? { isError: true } : {}),
        });
      })
      .catch(() => {
        // omp waits on this call until it is answered, so even a broken reply path must send one.
        hostCalls.delete(hostCall.id);
        if (controller.signal.aborted) return;
        send({
          type: "host_tool_result",
          id: hostCall.id,
          isError: true,
          result: { content: [{ type: "text", text: `the handler for ${hostCall.toolName} crashed` }] },
        });
      });
  };

  const route = (frame: Frame): void => {
    if (isReady(frame)) readyFrame(ok(frame));
    else if (isResponse(frame)) onResponse(frame);
    else if (isPromptResult(frame)) onPromptResult(frame);
    else if (frame.type === "session_settled") onSessionSettled();
    else if (isHostToolCall(frame)) onHostCall(frame);
    else if (isHostToolCancel(frame)) hostCalls.get(frame.targetId)?.abort();
  };

  const dispatch = (decoded: Decoded, line: string): void => {
    if (decoded.kind === "frame") {
      logs.inbound(logText(decoded.frame, decoded.text));
      frames.push(decoded.frame);
      route(decoded.frame);
    } else if (decoded.kind === "malformed") logs.inbound(line);
    else if (decoded.kind === "error")
      fail({ kind: "protocol", message: `omp RPC stream: ${decoded.reason}` });
  };

  // One decoder for the whole stream, so the handshake can turn chunk decoding on the moment protocol 2 is agreed.
  const decoder = createFrameDecoder();

  const exit = (async () => {
    for await (const line of proc.lines) dispatch(decoder.push(line), line);
    const ended = await proc.exit;
    fail({ kind: "exited", message: describeExit(ended), exit: ended });
    frames.close();
    await logs.close();
    return ended;
  })();

  const handshakeSteps = async (options: HandshakeOptions): Promise<Result<Handshake, RpcError>> => {
    const readyResult = await ready;
    if (!readyResult.ok) return readyResult;
    const protocol = requireProtocol2(readyResult.value);
    if (!protocol.ok) return protocol;
    decoder.negotiated(readyResult.value.maxFrameBytes);
    const replies = await Promise.all(handshakeCommands(options).map(request));
    const failed = replies.find((reply) => !reply.ok);
    if (failed !== undefined) return failed as Result<never, RpcError>;
    const state = asRecord(stateData(replies[replies.length - 1]));
    const tools = checkTools(state, options.expectTools);
    return tools.ok ? ok({ ready: readyResult.value, state }) : tools;
  };

  const request = (command: RpcCommand): Promise<Result<RpcResponse, RpcError>> => {
    nextId += 1;
    return call(`c${nextId}`, command);
  };

  return {
    pid: proc.pid,
    frames: frames.items,
    exit,
    request,
    handshake: async (options) => {
      const result = await withTimeout(handshakeSteps(options), options.timeoutMs, {
        kind: "timeout",
        message: `omp did not complete the RPC handshake within ${options.timeoutMs} ms`,
      });
      // A peer the handshake gave up on keeps running unwatched; it must not outlive the attempt.
      if (!result.ok && result.error.kind !== "exited") {
        inputClosed = true;
        proc.endInput();
        proc.signal("SIGKILL");
      }
      return result;
    },
    async prompt(message) {
      nextId += 1;
      const id = `c${nextId}`;
      const promptSentAt = Date.now();
      const turn = new Promise<Result<TurnEnd, RpcError>>((resolve) =>
        turns.set(id, { resolve, promptSentAt }),
      );
      const ack = await call(id, { type: "prompt", message });
      if (!ack.ok) {
        turns.delete(id);
        return ack;
      }
      return turn;
    },
    abort: () => request({ type: "abort" }),
    close() {
      inputClosed = true;
      proc.endInput();
      return exit;
    },
    interrupt: (reason) => proc.interrupt(reason),
    kill: (signal) => proc.signal(signal),
  };
}

/** The handshake commands in send order; the `get_state` reply is always the last one. */
function handshakeCommands(options: HandshakeOptions): RpcCommand[] {
  const hostTools = options.hostTools ?? [];
  return [
    { type: "negotiate_protocol", protocolVersion: 2 },
    ...(hostTools.length > 0 ? [{ type: "set_host_tools", tools: hostTools }] : []),
    { type: "set_event_filter", ...options.eventFilter },
    { type: "get_state" },
  ];
}

function stateData(reply: Result<RpcResponse, RpcError> | undefined): unknown {
  return reply?.ok === true ? reply.value.data : undefined;
}

function requireProtocol2(ready: ReadyFrame): Result<void, RpcError> {
  const versions = ready.supportedProtocolVersions;
  if (versions.includes(2)) return ok(undefined);
  return err({ kind: "protocol", message: `omp offers RPC protocol ${versions.join(", ")}; 2 is required` });
}

async function runHostTool(
  handler: HostToolHandler | undefined,
  hostCall: HostToolCall,
  signal: AbortSignal,
): Promise<HostToolReply> {
  if (handler === undefined) return { text: `No host tool named ${hostCall.toolName}.`, isError: true };
  try {
    // The handler is host code; whatever it returns is only a reply once it says so.
    const reply = asRecord(await handler(hostCall, signal));
    return typeof reply.text === "string"
      ? { text: reply.text, ...(reply.isError === true ? { isError: true } : {}) }
      : { text: `the handler for ${hostCall.toolName} did not return a reply`, isError: true };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

function checkTools(
  state: Readonly<Record<string, unknown>>,
  expected: readonly string[] | undefined,
): Result<void, RpcError> {
  if (expected === undefined) return ok(undefined);
  const dump = Array.isArray(state.dumpTools) ? state.dumpTools : [];
  const names = dump.map((tool) => asRecord(tool).name).filter((name) => typeof name === "string");
  const same = names.length === expected.length && expected.every((name) => names.includes(name));
  if (same) return ok(undefined);
  return err({
    kind: "protocol",
    message: `omp exposes the tools [${names.join(", ")}], expected exactly [${expected.join(", ")}]`,
  });
}

function describeExit(exit: ProcessExit): string {
  const how = exit.signal === null ? `exit code ${exit.code}` : `signal ${exit.signal}`;
  const tail = exit.stderrTail.trim();
  return `omp ended (${how})${tail === "" ? "" : `: ${tail}`}`;
}

async function withTimeout<T>(
  work: Promise<Result<T, RpcError>>,
  ms: number,
  error: RpcError,
): Promise<Result<T, RpcError>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Result<T, RpcError>>((resolve) => {
    timer = setTimeout(() => resolve(err(error)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
