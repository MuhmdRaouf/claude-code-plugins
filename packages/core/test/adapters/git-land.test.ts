/** readTrailer and isAncestor against real git: the quiet exit-1 conventions both lean on, and what lies outside them. */
import { beforeEach, describe, expect, it } from "vitest";
import { isAncestor, readTrailer } from "../../src/adapters/git-land.ts";
import { err, ok } from "../../src/domain/result.ts";
import { isolateGitConfig, makeRepo } from "../support/tmp.ts";

describe("readTrailer", () => {
  beforeEach(() => isolateGitConfig());

  it("worked-by when the key is unset", async () => {
    const repo = makeRepo();
    await expect(readTrailer("zai", repo.dir)).resolves.toEqual(ok("worked-by"));
  });

  it("worked-by when set to an empty value", async () => {
    const repo = makeRepo();
    repo.git("config", "zai.trailer", "");
    await expect(readTrailer("zai", repo.dir)).resolves.toEqual(ok("worked-by"));
  });

  it("none when set to none", async () => {
    const repo = makeRepo();
    repo.git("config", "zai.trailer", "none");
    await expect(readTrailer("zai", repo.dir)).resolves.toEqual(ok("none"));
  });

  it("any other value is an error, not a guess", async () => {
    const repo = makeRepo();
    repo.git("config", "zai.trailer", "maybe");
    await expect(readTrailer("zai", repo.dir)).resolves.toEqual(
      err({
        kind: "git_failed",
        command: "git config --get zai.trailer",
        stderr: '"maybe" is not worked-by or none',
      }),
    );
  });
});

describe("isAncestor", () => {
  beforeEach(() => isolateGitConfig());

  it("true one way, false the other", async () => {
    const repo = makeRepo();
    const first = repo.head();
    repo.git("commit", "--quiet", "--allow-empty", "-m", "second");
    const second = repo.head();

    await expect(isAncestor(repo.dir, first, second)).resolves.toEqual(ok(true));
    await expect(isAncestor(repo.dir, second, first)).resolves.toEqual(ok(false));
  });

  it("a ref that does not exist is an error", async () => {
    const repo = makeRepo();

    await expect(isAncestor(repo.dir, "no-such-ref", "HEAD")).resolves.toEqual(
      err({
        kind: "git_failed",
        command: "git merge-base --is-ancestor --end-of-options no-such-ref HEAD",
        stderr: expect.any(String),
      }),
    );
  });
});
