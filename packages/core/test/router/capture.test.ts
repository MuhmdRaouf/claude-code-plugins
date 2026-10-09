import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureEvent, RouteEvent, SpoolEvent } from "../../src/domain/route-events.ts";
import { createRouter, promptHashOf } from "../../src/router/router.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";

interface Seen {
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

/** A fake upstream that records what it got, answers with the headers it is told, and streams one event. */
async function upstream(seen: Seen[], headers: IncomingHttpHeaders = {}): Promise<URL> {
  const port = await listen(
    http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(200, { "content-type": "text/event-stream", ...headers });
        res.end('data: {"type":"message_start"}\n\n');
      });
    }),
  );
  return new URL(`http://127.0.0.1:${port}`);
}

/** A router pointed at one recording upstream on both routes, collecting its spool events. */
async function router(upstreamHeaders: IncomingHttpHeaders = {}) {
  const events: SpoolEvent[] = [];
  const seen: Seen[] = [];
  const target = await upstream(seen, upstreamHeaders);
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  servers.splice(servers.indexOf(probe), 1);
  const server = createRouter({
    provider: REFERENCE_PROVIDER,
    port,
    anthropic: target,
    providerUrl: target,
    key: async () => "k",
    log: () => undefined,
    events: (event) => events.push(event),
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const post = (body: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  return { post, events, seen, port };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

const TOOL = {
  name: "Bash",
  description: "Run a shell command",
  input_schema: { type: "object", properties: { command: { type: "string" } } },
};

const BODY = JSON.stringify({
  model: "glm-5.3",
  system: "you are a capture fixture",
  tools: [TOOL],
  messages: [],
});

describe("prompt capture", () => {
  it("captures a prompt once for two identical requests, both route events naming the same hash", async () => {
    const r = await router();
    await (await r.post(BODY)).text();
    await (await r.post(BODY)).text();
    await settle();

    const captures = r.events.filter((event): event is CaptureEvent => event.event === "capture");
    expect(captures).toHaveLength(1);
    expect(gunzipSync(Buffer.from(captures[0]?.gz ?? "", "base64")).toString("utf8")).toBe(
      JSON.stringify({ system: "you are a capture fixture", tools: [TOOL] }),
    );
    const routes = r.events.filter((event): event is RouteEvent => event.event === "route");
    expect(routes).toHaveLength(2);
    expect(routes[0]?.prompt_hash).toBe(captures[0]?.prompt_hash);
    expect(routes[1]?.prompt_hash).toBe(captures[0]?.prompt_hash);
    expect(routes[0]?.prompt_hash).toBe(promptHashOf(JSON.parse(BODY)));
  });

  it("captures a different prompt again, its own hash beside it", async () => {
    const r = await router();
    await (await r.post(BODY)).text();
    await (
      await r.post(JSON.stringify({ model: "glm-5.3", system: "another fixture", messages: [] }))
    ).text();
    await settle();

    const captures = r.events.filter((event): event is CaptureEvent => event.event === "capture");
    expect(captures).toHaveLength(2);
    expect(captures[0]?.prompt_hash).not.toBe(captures[1]?.prompt_hash);
  });

  it("forwards the client's bytes untouched while it captures", async () => {
    const r = await router();
    const res = await r.post(BODY);

    expect(res.status).toBe(200);
    expect(r.seen[0]?.body).toBe(BODY);
    await settle();
    // The capture read the body without reordering it: the hash still matches the client's own content.
    expect(r.events.some((event) => event.event === "capture")).toBe(true);
  });

  it("records only the allow-listed response headers, however many the upstream sent", async () => {
    const r = await router({
      "request-id": "req_01",
      "retry-after": "12",
      "anthropic-ratelimit-requests-remaining": "9",
      "x-ratelimit-limit-tokens": "1000",
      "set-cookie": ["sid=sekrit; HttpOnly"],
      authorization: "Bearer sekrit",
      "x-should-not-appear": "no",
    });
    await (await r.post(BODY)).text();
    await settle();

    const route = r.events.find((event): event is RouteEvent => event.event === "route");
    expect(route?.headers).toEqual({
      "request-id": "req_01",
      "retry-after": "12",
      "anthropic-ratelimit-requests-remaining": "9",
      "x-ratelimit-limit-tokens": "1000",
      "content-type": "text/event-stream",
    });
    expect(JSON.stringify(r.events)).not.toContain("sekrit");
    expect(JSON.stringify(r.events)).not.toContain("should-not-appear");
  });

  it("carries no hash and writes no capture for a request without system or tools", async () => {
    const r = await router();
    await (await r.post(JSON.stringify({ model: "glm-5.3", messages: [] }))).text();
    await settle();

    expect(r.events.some((event) => event.event === "capture")).toBe(false);
    const route = r.events.find((event): event is RouteEvent => event.event === "route");
    expect(route).not.toHaveProperty("prompt_hash");
    // The answer's headers still ride, but only the allow-listed ones (here, content-type alone).
    expect(route?.headers).toEqual({ "content-type": "text/event-stream" });
  });

  it("hashes the same content the same way whatever key order it arrived in", () => {
    const one = { system: "s", tools: [TOOL] };
    const flipped = {
      tools: [{ input_schema: TOOL.input_schema, description: TOOL.description, name: "Bash" }],
      system: "s",
    };
    expect(promptHashOf({ model: "glm-5.3", ...one })).toBe(promptHashOf({ model: "glm-5.3", ...flipped }));
    // A body with neither field hashes to nothing at all.
    expect(promptHashOf({ model: "glm-5.3" })).toBeUndefined();
    expect(promptHashOf(undefined)).toBeUndefined();
  });
});
