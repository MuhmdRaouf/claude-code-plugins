import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseStreamLine } from "../../src/domain/stream-parse.ts";
import type { WorkerEvent } from "../../src/domain/worker-events.ts";
import { EVENT_FIXTURES } from "../support/index.ts";

const FIXTURES = new URL("../fixtures/stream/", import.meta.url);

function fixtureLines(name: string): string[] {
  return readFileSync(new URL(name, FIXTURES), "utf8").split("\n");
}

function fixtureLine(name: string, lineNumber: number): string {
  const line = fixtureLines(name)[lineNumber - 1];
  if (line === undefined) throw new Error(`${name} has no line ${lineNumber}`);
  return line;
}

function fixtureEvents(name: string): WorkerEvent[] {
  return fixtureLines(name).flatMap((line) => {
    const parsed = parseStreamLine(line);
    if (!parsed.ok) throw new Error(`${name}: ${parsed.error}`);
    return [...parsed.value];
  });
}

describe("parseStreamLine", () => {
  it("system/init → init with session_id and model (fixture rate-limited-429.jsonl line 3)", () => {
    const parsed = parseStreamLine(fixtureLine("rate-limited-429.jsonl", 3));

    expect(parsed).toEqual({
      ok: true,
      value: [{ type: "init", sessionId: "13d60183-de73-441c-ae75-5fc27a410511", model: "glm-5.3-flash" }],
    });
  });
  it("system/api_retry → api_retry with attempt, max_retries and error_status", () => {
    const parsed = parseStreamLine(fixtureLine("rate-limited-429.jsonl", 7));

    expect(parsed).toEqual({
      ok: true,
      value: [{ type: "api_retry", attempt: 3, maxRetries: 10, status: 429 }],
    });
  });
  it("assistant message text blocks → assistant_text; tool_use blocks → tool_use with name and a short input summary", () => {
    const text = parseStreamLine(fixtureLine("success-edit.jsonl", 9));
    const edit = parseStreamLine(fixtureLine("success-edit.jsonl", 13));
    const bash = parseStreamLine(fixtureLine("tool-error.jsonl", 6));

    expect(text).toEqual({
      ok: true,
      value: [{ type: "assistant_text", text: "I'll fix the off-by-one in src/range.ts." }],
    });
    expect(edit).toEqual({
      ok: true,
      value: [{ type: "tool_use", name: "Edit", summary: "/work/repo/src/range.ts" }],
    });
    expect(bash).toEqual({ ok: true, value: [{ type: "tool_use", name: "Bash", summary: "npm test" }] });
  });
  it("tool_use summary is the most telling input field on one line, else compact JSON, capped at 80 chars", () => {
    const summaryOf = (input: unknown): string | undefined => {
      const line = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_x", name: "T", input }] },
      });
      const parsed = parseStreamLine(line);
      const event = parsed.ok ? parsed.value[0] : undefined;
      return event?.type === "tool_use" ? event.summary : undefined;
    };

    expect(summaryOf({ pattern: "TODO", path: "src" })).toBe("TODO");
    expect(summaryOf({ path: "src", glob: "*.ts" })).toBe("src");
    expect(summaryOf({ notebook_path: "a.ipynb" })).toBe("a.ipynb");
    expect(summaryOf({ url: "https://example.com", prompt: "read" })).toBe("https://example.com");
    expect(summaryOf({ query: "zod v4", allowed_domains: [] })).toBe("zod v4");
    expect(summaryOf({ description: "Explore", prompt: "find x" })).toBe("Explore");
    expect(summaryOf({ prompt: "find x" })).toBe("find x");
    expect(summaryOf({ skill: "tdd" })).toBe("tdd");
    expect(summaryOf({ command: "npm test\n  && npm run lint" })).toBe("npm test && npm run lint");
    expect(summaryOf({ todos: [{ id: 1 }] })).toBe('{"todos":[{"id":1}]}');
    expect(summaryOf({ command: "  npm test\n" })).toBe("npm test");
    expect(summaryOf({})).toBe("");
    expect(summaryOf("raw")).toBe("");
    expect(summaryOf(null)).toBe("");
    expect(summaryOf({ command: "x".repeat(200) })).toBe(`${"x".repeat(79)}…`);
    expect(summaryOf({ command: "x".repeat(80) })).toBe("x".repeat(80));
  });

  it("a multi-block assistant message keeps every block in order; adjacent text blocks join", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "Running tests." },
          { type: "tool_use", id: "toolu_y", name: "Bash", input: { command: "npm test" } },
          { type: "text", text: "Then " },
          { type: "text", text: "lint." },
          { type: "tool_use", id: "toolu_z", name: "Bash", input: { command: "npm run lint" } },
        ],
      },
    });
    const twoTexts = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    });

    expect(parseStreamLine(line)).toEqual({
      ok: true,
      value: [
        { type: "assistant_text", text: "Running tests." },
        { type: "tool_use", name: "Bash", summary: "npm test" },
        { type: "assistant_text", text: "Then lint." },
        { type: "tool_use", name: "Bash", summary: "npm run lint" },
      ],
    });
    expect(parseStreamLine(twoTexts)).toEqual({ ok: true, value: [{ type: "assistant_text", text: "ab" }] });
  });

  it("api_retry without an HTTP status (network error) → status null", () => {
    const line =
      '{"type": "system", "subtype": "api_retry", "attempt": 1, "max_retries": 10, "error_status": null}';

    expect(parseStreamLine(line)).toEqual({
      ok: true,
      value: [{ type: "api_retry", attempt: 1, maxRetries: 10, status: null }],
    });
  });

  it("result with missing accounting fields counts them as 0, a missing text as empty, no api_error_status as null", () => {
    const line = '{"type": "result", "subtype": "error_max_turns", "is_error": true, "usage": null}';

    expect(parseStreamLine(line)).toEqual({
      ok: true,
      value: [
        {
          type: "result",
          isError: true,
          text: "",
          structuredOutput: null,
          turns: 0,
          durationMs: 0,
          costUsd: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          apiErrorStatus: null,
        },
      ],
    });
  });

  it("result carries the live api_error_status as apiErrorStatus; a non-numeric one reads as null", () => {
    const limited = parseStreamLine(fixtureLine("rate-limited-429.jsonl", 16));
    const odd = parseStreamLine('{"type": "result", "is_error": true, "api_error_status": "429"}');

    expect(limited).toMatchObject({ ok: true, value: [{ type: "result", apiErrorStatus: 429 }] });
    expect(odd).toMatchObject({ ok: true, value: [{ type: "result", apiErrorStatus: null }] });
  });

  it("user messages: tool_result is_error omitted means success; any failed block makes it an error", () => {
    const user = (content: unknown): string =>
      JSON.stringify({ type: "user", message: { role: "user", content } });

    expect(parseStreamLine(user([{ type: "tool_result", tool_use_id: "a", content: "ok" }]))).toEqual({
      ok: true,
      value: [{ type: "tool_result", isError: false }],
    });
    expect(
      parseStreamLine(
        user([
          { type: "tool_result", tool_use_id: "a", content: "ok", is_error: false },
          { type: "tool_result", tool_use_id: "b", content: "boom", is_error: true },
        ]),
      ),
    ).toEqual({ ok: true, value: [{ type: "tool_result", isError: true }] });
  });

  it("user messages without tool_result blocks are other; text beside a tool_result is ignored", () => {
    const user = (content: unknown): string =>
      JSON.stringify({ type: "user", message: { role: "user", content } });
    const textOnly = user([{ type: "text", text: "Continue." }]);
    const mixed = user([
      { type: "text", text: "note" },
      { type: "tool_result", tool_use_id: "a", content: "boom", is_error: true },
    ]);

    expect(parseStreamLine(textOnly)).toEqual({ ok: true, value: [{ type: "other", raw: textOnly }] });
    expect(parseStreamLine(mixed)).toEqual({ ok: true, value: [{ type: "tool_result", isError: true }] });
  });

  it("stream_event content_block_delta text → text_delta", () => {
    const parsed = parseStreamLine(fixtureLine("success-edit.jsonl", 7));

    expect(parsed).toEqual({ ok: true, value: [{ type: "text_delta", text: "off-by-one in " }] });
  });
  it("user tool_result blocks → tool_result with is_error", () => {
    const failed = parseStreamLine(fixtureLine("tool-error.jsonl", 10));
    const succeeded = parseStreamLine(fixtureLine("success-edit.jsonl", 17));

    expect(failed).toEqual({ ok: true, value: [{ type: "tool_result", isError: true }] });
    expect(succeeded).toEqual({ ok: true, value: [{ type: "tool_result", isError: false }] });
  });
  it("result → result reading is_error independently of subtype (fixture: subtype success + is_error true)", () => {
    const parsed = parseStreamLine(fixtureLine("rate-limited-429.jsonl", 16));

    expect(parsed).toMatchObject({
      ok: true,
      value: [
        {
          type: "result",
          isError: true,
          text: "API Error: Request rejected (429) · [1302][Rate limit reached for requests][202610060644290fbcd9bc36024c65]",
          structuredOutput: null,
        },
      ],
    });
  });
  it("result maps usage tokens (input, output, cache read, cache creation) and total_cost_usd, num_turns, duration_ms", () => {
    const parsed = parseStreamLine(fixtureLine("success-edit.jsonl", 26));

    expect(parsed).toEqual({
      ok: true,
      value: [
        {
          type: "result",
          isError: false,
          text: "Fixed the off-by-one in range().",
          structuredOutput: {
            summary: "Fixed the off-by-one in range()",
            files: [{ path: "src/range.ts", why: "end bound was exclusive" }],
            root_cause: "loop used < instead of <=",
            tests_added: [],
            open_items: [],
          },
          turns: 3,
          durationMs: 42130,
          costUsd: 0.0123,
          usage: { inputTokens: 4200, outputTokens: 310, cacheReadTokens: 2800, cacheWriteTokens: 900 },
          apiErrorStatus: null,
        },
      ],
    });
  });
  it("unknown types and hook events → other, never an error", () => {
    const lines = [
      fixtureLine("rate-limited-429.jsonl", 1),
      fixtureLine("rate-limited-429.jsonl", 2),
      fixtureLine("rate-limited-429.jsonl", 4),
      fixtureLine("success-edit.jsonl", 1),
      fixtureLine("success-edit.jsonl", 4),
      '{"type": "rate_limit_event", "rate_limit_info": {"status": "allowed"}}',
      '{"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "hmm"}]}}',
      '{"type": "user", "message": {"role": "user", "content": "plain prompt text"}}',
      '{"type": "result", "subtype": "success"}',
      "[1, 2]",
    ];

    for (const line of lines) {
      expect(parseStreamLine(line)).toEqual({ ok: true, value: [{ type: "other", raw: line }] });
    }
  });
  it("blank line → no events; malformed JSON → error with a short message", () => {
    const truncated = `{"type": "assistant", "message": {"content": [{"type": "text", "text": "${"x".repeat(500)}`;

    expect(parseStreamLine("")).toEqual({ ok: true, value: [] });
    expect(parseStreamLine("  \t\r")).toEqual({ ok: true, value: [] });
    const malformed = parseStreamLine(truncated);
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.error).toMatch(/^malformed JSON: /);
    expect(malformed.error.length).toBeLessThanOrEqual(120);
  });
  it("parses every line of every fixture without error", () => {
    const names = readdirSync(FIXTURES).filter((name) => name.endsWith(".jsonl"));
    expect(names).toEqual(
      expect.arrayContaining([
        "crash-no-result.jsonl",
        "rate-limited-429.jsonl",
        "success-edit.jsonl",
        "tool-error.jsonl",
      ]),
    );

    for (const name of names) {
      const lines = fixtureLines(name).filter((line) => line !== "");
      for (const [index, line] of lines.entries()) {
        const parsed = parseStreamLine(line);
        expect(parsed, `${name} line ${index + 1}`).toMatchObject({ ok: true, value: [expect.any(Object)] });
      }
    }
  });
});

describe("the shared event fixtures", () => {
  it("are what parseStreamLine reads from each stream fixture, event for event", () => {
    const names = readdirSync(FIXTURES).filter((name) => name.endsWith(".jsonl"));

    expect(names).toEqual(readdirSync(EVENT_FIXTURES).filter((name) => name.endsWith(".jsonl")));
    for (const name of names) {
      const recorded = readFileSync(new URL(name, EVENT_FIXTURES), "utf8")
        .split("\n")
        .filter((line) => line !== "");
      expect(fixtureEvents(name), name).toEqual(recorded.map((line) => JSON.parse(line)));
    }
  });
});
