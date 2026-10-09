import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The same end-to-end leg under each runtime the plugin supports: scripts/runtime-leg.mjs starts the committed
 * bundle on a random port in temp dirs and checks the page, its assets, the live stream and the hooks. The bun
 * leg is skipped where bun is not installed (CI always installs it).
 */
const leg = fileURLToPath(new URL("../scripts/runtime-leg.mjs", import.meta.url));
const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

function runLeg(runtime: string): void {
  const result = spawnSync(runtime, [leg], { encoding: "utf8", timeout: 90_000 });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain("runtime leg passed");
}

describe("the bundled server and hooks, per runtime", () => {
  it("run under node", () => runLeg("node"));
  it.skipIf(!hasBun)("run under bun", () => runLeg("bun"));
});
