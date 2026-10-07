import { describe, expect, it } from "vitest";
import { openTail, splitLines, TAIL_CAP_BYTES, type TailState, tailFile } from "../src/ingest/tailer.ts";
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
  it("exposes the 50 MB first-read cap", () => {
    expect(TAIL_CAP_BYTES).toBe(52_428_800);
  });

  it("starts at zero for a missing file or a file within the cap", () => {
    const { home } = makeEnv();
    expect(openTail(`${home}/nope.jsonl`)).toEqual({
      path: `${home}/nope.jsonl`,
      offset: 0,
      partial: "",
      align: false,
    });
    const small = writeText(`${home}/small.jsonl`, "a\nb\n");
    expect(openTail(small)).toEqual({ path: small, offset: 0, partial: "", align: false });
    expect(openTail(small, 4)).toEqual({ path: small, offset: 0, partial: "", align: false }); // size == cap
  });

  it("skips to the last `cap` bytes and asks for line alignment when over the cap", () => {
    const { home } = makeEnv();
    const bigContent = `${"x".repeat(600)}\n${"y".repeat(300)}\n`;
    const big = writeText(`${home}/big.jsonl`, bigContent);
    const state = openTail(big, 300);
    expect(state.offset).toBe(bigContent.length - 300);
    expect(state.align).toBe(true);
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
    const state: TailState = { path: `${home}/gone.jsonl`, offset: 40, partial: "", align: false };
    expect(tailFile(state)).toEqual({ lines: [], restarted: false });
  });

  it("drops the aligned first chunk through its first newline", () => {
    const { home } = makeEnv();
    // 3 x 6-byte lines; cap 8 lands mid-"line1", so alignment must drop "1\n" and keep line2
    const path = writeText(`${home}/t.jsonl`, "line0\nline1\nline2\n");
    const state = openTail(path, 8);
    expect(tailFile(state)).toEqual({ lines: ["line2"], restarted: false });
    expect(state.align).toBe(false);
  });

  it("drops the whole chunk when the aligned prefix has no newline yet", () => {
    const { home } = makeEnv();
    const path = writeText(`${home}/t.jsonl`, `${"x".repeat(50)}\ntail-end-no-newline-yet`);
    const state = openTail(path, 10);
    expect(tailFile(state)).toEqual({ lines: [], restarted: false });
    expect(state.partial).toBe("");
  });
});
