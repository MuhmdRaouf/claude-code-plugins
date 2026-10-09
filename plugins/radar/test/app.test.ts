import { chmodSync, mkdirSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readServerInfo, removeServerInfo, startApp, writeServerInfo } from "../src/server/app.ts";
import { fileExists, savedPort, savePort, serverInfoPath } from "../src/shared/paths.ts";
import { iso, jsonl, makeEnv, writeText } from "./helpers.ts";

const DAY = 86_400_000;

/** One JSON body over real loopback http — the point is that a real client can talk to the app. */
function getJson(port: number, path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve(JSON.parse(body) as Record<string, unknown>));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A foreign socket squatting on a port, to make binds fail or to reserve a port. */
function startBlocker(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function closeQuietly(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** The spool file the real-clock watcher picks up on its first pass: today's date, fresh timestamps. */
function seedSpool(state: string, lines: Record<string, unknown>[]): string {
  const today = new Date().toISOString().slice(0, 10);
  return writeText(join(state, "spool", `${today}.jsonl`), jsonl(lines));
}

describe("server.json", () => {
  it("round-trips through a 0600 file, creating the state dir on the way", () => {
    const { env, state } = makeEnv();
    expect(fileExists(state)).toBe(false); // a first-ever start has no state dir yet
    expect(writeServerInfo(env, { pid: 4242, port: 8787, url: "http://127.0.0.1:8787", startedAt: 42 })).toBe(
      true,
    );
    expect(statSync(state).mode & 0o777).toBe(0o700);
    expect(statSync(serverInfoPath(env)).mode & 0o777).toBe(0o600);
    expect(readServerInfo(env)).toEqual({
      pid: 4242,
      port: 8787,
      url: "http://127.0.0.1:8787",
      startedAt: 42,
    });
  });

  it("reads nothing from malformed or mistyped files", () => {
    const { env } = makeEnv();
    writeText(serverInfoPath(env), "{oops");
    expect(readServerInfo(env)).toBeNull();
    writeText(serverInfoPath(env), JSON.stringify({ pid: "1", port: 2 })); // pid as a string
    expect(readServerInfo(env)).toBeNull();
    writeText(serverInfoPath(env), JSON.stringify({ pid: 1 })); // no port
    expect(readServerInfo(env)).toBeNull();
  });

  it("synthesizes the url and zeroes startedAt for a minimal but valid file", () => {
    const { env } = makeEnv();
    writeText(serverInfoPath(env), JSON.stringify({ pid: 9, port: 9001 }));
    expect(readServerInfo(env)).toEqual({ pid: 9, port: 9001, url: "http://127.0.0.1:9001", startedAt: 0 });
  });

  it("removes idempotently, present or not", () => {
    const { env } = makeEnv();
    removeServerInfo(env); // nothing there: the common case after a crash
    removeServerInfo(env);
    expect(fileExists(serverInfoPath(env))).toBe(false);
    writeServerInfo(env, { pid: 1, port: 1, url: "u", startedAt: 0 });
    removeServerInfo(env);
    expect(fileExists(serverInfoPath(env))).toBe(false);
  });

  it("reports a failed write against an unwritable file, leaving the old contents intact", () => {
    const { env } = makeEnv();
    writeServerInfo(env, { pid: 1, port: 1111, url: "http://127.0.0.1:1111", startedAt: 1 });
    chmodSync(serverInfoPath(env), 0o400); // open "w" on a read-only file fails where it stands
    try {
      expect(writeServerInfo(env, { pid: 2, port: 2222, url: "http://127.0.0.1:2222", startedAt: 2 })).toBe(
        false,
      );
      expect(readServerInfo(env)?.pid).toBe(1); // openSync failed before it could truncate anything
    } finally {
      chmodSync(serverInfoPath(env), 0o600);
    }
  });
});

describe("startApp", () => {
  it("runs without history when the history file cannot be opened, logging one line", async () => {
    const { env, state } = makeEnv();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // a directory where the database file must go: every runtime refuses to open it
    mkdirSync(join(state, "history.db"), { recursive: true });
    seedSpool(state, [{ ts: iso(Date.now()), event: "SessionStart", session_id: "s1", cwd: "/w/app" }]);
    const app = await startApp({ env, version: "test", sinceMs: DAY, intervalMs: 3_600_000 });
    try {
      expect(app.writer).toBeNull();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toContain("history unavailable");
      const health = await getJson(app.port, "/api/health");
      expect(health).toMatchObject({ ok: true, sessions: 1 }); // ingest went on as usual
    } finally {
      errorSpy.mockRestore();
      await app.stop();
    }
  });

  it("binds loopback, publishes its own pid and answers real http before it resolves", async () => {
    const { env, state } = makeEnv();
    seedSpool(state, [
      { ts: iso(Date.now()), event: "SessionStart", session_id: "s1", cwd: "/w/app" },
      { ts: iso(Date.now()), event: "UserPromptSubmit", session_id: "s1", prompt: "hello" },
    ]);
    const app = await startApp({ env, version: "test", sinceMs: DAY, intervalMs: 3_600_000 });
    try {
      expect(app.port).toBeGreaterThanOrEqual(10_000);
      expect(app.port).toBeLessThan(65_536);
      expect(app.url).toBe(`http://127.0.0.1:${app.port}`);
      expect(app.store.sessionList().map((session) => session.id)).toEqual(["s1"]); // the first pass ran
      expect(statSync(serverInfoPath(env)).mode & 0o777).toBe(0o600);
      expect(readServerInfo(env)).toEqual({
        pid: process.pid, // the child writes server.json itself
        port: app.port,
        url: app.url,
        startedAt: expect.any(Number),
      });
      const health = await getJson(app.port, "/api/health");
      expect(health).toMatchObject({ ok: true, version: "test", port: app.port, sessions: 1 });
    } finally {
      await app.stop();
    }
    expect(fileExists(serverInfoPath(env))).toBe(false);
    await expect(getJson(app.port, "/api/health")).rejects.toThrow(); // the socket is gone
  });

  it("keeps its port across a stop: the next start takes the saved one, a taken one moves and says so", async () => {
    const { env } = makeEnv();
    const first = await startApp({ env, version: "test", sinceMs: DAY, intervalMs: 3_600_000 });
    const port = first.port;
    await first.stop();
    expect(savedPort(env)).toBe(port); // kept after the stop, unlike server.json
    const again = await startApp({ env, version: "test", sinceMs: DAY, intervalMs: 3_600_000 });
    try {
      expect(again.port).toBe(port);
      expect(again.movedFrom).toBeUndefined();
    } finally {
      await again.stop();
    }
    const { server: blocker, port: taken } = await startBlocker();
    savePort(env, taken);
    const moved = await startApp({ env, version: "test", sinceMs: DAY, intervalMs: 3_600_000 });
    try {
      expect(moved.port).not.toBe(taken);
      expect(moved.movedFrom).toBe(taken);
      expect(savedPort(env)).toBe(moved.port);
    } finally {
      await moved.stop();
      await closeQuietly(blocker);
    }
  });

  it("binds exactly a pinned --port and records it", async () => {
    const { env } = makeEnv();
    const { server: blocker, port } = await startBlocker(); // reserve, then vacate
    await closeQuietly(blocker);
    const app = await startApp({ env, version: "test", sinceMs: DAY, port, intervalMs: 3_600_000 });
    try {
      expect(app.port).toBe(port);
      expect(readServerInfo(env)?.port).toBe(port);
    } finally {
      await app.stop();
    }
  });

  it("fails a pinned port that is busy, without publishing anything", async () => {
    const { env } = makeEnv();
    const { server: blocker, port } = await startBlocker();
    try {
      await expect(
        startApp({ env, version: "test", sinceMs: DAY, port, intervalMs: 3_600_000 }),
      ).rejects.toThrow(/EADDRINUSE/); // one attempt, the error surfaces as-is
      expect(fileExists(serverInfoPath(env))).toBe(false); // no url to a server that never bound
    } finally {
      await closeQuietly(blocker);
    }
  });

  it("gives up after 50 hopeless random draws and publishes nothing", async () => {
    const { env } = makeEnv();
    const { server: blocker, port } = await startBlocker();
    try {
      let draws = 0;
      await expect(
        startApp({
          env,
          version: "test",
          sinceMs: DAY,
          intervalMs: 3_600_000,
          random: () => {
            draws += 1;
            return port; // every draw lands on the busy port, EADDRINUSE being retryable
          },
        }),
      ).rejects.toThrow("no free port after 50 random draws");
      expect(draws).toBe(50);
      expect(fileExists(serverInfoPath(env))).toBe(false);
    } finally {
      await closeQuietly(blocker);
    }
  });
});
