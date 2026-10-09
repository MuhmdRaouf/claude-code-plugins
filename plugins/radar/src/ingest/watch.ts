/**
 * The ingest loop: every tick it tails the spool (hook lines), the transcripts referenced there plus anything
 * recent under the projects dir, the provider plugins' job attempts and their real transcripts, feeding the
 * store. New files are picked up on a slower rescan cadence. A pass runs in ~20 ms slices and yields in
 * between, so a large first catch-up cannot block the event loop — health keeps answering mid-scan. All
 * failures are contained per file — one unreadable transcript must never stop the rest.
 */
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pluginOf } from "../cost/prices.ts";
import { isRouterEventLine, parseRouterEvent } from "../router/health.ts";
import {
  type ApiErrorRecord,
  NOTICE_EVENT,
  OUTSIDE_SESSION,
  type RegistrySession,
  type RequestRecord,
  type SpoolLine,
} from "../shared/model.ts";
import { claudeConfigDir } from "../shared/paths.ts";
import { DEFAULT_UPSTREAM, pluginLabel, providerOf } from "../shared/provider.ts";
import type { Store } from "../store/store.ts";
import {
  attemptTranscript,
  type JobAttempt,
  type JobPlugin,
  jobClaudeHome,
  listSubagents,
  type PluginJob,
  readJobs,
} from "./jobs.ts";
import { type PidAlive, pidAlive, REGISTRY_RESCAN_MS, readRegistry } from "./registry.ts";
import { listSpoolFiles, parseSpoolLine } from "./spool.ts";
import { openTail, type TailState, tailFile } from "./tailer.ts";
import {
  type AgentDescriptor,
  billingOf,
  type ContentCapture,
  type FileIdentity,
  feedTranscriptLine,
  identifyFile,
  type Notice,
  newTranscriptState,
  type SessionMeta,
  type TranscriptEmit,
  type TranscriptState,
  usageOf,
} from "./transcript.ts";

type FileTail = { tail: TailState; parser: TranscriptState; identity: FileIdentity; path: string };

/** One projects-tree entry as the catch-up walk weighs it: a transcript worth reading, a directory to
 *  enter (both carrying their modified time for the newest-first order), or nothing worth the pass. */
type ScannedEntry =
  | { kind: "file"; path: string; mtimeMs: number }
  | { kind: "dir"; path: string; mtimeMs: number }
  | { kind: "skip" };

/** How long one slice of catch-up may run before the pass yields: the event loop must get a turn
 *  every few dozen milliseconds, so health and the stream keep answering mid-scan. */
const SLICE_MS = 20;

/** Session meta keys that copy straight onto a session upsert; every one is an optional string. */
const META_KEYS = ["cwd", "ccVersion", "customTitle", "agentName", "aiTitle", "slug", "branch"] as const;
type MetaKey = (typeof META_KEYS)[number];

export type WatcherOptions = {
  env: NodeJS.ProcessEnv;
  store: Store;
  sinceMs: number;
  intervalMs?: number;
  rescanMs?: number;
  now?: () => number;
  /** Who counts as a living pid in Claude Code's session registry; tests fake it. */
  alive?: PidAlive;
};

export type Watcher = {
  stop(): void;
  pollOnce(): void;
  /** How many transcript files the watcher still tails: eviction keeps this at the live few, not
   *  every transcript ever seen. */
  tracked(): number;
  /** True while a pass is running or queued: the server's first ingest is still draining its backlog,
   *  so a dashboard that reconnects mid-way knows its lists are still filling in. */
  catchingUp(): boolean;
};

/** The timeline line for a turn the user interrupted (Claude Code sends no Stop hook for one). */
export function interruptLine(stop: { sessionId: string; agentId: string; ts: number }): SpoolLine {
  return {
    ts: new Date(stop.ts).toISOString(),
    event: "Interrupted",
    session_id: stop.sessionId,
    ...(stop.agentId === "main" ? {} : { agent_id: stop.agentId }),
  };
}

/** The timeline line for an error notice Claude Code wrote itself; the store counts it as an agent error. */
export function noticeLine(notice: Notice): SpoolLine {
  return {
    ts: new Date(notice.ts).toISOString(),
    event: NOTICE_EVENT,
    session_id: notice.sessionId,
    message: `Claude Code notice: ${notice.what}`,
    ...(notice.agentId === "main" ? {} : { agent_id: notice.agentId }),
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

/** A failed status as the request's stop reason; a success leaves the stop reason to the transcript. */
function routeStatus(status: unknown): string | null {
  if (status === undefined || status === null) return null;
  const code = Number(status);
  return Number.isFinite(code) && code >= 200 && code < 300 ? null : String(status);
}

/** The provider a routed model belongs to; a model id the table does not know takes its plugin's name. */
function routedProvider(model: string, plugin: unknown): string {
  const known = providerOf(model);
  return known === "other" && typeof plugin === "string" ? pluginLabel(plugin) : known;
}

/**
 * A router's route line as a request record. The store pairs it with the transcript's copy of the same call
 * when there is one; an untagged line (agentId "") takes the agent of that copy, else counts under the main
 * agent, and a line with no session counts outside any session.
 */
/** The router that wrote a route line: its plugin, or just "router" when the line does not say. */
function routerOf(line: SpoolLine): string {
  return typeof line.plugin === "string" && line.plugin !== "" ? line.plugin : "router";
}

/** The response headers a route line may carry, case-insensitively. The router already keeps only these;
 *  the spool is data, so the allow-list is enforced again here, whatever wrote the line. */
const CAPTURED_HEADER =
  /^(request-id|x-request-id|retry-after|content-type|anthropic-ratelimit-.+|x-ratelimit-.+)$/i;

/** The allow-listed response headers a route line carries, when it says a plain string map. */
function headersOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, held] of Object.entries(value)) {
    if (CAPTURED_HEADER.test(name) && typeof held === "string") out[name] = held;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The optional fields a route line may carry, each on the record only when the line said (an empty
 *  string counts as saying nothing). */
function routeExtras(line: SpoolLine): Partial<RequestRecord> {
  const one = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;
  const error = one(line.error);
  const parent = one(line.parent_agent_id);
  const hash = one(line.prompt_hash);
  const headers = headersOf(line.headers);
  return {
    ...(error === undefined ? {} : { error }),
    ...(parent === undefined ? {} : { parentAgentId: parent }),
    ...(hash === undefined ? {} : { promptHash: hash }),
    ...(headers === undefined ? {} : { headers }),
  };
}

export function routeRequest(line: SpoolLine, model: string, ts: number): RequestRecord {
  const sessionId = typeof line.session_id === "string" ? line.session_id : OUTSIDE_SESSION;
  const agentId = typeof line.agent_id === "string" ? line.agent_id : "";
  const usage = line.usage ?? {};
  return {
    // the agent and model sit in the id so parallel subagent calls that finish in the same millisecond
    // stay the separate records they were
    id: `route:${sessionId}:${agentId}:${model}:${ts}:${line.status ?? ""}`,
    sessionId,
    agentId,
    ...routeExtras(line),
    model,
    upstream: typeof line.upstream === "string" ? line.upstream : DEFAULT_UPSTREAM,
    ts,
    latencyMs: typeof line.latency_ms === "number" ? line.latency_ms : null,
    // the same reading the transcript path gives its usage block: the counters, the thinking share of
    // the output and the billing conditions, all of which the router copied verbatim off the stream
    tokens: usageOf({ usage }),
    ...billingOf({ usage }),
    stopReason: routeStatus(line.status),
    provider: routedProvider(model, line.plugin),
    route: typeof line.route === "string" ? line.route : "router",
    via: routerOf(line),
  };
}

/** host:port of a base URL on this machine (a provider plugin's router), else null. */
export function loopbackHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ? parsed.host : null;
  } catch {
    return null;
  }
}

const stringField = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
};

/**
 * The project dir name Claude Code keeps a cwd's transcripts under: every separator and punctuation
 * character becomes a dash (`/w/app` → `-w-app`, `.agents` → `-agents`).
 */
export function projectDirOf(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/gu, "-");
}

/** Is there a regular file at this path? One unreadable stat reads as no. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** What a subagents meta file says (agentType, description), or null when it says nothing usable. */
function readAgentMeta(path: string): { agentType: string; description: string } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const agentType = stringField(record, "agentType");
    return agentType === null ? null : { agentType, description: stringField(record, "description") ?? "" };
  } catch {
    return null;
  }
}

export function startWatcher(options: WatcherOptions): Watcher {
  const { env, store } = options;
  const intervalMs = options.intervalMs ?? 1000;
  const rescanMs = options.rescanMs ?? REGISTRY_RESCAN_MS;
  const now = options.now ?? Date.now;

  const spoolTails = new Map<string, TailState>();
  const transcriptTails = new Map<string, FileTail>();
  const jobTails = new Map<string, FileTail>();
  /** Per session, every base URL its hooks reported, oldest first: a session can start direct and be
   *  routed later (or the reverse), so a request takes the URL in effect when it was made. */
  const sessionUpstreams = new Map<string, { ts: number; url: string }[]>();
  /** Per provider plugin, the base URL its router sent that plugin's models to, learned from route lines:
   *  a job's own calls name no upstream, so its plugin's is all radar can tell about where they went. */
  const routerUpstreams = new Map<string, string>();
  /** subagents/agent-<id>.meta.json per transcript, read once: agent type and task for the agent view. */
  const agentMetas = new Map<string, { agentType: string; description: string } | null>();
  const referencedTranscripts = new Set<string>();
  /** The transcript files of the sessions this rescan's registry named (their subagents included):
   *  a live session may sit quiet past the since window, and its tail must survive eviction. */
  const livePaths = new Set<string>();
  /** The transcript file of each registry session that has one: one lookup each, not one per rescan. */
  const registryTranscripts = new Map<string, string>();
  let lastRescan = 0;

  function applyEmit(emit: TranscriptEmit): void {
    if (emit.session !== null) applySessionMeta(emit.session);
    for (const agent of emit.agents) upsertDescriptor(agent);
    for (const call of emit.toolCalls) store.addToolCall(call);
    applyFailures(emit);
    const captured = new Map(emit.content.map((c) => [c.requestId, c] as const));
    for (const request of emit.requests) {
      store.addRequest(defaultUpstream(enrichUpstream(request)), ...contentOf(captured, request.id));
    }
  }

  /** One transcript-sighted agent into the store; its prompt title rides only when the parser saw one. */
  function upsertDescriptor(agent: AgentDescriptor): void {
    store.upsertAgent({
      sessionId: agent.sessionId,
      id: agent.id,
      parentId: agent.parentId,
      kind: agent.kind,
      name: agent.name,
      agentType: agent.agentType,
      description: agent.description,
      ...(agent.title === undefined ? {} : { title: agent.title }),
    });
  }

  /** A request's captured input and output, as addRequest's optional tail (empty when none was kept). */
  function contentOf(
    captured: Map<string, ContentCapture>,
    requestId: string,
  ): { input: string | null; output: string | null }[] {
    const content = captured.get(requestId);
    return content === undefined ? [] : [{ input: content.input, output: content.output }];
  }

  /** API errors and user interruptions: the alert engine's view of a turn going wrong or ending early. */
  function applyFailures(emit: TranscriptEmit): void {
    for (const failure of emit.apiErrors) store.addApiError(failure);
    for (const stop of emit.interrupts) store.addSpoolLine(interruptLine(stop));
    for (const notice of emit.notices) store.addSpoolLine(noticeLine(notice));
  }

  function applySessionMeta(meta: SessionMeta): void {
    const input: Parameters<Store["upsertSession"]>[0] = { id: meta.id };
    for (const key of META_KEYS) {
      const value = meta[key];
      if (value !== undefined) (input as Record<MetaKey, string>)[key] = value;
    }
    store.upsertSession(input);
  }

  /** Transcript lines have no upstream; the session's hooks taught us its base URL. A request takes the
   *  last one reported at or before it; one older than every report keeps the empty upstream. */
  function enrichUpstream(request: RequestRecord): RequestRecord {
    let known: string | undefined;
    for (const entry of sessionUpstreams.get(request.sessionId) ?? []) {
      if (entry.ts > request.ts) break;
      known = entry.url;
    }
    if (known === undefined) return request;
    // a local router is not where the call went: name it as the way, and let the router's own line say where
    const router = loopbackHost(known);
    return router === null ? { ...request, upstream: known } : { ...request, via: router };
  }

  /** A claude-* call enrichment left with no upstream went to Anthropic: Claude Code called the API itself, or a
   *  local router passed it straight through (`via` says which). A provider model keeps the empty upstream until
   *  the router's route line names where it actually went, and a zai job keeps its recorded upstream. */
  function defaultUpstream(request: RequestRecord): RequestRecord {
    if (request.upstream !== "" || !request.model.startsWith("claude-")) return request;
    return { ...request, upstream: DEFAULT_UPSTREAM };
  }

  function feedLine(fileTail: FileTail, line: string): void {
    applyEmit(feedTranscriptLine(fileTail.parser, fileTail.identity, line));
  }

  /** Every new line of one tail, in order, pausing between lines so the pass can yield. */
  function* tailLines(tail: TailState, feed: (line: string) => void): Generator<void> {
    for (const line of tailFile(tail).lines) {
      feed(line);
      yield;
    }
  }

  function rememberUpstream(sessionId: string, ts: number, url: string): void {
    const entries = sessionUpstreams.get(sessionId) ?? [];
    const last = entries.at(-1);
    if (last !== undefined && last.url === url && last.ts <= ts) return; // the same URL again: nothing new
    entries.push({ ts, url });
    entries.sort((a, b) => a.ts - b.ts);
    sessionUpstreams.set(sessionId, entries);
  }

  function ingestSpoolLine(line: SpoolLine): void {
    if (typeof line.session_id === "string" && typeof line.base_url === "string") {
      rememberUpstream(line.session_id, Date.parse(line.ts), line.base_url);
    }
    if (typeof line.transcript_path === "string" && line.transcript_path !== "") {
      referencedTranscripts.add(line.transcript_path);
    }
    if (line.event === "route") {
      ingestRouteEvent(line);
      return;
    }
    if (line.event === "capture") {
      ingestCaptureEvent(line);
      return;
    }
    if (isRouterEventLine(line)) {
      ingestRouterEvent(line);
      return;
    }
    store.addSpoolLine(line);
  }

  /** A capture line: the gzipped prompt a route line points at, stored once per hash by the history. */
  function ingestCaptureEvent(line: SpoolLine): void {
    const ts = Date.parse(line.ts);
    const hash = line.prompt_hash;
    if (!Number.isFinite(ts) || typeof hash !== "string" || hash === "" || typeof line.gz !== "string") {
      return;
    }
    store.addCapture({ hash, gz: line.gz, firstTs: ts });
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

  /** A route line that sent one of the plugin's own models somewhere names that plugin's real base URL. */
  function rememberRouterUpstream(line: SpoolLine, model: string): void {
    const plugin = typeof line.plugin === "string" ? line.plugin : "";
    const upstream = typeof line.upstream === "string" ? line.upstream : "";
    if (plugin === "" || upstream === "" || pluginOf(model) !== plugin) return;
    routerUpstreams.set(plugin, upstream);
  }

  function ingestRouteEvent(line: SpoolLine): void {
    const ts = Date.parse(line.ts);
    if (!Number.isFinite(ts)) return;
    const failure = routeFailure(line, ts);
    if (failure !== null) store.addApiError(failure);
    if (typeof line.model !== "string") return;
    rememberRouterUpstream(line, line.model);
    store.addRequest(routeRequest(line, line.model, ts));
  }

  /** Every *.jsonl under the projects dir modified since the window, plus spool-referenced paths:
   *  referenced ones first, then the walked ones newest-modified first — one directory per resumption,
   *  so a big projects tree cannot hold the pass hostage either. */
  function* discoverTranscripts(): Generator<string> {
    yield* referencedTranscripts;
    yield* walk(join(claudeConfigDir(env), "projects"), 0);
  }

  /**
   * The fresh transcripts of one directory, newest-modified first, then its subdirectories newest-mtime
   * first: a cold start reads the live session and its subagents before days-old files, so the dashboard
   * is useful within seconds of starting, not after the whole backlog. The since window still filters.
   */
  function* walk(dir: string, depth: number): Generator<string> {
    if (depth > 6) return;
    const { files, dirs } = scanDir(dir);
    yield* files;
    for (const sub of dirs) yield* walk(sub.path, depth + 1);
  }

  /** One directory's fresh transcript paths and subdirectories, each sorted newest-mtime first. */
  function scanDir(dir: string): { files: string[]; dirs: { path: string; mtimeMs: number }[] } {
    const files: { path: string; mtimeMs: number }[] = [];
    const dirs: { path: string; mtimeMs: number }[] = [];
    for (const entry of listDir(dir) ?? []) {
      const scanned = scanEntry(entry, dir);
      if (scanned.kind === "skip") continue;
      const bucket = scanned.kind === "file" ? files : dirs;
      bucket.push({ path: scanned.path, mtimeMs: scanned.mtimeMs });
    }
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { files: files.map((file) => file.path), dirs };
  }

  /** What one projects-tree entry contributes to the walk: a fresh transcript, a subdirectory, nothing. */
  function scanEntry(entry: Dirent, dir: string): ScannedEntry {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const mtimeMs = mtimeOf(path);
      return mtimeMs === null ? { kind: "skip" } : { kind: "dir", path, mtimeMs };
    }
    if (!entry.name.endsWith(".jsonl")) return { kind: "skip" };
    const mtimeMs = mtimeOf(path);
    if (mtimeMs === null || mtimeMs < sinceCutoff()) return { kind: "skip" };
    return { kind: "file", path, mtimeMs };
  }

  function listDir(dir: string): Dirent[] | null {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
  }

  /** A path's modified time, or null when it cannot be stat-ed (then it is not worth reading). */
  function mtimeOf(path: string): number | null {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  }

  const sinceCutoff = (): number => now() - options.sinceMs;

  /** A session transcript's tail, with its subagent's meta file beside it when there is one. */
  function transcriptTail(path: string): FileTail {
    const identity = identifyFile(path);
    const meta = identity.kind === "subagent" ? agentMetaFor(path) : null;
    return {
      path,
      tail: openTail(path),
      parser: newTranscriptState(),
      ...(meta === null ? { identity } : { identity: { ...identity, agentMeta: meta } }),
    };
  }

  /** One full pass over every source, as resumable work: sources in tick order, lines one by one. The
   *  registry runs before the transcripts, so a session it brings in has its transcript read this pass. */
  function* passWork(): Generator<void> {
    const shouldRescan = lastRescan === 0 || now() - lastRescan >= rescanMs;
    if (shouldRescan) lastRescan = now();
    yield* spoolPhase();
    yield* registryPhase(shouldRescan);
    yield* transcriptPhase(shouldRescan);
    if (shouldRescan) yield* jobsPhase();
  }

  /** Claude Code's own registry, on the rescan cadence: which sessions are live and how they are —
   *  and, for a session ingest has not discovered yet, its transcript however old it is. */
  function* registryPhase(shouldRescan: boolean): Generator<void> {
    if (!shouldRescan) return;
    livePaths.clear();
    const entries = readRegistry(env, options.alive ?? pidAlive);
    store.applyRegistry(entries, now());
    for (const entry of entries) yield* registryTailsOf(entry);
  }

  /** One registry session's transcripts into the tails, each newly found file its own yield. The
   *  subagents are re-listed on every rescan — a subagent the session spawns after we first saw it must
   *  be picked up however old the since window says it is — and a file new to us opens at its stored
   *  offset (the start, within the tail cap), never begun at end-of-file. */
  function* registryTailsOf(entry: RegistrySession): Generator<void> {
    const file = registryTranscriptOf(entry);
    if (file === null) return;
    registryTranscripts.set(entry.sessionId, file);
    const subagents = listSubagents(join(dirname(file), entry.sessionId, "subagents"));
    for (const path of [file, ...subagents]) {
      livePaths.add(path);
      if (transcriptTails.has(path)) continue;
      transcriptTails.set(path, transcriptTail(path));
      yield;
    }
  }

  /**
   * A live registry session's transcript under the projects dir, since window aside — the registry's
   * word is that this session is open. Its cwd names the slug dir Claude Code keeps transcripts in;
   * a cwd the slug scheme does not fit falls back to searching the project dirs for the file name.
   */
  function registryTranscriptOf(entry: RegistrySession): string | null {
    const known = registryTranscripts.get(entry.sessionId);
    if (known !== undefined) return known;
    const projects = join(claudeConfigDir(env), "projects");
    if (entry.cwd !== null) {
      const direct = join(projects, projectDirOf(entry.cwd), `${entry.sessionId}.jsonl`);
      if (isFile(direct)) return direct;
    }
    return attemptTranscript(projects, entry.sessionId)?.file ?? null;
  }

  function* spoolPhase(): Generator<void> {
    for (const path of listSpoolFiles(env, new Date(now()))) {
      yield* tailLines(spoolTailOf(path), ingestSpoolText);
    }
  }

  /** One spool file's tail, opened on first sight. */
  function spoolTailOf(path: string): TailState {
    let tail = spoolTails.get(path);
    if (tail === undefined) {
      tail = openTail(path);
      spoolTails.set(path, tail);
    }
    return tail;
  }

  function ingestSpoolText(text: string): void {
    const parsed = parseSpoolLine(text);
    if (parsed !== null) ingestSpoolLine(parsed);
  }

  /** The rescan's new transcript files into the tails, each its own yield. */
  function* discoverTails(): Generator<void> {
    for (const path of discoverTranscripts()) {
      if (!transcriptTails.has(path)) transcriptTails.set(path, transcriptTail(path));
      yield;
    }
  }

  function* transcriptPhase(shouldRescan: boolean): Generator<void> {
    if (shouldRescan) yield* discoverTails();
    for (const fileTail of [...transcriptTails.values()]) {
      yield* tailLines(fileTail.tail, (line) => feedLine(fileTail, line));
    }
    // the quiet tails go after the reads: a file this rescan brought in is read once before its
    // quietness drops it (a spool-referenced transcript outside the since window, say)
    if (shouldRescan) yield* evictQuietTails();
  }

  /**
   * Drop the tails nothing is waiting on: a file the registry no longer names and whose last change is
   * past the since window can only sit quiet — yet every tick would stat it, and a long radar would
   * stat every transcript it ever saw, forever. Dropped with its referenced-transcript entry, so the
   * rescan cannot re-open it from byte 0; a fresh change or a fresh spool line re-discovers it as any
   * new file.
   */
  function* evictQuietTails(): Generator<void> {
    for (const [path] of [...transcriptTails]) {
      if (livePaths.has(path)) continue;
      if ((mtimeOf(path) ?? -1) >= sinceCutoff()) continue;
      transcriptTails.delete(path);
      referencedTranscripts.delete(path);
      yield;
    }
  }

  /** The upstream a provider's jobs went to: zai's is known outright, the rest only what a router taught. */
  const jobUpstream = (plugin: JobPlugin): string => routerUpstreams.get(plugin) ?? "";

  function* jobsPhase(): Generator<void> {
    const jobs = readJobs(env, jobUpstream);
    for (const job of jobs) {
      applyJob(job);
      yield;
    }
    for (const fileTail of [...jobTails.values()]) {
      yield* tailLines(fileTail.tail, (line) => feedLine(fileTail, line));
    }
    // retire terminal jobs after feeding: a transcript sighting re-lives both the job's session and
    // its agent, so the pass must have the last word — and it ends the session, not just the agent
    for (const job of jobs) {
      if (!job.live && job.updatedAt !== null) store.endSession(job.sessionId, job.updatedAt);
    }
  }

  function applyJob(job: PluginJob): void {
    store.upsertSession({
      id: job.sessionId,
      external: true,
      ...(job.title !== null ? { customTitle: job.title } : {}),
      ...(job.branch !== null ? { branch: job.branch } : {}),
      ...(job.repoRoot !== null ? { repo: job.repoRoot } : {}),
      ...(job.parentSessionId !== null ? { parentSessionId: job.parentSessionId } : {}),
    });
    store.upsertAgent({
      sessionId: job.sessionId,
      id: job.id,
      kind: "external",
      name: job.id,
      model: job.model,
      title: job.title,
    });
    for (const attempt of job.attempts) applyAttempt(job, attempt);
  }

  function applyAttempt(job: PluginJob, attempt: JobAttempt): void {
    const found =
      attempt.sessionId === null
        ? null
        : attemptTranscript(jobClaudeHome(env, job.plugin), attempt.sessionId);
    if (found === null) {
      // an older job with no transcript: its stream file is all there is
      tailJobFile(attempt.file, {
        sessionId: job.sessionId,
        agentId: job.id,
        kind: "external",
        upstream: job.upstream,
      });
      return;
    }
    // the transcript carries the same calls with real usage: the stream file would count them twice
    jobTails.delete(attempt.file);
    tailJobFile(found.file, {
      sessionId: job.sessionId,
      agentId: job.id,
      kind: "external",
      upstream: job.upstream,
      remap: { sessionId: job.sessionId, agentId: job.id },
    });
    for (const file of found.subagents) {
      const meta = agentMetaFor(file);
      tailJobFile(file, {
        sessionId: job.sessionId,
        agentId: basename(file, ".jsonl"),
        kind: "subagent",
        upstream: job.upstream,
        remap: { sessionId: job.sessionId, agentId: job.id, parentId: job.id },
        ...(meta === null ? {} : { agentMeta: meta }),
      });
    }
  }

  function tailJobFile(file: string, identity: FileIdentity): void {
    if (jobTails.has(file)) return;
    jobTails.set(file, { path: file, tail: openTail(file), parser: newTranscriptState(), identity });
  }

  /** agent-<id>.meta.json beside a subagent transcript, read once; null when it is absent or unusable. */
  function agentMetaFor(transcript: string): { agentType: string; description: string } | null {
    const key = `${transcript.slice(0, -".jsonl".length)}.meta.json`;
    let meta = agentMetas.get(key);
    if (meta === undefined) {
      meta = readAgentMeta(key);
      agentMetas.set(key, meta);
    }
    return meta;
  }

  /** The pass in progress, or null while the watcher is idle: a pass resumes where it yielded. */
  let pass: Generator<void, void, void> | null = null;
  /** A poll asked for while another pass runs; it starts when that one ends, never during it. */
  let queuedPoll = false;
  let stopped = false;

  /** Runs the pass until the slice budget is out; false while work remains for another slice. */
  function runSlice(): boolean {
    const start = Date.now();
    while (Date.now() - start < SLICE_MS) {
      let done = false;
      try {
        done = pass?.next().done === true;
      } catch (e) {
        pass = null;
        throw e; // the synchronous caller sees it, as a bad tick did; the continuation contains it
      }
      if (done) {
        pass = null;
        return true;
      }
    }
    return false;
  }

  /** The pass to continue: the running one, a fresh one when a poll is queued, else null when idle. */
  function nextPass(): Generator<void, void, void> | null {
    if (pass !== null) return pass;
    if (!queuedPoll) return null;
    queuedPoll = false;
    return passWork();
  }

  /** Drains the queued passes, one ~20 ms slice at a time; the rest waits on setImmediate. */
  function pump(): void {
    if (stopped) {
      pass = null;
      return;
    }
    for (;;) {
      const current = nextPass();
      if (current === null) return;
      pass = current;
      if (runSlice()) continue;
      yieldToLoop();
      return;
    }
  }

  /** Hand the event loop a turn before the next slice; a bad slice there kills the pass, not the watcher. */
  function yieldToLoop(): void {
    setImmediate(() => {
      try {
        pump();
      } catch {
        // the next tick retries every file
      }
    });
  }

  function pollOnce(): void {
    if (stopped) return;
    queuedPoll = true;
    pump();
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
    /** How many transcript files the watcher still tails: eviction keeps this at the live few, not
     *  every transcript ever seen. */
    tracked: (): number => transcriptTails.size,
    catchingUp: (): boolean => pass !== null || queuedPoll,
    stop() {
      stopped = true;
      clearInterval(timer);
      pass = null;
    },
  };
}
