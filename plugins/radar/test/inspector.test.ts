import { describe, expect, it } from "vitest";
import type { RequestRecord } from "../src/shared/model.ts";
import { ZERO_TOKENS } from "../src/shared/model.ts";
import {
  captureSystemText,
  captureToolName,
  captureTools,
  firstLine,
  httpStatusOf,
  nearbyRetries,
  prettyJson,
  rawDocument,
  retriesText,
} from "../src/ui/app/inspector/util.ts";
import { makeRequest } from "./helpers.ts";

function at(id: string, ts: number, over: Partial<RequestRecord> = {}): RequestRecord {
  return makeRequest({ id, sessionId: "s1", agentId: "main", ts, ...over });
}

describe("the inspector's HTTP status", () => {
  it("reads a bare three-digit stop reason as the router's status, anything else as a stop reason", () => {
    expect(httpStatusOf(makeRequest({ stopReason: "429" }))).toBe(429);
    expect(httpStatusOf(makeRequest({ stopReason: "503" }))).toBe(503);
    expect(httpStatusOf(makeRequest({ stopReason: "end_turn" }))).toBeNull();
    expect(httpStatusOf(makeRequest({ stopReason: null }))).toBeNull();
    expect(httpStatusOf(makeRequest({ stopReason: "4x2" }))).toBeNull();
  });

  it("counts failed attempts for the same agent in the two minutes before the request", () => {
    const request = at("r", 100_000, { stopReason: "end_turn" });
    const retries = [
      at("new", 90_000, { stopReason: "500" }),
      at("edge", 100_000 - 120_000, { stopReason: "429" }),
      at("late", 100_001, { stopReason: "500" }),
      at("other-agent", 95_000, { agentId: "w1", stopReason: "429" }),
      at("success", 96_000, { stopReason: "end_turn" }),
      at("old", 100_000 - 121_000, { stopReason: "500" }),
      at("self", 100_000, { stopReason: "500" }),
    ];
    expect(nearbyRetries(retries, request).map((retry) => retry.id)).toEqual(["new", "edge"]);
    expect(nearbyRetries(retries, request)).toEqual(nearbyRetries([...retries].reverse(), request));
  });

  it("says none, or the count with the statuses that made them", () => {
    expect(retriesText([])).toBe("None recorded");
    expect(retriesText([at("a", 1, { stopReason: "500" }), at("b", 2, { stopReason: "429" })])).toBe(
      "2 within 2 min (429, 500)",
    );
    expect(retriesText([at("a", 1, { stopReason: "500" }), at("b", 2, { stopReason: "500" })])).toBe(
      "2 within 2 min (500)",
    );
  });
});

describe("the inspector's shapes", () => {
  it("prints pretty JSON that survives circular values, and first lines that are trimmed", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson(undefined)).toBe("undefined");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(prettyJson(circular)).toContain("[object Object]");
    expect(firstLine("first\nsecond")).toBe("first");
    expect(firstLine("  padded  ")).toBe("padded");
    expect(firstLine("")).toBe("");
  });

  it("shapes the raw document as the record plus the sides once they are fetched", () => {
    const request = at("r", 1);
    expect(rawDocument(request, null)).toEqual({ request });
    expect(rawDocument(request, { input: "in", output: "out" })).toEqual({
      request,
      input: "in",
      output: "out",
    });
  });
});

describe("the inspector's zero-token tokens", () => {
  it("keeps ZERO_TOKENS at hand for tables that show dashes", () => {
    expect(ZERO_TOKENS).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("the captured prompt's shapes", () => {
  it("reads a system prompt back as text, its blocks joined, dropping nothing silently", () => {
    expect(captureSystemText("be brief")).toBe("be brief");
    expect(
      captureSystemText([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
    ).toBe("one\n\ntwo");
    expect(captureSystemText([{ type: "image" }])).toBe("");
    expect(captureSystemText(null)).toBe("");
    expect(captureSystemText(undefined)).toBe("");
    // a shape nobody names yet shows as the JSON it is, never as nothing
    expect(captureSystemText({ odd: true })).toBe('{\n  "odd": true\n}');
  });

  it("keeps a prompt's object tools and names them, and nothing else", () => {
    expect(captureTools([{ name: "Bash" }, "nope", [1]])).toEqual([{ name: "Bash" }]);
    expect(captureTools(undefined)).toEqual([]);
    expect(captureToolName({})).toBe("tool");
    expect(captureToolName({ name: "" })).toBe("tool");
    expect(captureToolName({ name: "Bash" })).toBe("Bash");
  });
});
