import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_ROUTERS, portOf } from "../../src/domain/plugin-routers.ts";
import { claims } from "../../src/domain/provider.ts";
import {
  createPeerLookup,
  entryClaim,
  liveRouters,
  type RegisteredRouter,
  readRegistry,
  removeRegistryEntry,
  routersHome,
  saveRegistryEntry,
} from "../../src/router/registry.ts";
import { tempDir } from "../support/tmp.ts";

const entry = (over: Partial<RegisteredRouter> = {}): RegisteredRouter => ({
  name: "kimi",
  port: 18788,
  modelPrefixes: ["kimi-"],
  catalogIds: ["kimi-k3", "kimi-k2.6"],
  updatedAt: "2026-10-07T00:00:00.000Z",
  ...over,
});

/** A registry home under a temp root, as every test env pins with PROVIDER_ROUTERS_HOME. */
const home = (): { root: string; env: Record<string, string | undefined> } => {
  const root = tempDir("core-registry-");
  return { root, env: { HOME: join(root, "home"), PROVIDER_ROUTERS_HOME: join(root, "routers") } };
};

describe("routersHome", () => {
  it("takes PROVIDER_ROUTERS_HOME over ~/.agents", () => {
    expect(routersHome({ PROVIDER_ROUTERS_HOME: "/pin", HOME: "/home" })).toBe("/pin");
    expect(routersHome({ HOME: "/home" })).toBe(join("/home", ".agents", "provider-routers"));
  });
});

describe("the registry files", () => {
  it("writes one file per plugin and reads them back sorted by name", async () => {
    const { env } = home();

    await saveRegistryEntry(env, entry({ name: "zai", port: 18787, catalogIds: ["glm-5.3"] }));
    await saveRegistryEntry(env, entry());

    expect(readRegistry(env).map((e) => e.name)).toEqual(["kimi", "zai"]);
    const kimi = readRegistry(env).find((e) => e.name === "kimi");
    expect(kimi).toMatchObject({
      name: "kimi",
      port: 18788,
      modelPrefixes: ["kimi-"],
      catalogIds: ["kimi-k3", "kimi-k2.6"],
    });
    expect(kimi).not.toHaveProperty("pid");
  });

  it("keeps the recorded pid when a new entry carries none (setup writes without one)", async () => {
    const { env } = home();
    await saveRegistryEntry(env, entry({ pid: 4242 }));

    await saveRegistryEntry(env, entry());

    expect(readRegistry(env).find((e) => e.name === "kimi")?.pid).toBe(4242);
    await saveRegistryEntry(env, entry({ pid: 99 }));
    expect(readRegistry(env).find((e) => e.name === "kimi")?.pid).toBe(99);
  });

  it("skips unreadable or malformed files, and an absent dir reads as empty", () => {
    const { root, env } = home();
    expect(readRegistry(env)).toEqual([]);

    const dir = routersHome(env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "garbage.json"), "{ not json");
    writeFileSync(join(dir, "half.json"), JSON.stringify({ name: "half", port: "nope" }));
    mkdirSync(join(dir, "nested.json")); // a directory ending in .json: unreadable, skipped too

    expect(readRegistry(env)).toEqual([]);
    expect(existsSync(join(root, "routers", "half.json"))).toBe(true);
  });

  it("removes one plugin's entry; a missing entry is fine", async () => {
    const { env } = home();
    await saveRegistryEntry(env, entry());

    removeRegistryEntry(env, "kimi");
    removeRegistryEntry(env, "kimi");

    expect(readRegistry(env)).toEqual([]);
  });
});

describe("entryClaim", () => {
  it("claims catalog ids and prefixed ids, never another plugin's", () => {
    const kimi = entry();
    expect(claims(entryClaim(kimi), "kimi-k3")).toBe(true);
    expect(claims(entryClaim(kimi), "kimi-future-9")).toBe(true);
    expect(claims(entryClaim(kimi), "glm-5.3")).toBe(false);
    expect(claims(entryClaim(kimi), "claude-sonnet-5-5")).toBe(false);
  });
});

describe("createPeerLookup", () => {
  it("finds the peer that serves a model, never itself", async () => {
    const { env } = home();
    await saveRegistryEntry(env, entry());

    const lookup = createPeerLookup(env, "zai");
    expect(lookup("kimi-k3")).toEqual({ name: "kimi", port: 18788 });
    expect(lookup("glm-5.3")).toBeUndefined();
    expect(lookup("claude-sonnet-5-5")).toBeUndefined();

    const selfLookup = createPeerLookup(env, "kimi");
    expect(selfLookup("kimi-k3")).toBeUndefined();
  });

  it("re-reads the registry at most every 5 s", async () => {
    vi.useFakeTimers();
    try {
      const { env } = home();
      await saveRegistryEntry(env, entry());
      const lookup = createPeerLookup(env, "zai");
      expect(lookup("kimi-k3")?.name).toBe("kimi");

      await saveRegistryEntry(env, entry({ name: "deepseek", port: 18789, modelPrefixes: ["deepseek-"] }));
      expect(lookup("deepseek-v4-pro")).toBeUndefined();

      vi.advanceTimersByTime(5000);
      expect(lookup("deepseek-v4-pro")).toEqual({ name: "deepseek", port: 18789 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("liveRouters", () => {
  it("keeps only the entries whose router answers, minus this plugin's own", async () => {
    const { env } = home();
    await saveRegistryEntry(env, entry({ name: "kimi", port: 18788 }));
    await saveRegistryEntry(env, entry({ name: "deepseek", port: 18789 }));
    await saveRegistryEntry(env, entry({ name: "zai", port: 18787 }));

    const living = await liveRouters(env, "zai", async (candidate) => candidate.port === 18789);

    expect(living.map((e) => e.name)).toEqual(["deepseek"]);
  });

  it("health-checks the entries itself: a router that is down is not live", async () => {
    const { env } = home();
    await saveRegistryEntry(env, entry({ port: 1 })); // nothing answers on loopback port 1

    expect(await liveRouters(env, "zai")).toEqual([]);
  });
});

describe("the port map", () => {
  it("knows every plugin's router port, and reads ports out of URLs", () => {
    expect(PLUGIN_ROUTERS.get(18787)).toBe("zai");
    expect(PLUGIN_ROUTERS.get(18791)).toBe("qwen");
    expect(PLUGIN_ROUTERS.size).toBe(5);
    expect(portOf("http://127.0.0.1:18788/health")).toBe(18788);
    expect(portOf("http://localhost/x")).toBe(-1);
    expect(portOf("not a url")).toBe(-1);
  });
});
