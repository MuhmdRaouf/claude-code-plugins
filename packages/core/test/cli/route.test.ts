import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { claudeSettingsPath } from "../../src/adapters/claude-settings.ts";
import { EXIT } from "../../src/cli/exit.ts";
import {
  agentText as agentsLine,
  applyAgentModels,
  applyRouting,
  baseUrlReport,
  clearSetupDone,
  readSetupDone,
  recordSetupDone,
  removeRouting,
  routerUp,
  routingHook,
  type SetupDeps,
} from "../../src/cli/route.ts";
import { runCli } from "../../src/cli/run.ts";
import { err, ok, type Result } from "../../src/domain/result.ts";
import { stateLayout } from "../../src/domain/state-layout.ts";
import type { WorkerError } from "../../src/ports/index.ts";
import type { ProviderKey } from "../../src/ports/keys.ts";
import { readLedger } from "../../src/router/ledger.ts";
import { saveRegistryEntry } from "../../src/router/registry.ts";
import { fakeDeps, RecordingOutput } from "../support/fakes.ts";
import { closeServer, listen } from "../support/net.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";

const ROUTED_ENV = { ANTHROPIC_BASE_URL: "http://127.0.0.1:18787" };

/** An agent file as the plugin ships it: sonnet until setup rewrites the line. */
const agentMd = (name: string): string =>
  `---\nname: ${name}\nmodel: sonnet\n---\n\nYou are a ${name} worker.\n`;

function shippedAgents(root: string): void {
  const dir = join(root, "plugin", "agents");
  mkdirSync(dir, { recursive: true });
  for (const name of ["glm-5.3", "glm-5.3-flash"]) writeFileSync(join(dir, `${name}.md`), agentMd(name));
}

function agentText(root: string, name: string): string {
  return readFileSync(join(root, "plugin", "agents", `${name}.md`), "utf8");
}

/** The setup wiring's slice, over recorded stubs, the shipped agents and a sandboxed HOME in a temp root. */
class Harness {
  readonly out = new RecordingOutput();
  keyResult: Result<ProviderKey, WorkerError> = ok({ value: "test-key", source: "ZAI_API_KEY" });
  routerResult: Result<string, string> = ok("running on http://127.0.0.1:18787 (pid 4242)");
  routerKeyResult: Result<string, string> = ok("ZAI_API_KEY");
  stopped: Result<string, string> = ok("stopped (was not running)");
  keyCalls = 0;
  ensureCalls = 0;
  stopCalls = 0;
  constructor(
    readonly root: string,
    readonly env: Readonly<Record<string, string | undefined>> = {},
  ) {
    shippedAgents(root);
  }
  get fullEnv(): Readonly<Record<string, string | undefined>> {
    return { HOME: join(this.root, "home"), PROVIDER_ROUTERS_HOME: join(this.root, "routers"), ...this.env };
  }
  get deps(): SetupDeps {
    return {
      provider: REFERENCE_PROVIDER,
      env: this.fullEnv,
      stateRoot: this.root,
      bundlePath: join(this.root, "plugin", "dist", "zai.js"),
      out: this.out,
      settingsPath: claudeSettingsPath(this.fullEnv),
      loadKey: async () => {
        this.keyCalls += 1;
        return this.keyResult;
      },
      ensureRouter: async () => {
        this.ensureCalls += 1;
        return this.routerResult;
      },
      stopRouter: async () => {
        this.stopCalls += 1;
        return this.stopped;
      },
      routerKey: async () => this.routerKeyResult,
    };
  }
}

/** A loopback server that answers one plugin router's health path the way a router does. */
async function healthyServer(healthPath: string): Promise<number> {
  const name = healthPath.split("/")[1]?.replace(/-router$/, "");
  const server: Server = createServer((request, response) => {
    response.statusCode = request.url === healthPath ? 200 : 404;
    const provider = name === "zai" ? "Z.ai GLM" : name;
    response.end(request.url === healthPath ? JSON.stringify({ ok: true, name, provider }) : "");
  });
  const port = await listen(server);
  onTestFinished(() => closeServer(server));
  return port;
}

const settingsOf = (h: Harness): Record<string, unknown> =>
  JSON.parse(readFileSync(claudeSettingsPath(h.fullEnv), "utf8")) as Record<string, unknown>;

describe("the setupDone record", () => {
  it("round-trips, and clearing removes it", () => {
    const root = tempDir("core-route-");
    expect(readSetupDone(root)).toBe(false);
    recordSetupDone(root);
    expect(readSetupDone(root)).toBe(true);
    clearSetupDone(root);
    expect(readSetupDone(root)).toBe(false);
  });

  it("reads a legacy route file: provider counts, sonnet and garbage do not", () => {
    const root = tempDir("core-route-");
    writeFileSync(join(root, "route"), "sonnet\n");
    expect(readSetupDone(root)).toBe(false);
    writeFileSync(join(root, "route"), "provider-ish\n");
    expect(readSetupDone(root)).toBe(false);
    writeFileSync(join(root, "route"), "provider\n");
    expect(readSetupDone(root)).toBe(true);
  });

  it("recording replaces the legacy file with the mark", () => {
    const root = tempDir("core-route-");
    writeFileSync(join(root, "route"), "provider\n");

    recordSetupDone(root);

    expect(readSetupDone(root)).toBe(true);
    expect(rmSync(join(root, "route"), { force: true }));
    expect(readSetupDone(root)).toBe(true);
    expect(stateLayout(root).setupDone).toBe(join(root, "setup-done"));
  });
});

describe("applyAgentModels", () => {
  it("rewrites both agents' model lines to the provider's catalog ids", () => {
    const h = new Harness(tempDir("core-route-"));

    expect(
      applyAgentModels(join(h.root, "plugin", "dist", "zai.js"), REFERENCE_PROVIDER, "provider", {}),
    ).toEqual(
      ok([
        { tier: "main", agent: "glm-5.3", model: "glm-5.3", changed: true },
        { tier: "flash", agent: "glm-5.3-flash", model: "glm-5.3-flash", changed: true },
      ]),
    );
    expect(agentText(h.root, "glm-5.3")).toContain("model: glm-5.3");
    expect(agentText(h.root, "glm-5.3-flash")).toContain("model: glm-5.3-flash");
  });

  it("honours the model env overrides, per tier", () => {
    const h = new Harness(tempDir("core-route-"));

    applyAgentModels(join(h.root, "plugin", "dist", "zai.js"), REFERENCE_PROVIDER, "provider", {
      ZAI_MODEL_MAIN: "glm-5.5",
      ZAI_MODEL_FLASH: "glm-5.5-flash",
    });

    expect(agentText(h.root, "glm-5.3")).toContain("model: glm-5.5");
    expect(agentText(h.root, "glm-5.3-flash")).toContain("model: glm-5.5-flash");
  });

  it("sonnet restores the shipped default on both agents", () => {
    const h = new Harness(tempDir("core-route-"));
    applyAgentModels(join(h.root, "plugin", "dist", "zai.js"), REFERENCE_PROVIDER, "provider", {});

    applyAgentModels(join(h.root, "plugin", "dist", "zai.js"), REFERENCE_PROVIDER, "sonnet", {});

    expect(agentText(h.root, "glm-5.3")).toContain("model: sonnet");
    expect(agentText(h.root, "glm-5.3-flash")).toContain("model: sonnet");
  });

  it("names a missing agent file", () => {
    const h = new Harness(tempDir("core-route-"));
    rmSync(join(h.root, "plugin", "agents", "glm-5.3-flash.md"));

    expect(
      applyAgentModels(join(h.root, "plugin", "dist", "zai.js"), REFERENCE_PROVIDER, "provider", {}),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("glm-5.3-flash.md: not found"),
    });
  });

  it("names an agent without a model line", () => {
    const h = new Harness(tempDir("core-route-"));
    writeFileSync(join(h.root, "plugin", "agents", "glm-5.3.md"), "---\nname: glm-5.3\n---\nno model\n");

    expect(
      applyAgentModels(join(h.root, "plugin", "dist", "zai.js"), REFERENCE_PROVIDER, "provider", {}),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("glm-5.3.md: no model: line"),
    });
  });

  it("leaves an agent that already has the wanted model alone (a read-only file survives)", () => {
    const h = new Harness(tempDir("core-route-"));
    for (const name of ["glm-5.3", "glm-5.3-flash"])
      chmodSync(join(h.root, "plugin", "agents", `${name}.md`), 0o444);

    expect(
      applyAgentModels(join(h.root, "plugin", "dist", "zai.js"), REFERENCE_PROVIDER, "sonnet", {}).ok,
    ).toBe(true);
  });
});

describe("the models report line", () => {
  it("names each model alone while the agent named after it runs it, else the agent and what it runs", () => {
    const shipped = { tier: "main", agent: "glm-5.3", model: "glm-5.3", changed: false } as const;
    const sonnet = { tier: "flash", agent: "glm-5.3-flash", model: "sonnet", changed: true } as const;

    expect(agentsLine(ok([shipped, { ...sonnet, model: "glm-5.3-flash" }]))).toBe("glm-5.3, glm-5.3-flash");
    expect(agentsLine(ok([{ ...shipped, model: "glm-5.5" }, sonnet]))).toBe(
      "glm-5.3 → glm-5.5, glm-5.3-flash → sonnet",
    );
    expect(agentsLine(err("glm-5.3.md: not found"))).toBe("FAILED: glm-5.3.md: not found");
  });
});

describe("baseUrlReport", () => {
  it("is ok when ANTHROPIC_BASE_URL points at this plugin's router", () => {
    const report = baseUrlReport(REFERENCE_PROVIDER, ROUTED_ENV);

    expect(report.ok).toBe(true);
    expect(report.text).toContain("zai router (http://127.0.0.1:18787)");
  });

  it("names the other plugin when it points at another router", () => {
    const report = baseUrlReport(REFERENCE_PROVIDER, { ANTHROPIC_BASE_URL: "http://127.0.0.1:18788" });

    expect(report.ok).toBe(false);
    expect(report.text).toContain("kimi plugin's router");
    expect(report.text).toContain("export ANTHROPIC_BASE_URL=http://127.0.0.1:18787");
  });

  it("says unset or elsewhere when it points nowhere known, and follows the router port override", () => {
    expect(baseUrlReport(REFERENCE_PROVIDER, {}).text).toContain("unset or elsewhere");
    expect(
      baseUrlReport(REFERENCE_PROVIDER, {
        ZAI_ROUTER_PORT: "19000",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:19000",
      }).ok,
    ).toBe(true);
  });
});

describe("applyRouting", () => {
  it("starts the router, announces it in the registry, merges settings and rewrites the agents", async () => {
    const h = new Harness(tempDir("core-route-"));

    const applied = await applyRouting(h.deps);

    expect(applied).toMatchObject({ router: { ok: true }, settings: { ok: true }, agents: { ok: true } });
    expect(h.ensureCalls).toBe(1);
    const registry = JSON.parse(readFileSync(join(h.root, "routers", "zai.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(registry).toMatchObject({ name: "zai", port: 18787, catalogIds: ["glm-5.3", "glm-5.3-flash"] });
    expect(settingsOf(h)).toEqual({
      modelPicker: {
        options: [
          { model: "glm-5.3", label: "GLM 5.3" },
          { model: "glm-5.3-flash", label: "GLM 5.3 Flash" },
        ],
      },
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18787" },
    });
    expect(agentText(h.root, "glm-5.3")).toContain("model: glm-5.3");
    expect(readSetupDone(h.root)).toBe(true);
  });

  it("still merges settings when the router cannot start, keeps the agents on Sonnet, and records nothing", async () => {
    const h = new Harness(tempDir("core-route-"));
    h.routerResult = err("spawn failed");

    const applied = await applyRouting(h.deps);

    expect(applied.router).toEqual({ ok: false, error: "spawn failed" });
    expect(applied.settings.ok).toBe(true);
    expect(agentText(h.root, "glm-5.3")).toContain("model: sonnet");
    expect(readSetupDone(h.root)).toBe(false);
    expect(existsSync(join(h.root, "routers", "zai.json"))).toBe(false);
  });
});

describe("removeRouting", () => {
  it("takes the plugin's own entries out, restores sonnet, stops the service and clears the record", async () => {
    const h = new Harness(tempDir("core-route-"), ROUTED_ENV);
    await applyRouting(h.deps);

    const removed = await removeRouting(h.deps);

    expect(removed.router).toEqual({ ok: true, value: "stopped (was not running)" });
    expect(h.stopCalls).toBe(1);
    expect(settingsOf(h)).toEqual({});
    expect(agentText(h.root, "glm-5.3")).toContain("model: sonnet");
    expect(readSetupDone(h.root)).toBe(false);
    expect(existsSync(join(h.root, "routers", "zai.json"))).toBe(false);
  });

  it("repoints ANTHROPIC_BASE_URL at the other live registered router when one answers", async () => {
    const port = await healthyServer("/kimi-router/health");
    const h = new Harness(tempDir("core-route-"), ROUTED_ENV);
    await saveRegistryEntry(h.fullEnv, {
      name: "kimi",
      port,
      modelPrefixes: ["kimi-"],
      catalogIds: ["kimi-k3"],
      updatedAt: new Date().toISOString(),
    });
    await applyRouting(h.deps);

    await removeRouting(h.deps);

    const settings = settingsOf(h);
    expect(settings).toMatchObject({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } });
    expect(settings.modelPicker).toBeUndefined();
  });

  it("puts settings.json back byte for byte: setup's ledger is undone, empty containers included", async () => {
    const h = new Harness(tempDir("core-route-"), ROUTED_ENV);
    const path = claudeSettingsPath(h.fullEnv);
    mkdirSync(join(path, ".."), { recursive: true });
    const before = '{\n  "enabledPlugins": { "zai-plugin-cc@muhmdraouf": true },\n  "theme": "dark"\n}\n';
    writeFileSync(path, before);
    await applyRouting(h.deps);
    expect(readFileSync(path, "utf8")).not.toBe(before);

    await removeRouting(h.deps);

    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("without a ledger (a setup from before it), takes the provider's entries out all the same", async () => {
    const h = new Harness(tempDir("core-route-"), ROUTED_ENV);
    await applyRouting(h.deps);
    rmSync(stateLayout(h.root).ledger);

    await removeRouting(h.deps);

    expect(settingsOf(h)).toEqual({ modelPicker: { options: [] } });
  });
});

describe("routingHook", () => {
  it("does nothing without the setupDone mark", async () => {
    const h = new Harness(tempDir("core-route-"));

    expect(await routingHook(h.deps)).toBe(EXIT.ok);
    expect(h.out.lines).toEqual([]);
    expect(h.keyCalls).toBe(0);
  });

  it("re-applies silently when nothing needs repairing", async () => {
    const h = new Harness(tempDir("core-route-"));
    await applyRouting(h.deps);
    h.out.lines.length = 0;

    expect(await routingHook(h.deps)).toBe(EXIT.ok);
    expect(h.out.lines).toEqual([]);
    expect(agentText(h.root, "glm-5.3")).toContain("model: glm-5.3");
  });

  it("repairs agents an update reset to sonnet, silently", async () => {
    const h = new Harness(tempDir("core-route-"));
    await applyRouting(h.deps);
    shippedAgents(h.root);
    h.out.lines.length = 0;

    expect(await routingHook(h.deps)).toBe(EXIT.ok);
    expect(agentText(h.root, "glm-5.3")).toContain("model: glm-5.3");
    expect(h.out.lines).toEqual([]);
  });

  it("falls back to sonnet and removes the base URL when the router cannot start", async () => {
    const h = new Harness(tempDir("core-route-"));
    await applyRouting(h.deps);
    h.routerResult = err("spawn failed");
    h.out.lines.length = 0;

    expect(await routingHook(h.deps)).toBe(EXIT.ok);
    expect(agentText(h.root, "glm-5.3")).toContain("model: sonnet");
    expect(settingsOf(h)).not.toHaveProperty("env.ANTHROPIC_BASE_URL");
    expect(h.out.lines).toEqual([
      '{"systemMessage":"zai: the zai router could not start, so the zai agents run on Sonnet this session. Run /zai:setup to see why."}',
    ]);
  });

  it("falls back to sonnet, saying there is no key, even with the router up", async () => {
    const h = new Harness(tempDir("core-route-"));
    await applyRouting(h.deps);
    h.keyResult = err({ kind: "no_key", message: "no Z.ai GLM key: export ZAI_API_KEY" });
    h.out.lines.length = 0;

    expect(await routingHook(h.deps)).toBe(EXIT.ok);
    expect(agentText(h.root, "glm-5.3")).toContain("model: sonnet");
    expect(h.out.lines).toEqual([
      '{"systemMessage":"zai: no Z.ai GLM key found, so the zai agents run on Sonnet. Run /zai:setup to enter it."}',
    ]);
  });

  it("keeps the base URL when another live router deserves it", async () => {
    const port = await healthyServer("/kimi-router/health");
    const h = new Harness(tempDir("core-route-"));
    await saveRegistryEntry(h.fullEnv, {
      name: "kimi",
      port,
      modelPrefixes: ["kimi-"],
      catalogIds: ["kimi-k3"],
      updatedAt: new Date().toISOString(),
    });
    await applyRouting(h.deps);
    h.routerResult = err("spawn failed");
    h.out.lines.length = 0;

    await routingHook(h.deps);

    expect(settingsOf(h)).toMatchObject({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } });
  });
});

describe("setup --hook through the CLI", () => {
  it("is the session-start re-apply; without the setupDone mark it stays silent", async () => {
    const fakes = fakeDeps();
    shippedAgents(fakes.root);

    expect(await runCli(["setup", "--hook"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.out.lines).toEqual([]);
  });

  it("never pings the provider: a session start spends no tokens", async () => {
    const fakes = fakeDeps();
    shippedAgents(fakes.root);
    recordSetupDone(fakes.root);

    expect(await runCli(["setup", "--hook"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.worker.specs).toEqual([]);
  });
});

describe("the ledger, the marker and the agents' gate", () => {
  it("records what setup changed in the ledger, and the installed marker in the plugin's own data dir", async () => {
    const data = join(tempDir("core-route-data-"), "zai-plugin-cc-muhmdraouf");
    const h = new Harness(tempDir("core-route-"), { CLAUDE_PLUGIN_DATA: data });

    await applyRouting(h.deps);

    const ledger = readLedger(stateLayout(h.root).ledger);
    expect(ledger).toMatchObject({
      plugin: "zai",
      routerUrl: "http://127.0.0.1:18787",
      settingsPath: claudeSettingsPath(h.fullEnv),
      settings: { baseUrlBefore: null, optionsAdded: ["glm-5.3", "glm-5.3-flash"], createdEnv: true },
      keystore: { created: false },
      marker: join(data, "installed"),
    });
    expect(existsSync(join(data, "installed"))).toBe(true);
  });

  it("writes no marker into another plugin's data dir", async () => {
    const data = join(tempDir("core-route-data-"), "huddle-muhmdraouf");
    const h = new Harness(tempDir("core-route-"), { CLAUDE_PLUGIN_DATA: data });
    await applyRouting(h.deps);
    expect(readLedger(stateLayout(h.root).ledger)?.marker).toBeUndefined();
    expect(existsSync(data)).toBe(false);
  });

  it("keeps the agents on Sonnet when the base URL is the user's own proxy", async () => {
    const h = new Harness(tempDir("core-route-"));
    mkdirSync(join(h.root, "home", ".claude"), { recursive: true });
    writeFileSync(
      claudeSettingsPath(h.fullEnv),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://proxy.example" } }),
    );

    const applied = await applyRouting(h.deps);

    expect(applied.settings).toMatchObject({
      ok: true,
      value: [expect.any(String), expect.any(String), expect.stringContaining("your own proxy")],
    });
    expect(agentText(h.root, "glm-5.3")).toContain("model: sonnet");
  });

  it("says the provider is not ready when the running router cannot read the key, and keeps the agents on Sonnet", async () => {
    const h = new Harness(tempDir("core-route-"));
    h.routerKeyResult = err("no_key");

    const applied = await applyRouting(h.deps);

    expect(applied.router).toEqual({
      ok: false,
      error: expect.stringContaining(
        "but it cannot read the Z.ai GLM key (no_key): Z.ai GLM models are not ready",
      ),
    });
    expect(agentText(h.root, "glm-5.3")).toContain("model: sonnet");
    // The router itself runs, so the hooks keep it alive: setup counts as done.
    expect(readSetupDone(h.root)).toBe(true);
  });

  it("re-applies setup, in one user message, once a plugin disabled and cleaned up is enabled again", async () => {
    const h = new Harness(tempDir("core-route-"));
    await applyRouting(h.deps);
    const ledger = readLedger(stateLayout(h.root).ledger);
    // What the router's cleanup leaves after a disable.
    clearSetupDone(h.root);
    rmSync(stateLayout(h.root).ledger);
    writeFileSync(stateLayout(h.root).disabledLedger, JSON.stringify(ledger));
    rmSync(claudeSettingsPath(h.fullEnv));
    h.out.lines.length = 0;

    expect(await routingHook(h.deps)).toBe(EXIT.ok);

    expect(h.out.lines).toEqual([
      '{"systemMessage":"zai: enabled again and set up again; restart Claude Code to route through the zai router."}',
    ]);
    expect(settingsOf(h)).toMatchObject({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18787" } });
    expect(readSetupDone(h.root)).toBe(true);
    expect(existsSync(stateLayout(h.root).disabledLedger)).toBe(false);
    expect(readLedger(stateLayout(h.root).ledger)).toBeDefined();
  });

  it("a missing key leaves the router and the base URL alone, and says so once", async () => {
    const h = new Harness(tempDir("core-route-"));
    await applyRouting(h.deps);
    h.keyResult = err({ kind: "no_key", message: "no key" });
    h.out.lines.length = 0;

    await routingHook(h.deps);
    await routingHook(h.deps);

    expect(settingsOf(h)).toMatchObject({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18787" } });
    expect(h.out.lines).toEqual([
      '{"systemMessage":"zai: no Z.ai GLM key found, so the zai agents run on Sonnet. Run /zai:setup to enter it."}',
    ]);
  });

  it("setup --remove takes the ledger away, so the router has nothing left to undo", async () => {
    const h = new Harness(tempDir("core-route-"));
    await applyRouting(h.deps);
    writeFileSync(stateLayout(h.root).disabledLedger, "{}");
    await removeRouting(h.deps);
    expect(existsSync(stateLayout(h.root).ledger)).toBe(false);
    expect(existsSync(stateLayout(h.root).disabledLedger)).toBe(false);
  });

  it("knows its own router's health from any other 200", async () => {
    const port = await healthyServer("/zai-router/health");
    expect(await routerUp(REFERENCE_PROVIDER, { ZAI_ROUTER_PORT: String(port) })).toBe(true);
    const other = await healthyServer("/kimi-router/health");
    expect(await routerUp(REFERENCE_PROVIDER, { ZAI_ROUTER_PORT: String(other) })).toBe(false);
  });
});
