/**
 * The in-memory model, rebuilt from disk on start and fed incrementally after that. Bounded: at most
 * MAX_SESSIONS sessions and MAX_RECORDS request/tool/event records, oldest evicted first. Reads group records
 * by session once per version (cached), so a full projection costs one pass, not sessions × records.
 */
import { costOfAll } from "../cost/prices.ts";
import {
  type AgentKind,
  type AgentView,
  type ApiErrorRecord,
  addTokens,
  type EventRecord,
  MAX_RECORDS,
  MAX_SESSIONS,
  type ModelRow,
  type RequestRecord,
  type RouterEventRecord,
  type SessionView,
  type SpoolLine,
  type Summary,
  type ToolCallRecord,
  totalTokens,
  type UpstreamRow,
  ZERO_TOKENS,
} from "../shared/model.ts";
import { modelRows, summarize, toolCounts, upstreamRows } from "./aggregate.ts";

export type SessionListItem = {
  id: string;
  project: string | null;
  cwd: string | null;
  startedAt: number | null;
  endedAt: number | null;
  live: boolean;
  model: string | null;
  agentCount: number;
  requestCount: number;
  tokens: number;
  lastAt: number;
  external: boolean;
  title: string | null;
  /** Estimated USD at list price; null when none of its models is priced. */
  costUsd?: number | null;
};

type AgentState = {
  id: string;
  parentId: string | null;
  kind: AgentKind;
  name: string | null;
  model: string | null;
  live: boolean;
  startedAt: number | null;
  endedAt: number | null;
  title: string | null;
};

type SessionState = {
  id: string;
  cwd: string | null;
  upstream: string | null;
  ccVersion: string | null;
  external: boolean;
  startedAt: number | null;
  endedAt: number | null;
  live: boolean;
  model: string | null;
  lastAt: number;
  agents: Map<string, AgentState>;
};

/** Records grouped by session (and per-agent inside), rebuilt lazily when the version moves. */
type Projection = Map<string, { requests: RequestRecord[]; tools: ToolCallRecord[] }>;

export type Change = {
  sessions: boolean;
  requests: RequestRecord[];
  events: EventRecord[];
  tools: ToolCallRecord[];
};

export type RequestFilter = {
  session?: string;
  agent?: string;
  model?: string;
  since?: number;
  limit?: number;
};

export type SessionUpsert = {
  id: string;
  cwd?: string;
  upstream?: string;
  startedAt?: number;
  external?: boolean;
  ccVersion?: string;
};

export type Store = {
  addSpoolLine(line: SpoolLine): void;
  addRequest(record: RequestRecord): void;
  addToolCall(record: ToolCallRecord): void;
  upsertSession(input: SessionUpsert): void;
  endSession(id: string, endedAt: number): void;
  upsertAgent(input: AgentUpsert): void;
  endAgent(sessionId: string, agentId: string, endedAt: number): void;
  summary(): Summary;
  sessionList(): SessionListItem[];
  sessionDetail(id: string): SessionView | null;
  requests(filter: RequestFilter): RequestRecord[];
  requestsFor(filter: { session?: string; since?: number }): RequestRecord[];
  events(filter: { session?: string; since?: number; limit?: number }): EventRecord[];
  /** Recent tool calls, newest first; `failed` keeps only the ones that errored. */
  tools(filter: { session?: string; failed?: boolean; limit?: number }): ToolCallRecord[];
  models(): {
    models: ModelRow[];
    upstreams: UpstreamRow[];
    tools: { name: string; count: number; failures: number }[];
  };
  /** A 429/5xx seen anywhere (transcript retry, route line, router event); kept for the retry-storm alert. */
  addApiError(record: ApiErrorRecord): void;
  /** A router health event (fallback, refusal, rate limit, budget stop, restart). */
  addRouterEvent(record: RouterEventRecord): void;
  apiErrors(): ApiErrorRecord[];
  routerEvents(): RouterEventRecord[];
  /** Every request, tool call and event held, unsorted — the alert engine's input. */
  raw(): { requests: RequestRecord[]; tools: ToolCallRecord[]; events: EventRecord[] };
  onUpdate(listener: (change: Change) => void): () => void;
  version(): number;
};

/** Side records (API errors, router events) are small and only matter while recent: keep the newest few. */
const MAX_SIDE_RECORDS = 5000;

function tsToMs(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function projectOf(cwd: string | null): string | null {
  if (cwd === null || cwd === "") return null;
  const base = cwd
    .split("/")
    .filter((part) => part !== "")
    .pop();
  return base ?? cwd;
}

function earlierStarted(state: SessionState, startedAt: number | undefined): void {
  if (startedAt === undefined) return;
  if (state.startedAt === null || startedAt < state.startedAt) state.startedAt = startedAt;
}

/** First writer wins each fact; a later upsert only fills what is still blank. */
function applySessionUpsert(state: SessionState, input: SessionUpsert): void {
  if (input.cwd !== undefined && state.cwd === null) state.cwd = input.cwd;
  if (input.upstream !== undefined && state.upstream === null) state.upstream = input.upstream;
  if (input.ccVersion !== undefined && state.ccVersion === null) state.ccVersion = input.ccVersion;
  earlierStarted(state, input.startedAt);
  if (input.external !== undefined) state.external = input.external;
}

type AgentUpsert = {
  sessionId: string;
  id: string;
  parentId?: string | null;
  kind?: AgentKind;
  name?: string | null;
  model?: string | null;
  title?: string | null;
};

function applyAgentUpsert(target: AgentState, input: AgentUpsert): void {
  if (input.parentId !== undefined) target.parentId = input.parentId;
  if (input.kind !== undefined) target.kind = input.kind;
  if (input.name !== undefined && input.name !== null) target.name = input.name;
  if (input.model !== undefined && input.model !== null && target.model === null) {
    target.model = input.model;
  }
  if (input.title !== undefined) target.title = input.title;
  if (input.kind === "external") target.live = true;
}

export function createStore(): Store {
  let seq = 0;
  let ver = 0;
  const sessions = new Map<string, SessionState>();
  const requests = new Map<string, RequestRecord>();
  const tools = new Map<string, ToolCallRecord>();
  const events: EventRecord[] = [];
  const listeners = new Set<(change: Change) => void>();
  const apiErrors: ApiErrorRecord[] = [];
  const routerEvents: RouterEventRecord[] = [];
  /** tool_use ids seen in a PreToolUse spool line but not finished there; transcript pairing completes them. */
  const pendingToolStarts = new Map<string, number>();
  let cache: { version: number; projection: Projection } | null = null;

  function session(id: string): SessionState {
    let state = sessions.get(id);
    if (state === undefined) {
      state = {
        id,
        cwd: null,
        upstream: null,
        ccVersion: null,
        external: false,
        startedAt: null,
        endedAt: null,
        live: true,
        model: null,
        lastAt: 0,
        agents: new Map<string, AgentState>(),
      };
      sessions.set(id, state);
    }
    return state;
  }

  function agent(sessionId: string, agentId: string): AgentState {
    const state = session(sessionId);
    let existing = state.agents.get(agentId);
    if (existing === undefined) {
      existing = {
        id: agentId,
        parentId: agentId === "main" ? null : "main",
        kind: agentId === "main" ? "main" : "subagent",
        name: agentId === "main" ? "main" : agentId,
        model: null,
        live: agentId === "main",
        startedAt: null,
        endedAt: null,
        title: null,
      };
      state.agents.set(agentId, existing);
    }
    return existing;
  }

  function touch(sessionId: string, ts: number): void {
    const state = session(sessionId);
    if (ts > state.lastAt) state.lastAt = ts;
    if (state.startedAt === null || ts < state.startedAt) state.startedAt = ts;
  }

  function projection(): Projection {
    if (cache !== null && cache.version === ver) return cache.projection;
    const map: Projection = new Map();
    for (const request of requests.values()) {
      const bucket = map.get(request.sessionId) ?? { requests: [], tools: [] };
      bucket.requests.push(request);
      map.set(request.sessionId, bucket);
    }
    for (const tool of tools.values()) {
      const bucket = map.get(tool.sessionId) ?? { requests: [], tools: [] };
      bucket.tools.push(tool);
      map.set(tool.sessionId, bucket);
    }
    cache = { version: ver, projection: map };
    return map;
  }

  function dropSession(sessionId: string): void {
    sessions.delete(sessionId);
    for (const [id, record] of requests) if (record.sessionId === sessionId) requests.delete(id);
    for (const [id, record] of tools) if (record.sessionId === sessionId) tools.delete(id);
  }

  function evictSessions(): void {
    if (sessions.size <= MAX_SESSIONS) return;
    const ordered = [...sessions.values()].sort((a, b) => a.lastAt - b.lastAt);
    for (const victim of ordered.slice(0, sessions.size - MAX_SESSIONS)) dropSession(victim.id);
  }

  function drainMap(map: Map<string, RequestRecord | ToolCallRecord>, excess: number): number {
    for (const key of [...map.keys()]) {
      if (excess <= 0) break;
      map.delete(key);
      excess -= 1;
    }
    return excess;
  }

  function evictRecords(): void {
    let excess = requests.size + tools.size + events.length - MAX_RECORDS;
    if (excess <= 0) return;
    excess = drainMap(requests, excess);
    excess = drainMap(tools, excess);
    while (excess > 0 && events.length > 0) {
      events.shift();
      excess -= 1;
    }
  }

  function notify(change: Change): void {
    ver += 1;
    cache = null;
    for (const listener of listeners) listener(change);
  }

  function markSessionLive(sessionId: string, ts: number): void {
    const state = session(sessionId);
    state.live = true;
    state.endedAt = null;
    if (state.startedAt === null || ts < state.startedAt) state.startedAt = ts;
    agent(sessionId, "main").live = true;
  }

  function markSessionEnded(sessionId: string, ts: number): void {
    const state = session(sessionId);
    state.live = false;
    state.endedAt = ts;
    for (const value of state.agents.values()) value.live = false;
  }

  function markSubagentLive(line: SpoolLine, ts: number, sessionId: string, agentId: string): void {
    const target = agent(sessionId, agentId);
    target.live = true;
    target.startedAt = ts;
    if (typeof line.agent_type === "string") target.name = line.agent_type;
    if (typeof line.prompt === "string") target.title = line.prompt.slice(0, 80);
  }

  function markSubagentEnded(sessionId: string, agentId: string, ts: number): void {
    const target = agent(sessionId, agentId);
    target.live = false;
    target.endedAt = ts;
  }

  /** Session and agent lifecycle from one spool line; needs the session/agent closures. */
  function applyLifecycle(
    line: SpoolLine,
    ts: number,
    sessionId: string | null,
    agentId: string | null,
  ): void {
    if (sessionId === null) return;
    switch (line.event) {
      case "SessionStart":
        markSessionLive(sessionId, ts);
        break;
      case "SessionEnd":
        markSessionEnded(sessionId, ts);
        break;
      case "SubagentStart":
        if (agentId !== null) markSubagentLive(line, ts, sessionId, agentId);
        break;
      case "SubagentStop":
        if (agentId !== null) markSubagentEnded(sessionId, agentId, ts);
        break;
      default:
        break;
    }
  }

  const allRequests = (): RequestRecord[] => [...requests.values()];
  const allTools = (): ToolCallRecord[] => [...tools.values()];

  function buildAgentView(
    sessionId: string,
    agentState: AgentState,
    bucket: { requests: RequestRecord[]; tools: ToolCallRecord[] },
  ): AgentView {
    const mine = bucket.requests.filter((r) => r.agentId === agentState.id);
    const myTools = bucket.tools.filter((t) => (t.agentId ?? "main") === agentState.id);
    const lastRequest = mine[mine.length - 1];
    const lastAt = mine.reduce((acc, r) => Math.max(acc, r.ts), 0);
    return {
      id: agentState.id,
      sessionId,
      parentId: agentState.parentId,
      kind: agentState.kind,
      name: agentState.title ?? agentState.name,
      model: lastRequest?.model ?? agentState.model,
      requests: mine.length,
      errors: myTools.filter((t) => !t.ok).length,
      tools: myTools.length,
      tokens: mine.reduce((acc, r) => addTokens(acc, r.tokens), ZERO_TOKENS),
      costUsd: costOfAll(mine),
      live: agentState.live,
      lastAt: lastAt > 0 ? lastAt : (agentState.startedAt ?? agentState.endedAt ?? null),
    };
  }

  function buildSessionView(state: SessionState, proj: Projection): SessionView {
    const bucket = proj.get(state.id) ?? { requests: [], tools: [] };
    const agents = [...state.agents.values()].map((agentState) =>
      buildAgentView(state.id, agentState, bucket),
    );
    agents.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
    const lastRequest = bucket.requests[bucket.requests.length - 1];
    return {
      id: state.id,
      cwd: state.cwd,
      project: projectOf(state.cwd),
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      live: state.live,
      model: state.model ?? lastRequest?.model ?? null,
      upstream: state.upstream ?? lastRequest?.upstream ?? "",
      ccVersion: state.ccVersion,
      requestCount: bucket.requests.length,
      errorCount: bucket.tools.filter((t) => !t.ok).length,
      toolCount: bucket.tools.length,
      tokens: bucket.requests.reduce((acc, r) => addTokens(acc, r.tokens), ZERO_TOKENS),
      agents,
      external: state.external,
    };
  }

  /** Session-scoped facts a spool line can fill in once (first writer wins, later lines keep it). */
  function applyLineMeta(state: SessionState, line: SpoolLine): void {
    if (typeof line.cwd === "string" && state.cwd === null) state.cwd = line.cwd;
    if (typeof line.base_url === "string" && state.upstream === null) state.upstream = line.base_url;
    if (typeof line.cc_version === "string" && state.ccVersion === null) state.ccVersion = line.cc_version;
    if (typeof line.model_env?.ANTHROPIC_MODEL === "string" && state.model === null) {
      state.model = line.model_env.ANTHROPIC_MODEL;
    }
  }

  const store: Store = {
    addSpoolLine(line) {
      const ts = tsToMs(line.ts) ?? Date.now();
      const sessionId = typeof line.session_id === "string" ? line.session_id : null;
      const agentId = typeof line.agent_id === "string" ? line.agent_id : null;
      const change: Change = { sessions: false, requests: [], events: [], tools: [] };
      if (sessionId !== null) {
        touch(sessionId, ts);
        applyLineMeta(session(sessionId), line);
        change.sessions = true;
      }
      applyLifecycle(line, ts, sessionId, agentId);
      applyToolEvent(line, ts, sessionId, agentId, pendingToolStarts, tools, change);
      seq += 1;
      const record: EventRecord = {
        seq,
        ts,
        kind: line.event,
        sessionId,
        agentId,
        label: labelFor(line),
        payload: line,
      };
      events.push(record);
      change.events.push(record);
      evictSessions();
      evictRecords();
      notify(change);
    },

    addRequest(record) {
      const existing = requests.get(record.id);
      const merged: RequestRecord = existing
        ? {
            ...existing,
            model: record.model || existing.model,
            latencyMs: record.latencyMs ?? existing.latencyMs,
            tokens: totalTokens(record.tokens) > 0 ? record.tokens : existing.tokens,
            stopReason: record.stopReason ?? existing.stopReason,
          }
        : record;
      requests.set(record.id, merged);
      touch(merged.sessionId, merged.ts);
      const agentState = agent(merged.sessionId, merged.agentId);
      if (agentState.model === null) agentState.model = merged.model;
      evictRecords();
      notify({ sessions: true, requests: [merged], events: [], tools: [] });
    },

    addToolCall(record) {
      const existing = tools.get(record.id);
      const merged: ToolCallRecord = existing
        ? { ...existing, durationMs: record.durationMs ?? existing.durationMs, ok: record.ok || existing.ok }
        : record;
      tools.set(record.id, merged);
      touch(merged.sessionId, merged.startedAt);
      evictRecords();
      notify({ sessions: true, requests: [], events: [], tools: [merged] });
    },

    upsertSession(input) {
      applySessionUpsert(session(input.id), input);
      agent(input.id, "main");
      evictSessions();
      notify({ sessions: true, requests: [], events: [], tools: [] });
    },

    endSession(id, endedAt) {
      markSessionEnded(id, endedAt);
      notify({ sessions: true, requests: [], events: [], tools: [] });
    },

    upsertAgent(input) {
      agent(input.sessionId, "main");
      applyAgentUpsert(agent(input.sessionId, input.id), input);
      notify({ sessions: true, requests: [], events: [], tools: [] });
    },

    endAgent(sessionId, agentId, endedAt) {
      const target = agent(sessionId, agentId);
      target.live = false;
      target.endedAt = endedAt;
      notify({ sessions: true, requests: [], events: [], tools: [] });
    },

    summary() {
      const proj = projection();
      const views = [...sessions.values()].map((state) => buildSessionView(state, proj));
      return summarize(views, allRequests(), allTools(), Date.now());
    },

    sessionList() {
      const proj = projection();
      return [...sessions.values()]
        .map((state) => {
          const view = buildSessionView(state, proj);
          const title = [...state.agents.values()].find((a) => a.title !== null)?.title ?? null;
          const item: SessionListItem = {
            id: view.id,
            project: view.project,
            cwd: view.cwd,
            startedAt: view.startedAt,
            endedAt: view.endedAt,
            live: view.live,
            model: view.model,
            agentCount: view.agents.length,
            requestCount: view.requestCount,
            tokens: totalTokens(view.tokens),
            lastAt: state.lastAt,
            external: view.external,
            title,
            costUsd: costOfAll(proj.get(state.id)?.requests ?? []),
          };
          return item;
        })
        .sort((a, b) => b.lastAt - a.lastAt);
    },

    sessionDetail(id) {
      const state = sessions.get(id);
      return state === undefined ? null : buildSessionView(state, projection());
    },

    requests(filter) {
      const limit = filter.limit ?? 200;
      return allRequests()
        .filter(matches(filter))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit);
    },

    requestsFor(filter) {
      return allRequests().filter(matches(filter));
    },

    events(filter) {
      const limit = filter.limit ?? 200;
      return events
        .filter(
          (e) =>
            (filter.session === undefined || e.sessionId === filter.session) &&
            (filter.since === undefined || e.ts >= filter.since),
        )
        .slice(-limit)
        .reverse();
    },

    tools(filter) {
      const limit = filter.limit ?? 200;
      return allTools()
        .filter(
          (t) =>
            (filter.session === undefined || t.sessionId === filter.session) &&
            (filter.failed !== true || !t.ok),
        )
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit);
    },

    models() {
      return {
        models: modelRows(allRequests()),
        upstreams: upstreamRows(allRequests()),
        tools: toolCounts(allTools()),
      };
    },

    addApiError(record) {
      apiErrors.push(record);
      if (apiErrors.length > MAX_SIDE_RECORDS) apiErrors.splice(0, apiErrors.length - MAX_SIDE_RECORDS);
      ver += 1;
    },

    addRouterEvent(record) {
      routerEvents.push(record);
      if (routerEvents.length > MAX_SIDE_RECORDS) {
        routerEvents.splice(0, routerEvents.length - MAX_SIDE_RECORDS);
      }
      ver += 1;
    },

    apiErrors() {
      return [...apiErrors];
    },

    routerEvents() {
      return [...routerEvents];
    },

    raw() {
      return { requests: allRequests(), tools: allTools(), events: [...events] };
    },

    onUpdate(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    version() {
      return ver;
    },
  };

  return store;
}

function matches(filter: RequestFilter): (r: RequestRecord) => boolean {
  return (r) =>
    (filter.session === undefined || r.sessionId === filter.session) &&
    (filter.agent === undefined || r.agentId === filter.agent) &&
    (filter.model === undefined || r.model === filter.model) &&
    (filter.since === undefined || r.ts >= filter.since);
}

/** Tool pairing across spool lines: PreToolUse seeds a start, the completion events close it. */
function applyToolEvent(
  line: SpoolLine,
  ts: number,
  sessionId: string | null,
  agentId: string | null,
  pendingToolStarts: Map<string, number>,
  tools: Map<string, ToolCallRecord>,
  change: Change,
): void {
  if (line.event !== "PreToolUse" && line.event !== "PostToolUse" && line.event !== "PostToolUseFailure")
    return;
  if (sessionId === null) return;
  const name = typeof line.tool_name === "string" ? line.tool_name : "unknown";
  const fallbackId = `hook:${sessionId}:${name}:${ts}`;
  const toolUseId = typeof line.tool_use_id === "string" ? line.tool_use_id : fallbackId;
  if (line.event === "PreToolUse") {
    pendingToolStarts.set(toolUseId, ts);
    return;
  }
  const startedAt = pendingToolStarts.get(toolUseId) ?? ts;
  pendingToolStarts.delete(toolUseId);
  const existing = tools.get(toolUseId);
  const record: ToolCallRecord = {
    id: toolUseId,
    sessionId,
    agentId,
    name,
    startedAt,
    durationMs: existing?.durationMs ?? (startedAt < ts ? ts - startedAt : null),
    ok: line.event === "PostToolUse",
  };
  tools.set(toolUseId, record);
  change.tools.push(record);
}

/** The first key holding a string (empty strings count), else undefined. */
function stringAt(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** "Read /a/b.ts": the tool plus the most telling string of its input. */
function toolLabel(name: string, input: unknown): string {
  const hint =
    typeof input === "object" && input !== null
      ? firstStringOf(input as Record<string, unknown>, [
          "file_path",
          "path",
          "command",
          "pattern",
          "url",
          "description",
        ])
      : undefined;
  return hint === undefined ? name : `${name} ${hint.slice(0, 90)}`;
}

/** One-line label for the timeline: what a hook event was about, without dumping its payload. */
function labelFor(line: SpoolLine): string | null {
  const text = stringAt(line, ["prompt", "message"]);
  if (text !== undefined) return text.slice(0, 120);
  if (typeof line.model === "string" && typeof line.upstream === "string") {
    return `${line.model} → ${line.upstream}`;
  }
  if (typeof line.tool_name === "string") return toolLabel(line.tool_name, line.tool_input);
  return stringAt(line, ["agent_type", "reason", "trigger", "source"]) ?? null;
}

function firstStringOf(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}
