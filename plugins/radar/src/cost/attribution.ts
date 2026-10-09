/**
 * Attribution: who spent what. Ledger rows grouped by repo, project, session, agent or model over today, the
 * last 7 days or the last 30 days, each group with its request count, tokens by kind and estimated cost. The
 * tree nests the same rows repo → session (jobs under the session that submitted them) → agent → model. Pure.
 */
import { addTokens, type Tokens, totalTokens, ZERO_TOKENS } from "../shared/model.ts";
import { homeShort } from "../shared/repo.ts";
import type { LedgerNames, LedgerRow, SessionNames } from "./ledger.ts";
import { addCost, requestCost } from "./prices.ts";

export const ATTRIBUTION_BY = ["repo", "project", "session", "agent", "model"] as const;
export type AttributionBy = (typeof ATTRIBUTION_BY)[number];
export const ATTRIBUTION_RANGES = ["day", "week", "month"] as const;
export type AttributionRange = (typeof ATTRIBUTION_RANGES)[number];

export type AttributionRow = {
  key: string;
  label: string;
  requests: number;
  tokens: Tokens;
  /** Estimated USD at list price; null when no request in the group has a price. */
  costUsd: number | null;
  /** Requests in the group whose model the price table does not know. */
  unpriced: number;
};

/** One drill-down row of the costs tree: a repo, a session, an agent or a model, its summed usage, the model
 *  mix behind it and its children. A job session sits under the session that submitted it; its numbers stay
 *  its own, so no row is ever counted twice. */
export type AttributionNode = AttributionRow & {
  kind: "repo" | "session" | "agent" | "model";
  /** A second word when there is one: the agent type for an agent row. */
  note: string | null;
  /** Tokens per model behind this node, heaviest first: the stacked model-mix bar. */
  mix: { model: string; tokens: number }[];
  children: AttributionNode[];
};

/** Start of the range: local midnight today, or 7 / 30 days back from now. */
export function rangeStart(range: AttributionRange, now: number): number {
  if (range === "week") return now - 7 * 86_400_000;
  if (range === "month") return now - 30 * 86_400_000;
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const shortId = (id: string): string => id.slice(0, 8);

function sessionLabel(names: LedgerNames, sessionId: string): string {
  const known = names.sessions[sessionId];
  const project = known?.project ?? null;
  return project === null ? shortId(sessionId) : `${project} · ${shortId(sessionId)}`;
}

function projectOf(names: LedgerNames, sessionId: string): string | null {
  return names.sessions[sessionId]?.project ?? null;
}

/** A session's repo group: the repo root when known, else the project folder, else no project at all. */
function repoKeyAndLabel(names: LedgerNames, sessionId: string): { key: string; label: string } {
  const known = names.sessions[sessionId];
  const repo = known?.repo ?? null;
  if (repo !== null) return { key: repo, label: homeShort(repo) };
  const project = known?.project ?? null;
  return { key: project ?? "(no project)", label: project ?? "(no project)" };
}

function keyAndLabel(row: LedgerRow, by: AttributionBy, names: LedgerNames): { key: string; label: string } {
  if (by === "model") return { key: row.model, label: row.model };
  if (by === "session") return { key: row.sessionId, label: sessionLabel(names, row.sessionId) };
  if (by === "repo") return repoKeyAndLabel(names, row.sessionId);
  if (by === "project") {
    const project = projectOf(names, row.sessionId);
    return { key: project ?? "(no project)", label: project ?? "(no project)" };
  }
  const key = `${row.sessionId}:${row.agentId}`;
  const agent = row.agentId === "main" ? "main" : (names.agents[key]?.name ?? shortId(row.agentId));
  return { key, label: `${agent} · ${sessionLabel(names, row.sessionId)}` };
}

/** Rows grouped and summed, most expensive first, then most tokens. */
export function attribute(
  rows: LedgerRow[],
  by: AttributionBy,
  names: LedgerNames,
  since: number,
): AttributionRow[] {
  const groups = new Map<string, AttributionRow>();
  for (const row of rows) {
    if (row.ts < since) continue;
    const { key, label } = keyAndLabel(row, by, names);
    const group = groups.get(key) ?? {
      key,
      label,
      requests: 0,
      tokens: { ...ZERO_TOKENS },
      costUsd: null,
      unpriced: 0,
    };
    const cost = requestCost(row)?.usd ?? null;
    group.requests += 1;
    group.tokens = addTokens(group.tokens, row.tokens);
    group.costUsd = addCost(group.costUsd, cost);
    if (cost === null) group.unpriced += 1;
    groups.set(key, group);
  }
  const total = (t: Tokens): number => t.input + t.output + t.cacheRead + t.cacheWrite;
  return [...groups.values()].sort(
    (a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || total(b.tokens) - total(a.tokens),
  );
}

/** Today's estimated spend across every row (null when nothing today is priced). */
export function spendSince(rows: LedgerRow[], since: number): number | null {
  let total: number | null = null;
  for (const row of rows) if (row.ts >= since) total = addCost(total, requestCost(row)?.usd ?? null);
  return total;
}

/* ------------------------------- the tree ------------------------------- */

type Tally = { requests: number; tokens: Tokens; costUsd: number | null; unpriced: number };

type ModelBucket = { model: string; tally: Tally };

type AgentBucket = { key: string; label: string; note: string | null; models: Map<string, ModelBucket> };

type SessionBucket = {
  key: string;
  names: SessionNames;
  agents: Map<string, AgentBucket>;
  jobs: SessionBucket[];
};

const EMPTY_NAMES: SessionNames = {
  project: null,
  title: null,
  repo: null,
  parentSessionId: null,
  name: null,
};

function emptyTally(): Tally {
  return { requests: 0, tokens: { ...ZERO_TOKENS }, costUsd: null, unpriced: 0 };
}

function tallyRow(tally: Tally, row: LedgerRow): void {
  const cost = requestCost(row)?.usd ?? null;
  tally.requests += 1;
  tally.tokens = addTokens(tally.tokens, row.tokens);
  tally.costUsd = addCost(tally.costUsd, cost);
  if (cost === null) tally.unpriced += 1;
}

function addTally(into: Tally, from: Tally): void {
  into.requests += from.requests;
  into.tokens = addTokens(into.tokens, from.tokens);
  into.costUsd = addCost(into.costUsd, from.costUsd);
  into.unpriced += from.unpriced;
}

function tallyOf(items: Iterable<{ tally: Tally }>): Tally {
  const tally = emptyTally();
  for (const item of items) addTally(tally, item.tally);
  return tally;
}

/** The same sum over nodes already built: what a repo row shows once its sessions are done. */
function sumNodes(nodes: Iterable<AttributionNode>): Tally {
  const tally = emptyTally();
  for (const node of nodes) {
    tally.requests += node.requests;
    tally.tokens = addTokens(tally.tokens, node.tokens);
    tally.costUsd = addCost(tally.costUsd, node.costUsd);
    tally.unpriced += node.unpriced;
  }
  return tally;
}

const mixOrder = (a: { model: string; tokens: number }, b: { model: string; tokens: number }): number =>
  b.tokens - a.tokens || a.model.localeCompare(b.model);

/** Heaviest model first, then by name: one bar segment per model behind a node. */
function mixOf(models: Iterable<ModelBucket>): AttributionNode["mix"] {
  return [...models].map(({ model, tally }) => ({ model, tokens: totalTokens(tally.tokens) })).sort(mixOrder);
}

/** The mixes of several nodes folded into one, heaviest model first: what a repo row's bar shows. */
function mergeMix(parts: AttributionNode["mix"][]): AttributionNode["mix"] {
  const totals = new Map<string, number>();
  for (const part of parts) {
    for (const { model, tokens } of part) totals.set(model, (totals.get(model) ?? 0) + tokens);
  }
  return [...totals].map(([model, tokens]) => ({ model, tokens })).sort(mixOrder);
}

/** Most expensive first, then most tokens; nothing priced sinks (same order the flat groupings use). */
const bySpend = (a: AttributionNode, b: AttributionNode): number =>
  (b.costUsd ?? -1) - (a.costUsd ?? -1) || totalTokens(b.tokens) - totalTokens(a.tokens);

const modelNode = (bucket: ModelBucket): AttributionNode => ({
  kind: "model",
  key: bucket.model,
  label: bucket.model,
  note: null,
  ...bucket.tally,
  mix: [{ model: bucket.model, tokens: totalTokens(bucket.tally.tokens) }],
  children: [],
});

const agentNode = (bucket: AgentBucket): AttributionNode => {
  const models = [...bucket.models.values()];
  return {
    kind: "agent",
    key: bucket.key,
    label: bucket.label,
    note: bucket.note,
    ...tallyOf(models),
    mix: mixOf(models),
    children: models.map(modelNode).sort(bySpend),
  };
};

/** What a session is called in the tree: its own name, else the title an agent carried, else its short id. */
const sessionLabelOf = (session: SessionBucket): string =>
  session.names.name ?? session.names.title ?? shortId(session.key);

const sessionNode = (bucket: SessionBucket): AttributionNode => {
  const agents = [...bucket.agents.values()];
  // The session's models, folded one bucket per model: an agent and its subagents behind one model are
  // one bar segment and one token total, not one per agent — the mix the type promises, one entry per
  // model behind the node.
  const byModel = new Map<string, ModelBucket>();
  for (const agent of agents) {
    for (const model of agent.models.values()) {
      const held = byModel.get(model.model) ?? { model: model.model, tally: emptyTally() };
      addTally(held.tally, model.tally);
      byModel.set(model.model, held);
    }
  }
  const models = [...byModel.values()];
  // the session's own agent leads, then the subagents by spend, then the jobs it submitted
  const ordered = agents
    .map((agent) => ({ main: agent.key === `${bucket.key}:main`, node: agentNode(agent) }))
    .sort((a, b) => Number(b.main) - Number(a.main) || bySpend(a.node, b.node))
    .map((entry) => entry.node);
  return {
    kind: "session",
    key: bucket.key,
    label: sessionLabelOf(bucket),
    note: null,
    ...tallyOf(models),
    mix: mixOf(models),
    children: [...ordered, ...bucket.jobs.map(sessionNode).sort(bySpend)],
  };
};

/** True when the session's parent chain circles back on itself; such a session stays a top row, since a
 *  corrupted parent record must not hang the tree (or the build) in a loop. */
function hasParentLoop(session: SessionBucket, byId: Map<string, SessionBucket>): boolean {
  const seen = new Set<string>([session.key]);
  let at = session.names.parentSessionId;
  while (at !== null) {
    if (seen.has(at)) return true;
    seen.add(at);
    at = byId.get(at)?.names.parentSessionId ?? null;
  }
  return false;
}

const repoNode = (key: string, label: string, group: SessionBucket[]): AttributionNode => {
  const byId = new Map(group.map((session) => [session.key, session]));
  const top: SessionBucket[] = [];
  for (const session of group) {
    const parent =
      session.names.parentSessionId === null ? null : (byId.get(session.names.parentSessionId) ?? null);
    if (parent === null || hasParentLoop(session, byId)) top.push(session);
    else parent.jobs.push(session);
  }
  const sessions = group.map(sessionNode);
  return {
    kind: "repo",
    key,
    label,
    note: null,
    ...sumNodes(sessions),
    mix: mergeMix(sessions.map((session) => session.mix)),
    children: top.map(sessionNode).sort(bySpend),
  };
};

/** One pass over the rows: a bucket per session, per agent, per model, each carrying the names on record. */
function sessionBuckets(rows: LedgerRow[], names: LedgerNames, since: number): Map<string, SessionBucket> {
  const sessions = new Map<string, SessionBucket>();
  for (const row of rows) {
    if (row.ts < since) continue;
    const session = sessions.get(row.sessionId) ?? {
      key: row.sessionId,
      names: names.sessions[row.sessionId] ?? EMPTY_NAMES,
      agents: new Map<string, AgentBucket>(),
      jobs: [],
    };
    const named = names.agents[`${row.sessionId}:${row.agentId}`];
    const agent = session.agents.get(row.agentId) ?? {
      key: `${row.sessionId}:${row.agentId}`,
      label: named?.description ?? (row.agentId === "main" ? "main" : (named?.name ?? shortId(row.agentId))),
      note: named?.type ?? null,
      models: new Map<string, ModelBucket>(),
    };
    const model = agent.models.get(row.model) ?? { model: row.model, tally: emptyTally() };
    tallyRow(model.tally, row);
    agent.models.set(row.model, model);
    session.agents.set(row.agentId, agent);
    sessions.set(row.sessionId, session);
  }
  return sessions;
}

/** The costs drill-down over the same rows the flat groupings sum: repos → sessions (jobs nested under the
 *  session that submitted them, an unattached job directly under its repo) → agents → models. */
export function attributionTree(rows: LedgerRow[], names: LedgerNames, since: number): AttributionNode[] {
  const groups = new Map<string, { label: string; sessions: SessionBucket[] }>();
  for (const session of sessionBuckets(rows, names, since).values()) {
    const { key, label } = repoKeyAndLabel(names, session.key);
    const group = groups.get(key) ?? { label, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => repoNode(key, group.label, group.sessions)).sort(bySpend);
}
