import { describe, expect, it } from "vitest";
import { runtimeLabel } from "../../src/adapters/runtime.ts";

describe("runtimeLabel", () => {
  it("names bun with its version and path when process.versions has bun", () => {
    expect(runtimeLabel({ node: "24.3.0", bun: "1.3.14" }, "/opt/bun/bin/bun")).toBe(
      "bun 1.3.14 (/opt/bun/bin/bun)",
    );
  });

  it("names node otherwise", () => {
    expect(runtimeLabel({ node: "24.11.0" }, "/usr/bin/node")).toBe("node 24.11.0 (/usr/bin/node)");
    expect(runtimeLabel({}, "/x")).toBe("node ? (/x)");
  });

  it("defaults to this process", () => {
    expect(runtimeLabel()).toContain(process.execPath);
  });
});
