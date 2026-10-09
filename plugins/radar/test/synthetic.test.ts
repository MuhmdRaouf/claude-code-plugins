import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startWatcher } from "../src/ingest/watch.ts";
import { createStore } from "../src/store/store.ts";
import { iso, jsonl, makeEnv, writeText } from "./helpers.ts";

const T0 = Date.now() - 60_000;

/**
 * `<synthetic>` is the model name Claude Code writes on assistant messages it makes itself, as found in real
 * transcripts: "No response requested.", usage-limit and connection notices. None of them is a model call.
 */
function synthetic(ts: number, text: string, error?: string): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: iso(ts),
    isSidechain: false,
    ...(error === undefined ? {} : { isApiErrorMessage: true, error }),
    message: {
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "stop_sequence",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: "text", text }],
    },
  };
}

function real(ts: number, id: string): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: iso(ts),
    requestId: id,
    message: { model: "claude-opus-5-5", usage: { input_tokens: 3, output_tokens: 7 }, content: [] },
  };
}

describe("Claude Code's own <synthetic> messages", () => {
  it("are never model requests; the error ones show as a Claude Code notice on their session and agent", () => {
    const { env, config } = makeEnv();
    writeText(
      join(config, "projects", "-w-app", "s1.jsonl"),
      jsonl([
        { type: "user", timestamp: iso(T0), cwd: "/w/app", message: { content: "go" } },
        real(T0 + 1000, "req-1"),
        synthetic(T0 + 2000, "No response requested."),
        synthetic(T0 + 3000, "You've hit your session limit · resets 1pm", "rate_limit"),
        synthetic(T0 + 4000, "API Error: Connection lost mid-response.", "server_error"),
      ]),
    );
    const store = createStore();
    const watcher = startWatcher({ env, store, sinceMs: 86_400_000, intervalMs: 3_600_000 });
    watcher.stop();
    expect(store.models().models.map((row) => row.model)).toEqual(["claude-opus-5-5"]);
    expect(store.requests({})).toHaveLength(1);
    expect(store.summary()).toMatchObject({ requests: 1, errors: 2 });
    const session = store.sessionDetail("s1");
    expect(session?.errorCount).toBe(2);
    expect(session?.agents.find((agent) => agent.id === "main")?.errors).toBe(2);
    const notices = store.events({ session: "s1" }).filter((event) => event.kind === "Notice");
    expect(notices.map((event) => event.label)).toEqual([
      "Claude Code notice: connection error",
      "Claude Code notice: usage limit",
    ]);
  });
});
