/**
 * A client for one `pi --mode rpc` process (pi 1.0.4): frame decoding, command/response correlation, the
 * handshake, prompt completion and close semantics. Every inbound frame is also passed through, in order, on
 * `frames`, which is what the attempt log holds and what the event fold reads. pi negotiates nothing and has no
 * host-tool sub-protocol: commands are sent, answered, and a bare `agent_settled` ends every turn.
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
import { isResponse, type RpcResponse } from "./messages.ts";

/** A healthy pi answers get_state within a second of spawn (probed on 1.0.4); slow starts are node itself. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

/** How pi is started. A bare client applies no wall clock of its own; the worker always passes one. */
interface PiCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Wall clock after which the run is interrupted with reason "timeout". */
  readonly timeoutMs?: number;
  /** Between the RPC abort and SIGTERM, and between SIGTERM and SIGKILL. */
  readonly graceMs?: number;
}

/** pi prints this on stderr while creating a session for a `--session-id` it has not seen (it resumes otherwise). */
const BENIGN_STDERR =
  /^Warning: No project session found with id '.+'; creating a new session with that id\.$/;

function isBenignStderr(line: string): boolean {
  return BENIGN_STDERR.test(line);
}

export type RpcError =
  /** The binary could not be started, or a log could not be opened. */
  | { readonly kind: "start"; readonly message: string }
  /** The process ended (or its output did) before the answer came. */
  | { readonly kind: "exited"; readonly message: string; readonly exit: ProcessExit }
  | { readonly kind: "timeout"; readonly message: string }
  /** pi spoke something the client cannot trust: a get_state without a sessionId, a text-less answer. */
  | { readonly kind: "protocol"; readonly message: string }
  /** pi answered `success: false`. */
  | { readonly kind: "rejected"; readonly message: string; readonly command: string }
  /** stdin was already closed. */
  | { readonly kind: "closed"; readonly message: string };

export interface PiRpcOptions extends PiCommand {
  readonly log?: RpcLogPaths;
  readonly onStderr?: StderrListener;
}

interface HandshakeOptions {
  /** Covers waiting for the `get_state` answer. */
  readonly timeoutMs: number;
}

interface Handshake {
  /** `get_state`'s data: sessionId, sessionFile, model, thinkingLevel… */
  readonly state: Readonly<Record<string, unknown>>;
}

export interface TurnEnd {
  /** Epoch ms when the prompt was written, and when the turn was settled. */
  readonly promptSentAt: number;
  readonly endedAt: number;
}

/** A command as sent, without its id (the client assigns ids). */
type RpcCommand = { readonly type: string } & Readonly<Record<string, unknown>>;

export interface PiRpcClient {
  readonly pid: number;
  /** Every inbound frame in arrival order; ends with stdout. Must be kept draining: the queue buffers unread
   *  frames in memory without bound. */
  readonly frames: AsyncIterable<Frame>;
  /** Resolves once stdout is drained, the process has exited and the logs are closed. */
  readonly exit: Promise<ProcessExit>;
  /** On failure pi is killed: a peer that failed the handshake must not keep running unwatched. */
  handshake(options: HandshakeOptions): Promise<Result<Handshake, RpcError>>;
  /** Sends a command and waits for its response. */
  request(command: RpcCommand): Promise<Result<RpcResponse, RpcError>>;
  /** Runs one turn: the prompt's ack (admission only), then the `agent_settled` that ends the turn. */
  prompt(message: string): Promise<Result<TurnEnd, RpcError>>;
  /** RPC `abort`: pi cancels the running tool and settles the turn. */
  abort(): Promise<Result<RpcResponse, RpcError>>;
  /** `get_last_assistant_text`: the worker's fallback when the last assistant message ended with no text. */
  lastAssistantText(): Promise<Result<string, RpcError>>;
  /** Closes stdin and keeps reading until EOF: pi saves its session and exits 0. */
  close(): Promise<ProcessExit>;
  /** RPC `abort` and stdin closed first (the soft stop), then pi's process group is terminated. */
  interrupt(reason: "timeout" | "stopped"): Promise<void>;
  /** Signals pi's process group. */
  kill(signal: NodeJS.Signals): void;
}

/** `PICC_HANDSHAKE_TIMEOUT_MS` when it is a positive integer, else the default. */
export function handshakeTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const value = Number(env.PICC_HANDSHAKE_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_HANDSHAKE_TIMEOUT_MS;
}

export async function startPiRpc(options: PiRpcOptions): Promise<Result<PiRpcClient, RpcError>> {
  const logs = await openRpcLogs(options.log);
  if (!logs.ok) return err({ kind: "start", message: logs.error });
  // The soft stop is pi's own cancel, so it only exists once the client does: the hook looks it up when fired.
  let softStop: () => Promise<void> = async () => {};
  const proc = await startStreaming(
    {
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      // pi's agent_end frames carry the whole session, so its budget is far above the shared default (frames.ts
      // owns the number).
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
  const client = connect(proc.value, logs.value);
  softStop = async () => {
    // The abort ends the running turn; closing stdin then lets pi save its session and exit on its own.
    await client.abort();
    proc.value.endInput();
  };
  return ok(client);
}

interface PendingTurn {
  readonly resolve: (result: Result<TurnEnd, RpcError>) => void;
  readonly promptSentAt: number;
}

type Respond = (result: Result<RpcResponse, RpcError>) => void;

function connect(proc: StreamingProcess, logs: RpcLogs): PiRpcClient {
  const frames = createQueue<Frame>();
  const pending = new Map<string, Respond>();
  // pi is single-flight: one turn at a time, and `agent_settled` carries no id to tell turns apart.
  let pendingTurn: PendingTurn | undefined;
  let nextId = 0;
  let inputClosed = false;
  let terminal: RpcError | undefined;

  const fail = (error: RpcError): void => {
    terminal ??= error;
    for (const respond of pending.values()) respond(err(terminal));
    pending.clear();
    if (pendingTurn !== undefined) {
      pendingTurn.resolve(err(terminal));
      pendingTurn = undefined;
    }
  };

  const send = (frame: RpcCommand): boolean => {
    if (inputClosed || terminal !== undefined) return false;
    logs.outbound(frame);
    return proc.write(JSON.stringify(frame));
  };

  const unavailable = (): RpcError =>
    terminal ?? { kind: "closed", message: "pi's stdin is closed; no further commands can be sent" };

  const call = (id: string, command: RpcCommand): Promise<Result<RpcResponse, RpcError>> => {
    if (inputClosed || terminal !== undefined) return Promise.resolve(err(unavailable()));
    const answer = new Promise<Result<RpcResponse, RpcError>>((resolve) => pending.set(id, resolve));
    send({ id, ...command });
    return answer;
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
            message: response.error ?? `pi refused ${response.command}`,
          }),
    );
  };

  const onSettled = (): void => {
    if (pendingTurn === undefined) return;
    const turn = pendingTurn;
    pendingTurn = undefined;
    turn.resolve(ok({ promptSentAt: turn.promptSentAt, endedAt: Date.now() }));
  };

  const route = (frame: Frame): void => {
    if (isResponse(frame)) onResponse(frame);
    else if (frame.type === "agent_settled") onSettled();
  };

  const dispatch = (decoded: Decoded, line: string): void => {
    if (decoded.kind === "frame") {
      logs.inbound(logText(decoded.frame, decoded.text));
      frames.push(decoded.frame);
      route(decoded.frame);
    } else if (decoded.kind === "malformed") logs.inbound(line);
  };

  // One decoder for the whole stream: pi has no negotiation to switch partway through.
  const decoder = createFrameDecoder();

  const exit = (async () => {
    for await (const line of proc.lines) dispatch(decoder.push(line), line);
    const ended = await proc.exit;
    fail({ kind: "exited", message: describeExit(ended), exit: ended });
    frames.close();
    await logs.close();
    return ended;
  })();

  const request = (command: RpcCommand): Promise<Result<RpcResponse, RpcError>> => {
    nextId += 1;
    return call(`c${nextId}`, command);
  };

  async function handshakeSteps(): Promise<Result<Handshake, RpcError>> {
    const reply = await request({ type: "get_state" });
    if (!reply.ok) return reply;
    const state = asRecord(reply.value.data);
    return typeof state.sessionId === "string"
      ? ok({ state })
      : err({ kind: "protocol", message: "pi's get_state answer carries no sessionId" });
  }

  return {
    pid: proc.pid,
    frames: frames.items,
    exit,
    request,
    handshake: async (options) => {
      const result = await withTimeout(handshakeSteps(), options.timeoutMs, {
        kind: "timeout",
        message: `pi did not complete the RPC handshake within ${options.timeoutMs} ms`,
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
      const turn = new Promise<Result<TurnEnd, RpcError>>((resolve) => {
        pendingTurn = { resolve, promptSentAt };
      });
      const ack = await call(id, { type: "prompt", message });
      if (!ack.ok) {
        if (pendingTurn !== undefined) pendingTurn = undefined;
        return ack;
      }
      return turn;
    },
    abort: () => request({ type: "abort" }),
    async lastAssistantText() {
      const reply = await request({ type: "get_last_assistant_text" });
      if (!reply.ok) return reply;
      const text = asRecord(reply.value.data).text;
      return typeof text === "string"
        ? ok(text)
        : err({ kind: "protocol", message: "pi's get_last_assistant_text answer carries no text" });
    },
    close() {
      inputClosed = true;
      proc.endInput();
      return exit;
    },
    interrupt: (reason) => proc.interrupt(reason),
    kill: (signal) => proc.signal(signal),
  };
}

function describeExit(exit: ProcessExit): string {
  const how = exit.signal === null ? `exit code ${exit.code}` : `signal ${exit.signal}`;
  const tail = exit.stderrTail.trim();
  return `pi ended (${how})${tail === "" ? "" : `: ${tail}`}`;
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
