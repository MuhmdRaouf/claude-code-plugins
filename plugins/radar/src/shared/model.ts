/**
 * The shared vocabulary: token counters, the record types the store keeps, and the view shapes the API serves.
 * Records are plain data so the store can aggregate with pure functions and the UI can render from JSON alone.
 */

export type Tokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The reasoning part of `output` the provider breaks out (usage.output_tokens_details); a subset,
   *  never added again — absent when the usage block said nothing or said zero. */
  thinking?: number;
};

export const ZERO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** The timeline event for an error notice Claude Code wrote itself (a usage limit, a lost connection). */
export const NOTICE_EVENT = "Notice";

/** The session a router's request counts under when no Claude Code session sent it (a curl, a script). */
export const OUTSIDE_SESSION = "outside-a-session";

/** The name the unattached traffic shows under, in the live rail and as its History group. */
export const UNATTACHED_NAME = "Unattached";

/** One entry of Claude Code's own session registry: a running interactive session, one file per pid. */
export type RegistrySession = {
  pid: number;
  sessionId: string;
  /** The session's display name, when someone named it (see nameSource). */
  name: string | null;
  /** Who set the name ("user" wins over everything radar derived itself). */
  nameSource: string | null;
  /** What the session is doing right now ("busy", "idle", …). */
  status: string | null;
  /** Where the session works, when the registry file says; a session ingest never saw still gets one. */
  cwd: string | null;
  /** When the session started, in epoch ms, when the registry file says; else null. */
  startedAt: number | null;
};

/** The per-session activity sparkline: 48 buckets of request counts, each naming its most-seen model. */
export type Activity = { bucketMs: number; counts: number[]; models: string[] };

/** How many buckets a sparkline holds, live or ended. */
export const ACTIVITY_BUCKETS = 48;
/** A live session's activity window: its last 15 minutes, so one bucket is 18,750 ms. */
export const ACTIVITY_LIVE_MS = 15 * 60_000;
export const ACTIVITY_LIVE_BUCKET_MS = ACTIVITY_LIVE_MS / ACTIVITY_BUCKETS;

/** The name-shaped head of a prompt: whitespace folded to single spaces, cut at 80 characters. */
export function promptTitle(text: string): string {
  const oneLine = text.replace(/\s+/gu, " ").trim();
  return oneLine.length <= 80 ? oneLine : oneLine.slice(0, 80);
}

export function totalTokens(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/** A request still streaming: no stop reason yet and no output tokens — its numbers are the opening
 *  estimate, so nothing prices it and the views show it as still running until the final copy lands. */
export function isInFlight(r: { stopReason?: string | null; tokens: Pick<Tokens, "output"> }): boolean {
  return (r.stopReason ?? null) === null && r.tokens.output === 0;
}

/** One model request = one assistant message (streaming duplicates merged by requestId before this point). */
export type RequestRecord = {
  id: string;
  sessionId: string;
  agentId: string;
  model: string;
  upstream: string;
  ts: number;
  latencyMs: number | null;
  tokens: Tokens;
  stopReason: string | null;
  provider: string;
  /** How a provider plugin's router sent it ("anthropic" passthrough, "provider"); absent when no router saw it. */
  route?: string;
  /** The router it went through: the plugin's name ("zai") from its spool line, or the router's address when
   *  only the session's base URL said so; absent for a direct call. `upstream` is where the router sent it. */
  via?: string;
  /** Tokens are the run's total from its result event, not one call's context; the context alert skips these. */
  totals?: true;
  /** Why a failed call failed: the provider's own one-line reason, or the router's note on a dropped
   *  connection, from the route line it wrote. Absent on a success and on a call no router saw. */
  error?: string;
  /** The agent chain this call's agent hangs under, from a route line's parent_agent_id; absent when
   *  the line did not say. */
  parentAgentId?: string;
  /** The part of tokens.cacheWrite the request wrote to the 1-hour cache; absent when the usage block said nothing. */
  cacheWrite1h?: number;
  /** How fast the provider ran it ("fast" bills fast-mode rates); absent when the usage block said nothing. */
  speed?: string;
  /** The provider's inference region ("us" bills Claude at ×1.1); absent when the usage block said nothing. */
  geo?: string;
  /** The provider's service tier ("priority" bills MiniMax at ×1.5); absent when the usage block said nothing. */
  serviceTier?: string;
  /** One line on what the call was, computed at ingest from its captured content: the input kind
   *  ("↳ prompt: …" / "↳ N tool results") and the output's tool calls ("→ Edit a.ts, Bash git status")
   *  or "→ text", joined by two spaces. Absent when nothing was captured. */
  what?: string;
  /** The hash the request's system prompt and tools sit under in the history's captures table, from the
   *  route line; absent when the request carried neither and no capture exists. */
  promptHash?: string;
  /** The allow-listed response headers the route line recorded; absent when it recorded none. */
  headers?: Record<string, string>;
};

/** One distinct prompt a router captured: its hash, its gzip bytes as base64 exactly as the spool line
 *  carried them, and when the first request carrying it was seen. Stored once, never re-expanded. */
export type CaptureRecord = {
  hash: string;
  gz: string;
  firstTs: number;
};

export type ToolCallRecord = {
  id: string;
  sessionId: string;
  agentId: string | null;
  name: string;
  startedAt: number;
  durationMs: number | null;
  ok: boolean;
  /** A short hash of the tool's name and input, so the loop detector can see the same call repeated. */
  inputKey?: string;
};

/** A request that came back 429 or 5xx: from a transcript's API-error entry, a route line or a router event. */
export type ApiErrorRecord = {
  ts: number;
  sessionId: string | null;
  agentId: string | null;
  status: number;
  source: "transcript" | "route" | "router";
  /** The provider plugin whose router saw it (route/router sources), else null. */
  plugin: string | null;
};

export const ROUTER_EVENT_KINDS = ["fallback", "refusal", "rate_limited", "budget_stop", "restart"] as const;
export type RouterEventKind = (typeof ROUTER_EVENT_KINDS)[number];

/** One router health event a provider plugin's router appended to the spool (never a key, never a body). */
export type RouterEventRecord = {
  ts: number;
  plugin: string;
  event: RouterEventKind;
  reason: string;
  model: string | null;
};

export type EventRecord = {
  seq: number;
  ts: number;
  kind: string;
  sessionId: string | null;
  agentId: string | null;
  label: string | null;
  payload: unknown;
};

export type AgentKind = "main" | "subagent" | "external";

export type AgentView = {
  id: string;
  sessionId: string;
  parentId: string | null;
  kind: AgentKind;
  name: string | null;
  /** What kind of agent ran (general-purpose, fork, …), from its subagents meta file; null when unknown. */
  agentType: string | null;
  /** The agent's task, from the same meta file; null when unknown. */
  description: string | null;
  model: string | null;
  requests: number;
  errors: number;
  tools: number;
  tokens: Tokens;
  live: boolean;
  lastAt: number | null;
  /** Estimated USD at list price; null when none of its models is priced. */
  costUsd?: number | null;
  /** The agent's request latency at the 95th percentile; null under five timed requests — too few
   *  for a percentile to say anything. */
  latencyP95?: number | null;
};

export type SessionView = {
  id: string;
  cwd: string | null;
  project: string | null;
  /** The session's name: its custom title, agent name, AI title or slug; a job's brief title. */
  name: string | null;
  /** The git branch the session works on; a job's workspace branch. */
  branch: string | null;
  /** The repository the session works in; a job's workspace repo root. */
  repo: string | null;
  /** The session a job was submitted from; null for a plain session. */
  parentSessionId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  live: boolean;
  /** Whether the session is working or idle, from Claude Code's registry; null when it cannot tell. */
  status: "working" | "idle" | null;
  /** Request activity in 48 buckets: a live session's last 15 minutes, an ended one's whole span. */
  activity: Activity;
  model: string | null;
  upstream: string;
  ccVersion: string | null;
  requestCount: number;
  errorCount: number;
  toolCount: number;
  tokens: Tokens;
  agents: AgentView[];
  /** How many of those agents are live right now: the same rule the agents carry — a live parent and
   *  work (or a start) under five minutes old. Zero hides the card's live badge. */
  liveAgentCount: number;
  external: boolean;
};

export type Summary = {
  sessions: number;
  liveSessions: number;
  agents: number;
  requests: number;
  tokens: Tokens;
  errors: number;
  toolCalls: number;
  latencyP50: number | null;
  latencyP95: number | null;
  startedAt: number | null;
  now: number;
  /** Estimated USD at list price for everything in view; null when nothing in it is priced. */
  costUsd?: number | null;
};

export type ModelRow = {
  model: string;
  provider: string;
  requests: number;
  errors: number;
  tokens: Tokens;
  latencyP50: number | null;
  costUsd?: number | null;
};

export type UpstreamRow = {
  upstream: string;
  host: string;
  requests: number;
  tokens: Tokens;
  /** Estimated USD at list price; null when nothing sent there is priced. */
  costUsd?: number | null;
};

/** A parsed spool line, as the hook wrote it. Unknown fields ride along under [key: string]. */
export type SpoolLine = {
  ts: string;
  event: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: string;
  source?: string;
  reason?: string;
  trigger?: string;
  pid?: number;
  ppid?: number;
  base_url?: string;
  model_env?: Record<string, string>;
  cc_version?: string;
  /** a router health line may say null: no model involved */
  model?: string | null;
  upstream?: string;
  status?: string;
  /** Why an error answer or a dropped connection failed, as the route line's reason carries it. */
  error?: string;
  /** The agent chain the calling agent hangs under, as Claude Code stamped the forwarded request. */
  parent_agent_id?: string;
  /** The prompt hash a route line names (its capture sits under it) and the allow-listed response
   *  headers it recorded; a capture line carries the hash again with the gzipped content. */
  prompt_hash?: string;
  headers?: Record<string, string>;
  gz?: string;
  latency_ms?: number;
  /** The usage the router copied verbatim off the provider stream; anything past the four counters
   *  (thinking tokens, billing conditions) is read defensively, like the transcript's own usage. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type RouteEvent = {
  ts: number;
  sessionId: string | null;
  model: string;
  upstream: string;
  status: string | null;
  latencyMs: number | null;
  tokens: Tokens;
};

export const MAX_SESSIONS = 200;
export const MAX_RECORDS = 200_000;
