/**
 * The shared vocabulary: token counters, the record types the store keeps, and the view shapes the API serves.
 * Records are plain data so the store can aggregate with pure functions and the UI can render from JSON alone.
 */

export type Tokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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

export function totalTokens(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
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
  model: string | null;
  requests: number;
  errors: number;
  tools: number;
  tokens: Tokens;
  live: boolean;
  lastAt: number | null;
  /** Estimated USD at list price; null when none of its models is priced. */
  costUsd?: number | null;
};

export type SessionView = {
  id: string;
  cwd: string | null;
  project: string | null;
  startedAt: number | null;
  endedAt: number | null;
  live: boolean;
  model: string | null;
  upstream: string;
  ccVersion: string | null;
  requestCount: number;
  errorCount: number;
  toolCount: number;
  tokens: Tokens;
  agents: AgentView[];
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
  latency_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
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
