/**
 * Port selection: a random 5-digit port, never a fixed default (server/app.ts tries the saved port first). A
 * pinned --port is tried once and failures surface immediately; a random pick retries on EADDRINUSE/EACCES with a
 * fresh draw, bounded so a hopeless machine fails with a message instead of spinning. The random source is
 * injectable for tests.
 */
import { randomInt } from "node:crypto";
import type { AddressInfo, ListenOptions, Server } from "node:net";

export type RandomSource = (min: number, max: number) => number;

export const nativeRandom: RandomSource = (min, max) => randomInt(min, max);

export const PORT_MIN = 10000;
export const PORT_MAX = 65536; // exclusive, matching randomInt
export const MAX_ATTEMPTS = 50;

const RETRYABLE = new Set(["EADDRINUSE", "EACCES"]);

export type ListenResult = { ok: true; server: Server; port: number } | { ok: false; error: Error };

function listenOnce(server: Server, options: ListenOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options);
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function listenPinned(server: Server, port: number): Promise<ListenResult> {
  try {
    await listenOnce(server, { host: "127.0.0.1", port });
    return { ok: true, server, port };
  } catch (error) {
    return { ok: false, error: asError(error) };
  }
}

async function listenRandom(
  server: Server,
  random: RandomSource,
  maxAttempts: number,
): Promise<ListenResult> {
  let lastError: Error = new Error("no attempts made");
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const port = random(PORT_MIN, PORT_MAX);
    try {
      await listenOnce(server, { host: "127.0.0.1", port });
      return { ok: true, server, port };
    } catch (error) {
      lastError = asError(error);
      const code = (lastError as NodeJS.ErrnoException).code;
      if (code === undefined || !RETRYABLE.has(code)) return { ok: false, error: lastError };
    }
  }
  return {
    ok: false,
    error: new Error(`no free port after ${maxAttempts} random draws: ${lastError.message}`),
  };
}

/**
 * Bind a server to 127.0.0.1. `port` given → one attempt, errors returned. `port` omitted → up to
 * MAX_ATTEMPTS random draws in [PORT_MIN, PORT_MAX), retrying EADDRINUSE/EACCES.
 */
export async function listenLocal(
  server: Server,
  options: { port?: number; random?: RandomSource; attempts?: number },
): Promise<ListenResult> {
  if (options.port !== undefined) return listenPinned(server, options.port);
  return listenRandom(server, options.random ?? nativeRandom, options.attempts ?? MAX_ATTEMPTS);
}

/** The port a bound server is on (for the random case, where it was not chosen by us). */
export function boundPort(server: Server): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? (address as AddressInfo).port : 0;
}
