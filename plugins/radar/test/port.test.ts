import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  boundPort,
  listenLocal,
  MAX_ATTEMPTS,
  nativeRandom,
  PORT_MAX,
  PORT_MIN,
  type RandomSource,
} from "../src/server/port.ts";

const open: Server[] = [];

function freshServer(): Server {
  const server = createServer();
  open.push(server);
  return server;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** A port that is bound right now and stays bound for the test's lifetime. */
async function occupiedPort(): Promise<number> {
  const holder = freshServer();
  await listen(holder, 0);
  return boundPort(holder);
}

/** Bind an ephemeral port, then release it — a port that was free a moment ago. */
async function recentlyFreePort(): Promise<number> {
  const probe = freshServer();
  await listen(probe, 0);
  const port = boundPort(probe);
  await close(probe);
  return port;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => close(server)));
});

describe("listenLocal", () => {
  it("exposes the random-port policy constants", () => {
    expect(PORT_MIN).toBe(10_000);
    expect(PORT_MAX).toBe(65_536);
    expect(MAX_ATTEMPTS).toBe(50);
    const draw = nativeRandom(PORT_MIN, PORT_MAX);
    expect(draw).toBeGreaterThanOrEqual(PORT_MIN);
    expect(draw).toBeLessThan(PORT_MAX);
  });

  it("binds a random port on the loopback and reports it", async () => {
    const server = freshServer();
    const result = await listenLocal(server, { random: () => 25_000, attempts: 3 });
    expect(result).toMatchObject({ ok: true, port: 25_000 });
    expect(boundPort(server)).toBe(25_000);
  });

  it("retries EADDRINUSE with a fresh draw in range", async () => {
    const occupied = await occupiedPort();
    const free = await recentlyFreePort();
    const draws: number[] = [];
    const random: RandomSource = (min, _max) => {
      draws.push(min);
      return draws.length <= 2 ? occupied : free;
    };
    const result = await listenLocal(freshServer(), { random, attempts: 5 });
    expect(result).toMatchObject({ ok: true, port: free });
    expect(draws).toEqual([PORT_MIN, PORT_MIN, PORT_MIN]);
  });

  it("gives up after the attempt budget with a clear message", async () => {
    const occupied = await occupiedPort();
    let draws = 0;
    const random: RandomSource = () => {
      draws += 1;
      return occupied;
    };
    const result = await listenLocal(freshServer(), { random, attempts: 4 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("no free port after 4 random draws");
    expect(result.error.message).toContain("EADDRINUSE");
    expect(draws).toBe(4);
  });

  it("surfaces non-retryable errors without redrawing", async () => {
    const busy = freshServer();
    await listen(busy, 0); // already listening: a second listen can never succeed
    let draws = 0;
    const random: RandomSource = () => {
      draws += 1;
      return 25_000;
    };
    const result = await listenLocal(busy, { random, attempts: 5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as NodeJS.ErrnoException).code).toBe("ERR_SERVER_ALREADY_LISTEN");
    expect(draws).toBe(1);
  });

  it("tries a pinned port exactly once, success or failure", async () => {
    const free = await recentlyFreePort();
    const pinned = await listenLocal(freshServer(), { port: free });
    expect(pinned).toMatchObject({ ok: true, port: free });

    const occupied = await occupiedPort();
    const never: RandomSource = () => {
      throw new Error("pinned ports must not draw");
    };
    const failed = await listenLocal(freshServer(), { port: occupied, random: never });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect((failed.error as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
  });

  it("reports no port for a server that never listened", () => {
    expect(boundPort(freshServer())).toBe(0);
  });
});
