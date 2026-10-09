/**
 * Transcript parsing: Claude Code writes one json line per message into ~/.claude/projects/**. Each assistant
 * entry is one model request (streaming may write it several times — merged by requestId); tool_use blocks pair
 * with later tool_result blocks to give durations; sidechain entries and subagent files attribute work to
 * subagents. Pure and stateful-by-argument: the watcher owns the state, this module only interprets lines.
 */
import {
  type AgentKind,
  type ApiErrorRecord,
  promptTitle,
  type RequestRecord,
  type Tokens,
  type ToolCallRecord,
  totalTokens,
  ZERO_TOKENS,
} from "../shared/model.ts";
import { providerOf } from "../shared/provider.ts";

export type FileIdentity = {
  sessionId: string;
  agentId: string | null;
  kind: AgentKind;
  /** Where every request in this file went, when the file's source knows (a zai job calls Z.ai directly). */
  upstream?: string;
  /** When set, every record this file yields lands here, whatever session and agent its lines name: a job
   *  attempt's real transcript belongs to the job's pseudo session, not to the session id its lines carry. */
  remap?: { sessionId: string; agentId: string; parentId?: string };
  /** What the agent is, from subagents/agent-<id>.meta.json beside a subagent transcript, read once. */
  agentMeta?: { agentType: string; description: string };
};

export type AgentDescriptor = {
  sessionId: string;
  id: string;
  parentId: string | null;
  kind: AgentKind;
  name: string | null;
  /** What kind of agent ran (general-purpose, fork, …) and its task, when its meta file says. */
  agentType: string | null;
  description: string | null;
  /** The head of the agent's first prompt, emitted once it is seen; names a subagent with no meta file. */
  title?: string;
};

export type SessionMeta = {
  id: string;
  cwd?: string;
  ccVersion?: string;
  /** Naming data the transcript carries; the store keeps the latest of each per session. */
  customTitle?: string;
  agentName?: string;
  aiTitle?: string;
  slug?: string;
  branch?: string;
};

/** One captured content block, as the history stores it: a prompt text, a tool result or a piece of the
 *  assistant's answer. A block's text is capped (see capInto), the rest is kept whole. */
export type ContentBlock = {
  type: string;
  text?: string;
  /** A thinking block's words, which the wire carries under `thinking` (with its signature, dropped). */
  thinking?: string;
  /** A media block's kind ("image/png") and how many bytes its data decodes to; the data itself is
   *  never stored. */
  media_type?: string;
  bytes?: number;
  /** How many bytes of a capped text did not fit; the UI says the original size with it. */
  truncated?: number;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
};

/** One request's INPUT and OUTPUT, serialised elsewhere; the writer puts it beside the request. */
export type ContentCapture = { requestId: string; input: string | null; output: string | null };

export type TranscriptEmit = {
  requests: RequestRecord[];
  toolCalls: ToolCallRecord[];
  agents: AgentDescriptor[];
  session: SessionMeta | null;
  /** Each request's input and output text: what the model saw and what it answered. */
  content: ContentCapture[];
  /** API errors (429, 5xx) the transcript recorded: retries Claude Code made and errors it gave up on. */
  apiErrors: ApiErrorRecord[];
  /** Turns the user interrupted (Esc): Claude Code sends no Stop hook for these, the transcript says so. */
  interrupts: { sessionId: string; agentId: string; ts: number }[];
  /** Error notices Claude Code wrote itself (usage limit, lost connection): errors of the agent, not model calls. */
  notices: Notice[];
};

export type Notice = { sessionId: string; agentId: string; ts: number; what: string };

/** The model name Claude Code writes on assistant messages it makes itself, never on a model's answer. */
export const SYNTHETIC_MODEL = "<synthetic>";

const NOTICE_WHAT: Record<string, string> = {
  rate_limit: "usage limit",
  server_error: "connection error",
  authentication_failed: "not logged in",
  invalid_request: "request refused",
};

export type TranscriptState = {
  pendingTools: Map<
    string,
    { name: string; startedAt: number; sessionId: string; agentId: string; inputKey: string }
  >;
  lastUserTs: Map<string, number>;
  seenAgents: Set<string>;
  /** Agent chains whose first prompt already became their title: emitted once, never again. */
  prompts: Set<string>;
  /** Per agent, the last request and whether any request so far carried tokens: a `claude -p` stream on a
   *  provider that reports usage only in its final result event gets that total on its last request. */
  lastRequest: Map<string, { request: RequestRecord; anyTokens: boolean }>;
  /** Per agent chain, the user and tool_result entries since that agent's previous assistant request. */
  pendingInput: Map<string, ContentBlock[]>;
  /** Per agent chain and request id, that the request's first entry already consumed the pending input:
   *  a subagent writes one entry per block and its tool results land between them, so the later block
   *  entries of a message must leave the logged input to the next request. */
  inputTaken: Map<string, boolean>;
  /** Per request id, the assistant blocks seen so far: a streamed message is written several times. */
  streamOutput: Map<string, ContentBlock[]>;
  /** Per request id, the input side already computed for its `what`: the entry that takes the logged
   *  input computes it, and the message's later entries must keep naming it. */
  whatInput: Map<string, string>;
};

export function newTranscriptState(): TranscriptState {
  return {
    pendingTools: new Map(),
    lastUserTs: new Map(),
    seenAgents: new Set(),
    prompts: new Set(),
    lastRequest: new Map(),
    pendingInput: new Map(),
    inputTaken: new Map(),
    streamOutput: new Map(),
    whatInput: new Map(),
  };
}

const EMPTY: TranscriptEmit = {
  requests: [],
  toolCalls: [],
  agents: [],
  session: null,
  content: [],
  apiErrors: [],
  interrupts: [],
  notices: [],
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

/** One block's text is capped at 1 MB, so an ordinary large tool result is kept whole; the marker names
 *  how many bytes did not fit, and the block records the cut so the UI can say the original size. */
const TEXT_CAP = 1024 * 1024;

function capInto(out: ContentBlock, field: "text" | "thinking", text: string): void {
  const bytes = Buffer.byteLength(text);
  if (bytes <= TEXT_CAP) {
    out[field] = text;
    return;
  }
  let kept = text.slice(0, TEXT_CAP);
  while (Buffer.byteLength(kept) > TEXT_CAP) kept = kept.slice(0, -1);
  const cut = bytes - Buffer.byteLength(kept);
  out[field] = `${kept}…[truncated ${cut} bytes]`;
  out.truncated = cut;
}

/** The bytes a base64 payload decodes to, or null when it is not a string. */
function decodedBytesOf(data: unknown): number | null {
  if (typeof data !== "string") return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** A block with no words of its own (an image, a document): its kind, media type and the bytes its
 *  data decodes to — the data itself never stored. The marker keeps it readable anywhere a block's
 *  text is shown, so "the model saw an image" never reads as "the block was empty". */
function mediaBlockOf(type: string, block: Record<string, unknown>): ContentBlock {
  const out: ContentBlock = { type };
  const source = isRecord(block.source) ? block.source : {};
  if (typeof source.media_type === "string" && source.media_type !== "") out.media_type = source.media_type;
  const bytes = decodedBytesOf(source.data);
  if (bytes !== null) out.bytes = bytes;
  const what = `${type}${out.media_type === undefined ? "" : ` ${out.media_type}`}`;
  out.text = `[${what}${bytes === null ? "" : `, ${bytes} bytes`}]`;
  return out;
}

/** The text of a tool result: its content string, else its text blocks joined by newlines — with one
 *  marker per wordless block, so a result that only carried an image does not read as empty. */
function resultTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content.filter(isRecord)) {
    if (typeof block.text === "string" && block.text !== "") parts.push(block.text);
    else parts.push(mediaBlockOf(typeof block.type === "string" ? block.type : "unknown", block).text ?? "");
  }
  return parts.filter((part) => part !== "").join("\n");
}

/** A user-side block as the history stores it: a prompt text or a tool result with its id and error flag. */
function inputBlockOf(block: Record<string, unknown>): ContentBlock {
  const type = typeof block.type === "string" ? block.type : "unknown";
  if (type === "tool_result") {
    const out: ContentBlock = { type };
    if (typeof block.tool_use_id === "string") out.tool_use_id = block.tool_use_id;
    if (block.is_error === true) out.is_error = true;
    const text = resultTextOf(block.content);
    if (text !== "") capInto(out, "text", text);
    return out;
  }
  const out: ContentBlock = { type };
  if (typeof block.text === "string") capInto(out, "text", block.text);
  else return mediaBlockOf(type, block);
  return out;
}

/** An assistant-side block: its text, or the tool it wants to run with its name and whole input. A
 *  thinking block's words arrive under `thinking`, which the UI renders, so they are kept as they came. */
function outputBlockOf(block: Record<string, unknown>): ContentBlock {
  const out: ContentBlock = { type: typeof block.type === "string" ? block.type : "unknown" };
  if (typeof block.text === "string") capInto(out, "text", block.text);
  if (typeof block.thinking === "string") capInto(out, "thinking", block.thinking);
  if (out.type === "tool_use") {
    if (typeof block.name === "string") out.name = block.name;
    if (block.input !== undefined) out.input = block.input;
  }
  return out;
}

const jsonOf = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

/** Whitespace folded to single spaces, trimmed: everything a `what` line carries is one line. */
function oneLineOf(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** How many characters of a prompt a `what` keeps. */
const WHAT_PROMPT_CHARS = 40;
/** How long one tool argument in a `what` may run before it is cut. */
const WHAT_ARG_CHARS = 24;

/** A Bash command's head: its first two words ("git status" out of "git status --porcelain"), cut. */
function commandHeadOf(command: string): string {
  const head = oneLineOf(command)
    .split(" ")
    .filter((word) => word !== "")
    .slice(0, 2)
    .join(" ");
  return head.length > WHAT_ARG_CHARS ? head.slice(0, WHAT_ARG_CHARS) : head;
}

/** The argument a tool call's `what` names: the command's head for Bash, the pattern for Grep and Glob,
 *  a file's basename for the file tools; empty when the input carries none of these and the name stands alone. */
function toolArgOf(name: string, input: unknown): string {
  const fields = isRecord(input) ? input : {};
  const text = (key: string): string | null => {
    const value = fields[key];
    return typeof value === "string" && value !== "" ? value : null;
  };
  if (name === "Bash") return commandHeadOf(text("command") ?? "");
  if (name === "Grep" || name === "Glob") return oneLineOf(text("pattern") ?? "").slice(0, WHAT_ARG_CHARS);
  for (const key of ["file_path", "notebook_path", "path"]) {
    const file = text(key);
    if (file !== null) return file.split("/").pop() ?? file;
  }
  return "";
}

/** The input side of a `what`: the prompt's first 40 characters, else how many tool results came back. */
function inputPartOf(blocks: ContentBlock[]): string | null {
  const prompt = blocks.find((block) => block.type === "text" && typeof block.text === "string");
  if (prompt !== undefined) {
    const text = oneLineOf(prompt.text ?? "");
    return text === "" ? null : `prompt: ${text.slice(0, WHAT_PROMPT_CHARS)}`;
  }
  const results = blocks.filter((block) => block.type === "tool_result").length;
  return results > 0 ? `${results} tool result${results === 1 ? "" : "s"}` : null;
}

/** The output side of a `what`: the first three tool calls with their telling argument ("+N" past that),
 *  else "text" when the answer carried anything at all; null when it carried nothing. */
function outputPartOf(blocks: ContentBlock[]): string | null {
  const calls = blocks.filter((block) => block.type === "tool_use");
  if (calls.length === 0) return blocks.length > 0 ? "text" : null;
  const named = calls.slice(0, 3).map((call) => {
    const arg = toolArgOf(call.name ?? "", call.input);
    return arg === "" ? (call.name ?? "tool") : `${call.name} ${arg}`;
  });
  const rest = calls.length - named.length;
  return `${named.join(", ")}${rest > 0 ? ` +${rest}` : ""}`;
}

/** One line on what a request was, computed once at ingest so the browser never parses content to show
 *  it: "↳ <input kind>  → <what it did>", the sides joined by two spaces; null with neither side. */
export function whatOf(input: string | null, output: ContentBlock[]): string | null {
  const parts: string[] = [];
  if (input !== null) parts.push(`↳ ${input}`);
  const out = outputPartOf(output);
  if (out !== null) parts.push(`→ ${out}`);
  return parts.length === 0 ? null : parts.join("  ");
}

/** The words a text or thinking block carries, under whichever field the wire used for them. */
const wordsOf = (block: ContentBlock): string | undefined =>
  typeof block.text === "string"
    ? block.text
    : typeof block.thinking === "string"
      ? block.thinking
      : undefined;

/** Fold a streamed rewrite into the block it grows, when one is there: true when it was folded. */
function growWords(list: ContentBlock[], next: ContentBlock): boolean {
  const words = next.type === "text" || next.type === "thinking" ? wordsOf(next) : undefined;
  if (words === undefined) return false;
  const grown = list.find(
    (block) =>
      (block.type === next.type || block.type === "text") &&
      words.startsWith(wordsOf(block) ?? "\u0000") === true,
  );
  if (grown === undefined) return false;
  if (next.text !== undefined) grown.text = next.text;
  if (next.thinking !== undefined) grown.thinking = next.thinking;
  return true;
}

/** A streamed message is written again and again as it grows: a longer text replaces its own prefix and
 *  a repeated tool_use is kept once, so the accumulated list reads as one message, not many. Thinking
 *  grows the same way, under its own field. */
function accumulateBlock(list: ContentBlock[], next: ContentBlock): void {
  if (growWords(list, next)) return;
  if (
    next.type === "tool_use" &&
    list.some(
      (block) =>
        block.type === "tool_use" && block.name === next.name && jsonOf(block.input) === jsonOf(next.input),
    )
  ) {
    return;
  }
  list.push(next);
}

/** Bound the per-file state: a streamed rewrite lands within seconds, so a window of request ids is
 *  plenty; dropping the oldest keeps a long transcript's parser flat. */
function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size <= cap) return;
  const oldest = map.keys().next();
  if (!oldest.done) map.delete(oldest.value);
}

/**
 * Capture a request's INPUT and OUTPUT for the history. OUTPUT is the assistant message's blocks,
 * accumulated across the entries a stream writes for one request id; INPUT is the user and tool_result
 * entries the chain logged since the agent's previous request, consumed by the request's first entry.
 * Returns the request's one-line `what`, from the input just taken and the output accumulated so far.
 */
/** The request's logged input, taken by its FIRST entry only: a subagent's later block entries arrive
 *  after the tool results its own earlier blocks caused, and those results belong to the next request. */
function takePendingInput(
  state: TranscriptState,
  requestId: string,
  ctx: AgentContext,
): ContentBlock[] | undefined {
  const key = `${ctx.agentTag}␟${requestId}`;
  if (state.inputTaken.has(key)) return undefined;
  rememberBounded(state.inputTaken, key, true, 512);
  const input = state.pendingInput.get(ctx.agentTag);
  state.pendingInput.delete(ctx.agentTag);
  return input;
}

function captureContent(
  state: TranscriptState,
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  ctx: AgentContext,
  emit: TranscriptEmit,
): string | undefined {
  const requestId = requestIdOf(entry, message, ctx);
  const output = state.streamOutput.get(requestId) ?? [];
  for (const block of contentBlocks(message)) accumulateBlock(output, outputBlockOf(block));
  rememberBounded(state.streamOutput, requestId, output, 256);
  const input = takePendingInput(state, requestId, ctx);
  emit.content.push({
    requestId,
    input: input === undefined || input.length === 0 ? null : JSON.stringify(input),
    output: output.length === 0 ? null : JSON.stringify(output),
  });
  // the entry that took the logged input computes the `what`'s input side; a streamed message's later
  // entries see no input of their own, so the remembered part stands in for it
  let inputPart = state.whatInput.get(requestId) ?? null;
  if (input !== undefined) {
    const taken = inputPartOf(input);
    if (taken !== null) {
      inputPart = taken;
      rememberBounded(state.whatInput, requestId, taken, 256);
    }
  }
  return whatOf(inputPart, output) ?? undefined;
}

function tsOf(entry: Record<string, unknown>): number | null {
  const value = entry.timestamp;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The usage block's token counters, including the reasoning share of the output the provider breaks
 *  out (output_tokens_details). Shared with the route-line path, which reads the same wire usage. */
export function usageOf(message: Record<string, unknown>): Tokens {
  const usage = message.usage;
  if (!isRecord(usage)) return { ...ZERO_TOKENS };
  const pick = (key: string): number => {
    const value = usage[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const tokens: Tokens = {
    input: pick("input_tokens"),
    output: pick("output_tokens"),
    cacheRead: pick("cache_read_input_tokens"),
    cacheWrite: pick("cache_creation_input_tokens"),
  };
  // the reasoning share of the output, when the provider breaks it out (output_tokens_details)
  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const thinking = details.thinking_tokens;
  if (typeof thinking === "number" && Number.isFinite(thinking) && thinking > 0) tokens.thinking = thinking;
  return tokens;
}

/** How the request bills beyond its token counts: the 1-hour cache writes, fast mode, geo and service tier.
 *  Empty strings and fields the usage block omits stay unset. Shared with the route-line path. */
export function billingOf(message: Record<string, unknown>): Partial<RequestRecord> {
  const usage = message.usage;
  if (!isRecord(usage)) return {};
  const billing: Partial<RequestRecord> = {};
  const creation = isRecord(usage.cache_creation) ? usage.cache_creation : {};
  const oneHour = creation.ephemeral_1h_input_tokens;
  if (typeof oneHour === "number" && Number.isFinite(oneHour) && oneHour > 0) {
    billing.cacheWrite1h = oneHour;
  }
  const word = (key: string): string | undefined => {
    const value = usage[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const speed = word("speed");
  const geo = word("inference_geo");
  const serviceTier = word("service_tier");
  if (speed !== undefined) billing.speed = speed;
  if (geo !== undefined) billing.geo = geo;
  if (serviceTier !== undefined) billing.serviceTier = serviceTier;
  return billing;
}

function agentKeyOf(
  entry: Record<string, unknown>,
  file: FileIdentity,
): { sessionId: string; agentId: string } {
  // the remap pins the session: a job attempt's lines carry the attempt's own session id, never the job's
  if (file.remap !== undefined) {
    return { sessionId: file.remap.sessionId, agentId: file.agentId ?? file.remap.agentId };
  }
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

/** First sighting of an agent emits its descriptor once; later lines return null. The name is null when
 *  no meta file named the agent: the store falls back to the agent's first prompt, never the raw id. */
function agentDescriptorOf(state: TranscriptState, ctx: AgentContext): AgentDescriptor | null {
  if (state.seenAgents.has(ctx.agentTag)) return null;
  state.seenAgents.add(ctx.agentTag);
  const meta = ctx.file.agentMeta;
  return {
    sessionId: ctx.sessionId,
    id: ctx.agentId,
    parentId: ctx.file.remap?.parentId ?? (ctx.agentId === "main" ? null : "main"),
    kind: agentKindOf(ctx),
    name: meta?.agentType ?? null,
    agentType: meta?.agentType ?? null,
    description: meta?.description ?? null,
  };
}

/** The first text a user message carries: its content string, else its first text block; else null. */
function firstTextOf(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (typeof content === "string") return content.trim() === "" ? null : content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (isRecord(block) && typeof block.text === "string" && block.text.trim() !== "") return block.text;
  }
  return null;
}

/** A subagent's first prompt, emitted once as its title: names it when no meta file did. A job's own
 *  transcript never renames the job — the job's title is the job files' business. */
function emitPromptTitle(
  state: TranscriptState,
  message: Record<string, unknown>,
  ctx: AgentContext,
  emit: TranscriptEmit,
): void {
  if (agentKindOf(ctx) !== "subagent" || state.prompts.has(ctx.agentTag)) return;
  const text = firstTextOf(message);
  if (text === null) return;
  state.prompts.add(ctx.agentTag);
  emit.agents.push({
    sessionId: ctx.sessionId,
    id: ctx.agentId,
    parentId: ctx.file.remap?.parentId ?? (ctx.agentId === "main" ? null : "main"),
    kind: agentKindOf(ctx),
    name: null,
    agentType: ctx.file.agentMeta?.agentType ?? null,
    description: ctx.file.agentMeta?.description ?? null,
    title: promptTitle(text),
  });
}

const NAMED_TYPES: Record<string, keyof Omit<SessionMeta, "id" | "cwd" | "ccVersion" | "branch">> = {
  "custom-title": "customTitle",
  "agent-name": "agentName",
  "ai-title": "aiTitle",
};

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** A naming line (`{"type":"custom-title",...}`): the field it names, when it names it with a real value. */
function namedMetaOf(entry: Record<string, unknown>): Partial<SessionMeta> | null {
  const field = NAMED_TYPES[typeof entry.type === "string" ? entry.type : ""];
  if (field === undefined) return null;
  const value = nonEmpty(entry[field]);
  return value === null ? null : { [field]: value };
}

function sessionMetaOf(
  entry: Record<string, unknown>,
  sessionId: string,
  named: boolean,
): SessionMeta | null {
  const name = named ? namedMetaOf(entry) : null;
  const slug = named ? nonEmpty(entry.slug) : null;
  const branch = named ? nonEmpty(entry.gitBranch) : null;
  const cwd = nonEmpty(entry.cwd);
  const ccVersion = nonEmpty(entry.version);
  if (name === null && slug === null && branch === null && cwd === null && ccVersion === null) {
    return null;
  }
  const meta: SessionMeta = { id: sessionId };
  if (cwd !== null) meta.cwd = cwd;
  if (ccVersion !== null) meta.ccVersion = ccVersion;
  if (name !== null) Object.assign(meta, name);
  if (slug !== null) meta.slug = slug;
  if (branch !== null) meta.branch = branch;
  return meta;
}

/** The id one model call is known by: the API request id, else the assistant message's own id — a
 *  subagent transcript names no request and writes one entry per block, each naming the same message —
 *  else the entry's uuid (or timestamp). */
function requestIdOf(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  ctx: AgentContext,
): string {
  if (typeof entry.requestId === "string") return entry.requestId;
  if (typeof message.id === "string" && message.id !== "") return message.id;
  return `msg:${String(entry.uuid ?? ctx.ts)}`;
}

function requestOf(
  state: TranscriptState,
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  ctx: AgentContext,
): RequestRecord | null {
  const model = typeof message.model === "string" ? message.model : "";
  if (model === "") return null;
  const requestId = requestIdOf(entry, message, ctx);
  const lastUserTs = state.lastUserTs.get(ctx.agentTag);
  const latency = lastUserTs !== undefined && ctx.ts >= lastUserTs ? ctx.ts - lastUserTs : null;
  return {
    id: requestId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    model,
    upstream: ctx.file.upstream ?? "",
    ts: ctx.ts,
    latencyMs: latency,
    tokens: usageOf(message),
    ...billingOf(message),
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
      // bounded like its sibling maps: a tool_use whose result never lands (an Esc interrupt, a crashed
      // subagent) loses only its duration once the window moves past it, instead of leaking forever
      rememberBounded(
        state.pendingTools,
        block.id,
        {
          name: block.name,
          startedAt: ctx.ts,
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          inputKey: toolInputKey(block.name, block.input),
        },
        512,
      );
    }
  }
  const failed = assistantErrorStatus(entry, message);
  if (failed !== null) emit.apiErrors.push(apiErrorOf(ctx, failed));
  if (entry.isApiErrorMessage === true) emit.notices.push(noticeOf(entry, ctx));
  // Claude Code's own messages and the API errors it reports are not model requests
  if (failed !== null || message.model === SYNTHETIC_MODEL || entry.isApiErrorMessage === true) return;
  const request = requestOf(state, entry, message, ctx);
  if (request === null) return;
  emit.requests.push(request);
  const what = captureContent(state, entry, message, ctx, emit);
  if (what !== undefined) request.what = what;
  const seen = state.lastRequest.get(ctx.agentTag);
  const anyTokens = (seen?.anyTokens ?? false) || totalTokens(request.tokens) > 0;
  state.lastRequest.set(ctx.agentTag, { request, anyTokens });
}

/** A stream's closing `result` event: when no request reported tokens, its usage is the run's total. */
function applyResult(
  state: TranscriptState,
  entry: Record<string, unknown>,
  file: FileIdentity,
): TranscriptEmit {
  const { sessionId, agentId } = agentKeyOf(entry, file);
  const seen = state.lastRequest.get(`${sessionId}:${agentId}`);
  if (seen === undefined || seen.anyTokens) return EMPTY;
  const tokens = usageOf(entry);
  if (totalTokens(tokens) === 0) return EMPTY;
  state.lastRequest.set(`${sessionId}:${agentId}`, { request: seen.request, anyTokens: true });
  return { ...EMPTY, requests: [{ ...seen.request, tokens, totals: true }] };
}

function noticeOf(entry: Record<string, unknown>, ctx: AgentContext): Notice {
  const kind = typeof entry.error === "string" ? entry.error : "";
  return { sessionId: ctx.sessionId, agentId: ctx.agentId, ts: ctx.ts, what: NOTICE_WHAT[kind] ?? "error" };
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
  if (entry.isApiErrorMessage !== true && message.model !== SYNTHETIC_MODEL) return null;
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
  captureUserInput(state, message, ctx);
  emitPromptTitle(state, message, ctx, emit);
  for (const block of contentBlocks(message)) {
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    emit.toolCalls.push(toolResultOf(state, block, block.tool_use_id, ctx));
  }
}

/** The input side of the next request: the prompt text, or tool results, until the agent answers again. */
function captureUserInput(state: TranscriptState, message: Record<string, unknown>, ctx: AgentContext): void {
  const blocks = state.pendingInput.get(ctx.agentTag) ?? [];
  const content = message.content;
  if (typeof content === "string") {
    if (content !== "") {
      const text: ContentBlock = { type: "text" };
      capInto(text, "text", content);
      blocks.push(text);
    }
  } else {
    for (const block of contentBlocks(message)) blocks.push(inputBlockOf(block));
  }
  if (blocks.length === 0) return;
  rememberBounded(state.pendingInput, ctx.agentTag, blocks.slice(-256), 256);
}

/** Parse one transcript line into records, updating the cross-line state (pending tools, last user ts). */
export function feedTranscriptLine(state: TranscriptState, file: FileIdentity, raw: string): TranscriptEmit {
  const entry = parseEntry(raw);
  if (entry === null) return EMPTY;
  if (entry.type === "result") return applyResult(state, entry, file);
  const { sessionId, agentId } = agentKeyOf(entry, file);
  // a naming line has no timestamp; a job's own transcript never renames its job session
  const named = file.remap === undefined;
  const namedOnly = namedMetaOf(entry);
  if (named && namedOnly !== null) return { ...EMPTY, session: { id: sessionId, ...namedOnly } };
  const ts = tsOf(entry);
  if (ts === null) return EMPTY;
  const ctx: AgentContext = { sessionId, agentId, agentTag: `${sessionId}:${agentId}`, ts, file };
  const emit: TranscriptEmit = {
    requests: [],
    toolCalls: [],
    agents: [],
    session: null,
    content: [],
    apiErrors: [],
    interrupts: [],
    notices: [],
  };

  const agent = agentDescriptorOf(state, ctx);
  if (agent !== null) emit.agents.push(agent);
  emit.session = sessionMetaOf(entry, sessionId, named);

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
