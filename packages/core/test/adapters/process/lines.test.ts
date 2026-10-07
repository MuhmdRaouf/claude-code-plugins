import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createQueue, DEFAULT_MAX_LINE_BYTES, eachLine } from "../../../src/adapters/process/lines.ts";
import { sleep } from "../../support/wait.ts";

describe("eachLine", () => {
  it("splits on newlines and flushes the last line at EOF", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    let ended = 0;
    eachLine(
      stream,
      (line) => lines.push(line),
      () => {
        ended += 1;
      },
    );
    stream.write("one\ntw");
    stream.write("o\nthree");
    stream.end();
    await new Promise((resolve) => stream.once("close", resolve));
    expect(lines).toEqual(["one", "two", "three"]);
    expect(ended).toBe(1);
  });

  it("ends and destroys the stream when a line passes the byte limit without a newline", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    let ended = 0;
    let overflowed = 0;
    // A small limit keeps the test cheap; the real one is omp's one-MiB frame budget.
    eachLine(
      stream,
      (line) => lines.push(line),
      () => {
        ended += 1;
      },
      () => {
        overflowed += 1;
      },
      16,
    );
    stream.write("kept\n");
    stream.write("x".repeat(17));
    await new Promise((resolve) => stream.once("close", resolve));
    expect(lines).toEqual(["kept"]);
    expect(ended).toBe(1);
    expect(overflowed).toBe(1);
  });

  it("overflows past the default one-MiB budget when no limit is given", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    let overflowed = 0;
    eachLine(
      stream,
      (line) => lines.push(line),
      () => {},
      () => {
        overflowed += 1;
      },
    );
    stream.write("kept\n");
    stream.write("x".repeat(DEFAULT_MAX_LINE_BYTES + 1));
    await new Promise((resolve) => stream.once("close", resolve));
    expect(lines).toEqual(["kept"]);
    expect(overflowed).toBe(1);
  });
});

describe("createQueue", () => {
  it("yields items in order across compactions, waits for more, and ends on close", async () => {
    const queue = createQueue<number>();
    for (let i = 0; i < 2_500; i += 1) queue.push(i);
    const seen: number[] = [];
    const done = (async () => {
      for await (const item of queue.items) seen.push(item);
    })();
    await sleep(10); // the reader drains the 2,500 and parks waiting for more
    queue.push(2_500);
    queue.close();
    queue.push(9_999);
    await done;
    expect(seen).toEqual(Array.from({ length: 2_501 }, (_, i) => i));
  });
});
