/**
 * The omp RPC frames the client itself acts on (shapes from omp 18.6.1, see test/fixtures/omp-rpc). Everything else
 * passes through as an opaque Frame for the event fold.
 */
import type { Frame } from "./frames.ts";

export interface ReadyFrame {
  readonly type: "ready";
  readonly protocolVersion: number;
  readonly supportedProtocolVersions: readonly number[];
  /** The longest single line omp writes; longer frames arrive as `rpc_chunk` runs instead. */
  readonly maxFrameBytes?: number;
}

/** `{id, type:"response", command, success, data? | error}`. */
export interface RpcResponse {
  readonly type: "response";
  readonly id?: string;
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface PromptError {
  readonly message: string;
  readonly provider?: string;
  readonly model?: string;
  readonly httpStatus?: number;
  readonly retryable?: boolean;
}

/** Exactly one per admitted prompt. `agentInvoked: false` (e.g. not authenticated) is never followed by
 *  `session_settled`, and `sessionSettled: true` means none is needed. */
export interface PromptResult {
  readonly type: "prompt_result";
  readonly id: string;
  readonly agentInvoked: boolean;
  readonly status: "completed" | "aborted" | "error";
  readonly sessionSettled: boolean;
  readonly error?: PromptError;
}

/** omp asks the host to run one of its host tools; it arrives before `tool_execution_start` for that call. */
export interface HostToolCall {
  readonly type: "host_tool_call";
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** omp gave up on a pending host tool call (the turn was aborted); no result may follow. */
interface HostToolCancel {
  readonly type: "host_tool_cancel";
  readonly id: string;
  readonly targetId: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isReady(frame: Frame): frame is Frame & ReadyFrame {
  const versions = frame.supportedProtocolVersions;
  return (
    frame.type === "ready" &&
    Array.isArray(versions) &&
    versions.every((version) => typeof version === "number") &&
    typeof frame.protocolVersion === "number"
  );
}

export function isResponse(frame: Frame): frame is Frame & RpcResponse {
  return frame.type === "response" && typeof frame.command === "string" && typeof frame.success === "boolean";
}

export function isPromptResult(frame: Frame): frame is Frame & PromptResult {
  return (
    frame.type === "prompt_result" &&
    typeof frame.id === "string" &&
    typeof frame.agentInvoked === "boolean" &&
    typeof frame.sessionSettled === "boolean" &&
    (frame.status === "completed" || frame.status === "aborted" || frame.status === "error")
  );
}

export function isHostToolCall(frame: Frame): frame is Frame & HostToolCall {
  return (
    frame.type === "host_tool_call" &&
    typeof frame.id === "string" &&
    typeof frame.toolCallId === "string" &&
    typeof frame.toolName === "string" &&
    isRecord(frame.arguments)
  );
}

export function isHostToolCancel(frame: Frame): frame is Frame & HostToolCancel {
  return (
    frame.type === "host_tool_cancel" && typeof frame.id === "string" && typeof frame.targetId === "string"
  );
}
