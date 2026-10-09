import { describe, expect, it } from "vitest";
import { fuzzy } from "../src/fuzzy.ts";

describe("fuzzy", () => {
  it("returns -1 when a word matches neither as a substring nor as a subsequence", () => {
    expect(fuzzy("xyz", "board")).toBe(-1);
    expect(fuzzy("board zz", "board view")).toBe(-1);
  });

  it("ranks a substring above a subsequence and a word start above the middle of a word", () => {
    expect(fuzzy("view", "board view")).toBeGreaterThan(fuzzy("bvw", "board view"));
    expect(fuzzy("view", "board view")).toBeGreaterThan(fuzzy("oard", "board view"));
    expect(fuzzy("view", "view")).toBeGreaterThan(fuzzy("view", "board view"));
  });

  it("scores a subsequence higher when its characters run together or start words", () => {
    expect(fuzzy("bv", "board-view")).toBeGreaterThan(fuzzy("bd", "board-view"));
    expect(fuzzy("brd", "brxd")).toBeGreaterThan(fuzzy("brd", "bxrxd"));
  });

  it("needs every word and ignores case and extra spaces", () => {
    expect(fuzzy("  Task  Graph ", "the task graph")).toBeGreaterThan(0);
    expect(fuzzy("", "anything")).toBeCloseTo(-0.16);
  });

  it("prefers the shorter of two texts with the same match", () => {
    expect(fuzzy("go", "go")).toBeGreaterThan(fuzzy("go", "go home now"));
  });
});
