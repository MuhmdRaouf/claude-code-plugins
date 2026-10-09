import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFsEngineConfig } from "../../src/adapters/fs-engine-config.ts";
import type { Deps } from "../../src/app/deps.ts";
import { findBinary } from "../../src/cli/commands/engine-setup.ts";
import { engineWorkers } from "../../src/cli/engine-wire.ts";
import { EXIT } from "../../src/cli/exit.ts";
import { agentsDir, recordSetupDone, removeRouting, setupDeps } from "../../src/cli/route.ts";
import { runCli } from "../../src/cli/run.ts";
import type { EngineTool } from "../../src/domain/engine.ts";
import type { Provider } from "../../src/domain/provider.ts";
import { err } from "../../src/domain/result.ts";
import { stateLayout } from "../../src/domain/state-layout.ts";
import { readLedger } from "../../src/router/ledger.ts";
import { type Fakes, fakeDeps } from "../support/fakes.ts";
import { ACME_PROVIDER, REFERENCE_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";

const FIXTURES = join(import.meta.dirname, "../fixtures/engines");
const PONG = JSON.stringify({ summary: "pong", findings: [], open_items: [] });

/** A tool on PATH as the user would have it: a script named after the tool that answers --version and otherwise runs
 *  the fake, logged in and set up to answer. Unconfigured, it answers --version and nothing else, the way a tool with no
 *  login or provider set up stops: a complaint on stderr and exit 1. */
function toolOnPath(dir: string, tool: EngineTool, configured = true): void {
  const unconfigured = `[ "$1" = "--version" ] && { echo "${tool} 1.0.0"; exit 0; }\necho "No API key found for any provider. Log in first." >&2\nexit 1`;
  const run: Record<EngineTool, string> = {
    omp: `export FAKE_OMP_FINAL_TEXT='${PONG}'\nexec "${join(FIXTURES, "fake-omp.ts")}" "$@"`,
    pi: `export FAKE_PI_FINAL_TEXT='${PONG}'\nexec "${join(FIXTURES, "fake-pi.ts")}" "$@"`,
    opencode: `[ "$1" = "--version" ] && { echo 1.18.34; exit 0; }\nexport FAKE_OPENCODE_FIXTURE="${join(FIXTURES, "opencode/happy.jsonl")}"\nexec "${join(FIXTURES, "fake-opencode.ts")}" "$@"`,
  };
  const file = join(dir, tool);
  writeFileSync(file, `#!/bin/sh\n${configured ? run[tool] : unconfigured}\n`);
  chmodSync(file, 0o755);
}

interface World {
  readonly fakes: Fakes;
  readonly deps: Deps;
  readonly bin: string;
}

/** The plain-setup fakes, plus real engine workers over the tools found on a PATH of our own. */
function world(
  provider: Provider = REFERENCE_PROVIDER,
  tools: readonly EngineTool[] = ["omp", "opencode", "pi"],
  unconfigured: readonly EngineTool[] = [],
): World {
  const bin = tempDir("engine-bin-");
  for (const tool of tools) toolOnPath(bin, tool, !unconfigured.includes(tool));
  // A temp HOME: nothing of the real user's tool setup is ever reached.
  const fakes = fakeDeps(
    undefined,
    { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: tempDir("engine-home-") },
    { provider },
  );
  const engines = engineWorkers({ provider, env: fakes.deps.env, stopGraceMs: 1_000 });
  for (const tool of ["omp", "opencode", "pi"] as const)
    writeFileSync(
      join(agentsDir(fakes.deps.bundlePath), `${tool}.md`),
      `---\nname: ${tool}\nmodel: sonnet\n---\nbody\n`,
    );
  return { fakes, deps: { ...fakes.deps, engines }, bin };
}

function agentModel(fakes: Fakes, tool: string): string | undefined {
  return /^model: (.*)$/m.exec(
    readFileSync(join(agentsDir(fakes.deps.bundlePath), `${tool}.md`), "utf8"),
  )?.[1];
}

function lastJson(fakes: Fakes): Record<string, unknown> {
  return JSON.parse(fakes.out.lines.at(-1) ?? "{}") as Record<string, unknown>;
}

/** The smoke line of a tool that answered: the model it says it ran on, when it names one, and its own numbers. */
function smokeLine(tool: EngineTool): RegExp {
  const on = tool === "opencode" ? "" : " on zai/glm-5\\.3";
  return new RegExp(`^ok: ${tool} answered${on} \\(${tool}'s own numbers: \\d+ turns?, \\$[\\d.]+\\)$`);
}

describe("setup --engine-check", () => {
  it.each(["omp", "opencode", "pi"] as const)(
    "%s: plain setup's report plus binary, version and a smoke run of the tool as it is; nothing enabled",
    async (tool) => {
      const { fakes, deps, bin } = world();

      expect(await runCli(["setup", "--engine-check", tool, "--json"], deps, "/repo")).toBe(EXIT.ok);
      const report = lastJson(fakes);
      expect(report).toMatchObject({
        ready: true,
        key: { ok: true, value: "ZAI_API_KEY" },
        router: { ok: true },
      });
      expect(report.engine).toEqual({
        engine: tool,
        ready: true,
        binary: { ok: true, value: join(bin, tool) },
        version: { ok: true, value: expect.any(String) },
        smoke: { ok: true, value: expect.stringMatching(smokeLine(tool)) },
        watcher: null,
        watchers: { provider: "GLM 5.3 (Z.ai GLM)", sonnet: "Claude Sonnet" },
      });
      // The check changes nothing about the engine.
      expect(existsSync(stateLayout(fakes.root).engines)).toBe(false);
      expect(agentModel(fakes, tool)).toBe("sonnet");
    },
    60_000,
  );

  it("prints plain setup's report, then the engine's lines and the current watcher", async () => {
    const { fakes, deps, bin } = world();
    createFsEngineConfig(fakes.root).write({
      engines: { omp: { watcher: "sonnet", version: "omp/18.6.1", path: "omp" } },
    });

    expect(await runCli(["setup", "--engine-check", "omp"], deps, "/repo")).toBe(EXIT.ok);
    const text = fakes.out.text;
    expect(text.startsWith("zai setup: ready.")).toBe(true);
    expect(text).toContain(
      ["zai setup: omp engine", `  binary:  ${join(bin, "omp")}`, "  version: omp/18.6.1"].join("\n"),
    );
    expect(text).toMatch(
      /\n {2}smoke: {3}ok: omp answered on zai\/glm-5\.3 \(omp's own numbers: \d+ turns?, \$[\d.]+\)\n/,
    );
    expect(text.endsWith("  watcher: Claude Sonnet (current)\nready")).toBe(true);
  }, 60_000);

  it.each(["omp", "opencode", "pi"] as const)(
    "%s not logged in or configured fails its smoke line, telling the user to set the tool up, exit 6",
    async (tool) => {
      const { fakes, deps } = world(REFERENCE_PROVIDER, ["omp", "opencode", "pi"], [tool]);

      expect(await runCli(["setup", "--engine-check", tool, "--json"], deps, "/repo")).toBe(EXIT.notReady);
      const report = lastJson(fakes) as {
        ready: boolean;
        engine: Record<string, { ok: boolean; error?: string }>;
      };
      expect(report.ready).toBe(false);
      expect(report.engine.binary?.ok).toBe(true);
      expect(report.engine.version?.ok).toBe(true);
      expect(report.engine.smoke).toEqual({
        ok: false,
        error: expect.stringMatching(
          new RegExp(`; run ${tool} once and log in / configure it; the plugin uses it as it is$`),
        ),
      });
      expect(existsSync(stateLayout(fakes.root).engines)).toBe(false);
    },
    60_000,
  );

  it("every provider checks every tool the same way: qwen-like providers included", async () => {
    const { fakes, deps } = world(ACME_PROVIDER);

    expect(await runCli(["setup", "--engine-check", "pi", "--json"], deps, "/repo")).toBe(EXIT.ok);
    expect(lastJson(fakes)).toMatchObject({ ready: true, engine: { smoke: { ok: true } } });
  }, 60_000);

  it("a tool missing from PATH fails its binary line and exits 6", async () => {
    const { fakes, deps } = world(REFERENCE_PROVIDER, []);
    const bare = { ...deps, env: { ...deps.env, PATH: tempDir("empty-path-") } };

    expect(await runCli(["setup", "--engine-check", "opencode", "--json"], bare, "/repo")).toBe(
      EXIT.notReady,
    );
    expect(lastJson(fakes)).toMatchObject({
      engine: {
        binary: { ok: false, error: "opencode is not on PATH" },
        version: { ok: false, error: "not run: no binary" },
        smoke: { ok: false, error: "not run: fix the lines above first" },
      },
    });
  });

  it("the smoke run needs nothing of the provider's, but the check is ready only once plain setup is", async () => {
    const { fakes, deps } = world();
    fakes.host.keyResult = err({ kind: "no_key", message: "no Z.ai key: export ZAI_API_KEY" });

    expect(await runCli(["setup", "--engine-check", "omp", "--json"], deps, "/repo")).toBe(EXIT.notReady);
    expect(lastJson(fakes)).toMatchObject({
      ready: false,
      key: { ok: false },
      engine: { ready: false, binary: { ok: true }, smoke: { ok: true } },
    });
  }, 60_000);

  it("an explicit binary path must be an executable file", () => {
    expect(findBinary("/nonexistent/omp", "")).toEqual({
      ok: false,
      error: "/nonexistent/omp is not an executable file",
    });
  });
});

describe("setup --engines", () => {
  it("reads what the setup menu asks from and changes nothing: setup not run, every tool found, none enabled", async () => {
    const { fakes, deps, bin } = world();

    expect(await runCli(["setup", "--engines", "--json"], deps, "/repo")).toBe(EXIT.ok);
    expect(lastJson(fakes)).toEqual({
      setup: false,
      engines: (["omp", "opencode", "pi"] as const).map((tool) => ({
        engine: tool,
        binary: { ok: true, value: join(bin, tool) },
        watcher: null,
      })),
    });
    expect(existsSync(stateLayout(fakes.root).engines)).toBe(false);
    expect(agentModel(fakes, "omp")).toBe("sonnet");
  });

  it("names the recorded watchers and a missing binary", async () => {
    const { fakes, deps, bin } = world(ACME_PROVIDER, ["omp"]);
    recordSetupDone(fakes.root);
    createFsEngineConfig(fakes.root).write({
      engines: { omp: { watcher: "provider", version: "1", path: "omp" } },
    });
    const missing = { PATH: bin };

    expect(
      await runCli(["setup", "--engines", "--json"], { ...deps, env: { ...deps.env, ...missing } }, "/repo"),
    ).toBe(EXIT.ok);
    expect(lastJson(fakes)).toEqual({
      setup: true,
      engines: [
        {
          engine: "omp",
          binary: { ok: true, value: join(bin, "omp") },
          watcher: "provider",
        },
        {
          engine: "opencode",
          binary: { ok: false, error: "opencode is not on PATH" },
          watcher: null,
        },
        {
          engine: "pi",
          binary: { ok: false, error: "pi is not on PATH" },
          watcher: null,
        },
      ],
    });

    expect(await runCli(["setup", "--engines"], { ...deps, env: { ...deps.env, ...missing } }, "/repo")).toBe(
      EXIT.ok,
    );
    expect(fakes.out.lines.at(-1)).toBe(
      [
        "acme setup: done",
        `  omp:      installed (${join(bin, "omp")}); enabled, watched by Big Model 9 (Acme Models)`,
        "  opencode: not found: opencode is not on PATH; not enabled",
        "  pi:       not found: pi is not on PATH; not enabled",
      ].join("\n"),
    );
  });

  it("prints that setup has not run yet", async () => {
    const { fakes, deps } = world();
    createFsEngineConfig(fakes.root).write({
      engines: { pi: { watcher: "sonnet", version: "1", path: "pi" } },
    });

    expect(await runCli(["setup", "--engines"], deps, "/repo")).toBe(EXIT.ok);
    const text = fakes.out.lines.at(-1) ?? "";
    expect(text.split("\n")[0]).toBe("zai setup: not run yet");
    expect(text).toContain("; enabled, watched by Claude Sonnet");
  });
});

describe("setup --engine-enable", () => {
  it("records the engine and its watcher and points the wrapper agent at the watcher's model; rerunning switches", async () => {
    const { fakes, deps, bin } = world();
    createFsEngineConfig(fakes.root).write({
      engines: { pi: { watcher: "sonnet", version: "1", path: "pi" } },
    });

    expect(await runCli(["setup", "--engine-enable", "omp", "--watcher", "provider"], deps, "/repo")).toBe(
      EXIT.ok,
    );
    expect(fakes.out.lines.at(-1)).toBe(
      "zai: omp enabled; zai:omp runs on glm-5.3 (watcher: GLM 5.3 (Z.ai GLM))",
    );
    expect(agentModel(fakes, "omp")).toBe("glm-5.3");
    expect(createFsEngineConfig(fakes.root).read().engines).toEqual({
      pi: { watcher: "sonnet", version: "1", path: "pi" },
      omp: { watcher: "provider", version: "omp/18.6.1", path: join(bin, "omp") },
    });

    expect(
      await runCli(["setup", "--engine-enable", "omp", "--watcher", "sonnet", "--json"], deps, "/repo"),
    ).toBe(EXIT.ok);
    expect(lastJson(fakes)).toEqual({
      engine: "omp",
      enabled: true,
      watcher: "sonnet",
      agent: "zai:omp",
      model: "sonnet",
    });
    expect(agentModel(fakes, "omp")).toBe("sonnet");
    expect(createFsEngineConfig(fakes.root).read().engines.omp?.watcher).toBe("sonnet");
    expect(createFsEngineConfig(fakes.root).read().engines.pi).toBeDefined();
  });

  it("refuses a tool that is not installed, writing nothing (exit 6)", async () => {
    const { fakes, deps } = world(ACME_PROVIDER, ["omp", "opencode"]);
    const bare = { ...deps, env: { ...deps.env, PATH: tempDir("empty-path-") } };

    expect(await runCli(["setup", "--engine-enable", "pi", "--watcher", "sonnet"], bare, "/repo")).toBe(
      EXIT.notReady,
    );
    expect(fakes.out.errors).toEqual(["acme: cannot enable pi: pi is not on PATH"]);
    expect(existsSync(stateLayout(fakes.root).engines)).toBe(false);
  });

  it.each([
    [["--engine-check", "cursor"], "--engine-check takes omp, opencode or pi"],
    [["--engine-enable", "cursor", "--watcher", "sonnet"], "--engine-enable takes omp, opencode or pi"],
    [["--engine-enable", "omp"], "--engine-enable needs --watcher provider or --watcher sonnet"],
    [
      ["--engine-enable", "omp", "--watcher", "opus"],
      "--engine-enable needs --watcher provider or --watcher sonnet",
    ],
    [["--watcher", "sonnet"], "--watcher goes with --engine-enable"],
    [["--engines", "--engine-check", "omp"], "--engines takes no other setup flag"],
    [["--engines", "--engine-enable", "omp", "--watcher", "sonnet"], "--engines takes no other setup flag"],
    [["--engines", "--watcher", "sonnet"], "--engines takes no other setup flag"],
  ])("setup %j is a usage error", async (args, message) => {
    const { fakes, deps } = world();

    expect(await runCli(["setup", ...args], deps, "/repo")).toBe(EXIT.usage);
    expect(fakes.out.errors[0]).toBe(`zai: ${message}`);
  });
});

describe("setup --remove undoes engine setup", () => {
  it("clears the enabled engines and puts the wrapper agent back on its model before setup", async () => {
    const { fakes, deps } = world();
    expect(await runCli(["setup"], deps, "/repo")).toBe(EXIT.ok);
    // The wrapper agent as an older install left it: not the shipped sonnet, so only the ledger can put it back.
    writeFileSync(
      join(agentsDir(fakes.deps.bundlePath), "omp.md"),
      "---\nname: omp\nmodel: haiku\n---\nbody\n",
    );

    expect(await runCli(["setup", "--engine-enable", "omp", "--watcher", "provider"], deps, "/repo")).toBe(
      EXIT.ok,
    );
    expect(agentModel(fakes, "omp")).toBe("glm-5.3");
    expect(readLedger(stateLayout(fakes.root).ledger)?.agents?.omp).toBe("haiku");
    expect(createFsEngineConfig(fakes.root).read().engines.omp).toBeDefined();

    const removed = await removeRouting(setupDeps(deps));

    expect(removed.agents.ok).toBe(true);
    expect(agentModel(fakes, "omp")).toBe("haiku");
    expect(createFsEngineConfig(fakes.root).read().engines).toEqual({});
  });
});

describe("setup --hook re-applies the watchers", () => {
  function hookWorld(mainModel: string): World {
    const w = world();
    writeFileSync(join(agentsDir(w.fakes.deps.bundlePath), "glm-5.3.md"), `model: ${mainModel}\n`);
    createFsEngineConfig(w.fakes.root).write({
      engines: {
        omp: { watcher: "provider", version: "1", path: "omp" },
        pi: { watcher: "sonnet", version: "1", path: "pi" },
      },
    });
    return w;
  }

  it("a plugin update reset the agent files: the provider watcher goes back to the provider's model", async () => {
    const { fakes, deps } = hookWorld("glm-5.3");
    writeFileSync(join(agentsDir(fakes.deps.bundlePath), "pi.md"), "model: glm-5.3\n");

    expect(await runCli(["setup", "--hook"], deps, "/repo")).toBe(EXIT.ok);
    expect(agentModel(fakes, "omp")).toBe("glm-5.3");
    expect(agentModel(fakes, "pi")).toBe("sonnet");
    expect(agentModel(fakes, "opencode")).toBe("sonnet");
    // Repairs are silent: nothing for Claude's context, nothing for the user.
    expect(fakes.out.lines).toEqual([]);

    expect(await runCli(["setup", "--hook"], deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.out.lines).toEqual([]);
  });

  it("while the main agent runs on Sonnet (no router), a provider watcher runs on Sonnet too", async () => {
    const { fakes, deps } = hookWorld("sonnet");
    writeFileSync(join(agentsDir(fakes.deps.bundlePath), "omp.md"), "model: glm-5.3\n");

    expect(await runCli(["setup", "--hook"], deps, "/repo")).toBe(EXIT.ok);
    expect(agentModel(fakes, "omp")).toBe("sonnet");
  });

  it("a config from before engines (no file, or one it cannot read) changes nothing", async () => {
    const { fakes, deps } = world();
    expect(await runCli(["setup", "--hook"], deps, "/repo")).toBe(EXIT.ok);
    writeFileSync(stateLayout(fakes.root).engines, "{not json");
    expect(await runCli(["setup", "--hook"], deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.out.lines).toEqual([]);
    expect(createFsEngineConfig(fakes.root).read()).toEqual({ engines: {} });
  });
});
