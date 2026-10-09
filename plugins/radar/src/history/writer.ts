/**
 * The bridge from the live store to the history file: it queues what every store update holds and
 * writes the batch in one transaction per flush — at most one per 500 ms, plus a final flush on stop —
 * mapping the store's own views (never a re-read of the transcripts) into node, request, tool and
 * event rows, and deriving node rows only for the sessions the batch touched. A request-heavy update
 * skips the views — request rows already carry everything they need — and only a naming or lifecycle
 * change, or the first sighting of a session or agent, re-reads sessionDetail. Nothing is dropped:
 * records queue until they are written. Every failure is contained: the writer logs one line and
 * detaches, and radar runs on without history.
 */
import type { CaptureRecord, SessionView } from "../shared/model.ts";
import type { Change, Store } from "../store/store.ts";
import type { History, NodeUpsert } from "./history.ts";

/** How long updates may queue before the next flush writes them all in one transaction. */
const FLUSH_MS = 500;

export type HistoryWriter = {
  /** Write everything queued so far, now: the shutdown path and tests use it. */
  flush(): void;
  /** Detach from the store, flush what is queued, and close the history file. */
  stop(): void;
};

export type HistoryWriterOptions = { store: Store; history: History };

/** What the writer remembers about a session it has mapped: its node ids, job flag and lead agent. */
type KnownSession = { external: boolean; lead: string; nodes: Set<string> };

/** Which sessions a change touched, from its payload and its records. */
function touchedOf(change: Change): Set<string> {
  const touched = new Set<string>(change.touched);
  for (const request of change.requests) touched.add(request.sessionId);
  for (const tool of change.tools) touched.add(tool.sessionId);
  for (const event of change.events) if (event.sessionId !== null) touched.add(event.sessionId);
  return touched;
}

/**
 * A record's node id: the session's lead agent (main, or a job's own agent) sits on the session node,
 * every other agent on its own `/agent` node. A job's phantom main agent collapses onto the job node.
 */
function nodeIdOf(sessionId: string, agentId: string, external: boolean, lead: string): string {
  if (agentId === "main" || agentId === "" || (external && agentId === lead)) {
    return external ? `job:${sessionId}` : `${sessionId}/main`;
  }
  return `${sessionId}/${agentId}`;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The session node's id, kind and parent: a job hangs under the session that submitted it. */
function rootUpsertOf(view: SessionView, lead: string, lastAt: number | null): NodeUpsert {
  const kind = view.external ? "job" : "main";
  return {
    id: nodeIdOf(view.id, "main", view.external, lead),
    kind,
    sessionId: view.id,
    agentId: lead,
    parentId: view.external && view.parentSessionId !== null ? `${view.parentSessionId}/main` : null,
    name: view.name,
    repo: view.repo,
    branch: view.branch,
    project: view.project,
    cwd: view.cwd,
    model: view.model,
    parentSessionId: view.external ? view.parentSessionId : null,
    startedAt: view.startedAt,
    lastAt,
    endedAt: view.endedAt,
  };
}

/** Subagent nodes are named after their agent view; the session node carries the session's own facts. */
function agentUpsertOf(
  view: SessionView,
  agent: SessionView["agents"][number],
  rootId: string,
  lead: string,
): NodeUpsert {
  const id = nodeIdOf(view.id, agent.id, view.external, lead);
  const parent =
    agent.parentId === null || agent.parentId === agent.id
      ? rootId
      : nodeIdOf(view.id, agent.parentId, view.external, lead);
  return {
    id,
    kind: "subagent",
    sessionId: view.id,
    agentId: agent.id,
    parentId: parent === id ? null : parent,
    name: agent.name,
    agentType: agent.agentType,
    description: agent.description,
    model: agent.model,
    lastAt: agent.lastAt,
  };
}

/** The lead agent: the one whose requests name the session's model — a job's own agent, else main. */
function leadOf(view: SessionView): string {
  const lead = view.external
    ? view.agents.find((agent) => agent.kind === "external")
    : view.agents.find((agent) => agent.id === "main");
  return lead?.id ?? (view.external ? view.id : "main");
}

/** Newest activity the views and this change can vouch for, for the node's last_at clock. */
function lastAtOf(view: SessionView, change: Change): number | null {
  let last: number | null = view.startedAt;
  const newer = (ts: number): void => {
    if (last === null || ts > last) last = ts;
  };
  for (const agent of view.agents) if (agent.lastAt !== null) newer(agent.lastAt);
  for (const request of change.requests) if (request.sessionId === view.id) newer(request.ts);
  for (const tool of change.tools) if (tool.sessionId === view.id) newer(tool.startedAt);
  for (const event of change.events) if (event.sessionId === view.id) newer(event.ts);
  return last;
}

/** Map one session and its agents from the store's view; ends the node when the view says ended. */
function refreshSession(
  store: Store,
  history: History,
  known: Map<string, KnownSession>,
  sessionId: string,
  change: Change,
): void {
  const view = store.sessionDetail(sessionId);
  if (view === null) return;
  const lead = leadOf(view);
  const root = rootUpsertOf(view, lead, lastAtOf(view, change));
  history.upsertNode(root);
  const nodes = new Set<string>([root.id]);
  for (const agent of view.agents) {
    const node = agentUpsertOf(view, agent, root.id, lead);
    if (node.id === root.id) continue;
    history.upsertNode(node);
    nodes.add(node.id);
  }
  known.set(view.id, { external: view.external, lead, nodes });
}

/** The session and agent every record of the change names, in the order they arrived. */
function recordAgentsOf(change: Change): [string, string][] {
  const pairs: [string, string][] = [];
  for (const request of change.requests) pairs.push([request.sessionId, request.agentId || "main"]);
  for (const tool of change.tools) pairs.push([tool.sessionId, tool.agentId ?? "main"]);
  for (const event of change.events) {
    if (event.sessionId !== null) pairs.push([event.sessionId, event.agentId ?? "main"]);
  }
  return pairs;
}

/** A record-bearing update for a session whose nodes are all known already needs no view. */
function needsRefresh(
  known: Map<string, KnownSession>,
  pairs: readonly [string, string][],
  sessionId: string,
): boolean {
  const state = known.get(sessionId);
  if (state === undefined) return true;
  return pairs.some(
    ([session, agentId]) =>
      session === sessionId && !state.nodes.has(nodeIdOf(sessionId, agentId, state.external, state.lead)),
  );
}

/** Everything one batch holds, in one transaction: fresh nodes first, then the records. */
function applyBatch(
  store: Store,
  history: History,
  known: Map<string, KnownSession>,
  batch: Change,
  forced: Set<string>,
): void {
  const pairs = recordAgentsOf(batch);
  for (const sessionId of batch.touched) {
    // a naming or lifecycle change carries no records: the views are the only source, so re-read them
    if (forced.has(sessionId) || needsRefresh(known, pairs, sessionId)) {
      refreshSession(store, history, known, sessionId, batch);
    }
  }
  writeRecords(history, known, batch);
}

export function attachHistoryWriter(options: HistoryWriterOptions): HistoryWriter {
  const { store, history } = options;
  const known = new Map<string, KnownSession>();

  let broken = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Sessions the queued updates touched; the ones a record-less update touched must re-read views. */
  const dirty = new Set<string>();
  const forced = new Set<string>();
  /** Every record the queued updates hold, in arrival order; written once, at the next flush. */
  const queued: Change = { sessions: false, touched: [], requests: [], events: [], tools: [], content: [] };
  /** The captures the queued updates hold, beside the records (Change carries them optionally). */
  const queuedCaptures: CaptureRecord[] = [];

  function queue(change: Change): void {
    markTouched(change);
    for (const request of change.requests) queued.requests.push(request);
    for (const content of change.content) queued.content.push(content);
    for (const tool of change.tools) queued.tools.push(tool);
    for (const event of change.events) queued.events.push(event);
    for (const capture of change.captures ?? []) queuedCaptures.push(capture);
  }

  /** Mark the sessions the change touched; a record-less change (naming, lifecycle) must re-read views. */
  function markTouched(change: Change): void {
    const lifecycle = change.requests.length === 0 && change.tools.length === 0 && change.events.length === 0;
    for (const sessionId of touchedOf(change)) {
      dirty.add(sessionId);
      if (lifecycle) forced.add(sessionId);
    }
  }

  function schedule(): void {
    if (timer !== null || broken || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, FLUSH_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // a batch of captures alone (no session touched) is still worth writing now
    if (broken || (dirty.size === 0 && queuedCaptures.length === 0)) return;
    const batch: Change = {
      sessions: true,
      touched: [...dirty],
      requests: queued.requests,
      events: queued.events,
      tools: queued.tools,
      content: queued.content,
      ...(queuedCaptures.length === 0 ? {} : { captures: [...queuedCaptures] }),
    };
    const reRead = new Set(forced);
    dirty.clear();
    forced.clear();
    queued.requests = [];
    queued.content = [];
    queued.tools = [];
    queued.events = [];
    queuedCaptures.length = 0;
    try {
      history.transaction(() => applyBatch(store, history, known, batch, reRead));
    } catch (e) {
      // the store must never learn that history failed; run without it from here on
      broken = true;
      unsubscribe();
      console.error(`radar: history write failed, history disabled (${errorText(e)})`);
    }
  }

  const unsubscribe = store.onUpdate((change) => {
    if (broken || stopped) return;
    queue(change);
    schedule();
  });

  return {
    flush,
    /** Idempotent: shutdown paths may both try (a self-removal and the caller's stop). */
    stop(): void {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      flush();
      history.close();
    },
  };
}

/** The node id a record of a session lands on, with the defaults a session never mapped gets. */
function recordNodeOf(known: Map<string, KnownSession>, sessionId: string, agentId: string | null): string {
  const state = known.get(sessionId);
  return nodeIdOf(sessionId, agentId ?? "main", state?.external ?? false, state?.lead ?? "main");
}

function writeRecords(history: History, known: Map<string, KnownSession>, change: Change): void {
  for (const request of change.requests) {
    history.putRequest(recordNodeOf(known, request.sessionId, request.agentId || "main"), request);
  }
  for (const content of change.content) {
    history.putContent(content.requestId, { input: content.input, output: content.output });
  }
  for (const tool of change.tools) {
    history.putTool(recordNodeOf(known, tool.sessionId, tool.agentId), tool);
  }
  for (const event of change.events) {
    const node = event.sessionId === null ? null : recordNodeOf(known, event.sessionId, event.agentId);
    history.addEvent(node, event);
  }
  for (const capture of change.captures ?? []) {
    history.putCapture(capture);
  }
}
