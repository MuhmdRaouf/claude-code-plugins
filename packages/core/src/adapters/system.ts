import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Clock, Ids, ProcessControl } from "../ports/index.ts";
import { isAlive, terminateGroup } from "./process/group.ts";
import { spawnOrphan } from "./process/orphan.ts";

export function createSystemClock(): Clock {
  return {
    now: () => Date.now(),
    iso: () => new Date().toISOString(),
    sleep: async (ms, signal) => {
      await delay(ms, undefined, signal === undefined ? {} : { signal });
    },
  };
}

/** Crockford base32, lowercase: no i/l/o/u, so ids survive being read aloud or retyped. */
const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

/** jobId: `yymmdd-` + 6 base32 chars (sortable, short, prefix-resolvable); sessionId: crypto.randomUUID(). */
export function createIds(): Ids {
  return {
    jobId: () => `${utcDay(new Date())}-${randomBase32(6)}`,
    sessionId: () => randomUUID(),
  };
}

function utcDay(date: Date): string {
  return date.toISOString().slice(2, 10).replaceAll("-", "");
}

function randomBase32(length: number): string {
  return Array.from({ length }, () => BASE32[randomInt(BASE32.length)]).join("");
}

/** spawnDriver runs `process.execPath <this bundle> drive <id>` as an orphaned group leader (see spawnOrphan) with stdio
 *  to <job>/driver.log: stop can signal the driver and its worker together, and no tree-kill of the caller reaches it. */
export function createProcessControl(bundlePath: string, logPath: (jobId: string) => string): ProcessControl {
  return {
    isAlive,
    terminateGroup,
    spawnDriver: (jobId) => spawnOrphan(process.execPath, [bundlePath, "drive", jobId], logPath(jobId)),
  };
}
