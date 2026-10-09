// A refused key or an empty balance on a provider route reaches Claude Code as a non-retryable 400 that says what to
// run or where to top up, never as the 401 it would read as its own login failing or the 429 it would retry for
// minutes. Anthropic's and a peer's answers are never touched.
import http from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { SpoolEvent } from "../../src/domain/route-events.ts";
import { refusalOf } from "../../src/router/refusal.ts";
import { createRouter } from "../../src/router/router.ts";
import { INSPECT_LIMIT_BYTES } from "../../src/router/upstream.ts";
import { closeServer, freePort, listen } from "../support/net.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";

const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

describe("refusalOf: each provider's documented out-of-balance answer", () => {
  it.each([
    [
      "Z.ai 1113",
      429,
      { error: { code: "1113", message: "Insufficient balance or no resource package. Please recharge." } },
    ],
    ["Z.ai 1113 as a number", 429, { error: { code: 1113, message: "x" } }],
    ["Z.ai 1316", 429, { error: { code: "1316", message: "Usage limit reached for the past 5 hours." } }],
    ["Z.ai 1317", 429, { error: { code: "1317", message: "Usage limit reached for the past 7 days." } }],
    [
      "Moonshot exceeded_current_quota_error",
      429,
      {
        error: {
          type: "exceeded_current_quota_error",
          message: "Your account is suspended, please check billing",
        },
      },
    ],
    ["DeepSeek 402", 402, { error: { message: "Insufficient Balance", type: "unknown_error" } }],
    ["MiniMax 1008", 500, { base_resp: { status_code: 1008, status_msg: "insufficient balance" } }],
    [
      "DashScope Arrearage",
      400,
      {
        error: {
          code: "Arrearage",
          message: "Access denied, please make sure your account is in good standing.",
        },
      },
    ],
    ["DashScope isv.OUT_OF_SERVICE", 400, { code: "isv.OUT_OF_SERVICE", message: "service paused" }],
    ["the wording alone", 403, { error: { message: "insufficient balance" } }],
  ])("%s is out of balance", (_name, status, body) => {
    expect(refusalOf(status, json(body))).toBe("balance");
  });

  it("reads a 401 or 403 as a refused key, and every other answer as not a refusal", () => {
    expect(refusalOf(401, json({ error: { code: "1000", message: "Authentication Failed" } }))).toBe("key");
    expect(refusalOf(403, Buffer.from("forbidden"))).toBe("key");
    expect(refusalOf(402, Buffer.from("not json"))).toBe("balance");
    // A plain rate limit (Z.ai 1302, Moonshot rate_limit_reached_error) stays a retryable 429.
    expect(refusalOf(429, json({ error: { code: "1302", message: "rate limit" } }))).toBeUndefined();
    expect(
      refusalOf(429, json({ error: { type: "rate_limit_reached_error", message: "slow down" } })),
    ).toBeUndefined();
    expect(
      refusalOf(400, json({ error: { type: "invalid_request_error", message: "bad" } })),
    ).toBeUndefined();
    expect(refusalOf(500, Buffer.from("<html>"))).toBeUndefined();
    expect(refusalOf(500, json([1113]))).toBeUndefined();
    expect(refusalOf(200, json({ error: { code: "1113" } }))).toBeUndefined();
  });
});

// ── through the router ──────────────────────────────────────────────────────────────────────────────────────────────

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      const closed = closeServer(server);
      server.closeAllConnections();
      return closed;
    }),
  );
});

/** Listens on loopback (port 0 unless given) and closes the server after the test. */
function serve(server: http.Server, port = 0): Promise<number> {
  servers.push(server);
  return listen(server, "127.0.0.1", port);
}

/** An upstream that answers every request with the status and body it is set to. */
async function answering() {
  const state = {
    status: 200,
    body: '{"ok":true}',
    type: "application/json",
    encoding: undefined as string | undefined,
  };
  const port = await serve(
    http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(state.status, {
          "content-type": state.type,
          ...(state.encoding === undefined ? {} : { "content-encoding": state.encoding }),
        });
        res.end(state.encoding === undefined ? state.body : gzipSync(Buffer.from(state.body)));
      });
    }),
  );
  return { state, url: new URL(`http://127.0.0.1:${port}`) };
}

async function rig() {
  const provider = await answering();
  const anthropic = await answering();
  const peer = await answering();
  const logs: string[] = [];
  const events: SpoolEvent[] = [];
  const port = await freePort();
  await serve(
    createRouter({
      provider: REFERENCE_PROVIDER,
      port,
      anthropic: anthropic.url,
      providerUrl: provider.url,
      key: async () => "the-key",
      log: (line) => logs.push(line),
      peers: (model) =>
        model.startsWith("kimi-") ? { name: "kimi", port: Number(peer.url.port) } : undefined,
      events: (event) => events.push(event),
    }),
    port,
  );
  const post = async (model: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [] }),
    });
    return { status: res.status, retry: res.headers.get("x-should-retry"), body: await res.text() };
  };
  return { provider, anthropic, peer, logs, events, post, port };
}

const message = (body: string): string => (JSON.parse(body) as { error: { message: string } }).error.message;

/** A provider-bound POST read raw: fetch would decompress for its caller and hide the answer's own bytes. */
function postRaw(
  port: number,
  model: string,
): Promise<{ status: number; encoding: string | null; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            encoding: res.headers["content-encoding"] ?? null,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ model, messages: [] }));
  });
}

describe("the router on a provider route", () => {
  it("answers the provider's 401 and 403 with a non-retryable 400 that names setup, never the upstream's text", async () => {
    const r = await rig();
    for (const status of [401, 403]) {
      r.provider.state.status = status;
      r.provider.state.body = JSON.stringify({ error: { code: "1000", message: "bad key the-key" } });
      const answer = await r.post("glm-5.3");
      expect(answer.status).toBe(400);
      expect(answer.retry).toBe("false");
      expect(answer.body).not.toContain("the-key");
      expect(JSON.parse(answer.body)).toEqual({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Z.ai GLM key refused or missing: run /zai:setup (Z.ai GLM answered HTTP ${status}). Claude models are not affected.`,
        },
      });
    }
    expect(r.logs).toContainEqual(expect.stringContaining("→ provider 401 answered 400 (key refused)"));
  });

  it("answers an out-of-balance 429 at once with a non-retryable 400 naming the top-up page", async () => {
    const r = await rig();
    r.provider.state.status = 429;
    r.provider.state.body = JSON.stringify({ error: { code: "1113", message: "Insufficient balance" } });
    const answer = await r.post("glm-5.3-flash");
    expect(answer.status).toBe(400);
    expect(answer.retry).toBe("false");
    expect(message(answer.body)).toBe(
      "Z.ai GLM says this key has no balance or quota left (Z.ai GLM answered HTTP 429): top up at https://z.ai/manage-apikey/billing, then retry. Claude models are not affected.",
    );
  });

  it("passes every other provider error through as it came: a plain rate limit stays a retryable 429", async () => {
    const r = await rig();
    r.provider.state.status = 429;
    r.provider.state.body = '{"error":{"code":"1302","message":"rate limit"}}';
    expect(await r.post("glm-5.3")).toEqual({ status: 429, retry: null, body: r.provider.state.body });
    r.provider.state.status = 500;
    r.provider.state.body = "upstream broke";
    expect(await r.post("glm-5.3")).toEqual({ status: 500, retry: null, body: "upstream broke" });
  });

  it("blanks the key out of any other provider error that quotes it, status and type kept", async () => {
    const r = await rig();
    r.provider.state.status = 500;
    r.provider.state.type = "text/plain";
    r.provider.state.body = "bearer the-key is not valid here; the-key again";
    expect(await r.post("glm-5.3")).toEqual({
      status: 500,
      retry: null,
      body: "bearer [key redacted] is not valid here; [key redacted] again",
    });
    expect(r.logs).toContainEqual(expect.stringContaining("→ provider 500 answered 500 (key redacted)"));
  });

  it("answers a held-back error the provider cuts off midway with a 502, never a half-sent body", async () => {
    const r = await rig();
    r.provider.state.status = 401;
    r.provider.state.body = "cut";
    // The answer's headers and a first chunk go out, then the socket dies before the body ends.
    servers[0]?.removeAllListeners("request");
    servers[0]?.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(401, { "content-type": "application/json", "content-length": "100" });
        res.write('{"error":');
        setTimeout(() => res.socket?.destroy(), 20);
      });
    });
    const answer = await r.post("glm-5.3");
    expect(answer.status).toBe(502);
    expect(message(answer.body)).toContain("provider unreachable");
  });

  it("sends an error body over the inspection limit through unchanged, even a 401", async () => {
    const r = await rig();
    r.provider.state.status = 401;
    r.provider.state.body = "x".repeat(INSPECT_LIMIT_BYTES * 2);
    const answer = await r.post("glm-5.3");
    expect(answer.status).toBe(401);
    expect(answer.body).toBe(r.provider.state.body);
  });
});

describe("a provider answer that arrives compressed", () => {
  it("reads a gzipped out-of-balance 429 the same as a plain one", async () => {
    const r = await rig();
    r.provider.state.status = 429;
    r.provider.state.encoding = "gzip";
    r.provider.state.body = JSON.stringify({ error: { code: "1113", message: "Insufficient balance" } });
    const answer = await r.post("glm-5.3-flash");
    expect(answer.status).toBe(400);
    expect(answer.retry).toBe("false");
    expect(message(answer.body)).toBe(
      "Z.ai GLM says this key has no balance or quota left (Z.ai GLM answered HTTP 429): top up at https://z.ai/manage-apikey/billing, then retry. Claude models are not affected.",
    );
    expect(r.logs).toContainEqual(expect.stringContaining("→ provider 429 answered 400 (out of balance)"));
  });

  it("blanks the key out of a gzipped error that quotes it, and answers plain bytes", async () => {
    const r = await rig();
    r.provider.state.status = 500;
    r.provider.state.type = "text/plain";
    r.provider.state.encoding = "gzip";
    r.provider.state.body = "bearer the-key is not valid here";
    const answer = await postRaw(r.port, "glm-5.3");
    expect(answer.status).toBe(500);
    // The replacement is the router's own plain body, so it no longer claims the provider's encoding.
    expect(answer.encoding).toBeNull();
    expect(answer.body.toString()).toBe("bearer [key redacted] is not valid here");
    expect(r.logs).toContainEqual(expect.stringContaining("→ provider 500 answered 500 (key redacted)"));
  });

  it("reads a gzipped error's reason for its route event and log line", async () => {
    const r = await rig();
    r.provider.state.status = 400;
    r.provider.state.encoding = "gzip";
    r.provider.state.body = '{"error":{"code":"1210","message":"API key not valid"}}';
    const answer = await postRaw(r.port, "glm-5.3");
    // Not a refusal, and the key is not quoted: the gzip bytes go through exactly as they came.
    expect(answer.status).toBe(400);
    expect(answer.encoding).toBe("gzip");
    expect(answer.body).toEqual(gzipSync(Buffer.from(r.provider.state.body)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.logs).toContainEqual(expect.stringContaining("→ provider 400 (1210: API key not valid)"));
    expect(r.events[0]).toMatchObject({ event: "route", status: 400, error: "1210: API key not valid" });
  });

  it("passes a gzipped answer that is neither a refusal nor key-quoting through byte for byte", async () => {
    const r = await rig();
    r.provider.state.status = 429;
    r.provider.state.encoding = "gzip";
    r.provider.state.body = '{"error":{"code":"1302","message":"rate limit"}}';
    const answer = await postRaw(r.port, "glm-5.3");
    expect(answer.status).toBe(429);
    expect(answer.encoding).toBe("gzip");
    expect(answer.body).toEqual(gzipSync(Buffer.from(r.provider.state.body)));
  });
});

describe("the router on claude-* and peer routes", () => {
  it("never alters Anthropic's or a peer's answers, a 401 or an out-of-balance 429 included", async () => {
    const r = await rig();
    for (const upstream of [r.anthropic, r.peer]) {
      for (const [status, body] of [
        [401, '{"type":"error","error":{"type":"authentication_error","message":"OAuth token expired"}}'],
        [429, '{"error":{"code":"1113","message":"Insufficient balance"}}'],
        [402, '{"error":{"message":"Insufficient Balance"}}'],
      ] as const) {
        upstream.state.status = status;
        upstream.state.body = body;
        const model = upstream === r.anthropic ? "claude-sonnet-5-5" : "kimi-k3";
        expect(await r.post(model)).toEqual({ status, retry: null, body });
      }
    }
  });
});
