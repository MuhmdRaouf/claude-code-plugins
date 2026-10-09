import { describe, expect, it } from "vitest";
import { type RepoFs, repoOf } from "../src/shared/repo.ts";

/** A fake fs from path → content; a path present with null content is a directory. */
function fakeFs(entries: Record<string, string | null>): RepoFs {
  return {
    exists: (path) => path in entries,
    readFile: (path) => (path in entries ? (entries[path] ?? null) : null),
  };
}

describe("repoOf", () => {
  it("names the directory holding a .git directory, near or far up", () => {
    const fs = fakeFs({ "/w/app/.git": null, "/w/app/src/a.ts": "" });
    expect(repoOf("/w/app", fs)).toBe("/w/app");
    expect(repoOf("/w/app/src", fs)).toBe("/w/app");
  });

  it("folds a linked worktree into the checkout its .git file points at", () => {
    const fs = fakeFs({ "/w/wt/.git": "gitdir: /w/main/.git/worktrees/wt\n" });
    expect(repoOf("/w/wt", fs)).toBe("/w/main");
    expect(repoOf("/w/wt/plugins/radar", fs)).toBe("/w/main");
  });

  it("resolves a relative gitdir against the directory holding the .git file", () => {
    const fs = fakeFs({ "/w/wt/.git": "gitdir: ../main/.git/worktrees/wt" });
    expect(repoOf("/w/wt", fs)).toBe("/w/main");
  });

  it("keeps the checkout itself when the .git file is not a worktree pointer", () => {
    const fs = fakeFs({ "/w/app/.git": "gitdir: /somewhere/else" });
    expect(repoOf("/w/app", fs)).toBe("/w/app");
  });

  it("returns null when no parent holds a .git", () => {
    expect(repoOf("/w/app/src", fakeFs({}))).toBeNull();
    expect(repoOf("/", fakeFs({}))).toBeNull();
  });
});
