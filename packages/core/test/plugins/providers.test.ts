/**
 * The five provider plugins side by side: every `plugins/<name>-plugin-cc/src/provider.ts` in the repository, loaded as
 * the plugin loads it, and the rules no single plugin can check alone (unique ports, env prefixes, agent names, model
 * prefixes that never claim another plugin's models) plus the naming scheme each one follows. A plugin's own
 * provider.test.ts keeps the facts that are only its own (catalog, endpoint, key variables).
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stateRootRule } from "../../src/adapters/state-root.ts";
import type { Provider } from "../../src/domain/provider.ts";

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
      expect(p.baseUrl.intl).toMatch(/^https:\/\/[^/]+\/.*anthropic$/);
      if (p.baseUrl.cn !== undefined) expect(p.baseUrl.cn).toMatch(/^https:\/\/[^/]+\/.*anthropic$/);
      for (const field of p.strip)
        expect(
          p.caveats.filter((caveat) => caveat.includes(field)),
          `${field}: a caveat names it`,
        ).not.toEqual([]);
      for (const agent of Object.values(p.agents))
        expect(existsSync(join(PLUGINS, `${name}-plugin-cc/plugin/agents/${agent}.md`)), agent).toBe(true);
    },
  );
});
