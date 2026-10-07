// `<state>/router.pid`: what the starter knows about the running router — its pid, port, the bundle version, the
// front protocol, whether it is the main router or the emergency passthrough, and the token its control endpoints
// require. Written 0600, atomically, only by the starter once the router answers health.
import { rmSync } from "node:fs";
import { z } from "zod";
import { readJsonFile, writeFileAtomicSync } from "../adapters/fs-files.ts";
import { stateLayout } from "../domain/state-layout.ts";

export interface PidRecord {
  readonly pid: number;
  readonly port: number;
  readonly startedAt: string;
  readonly node: string;
  readonly version: string;
  readonly frontVersion: number;
  readonly mode: "router" | "emergency";
  readonly token: string;
}

/** Only what every starter, old or new, relies on is checked: a record an older version wrote still counts. */
const PidShape = z.looseObject({ pid: z.number(), port: z.number(), token: z.string() });

export function writePidFile(stateRoot: string, record: PidRecord): void {
  writeFileAtomicSync(stateLayout(stateRoot).routerPid, `${JSON.stringify(record, null, 2)}\n`);
}

/** The record, or undefined when there is none or it does not parse. */
export function readPidFile(stateRoot: string): PidRecord | undefined {
  return readJsonFile(stateLayout(stateRoot).routerPid, PidShape) as PidRecord | undefined;
}

export function removePidFile(stateRoot: string): void {
  rmSync(stateLayout(stateRoot).routerPid, { force: true });
}
