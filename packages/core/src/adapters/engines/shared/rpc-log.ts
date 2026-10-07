/**
 * What an RPC engine's (omp's, pi's) attempt logs hold. Inbound frames are logged byte for byte, with one exception:
 * tool results carry the full pre-elision output (a `tool_execution_end`'s `result.details`, a toolResult
 * `message_end`'s `content` and `details`; a 3 MB `read` once wrote two ~519 KB lines although the model saw 40 KB),
 * so a field over LOG_FIELD_LIMIT is cut to its first and last LOG_KEEP bytes of JSON plus its byte count. The fold
 * never reads those fields. Outbound commands are logged as sent, except the prompt text, which job.json keeps.
 */
import type { WriteStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { err, ok, type Result } from "../../../domain/result.ts";

export const LOG_FIELD_LIMIT = 64 * 1024;
export const LOG_KEEP = 16 * 1024;

/** Stands in for a cut field. */
export interface TruncatedField {
  readonly $truncated: number;
  readonly head: string;
  readonly tail: string;
}

type Json = Readonly<Record<string, unknown>>;

/** One decoded frame of either protocol. */
type Frame = { readonly type: string } & Json;

/** The log line for an inbound frame: `text` itself unless a tool result field is too big. */
export function logText(frame: Frame, text: string): string {
  const cut = cutFrame(frame);
  return cut === undefined ? text : JSON.stringify(cut);
}

/** The log line for an outbound command; a prompt's message becomes `{"$ref": promptRef}`. */
export function outboundLogText(command: Json, promptRef: string): string {
  return JSON.stringify(command.type === "prompt" ? { ...command, message: { $ref: promptRef } } : command);
}

function cutFrame(frame: Frame): Frame | undefined {
  if (frame.type === "tool_execution_end" && isObject(frame.result)) {
    const result = cutFields(frame.result, ["details"]);
    return result === undefined ? undefined : { ...frame, result };
  }
  if (frame.type === "message_end" && isObject(frame.message) && frame.message.role === "toolResult") {
    const message = cutFields(frame.message, ["content", "details"]);
    return message === undefined ? undefined : { ...frame, message };
  }
  return undefined;
}

function cutFields(object: Json, keys: readonly string[]): Json | undefined {
  let out: Json | undefined;
  for (const key of keys) {
    const cut = cutValue(object[key]);
    if (cut !== undefined) out = { ...(out ?? object), [key]: cut };
  }
  return out;
}

function cutValue(value: unknown): TruncatedField | undefined {
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  const bytes = Buffer.from(json, "utf8");
  if (bytes.byteLength <= LOG_FIELD_LIMIT) return undefined;
  return {
    $truncated: bytes.byteLength,
    head: cutBytes(bytes, 0, LOG_KEEP),
    tail: cutBytes(bytes, bytes.byteLength - LOG_KEEP, bytes.byteLength),
  };
}

/** `bytes`[start, end) as text, walked to the nearest UTF-8 boundary so no character is cut in half. */
function cutBytes(bytes: Buffer, start: number, end: number): string {
  while (end > start && isContinuation(bytes[end] ?? 0)) end -= 1;
  while (start < end && isContinuation(bytes[start] ?? 0)) start += 1;
  return bytes.subarray(start, end).toString("utf8");
}

const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where a worker session's RPC traffic is logged. */
export interface RpcLogPaths {
  /** Inbound frames, one per line (`attempt-<n>.jsonl`). */
  readonly stdout: string;
  /** Outbound commands (`attempt-<n>.rpc-in.jsonl`). */
  readonly stdin: string;
  /** Stands in for the prompt text in the outbound log, e.g. `job.json#attempts[0].prompt`. */
  readonly promptRef: string;
}

export interface RpcLogs {
  inbound(line: string): void;
  outbound(command: Json): void;
  /** The first stream failure, once one happens; logging stops after it. */
  failure(): string | undefined;
  /** Flushes and closes both files. */
  close(): Promise<void>;
}

const NO_LOGS: RpcLogs = {
  inbound: () => {},
  outbound: () => {},
  failure: () => undefined,
  close: async () => {},
};

/** Opens both logs for appending (0600); without paths nothing is logged. */
export async function openRpcLogs(paths: RpcLogPaths | undefined): Promise<Result<RpcLogs, string>> {
  if (paths === undefined) return ok(NO_LOGS);
  const frames = await appendStream(paths.stdout);
  if (!frames.ok) return frames;
  const commands = await appendStream(paths.stdin);
  if (!commands.ok) {
    await endStream(frames.value);
    return commands;
  }
  return ok(createRpcLogs(frames.value, commands.value, paths.promptRef));
}

/** Wires two opened append streams into the logs; the streams stay private to this module's failure handling. */
export function createRpcLogs(frames: WriteStream, commands: WriteStream, promptRef: string): RpcLogs {
  let failure: string | undefined;
  const record = (error: Error): void => {
    failure ??= String(error);
  };
  frames.once("error", record);
  commands.once("error", record);
  return {
    inbound: (line) => {
      if (failure === undefined) frames.write(`${line}\n`);
    },
    outbound: (command) => {
      if (failure === undefined) commands.write(`${outboundLogText(command, promptRef)}\n`);
    },
    failure: () => failure,
    close: async () => {
      await Promise.all([endStream(frames), endStream(commands)]);
    },
  };
}

async function appendStream(path: string): Promise<Result<WriteStream, string>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a", 0o600);
    return ok(handle.createWriteStream());
  } catch (error) {
    return err(`cannot open log ${path}: ${String(error)}`);
  }
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.end(() => resolve());
    // A stream that failed before closing never runs the end callback's finish path; 'close' is unconditional.
    stream.once("close", () => resolve());
  });
}
