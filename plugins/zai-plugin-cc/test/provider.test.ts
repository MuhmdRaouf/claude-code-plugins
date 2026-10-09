import { CLAUDE_CAPS } from "@muhmdraouf/core/adapters/claude-headless.ts";
import { stateRootRule } from "@muhmdraouf/core/adapters/state-root.ts";
import { REFERENCE_CAPS, REFERENCE_PROVIDER, REFERENCE_STATE_ROOT } from "@muhmdraouf/core/testing";
import { describe, expect, it } from "vitest";
import { ZAI_PROVIDER } from "../src/provider.ts";

describe("zai is core's reference provider", () => {
  it("core's shared suites assert zai's names, its state root and the claude worker's terms", () => {
    expect(ZAI_PROVIDER).toEqual(REFERENCE_PROVIDER);
    expect(stateRootRule(ZAI_PROVIDER)).toEqual(REFERENCE_STATE_ROOT);
    expect(CLAUDE_CAPS).toEqual(REFERENCE_CAPS);
  });
});
