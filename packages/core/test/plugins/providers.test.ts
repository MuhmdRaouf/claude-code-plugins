/**
 * The five provider plugins side by side: every `plugins/<name>-plugin-cc/src/provider.ts` in the repository, loaded as
 * the plugin loads it, and the rules no single plugin can check alone (unique ports, env prefixes, agent names, model
 * prefixes that never claim another plugin's models) plus the naming scheme each one follows. A plugin's own
 * provider.test.ts keeps the facts that are only its own (catalog, endpoint, key variables).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stateRootRule } from "../../src/adapters/state-root.ts";
import type { Provider } from "../../src/domain/provider.ts";
import { OFFERINGS } from "../../src/render/prices.ts";

const PLUGINS = join(import.meta.dirname, "../../../../plugins");

interface Plugin {
  readonly dir: string;
  readonly provider: Provider;
}

async function providerPlugins(): Promise<Plugin[]> {
  const dirs = readdirSync(PLUGINS)
    .filter((dir) => dir.endsWith("-plugin-cc"))
    .sort();
  return Promise.all(
    dirs.map(async (dir) => {
      const module = (await import(join(PLUGINS, dir, "src/provider.ts"))) as Record<string, unknown>;
      const exported = Object.entries(module).filter(([key]) => key.endsWith("_PROVIDER"));
      expect(
        exported.map(([key]) => key),
        `${dir}: one *_PROVIDER export`,
      ).toHaveLength(1);
      return { dir, provider: exported[0]?.[1] as Provider };
    }),
  );
}

const plugins = await providerPlugins();
const providers = plugins.map((plugin) => plugin.provider);

/** Catalog fields a model may ship without, and why: the provider publishes no figure to copy (each entry says where
 *  the plugins looked, as prices.ts cites its sources). Every model id not named here must declare the field. */
/** Models whose window is far below the 1M of the Claude models a hint could name: without a hint Claude Code
 *  keeps its standard window for an unknown id, which fits them, where a 1M hint would let a session outgrow
 *  the provider's window before auto-compact starts. */
const NO_WINDOW_HINT: Readonly<Record<string, string>> = {
  "kimi-k2.6": "262,144-token window (platform.kimi.ai/docs/pricing/chat, 2026-10-09)",
  "MiniMax-M2.7-highspeed":
    "204,800-token window (platform.minimax.io/docs/api-reference/text-anthropic-api, 2026-10-09)",
};

const UNPUBLISHED: Readonly<Record<string, string>> = {
  "kimi-k2.6":
    "Moonshot publishes no output cap for it, only the 262,144-token window (platform.kimi.ai/docs/pricing/chat, 2026-10-09)",
  "MiniMax-M3":
    "MiniMax publishes no output cap; the window is 1,000,000 (platform.minimax.io/docs/api-reference/text-anthropic-api, 2026-10-09)",
  "MiniMax-M2.7-highspeed":
    "MiniMax publishes no output cap; the window is 204,800 (platform.minimax.io/docs/api-reference/text-anthropic-api, 2026-10-09)",
  "qwen3.8-max":
    "Alibaba Cloud publishes no output cap for Model Studio models; the window is 1M (help.aliyun.com/zh/model-studio/text-generation-model, 2026-10-09)",
  "qwen3.8-flash":
    "Alibaba Cloud publishes no output cap for Model Studio models; the window is 1M (help.aliyun.com/zh/model-studio/text-generation-model, 2026-10-09)",
};

/** Every markdown file a plugin ships: the copy users read. */
function markdownFiles(root: string): readonly string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.parentPath.includes("node_modules"),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The provider's price sheet, found by the host its endpoint shares with it. */
function sheetOf(provider: Provider): (typeof OFFERINGS)[number] | undefined {
  return OFFERINGS.find((offering) => offering.host === new URL(provider.baseUrl).host);
}

/** Every value `pick` gives, asserting no two providers share one. */
function expectUnique(what: string, pick: (provider: Provider) => readonly (string | number)[]): void {
  const all = providers.flatMap(pick);
  const repeated = all.filter((value, index) => all.indexOf(value) !== index);
  expect(repeated, `${what} shared between providers`).toEqual([]);
}

describe("the provider plugins together", () => {
  it("are the five providers, each in its own <name>-plugin-cc", () => {
    expect(plugins.map(({ dir, provider }) => [dir, provider.name])).toEqual([
      ["deepseek-plugin-cc", "deepseek"],
      ["kimi-plugin-cc", "kimi"],
      ["minimax-plugin-cc", "minimax"],
      ["qwen-plugin-cc", "qwen"],
      ["zai-plugin-cc", "zai"],
    ]);
  });

  it("never share a name, port, env prefix, key variable, key file, state root, display name or agent", () => {
    expectUnique("name", (p) => [p.name]);
    expectUnique("display name", (p) => [p.display]);
    expectUnique("router port", (p) => [p.router.port]);
    expectUnique("router label", (p) => [p.router.label]);
    expectUnique("env prefix", (p) => [p.envPrefix]);
    expectUnique("key variable", (p) => p.keyEnv);
    expectUnique("key file", (p) => [p.keyFile]);
    expectUnique("state dir variable", (p) => [stateRootRule(p).envVar]);
    expectUnique("agent", (p) => [p.agents.main, p.agents.flash].map((agent) => `${p.agentPrefix}${agent}`));
    expectUnique("model id", (p) => [p.catalog.main.id, p.catalog.flash.id]);
  });

  it("route only their own models: each catalog id is claimed by its own router's prefixes and no other's", () => {
    for (const owner of providers) {
      for (const tier of ["main", "flash"] as const) {
        const id = owner.catalog[tier].id;
        const claimants = providers
          .filter((p) => p.router.modelPrefixes.some((prefix) => id.startsWith(prefix)))
          .map((p) => p.name);
        expect({ id, claimants }).toEqual({ id, claimants: [owner.name] });
      }
      for (const prefix of owner.router.modelPrefixes) expect(prefix, owner.name).not.toMatch(/^claude/i);
    }
  });

  it.each(providers.map((provider) => [provider.name, provider] as const))(
    "%s follows the naming scheme and its agents ship as files",
    (name, p) => {
      const NAME = name.toUpperCase();
      expect({
        slash: p.slash,
        agentPrefix: p.agentPrefix,
        branchPrefix: p.branchPrefix,
        harness: p.harness,
        envPrefix: p.envPrefix,
        artifactsEnv: p.artifactsEnv,
        firstKey: p.keyEnv[0],
        keyFile: p.keyFile,
        healthPath: p.router.healthPath,
        agents: p.agents,
        tiers: [p.catalog.main.tier, p.catalog.flash.tier],
        stateRoot: stateRootRule(p),
      }).toEqual({
        slash: `/${name}:`,
        agentPrefix: `${name}:`,
        branchPrefix: `${name}/`,
        harness: name,
        envPrefix: NAME,
        artifactsEnv: `${NAME}_ARTIFACTS`,
        firstKey: `${NAME}_API_KEY`,
        keyFile: `~/.config/${name}-plugin-cc/env`,
        healthPath: `/${name}-router/health`,
        agents: { main: p.catalog.main.id, flash: p.catalog.flash.id },
        tiers: ["main", "flash"],
        stateRoot: { envVar: `${NAME}_STATE_DIR`, dataPrefix: `${name}-`, xdgName: name },
      });
      // zai keeps its historical service label; the newer plugins use the com.muhmdraouf scheme.
      expect(p.router.label).toBe(
        name === "zai" ? "dev.muhmdraouf.zai-router" : `com.muhmdraouf.${name}-router`,
      );
      expect(p.baseUrl).toMatch(/^https:\/\/[^/]+\/.*anthropic$/);
      for (const field of p.strip)
        expect(
          p.caveats.filter((caveat) => caveat.includes(field)),
          `${field}: a caveat names it`,
        ).not.toEqual([]);
      for (const agent of Object.values(p.agents))
        expect(existsSync(join(PLUGINS, `${name}-plugin-cc/plugin/agents/${agent}.md`)), agent).toBe(true);
    },
  );

  /** Main and flash of every provider plugin, with the directory each came from. */
  const refs = () =>
    plugins.flatMap(({ dir, provider }) =>
      [provider.catalog.main, provider.catalog.flash].map((ref) => ({ dir, ref })),
    );

  it("give every catalog model a behavesAs window hint, unless its window is far smaller", () => {
    for (const { dir, ref } of refs()) {
      if (NO_WINDOW_HINT[ref.id] !== undefined)
        expect(ref.behavesAs, `${dir}: ${ref.id} must not borrow a larger window`).toBeUndefined();
      else
        expect(ref.behavesAs, `${dir}: ${ref.id} declares no behavesAs and none is exempted`).toMatch(
          /^claude-/,
        );
    }
  });

  it("give every catalog model an output cap, or the documented exemption", () => {
    for (const { dir, ref } of refs()) {
      expect(
        ref.maxOutputTokens ?? UNPUBLISHED[ref.id],
        `${dir}: ${ref.id} declares no maxOutputTokens and none is exempted`,
      ).toBeTruthy();
      if (ref.maxOutputTokens !== undefined) expect(ref.maxOutputTokens, ref.id).toBeGreaterThan(0);
    }
  });

  it("never call the flash tier cheaper where the price sheet prices it above the main model", () => {
    for (const { dir, provider } of plugins) {
      const offering = sheetOf(provider);
      const main = offering?.models[provider.catalog.main.id]?.base;
      const flash = offering?.models[provider.catalog.flash.id]?.base;
      expect(main, `${provider.name}: ${provider.catalog.main.id} on the sheet`).toBeDefined();
      expect(flash, `${provider.name}: ${provider.catalog.flash.id} on the sheet`).toBeDefined();
      const cheaper =
        (flash?.input ?? Infinity) < (main?.input ?? Infinity) &&
        (flash?.output ?? Infinity) < (main?.output ?? Infinity);
      for (const file of markdownFiles(join(PLUGINS, dir))) {
        expect(
          cheaper || !/\bcheaper\b/i.test(readFileSync(file, "utf8")),
          `${file} calls ${provider.catalog.flash.id} cheaper; the price sheet (${offering?.source}) does not agree`,
        ).toBe(true);
      }
    }
  });
});
