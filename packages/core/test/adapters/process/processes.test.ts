import { describe, expect, it } from "vitest";
import { processList } from "../../../src/adapters/process/processes.ts";

describe("the process list", () => {
  it("reads this machine's processes with ps, this test's own among them", async () => {
    const list = await processList();
    expect(list?.some((entry) => entry.pid === process.pid)).toBe(true);
  });

  it("is unknown on Windows, and when ps fails", async () => {
    expect(await processList("win32")).toBeUndefined();
    expect(await processList("linux", async () => ({ kind: "missing", message: "no ps" }))).toBeUndefined();
  });
});
