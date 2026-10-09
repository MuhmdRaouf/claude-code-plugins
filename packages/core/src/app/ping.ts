import { err, ok, type Result } from "../domain/result.ts";
import { finalizeWorker, type WorkerEvent, type WorkerResult } from "../domain/worker-events.ts";
import type { WorkerError } from "../ports/index.ts";
import type { Deps } from "./deps.ts";
import { builtinContract } from "./report-schema.ts";

const PING_TIMEOUT_MS = 120_000;
const PING_PROMPT =
  'This is a connectivity check. Use no tools. End at once with a notes report whose summary is "pong", with no findings and no open items.';

/** One tiny real request (the provider's ping tier, read-only, notes report) that proves the key and the route work. */
export async function ping(deps: Deps): Promise<Result<WorkerResult, WorkerError>> {
  const started = await deps.worker.start({
    cwd: deps.host.stateRoot,
    model: deps.provider.catalog[deps.provider.pingTier],
    access: "readonly",
    prompt: PING_PROMPT,
    session: { kind: "new", key: deps.ids.sessionId() },
    report: builtinContract("notes"),
    addDirs: [],
    passEnv: {},
    timeoutMs: PING_TIMEOUT_MS,
    logPath: `${deps.host.stateRoot}/setup-ping.jsonl`,
  });
  if (!started.ok) return err(started.error);
  const events: WorkerEvent[] = [];
  for await (const event of started.value.events) events.push(event);
  const exit = await started.value.exit;
  return ok(finalizeWorker(events, exit, exit.forced));
}
