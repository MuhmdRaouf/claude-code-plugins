/**
 * Loopback servers and ports for tests. `listen` binds port 0 and returns the port the OS chose: race-free, use it
 * whenever the test owns the server. `freePort` is for a port a child process binds later: the bind-close-reuse
 * window cannot be closed from outside the child, so the port is drawn at random below every OS's ephemeral range
 * (Linux 32768-60999, macOS and Windows 49152-65535), where the OS never hands out a port by itself, checked free, and
 * never handed out twice by this process.
 */
import { randomInt } from "node:crypto";
import { createServer, type Server } from "node:net";

/** Binds `server` on `host` (port 0 unless given) and resolves with the bound port. */
export function listen(
  server: Pick<Server, "listen" | "address" | "once">,
  host = "127.0.0.1",
  port = 0,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error(`no port bound on ${host}`));
      else resolve(address.port);
    });
  });
}

/** Closes `server`, resolving once it no longer listens (an already closed server resolves too). */
export function closeServer(server: Pick<Server, "close">): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const LOWEST = 20_000;
const HIGHEST = 32_000;
const handedOut = new Set<number>();

async function bindable(port: number, host: string): Promise<boolean> {
  const probe = createServer();
  try {
    await listen(probe, host, port);
    await closeServer(probe);
    return true;
  } catch {
    return false;
  }
}

/** A port nothing listens on, for a child process to bind: outside the ephemeral ranges, unique in this process. */
export async function freePort(host = "127.0.0.1"): Promise<number> {
  for (let tries = 0; tries < 100; tries++) {
    const port = randomInt(LOWEST, HIGHEST);
    if (handedOut.has(port)) continue;
    handedOut.add(port);
    if (await bindable(port, host)) return port;
  }
  throw new Error(`no free port in ${LOWEST}-${HIGHEST} after 100 tries`);
}
