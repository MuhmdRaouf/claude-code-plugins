import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  handshakeTimeoutMs,
  startPiRpc,
} from "../../../../src/adapters/engines/pi-rpc/client.ts";
import type { Frame } from "../../../../src/adapters/engines/pi-rpc/frames.ts";
import { isResponse } from "../../../../src/adapters/engines/pi-rpc/messages.ts";
import { collect, isAlive, SESSION, startFake, tempDir, waitForFrame } from "./harness.ts";

const HANDSHAKE = { timeoutMs: 30_000 };

function lines(path: string): Promise<string[]> {
  return readFile(path, "utf8").then((text) => text.split("\n").filter((line) => line !== ""));
}

describe("handshake", () => {
  it("sends get_state first and returns its data, with the whole exchange logged", async () => {
    const dir = tempDir();
    const log = { stdout: join(dir, "a.jsonl"), stdin: join(dir, "a.rpc-in.jsonl"), promptRef: "ref" };
    const client = await startFake({}, { log });
    const shake = await client.handshake(HANDSHAKE);
    expect(shake).toMatchObject({
      ok: true,
      value: { state: { sessionId: SESSION, thinkingLevel: "medium", messageCount: 0 } },
    });
    await client.close();
    expect(await lines(log.stdin)).toEqual(['{"id":"c1","type":"get_state"}']);
    expect((await lines(log.stdout))[0]).toContain('"command":"get_state"');
  });

  it("marks pi's session-create warning benign and keeps it out of the exit's stderr tail", async () => {
    const seen: { line: string; benign: boolean }[] = [];
    const client = await startFake({}, { onStderr: (line, benign) => seen.push({ line, benign }) });
    const shake = await client.handshake(HANDSHAKE);
    expect(shake.ok).toBe(true);
    expect(seen).toEqual([
      {
        line: `Warning: No project session found with id '${SESSION}'; creating a new session with that id.`,
        benign: true,
      },
    ]);
    expect((await client.close()).stderrTail).toBe("");
  });

  it("still completes against a pi that answers get_state late", async () => {
    const client = await startFake({ FAKE_PI_SLOW_STATE_MS: "150" });
    expect(await client.handshake(HANDSHAKE)).toMatchObject({ ok: true });
    await client.close();
  });

  it("times out and kills pi when the answer never comes", async () => {
    const client = await startFake({ FAKE_PI_SLOW_STATE_MS: "5000" });
    const shake = await client.handshake({ timeoutMs: 200 });
    expect(shake).toEqual({
      ok: false,
      error: { kind: "timeout", message: "pi did not complete the RPC handshake within 200 ms" },
    });
    expect(await client.exit).toMatchObject({ code: null, signal: "SIGKILL" });
    expect(isAlive(client.pid)).toBe(false);
  });

  it("refuses a get_state answer without a sessionId, as a protocol error, and kills pi", async () => {
    const client = await startFake({ FAKE_PI_NO_SESSION_ID: "1" });
    const shake = await client.handshake(HANDSHAKE);
    expect(shake).toEqual({
      ok: false,
      error: { kind: "protocol", message: "pi's get_state answer carries no sessionId" },
    });
    expect(await client.exit).toMatchObject({ signal: "SIGKILL" });
  });

  it("reports a pi that dies before answering as an exit, with its stderr tail", async () => {
    const client = await startFake(
      {},
      {
        command: process.execPath,
        args: ["-e", "process.stderr.write('early death\\n'); process.exit(3)"],
        cwd: tempDir(),
      },
    );
    const shake = await client.handshake(HANDSHAKE);
    expect(shake).toMatchObject({
      ok: false,
      error: { kind: "exited", message: "pi ended (exit code 3): early death" },
    });
    expect((await client.exit).code).toBe(3);
  });

  it("tolerates a stray non-JSON line before the first command, logging it as sent", async () => {
    const dir = tempDir();
    const log = { stdout: join(dir, "a.jsonl"), stdin: join(dir, "a.rpc-in.jsonl"), promptRef: "ref" };
    const client = await startFake({ FAKE_PI_GARBAGE: "1" }, { log });
    expect(await client.handshake(HANDSHAKE)).toMatchObject({ ok: true });
    await client.close();
    expect((await lines(log.stdout))[0]).toBe("this is not json");
  });

  it("clears its timeout timer once the handshake answers", async () => {
    vi.useFakeTimers();
    try {
      const client = await startFake();
      expect(await client.handshake(HANDSHAKE)).toMatchObject({ ok: true });
      expect(vi.getTimerCount()).toBe(0);
      expect(await client.close()).toEqual({ code: 0, signal: null, stderrTail: "", forced: null });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("handshakeTimeoutMs", () => {
  it("defaults to 15 seconds and honours PICC_HANDSHAKE_TIMEOUT_MS", () => {
    expect(DEFAULT_HANDSHAKE_TIMEOUT_MS).toBe(15_000);
    expect(handshakeTimeoutMs({})).toBe(15_000);
    expect(handshakeTimeoutMs({ PICC_HANDSHAKE_TIMEOUT_MS: "60000" })).toBe(60_000);
    expect(handshakeTimeoutMs({ PICC_HANDSHAKE_TIMEOUT_MS: "soon" })).toBe(15_000);
    expect(handshakeTimeoutMs({ PICC_HANDSHAKE_TIMEOUT_MS: "0" })).toBe(15_000);
  });
});

describe("commands", () => {
  it("correlates answers by id", async () => {
    const client = await startFake();
    await client.handshake(HANDSHAKE);
    const [state, text] = await Promise.all([
      client.request({ type: "get_state" }),
      client.request({ type: "get_last_assistant_text" }),
    ]);
    expect(state).toMatchObject({ ok: true, value: { command: "get_state", data: { sessionId: SESSION } } });
    expect(text).toMatchObject({
      ok: true,
      value: { command: "get_last_assistant_text", data: { text: "" } },
    });
    await client.close();
  });

  it("surfaces a command pi refuses", async () => {
    const client = await startFake();
    await client.handshake(HANDSHAKE);
    expect(await client.request({ type: "frobnicate" })).toEqual({
      ok: false,
      error: { kind: "rejected", command: "frobnicate", message: "Unknown command: frobnicate" },
    });
    await client.close();
  });

  it("answers exited, not rejected, once pi is gone", async () => {
    const client = await startFake();
    await client.handshake(HANDSHAKE);
    await client.close();
    const reply = await client.request({ type: "get_state" });
    expect(reply).toMatchObject({ ok: false, error: { kind: "exited" } });
  });

  it("answers closed when stdin is already shut but pi lives on", async () => {
    const client = await startFake({ FAKE_PI_SCENARIO: "sleep" });
    await client.handshake(HANDSHAKE);
    void client.prompt("sleep");
    const closing = client.close();
    const reply = await client.request({ type: "get_state" });
    expect(reply).toEqual({
      ok: false,
      error: { kind: "closed", message: "pi's stdin is closed; no further commands can be sent" },
    });
    client.kill("SIGKILL");
    expect(await closing).toMatchObject({ signal: "SIGKILL" });
  });
});

describe("turns", () => {
  it("resolves a prompt at agent_settled with its timings, and the transcript frames pass through in order", async () => {
    const client = await startFake();
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    const turn = await client.prompt("Do the thing.");
    expect(turn.ok).toBe(true);
    if (turn.ok) expect(turn.value.endedAt).toBeGreaterThanOrEqual(turn.value.promptSentAt);
    await waitForFrame(seen, (frame) => frame.type === "agent_settled");
    const roles = seen
      .filter((frame) => frame.type === "message_end")
      .map((frame) => (frame as { message?: { role?: string } }).message?.role);
    expect(roles).toEqual(["system", "user", "assistant"]);
    expect(seen.map((frame) => frame.type)).toContain("message_update");
    expect(seen[seen.length - 1]).toEqual({ type: "agent_settled" });
    expect(await client.lastAssistantText()).toMatchObject({ ok: true, value: "done" });
    await client.close();
  });

  it("admits and settles a turn even when pi ends its assistant message in error", async () => {
    const client = await startFake({ FAKE_PI_SCENARIO: "error" });
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    expect(await client.prompt("Summarize.")).toMatchObject({ ok: true });
    const failed = seen
      .filter((frame) => frame.type === "message_end")
      .map((frame) => (frame as { message?: { role?: string } }).message?.role);
    expect(failed).toEqual(["system", "user", "assistant"]);
    await client.close();
  });

  it("settles with no assistant message at all when pi has nothing to say", async () => {
    const client = await startFake({ FAKE_PI_NO_AGENT: "1" });
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    expect(await client.prompt("Just settle.")).toMatchObject({ ok: true });
    await waitForFrame(seen, (frame) => frame.type === "agent_settled");
    const roles = seen
      .filter((frame) => frame.type === "message_end")
      .map((frame) => (frame as { message?: { role?: string } }).message?.role);
    expect(roles).toEqual(["system", "user"]);
    expect(seen[seen.length - 1]).toEqual({ type: "agent_settled" });
    await client.close();
  });

  it("rejects the prompt when pi will not take it", async () => {
    const client = await startFake({ FAKE_PI_SCENARIO: "no-such-scenario" });
    await client.handshake(HANDSHAKE);
    expect(await client.prompt("Try anyway.")).toEqual({
      ok: false,
      error: { kind: "rejected", command: "prompt", message: "cannot prompt now" },
    });
    await client.close();
  });

  it("aborts a running tool: the turn settles before the abort response, in pi's order", async () => {
    const client = await startFake({ FAKE_PI_SCENARIO: "sleep" });
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    const turn = client.prompt("sleep");
    await waitForFrame(seen, (frame) => frame.type === "tool_execution_start");
    expect(await client.abort()).toMatchObject({ ok: true, value: { command: "abort" } });
    expect(await turn).toMatchObject({ ok: true });
    await waitForFrame(seen, (frame) => isResponse(frame) && frame.command === "abort");
    const settledAt = seen.findIndex((frame) => frame.type === "agent_settled");
    const abortReplyAt = seen.findIndex((frame) => isResponse(frame) && frame.command === "abort");
    expect(settledAt).toBeGreaterThanOrEqual(0);
    expect(abortReplyAt).toBeGreaterThan(settledAt);
    const messages = seen.filter((frame) => frame.type === "message_end");
    const last = messages[messages.length - 1] as { message?: Record<string, unknown> };
    expect(last.message).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: "The operation was aborted.",
    });
    await client.close();
  });

  it("kills a pi that ignores the abort", async () => {
    const client = await startFake({ FAKE_PI_SCENARIO: "ignore-abort" }, { graceMs: 300 });
    await client.handshake(HANDSHAKE);
    const turn = client.prompt("sleep");
    await waitForFrame(collect(client), (frame) => frame.type === "tool_execution_start");
    expect(await client.abort()).toMatchObject({ ok: true });
    client.kill("SIGTERM");
    const early = await Promise.race([client.exit, delay(300, "still running")]);
    expect(early).toBe("still running");
    client.kill("SIGKILL");
    expect(await turn).toMatchObject({ ok: false, error: { kind: "exited", exit: { signal: "SIGKILL" } } });
  });

  it("rejects the turn when pi dies mid-turn", async () => {
    const client = await startFake({ FAKE_PI_SCENARIO: "crash" });
    await client.handshake(HANDSHAKE);
    const turn = await client.prompt("crash");
    expect(turn).toMatchObject({
      ok: false,
      error: { kind: "exited", message: "pi ended (exit code 1): fake pi: simulated crash" },
    });
    if (!turn.ok && turn.error.kind === "exited") {
      expect(turn.error.exit).toEqual({
        code: 1,
        signal: null,
        stderrTail: "fake pi: simulated crash\n",
        forced: null,
      });
    }
    await client.exit;
  });

  it("refuses a second prompt while a turn is still open (pi is single-flight)", async () => {
    const client = await startFake({ FAKE_PI_SCENARIO: "sleep" });
    await client.handshake(HANDSHAKE);
    void client.prompt("first");
    expect(await client.prompt("second")).toEqual({
      ok: false,
      error: { kind: "rejected", command: "prompt", message: "cannot prompt now" },
    });
    client.abort();
    await client.close();
  });
});

describe("large frames", () => {
  it("carries a 2 MiB assistant message whole, without chunking", async () => {
    const dir = tempDir();
    const log = { stdout: join(dir, "a.jsonl"), stdin: join(dir, "a.rpc-in.jsonl"), promptRef: "ref" };
    const client = await startFake({ FAKE_PI_SCENARIO: "big-frame" }, { log });
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    expect(await client.prompt("read big.txt")).toMatchObject({ ok: true });
    const assistant = seen.find(
      (frame) =>
        frame.type === "message_end" &&
        (frame as { message?: { role?: string } }).message?.role === "assistant",
    ) as unknown as { message: { content: { type: string; text: string }[] } };
    expect(assistant.message.content[0]?.text.length).toBe(2 * 1024 * 1024);
    // The log is an append stream written behind the frames; close is what flushes it (as the worker relies on).
    await client.close();
    const logged = await lines(log.stdout);
    expect(logged.length).toBe(seen.length);
    expect(Math.max(...logged.map((line) => line.length))).toBeGreaterThan(2 * 1024 * 1024);
    for (const line of logged) expect(line).not.toContain("rpc_chunk");
  });
});

describe("close and exit", () => {
  it("close ends stdin, drains the remaining frames and reports pi's own exit", async () => {
    const client = await startFake();
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    expect(await client.prompt("done")).toMatchObject({ ok: true });
    expect(await client.close()).toEqual({ code: 0, signal: null, stderrTail: "", forced: null });
    // The queue was closed at stdout end; nothing new can arrive after close.
    const after: Frame[] = [];
    for await (const frame of client.frames) after.push(frame);
    expect(after).toEqual([]);
    expect(seen.length).toBeGreaterThan(0);
    expect(isAlive(client.pid)).toBe(false);
  });

  it("fails with start when the binary is missing", async () => {
    const started = await startPiRpc({ command: "/nonexistent/pi", args: [], cwd: tempDir(), env: {} });
    expect(started).toMatchObject({ ok: false, error: { kind: "start" } });
    if (!started.ok) expect(started.error.message).toContain("ENOENT");
  });

  it("fails with start when a log cannot be opened", async () => {
    const dir = tempDir();
    // A file where a directory of logs should be makes both log paths unopenable.
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a directory");
    for (const name of ["stdout", "stdin"] as const) {
      const log = {
        stdout: join(blocker, `${name}.jsonl`),
        stdin: join(blocker, `${name}.rpc-in.jsonl`),
        promptRef: "ref",
      };
      const started = await startPiRpc({
        command: process.execPath,
        args: ["-e", ""],
        cwd: dir,
        env: {},
        log,
      });
      expect(started).toMatchObject({ ok: false, error: { kind: "start" } });
      if (!started.ok) expect(started.error.message).toContain("cannot open log");
    }
  });
});
