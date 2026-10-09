import { describe, expect, it } from "vitest";
import { stampMs, timeAgo } from "../src/time.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");

describe("timeAgo", () => {
  it("says the unknown plainly", () => {
    for (const ts of [null, undefined, "", "not a date"]) expect(timeAgo(ts, NOW)).toBe("—");
    expect(stampMs("nope")).toBeNull();
  });

  it("steps from just now to minutes, hours and days", () => {
    expect(timeAgo(NOW - 44_000, NOW)).toBe("just now");
    expect(timeAgo(NOW + 60_000, NOW)).toBe("just now");
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(timeAgo("2026-10-08T09:00:00Z", NOW)).toBe("3 h ago");
    expect(timeAgo(NOW - 2 * 86_400_000, NOW)).toBe("2 d ago");
  });
});
