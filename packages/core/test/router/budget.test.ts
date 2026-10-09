// Radar's budgets on a provider route: a stopped scope answers the provider's models with the refusal's
// non-retryable 400 and never touches claude-*; a status the router cannot trust stops nothing. And the health events
// a router appends for every refusal, rate limit and budget stop: what happened, never the key or a body.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BudgetStop } from "../../src/domain/budget.ts";
import type { RouterHealthEvent, SpoolEvent } from "../../src/domain/route-events.ts";
import { budgetStatusFile, budgetsFile, createBudgetGate } from "../../src/router/budget.ts";
import { createRouter } from "../../src/router/router.ts";
import { closeServer, freePort, listen } from "../support/net.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";

const statusOf = (stopped: readonly string[], updatedAt = Date.now()) =>
  JSON.stringify({ version: 1, updatedAt, stopped, spend: [] });

function radar() {
  const home = tempDir("core-budget-");
  const env = { HOME: join(home, "home"), RADAR_HOME: join(home, "radar") };
  mkdirSync(env.RADAR_HOME, { recursive: true });
  return env;
}

describe("createBudgetGate", () => {
  it("reads the status and the budgets beside the spool, and stops what the status stops", () => {
    const env = radar();
    const gate = createBudgetGate("zai", env, () => 1000, 5000);
    expect(gate()).toBeUndefined();
    const fresh = radar();
    writeFileSync(budgetStatusFile(fresh), statusOf(["provider:zai"]));
    writeFileSync(
      budgetsFile(fresh),
      JSON.stringify({
        version: 1,
        budgets: [{ id: "b", scope: "provider:zai", period: "week", limitUsd: 1, action: "stop" }],
      }),
    );
    expect(createBudgetGate("zai", fresh)()).toEqual({ scope: "provider:zai", period: "week" });
    expect(createBudgetGate("kimi", fresh)()).toBeUndefined();
  });

  it("holds one reading for five seconds, then reads again; a clock that steps back reads again too", () => {
    const env = radar();
    let now = 1_000_000;
    const gate = createBudgetGate("zai", env, () => now);
    writeFileSync(budgetStatusFile(env), statusOf(["provider:zai"], now));
    expect(gate()?.scope).toBe("provider:zai");
    writeFileSync(budgetStatusFile(env), statusOf([], now));
    now += 4999;
    expect(gate()?.scope).toBe("provider:zai");
    now += 1;
    expect(gate()).toBeUndefined();
    writeFileSync(budgetStatusFile(env), statusOf(["total"], now));
    now -= 60_000;
    expect(gate()?.scope).toBe("total");
  });

  it("never blocks or throws on what it finds there: a directory, a FIFO, a huge file, garbage, a stale status", () => {
    const env = radar();
    const file = budgetStatusFile(env);
    const gate = () => createBudgetGate("zai", env)();
    mkdirSync(file);
    expect(gate()).toBeUndefined();
    rmSync(file, { recursive: true });
    execFileSync("mkfifo", [file]);
    // Reading a FIFO with no writer would block forever; the gate looks before it reads.
    expect(gate()).toBeUndefined();
    rmSync(file);
    writeFileSync(file, `${statusOf(["provider:zai"]).slice(0, -1)}${" ".repeat(1024 * 1024)}}`);
    expect(gate()).toBeUndefined();
    writeFileSync(file, "{not json");
    expect(gate()).toBeUndefined();
    writeFileSync(file, statusOf(["provider:zai"], Date.now() - 11 * 60_000));
    expect(gate()).toBeUndefined();
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

function serve(server: http.Server, port = 0): Promise<number> {
  servers.push(server);
  return listen(server, "127.0.0.1", port);
}

async function answering() {
  const state = { status: 200, body: '{"ok":true}', requests: 0 };
  const port = await serve(
    http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        state.requests += 1;
        res.writeHead(state.status, { "content-type": "application/json" });
        res.end(state.body);
      });
    }),
  );
  return { state, url: new URL(`http://127.0.0.1:${port}`) };
}

const KEY = "sk-budget-test-key";

async function rig(options: { key?: string | undefined } = {}) {
  const provider = await answering();
  const anthropic = await answering();
  const events: SpoolEvent[] = [];
  const box: { stop: BudgetStop | undefined; keyReads: number } = { stop: undefined, keyReads: 0 };
  const port = await freePort();
  const key = "key" in options ? options.key : KEY;
  await serve(
    createRouter({
      provider: REFERENCE_PROVIDER,
      port,
      anthropic: anthropic.url,
      providerUrl: provider.url,
      key: async () => {
        box.keyReads += 1;
        return key;
      },
      log: () => undefined,
      events: (event) => events.push(event),
      budget: () => box.stop,
    }),
    port,
  );
  const post = async (model: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "secret prompt text" }] }),
    });
    return { status: res.status, retry: res.headers.get("x-should-retry"), body: await res.text() };
  };
  const health = (): RouterHealthEvent[] =>
    events.filter((event): event is RouterHealthEvent => "kind" in event && event.kind === "router.event");
  return { provider, anthropic, events, box, post, health };
}

describe("a stopped budget on the router", () => {
  it("answers the provider's models with a non-retryable 400 naming the dashboard, before reading the key", async () => {
    const r = await rig();
    r.box.stop = { scope: "provider:zai", period: "month" };
    const answer = await r.post("glm-5.3");
    expect(answer.status).toBe(400);
    expect(answer.retry).toBe("false");
    expect(JSON.parse(answer.body)).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Z.ai GLM budget reached for this month: raise or lift it in the Radar dashboard (/radar:open)",
      },
    });
    expect(r.provider.state.requests).toBe(0);
    expect(r.box.keyReads).toBe(0);
  });

  it("never touches claude-*: a stopped total still sends Anthropic's models through", async () => {
    const r = await rig();
    r.box.stop = { scope: "total", period: undefined };
    expect(await r.post("claude-sonnet-5-5")).toEqual({ status: 200, retry: null, body: '{"ok":true}' });
    expect(r.anthropic.state.requests).toBe(1);
    expect(r.health()).toEqual([]);
  });

  it("records one budget_stop when a scope turns the models off, a refusal per request, and again after a lift", async () => {
    const r = await rig();
    r.box.stop = { scope: "provider:zai", period: "day" };
    await r.post("glm-5.3");
    await r.post("glm-5.3-flash");
    r.box.stop = undefined;
    expect((await r.post("glm-5.3")).status).toBe(200);
    r.box.stop = { scope: "total", period: "week" };
    await r.post("glm-5.3");
    expect(r.health().map(({ event, reason, model }) => ({ event, reason, model }))).toEqual([
      { event: "budget_stop", reason: "provider:zai budget reached for this day", model: "glm-5.3" },
      { event: "refusal", reason: "budget: provider:zai", model: "glm-5.3" },
      { event: "refusal", reason: "budget: provider:zai", model: "glm-5.3-flash" },
      { event: "budget_stop", reason: "total budget reached for this week", model: "glm-5.3" },
      { event: "refusal", reason: "budget: total", model: "glm-5.3" },
    ]);
  });
});

describe("router health events", () => {
  it("records a refused key, an empty balance, a plain rate limit and a missing key; never the key or a body", async () => {
    const r = await rig();
    r.provider.state.status = 401;
    r.provider.state.body = JSON.stringify({ error: { message: `bad key ${KEY}` } });
    await r.post("glm-5.3");
    r.provider.state.status = 429;
    r.provider.state.body = JSON.stringify({
      error: { code: "1113", message: `Insufficient balance ${KEY}` },
    });
    await r.post("glm-5.3");
    r.provider.state.body = JSON.stringify({ error: { code: "1302", message: `rate limit ${KEY}` } });
    await r.post("glm-5.3-flash");
    r.provider.state.status = 500;
    await r.post("glm-5.3");
    const none = await rig({ key: undefined });
    await none.post("glm-5.3");

    const seen = [...r.health(), ...none.health()];
    expect(seen.map(({ event, reason, model }) => ({ event, reason, model }))).toEqual([
      { event: "refusal", reason: "key: HTTP 401", model: "glm-5.3" },
      { event: "refusal", reason: "balance: HTTP 429", model: "glm-5.3" },
      { event: "rate_limited", reason: "HTTP 429", model: "glm-5.3-flash" },
      { event: "refusal", reason: "key: no key is set", model: "glm-5.3" },
    ]);
    for (const event of seen) {
      expect(Object.keys(event).sort()).toEqual(["event", "kind", "model", "plugin", "reason", "ts"]);
      expect(event).toMatchObject({ kind: "router.event", plugin: "zai" });
      expect(Math.abs(event.ts - Date.now())).toBeLessThan(60_000);
    }
    const text = JSON.stringify([...r.events, ...none.events]);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("secret prompt text");
    expect(text).not.toContain("Insufficient");
  });

  it("writes nothing for claude-* errors: Anthropic's 429 is not this router's rate limit", async () => {
    const r = await rig();
    r.anthropic.state.status = 429;
    expect((await r.post("claude-haiku-4-5")).status).toBe(429);
    expect(r.health()).toEqual([]);
  });
});
