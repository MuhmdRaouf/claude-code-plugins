import http, { type IncomingHttpHeaders } from "node:http";
import net, { type AddressInfo } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { isLoopback } from "../../src/domain/plugin-routers.ts";
import { claims, modelClaim } from "../../src/domain/provider.ts";
import type { RouteEvent, SpoolEvent } from "../../src/domain/route-events.ts";
import type { PeerTarget } from "../../src/router/registry.ts";
import {
  createRouter,
  PEER_HOP,
  REQUEST_ID,
  stripRejected,
  upstreamErrorReason,
  upstreamHeaders,
  usageTracker,
} from "../../src/router/router.ts";
import { requestModel, TOKEN_HEADER } from "../../src/router/upstream.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";

interface Seen {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const servers: http.Server[] = [];
afterEach(async () => {
  // The router keeps upstream sockets alive for reuse, so a fake upstream is closed with its connections.
  await Promise.all(
    servers.splice(0).map((s) => {
      const closed = new Promise((r) => s.close(r));
      s.closeAllConnections();
      return closed;
    }),
  );
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake upstream that records what it got and answers with its name, streamed in two chunks. */
async function upstream(name: string, path: string, seen: Seen[]): Promise<URL> {
  const port = await listen(
    http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${name}-1\n\n`);
        setTimeout(() => res.end(`data: ${name}-2\n\n`), 20);
      });
    }),
  );
  return new URL(`http://127.0.0.1:${port}${path}`);
}

async function router(
  key: string | undefined,
  dead?: URL,
  extra: {
    peers?: (model: string) => PeerTarget | undefined;
    events?: SpoolEvent[];
    token?: string;
    /** A key lookup of one's own: used where the lookup's timing is the point. */
    lookup?: () => Promise<string | undefined>;
  } = {},
) {
  const anthropicSeen: Seen[] = [];
  const providerSeen: Seen[] = [];
  const logs: string[] = [];
  const anthropic = dead ?? (await upstream("anthropic", "", anthropicSeen));
  const providerUrl = dead ?? (await upstream("provider", "/api/anthropic", providerSeen));
  // The router must know its own port for the Host check, so reserve one first.
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  servers.splice(servers.indexOf(probe), 1);
  const server = createRouter({
    provider: REFERENCE_PROVIDER,
    port,
    anthropic,
    providerUrl,
    key: extra.lookup ?? (async () => key),
    log: (l) => logs.push(l),
    ...(extra.peers === undefined ? {} : { peers: extra.peers }),
    ...(extra.events === undefined ? {} : { events: (event: SpoolEvent) => extra.events?.push(event) }),
    ...(extra.token === undefined ? {} : { token: extra.token }),
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const post = (model: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer anthropic-oauth", ...headers },
      body: JSON.stringify({ model, messages: [] }),
    });
  return { port, post, anthropicSeen, providerSeen, logs };
}

describe("routing", () => {
  /** A raw provider-bound POST whose body arrives exactly as built, so untouched bytes are assertable. */
  const postBody = (port: number, body: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
      body,
    });

  it("sends the provider's own models to it with its key in place of the caller's credentials", async () => {
    const r = await router("provider-secret");
    const res = await r.post("glm-5.3-flash", { "x-api-key": "anthropic-key" });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: provider-1\n\ndata: provider-2\n\n");
    expect(r.anthropicSeen).toEqual([]);
    const [got] = r.providerSeen;
    expect(got?.path).toBe("/api/anthropic/v1/messages?beta=true");
    expect(got?.headers.authorization).toBe("Bearer provider-secret");
    expect(got?.headers["x-api-key"]).toBeUndefined();
    expect(JSON.parse(got?.body ?? "").model).toBe("glm-5.3-flash");
  });

  it("sends every other model to Anthropic with the caller's headers untouched", async () => {
    const r = await router("provider-secret");
    const res = await r.post("claude-opus-5-5", { "anthropic-beta": "x" });

    expect(await res.text()).toBe("data: anthropic-1\n\ndata: anthropic-2\n\n");
    expect(r.providerSeen).toEqual([]);
    const [got] = r.anthropicSeen;
    expect(got?.path).toBe("/v1/messages?beta=true");
    expect(got?.headers.authorization).toBe("Bearer anthropic-oauth");
    expect(got?.headers["anthropic-beta"]).toBe("x");
  });

  it("claims an exact catalog id even without a matching prefix, so a renamed model still routes", () => {
    const provider = {
      ...REFERENCE_PROVIDER,
      catalog: {
        ...REFERENCE_PROVIDER.catalog,
        main: { tier: "main" as const, id: "totally-unprefixed", label: "Unprefixed" },
      },
    };
    expect(claims(modelClaim(provider), "totally-unprefixed")).toBe(true);
    expect(claims(modelClaim(provider), "glm-5.3")).toBe(true);
    expect(claims(modelClaim(provider), "claude-haiku-4-5")).toBe(false);
  });

  it("answers the provider's model without a key with a non-retryable 400 naming setup, never a 401", async () => {
    const r = await router(undefined);
    const glm = await r.post("glm-5.3");

    expect(glm.status).toBe(400);
    expect(glm.headers.get("x-should-retry")).toBe("false");
    expect(await glm.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Z.ai GLM key refused or missing: run /zai:setup (no key is set). Claude models are not affected.",
      },
    });
    expect((await r.post("claude-sonnet-5-5")).status).toBe(200);
    expect(r.providerSeen).toEqual([]);
  });

  it("refuses a request whose Host is not this machine's router", async () => {
    const r = await router("k");
    const res = await new Promise<number>((resolve) => {
      http
        .request(
          {
            host: "127.0.0.1",
            port: r.port,
            path: "/v1/messages",
            method: "POST",
            headers: { host: "evil.example" },
          },
          (a) => resolve(a.statusCode ?? 0),
        )
        .end("{}");
    });

    expect(res).toBe(421);
    expect(r.anthropicSeen).toEqual([]);
  });

  it("serves its health check and logs one line per request without credentials", async () => {
    const r = await router("provider-secret");
    expect((await fetch(`http://127.0.0.1:${r.port}${REFERENCE_PROVIDER.router.healthPath}`)).status).toBe(
      200,
    );
    await (await r.post("glm-5.3")).text();

    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toMatch(/POST \/api\/anthropic\/v1\/messages model=glm-5.3 → provider 200/);
    expect(r.logs.join()).not.toMatch(/secret|oauth/);
  });

  it("answers an Anthropic-style 502 when the upstream is unreachable", async () => {
    const gone = http.createServer();
    const port = await listen(gone);
    await new Promise((r) => gone.close(r));
    servers.splice(servers.indexOf(gone), 1);
    const r = await router("k", new URL(`http://127.0.0.1:${port}`));
    const res = await r.post("claude-opus-5-5");

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("api_error");
    expect(r.logs[0]).toMatch(/→ anthropic error ECONNREFUSED/);
  });

  it("records the connection failure's errno as the route event's reason", async () => {
    const gone = http.createServer();
    const port = await listen(gone);
    await new Promise((r) => gone.close(r));
    servers.splice(servers.indexOf(gone), 1);
    const events: SpoolEvent[] = [];
    const r = await router("k", new URL(`http://127.0.0.1:${port}`), { events });
    const res = await r.post("claude-opus-5-5");

    expect(res.status).toBe(502);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "route",
      route: "anthropic",
      status: 502,
      error: "connection failed (ECONNREFUSED)",
    });
  });

  it("records why it refused a second peer hop on that route event too", async () => {
    const peerUrl = await upstream("kimi", "", []);
    const events: SpoolEvent[] = [];
    const peers = (model: string): PeerTarget | undefined =>
      model.startsWith("kimi-") ? { name: "kimi", port: Number(peerUrl.port) } : undefined;
    const r = await router("k", undefined, { peers, events });
    const res = await r.post("kimi-k3", { [PEER_HOP]: "1" });

    expect(res.status).toBe(508);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events[0]).toMatchObject({
      event: "route",
      route: "refused",
      status: 508,
      error: "refusing to forward a request twice",
    });
  });

  it("refuses an http upstream that is not loopback, on either route", async () => {
    const r = await router("k", new URL("http://10.9.8.7:1"));
    const anthropic = await r.post("claude-opus-5-5");
    const provider = await r.post("glm-5.3");

    expect(anthropic.status).toBe(502);
    expect(provider.status).toBe(502);
    expect(((await anthropic.json()) as { error: { message: string } }).error.message).toContain(
      "must be https unless it is loopback (10.9.8.7:1)",
    );
    expect(r.logs.filter((l) => l.includes("refused"))).toHaveLength(2);
  });

  it("strips the provider's rejected fields from provider-bound bodies only, wherever they sit", async () => {
    const anthropicSeen: Seen[] = [];
    const providerSeen: Seen[] = [];
    const logs: string[] = [];
    const anthropic = await upstream("anthropic", "", anthropicSeen);
    const providerUrl = await upstream("provider", "/api/anthropic", providerSeen);
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    servers.splice(servers.indexOf(probe), 1);
    const stripping = { ...REFERENCE_PROVIDER, strip: ["cache_control"] };
    const server = createRouter({
      provider: stripping,
      port,
      anthropic,
      providerUrl,
      key: async () => "k",
      log: (l) => logs.push(l),
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    const body = JSON.stringify({
      model: "glm-5.3",
      metadata: { cache_control: { type: "ephemeral" } },
      messages: [
        { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "ho", cache_control: { type: "ephemeral" } }] },
      ],
    });

    await (
      await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body,
      })
    ).text();
    await (
      await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify({ ...JSON.parse(body), model: "claude-opus-5-5" }),
      })
    ).text();

    expect(JSON.parse(providerSeen[0]?.body ?? "")).toEqual({
      model: "glm-5.3",
      metadata: {},
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "ho" }] },
      ],
    });
    // Anthropic-bound: forwarded unchanged, cache_control and all.
    expect(JSON.parse(anthropicSeen[0]?.body ?? "").messages[0].content[0].cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("clamps max_tokens above the model's cap and forwards anything else as the request carried it", async () => {
    const r = await router("provider-secret");
    await postBody(r.port, JSON.stringify({ model: "glm-5.3-flash", max_tokens: 131073, messages: [] }));
    const below = JSON.stringify({ model: "glm-5.3-flash", max_tokens: 1024, messages: [] });
    await postBody(r.port, below);
    const missing = JSON.stringify({ model: "glm-5.3-flash", messages: [] });
    await postBody(r.port, missing);
    // A model the catalog names only by prefix declares no cap, so its max_tokens stays as it came.
    const prefixed = JSON.stringify({ model: "glm-9.9-preview", max_tokens: 999999, messages: [] });
    await postBody(r.port, prefixed);

    expect(JSON.parse(r.providerSeen[0]?.body ?? "").max_tokens).toBe(131072);
    // Below the cap, without max_tokens, and without a declared cap: the caller's bytes, not a re-serialisation.
    expect(r.providerSeen[1]?.body).toBe(below);
    expect(r.providerSeen[2]?.body).toBe(missing);
    expect(r.providerSeen[3]?.body).toBe(prefixed);
  });

  it("serves a web_search tool with the provider's web search model, whatever model was asked", async () => {
    const r = await router("provider-secret");
    const tool = [{ type: "web_search_20250305", name: "web_search" }];
    await postBody(r.port, JSON.stringify({ model: "glm-5.3-flash", messages: [], tools: tool }));
    const serving = JSON.stringify({ model: "glm-5.3", messages: [], tools: tool });
    await postBody(r.port, serving);
    const without = JSON.stringify({ model: "glm-5.3-flash", messages: [] });
    await postBody(r.port, without);
    await postBody(
      r.port,
      JSON.stringify({ model: "glm-5.3-flash", messages: [], tools: [{ name: "Bash" }] }),
    );

    expect(JSON.parse(r.providerSeen[0]?.body ?? "").model).toBe("glm-5.3");
    expect(r.logs.filter((l) => l.includes("web_search tool served by glm-5.3"))).toHaveLength(1);
    // The model that serves the tool, a request without any tool, and a regular tool all go where they were asked.
    expect(r.providerSeen[1]?.body).toBe(serving);
    expect(r.providerSeen[2]?.body).toBe(without);
    expect(JSON.parse(r.providerSeen[3]?.body ?? "").model).toBe("glm-5.3-flash");
  });

  it("forwards Claude traffic byte for byte, a web_search tool and an oversized max_tokens included", async () => {
    const r = await router("provider-secret");
    const body = JSON.stringify({
      model: "claude-opus-5-5",
      max_tokens: 999999,
      messages: [],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });
    const res = await postBody(r.port, body);

    expect(res.status).toBe(200);
    expect(r.providerSeen).toEqual([]);
    expect(r.anthropicSeen[0]?.body).toBe(body);
    expect(r.logs.join("\n")).not.toContain("web_search");
  });
});

describe("helpers", () => {
  it("reads the model from a JSON body and treats anything else as no model", () => {
    expect(requestModel(Buffer.from('{"model":"glm-5.3"}'))).toBe("glm-5.3");
    expect(requestModel(Buffer.from("not json"))).toBe("");
    expect(requestModel(Buffer.from('{"model":5}'))).toBe("");
  });

  it("drops hop-by-hop headers and sets host and length for the upstream", () => {
    const out = upstreamHeaders(
      { connection: "keep-alive", "transfer-encoding": "chunked", host: "127.0.0.1:1", accept: "x" },
      new URL("https://api.z.ai/api/anthropic"),
      7,
    );
    expect(out).toEqual({ accept: "x", host: "api.z.ai", "content-length": "7" });
  });

  it("strips rejected fields recursively and keeps bytes without them as they were", () => {
    const body = Buffer.from(
      '{"context_management":true,"messages":[{"cache_control":{},"role":"user"},{"cache_control":{},"role":"assistant"}],"nested":{"cache_control":{}}}',
    );
    expect(JSON.parse(stripRejected(body, ["cache_control", "context_management"]).toString())).toEqual({
      messages: [{ role: "user" }, { role: "assistant" }],
      nested: {},
    });
    // A provider that rejects nothing, a body without the field, and a non-JSON body all pass through unchanged.
    expect(stripRejected(body, [])).toBe(body);
    expect(stripRejected(Buffer.from('{"model":"glm-5.3"}'), ["cache_control"]).toString()).toBe(
      '{"model":"glm-5.3"}',
    );
    expect(stripRejected(Buffer.from("not json"), ["cache_control"]).toString()).toBe("not json");
  });

  it("knows the loopback hosts an http upstream may be", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.9.9.9")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("10.0.0.1")).toBe(false);
    expect(isLoopback("api.z.ai")).toBe(false);
  });

  it("parses usage out of a JSON body's top level, out of SSE split across chunks, and out of nothing", () => {
    const json = usageTracker("application/json");
    json.push(Buffer.from('{"usage":{"input_tok'));
    json.push(Buffer.from('ens":5},"rest":"sekrit"}'));
    expect(json.usage()).toEqual({ input_tokens: 5 });

    const sse = usageTracker("text/event-stream; charset=utf-8");
    sse.push(Buffer.from('data: {"type":"message_start","message":{"usage":{"input'));
    sse.push(Buffer.from('_tokens":2}}}\n\ndata: {"type":"message_delta","usage":{"out'));
    sse.push(Buffer.from('put_tokens":9}}\n\n'));
    expect(sse.usage()).toEqual({ input_tokens: 2, output_tokens: 9 });

    expect(usageTracker(undefined).usage()).toBeUndefined();
    expect(usageTracker("text/plain").usage()).toBeUndefined();

    const broken = usageTracker("application/json");
    broken.push(Buffer.from("not json"));
    expect(broken.usage()).toBeUndefined();

    const noisy = usageTracker("text/event-stream");
    noisy.push(Buffer.from("data: oops\n: keepalive\ndata: 7\n\n"));
    expect(noisy.usage()).toBeUndefined();
  });

  it("reads a provider error's reason: the known shapes, one line, capped, credentials redacted", () => {
    expect(
      upstreamErrorReason(
        Buffer.from('{"error":{"type":"invalid_request_error","message":"messages: field required"}}'),
      ),
    ).toBe("invalid_request_error: messages: field required");
    expect(upstreamErrorReason(Buffer.from('{"error":{"code":"1210","message":"API key not valid"}}'))).toBe(
      "1210: API key not valid",
    );
    expect(upstreamErrorReason(Buffer.from('{"code":"1302","msg":"conversation does not exist"}'))).toBe(
      "1302: conversation does not exist",
    );
    // Anything else — not JSON, or JSON without a known shape — is the text itself; newlines and runs of
    // whitespace collapse into one line.
    expect(upstreamErrorReason(Buffer.from("<html>\n  Bad\trequest  </html>"))).toBe(
      "<html> Bad request </html>",
    );
    expect(upstreamErrorReason(Buffer.from('{"nothing":"here"}'))).toBe('{"nothing":"here"}');
    // A credential-shaped run never survives, however the message spells it.
    expect(
      upstreamErrorReason(Buffer.from(`{"code":"407","msg":"key ${"a".repeat(32)} quota exhausted"}`)),
    ).toBe("407: key … quota exhausted");
    expect(upstreamErrorReason(Buffer.from(`{"error":{"type":"e","message":"${"x".repeat(400)}"}}`))).toBe(
      "e: …",
    );
    // The route's own key is redacted even when it is too short to look like a token.
    expect(
      upstreamErrorReason(Buffer.from('{"code":"1","msg":"bad key short-key-123"}'), "short-key-123"),
    ).toBe("1: bad key …");
    // At most 300 characters are kept (of the first 2048 bytes read).
    const long = `{"error":{"type":"e","message":"${"abcdef ".repeat(60)}trailing"}}`;
    expect(upstreamErrorReason(Buffer.from(long))).toBe(`e: ${"abcdef ".repeat(60)}trailing`.slice(0, 300));
    expect(upstreamErrorReason(Buffer.from(""))).toBeUndefined();
  });
});

describe("peer forwarding", () => {
  const kimiPeer =
    (port: number) =>
    (model: string): PeerTarget | undefined =>
      model.startsWith("kimi-") ? { name: "kimi", port } : undefined;

  it("sends another plugin's models to its router unchanged, stamped with the hop header", async () => {
    const peerSeen: Seen[] = [];
    const peerUrl = await upstream("kimi", "", peerSeen);
    const r = await router("provider-secret", undefined, { peers: kimiPeer(Number(peerUrl.port)) });
    const res = await r.post("kimi-k3", { "anthropic-beta": "x" });

    expect(await res.text()).toBe("data: kimi-1\n\ndata: kimi-2\n\n");
    expect(r.providerSeen).toEqual([]);
    expect(r.anthropicSeen).toEqual([]);
    const [got] = peerSeen;
    expect(got?.path).toBe("/v1/messages?beta=true");
    expect(got?.headers.authorization).toBe("Bearer anthropic-oauth");
    expect(got?.headers[PEER_HOP]).toBe("1");
    expect(JSON.parse(got?.body ?? "").model).toBe("kimi-k3");
  });

  it("serves its own provider's model when another plugin's router forwarded it, without the hop header", async () => {
    const r = await router("k");
    const res = await r.post("glm-5.3", { [PEER_HOP]: "1" });

    expect(res.status).toBe(200);
    await res.text();
    expect(r.providerSeen).toHaveLength(1);
    expect(r.providerSeen[0]?.headers[PEER_HOP]).toBeUndefined();
    expect(r.providerSeen[0]?.headers.authorization).toBe("Bearer k");
  });

  it.each([
    ["another plugin's", "kimi-k3"],
    ["an Anthropic", "claude-sonnet-5-5"],
  ])("refuses to forward a request twice: %s model that already hopped gets a 508", async (_, model) => {
    const peerSeen: Seen[] = [];
    const peerUrl = await upstream("kimi", "", peerSeen);
    const r = await router("k", undefined, { peers: kimiPeer(Number(peerUrl.port)) });
    const res = await r.post(model, { [PEER_HOP]: "1" });

    expect(res.status).toBe(508);
    expect(r.providerSeen).toEqual([]);
    expect(r.anthropicSeen).toEqual([]);
    expect(peerSeen).toEqual([]);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("forward");
  });

  it("answers an Anthropic-style 502 naming the plugin and its setup when the peer is down", async () => {
    const gone = http.createServer();
    const deadPeerPort = await listen(gone);
    await new Promise((r) => gone.close(r));
    servers.splice(servers.indexOf(gone), 1);
    const r = await router("k", undefined, { peers: kimiPeer(deadPeerPort) });
    const res = await r.post("kimi-k3");

    expect(res.status).toBe(502);
    const { error } = (await res.json()) as { error: { type: string; message: string } };
    expect(error.type).toBe("api_error");
    expect(error.message).toContain("kimi plugin's router is down");
    expect(error.message).toContain("/kimi:setup");
  });

  it("still sends claude-* models to Anthropic when a peer is configured", async () => {
    const peerSeen: Seen[] = [];
    const peerUrl = await upstream("kimi", "", peerSeen);
    const r = await router("k", undefined, { peers: kimiPeer(Number(peerUrl.port)) });

    await (await r.post("claude-sonnet-5-5")).text();

    expect(peerSeen).toEqual([]);
    expect(r.anthropicSeen).toHaveLength(1);
  });
});

/** An upstream whose answers carry usage: JSON at the top level, the same JSON gzipped, or SSE in message_start and
 *  message_delta. */
async function usageUpstream(kind: "sse" | "json" | "gzip", seen: Seen[]): Promise<URL> {
  const port = await listen(
    http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
        if (kind === "json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4 } }));
          return;
        }
        if (kind === "gzip") {
          res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
          res.end(gzipSync(Buffer.from(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4 } }))));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10 } } })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "sekrit answer" } })}\n\n`,
        );
        res.end(
          `data: ${JSON.stringify({ type: "message_delta", delta: { stop: "end" }, usage: { output_tokens: 7 } })}\n\n`,
        );
      });
    }),
  );
  return new URL(`http://127.0.0.1:${port}`);
}

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

/** A router pointed at the usage upstream, recording its route events. */
async function usageRouter(kind: "sse" | "json" | "gzip") {
  const events: SpoolEvent[] = [];
  const anthropicSeen: Seen[] = [];
  const providerSeen: Seen[] = [];
  const anthropic = await usageUpstream(kind, anthropicSeen);
  const providerUrl = await usageUpstream(kind, providerSeen);
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  servers.splice(servers.indexOf(probe), 1);
  const server = createRouter({
    provider: REFERENCE_PROVIDER,
    port,
    anthropic,
    providerUrl,
    key: async () => "k",
    log: () => undefined,
    events: (event) => events.push(event),
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const post = (model: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer anthropic-oauth", ...headers },
      body: JSON.stringify({ model, messages: [] }),
    });
  return { post, events, anthropicSeen, providerSeen, port, anthropic };
}

describe("route events", () => {
  it("records an SSE answer's usage from message_start and the final message_delta, and the session id", async () => {
    const r = await usageRouter("sse");
    await (await r.post("claude-sonnet-5-5", { "x-claude-code-session-id": "sess-1" })).text();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.events).toHaveLength(1);
    const event = r.events[0] as RouteEvent;
    expect(event).toMatchObject({
      event: "route",
      plugin: "zai",
      model: "claude-sonnet-5-5",
      route: "anthropic",
      status: 200,
      session_id: "sess-1",
      usage: { input_tokens: 10, output_tokens: 7 },
    });
    expect(event.upstream).toBe(r.anthropic.host);
    expect(event.latency_ms).toBeGreaterThanOrEqual(0);
    // Metadata only: the answer's text never reaches the spool.
    expect(JSON.stringify(r.events)).not.toContain("sekrit");
  });

  it("records a JSON answer's top-level usage, and nothing else of the body", async () => {
    const r = await usageRouter("json");
    await (await r.post("glm-5.3")).text();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const event = r.events[0] as RouteEvent;
    expect(event).toMatchObject({
      event: "route",
      plugin: "zai",
      model: "glm-5.3",
      route: "provider",
      status: 200,
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    expect(event).not.toHaveProperty("session_id");
  });

  it("records a gzipped JSON answer's usage, and the client still gets the identical gzip bytes", async () => {
    const r = await usageRouter("gzip");
    const answer = await postRaw(r.port, "glm-5.3");
    expect(answer.status).toBe(200);
    expect(answer.encoding).toBe("gzip");
    expect(gunzipSync(answer.body).toString()).toBe('{"usage":{"input_tokens":3,"output_tokens":4}}');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.events[0]).toMatchObject({
      event: "route",
      plugin: "zai",
      model: "glm-5.3",
      route: "provider",
      status: 200,
      usage: { input_tokens: 3, output_tokens: 4 },
    });
  });

  it("answers a JSON answer over the usage cap whole, and its route event carries no usage", async () => {
    const body = JSON.stringify({
      usage: { input_tokens: 3, output_tokens: 4 },
      pad: "x".repeat(128 * 1024),
    });
    const r = await answeringRouter(200, body);
    const res = await r.post("glm-5.3");

    // The answer is not held back or cut: the client reads every byte of it.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ event: "route", route: "provider", status: 200 });
    expect(r.events[0]).not.toHaveProperty("usage");
  });

  it("records a subagent's agent and parent-agent ids beside the session id, and none for a bare request", async () => {
    const r = await usageRouter("json");
    await (
      await r.post("glm-5.3", {
        "x-claude-code-session-id": "sess-7",
        "x-claude-code-agent-id": "agent-9",
        "x-claude-code-parent-agent-id": "agent-2",
      })
    ).text();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.events[0]).toMatchObject({
      session_id: "sess-7",
      agent_id: "agent-9",
      parent_agent_id: "agent-2",
    });

    const bare = await usageRouter("sse");
    await (await bare.post("claude-sonnet-5-5", { "x-claude-code-session-id": "sess-1" })).text();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const event = bare.events[0] as RouteEvent;
    expect(event.session_id).toBe("sess-1");
    expect(event).not.toHaveProperty("agent_id");
    expect(event).not.toHaveProperty("parent_agent_id");
    // No other header ever reaches the spool.
    expect(JSON.stringify(bare.events)).not.toContain("authorization");
  });

  it("records a 502 for an unreachable upstream, and no usage when the answer carries none", async () => {
    const events: SpoolEvent[] = [];
    const gone = http.createServer();
    const deadPort = await listen(gone);
    await new Promise((r) => gone.close(r));
    servers.splice(servers.indexOf(gone), 1);
    const dead = new URL(`http://127.0.0.1:${deadPort}`);
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    servers.splice(servers.indexOf(probe), 1);
    const server = createRouter({
      provider: REFERENCE_PROVIDER,
      port,
      anthropic: dead,
      providerUrl: dead,
      key: async () => "k",
      log: () => undefined,
      events: (event) => events.push(event),
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5" }),
    });

    expect(res.status).toBe(502);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "route", route: "anthropic", status: 502 });
    expect(events[0]).not.toHaveProperty("usage");
  });
});

/** An upstream that answers every request with one fixed answer, recording what it got. */
async function fixedUpstream(status: number, contentType: string, body: string, seen: Seen[]): Promise<URL> {
  const port = await listen(
    http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(status, { "content-type": contentType });
        res.end(body);
      });
    }),
  );
  return new URL(`http://127.0.0.1:${port}`);
}

/** A router whose provider (or Anthropic) side answers every request with one fixed answer, recording its route
 *  events and its log lines. */
async function answeringRouter(
  status: number,
  body: string,
  {
    target = "provider",
    contentType = "application/json",
  }: { target?: "provider" | "anthropic"; contentType?: string } = {},
) {
  const events: SpoolEvent[] = [];
  const logs: string[] = [];
  const seen: Seen[] = [];
  const fixed = await fixedUpstream(status, contentType, body, seen);
  const anthropic = target === "anthropic" ? fixed : await upstream("anthropic", "", []);
  const providerUrl = target === "provider" ? fixed : await upstream("provider", "/api/anthropic", []);
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  servers.splice(servers.indexOf(probe), 1);
  const server = createRouter({
    provider: REFERENCE_PROVIDER,
    port,
    anthropic,
    providerUrl,
    key: async () => "provider-secret",
    log: (line) => logs.push(line),
    events: (event) => events.push(event),
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const post = (model: string) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [] }),
    });
  return { post, events, logs };
}

describe("why a provider request failed", () => {
  const token = "sk-zai-9f2c88d4a1b34e6f8d7c5b3a2e1f0d9c8b7a6f5e";

  it("records a Z.ai-shaped 400's reason on the route event and the log line, credentials redacted", async () => {
    const body = JSON.stringify({
      error: { code: "1210", message: `API key not valid: ${token}\n regenerate  it in the dashboard` },
    });
    const r = await answeringRouter(400, body);
    const res = await r.post("glm-5.3");

    // Not a refusal, and the key is not quoted: the answer goes through exactly as it came.
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(body);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      event: "route",
      route: "provider",
      status: 400,
      error: "1210: API key not valid: … regenerate it in the dashboard",
    });
    expect(r.logs).toEqual([
      expect.stringMatching(
        /^POST \/v1\/messages model=glm-5\.3 → provider 400 \(1210: API key not valid: … regenerate it in the dashboard\)$/,
      ),
    ]);
    // Neither the spool nor the log ever carries the token.
    expect(JSON.stringify(r.events)).not.toContain(token);
    expect(r.logs.join()).not.toContain(token);
  });

  it("records nothing new for a claude-* 400: the event carries no error and the log line stays plain", async () => {
    const body = JSON.stringify({
      error: { type: "invalid_request_error", message: `messages: field required near ${token}` },
    });
    const r = await answeringRouter(400, body, { target: "anthropic" });
    const res = await r.post("claude-opus-5-5");

    expect(res.status).toBe(400);
    expect(await res.text()).toBe(body);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.events[0]).toMatchObject({ event: "route", route: "anthropic", status: 400 });
    expect(r.events[0]).not.toHaveProperty("error");
    expect(r.logs).toEqual([expect.stringMatching(/→ anthropic 400$/)]);
  });

  it("leaves a 200 stream untouched byte for byte, with no error on its event or its log line", async () => {
    const payload = 'data: {"type":"message_start"}\n\ndata: {"type":"message_delta"}\n\n';
    const r = await answeringRouter(200, payload, { contentType: "text/event-stream" });
    const res = await r.post("glm-5.3");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(payload);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.events[0]).toMatchObject({ event: "route", route: "provider", status: 200 });
    expect(r.events[0]).not.toHaveProperty("error");
    expect(r.logs).toEqual([expect.stringMatching(/→ provider 200$/)]);
  });
});

/** An SSE upstream that answers every request with exactly these bytes, optionally split mid-first-line. */
async function sseUpstream(payload: string, seen: Seen[], splitAt?: number): Promise<URL> {
  const port = await listen(
    http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (splitAt === undefined) {
          res.end(payload);
          return;
        }
        res.write(payload.slice(0, splitAt));
        setTimeout(() => res.end(payload.slice(splitAt)), 5);
      });
    }),
  );
  return new URL(`http://127.0.0.1:${port}`);
}

describe("prompt usage", () => {
  /** The stream a Z.ai-shaped upstream sends: the prompt only in message_start, the real numbers in message_delta. */
  const stream = (start: Record<string, unknown>): string =>
    [
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: start } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } })}\n\n`,
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { input_tokens: 153, output_tokens: 30, cache_read_input_tokens: 0 },
      })}\n\n`,
    ].join("");

  /** A router whose upstreams answer every request with exactly `payload`, recording its route events. */
  async function promptRouter(payload: string, splitAt?: number) {
    const events: SpoolEvent[] = [];
    const anthropicSeen: Seen[] = [];
    const providerSeen: Seen[] = [];
    const anthropic = await sseUpstream(payload, anthropicSeen);
    const providerUrl = await sseUpstream(payload, providerSeen, splitAt);
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    servers.splice(servers.indexOf(probe), 1);
    const server = createRouter({
      provider: REFERENCE_PROVIDER,
      port,
      anthropic,
      providerUrl,
      key: async () => "k",
      log: () => undefined,
      events: (event) => events.push(event),
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    const post = (body: string) =>
      fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer anthropic-oauth" },
        body,
      });
    return { post, events };
  }

  /** The first `data:` line of an SSE answer, parsed. */
  const firstEvent = (text: string): { message: { usage: Record<string, number> } } =>
    JSON.parse((text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5));

  it("rewrites a provider stream's zero message_start usage to the conversation's estimated prompt", async () => {
    const payload = stream({ input_tokens: 0, output_tokens: 0 });
    // The message_start's JSON straddles two chunks: the rewriter holds until the line is whole.
    const r = await promptRouter(payload, payload.indexOf("input_tokens"));
    const body = JSON.stringify({
      model: "glm-5.3",
      system: "you are a prompt-usage fixture",
      messages: [{ role: "user", content: "first turn" }],
    });
    const text = await (await r.post(body)).text();

    const start = firstEvent(text).message.usage;
    expect(start.input_tokens).toBe(Math.round(body.length / 4));
    expect(start.cache_read_input_tokens).toBe(0);
    expect(start.cache_creation_input_tokens).toBe(0);
    // The later events stay the provider's own bytes: the real numbers still close the stream.
    expect(text.split("\n").find((l) => l.includes("message_delta"))).toBe(
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":153,"output_tokens":30,"cache_read_input_tokens":0}}',
    );
  });

  it("estimates the next turn of a conversation from what its last turn really cost", async () => {
    const r = await promptRouter(stream({ input_tokens: 0, output_tokens: 0 }));
    const first = JSON.stringify({
      model: "glm-5.3",
      system: "you are a prompt-usage fixture two",
      messages: [{ role: "user", content: "first turn" }],
    });
    await (await r.post(first)).text();
    const followUp = JSON.stringify({
      model: "glm-5.3",
      system: "you are a prompt-usage fixture two",
      messages: [
        { role: "user", content: "first turn" },
        { role: "assistant", content: "done" },
      ],
    });
    const text = await (await r.post(followUp)).text();

    // The first turn really cost 153 prompt tokens (its final message_delta), and the body grew by its tail.
    expect(firstEvent(text).message.usage.input_tokens).toBe(
      Math.round(153 + (followUp.length - first.length) / 4),
    );
    expect(firstEvent(text).message.usage.cache_read_input_tokens).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Usage tracking saw the raw stream, so the route events keep the provider's exact numbers.
    expect(r.events.at(-1)).toMatchObject({
      route: "provider",
      usage: { input_tokens: 153, output_tokens: 30, cache_read_input_tokens: 0 },
    });
  });

  it("leaves a claude-* stream byte for byte as the upstream sent it", async () => {
    const start = { input_tokens: 0, output_tokens: 0 };
    const r = await promptRouter(stream(start));
    const body = JSON.stringify({ model: "claude-sonnet-5-5", messages: [] });

    expect(await (await r.post(body)).text()).toBe(stream(start));
    expect(r.events.at(-1)).toMatchObject({ route: "anthropic" });
  });

  it("leaves a message_start that already carries a real prompt size exactly as it came", async () => {
    const start = { input_tokens: 152000, cache_read_input_tokens: 9000, output_tokens: 1 };
    const r = await promptRouter(stream(start));
    const body = JSON.stringify({ model: "glm-5.3", messages: [] });

    expect(await (await r.post(body)).text()).toBe(stream(start));
  });
});

describe("the worker's hardening", () => {
  async function bare(options: Partial<Parameters<typeof createRouter>[0]>) {
    const anthropicSeen: Seen[] = [];
    const anthropic = await upstream("anthropic", "", anthropicSeen);
    const server = createRouter({
      provider: REFERENCE_PROVIDER,
      port: 0,
      anthropic,
      providerUrl: anthropic,
      key: async () => "k",
      log: () => undefined,
      ...options,
    });
    const port = await listen(server);
    const post = (body: string, path = "/v1/messages", headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body, headers });
    return { post, anthropicSeen, server };
  }

  it("answers a provider request 503 when the key lookup hangs, and claude-* never waits for it", async () => {
    const r = await bare({ key: () => new Promise(() => undefined), keyTimeoutMs: 50 });
    const started = Date.now();
    expect((await r.post('{"model":"claude-x"}')).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(50);
    const glm = await r.post('{"model":"glm-5.3"}');
    expect(glm.status).toBe(503);
    expect(((await glm.json()) as { error: { message: string } }).error.message).toContain("timed out");
  });

  it("treats a key lookup that throws as no key", async () => {
    const r = await bare({ key: () => Promise.reject(new Error("keychain locked")) });
    const glm = await r.post('{"model":"glm-5.3"}');
    expect(glm.status).toBe(400);
    expect(((await glm.json()) as { error: { message: string } }).error.message).toContain("run /zai:setup");
  });

  it("refuses a body over the limit with an Anthropic-shaped 413, and a path that would change the host", async () => {
    const r = await bare({ bodyLimit: 16 });
    const big = await r.post(JSON.stringify({ model: "claude-x", pad: "x".repeat(64) }));
    expect(big.status).toBe(413);
    expect((await r.post('{"model":"claude-x"}', "//evil.example/x")).status).toBe(400);
    expect(r.anthropicSeen).toEqual([]);
  });

  it("tells the front (when it asked) just before a request goes upstream, and drops the front's request id", async () => {
    const acked: string[] = [];
    const r = await bare({ onUpstream: (req) => acked.push(String(req.headers[REQUEST_ID])) });
    const port = (r.server.address() as AddressInfo).port;
    const answer = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      body: '{"model":"claude-x"}',
      headers: { [REQUEST_ID]: "r1" },
    });
    await answer.text();
    expect(acked).toEqual(["r1"]);
    expect(r.anthropicSeen[0]?.headers[REQUEST_ID]).toBeUndefined();
  });

  it("answers its health with its name, so nothing else's 200 passes for it", async () => {
    const r = await bare({});
    const port = (r.server.address() as AddressInfo).port;
    expect(
      await (await fetch(`http://127.0.0.1:${port}${REFERENCE_PROVIDER.router.healthPath}`)).json(),
    ).toEqual({
      ok: true,
      name: "zai",
      provider: "Z.ai GLM",
    });
  });

  it("refuses the data path without the front's token, and strips the token before anything goes upstream", async () => {
    const r = await bare({ token: "hop-secret" });

    const refused = await r.post('{"model":"glm-5.3"}');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      type: "error",
      error: { type: "permission_error", message: "zai router: data path refused" },
    });
    const wrong = await r.post('{"model":"glm-5.3"}', "/v1/messages", { [TOKEN_HEADER]: "nope" });
    expect(wrong.status).toBe(403);
    expect(r.anthropicSeen).toEqual([]);

    // Health stays open, and a request that carries the token is forwarded — the token itself never is.
    const port = (r.server.address() as AddressInfo).port;
    expect((await fetch(`http://127.0.0.1:${port}${REFERENCE_PROVIDER.router.healthPath}`)).status).toBe(200);
    const allowed = await r.post('{"model":"claude-x"}', "/v1/messages", { [TOKEN_HEADER]: "hop-secret" });
    expect(allowed.status).toBe(200);
    expect(r.anthropicSeen[0]?.headers[TOKEN_HEADER]).toBeUndefined();
  });

  it("does not forward a request whose client left while the key was being read", async () => {
    const r = await bare({ key: () => new Promise((resolve) => setTimeout(() => resolve("k"), 200)) });
    const port = (r.server.address() as AddressInfo).port;
    const socket = net.connect(port, "127.0.0.1");
    socket.write(
      `POST /v1/messages HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\ncontent-length: 19\r\n\r\n{"model":"glm-5.3"}`,
    );
    await sleep(50);
    socket.destroy();
    // The key arrives long after the client left: nothing goes upstream for the dead request.
    await sleep(250);
    expect(r.anthropicSeen).toEqual([]);
  });
});
