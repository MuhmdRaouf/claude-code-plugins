import { describe, expect, it } from "vitest";
import { parsePid } from "../../src/domain/pid.ts";

describe("parsePid reads a pid or lock file", () => {
  it("takes digits around whitespace", () => {
    expect(parsePid("4242\n")).toBe(4242);
    expect(parsePid("  17 ")).toBe(17);
  });

  it.each(["", "0", "1", "-5", "+5", "1e3", "12abc", "3.5", "99999999999999999999"])("refuses %j", (text) => {
    expect(parsePid(text)).toBeUndefined();
  });
});
