import { describe, expect, it } from "vitest";
import { modelEnvName, resolveProvider } from "../../src/domain/provider.ts";
import { ACME_PROVIDER, REFERENCE_PROVIDER } from "../support/provider.ts";

describe("modelEnvName", () => {
  it("uppercases the tier after the provider's env prefix", () => {
    expect(modelEnvName(ACME_PROVIDER, "main")).toBe("ACME_MODEL_MAIN");
    expect(modelEnvName(REFERENCE_PROVIDER, "flash")).toBe("ZAI_MODEL_FLASH");
  });
});

describe("resolveProvider", () => {
  it("returns the provider unchanged when no override is set", () => {
    expect(resolveProvider(ACME_PROVIDER, {})).toEqual(ACME_PROVIDER);
  });

  it("replaces only the catalog ids the env names", () => {
    const resolved = resolveProvider(ACME_PROVIDER, { ACME_MODEL_FLASH: "small-model-9-turbo" });

    expect(resolved.catalog).toEqual({
      main: { tier: "main", id: "big-model-9", label: "Big Model 9" },
      flash: { tier: "flash", id: "small-model-9-turbo", label: "Small Model 9" },
    });
    expect(resolved.tierNames).toEqual(ACME_PROVIDER.tierNames);
  });

  it("overrides the endpoint when the env names one", () => {
    const resolved = resolveProvider(ACME_PROVIDER, { ACME_BASE_URL: "https://mirror.acme.test/anthropic" });

    expect(resolved.baseUrl).toBe("https://mirror.acme.test/anthropic");
  });
});
