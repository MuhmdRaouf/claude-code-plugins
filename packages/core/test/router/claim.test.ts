// One answer to "is this our model?": the resolved provider's claim (env overrides included), shared by the worker's
// router, the front's and the emergency's passthrough, and the peer registry. An overridden id outside the usual
// prefix is the provider's everywhere; a foreign id is nobody's. The chaos suite proves the same on real processes.
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { claims, modelClaim, resolveProvider } from "../../src/domain/provider.ts";
import type { SpoolEvent } from "../../src/domain/route-events.ts";
import { startEmergency } from "../../src/router/emergency.ts";
import { passThrough } from "../../src/router/passthrough.ts";
import { registryEntryFor } from "../../src/router/process.ts";
import { createPeerLookup, entryClaim, saveRegistryEntry } from "../../src/router/registry.ts";
import { createRouter } from "../../src/router/router.ts";
import { readBody } from "../../src/router/upstream.ts";
import { closeServer, freePort, listen } from "../support/net.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";

/** zai with its main model overridden to an id no prefix of it covers. */
const OVERRIDE = "acme-coder-9";
const ENV = { ZAI_MODEL_MAIN: OVERRIDE };
const RESOLVED = resolveProvider(REFERENCE_PROVIDER, ENV);
const FOREIGN = "kimi-k3";

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

/** An upstream that answers with its own name. */
async function named(name: string): Promise<URL> {
  const port = await serve(
    http.createServer((req, res) => {
      req.resume();
      req.on("end", () => res.end(name));
    }),
  );
  return new URL(`http://127.0.0.1:${port}`);
}

const post = async (port: number, model: string): Promise<{ status: number; body: string }> => {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    body: JSON.stringify({ model, messages: [] }),
  });
  return { status: res.status, body: await res.text() };
};

describe("claims", () => {
  it("covers the resolved catalog ids and the prefixes, nothing else, and never the empty id", () => {
    const claim = modelClaim(RESOLVED);
    expect(claim).toEqual({ ids: [OVERRIDE, "glm-5.3-flash"], prefixes: ["glm-"] });
    expect(claims(claim, OVERRIDE)).toBe(true);
    expect(claims(claim, "glm-anything")).toBe(true);
    expect(claims(claim, FOREIGN)).toBe(false);
    expect(claims(claim, "claude-sonnet-5-5")).toBe(false);
    expect(claims(claim, "")).toBe(false);
    expect(claims(modelClaim(REFERENCE_PROVIDER), OVERRIDE)).toBe(false);
  });
});

describe("an overridden model id outside the prefix", () => {
  it("is sent to the provider by the worker's router, and a foreign id to Anthropic", async () => {
    const anthropic = await named("anthropic");
    const provider = await named("provider");
    const server = createRouter({
      provider: RESOLVED,
      port: 0,
      anthropic,
      providerUrl: provider,
      key: async () => "k",
      log: () => undefined,
    });
    const port = await serve(server);
    expect(await post(port, OVERRIDE)).toEqual({ status: 200, body: "provider" });
    expect(await post(port, FOREIGN)).toEqual({ status: 200, body: "anthropic" });
  });

  it("is refused by the front's passthrough, and a foreign id goes to Anthropic", async () => {
    const anthropic = await named("anthropic");
    const options = {
      name: RESOLVED.name,
      display: RESOLVED.display,
      claim: modelClaim(RESOLVED),
      anthropic,
      env: {},
      state: "degraded after repeated crashes",
    };
    const port = await serve(
      http.createServer((req, res) => {
        void readBody(req).then((body) => {
          if (body !== "too-large") passThrough(options, req, res, body);
        });
      }),
    );
    expect((await post(port, OVERRIDE)).status).toBe(503);
    expect(await post(port, FOREIGN)).toEqual({ status: 200, body: "anthropic" });
  });

  it("is refused by the emergency passthrough, and a foreign id goes to Anthropic", async () => {
    const anthropic = await named("anthropic");
    const port = await freePort();
    const events: SpoolEvent[] = [];
    servers.push(
      await startEmergency({
        name: RESOLVED.name,
        display: RESOLVED.display,
        healthPath: RESOLVED.router.healthPath,
        claim: modelClaim(RESOLVED),
        port,
        anthropic,
        env: {},
        token: "t",
        events: (event) => events.push(event),
      }),
    );
    expect((await post(port, OVERRIDE)).status).toBe(503);
    expect(await post(port, FOREIGN)).toEqual({ status: 200, body: "anthropic" });
    // Every request the emergency passthrough serves is a fallback Radar hears about.
    expect(events.map(({ ts: _ts, ...rest }) => rest)).toEqual(
      [OVERRIDE, FOREIGN].map((model) => ({
        kind: "router.event",
        plugin: "zai",
        event: "fallback",
        reason: "emergency passthrough",
        model,
      })),
    );
  });

  it("is announced in the registry, so a peer forwards it here and not a foreign id", async () => {
    const env = { PROVIDER_ROUTERS_HOME: tempDir("claim-"), ...ENV };
    const entry = registryEntryFor(REFERENCE_PROVIDER, env);
    expect(claims(entryClaim(entry), OVERRIDE)).toBe(true);
    await saveRegistryEntry(env, entry);
    const lookup = createPeerLookup(env, "kimi");
    expect(lookup(OVERRIDE)).toEqual({ name: "zai", port: entry.port });
    expect(lookup(FOREIGN)).toBeUndefined();
  });
});
