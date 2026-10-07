import type { IncomingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHttpServer, hostAllowed } from "../src/server/http.ts";
import { boundPort } from "../src/server/port.ts";
import type { Store } from "../src/store/store.ts";
import { createStore } from "../src/store/store.ts";
import { iso, makeEnv, makeRequest, waitFor, withPublicDir, writeText } from "./helpers.ts";

const PUBLIC_FILES: Record<string, string> = {
  "index.html": "<!doctype html><title>obs</title>observatory — ✓", // non-ascii: byte lengths, not chars
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

async function withServer<T>(
  options: { heartbeatMs?: number; files?: Record<string, string> },
  fn: (handle: { port: number; store: Store; closeStreams(): void }) => Promise<T>,
): Promise<T> {
  const { home } = makeEnv();
  const files = options.files ?? PUBLIC_FILES;
  for (const name of Object.keys(files)) writeText(join(home, "public", name), files[name] ?? "");
  const store = createStore();
  const built = await withPublicDir(join(home, "public"), async () => {
    const built = createHttpServer({
      store,
      version: "test",
      startedAt: 1_000,
      ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
    });
    await new Promise<void>((resolve) => built.server.listen(0, "127.0.0.1", () => resolve()));
    built.state.port = boundPort(built.server);
    return built;
  });
  try {
    return await fn({ port: built.state.port, store, closeStreams: built.closeStreams });
  } finally {
    built.server.closeAllConnections();
    await new Promise<void>((resolve) => built.server.close(() => resolve()));
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
