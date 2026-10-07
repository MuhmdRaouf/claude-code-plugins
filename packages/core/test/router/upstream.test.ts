import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { degradedMessage, passThrough } from "../../src/router/passthrough.ts";
import {
  agentFor,
  anthropicError,
  bunProxiesItself,
  exemptLoopback,
  forwardHeaders,
  noProxy,
  type ProxyEnv,
  proxyFor,
  readBody,
  requestModel,
  responseHeaders,
  safePath,
  sendUpstream,
  trackConnections,
  type UpstreamFailure,
  upstreamUrl,
} from "../../src/router/upstream.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function serve(handler: http.RequestListener, setup?: (server: http.Server) => void): Promise<number> {
  const server = http.createServer(handler);
  setup?.(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return (server.address() as net.AddressInfo).port;
}

function request(
  port: number,
  options: { method?: string; path?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? "/v1/messages?beta=true",
        headers: options.headers ?? {},
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          }),
        );
        res.on("aborted", () => reject(new Error("aborted")));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

/** A local server whose every request is sent upstream by `sendUpstream`, recording the failures. */
async function relay(
  target: (req: IncomingMessage) => URL,
  env: ProxyEnv = {},
  extra: { idleMs?: number; direct?: boolean } = {},
): Promise<{ port: number; failures: UpstreamFailure[]; finished: number[] }> {
  const failures: UpstreamFailure[] = [];
  const finished: number[] = [];
  const port = await serve((req, res: ServerResponse) => {
    void readBody(req).then((body) => {
      if (body === "too-large") return;
      const url = target(req);
      sendUpstream(
        {
          url,
          method: req.method ?? "POST",
          headers: forwardHeaders(req.headers, url, body.length),
          body,
          env,
          ...extra,
        },
        res,
        {
          failed: (failure) => {
            failures.push(failure);
            if (!failure.afterHeaders) anthropicError(res, 502, "api_error", failure.code);
          },
          finished: (answer) => finished.push(answer.statusCode ?? 0),
        },
      );
    });
  });
  return { port, failures, finished };
}

describe("paths and headers", () => {
  it("accepts exactly one leading slash, so a request path can never change the upstream host", () => {
    expect(safePath("/v1/messages?beta=true")).toBe("/v1/messages?beta=true");
    expect(safePath("//evil.example/x")).toBeUndefined();
    expect(safePath("http://evil.example/x")).toBeUndefined();
    expect(safePath(undefined)).toBeUndefined();
  });

  it("builds the upstream URL from the target's origin and path prefix plus the request path", () => {
    expect(upstreamUrl(new URL("https://api.z.ai/api/anthropic/"), "/v1/messages?x=1").href).toBe(
      "https://api.z.ai/api/anthropic/v1/messages?x=1",
    );
    expect(upstreamUrl(new URL("https://api.anthropic.com"), "/v1/messages").href).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });

  it("reads the model of a JSON body, and nothing from anything else", () => {
    expect(requestModel(Buffer.from('{"model":"claude-x"}'))).toBe("claude-x");
    expect(requestModel(Buffer.from('{"model":7}'))).toBe("");
    expect(requestModel(Buffer.from("not json"))).toBe("");
    expect(requestModel(Buffer.from("null"))).toBe("");
  });

  it("drops the connection's own headers on the way in and on the way out", () => {
    const target = new URL("https://api.anthropic.com");
    expect(
      forwardHeaders(
        {
          connection: "keep-alive",
          "keep-alive": "timeout=5",
          "x-api-key": "k",
          host: "127.0.0.1:1",
          te: "x",
        },
        target,
        3,
      ),
    ).toEqual({ "x-api-key": "k", host: "api.anthropic.com", "content-length": "3" });
    expect(responseHeaders({ connection: "close", "keep-alive": "x", "content-type": "a" })).toEqual({
      "content-type": "a",
    });
    // Framing belongs to each hop too: a held-back answer is re-sent in one piece, and its length is its own.
    expect(responseHeaders({ "transfer-encoding": "chunked", "content-type": "a" })).toEqual({
      "content-type": "a",
    });
  });
});

describe("bodies", () => {
  it("reads a body under the limit and reports one over it", async () => {
    const seen: (Buffer | string)[] = [];
    const port = await serve((req, res) => {
      void readBody(req, 8).then((body) => {
        seen.push(body);
        res.end();
      });
    });
    await request(port, { body: "1234" });
    await request(port, { body: "123456789012" });
    expect(seen).toEqual([Buffer.from("1234"), "too-large"]);
  });

  it("answers an Anthropic-shaped error, and destroys a response whose headers already went out", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200);
      res.write("started");
      anthropicError(res, 500, "api_error", "late");
    });
    await expect(request(port)).rejects.toThrow();
  });
});

describe("the proxy environment", () => {
  it("exempts loopback from a proxy: NO_PROXY and no_proxy gain 127.0.0.1 and localhost, only when a proxy is set", () => {
    expect(exemptLoopback({ HOME: "/h" })).toEqual({ HOME: "/h" });
    expect(exemptLoopback({ HTTPS_PROXY: " " })).toEqual({ HTTPS_PROXY: " " });
    expect(exemptLoopback({ https_proxy: "http://p:1" })).toEqual({
      https_proxy: "http://p:1",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    });
    expect(exemptLoopback({ HTTP_PROXY: "http://p:1", No_Proxy: "corp, localhost" })).toEqual({
      HTTP_PROXY: "http://p:1",
      NO_PROXY: "corp,localhost,127.0.0.1",
      no_proxy: "corp,localhost,127.0.0.1",
    });
    // Lowercase wins, as in noProxy.
    expect(exemptLoopback({ HTTP_PROXY: "http://p:1", no_proxy: "a", NO_PROXY: "b" }).NO_PROXY).toBe(
      "a,127.0.0.1,localhost",
    );
  });

  it("knows which runtimes proxy from the environment by themselves: Bun before 1.4", () => {
    expect(bunProxiesItself(undefined)).toBe(false);
    expect(bunProxiesItself("1.3.14")).toBe(true);
    expect(bunProxiesItself("0.9.0")).toBe(true);
    expect(bunProxiesItself("1.4.0")).toBe(false);
    expect(bunProxiesItself("2.0.0")).toBe(false);
  });

  it("honours NO_PROXY: everything, a host, a domain suffix in its three spellings, a port", () => {
    expect(noProxy("api.anthropic.com", "443", {})).toBe(false);
    expect(noProxy("api.anthropic.com", "443", { NO_PROXY: "*" })).toBe(true);
    expect(noProxy("api.anthropic.com", "443", { no_proxy: "api.anthropic.com" })).toBe(true);
    expect(noProxy("api.anthropic.com", "443", { NO_PROXY: ".anthropic.com" })).toBe(true);
    expect(noProxy("api.anthropic.com", "443", { NO_PROXY: "*.anthropic.com" })).toBe(true);
    expect(noProxy("api.anthropic.com", "443", { NO_PROXY: "anthropic.com" })).toBe(true);
    expect(noProxy("api.anthropic.com", "443", { NO_PROXY: "anthropic.com:8443" })).toBe(false);
    expect(noProxy("api.anthropic.com", "443", { NO_PROXY: "other.com, ,api.anthropic.com:443" })).toBe(true);
    expect(noProxy("notanthropic.com", "443", { NO_PROXY: "anthropic.com" })).toBe(false);
  });

  it("picks HTTPS_PROXY or HTTP_PROXY by the target's scheme, in either case, lowercase first", () => {
    const https = new URL("https://api.anthropic.com/v1");
    const plain = new URL("http://127.0.0.1:9/x");
    expect(proxyFor(https, {})).toBeUndefined();
    expect(proxyFor(https, { HTTPS_PROXY: "http://proxy:3128" })?.href).toBe("http://proxy:3128/");
    expect(proxyFor(https, { https_proxy: "proxy:1", HTTPS_PROXY: "http://other:2" })?.href).toBe(
      "http://proxy:1/",
    );
    expect(proxyFor(plain, { HTTP_PROXY: "http://proxy:3128", HTTPS_PROXY: "http://no:1" })?.href).toBe(
      "http://proxy:3128/",
    );
    expect(proxyFor(https, { HTTPS_PROXY: "  " })).toBeUndefined();
    expect(proxyFor(https, { HTTPS_PROXY: "http://[bad" })).toBeUndefined();
    expect(proxyFor(https, { HTTPS_PROXY: "http://proxy:1", NO_PROXY: "anthropic.com" })).toBeUndefined();
  });

  it("keeps one pooled agent per route and makes a fresh one for a retry", () => {
    const target = new URL("http://127.0.0.1:1");
    expect(agentFor(target, {})).toBe(agentFor(target, {}));
    expect(agentFor(target, {}, true)).not.toBe(agentFor(target, {}));
    expect(agentFor(new URL("https://example.com"), {})).not.toBe(agentFor(target, {}));
  });

  it("tunnels through the proxy with CONNECT, with credentials when the proxy URL carries them", async () => {
    const upstream = await serve((req, res) => {
      req.resume();
      req.on("end", () => res.end(`upstream saw ${req.url}`));
    });
    const connects: { url: string; auth?: string }[] = [];
    const proxy = await serve(
      (_req, res) => res.end("not a forward proxy"),
      (server) =>
        server.on("connect", (req: IncomingMessage, client: net.Socket, head: Buffer) => {
          connects.push({
            url: req.url ?? "",
            ...(req.headers["proxy-authorization"] === undefined
              ? {}
              : { auth: req.headers["proxy-authorization"] }),
          });
          const [host, port] = (req.url ?? "").split(":");
          const socket = net.connect(Number(port), host, () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            socket.write(head);
            socket.pipe(client);
            client.pipe(socket);
          });
          client.on("error", () => socket.destroy());
          socket.on("error", () => client.destroy());
        }),
    );
    const viaProxy = await relay((req) => new URL(`http://127.0.0.1:${upstream}${req.url}`), {
      HTTP_PROXY: `http://user:p%40ss@127.0.0.1:${proxy}`,
    });
    expect((await request(viaProxy.port, { body: "{}" })).body).toBe("upstream saw /v1/messages?beta=true");
    expect(connects).toEqual([
      { url: `127.0.0.1:${upstream}`, auth: `Basic ${Buffer.from("user:p@ss").toString("base64")}` },
    ]);
  });

  it("reports a proxy that refuses the tunnel", async () => {
    const proxy = await serve(
      (_req, res) => res.end(),
      (server) =>
        server.on("connect", (_req: IncomingMessage, client: net.Socket) => {
          client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        }),
    );
    const viaProxy = await relay(() => new URL("http://127.0.0.1:9/x"), {
      HTTP_PROXY: `http://127.0.0.1:${proxy}`,
    });
    const answer = await request(viaProxy.port, { body: "{}" });
    expect(answer.status).toBe(502);
    expect(viaProxy.failures).toHaveLength(1);
  });

  it("leaves the proxying to Node when NODE_USE_ENV_PROXY=1", async () => {
    const forwarded: string[] = [];
    const proxy = await serve((req, res) => {
      forwarded.push(req.url ?? "");
      req.resume();
      req.on("end", () => res.end("via node's proxy"));
    });
    const viaNode = await relay(() => new URL("http://127.0.0.1:9/x"), {
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: `http://127.0.0.1:${proxy}`,
    });
    expect((await request(viaNode.port, { body: "{}" })).body).toBe("via node's proxy");
    expect(forwarded).toEqual(["http://127.0.0.1:9/x"]);
  });
});

describe("connection tracking", () => {
  /** A server that answers /stream with a stream that never ends and everything else at once, tracked. */
  async function tracked() {
    let opened = 0;
    const closes: number[] = [];
    const connections = trackConnections((open) => closes.push(open));
    const server = http.createServer((req, res) => {
      if (req.url === "/stream") {
        res.writeHead(200);
        res.write("first\n");
        return;
      }
      res.end("ok");
    });
    server.on("connection", () => (opened += 1));
    connections.watch(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      connections.closeAll();
      server.close();
    });
    const port = (server.address() as net.AddressInfo).port;
    const agent = new http.Agent({ keepAlive: true });
    cleanups.push(() => agent.destroy());
    const get = (path: string) =>
      new Promise<IncomingMessage>((resolve, reject) =>
        http.get({ host: "127.0.0.1", port, path, agent }, resolve).on("error", reject),
      );
    return { connections, closes, get, opened: () => opened };
  }

  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };

  it("drain closes an idle keep-alive socket at once and a busy one as soon as its response is done", async () => {
    const t = await tracked();
    const idle = await t.get("/");
    idle.resume();
    await new Promise((resolve) => idle.on("end", resolve));
    expect(t.connections.size).toBe(1);
    t.connections.drain();
    await until(() => t.connections.size === 0);
    expect(t.connections.size).toBe(0);
    expect(t.closes).toEqual([0]);
  });

  it("drain leaves a streaming response open; closeAll ends it", async () => {
    const t = await tracked();
    const stream = await t.get("/stream");
    let ended = false;
    stream.on("close", () => (ended = true));
    stream.resume();
    t.connections.drain();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ended).toBe(false);
    expect(t.connections.size).toBe(1);
    t.connections.closeAll();
    await until(() => ended);
    expect(ended).toBe(true);
  });

  it("a busy socket that finishes while draining closes right after its response", async () => {
    const t = await tracked();
    const pending = t.get("/");
    t.connections.drain();
    const answer = await pending;
    answer.resume();
    await until(() => t.connections.size === 0);
    expect(t.connections.size).toBe(0);
    expect(t.opened()).toBe(1);
  });
});

describe("one request upstream", () => {
  it("retries once on a fresh socket when a reused one turns out closed before any answer", async () => {
    let served = 0;
    const upstream = await serve((req, res) => {
      req.resume();
      req.on("end", () => {
        served += 1;
        res.end(`answer ${served}`);
        // The upstream closes its idle keep-alive socket right after answering: the next reuse finds it dead.
        setTimeout(() => req.socket.destroy(), 1);
      });
    });
    const port = await relay(() => new URL(`http://127.0.0.1:${upstream}/x`));
    expect((await request(port.port, { body: "{}" })).body).toBe("answer 1");
    await sleep(20);
    expect((await request(port.port, { body: "{}" })).status).toBe(200);
    expect(port.failures).toEqual([]);
  });

  it("gives up on an upstream that stays silent (an idle timeout, not a total one)", async () => {
    const upstream = await serve(() => undefined);
    const port = await relay(() => new URL(`http://127.0.0.1:${upstream}/x`), {}, { idleMs: 100 });
    const answer = await request(port.port, { body: "{}" });
    expect(answer.status).toBe(502);
    expect(port.failures).toEqual([{ code: "ETIMEDOUT", afterHeaders: false }]);
  });

  it("ends the client's answer when the upstream's stops mid-body, instead of leaving it open", async () => {
    const upstream = await serve((req, res) => {
      req.resume();
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      setTimeout(() => req.socket.destroy(), 20);
    });
    const port = await relay(() => new URL(`http://127.0.0.1:${upstream}/x`));
    await expect(request(port.port, { body: "{}" })).rejects.toThrow();
    await sleep(20);
    expect(port.failures).toEqual([{ code: "EABORTED", afterHeaders: true }]);
  });

  it("aborts the upstream request when the client goes away", async () => {
    let closed = false;
    const upstream = await serve((req) => {
      req.resume();
      req.on("close", () => {
        closed = true;
      });
    });
    const port = await relay(() => new URL(`http://127.0.0.1:${upstream}/x`), {}, { direct: true });
    const socket = net.connect(port.port, "127.0.0.1");
    socket.write("POST /x HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 2\r\n\r\n{}");
    await sleep(50);
    socket.destroy();
    await sleep(50);
    expect(closed).toBe(true);
  });

  it("pipes the answer through, status and body, and says when it finished", async () => {
    const upstream = await serve((req, res) => {
      req.resume();
      res.writeHead(201, { "content-type": "application/json", connection: "close" });
      res.end('{"done":true}');
    });
    const port = await relay(() => new URL(`http://127.0.0.1:${upstream}/x`));
    const answer = await request(port.port, { body: "{}" });
    expect(answer).toMatchObject({ status: 201, body: '{"done":true}' });
    await sleep(10);
    expect(port.finished).toEqual([201]);
  });
});

describe("the passthrough", () => {
  const options = (anthropic: URL) => ({
    name: "acme",
    display: "Acme Models",
    claim: { ids: [], prefixes: ["big-"] },
    anthropic,
    env: {},
    state: "degraded after repeated crashes",
    idleMs: 1000,
    log: () => undefined,
  });

  async function passthroughServer(anthropic: URL): Promise<number> {
    return serve((req, res) => {
      void readBody(req).then((body) => {
        if (body !== "too-large") passThrough(options(anthropic), req, res, body);
      });
    });
  }

  it("pipes Claude's requests to Anthropic exactly: method, path, query, headers, body, status, stream", async () => {
    const seen: {
      method?: string | undefined;
      url?: string | undefined;
      headers: http.IncomingHttpHeaders;
      body: string;
    }[] = [];
    const anthropic = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        res.writeHead(207, { "content-type": "text/event-stream" });
        res.write("data: 1\n\n");
        setTimeout(() => res.end("data: 2\n\n"), 10);
      });
    });
    const port = await passthroughServer(new URL(`http://127.0.0.1:${anthropic}`));
    const body = JSON.stringify({ model: "claude-x", stream: true });
    const answer = await request(port, {
      method: "PUT",
      body,
      headers: {
        authorization: "Bearer caller",
        "x-api-key": "caller-key",
        "content-type": "application/json",
      },
    });
    expect(answer).toMatchObject({ status: 207, body: "data: 1\n\ndata: 2\n\n" });
    expect(seen).toEqual([
      {
        method: "PUT",
        url: "/v1/messages?beta=true",
        headers: expect.objectContaining({ authorization: "Bearer caller", "x-api-key": "caller-key" }),
        body,
      },
    ]);
  });

  it("treats a body that does not parse, or names no model, as Anthropic's", async () => {
    const anthropic = await serve((req, res) => {
      req.resume();
      req.on("end", () => res.end("anthropic"));
    });
    const port = await passthroughServer(new URL(`http://127.0.0.1:${anthropic}`));
    expect((await request(port, { body: "not json" })).body).toBe("anthropic");
    expect((await request(port, { body: "{}" })).body).toBe("anthropic");
  });

  it("answers a provider-model request 503 with what to run, and a bad path 400", async () => {
    const port = await passthroughServer(new URL("http://127.0.0.1:9"));
    const provider = await request(port, { body: '{"model":"big-9"}' });
    expect(provider.status).toBe(503);
    expect(JSON.parse(provider.body)).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: degradedMessage({
          name: "acme",
          display: "Acme Models",
          state: "degraded after repeated crashes",
        }),
      },
    });
    expect(degradedMessage({ name: "acme", display: "Acme Models", state: "x" })).toBe(
      "Acme Models router x; Claude models still work. Run /acme:setup.",
    );
    expect((await request(port, { path: "//evil/x", body: "{}" })).status).toBe(400);
  });

  it("answers a 502 when Anthropic cannot be reached", async () => {
    const gone = await serve(() => undefined);
    const port = await passthroughServer(new URL(`http://127.0.0.1:${gone}`));
    cleanups.splice(0, 1)[0]?.();
    await sleep(20);
    const answer = await request(port, { body: '{"model":"claude-x"}' });
    expect(answer.status).toBe(502);
  });
});
