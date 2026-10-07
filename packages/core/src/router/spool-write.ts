// The spool's writing half, from Node built-ins alone so the emergency passthrough can report too: where the
// observatory lives, the day's file, and the append that never lets a failing disk reach a client.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EnvLookup } from "../domain/provider.ts";
import type { SpoolEvent } from "../domain/route-events.ts";

/** The observatory's home: $OBSERVATORY_HOME, else ~/.local/state/observatory. */
export function observatoryHome(env: EnvLookup): string {
  return env.OBSERVATORY_HOME ?? join(env.HOME ?? homedir(), ".local", "state", "observatory");
}

/** The day's spool file, named for the local date (the day the events happened where the router runs). */
export function spoolFile(env: EnvLookup, now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return join(observatoryHome(env), "spool", `${now.getFullYear()}-${month}-${day}.jsonl`);
}

/** Appends events to the spool in one write each; a failing write costs one line on the router's stderr and nothing
 *  else — the client's answer never waits on the spool. */
export function createSpoolWriter(
  env: EnvLookup,
  warn: (line: string) => void = console.error,
  now: () => Date = () => new Date(),
): (event: SpoolEvent) => void {
  let ensured = false;
  const append = (event: SpoolEvent): void => {
    if (!ensured) {
      mkdirSync(join(observatoryHome(env), "spool"), { recursive: true, mode: 0o700 });
      ensured = true;
    }
    appendFileSync(spoolFile(env, now()), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  };
  return (event) => {
    try {
      append(event);
    } catch (error) {
      try {
        // The observatory removed its tree under a running router: make the directory again, once.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        ensured = false;
        append(event);
      } catch (again) {
        warn(`route spool: ${again instanceof Error ? again.message : String(again)}`);
      }
    }
  };
}
