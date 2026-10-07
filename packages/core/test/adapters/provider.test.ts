import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTempIndex } from "../../src/adapters/git-snapshot.ts";
import { createShellGates } from "../../src/adapters/shell-gates.ts";
import { ok } from "../../src/domain/result.ts";
import { isolateGitConfig, makeRepo, tempDir } from "../support/tmp.ts";

// The adapters name what they leave behind after the provider they serve.
describe("adapters take the provider's name", () => {
  it.each(["zai", "acme"])("the temp index dir is <provider>-index-… (%s)", async (name) => {
    isolateGitConfig();
    const repo = makeRepo();
    let index = "";

    await withTempIndex(repo.dir, name, async (env) => {
      index = env.GIT_INDEX_FILE ?? "";
      return ok(undefined);
    });

    expect(basename(dirname(index))).toMatch(new RegExp(`^${name}-index-`));
  });

  it.each(["zai", "acme"])("a gate that cannot start says so as <provider>: … (%s)", async (name) => {
    const result = await createShellGates(name).run(
      join(tempDir(), "missing"),
      { run: "true", timeoutMs: 1000 },
      {},
      join(tempDir(), "g.log"),
    );

    expect(result.tail).toMatch(new RegExp(`^${name}: could not start gate: `));
  });
});
