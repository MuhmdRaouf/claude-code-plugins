import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const PROVIDERS = ["zai", "kimi", "deepseek", "minimax", "qwen"];

const catalogue = JSON.parse(
  readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"),
);

test("the catalogue lists the five provider plugins and huddle, and the names are unique", () => {
  const names = catalogue.plugins.map((plugin) => plugin.name);

  assert.deepEqual([...names].sort(), [...PROVIDERS.map((provider) => `${provider}-plugin-cc`), "huddle"].sort());
  assert.equal(new Set(names).size, names.length, "names are unique");
});

test("every provider plugin entry installs huddle with it", () => {
  for (const provider of PROVIDERS) {
    const entry = catalogue.plugins.find((plugin) => plugin.name === `${provider}-plugin-cc`);
    assert.deepEqual(entry?.dependencies, ["huddle"], `${provider}-plugin-cc declares huddle`);
  }
});

test("the huddle entry fetches plugin/ from the huddle repository", () => {
  const entry = catalogue.plugins.find((plugin) => plugin.name === "huddle");
  assert.deepEqual(entry?.source, { source: "git-subdir", url: "MuhmdRaouf/huddle", path: "plugin" });
});
