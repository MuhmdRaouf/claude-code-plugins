/**
 * Transcript parsing: Claude Code writes one json line per message into ~/.claude/projects/**. Each assistant
 * entry is one model request (streaming may write it several times — merged by requestId); tool_use blocks pair
 * with later tool_result blocks to give durations; sidechain entries and subagent files attribute work to
 * subagents. Pure and stateful-by-argument: the watcher owns the state, this module only interprets lines.
 */
import {
  type AgentKind,
  type ApiErrorRecord,
  type RequestRecord,
  type Tokens,
  type ToolCallRecord,
  ZERO_TOKENS,
} from "../shared/model.ts";
import { providerOf } from "../shared/provider.ts";

export type FileIdentity = {
  sessionId: string;
  agentId: string | null;
  kind: AgentKind;
};

export type AgentDescriptor = {
  sessionId: string;
  id: string;
  parentId: string | null;
  kind: AgentKind;
  name: string | null;
};

export type SessionMeta = {
  id: string;
  cwd?: string;
  ccVersion?: string;
};

export type TranscriptEmit = {
  requests: RequestRecord[];
  toolCalls: ToolCallRecord[];
  agents: AgentDescriptor[];
  session: SessionMeta | null;
  /** API errors (429, 5xx) the transcript recorded: retries Claude Code made and errors it gave up on. */
  apiErrors: ApiErrorRecord[];
  /** Turns the user interrupted (Esc): Claude Code sends no Stop hook for these, the transcript says so. */
  interrupts: { sessionId: string; agentId: string; ts: number }[];
};

export type TranscriptState = {
  pendingTools: Map<
    string,
    { name: string; startedAt: number; sessionId: string; agentId: string; inputKey: string }
  >;
  lastUserTs: Map<string, number>;
  seenAgents: Set<string>;
};

export function newTranscriptState(): TranscriptState {
  return { pendingTools: new Map(), lastUserTs: new Map(), seenAgents: new Set() };
}

const EMPTY: TranscriptEmit = {
  requests: [],
  toolCalls: [],
  agents: [],
  session: null,
  apiErrors: [],
  interrupts: [],
};

/** FNV-1a over a string, as 8 hex digits: enough to tell "the same call again" from a different one. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The identity of a tool call for loop detection: its name plus its whole input. Never stored as text. */
export function toolInputKey(name: string, input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? "";
  } catch {
    text = "";
  }
  return shortHash(`${name}\u0000${text}`);
}

const RETRYABLE = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);

/** "API Error: 529 {…}" → 529; anything else → null. */
export function apiErrorStatus(text: string): number | null {
  const match = /API Error:\s*(\d{3})/.exec(text);
  if (match === null) return null;
  const status = Number(match[1]);
  return RETRYABLE(status) ? status : null;
}

function stripExt(name: string): string {
  return name.endsWith(".jsonl") ? name.slice(0, -6) : name;
}

/** Which session and agent a file belongs to, from its path alone (line data refines this). */
export function identifyFile(path: string): FileIdentity {
  const parts = path.split("/");
  const subagentsAt = parts.lastIndexOf("subagents");
  if (subagentsAt > 0) {
    const agentPart = stripExt(parts[parts.length - 1] ?? "");
    return { sessionId: parts[subagentsAt - 1] ?? agentPart, agentId: agentPart, kind: "subagent" };
  }
  return { sessionId: stripExt(parts[parts.length - 1] ?? path), agentId: null, kind: "main" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function contentBlocks(message: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const content = message?.content;
  if (typeof content === "string") return [];
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

function tsOf(entry: Record<string, unknown>): number | null {
  const value = entry.timestamp;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function usageOf(message: Record<string, unknown>): Tokens {
  const usage = message.usage;
  if (!isRecord(usage)) return { ...ZERO_TOKENS };
  const pick = (key: string): number => {
    const value = usage[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return {
    input: pick("input_tokens"),
    output: pick("output_tokens"),
    cacheRead: pick("cache_read_input_tokens"),
    cacheWrite: pick("cache_creation_input_tokens"),
  };
}

function agentKeyOf(
  entry: Record<string, unknown>,
  file: FileIdentity,
): { sessionId: string; agentId: string } {
  const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : file.sessionId;
  if (file.agentId !== null) return { sessionId, agentId: file.agentId };
  if (entry.isSidechain === true) {
    return { sessionId, agentId: typeof entry.agentId === "string" ? entry.agentId : "sidechain" };
  }
  return { sessionId, agentId: "main" };
}

type AgentContext = {
  sessionId: string;
  agentId: string;
  agentTag: string;
  ts: number;
  file: FileIdentity;
};

function parseEntry(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The file's kind stands, except inside a main transcript where sidechain agents are subagents. */
function agentKindOf(ctx: AgentContext): AgentKind {
  if (ctx.file.kind !== "main") return ctx.file.kind;
  return ctx.agentId === "main" ? "main" : "subagent";
}

/** First sighting of an agent emits its descriptor once; later lines return null. */
function agentDescriptorOf(state: TranscriptState, ctx: AgentContext): AgentDescriptor | null {
  if (state.seenAgents.has(ctx.agentTag)) return null;
  state.seenAgents.add(ctx.agentTag);
  return {
    sessionId: ctx.sessionId,
    id: ctx.agentId,
    parentId: ctx.agentId === "main" ? null : "main",
    kind: agentKindOf(ctx),
    name: ctx.agentId,
  };
}

function sessionMetaOf(entry: Record<string, unknown>, sessionId: string): SessionMeta | null {
  if (typeof entry.cwd !== "string" && typeof entry.version !== "string") return null;
  const meta: SessionMeta = { id: sessionId };
  if (typeof entry.cwd === "string") meta.cwd = entry.cwd;
  if (typeof entry.version === "string") meta.ccVersion = entry.version;
  return meta;
}

function requestOf(
  state: TranscriptState,
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  ctx: AgentContext,
): RequestRecord | null {
  const model = typeof message.model === "string" ? message.model : "";
  if (model === "") return null;
  const requestId =
    typeof entry.requestId === "string" ? entry.requestId : `msg:${String(entry.uuid ?? ctx.ts)}`;
  const lastUserTs = state.lastUserTs.get(ctx.agentTag);
  const latency = lastUserTs !== undefined && ctx.ts >= lastUserTs ? ctx.ts - lastUserTs : null;
  return {
    id: requestId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    model,
    upstream: "",
    ts: ctx.ts,
    latencyMs: latency,
    tokens: usageOf(message),
    stopReason: typeof message.stop_reason === "string" ? message.stop_reason : null,
    provider: providerOf(model),
  };
}

function applyAssistant(
  state: TranscriptState,
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  ctx: AgentContext,
  emit: TranscriptEmit,
): void {
  for (const block of contentBlocks(message)) {
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      state.pendingTools.set(block.id, {
        name: block.name,
        startedAt: ctx.ts,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        inputKey: toolInputKey(block.name, block.input),
      });
    }
  }
  const failed = assistantErrorStatus(entry, message);
  if (failed !== null) {
    emit.apiErrors.push(apiErrorOf(ctx, failed));
    return; // the synthetic "API Error" message is not a model request
  }
  const request = requestOf(state, entry, message, ctx);
  if (request !== null) emit.requests.push(request);
}

function apiErrorOf(ctx: AgentContext, status: number): ApiErrorRecord {
  return {
    ts: ctx.ts,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    status,
    source: "transcript",
    plugin: null,
  };
}

/** An assistant entry Claude Code wrote for a request that failed: its status, else null. */
function assistantErrorStatus(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): number | null {
  if (entry.isApiErrorMessage !== true && message.model !== "<synthetic>") return null;
  for (const block of contentBlocks(message)) {
    if (block.type === "text" && typeof block.text === "string") {
      const status = apiErrorStatus(block.text);
      if (status !== null) return status;
    }
  }
  return null;
}

/** A system entry recording one retry ("api_error" with the HTTP status), else null. */
function systemErrorStatus(entry: Record<string, unknown>): number | null {
  if (entry.type !== "system" || entry.subtype !== "api_error") return null;
  const error = isRecord(entry.error) ? entry.error : {};
  const raw = typeof error.status === "number" ? error.status : entry.status;
  return typeof raw === "number" && RETRYABLE(raw) ? raw : null;
}

function toolResultOf(
  state: TranscriptState,
  block: Record<string, unknown>,
  toolUseId: string,
  ctx: AgentContext,
): ToolCallRecord {
  const pending = state.pendingTools.get(toolUseId);
  state.pendingTools.delete(toolUseId);
  const startedAt = pending?.startedAt ?? ctx.ts;
  return {
    id: toolUseId,
    sessionId: pending?.sessionId ?? ctx.sessionId,
    agentId: pending?.agentId ?? ctx.agentId,
    name: pending?.name ?? "unknown",
    startedAt,
    durationMs: startedAt < ctx.ts ? ctx.ts - startedAt : null,
    ok: block.is_error !== true,
    ...(pending === undefined ? {} : { inputKey: pending.inputKey }),
  };
}

/** "[Request interrupted by user]" (and "… for tool use"), as a string or a text block. */
function isInterruption(message: Record<string, unknown>): boolean {
  const marker = (text: unknown): boolean =>
    typeof text === "string" && text.startsWith("[Request interrupted by user");
  if (marker(message.content)) return true;
  return contentBlocks(message).some((block) => block.type === "text" && marker(block.text));
}

function applyUser(
  state: TranscriptState,
  message: Record<string, unknown>,
  ctx: AgentContext,
  emit: TranscriptEmit,
): void {
  if (isInterruption(message))
    emit.interrupts.push({ sessionId: ctx.sessionId, agentId: ctx.agentId, ts: ctx.ts });
  for (const block of contentBlocks(message)) {
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    emit.toolCalls.push(toolResultOf(state, block, block.tool_use_id, ctx));
  }
}

/** Parse one transcript line into records, updating the cross-line state (pending tools, last user ts). */
export function feedTranscriptLine(state: TranscriptState, file: FileIdentity, raw: string): TranscriptEmit {
  const entry = parseEntry(raw);
  if (entry === null) return EMPTY;
  const ts = tsOf(entry);
  if (ts === null) return EMPTY;
  const { sessionId, agentId } = agentKeyOf(entry, file);
  const ctx: AgentContext = { sessionId, agentId, agentTag: `${sessionId}:${agentId}`, ts, file };
  const emit: TranscriptEmit = {
    requests: [],
    toolCalls: [],
    agents: [],
    session: null,
    apiErrors: [],
    interrupts: [],
  };

  const agent = agentDescriptorOf(state, ctx);
  if (agent !== null) emit.agents.push(agent);
  emit.session = sessionMetaOf(entry, sessionId);

  const message = isRecord(entry.message) ? entry.message : undefined;
  if (entry.type === "assistant" && message !== undefined) {
    applyAssistant(state, entry, message, ctx, emit);
    return emit;
  }

  const retried = systemErrorStatus(entry);
  if (retried !== null) emit.apiErrors.push(apiErrorOf(ctx, retried));
  // user and system entries mark the boundary before the next assistant turn
  state.lastUserTs.set(ctx.agentTag, ts);
  if (entry.type === "user" && message !== undefined) applyUser(state, message, ctx, emit);
  return emit;
}
