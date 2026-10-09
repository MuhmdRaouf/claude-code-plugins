// The peer registry: every provider plugin's router announces itself here, so one plugin's
// router can forward another plugin's model ids to it and all five can be set up at once. One JSON file per plugin in
// a shared state dir, written atomically; nothing here ever holds a key.

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../adapters/fs-files.ts";
import { agentsStateDir, migrateStateDir } from "../adapters/state-migrate.ts";
import { parseJson } from "../domain/json.ts";
import { claims, type EnvLookup, type ModelClaim } from "../domain/provider.ts";

/** One plugin's announcement: where its router listens and which model ids it serves. */
export interface RegisteredRouter {
  readonly name: string;
  readonly port: number;
  readonly modelPrefixes: readonly string[];
  readonly catalogIds: readonly string[];
  readonly pid?: number;
  readonly updatedAt: string;
}

/** Where a peer router answers its health check: every plugin's is `/<name>-router/health`. */
function peerHealthPath(name: string): string {
  return `/${name}-router/health`;
}

/** The shared dir: $PROVIDER_ROUTERS_HOME, else ~/.agents/provider-routers (an old XDG one moves over). */
export function routersHome(env: EnvLookup, log: (line: string) => void = console.error): string {
  if (env.PROVIDER_ROUTERS_HOME !== undefined) return env.PROVIDER_ROUTERS_HOME;
  migrateStateDir("provider-routers", env, log);
  return agentsStateDir(env, "provider-routers");
}

function entryFile(env: EnvLookup, name: string): string {
  return join(routersHome(env), `${name}.json`);
}

/** Every valid entry, sorted by plugin name; unreadable files are skipped, not fatal. */
export function readRegistry(env: EnvLookup): readonly RegisteredRouter[] {
  let names: readonly string[];
  try {
    names = readdirSync(routersHome(env));
  } catch {
    return [];
  }
  return names
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      try {
        return [parseEntry(readFileSync(join(routersHome(env), file), "utf8"))];
      } catch {
        return [];
      }
    })
    .filter((entry): entry is RegisteredRouter => entry !== undefined)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** An entry any version wrote: extra keys are dropped, a missing or mistyped one discards the entry. */
const EntryShape = z.object({
  name: z.string(),
  port: z.number(),
  modelPrefixes: z.array(z.string()),
  catalogIds: z.array(z.string()),
  pid: z.number().optional(),
  updatedAt: z.string(),
});

function parseEntry(text: string): RegisteredRouter | undefined {
  const entry = parseJson(text, EntryShape);
  if (entry === undefined) return undefined;
  const { pid, ...rest } = entry;
  return pid === undefined ? rest : { ...rest, pid };
}

/** Writes one plugin's entry atomically, keeping the recorded pid when the new entry carries none (setup writes
 *  without one; the router itself writes with its own). */
export async function saveRegistryEntry(env: EnvLookup, entry: RegisteredRouter): Promise<void> {
  const previous = readRegistry(env).find((other) => other.name === entry.name);
  const full =
    entry.pid === undefined && previous?.pid !== undefined ? { ...entry, pid: previous.pid } : entry;
  await writeFileAtomic(entryFile(env, entry.name), `${JSON.stringify(full, null, 2)}\n`, { mkdir: true });
}

/** Takes one plugin's entry out; a missing entry is fine. */
export function removeRegistryEntry(env: EnvLookup, name: string): void {
  rmSync(entryFile(env, name), { force: true });
}

/** The model claim a peer announced: its resolved catalog ids and its prefixes (the file keeps its historical keys). */
export function entryClaim(entry: RegisteredRouter): ModelClaim {
  return { ids: entry.catalogIds, prefixes: entry.modelPrefixes };
}

/** Another plugin's router that serves the model, for the router to forward to. */
export interface PeerTarget {
  readonly name: string;
  readonly port: number;
}

/** Looks up which peer serves a model, re-reading the registry at most every 5 s so forwarding stays cheap. */
export function createPeerLookup(env: EnvLookup, self: string): (model: string) => PeerTarget | undefined {
  let entries: readonly RegisteredRouter[] = [];
  let readAt = -Infinity;
  return (model) => {
    if (Date.now() - readAt >= 5000) {
      entries = readRegistry(env).filter((entry) => entry.name !== self);
      readAt = Date.now();
    }
    const peer = entries.find((entry) => claims(entryClaim(entry), model));
    return peer === undefined ? undefined : { name: peer.name, port: peer.port };
  };
}

/** The entries whose router answers its health check right now (used to decide where a removed plugin's base URL
 *  goes, and never to forward: a dead peer fails its forward with a 502 that names `/setup`). */
export async function liveRouters(
  env: EnvLookup,
  exclude: string,
  alive: (entry: RegisteredRouter) => Promise<boolean> = healthCheck,
): Promise<readonly RegisteredRouter[]> {
  const others = readRegistry(env).filter((entry) => entry.name !== exclude);
  const living = await Promise.all(others.map((entry) => alive(entry)));
  return others.filter((_, i) => living[i] === true);
}

/** Live means the port answers that plugin's health path with its own name, not merely any 200. */
async function healthCheck(entry: RegisteredRouter): Promise<boolean> {
  try {
    const url = `http://127.0.0.1:${entry.port}${peerHealthPath(entry.name)}`;
    const answer = await fetch(url, { signal: AbortSignal.timeout(500) });
    const body: unknown = answer.ok ? JSON.parse(await answer.text()) : undefined;
    return (
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>).ok === true &&
      (body as Record<string, unknown>).name === entry.name
    );
  } catch {
    return false;
  }
}
