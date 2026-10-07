import type { JobPaths } from "../domain/state-layout.ts";
import type { Deps } from "./deps.ts";

/** How often a driver looks for a `stop` request. */
const POLL_MS = 1_000;

export interface StopWatch {
  /** Aborts once a stop is requested: the job's stop file appeared, or the caller's signal aborted. */
  readonly signal: AbortSignal;
  close(): void;
}

export function watchStop(deps: Deps, paths: JobPaths, external?: AbortSignal): StopWatch {
  const stop = new AbortController();
  const closed = new AbortController();
  const onExternal = () => stop.abort(external?.reason);
  if (external?.aborted) onExternal();
  external?.addEventListener("abort", onExternal, { once: true });
  void (async () => {
    while (!stop.signal.aborted) {
      if (await deps.files.stopRequested(paths)) {
        stop.abort(new Error("stop requested"));
        return;
      }
      const slept = await deps.clock.sleep(POLL_MS, closed.signal).then(
        () => true,
        () => false,
      );
      if (!slept) return;
    }
  })();
  return {
    signal: stop.signal,
    close() {
      closed.abort();
      external?.removeEventListener("abort", onExternal);
    },
  };
}
