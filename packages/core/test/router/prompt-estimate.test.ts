import { describe, expect, it } from "vitest";
import { estimatePrompt, promptKey, recordPrompt } from "../../src/router/prompt-estimate.ts";

describe("promptKey", () => {
  it("is 16 hex characters and stable for the same system and first message", () => {
    const first = { role: "user", content: "hi" };
    expect(promptKey("You delegate work.", first)).toMatch(/^[0-9a-f]{16}$/);
    expect(promptKey("You delegate work.", first)).toBe(promptKey("You delegate work.", first));
  });

  it("moves when the system or the first message moves", () => {
    expect(promptKey("a", "m")).not.toBe(promptKey("b", "m"));
    expect(promptKey("a", "m")).not.toBe(promptKey("a", "n"));
  });

  it("reads only the first 4096 characters of each part", () => {
    const edge = "x".repeat(4096);
    // Differences past the cut are invisible: the head is the identity, not the whole transcript.
    expect(promptKey(`${edge}A`, "m")).toBe(promptKey(`${edge}B`, "m"));
    expect(promptKey("a", "m")).not.toBe(promptKey("b", "m"));
  });
});

describe("estimatePrompt", () => {
  it("takes a quarter token per byte for a conversation never seen", () => {
    expect(estimatePrompt("no-such-conversation", 8192)).toBe(2048);
    expect(estimatePrompt("no-such-conversation", 7)).toBe(2);
  });

  it("grows from what the last turn of the same conversation really cost", () => {
    const key = promptKey("s-grown", "m");
    recordPrompt(
      key,
      { input_tokens: 1000, cache_read_input_tokens: 50, cache_creation_input_tokens: 3 },
      8000,
    );
    expect(estimatePrompt(key, 12000)).toBe(2053);
  });

  it("never goes down when the next body is shorter", () => {
    const key = promptKey("s-shorter", "m");
    recordPrompt(key, { input_tokens: 900 }, 8000);
    expect(estimatePrompt(key, 4000)).toBe(900);
  });

  it("ignores a final usage that still reports no prompt size", () => {
    const key = promptKey("s-zero", "m");
    recordPrompt(key, { input_tokens: 0, output_tokens: 30 }, 8000);
    expect(estimatePrompt(key, 8000)).toBe(2000);
  });

  it("forgets the oldest conversation past 500", () => {
    const evicted = promptKey("s-oldest", "m");
    recordPrompt(evicted, { input_tokens: 999999 }, 0);
    for (let i = 0; i < 500; i += 1)
      recordPrompt(promptKey(`s-flood-${i}`, "m"), { input_tokens: 1000000 + i }, 0);
    // The flooded-out conversation estimates like a stranger again; the newest one is still known.
    expect(estimatePrompt(evicted, 4000)).toBe(1000);
    expect(estimatePrompt(promptKey("s-flood-499", "m"), 0)).toBe(1000499);
  });
});
