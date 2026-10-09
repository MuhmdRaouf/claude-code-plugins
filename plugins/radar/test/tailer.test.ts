import { describe, expect, it } from "vitest";
import { openTail, splitLines, TAIL_CHUNK_BYTES, type TailState, tailFile } from "../src/ingest/tailer.ts";
import { appendText, makeEnv, writeText } from "./helpers.ts";

describe("splitLines", () => {
  it("splits complete lines and keeps the tail as carry", () => {
    expect(splitLines("", "a\nb\n")).toEqual({ lines: ["a", "b"], partial: "" });
    expect(splitLines("", "a\nb")).toEqual({ lines: ["a"], partial: "b" });
    expect(splitLines("a", "b\nc\n")).toEqual({ lines: ["ab", "c"], partial: "" });
    expect(splitLines("", "")).toEqual({ lines: [], partial: "" });
  });

  it("drops blank lines", () => {
    expect(splitLines("", "a\n\nb\n \n")).toEqual({ lines: ["a", "b"], partial: "" });
  });
});

describe("openTail", () => {
  it("bounds one read, so even a first catch-up streams instead of loading a file whole", () => {
    expect(TAIL_CHUNK_BYTES).toBe(4 * 1024 * 1024);
  });

  it("starts at the file's first byte, however big the file is", () => {
    const { home } = makeEnv();
    expect(openTail(`${home}/nope.jsonl`)).toEqual({ path: `${home}/nope.jsonl`, offset: 0, partial: "" });
    const small = writeText(`${home}/small.jsonl`, "a\nb\n");
    expect(openTail(small)).toEqual({ path: small, offset: 0, partial: "" });
    const big = writeText(`${home}/big.jsonl`, `${"x".repeat(600)}\n${"y".repeat(300)}\n`);
    expect(openTail(big)).toEqual({ path: big, offset: 0, partial: "" });
  });
});

describe("tailFile", () => {
  it("returns new lines only, then goes quiet", () => {
    const { home } = makeEnv();
    const path = writeText(`${home}/t.jsonl`, "one\ntwo\n");
    const state = openTail(path);
    expect(tailFile(state)).toEqual({ lines: ["one", "two"], restarted: false });
    expect(tailFile(state)).toEqual({ lines: [], restarted: false });
  });

  it("holds a partial trailing line until it completes", () => {
    const { home } = makeEnv();
    const path = writeText(`${home}/t.jsonl`, "");
    const state = openTail(path);
    appendText(path, "abc");
    expect(tailFile(state)).toEqual({ lines: [], restarted: false });
    expect(state.partial).toBe("abc");
    appendText(path, "def\n");
    expect(tailFile(state)).toEqual({ lines: ["abcdef"], restarted: false });
  });

  it("restarts from the top when the file shrinks (rotation)", () => {
    const { home } = makeEnv();
    const path = writeText(`${home}/t.jsonl`, "aaaa\nbbbb\ncccc\n");
    const state = openTail(path);
    tailFile(state);
    writeText(path, "x\ny\n");
    expect(tailFile(state)).toEqual({ lines: ["x", "y"], restarted: true });
    expect(state.partial).toBe("");
  });

  it("reports nothing for a file that vanished", () => {
    const { home } = makeEnv();
    const state: TailState = { path: `${home}/gone.jsonl`, offset: 40, partial: "" };
    expect(tailFile(state)).toEqual({ lines: [], restarted: false });
  });

  it("reads a file bigger than one chunk from the start, a bounded slice per read, in order", () => {
    const { home } = makeEnv();
    const all = Array.from({ length: 50 }, (_, i) => `line-${String(i).padStart(2, "0")}-${"x".repeat(20)}`);
    const path = writeText(`${home}/t.jsonl`, `${all.join("\n")}\n`);
    const state = openTail(path);
    const seen: string[] = [];
    let reads = 0;
    for (;;) {
      const { lines } = tailFile(state, 128); // far smaller than the file
      reads += 1;
      seen.push(...lines);
      if (lines.length === 0) break;
    }
    expect(seen).toEqual(all); // nothing skipped: the whole file, from its first line
    expect(reads).toBeGreaterThan(8); // in bounded slices, not one whole-file read
    expect(state.partial).toBe("");
  });

  it("carries a line that straddles a chunk boundary whole", () => {
    const { home } = makeEnv();
    const path = writeText(`${home}/t.jsonl`, "first\nsecond-continues-past-the-cut\nthird\n");
    const state = openTail(path);
    expect(tailFile(state, 12).lines).toEqual(["first"]); // "second" held back as a partial line
    expect(state.partial).toBe("second");
    expect(tailFile(state, 64).lines).toEqual(["second-continues-past-the-cut", "third"]);
  });
});
