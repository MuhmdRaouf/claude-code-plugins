/** Typed views of the RPC frames pi 1.0.4 answers. pi is looser than omp: it sends no ready frame, only ever echoes
 *  the `response` envelope, and ends each turn with a bare `agent_settled` that carries no fields worth typing. What
 *  the fold reads off the event stream (message ends, tool executions, retries) is untyped there: pi shapes it like a
 *  transcript, so the worker picks those frames apart field by field instead of narrowing whole frames here. */

import type { Frame } from "./frames.ts";

/** pi's answer to a command: success plus whatever the command reports under `data`. */
export interface RpcResponse {
  /** The id the commanding side sent; absent when pi answers a line it could not parse. */
  readonly id?: string;
  readonly command: string;
  readonly success: boolean;
  readonly error?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export function isResponse(frame: Frame): frame is Frame & RpcResponse {
  return frame.type === "response" && typeof frame.command === "string" && typeof frame.success === "boolean";
}
