/**
 * The ingest loop: every tick it tails the spool (hook lines), the transcripts referenced there plus anything
 * recent under the projects dir, and zai job attempts, feeding the store. New files are picked up on a slower
 * rescan cadence. All failures are contained per file — one unreadable transcript must never stop the rest.
 */
import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pluginOf } from "../cost/prices.ts";
import { isRouterEventLine, parseRouterEvent } from "../router/health.ts";
import type { ApiErrorRecord, RequestRecord, SpoolLine } from "../shared/model.ts";
import { claudeConfigDir } from "../shared/paths.ts";
import { DEFAULT_UPSTREAM } from "../shared/provider.ts";
import type { Store } from "../store/store.ts";
import { listSpoolFiles, parseSpoolLine } from "./spool.ts";
import { openTail, type TailState, tailFile } from "./tailer.ts";
import {
  type FileIdentity,
  feedTranscriptLine,
  identifyFile,
  newTranscriptState,
  type SessionMeta,
  type TranscriptEmit,
  type TranscriptState,
} from "./transcript.ts";
import { readZaiJobs, type ZaiJob } from "./zai.ts";

type FileTail = { tail: TailState; parser: TranscriptState; identity: FileIdentity; path: string };

export type WatcherOptions = {
  env: NodeJS.ProcessEnv;
  store: Store;
  sinceMs: number;
  intervalMs?: number;
  rescanMs?: number;
  now?: () => number;
};

export type Watcher = { stop(): void; pollOnce(): void };

/** The timeline line for a turn the user interrupted (Claude Code sends no Stop hook for one). */
export function interruptLine(stop: { sessionId: string; agentId: string; ts: number }): SpoolLine {
  return {
    ts: new Date(stop.ts).toISOString(),
    event: "Interrupted",
    session_id: stop.sessionId,
    ...(stop.agentId === "main" ? {} : { agent_id: stop.agentId }),
  };
}

const stringOr = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A route line that came back 429/5xx as a retryable failure; anything else is null. */
export function routeFailure(line: SpoolLine, ts: number): ApiErrorRecord | null {
  const status = Number(line.status);
  if (!(status === 429 || (status >= 500 && status <= 599))) return null;
  const model = stringOr(line.model);
  return {
    ts,
    sessionId: stringOr(line.session_id),
    agentId: stringOr(line.agent_id),
    status,
    source: "route",
    plugin: stringOr(line.plugin) ?? (model === null ? null : pluginOf(model)),
  };
}

/** A router's route line as a request record (provider "route": never priced, the transcript has it). */
function routeRequest(
  line: SpoolLine,
  sessionId: string,
  model: string,
  ts: number,
  tokens: RequestRecord["tokens"],
): RequestRecord {
  return {
    id: `route:${sessionId}:${ts}:${line.status ?? ""}`,
    sessionId,
    agentId: "main",
    model,
    upstream: typeof line.upstream === "string" ? line.upstream : DEFAULT_UPSTREAM,
    ts,
    latencyMs: typeof line.latency_ms === "number" ? line.latency_ms : null,
    tokens,
    stopReason: typeof line.status === "string" ? line.status : null,
    provider: "route",
  };
}

export function startWatcher(options: WatcherOptions): Watcher {
  const { env, store } = options;
  const intervalMs = options.intervalMs ?? 1000;
  const rescanMs = options.rescanMs ?? 5000;
  const now = options.now ?? Date.now;

  const spoolTails = new Map<string, TailState>();
  const transcriptTails = new Map<string, FileTail>();
  const zaiTails = new Map<string, FileTail>();
  const sessionUpstreams = new Map<string, string>();
  const referencedTranscripts = new Set<string>();
  let lastRescan = 0;

  function applyEmit(emit: TranscriptEmit): void {
    if (emit.session !== null) applySessionMeta(emit.session);
    for (const agent of emit.agents) {
      store.upsertAgent({
        sessionId: agent.sessionId,
        id: agent.id,
        parentId: agent.parentId,
        kind: agent.kind,
        name: agent.name,
      });
    }
    for (const call of emit.toolCalls) store.addToolCall(call);
    applyFailures(emit);
    for (const request of emit.requests) store.addRequest(enrichUpstream(request));
  }

  /** API errors and user interruptions: the alert engine's view of a turn going wrong or ending early. */
  function applyFailures(emit: TranscriptEmit): void {
    for (const failure of emit.apiErrors) store.addApiError(failure);
    for (const stop of emit.interrupts) store.addSpoolLine(interruptLine(stop));
  }

  function applySessionMeta(meta: SessionMeta): void {
    const input: Parameters<Store["upsertSession"]>[0] = { id: meta.id };
    if (meta.cwd !== undefined) input.cwd = meta.cwd;
    if (meta.ccVersion !== undefined) input.ccVersion = meta.ccVersion;
    store.upsertSession(input);
  }

  /** Transcript lines have no upstream; the spool's SessionStart taught us this session's base URL. */
  function enrichUpstream(request: RequestRecord): RequestRecord {
    const known = sessionUpstreams.get(request.sessionId);
    return known === undefined ? request : { ...request, upstream: known };
  }

  function feedTail(fileTail: FileTail): void {
    const result = tailFile(fileTail.tail);
    for (const line of result.lines) {
      const emit = feedTranscriptLine(fileTail.parser, fileTail.identity, line);
      applyEmit(emit);
    }
  }

  function pollSpool(): void {
    for (const path of listSpoolFiles(env, new Date(now()))) {
      let tail = spoolTails.get(path);
      if (tail === undefined) {
        tail = openTail(path);
        spoolTails.set(path, tail);
      }
      const result = tailFile(tail);
      for (const line of result.lines) {
        const parsed = parseSpoolLine(line);
        if (parsed !== null) ingestSpoolLine(parsed);
      }
    }
  }

  function ingestSpoolLine(line: SpoolLine): void {
    if (typeof line.session_id === "string" && typeof line.base_url === "string") {
      sessionUpstreams.set(line.session_id, line.base_url);
    }
    if (typeof line.transcript_path === "string" && line.transcript_path !== "") {
      referencedTranscripts.add(line.transcript_path);
    }
    if (line.event === "route") {
      ingestRouteEvent(line);
      return;
    }
    if (isRouterEventLine(line)) {
      ingestRouterEvent(line);
      return;
    }
    store.addSpoolLine(line);
  }

  function routeTokens(line: SpoolLine): RequestRecord["tokens"] {
    const usage = line.usage ?? {};
    return {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    };
  }

  /** A router health line: kept for the router view; a rate limit also feeds the retry-storm alert. */
  function ingestRouterEvent(line: SpoolLine): void {
    const event = parseRouterEvent(line);
    if (event === null) return;
    store.addRouterEvent(event);
    if (event.event === "rate_limited") {
      store.addApiError({
        ts: event.ts,
        sessionId: null,
        agentId: null,
        status: 429,
        source: "router",
        plugin: event.plugin,
      });
    }
  }

  function ingestRouteEvent(line: SpoolLine): void {
    const ts = Date.parse(line.ts);
    if (!Number.isFinite(ts)) return;
    const failure = routeFailure(line, ts);
    if (failure !== null) store.addApiError(failure);
    if (typeof line.session_id !== "string" || typeof line.model !== "string") return;
    store.addRequest(routeRequest(line, line.session_id, line.model, ts, routeTokens(line)));
  }

  /** Every *.jsonl under the projects dir modified since the window, plus spool-referenced paths. */
  function discoverTranscripts(): string[] {
    const root = join(claudeConfigDir(env), "projects");
    const found: string[] = [];
    discover(root, 0, found);
    return [...referencedTranscripts, ...found];
  }

  function discover(dir: string, depth: number, found: string[]): void {
    if (depth > 6) return;
    const entries = listDir(dir);
    if (entries === null) return;
    for (const entry of entries) visitEntry(entry, dir, depth, found);
  }

  function visitEntry(entry: Dirent, dir: string, depth: number, found: string[]): void {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      discover(path, depth + 1, found);
      return;
    }
    if (entry.name.endsWith(".jsonl") && freshEnough(path)) found.push(path);
  }

  function listDir(dir: string): Dirent[] | null {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
  }

  function freshEnough(path: string): boolean {
    try {
      return statSync(path).mtimeMs >= sinceCutoff();
    } catch {
      return false;
    }
  }

  const sinceCutoff = (): number => now() - options.sinceMs;

  function pollTranscripts(shouldRescan: boolean): void {
    if (shouldRescan) {
      for (const path of discoverTranscripts()) {
        if (transcriptTails.has(path)) continue;
        const identity = identifyFile(path);
        transcriptTails.set(path, { path, tail: openTail(path), parser: newTranscriptState(), identity });
      }
    }
    for (const fileTail of transcriptTails.values()) feedTail(fileTail);
  }

  function pollZai(shouldRescan: boolean): void {
    if (!shouldRescan) return;
    const jobs = readZaiJobs(env);
    for (const job of jobs) applyZaiJob(job);
    for (const fileTail of zaiTails.values()) feedTail(fileTail);
    // retire terminal jobs after feeding: a transcript sighting would otherwise re-live them
    for (const job of jobs) {
      if (!job.live && job.updatedAt !== null) store.endAgent(job.sessionId, job.id, job.updatedAt);
    }
  }

  function applyZaiJob(job: ZaiJob): void {
    store.upsertSession({ id: job.sessionId, external: true });
    store.upsertAgent({
      sessionId: job.sessionId,
      id: job.id,
      kind: "external",
      name: job.id,
      model: job.model,
      title: job.title,
    });
    for (const file of job.attemptFiles) {
      if (zaiTails.has(file)) continue;
      zaiTails.set(file, {
        path: file,
        tail: openTail(file),
        parser: newTranscriptState(),
        identity: { sessionId: job.sessionId, agentId: job.id, kind: "external" },
      });
    }
  }

  function pollOnce(): void {
    const shouldRescan = lastRescan === 0 || now() - lastRescan >= rescanMs;
    if (shouldRescan) lastRescan = now();
    pollSpool();
    pollTranscripts(shouldRescan);
    pollZai(shouldRescan);
  }

  pollOnce();
  const timer = setInterval(() => {
    try {
      pollOnce();
    } catch {
      // one bad tick must not kill the watcher; the next tick retries every file
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    pollOnce,
    stop() {
      clearInterval(timer);
    },
  };
}
