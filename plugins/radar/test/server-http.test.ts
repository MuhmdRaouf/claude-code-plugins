import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { type History, openHistory } from "../src/history/history.ts";
import { createHttpServer, hostAllowed } from "../src/server/http.ts";
import { createInsights } from "../src/server/insights.ts";
import { boundPort } from "../src/server/port.ts";
import { historyPath } from "../src/shared/paths.ts";
import type { Store } from "../src/store/store.ts";
import { createStore } from "../src/store/store.ts";
import { iso, makeEnv, makeRequest, waitFor, withPublicDir, writeText } from "./helpers.ts";

const PUBLIC_FILES: Record<string, string> = {
  "index.html": "<!doctype html><title>obs</title>radar — ✓", // non-ascii: byte lengths, not chars
  "app.css": "body{background:#0b0f14}",
  "app.js": "console.log('obs')",
};

type Response = { status: number; headers: IncomingHttpHeaders; body: string };

/** A client request the way Node sends it: Host is the loopback pair for this port automatically. */
function get(port: number, path: string, method: "GET" | "HEAD" = "GET"): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** The same, but the body stays bytes: for the bundled fonts, which are not text. */
function getRaw(
  port: number,
  path: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/** A hand-written request over a raw socket, for headers Node would not let us send. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let text = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(text));
  });
}

/** A write with explicit headers, the way the dashboard's own fetch sends it. */
function post(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** An /api/stream client that just accumulates the wire text for inspection. */
function openStream(port: number): { buffer(): string; close(): void; ended(): boolean } {
  const req = httpRequest({ host: "127.0.0.1", port, path: "/api/stream" });
  let text = "";
  let ended = false;
  req.on("response", (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      text += chunk;
    });
    // a stream torn down mid-response is how every test ends; transport noise is not a failure
    res.on("error", () => {});
    res.on("close", () => {
      ended = true;
    });
  });
  req.on("error", () => {});
  req.end(); // without it the request never leaves the client
  return { buffer: () => text, close: () => req.destroy(), ended: () => ended };
}

/** Complete SSE frames only: anything past the last blank line is a half-arrived frame. */
function sseFrames(wire: string): { data: Record<string, unknown>[]; comments: string[] } {
  const complete = wire.endsWith("\n\n") ? wire : wire.slice(0, Math.max(0, wire.lastIndexOf("\n\n") + 2));
  const data: Record<string, unknown>[] = [];
  const comments: string[] = [];
  for (const line of complete.split("\n")) {
    if (line.startsWith("data: ")) data.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
    else if (line.startsWith(":")) comments.push(line);
  }
  return { data, comments };
}

/** A font or other binary artifact into the test public dir; writeText is utf8-only. */
function writeBinary(path: string, contents: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: 0o600 });
}

async function withServer<T>(
  options: {
    heartbeatMs?: number;
    files?: Record<string, string>;
    binary?: Record<string, Buffer>;
    history?: boolean;
    /** The ingest watcher, for the backlog word the snapshot and ingest messages carry. */
    watcher?: { catchingUp(): boolean };
  },
  fn: (handle: {
    port: number;
    store: Store;
    closeStreams(): void;
    /** The wired history when the test asked for one, else null. */
    history: History | null;
  }) => Promise<T>,
): Promise<T> {
  const { env, home } = makeEnv();
  const files = options.files ?? PUBLIC_FILES;
  for (const name of Object.keys(files)) writeText(join(home, "public", name), files[name] ?? "");
  for (const [name, contents] of Object.entries(options.binary ?? {})) {
    writeBinary(join(home, "public", name), contents);
  }
  const store = createStore();
  let history: History | null = null;
  if (options.history === true) history = await openHistory(historyPath(env));
  const insights = history === null ? undefined : createInsights({ env, store, tickMs: 0 });
  const built = await withPublicDir(join(home, "public"), async () => {
    const built = createHttpServer({
      store,
      version: "test",
      startedAt: 1_000,
      ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
      ...(insights !== undefined ? { insights } : {}),
      ...(options.watcher !== undefined ? { watcher: options.watcher } : {}),
      history,
    });
    await new Promise<void>((resolve) => built.server.listen(0, "127.0.0.1", () => resolve()));
    built.state.port = boundPort(built.server);
    return built;
  });
  try {
    return await fn({ port: built.state.port, store, closeStreams: built.closeStreams, history });
  } finally {
    built.server.closeAllConnections();
    await new Promise<void>((resolve) => built.server.close(() => resolve()));
    insights?.stop();
    history?.close();
  }
}

describe("hostAllowed", () => {
  it("accepts only the two loopback spellings of this exact port", () => {
    expect(hostAllowed("127.0.0.1:8787", 8787)).toBe(true);
    expect(hostAllowed("localhost:8787", 8787)).toBe(true);
    expect(hostAllowed("127.0.0.1:8787", 9999)).toBe(false); // right name, wrong port
    expect(hostAllowed("127.0.0.1", 8787)).toBe(false); // no port at all
    expect(hostAllowed("localhost", 8787)).toBe(false);
    expect(hostAllowed("evil.example:8787", 8787)).toBe(false); // a rebound name
    expect(hostAllowed("[::1]:8787", 8787)).toBe(false);
    expect(hostAllowed(undefined, 8787)).toBe(false);
  });
});

describe("the dns-rebinding guard", () => {
  it("rejects foreign, missing and wrong-port Host headers with 403", async () => {
    await withServer({}, async ({ port }) => {
      const foreign = await raw(
        port,
        `GET / HTTP/1.1\r\nHost: evil.example:${port}\r\nConnection: close\r\n\r\n`,
      );
      expect(foreign.startsWith("HTTP/1.1 403")).toBe(true);
      expect(foreign).toContain('"error":"forbidden host"');
      expect(foreign.startsWith("HTTP/1.1 200")).toBe(false); // never a byte of the dashboard

      const noHost = await raw(port, "GET / HTTP/1.0\r\nConnection: close\r\n\r\n");
      expect(noHost.startsWith("HTTP/1.1 403")).toBe(true);

      const wrongPort = await raw(port, "GET / HTTP/1.1\r\nHost: 127.0.0.1:1\r\nConnection: close\r\n\r\n");
      expect(wrongPort.startsWith("HTTP/1.1 403")).toBe(true);
    });
  });

  it("serves both loopback spellings of this port", async () => {
    await withServer({}, async ({ port }) => {
      const numeric = await get(port, "/");
      expect(numeric.status).toBe(200);
      const local = await raw(
        port,
        `GET /api/health HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`,
      );
      expect(local.startsWith("HTTP/1.1 200")).toBe(true);
    });
  });
});

describe("methods", () => {
  it("answers GET and HEAD only", async () => {
    await withServer({}, async ({ port }) => {
      const post = await raw(
        port,
        `POST /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      expect(post.startsWith("HTTP/1.1 405")).toBe(true);
      expect(post).toContain('"error":"method not allowed"');

      const head = await get(port, "/api/health", "HEAD");
      expect(head.status).toBe(200);
      expect(head.body).toBe(""); // the body is suppressed; the headers stay
      expect(head.headers["content-type"]).toBe("application/json; charset=utf-8");
    });
  });
});

describe("static files", () => {
  it("serves the three allowlisted paths with their content types", async () => {
    await withServer({}, async ({ port }) => {
      const index = await get(port, "/");
      expect(index.status).toBe(200);
      expect(index.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(index.headers["cache-control"]).toBe("no-store");
      expect(index.body).toBe(PUBLIC_FILES["index.html"] ?? "");
      expect(Number(index.headers["content-length"])).toBe(Buffer.byteLength(index.body, "utf8"));

      expect((await get(port, "/index.html")).body).toBe(index.body);
      expect((await get(port, "/app.css")).headers["content-type"]).toBe("text/css; charset=utf-8");
      const js = await get(port, "/app.js");
      expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(js.body).toBe(PUBLIC_FILES["app.js"] ?? "");
    });
  });

  it("404s unknown paths, encoded traversals and missing build artifacts", async () => {
    await withServer({ files: { "index.html": "x" } }, async ({ port }) => {
      const unknown = await get(port, "/secret.txt");
      expect(unknown.status).toBe(404);
      expect(unknown.body).toContain('"error":"not found: /secret.txt"');

      const traversal = await get(port, "/%2e%2e/app.js");
      expect(traversal.status).toBe(404); // encoded dots stay off the allowlist; no path is ever resolved

      const absent = await get(port, "/app.js");
      expect(absent.status).toBe(404);
      expect(absent.body).toContain('"error":"missing build artifact: app.js"');
    });
  });

  it("serves a bundled font by name as font/woff2, bytes intact, and nothing but woff2 names", async () => {
    const face = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0xff, 0xfe]); // "wOF2" plus binary bytes
    await withServer(
      {
        files: { "index.html": "x" },
        binary: { "fonts/ibm-plex-sans-latin-wght-normal.woff2": face },
      },
      async ({ port }) => {
        const font = await getRaw(port, "/fonts/ibm-plex-sans-latin-wght-normal.woff2");
        expect(font.status).toBe(200);
        expect(font.headers["content-type"]).toBe("font/woff2");
        expect(font.headers["cache-control"]).toBe("no-store");
        expect(Number(font.headers["content-length"])).toBe(face.length);
        expect(font.body.equals(face)).toBe(true);

        // an encoded slash survives URL normalization as part of the name, and the name regex admits no "/" or "%"
        const traversal = await get(port, "/fonts/latin%2f..%2fapp.woff2");
        expect(traversal.status).toBe(404);
        expect(traversal.body).toContain('"error":"not found: /fonts/latin%2f..%2fapp.woff2"');

        expect((await get(port, "/fonts/evil.js")).status).toBe(404); // only .woff2 is a font here
        const absent = await get(port, "/fonts/no-such.woff2");
        expect(absent.status).toBe(404);
        expect(absent.body).toContain('"error":"missing build artifact: fonts/no-such.woff2"');
      },
    );
  });
});

describe("json api", () => {
  it("reports health from the live store, with no CORS headers", async () => {
    await withServer({}, async ({ port, store }) => {
      const empty = await get(port, "/api/health");
      expect(empty.status).toBe(200);
      expect(empty.headers["cache-control"]).toBe("no-store");
      expect(empty.headers["access-control-allow-origin"]).toBeUndefined();
      const health = JSON.parse(empty.body) as Record<string, unknown>;
      expect(health).toMatchObject({ ok: true, version: "test", port, sessions: 0, startedAt: 1_000 });
      expect(health.uptimeMs).toBeTypeOf("number");

      store.addSpoolLine({ ts: iso(Date.now()), event: "SessionStart", session_id: "s1", cwd: "/w/app" });
      const fed = JSON.parse((await get(port, "/api/health")).body) as Record<string, unknown>;
      expect(fed.sessions).toBe(1);
      const sessions = JSON.parse((await get(port, "/api/sessions")).body) as {
        sessions: { id: string }[];
      };
      expect(sessions.sessions.map((session) => session.id)).toEqual(["s1"]);
    });
  });

  it("lists the route table for unknown api paths", async () => {
    await withServer({}, async ({ port }) => {
      const res = await get(port, "/api/nope");
      expect(res.status).toBe(404);
      const parsed = JSON.parse(res.body) as { error: string; routes: string[] };
      expect(parsed.error).toBe("no such route: /api/nope");
      expect(parsed.routes).toContain("/api/summary");
    });
  });
});

describe("the stream", () => {
  it("opens with a retry hint and a snapshot of the current store", async () => {
    await withServer({}, async ({ port, store }) => {
      store.addSpoolLine({ ts: iso(Date.now()), event: "SessionStart", session_id: "s1", cwd: "/w/app" });
      const stream = openStream(port);
      try {
        await waitFor("the snapshot frame", 2_000, () => sseFrames(stream.buffer()).data.length === 1);
        const wire = stream.buffer();
        expect(wire.startsWith("retry: 3000\n\n")).toBe(true);
        const snapshot = sseFrames(wire).data[0] ?? {};
        expect(snapshot.type).toBe("snapshot");
        expect((snapshot.sessions as { id: string }[]).map((session) => session.id)).toEqual(["s1"]);
        expect(snapshot.models).toBeTypeOf("object");
        expect(snapshot.summary).toBeTypeOf("object");
        expect(snapshot.catchingUp).toBe(false); // no watcher wired: the server is never mid-backlog
      } finally {
        stream.close();
      }
    });
  });

  it("tells the open streams when the ingest backlog word flips", async () => {
    let catchingUp = true;
    await withServer({ watcher: { catchingUp: () => catchingUp } }, async ({ port }) => {
      const stream = openStream(port);
      try {
        await waitFor("the snapshot frame", 2_000, () => sseFrames(stream.buffer()).data.length === 1);
        const snapshot = sseFrames(stream.buffer()).data[0] ?? {};
        expect(snapshot.catchingUp).toBe(true); // the reconnecting dashboard reads the word up front
        catchingUp = false; // the backlog drained
        await waitFor("the ingest message", 2_000, () => {
          const ingest = sseFrames(stream.buffer()).data.find((message) => message.type === "ingest");
          return ingest?.catchingUp === false;
        });
      } finally {
        stream.close();
      }
    });
  });

  it("pushes records as they land, then unsubscribes when the client detaches", async () => {
    await withServer({}, async ({ port, store }) => {
      const stream = openStream(port);
      try {
        await waitFor("the snapshot frame", 2_000, () => sseFrames(stream.buffer()).data.length === 1);

        store.addSpoolLine({
          ts: iso(Date.now()),
          event: "UserPromptSubmit",
          session_id: "s1",
          prompt: "hi",
        });
        await waitFor("the event and its session refresh", 2_000, () => {
          const types = sseFrames(stream.buffer()).data.map((message) => message.type);
          return types.includes("event") && types.includes("sessions");
        });

        store.addRequest(makeRequest({ id: "r-live", ts: Date.now() }));
        await waitFor("the streamed request", 2_000, () => stream.buffer().includes("r-live"));
        const streamed = sseFrames(stream.buffer()).data.find((message) => message.type === "request");
        expect((streamed as { request?: { id?: string } } | undefined)?.request?.id).toBe("r-live");
      } finally {
        stream.close();
      }

      store.addRequest(makeRequest({ id: "r-ghost", ts: Date.now() }));
      await new Promise((sleep) => setTimeout(sleep, 120));
      expect(stream.buffer().includes("r-ghost")).toBe(false); // the close handler unsubscribed us
    });
  });

  it("folds a burst of changes into one sessions message, the record deltas still immediate", async () => {
    await withServer({}, async ({ port, store }) => {
      const stream = openStream(port);
      try {
        await waitFor("the snapshot frame", 2_000, () => sseFrames(stream.buffer()).data.length === 1);
        // a catch-up burst: many single-record changes inside one coalescing window
        for (let i = 0; i < 25; i += 1) {
          store.addSpoolLine({
            ts: iso(Date.now() + i),
            event: "UserPromptSubmit",
            session_id: `s${i}`,
            prompt: `prompt ${i}`,
          });
        }
        await waitFor("the folded sessions message", 2_000, () => {
          const data = sseFrames(stream.buffer()).data;
          return data.filter((message) => message.type === "sessions").length === 1;
        });
        const folded = sseFrames(stream.buffer()).data.find((message) => message.type === "sessions") as {
          sessions?: { id: string }[];
        };
        expect((folded.sessions ?? []).map((session) => session.id)).toHaveLength(25);
        // one full-state refresh for the whole burst, however many lines fed it
        const withinWindow = sseFrames(stream.buffer()).data.filter((message) => message.type === "sessions");
        expect(withinWindow).toHaveLength(1);
        // the next change after the window opens a new refresh
        store.addSpoolLine({
          ts: iso(Date.now() + 1_000),
          event: "UserPromptSubmit",
          session_id: "s26",
          prompt: "later",
        });
        await waitFor("a second sessions message", 2_000, () => {
          return (
            sseFrames(stream.buffer()).data.filter((message) => message.type === "sessions").length === 2
          );
        });
      } finally {
        stream.close();
      }
    });
  });

  it("beats a heartbeat comment between updates", async () => {
    await withServer({ heartbeatMs: 50 }, async ({ port }) => {
      const stream = openStream(port);
      try {
        await waitFor("a heartbeat", 2_000, () => sseFrames(stream.buffer()).comments.includes(":hb"));
      } finally {
        stream.close();
      }
    });
  });

  it("closeStreams ends every live stream (bun's closeAllConnections() does not)", async () => {
    await withServer({}, async ({ port, closeStreams }) => {
      const stream = openStream(port);
      try {
        await waitFor("the snapshot frame", 2_000, () => sseFrames(stream.buffer()).data.length === 1);
        closeStreams();
        await waitFor("the stream to end", 2_000, () => stream.ended());
      } finally {
        stream.close();
      }
    });
  });

  it("answers HEAD on the stream without a body", async () => {
    await withServer({}, async ({ port }) => {
      const head = await get(port, "/api/stream", "HEAD");
      expect(head.status).toBe(200);
      expect(head.body).toBe("");
      expect(head.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    });
  });
});

describe("history over the wire", () => {
  function seedTree(history: History | null): void {
    history?.upsertNode({
      id: "s1/main",
      kind: "main",
      sessionId: "s1",
      agentId: "main",
      repo: "/w/app",
      branch: "main",
      name: "Wire",
      lastAt: Date.now(),
    });
    history?.putRequest("s1/main", {
      id: "rw",
      sessionId: "s1",
      agentId: "main",
      model: "glm-5.3",
      upstream: "https://api.z.ai",
      ts: Date.now(),
      latencyMs: 5,
      tokens: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
      stopReason: null,
      provider: "zai",
    });
  }

  it("503s every history read when no history is wired", async () => {
    await withServer({}, async ({ port }) => {
      for (const path of [
        "/api/history/roots",
        "/api/history/tree/x",
        "/api/history/requests",
        "/api/history/content/x",
        "/api/history/context/x",
        "/api/history/repos",
        "/api/history/stats",
      ]) {
        const res = await get(port, path);
        expect(res.status).toBe(503);
        expect(JSON.parse(res.body)).toEqual({ error: "history unavailable" });
      }
    });
  });

  it("serves the seeded tree through every read route", async () => {
    await withServer({ history: true }, async ({ port, history }) => {
      seedTree(history);
      const roots = JSON.parse((await get(port, "/api/history/roots")).body) as {
        roots: Array<{ id: string; requests: number; costUsd: number | null }>;
      };
      expect(roots.roots.map((root) => root.id)).toEqual(["s1/main"]);
      expect(roots.roots[0]).toMatchObject({ requests: 1, costUsd: expect.any(Number) });

      const tree = JSON.parse((await get(port, "/api/history/tree/s1%2Fmain")).body) as {
        nodes: Array<{ id: string; live: boolean }>;
      };
      expect(tree.nodes.map((node) => node.id)).toEqual(["s1/main"]);

      const requests = JSON.parse((await get(port, "/api/history/requests?root=s1%2Fmain")).body) as {
        requests: Array<{ id: string; cost: { detail: string[] } | null }>;
      };
      expect(requests.requests.map((r) => r.id)).toEqual(["rw"]);
      expect(requests.requests[0]?.cost).toMatchObject({ detail: ["Z.ai list"] });

      const repos = JSON.parse((await get(port, "/api/history/repos")).body) as {
        repos: Array<{ repo: string; roots: number }>;
      };
      expect(repos.repos).toEqual([{ repo: "/w/app", roots: 1 }]);

      const stats = JSON.parse((await get(port, "/api/history/stats")).body) as {
        nodes: number;
        requests: number;
        retentionDays: number;
      };
      expect(stats).toMatchObject({ nodes: 1, requests: 1, retentionDays: 30 });
    });
  });

  it("clears history only as JSON from the dashboard, like every write", async () => {
    await withServer({ history: true }, async ({ port, history }) => {
      seedTree(history);
      const plain = await post(port, "/api/history/clear", "{}", { "content-type": "text/plain" });
      expect(plain.status).toBe(403);
      const foreign = await post(port, "/api/history/clear", "{}", {
        "content-type": "application/json",
        origin: "http://evil.test",
      });
      expect(foreign.status).toBe(403);

      const cleared = await post(port, "/api/history/clear", "{}", {
        "content-type": "application/json",
      });
      expect(cleared.status).toBe(200);
      expect(JSON.parse(cleared.body)).toEqual({ cleared: true });
      const stats = JSON.parse((await get(port, "/api/history/stats")).body) as { nodes: number };
      expect(stats.nodes).toBe(0);

      expect((await get(port, "/api/history/clear")).status).toBe(404); // GET was never a route
      const absent = await post(port, "/api/history/clear", "{}", {
        "content-type": "application/json",
      });
      expect(absent.status).toBe(200); // clearing an empty history is fine
    });
  });
});
