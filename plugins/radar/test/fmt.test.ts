import { describe, expect, it } from "vitest";
import { OUTSIDE_SESSION } from "../src/shared/model.ts";
import {
  costDetailText,
  costText,
  fmtAgo,
  fmtClock,
  fmtCount,
  fmtDuration,
  fmtNum,
  fmtPercent,
  fmtTime,
  fmtTokens,
  fmtUptime,
  fmtUsd,
  hostOf,
  sessionName,
} from "../src/ui/fmt.ts";

describe("fmtTokens", () => {
  it("shows whole numbers under a thousand", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(731)).toBe("731");
  });

  it("compacts with as many digits as fit", () => {
    expect(fmtTokens(1234)).toBe("1.23k");
    expect(fmtTokens(1500)).toBe("1.5k");
    expect(fmtTokens(12345)).toBe("12.3k");
    expect(fmtTokens(123456)).toBe("123k");
    expect(fmtTokens(1_000_000)).toBe("1M");
    expect(fmtTokens(8_100_000_000)).toBe("8.1B");
  });

  it("never renders infinity or NaN as a number", () => {
    expect(fmtTokens(Number.NaN)).toBe("–");
    expect(fmtTokens(Number.POSITIVE_INFINITY)).toBe("–");
  });

  it("shows a dash for a negative count instead of raw scientific notation", () => {
    expect(fmtTokens(-1)).toBe("–");
    expect(fmtTokens(-2.0375423986018017e43)).toBe("–");
  });
});

describe("fmtNum", () => {
  it("groups thousands", () => {
    expect(fmtNum(0)).toBe("0");
    expect(fmtNum(999)).toBe("999");
    expect(fmtNum(1234)).toBe("1,234");
    expect(fmtNum(1234567)).toBe("1,234,567");
  });

  it("keeps the sign out of the grouping", () => {
    expect(fmtNum(-1234)).toBe("-1,234");
  });
});

describe("fmtDuration", () => {
  it("returns a dash for no data", () => {
    expect(fmtDuration(null)).toBe("–");
    expect(fmtDuration(undefined)).toBe("–");
    expect(fmtDuration(Number.NaN)).toBe("–");
  });

  it("covers every unit band with exact strings", () => {
    expect(fmtDuration(0)).toBe("0ms");
    expect(fmtDuration(812)).toBe("812ms");
    expect(fmtDuration(6300)).toBe("6.3s");
    expect(fmtDuration(154_000)).toBe("2m34s");
    expect(fmtDuration(119_500)).toBe("2m00s"); // 1m59.5s rounds into the next minute
    expect(fmtDuration(7_200_000)).toBe("2h00m");
    expect(fmtDuration(7_140_000)).toBe("1h59m");
  });
});

describe("fmtClock / fmtTime", () => {
  it("formats local clock time with padded fields", () => {
    const ts = new Date(2026, 0, 15, 9, 5, 3).getTime();
    expect(fmtClock(ts)).toBe("09:05:03");
  });

  it("shows seconds for today and hour:minute for older days", () => {
    const today = new Date();
    today.setHours(12, 5, 3, 0);
    expect(fmtTime(today.getTime())).toBe("12:05:03");
    // a fixed past date can never be "today", so this branch is deterministic
    expect(fmtTime(new Date(2020, 0, 2, 14, 5, 0).getTime())).toBe("14:05");
  });
});

describe("fmtAgo", () => {
  it("steps through the bands", () => {
    const now = 10_000_000;
    expect(fmtAgo(now, now)).toBe("now");
    expect(fmtAgo(now - 500, now)).toBe("now");
    expect(fmtAgo(now - 5_000, now)).toBe("5s ago");
    expect(fmtAgo(now - 65_000, now)).toBe("1m ago");
    expect(fmtAgo(now - 3_700_000, now)).toBe("1h ago");
    expect(fmtAgo(now - 90_000_000, now)).toBe("1d ago");
  });

  it("clamps future timestamps to now rather than going negative", () => {
    expect(fmtAgo(10_000, 0)).toBe("now");
  });
});

describe("fmtUptime", () => {
  it("is fmtDuration over the delta", () => {
    expect(fmtUptime(1_000, 16_300)).toBe("15.3s");
    expect(fmtUptime(5_000, 1_000)).toBe("0ms");
  });
});

describe("fmtPercent", () => {
  it("rounds whole percents and keeps a decimal under ten", () => {
    expect(fmtPercent(0)).toBe("0%");
    expect(fmtPercent(0.842)).toBe("84%");
    expect(fmtPercent(1)).toBe("100%");
    expect(fmtPercent(0.042)).toBe("4.2%");
    expect(fmtPercent(0.005)).toBe("0.5%");
    expect(fmtPercent(Number.NaN)).toBe("–");
  });
});

describe("fmtCount", () => {
  it("pluralises regular nouns by count", () => {
    expect(fmtCount(1, "request")).toBe("1 request");
    expect(fmtCount(0, "request")).toBe("0 requests");
    expect(fmtCount(1_200, "agent")).toBe("1,200 agents");
  });
});
describe("fmtUsd", () => {
  it("prints estimates with sensible precision", () => {
    expect(fmtUsd(null)).toBe("–");
    expect(fmtUsd(undefined)).toBe("–");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(0.0012)).toBe("<$0.01"); // never "$0.0000"
    expect(fmtUsd(0.01)).toBe("$0.01");
    expect(fmtUsd(4.2)).toBe("$4.20");
    expect(fmtUsd(12_345.6)).toBe("$12,346");
  });
});

describe("costText", () => {
  it("prefixes an estimate with est., or says unpriced", () => {
    expect(costText(null)).toBe("unpriced");
    expect(costText(undefined)).toBe("unpriced");
    expect(costText(0)).toBe("est. $0.00");
    expect(costText(1)).toBe("est. $1.00");
  });
});

describe("costDetailText", () => {
  it("joins the sum and every condition that shaped it, or names the unpriced case", () => {
    expect(costDetailText(null)).toBe("tokens only (no price for this model)");
    expect(costDetailText({ usd: 0.0123, detail: [] })).toBe("$0.01");
    expect(costDetailText({ usd: 0.0123, detail: ["Anthropic list", "1 h cache writes"] })).toBe(
      "$0.01 · Anthropic list · 1 h cache writes",
    );
  });
});

describe("sessionName", () => {
  it("is the project folder, else the first eight characters of the id", () => {
    expect(sessionName({ id: "abcdefghijklmnop", project: "app" })).toBe("app");
    expect(sessionName({ id: "abcdefghijklmnop", project: null })).toBe("abcdefgh");
  });

  it("has a fixed name for traffic outside any session", () => {
    expect(sessionName({ id: OUTSIDE_SESSION, project: null })).toBe("Outside a session");
  });
});

describe("hostOf", () => {
  it("reduces an upstream to its host, with fallbacks", () => {
    expect(hostOf("")).toBe("–");
    expect(hostOf("https://api.anthropic.com")).toBe("api.anthropic.com");
    expect(hostOf("http://127.0.0.1:8787")).toBe("127.0.0.1:8787");
    expect(hostOf("not a url")).toBe("not a url");
  });
});
