import { describe, expect, it } from "vitest";
import { resolveStateRoot, type StateRootRule, stateRootRule } from "../../src/adapters/state-root.ts";
import { ACME_PROVIDER, REFERENCE_PROVIDER, REFERENCE_STATE_ROOT } from "../support/provider.ts";

const ACME: StateRootRule = { envVar: "ACME_STATE_DIR", dataPrefix: "acme-plugin-", xdgName: "acme" };

describe("resolveStateRoot", () => {
  it.each([
    ["zai", REFERENCE_STATE_ROOT, "ZAI_STATE_DIR", "/data/zai-plugin-cc-m", "zai"],
    ["a second provider", ACME, "ACME_STATE_DIR", "/data/acme-plugin-m", "acme"],
  ] as const)(
    "%s: its env var, else its own plugin data dir, else XDG, else ~/.local/state",
    (_, rule, envVar, own, xdg) => {
      expect(resolveStateRoot({ [envVar]: "/explicit", CLAUDE_PLUGIN_DATA: own, HOME: "/h" }, rule)).toBe(
        "/explicit",
      );
      expect(resolveStateRoot({ CLAUDE_PLUGIN_DATA: own, XDG_STATE_HOME: "/xdg", HOME: "/h" }, rule)).toBe(
        own,
      );
      expect(resolveStateRoot({ XDG_STATE_HOME: "/xdg", HOME: "/h" }, rule)).toBe(`/xdg/${xdg}`);
      expect(resolveStateRoot({ HOME: "/h" }, rule)).toBe(`/h/.local/state/${xdg}`);
    },
  );

  it("never takes another provider's env var or data dir", () => {
    const zaiOwn = { ZAI_STATE_DIR: "/zai", CLAUDE_PLUGIN_DATA: "/data/zai-plugin-cc-m", HOME: "/h" };
    const acmeOwn = { ACME_STATE_DIR: "/acme", CLAUDE_PLUGIN_DATA: "/data/acme-plugin-m", HOME: "/h" };

    expect(resolveStateRoot(zaiOwn, ACME)).toBe("/h/.local/state/acme");
    expect(resolveStateRoot(acmeOwn, REFERENCE_STATE_ROOT)).toBe("/h/.local/state/zai");
  });

  it("stateRootRule derives each provider's rule from its own names", () => {
    expect(stateRootRule(REFERENCE_PROVIDER)).toEqual(REFERENCE_STATE_ROOT);
    expect(stateRootRule(ACME_PROVIDER)).toEqual({
      envVar: "ACME_STATE_DIR",
      dataPrefix: "acme-",
      xdgName: "acme",
    });
  });
});
