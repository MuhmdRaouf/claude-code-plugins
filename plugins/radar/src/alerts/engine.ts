/**
 * The alerts engine (GET /api/alerts): pure detection over what radar already holds.
 *
 *  - stuck:       a live session mid-turn (a prompt with no Stop after it) with no request, tool result or agent
 *                 event for 10 min — 30 min while a tool is still running — and no Notification since (Claude Code
 *                 sends one when it waits on the user). Past 6 h of silence a session counts as abandoned, not stuck.
 *  - loop:        the same tool with the same input called 5 times in a row by one agent, the last within 30 min.
 *  - retry_storm: 5 or more 429/5xx answers within 2 minutes for one session (or one router), the last within 10 min.
 *  - context:     an agent's last request filled 85% of its context window (200k, or 1M when the session shows
 *                 it has one), no compaction since, within the last 6 h. A request holding a run's total from
 *                 a result event is not one call's context: those requests never fire it.
 *  - budget:      a budget at 80% or more of its limit this period (and again at 100%).
 *
 * Ids are stable for one occurrence, so a dismissal holds until the same thing happens again.
 */
import type { BudgetSpend } from "../budget/budgets.ts";
import { contextOf, contextWindow, isRunTotal } from "../shared/context.ts";
import type { ApiErrorRecord, EventRecord, RequestRecord, ToolCallRecord } from "../shared/model.ts";
import { scopeLabel } from "../shared/provider.ts";
import type { SessionListItem } from "../store/store.ts";

export const ALERT_KINDS = ["stuck", "loop", "retry_storm", "budget", "context"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export type Alert = {
  id: string;
  kind: AlertKind;
  sessionId: string;
  agentId: string | null;
  project: string;
  since: number;
  detail: string;
  costUsd: number | null;
  /** "warn" or "err": how loud the dashboard shows it. */
  severity: "warn" | "err";
};

export type Thresholds = {
  stuckMs: number;
  stuckToolMs: number;
  abandonedMs: number;
  loopRepeats: number;
  loopFreshMs: number;
  retryCount: number;
  retryWindowMs: number;
  retryFreshMs: number;
  contextRatio: number;
  budgetWarnPct: number;
};

const MINUTE = 60_000;

export const DEFAULT_THRESHOLDS: Thresholds = {
  stuckMs: 10 * MINUTE,
  stuckToolMs: 30 * MINUTE,
  abandonedMs: 6 * 60 * MINUTE,
  loopRepeats: 5,
  loopFreshMs: 30 * MINUTE,
  retryCount: 5,
  retryWindowMs: 2 * MINUTE,
  retryFreshMs: 10 * MINUTE,
  contextRatio: 0.85,
  budgetWarnPct: 80,
};

export type AlertInput = {
  now: number;
  sessions: SessionListItem[];
  requests: RequestRecord[];
  tools: ToolCallRecord[];
  events: EventRecord[];
  apiErrors: ApiErrorRecord[];
  budgets: BudgetSpend[];
};

type SessionData = { requests: RequestRecord[]; tools: ToolCallRecord[]; events: EventRecord[] };

const END_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);
const ACTIVITY_EVENTS = new Set([
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
]);

function groupBySession(input: AlertInput): Map<string, SessionData> {
  const map = new Map<string, SessionData>();
  const bucket = (id: string): SessionData => {
    let entry = map.get(id);
    if (entry === undefined) {
      entry = { requests: [], tools: [], events: [] };
      map.set(id, entry);
    }
    return entry;
  };
  for (const r of input.requests) bucket(r.sessionId).requests.push(r);
  for (const t of input.tools) bucket(t.sessionId).tools.push(t);
  for (const e of input.events) if (e.sessionId !== null) bucket(e.sessionId).events.push(e);
  for (const entry of map.values()) {
    entry.requests.sort((a, b) => a.ts - b.ts);
    entry.tools.sort((a, b) => a.startedAt - b.startedAt);
    entry.events.sort((a, b) => a.ts - b.ts);
  }
  return map;
}

function lastTs(events: EventRecord[], kinds: Set<string>): number | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== undefined && kinds.has(event.kind)) return event.ts;
  }
  return null;
}

const toolEnd = (t: ToolCallRecord): number => t.startedAt + (t.durationMs ?? 0);

function lastActivityOf(data: SessionData): number | null {
  const candidates: number[] = [];
  const lastRequest = data.requests[data.requests.length - 1];
  if (lastRequest !== undefined) candidates.push(lastRequest.ts);
  for (const tool of data.tools) candidates.push(toolEnd(tool));
  const event = lastTs(data.events, ACTIVITY_EVENTS);
  if (event !== null) candidates.push(event);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

/** Is the session in the middle of a turn (as opposed to waiting for the user to type)? */
function turnOpen(data: SessionData, lastActivity: number): boolean {
  const lastRequest = data.requests[data.requests.length - 1];
  if (lastRequest !== undefined && lastRequest.ts >= lastActivity && lastRequest.agentId === "main") {
    if (lastRequest.stopReason !== null && END_REASONS.has(lastRequest.stopReason)) return false;
  }
  const prompt = lastTs(data.events, new Set(["UserPromptSubmit"]));
  const stop = lastTs(data.events, new Set(["Stop", "SessionEnd", "Interrupted"]));
  if (prompt !== null) return stop === null || prompt > stop;
  // no hook lines for this session: only a request that asked for a tool says a turn is still going
  return lastRequest?.stopReason === "tool_use";
}

/** The fields every session-scoped alert shares. */
function sessionAlert(
  kind: AlertKind,
  session: SessionListItem,
  agentId: string | null,
  fields: { id: string; since: number; detail: string; severity: Alert["severity"] },
): Alert {
  return {
    kind,
    sessionId: session.id,
    agentId: agentId === "main" ? null : agentId,
    project: session.project ?? "",
    costUsd: session.costUsd ?? null,
    ...fields,
  };
}

/** The silence in a turn that is still open, or null when the session is idle, waiting, done or abandoned. */
function turnSilence(session: SessionListItem, data: SessionData): number | null {
  if (!session.live || session.external) return null;
  const lastActivity = lastActivityOf(data);
  if (lastActivity === null || !turnOpen(data, lastActivity)) return null;
  const notified = lastTs(data.events, new Set(["Notification"]));
  return notified !== null && notified >= lastActivity ? null : lastActivity; // a Notification: waiting on the user
}

function stuckAlert(session: SessionListItem, data: SessionData, now: number, t: Thresholds): Alert | null {
  const lastActivity = turnSilence(session, data);
  if (lastActivity === null) return null;
  const lastRequest = data.requests[data.requests.length - 1];
  const toolRunning = lastRequest?.stopReason === "tool_use" && lastRequest.ts >= lastActivity;
  const idle = now - lastActivity;
  if (idle < (toolRunning ? t.stuckToolMs : t.stuckMs) || idle > t.abandonedMs) return null;
  const minutes = Math.floor(idle / MINUTE);
  return sessionAlert("stuck", session, lastRequest?.agentId ?? null, {
    id: `stuck:${session.id}:${lastActivity}`,
    since: lastActivity,
    detail: toolRunning
      ? `A tool has been running for ${minutes} min with nothing back`
      : `No request or tool activity for ${minutes} min in the middle of a turn`,
    severity: "err",
  });
}

/** The current run of identical calls at the end of one agent's tool calls. */
export function trailingStreak(calls: ToolCallRecord[]): ToolCallRecord[] {
  const last = calls[calls.length - 1];
  if (last?.inputKey === undefined) return [];
  let start = calls.length - 1;
  const same = (call: ToolCallRecord | undefined): boolean =>
    call !== undefined && call.inputKey === last.inputKey && call.name === last.name;
  while (start > 0 && same(calls[start - 1])) start -= 1;
  return calls.slice(start);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list === undefined) map.set(k, [item]);
    else list.push(item);
  }
  return map;
}

function loopAlerts(session: SessionListItem, data: SessionData, now: number, t: Thresholds): Alert[] {
  const alerts: Alert[] = [];
  for (const [agentId, calls] of groupBy(data.tools, (tool) => tool.agentId ?? "main")) {
    const streak = trailingStreak(calls);
    const first = streak[0];
    const last = streak[streak.length - 1];
    if (first === undefined || last === undefined || streak.length < t.loopRepeats) continue;
    if (now - last.startedAt > t.loopFreshMs) continue;
    alerts.push(
      sessionAlert("loop", session, agentId, {
        id: `loop:${session.id}:${agentId}:${first.id}`,
        since: first.startedAt,
        detail: `${last.name} called ${streak.length} times in a row with the same input`,
        severity: "warn",
      }),
    );
  }
  return alerts;
}

function contextAlerts(session: SessionListItem, data: SessionData, now: number, t: Thresholds): Alert[] {
  if (!session.live) return [];
  const window = contextWindow(data.requests);
  const lastByAgent = new Map(data.requests.map((request) => [request.agentId, request]));
  const compacted = lastTs(data.events, new Set(["PreCompact"])) ?? -1;
  const alerts: Alert[] = [];
  for (const [agentId, request] of lastByAgent) {
    if (isRunTotal(request)) continue; // the job's total would read as many windows over
    const used = contextOf(request);
    const stale = now - request.ts > t.abandonedMs || compacted >= request.ts;
    if (used / window < t.contextRatio || stale) continue;
    const pct = Math.round((used / window) * 100);
    alerts.push(
      sessionAlert("context", session, agentId, {
        id: `context:${session.id}:${agentId}:${request.id}`,
        since: request.ts,
        detail: `Context at ${Math.round(used / 1000)}k of ${window / 1000}k tokens (${pct}%): compaction is near`,
        severity: "warn",
      }),
    );
  }
  return alerts;
}

/** Retryable failures in the freshness window, grouped by session (or by router when no session is known). */
function failuresBySubject(input: AlertInput, t: Thresholds): Map<string, ApiErrorRecord[]> {
  const fresh = input.apiErrors.filter((f) => f.ts <= input.now && input.now - f.ts <= t.retryFreshMs);
  return groupBy(fresh, (f) => f.sessionId ?? `router:${f.plugin ?? "unknown"}`);
}

function retryDetail(window: ApiErrorRecord[], t: Thresholds): string {
  const first = window[0];
  const statuses = [...new Set(window.map((f) => f.status))].sort().join(", ");
  const where =
    first?.sessionId === null && first.plugin !== null
      ? ` at the ${scopeLabel(`provider:${first.plugin}`)} router`
      : "";
  return `${window.length} rate limits or server errors (${statuses}) within ${Math.round(
    t.retryWindowMs / MINUTE,
  )} min${where}`;
}

function retryAlerts(input: AlertInput, t: Thresholds, sessions: Map<string, SessionListItem>): Alert[] {
  const alerts: Alert[] = [];
  for (const [subject, failures] of failuresBySubject(input, t)) {
    const window = densestWindow(
      failures.sort((a, b) => a.ts - b.ts),
      t.retryWindowMs,
    );
    const first = window[0];
    if (first === undefined || window.length < t.retryCount) continue;
    const session = sessions.get(subject) ?? {
      id: first.sessionId ?? "",
      project: null,
      costUsd: null,
    };
    alerts.push({
      ...sessionAlert("retry_storm", session as SessionListItem, null, {
        id: `retry_storm:${subject}:${first.ts}`,
        since: first.ts,
        detail: retryDetail(window, t),
        severity: "err",
      }),
    });
  }
  return alerts;
}

/** The longest run of failures fitting in one window (the earliest such run on a tie). */
function densestWindow(failures: ApiErrorRecord[], windowMs: number): ApiErrorRecord[] {
  let best: ApiErrorRecord[] = [];
  let start = 0;
  for (let end = 0; end < failures.length; end += 1) {
    const endTs = failures[end]?.ts ?? 0;
    while ((failures[start]?.ts ?? endTs) < endTs - windowMs) start += 1;
    if (end - start + 1 > best.length) best = failures.slice(start, end + 1);
  }
  return best;
}

const PERIOD_WORD = { day: "daily", week: "weekly", month: "monthly" } as const;

function budgetAlerts(input: AlertInput, t: Thresholds): Alert[] {
  const alerts: Alert[] = [];
  for (const spend of input.budgets) {
    if (spend.pct < t.budgetWarnPct) continue;
    const over = spend.pct >= 100;
    const action = spend.action === "stop" ? (over ? "requests are stopped" : "stops at 100%") : "warn only";
    alerts.push({
      id: `budget:${spend.id}:${spend.periodStart}:${over ? 100 : t.budgetWarnPct}`,
      kind: "budget",
      sessionId: "",
      agentId: null,
      project: "",
      since: spend.periodStart,
      detail: `${scopeLabel(spend.scope)} ${PERIOD_WORD[spend.period]} budget at ${Math.round(spend.pct)}% ($${spend.spentUsd.toFixed(2)} of $${spend.limitUsd.toFixed(2)}), ${action}`,
      costUsd: spend.spentUsd,
      severity: over ? "err" : "warn",
    });
  }
  return alerts;
}

const SEVERITY_ORDER = { err: 0, warn: 1 } as const;

/** Every alert that holds right now, loudest and newest first. */
export function detectAlerts(input: AlertInput, thresholds: Thresholds = DEFAULT_THRESHOLDS): Alert[] {
  const grouped = groupBySession(input);
  const sessions = new Map(input.sessions.map((s) => [s.id, s]));
  const alerts: Alert[] = [];
  for (const session of input.sessions) {
    const data = grouped.get(session.id);
    if (data === undefined) continue;
    const stuck = stuckAlert(session, data, input.now, thresholds);
    if (stuck !== null) alerts.push(stuck);
    alerts.push(...loopAlerts(session, data, input.now, thresholds));
    alerts.push(...contextAlerts(session, data, input.now, thresholds));
  }
  alerts.push(...retryAlerts(input, thresholds, sessions), ...budgetAlerts(input, thresholds));
  return alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.since - a.since);
}
