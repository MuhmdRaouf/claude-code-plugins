import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  type HostToolHandler,
  type HostToolReply,
  handshakeTimeoutMs,
  startOmpRpc,
} from "../../../../src/adapters/engines/omp-rpc/client.ts";
import type { Frame } from "../../../../src/adapters/engines/omp-rpc/frames.ts";
import type { HostToolCall } from "../../../../src/adapters/engines/omp-rpc/messages.ts";
import { LOG_KEEP } from "../../../../src/adapters/engines/shared/rpc-log.ts";
import {
  collect,
  FAKE_OMP,
  HANDSHAKE,
  isAlive,
  READONLY_ARGS,
  startFake,
  startFixture,
  tempDir,
  waitForFrame,
} from "../../../fixtures/engines/omp.ts";

const accept: HostToolHandler = () => ({ text: "Report received." });

function lines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

type WireFrame = { type: string; chunkId?: string; byteLength?: number; toolName?: string };

describe("handshake", () => {
  it("negotiates v2, mounts the host tools, sets the filter and returns get_state", async () => {
    const dir = tempDir();
    const log = { stdout: join(dir, "a.jsonl"), stdin: join(dir, "a.rpc-in.jsonl"), promptRef: "ref" };
    const client = await startFake({}, { log });
    const shake = await client.handshake({
      ...HANDSHAKE,
      expectTools: ["read", "grep", "glob", "submit_report"],
    });
    expect(shake).toMatchObject({
      ok: true,
      value: { ready: { supportedProtocolVersions: [1, 2] }, state: { model: { id: "glm-5.3" } } },
    });
    await client.close();
    const sent = lines(log.stdin).map((line) => JSON.parse(line));
    expect(sent.map((command) => command.type)).toEqual([
      "negotiate_protocol",
      "set_host_tools",
      "set_event_filter",
      "get_state",
    ]);
    expect(sent[0]).toEqual({ id: "c1", type: "negotiate_protocol", protocolVersion: 2 });
    expect(sent[1].tools[0]).toMatchObject({ name: "submit_report", loadMode: "essential" });
    expect(sent[2]).toMatchObject({
      events: expect.arrayContaining(["message_update"]),
      messageUpdates: "delta",
    });
  });

  it("fails when dumpTools is not exactly the expected set", async () => {
    const client = await startFake();
    const shake = await client.handshake({ ...HANDSHAKE, expectTools: ["read", "grep", "glob"] });
    expect(shake).toMatchObject({
      ok: false,
      error: { kind: "protocol", message: expect.stringContaining("submit_report") },
    });
  });

  it("waits for a slow ready, and reports omp's 'Still starting' stderr as benign", async () => {
    const stderr: [string, boolean][] = [];
    const client = await startFake(
      { FAKE_OMP_READY_DELAY_MS: "1500" },
      { onStderr: (line, benign) => stderr.push([line, benign]) },
    );
    expect(await client.handshake(HANDSHAKE)).toMatchObject({ ok: true });
    expect(stderr).toEqual([["Still starting after 10s — phase: discoverCustomToolPaths", true]]);
    expect((await client.close()).stderrTail).toBe("");
  });

  it("times out when ready does not come in time, then kills the omp nobody drives anymore", async () => {
    const client = await startFake({ FAKE_OMP_READY_DELAY_MS: "5000" });
    const shake = await client.handshake({ ...HANDSHAKE, timeoutMs: 200 });
    expect(shake).toEqual({
      ok: false,
      error: { kind: "timeout", message: "omp did not complete the RPC handshake within 200 ms" },
    });
    expect(await client.exit).toMatchObject({ code: null, signal: "SIGKILL" });
  });

  it("refuses an omp without protocol 2, then kills it", async () => {
    const client = await startFake({ FAKE_OMP_PROTOCOLS: "1" });
    expect(await client.handshake(HANDSHAKE)).toEqual({
      ok: false,
      error: { kind: "protocol", message: "omp offers RPC protocol 1; 2 is required" },
    });
    expect(await client.exit).toMatchObject({ code: null, signal: "SIGKILL" });
  });

  it("reports an omp that exits before ready, with its stderr (recorded: --resume <unknown id>)", async () => {
    const client = await startFixture("resume-unknown-id");
    const shake = await client.handshake(HANDSHAKE);
    expect(shake).toMatchObject({
      ok: false,
      error: { kind: "exited", exit: { code: 1 }, message: expect.stringContaining("not found") },
    });
  });

  it("tolerates a line that is not a frame, and logs it", async () => {
    const dir = tempDir();
    const log = { stdout: join(dir, "a.jsonl"), stdin: join(dir, "b.jsonl"), promptRef: "ref" };
    const client = await startFake({ FAKE_OMP_GARBAGE: "1" }, { log });
    expect(await client.handshake(HANDSHAKE)).toMatchObject({ ok: true });
    await client.close();
    expect(lines(log.stdout)[0]).toBe("this is not json");
  });

  it("reads the timeout from OMPCC_HANDSHAKE_TIMEOUT_MS, defaulting to 45 s", () => {
    expect(DEFAULT_HANDSHAKE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(handshakeTimeoutMs({ OMPCC_HANDSHAKE_TIMEOUT_MS: "60000" })).toBe(60_000);
    for (const value of [undefined, "", "0", "-5", "1.5", "soon"])
      expect(handshakeTimeoutMs({ OMPCC_HANDSHAKE_TIMEOUT_MS: value })).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS);
  });

  it("leaves no handshake timeout timer behind once the handshake answers", async () => {
    vi.useFakeTimers();
    const client = await startFake();
    try {
      expect(await client.handshake(HANDSHAKE)).toMatchObject({ ok: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      // The pipe-drop fallback after exit must run on a real timer.
      vi.useRealTimers();
    }
    expect(await client.close()).toEqual({ code: 0, signal: null, stderrTail: "", forced: null });
  });
});

describe("commands", () => {
  it("correlates concurrent responses by id", async () => {
    const client = await startFake();
    await client.handshake(HANDSHAKE);
    const [state, stats] = await Promise.all([
      client.request({ type: "get_state" }),
      client.request({ type: "get_session_stats" }),
    ]);
    expect(state).toMatchObject({
      ok: true,
      value: { command: "get_state", data: { dumpTools: expect.any(Array) } },
    });
    expect(stats).toMatchObject({
      ok: true,
      value: { command: "get_session_stats", data: { assistantMessages: 0 } },
    });
  });

  it("returns omp's refusal", async () => {
    const client = await startFake();
    expect(await client.request({ type: "frobnicate" })).toEqual({
      ok: false,
      error: { kind: "rejected", command: "frobnicate", message: "Unknown command: frobnicate" },
    });
  });

  it("refuses to send after close", async () => {
    const client = await startFake();
    await client.close();
    expect(await client.request({ type: "get_state" })).toMatchObject({
      ok: false,
      error: { kind: "exited" },
    });
  });

  it("fails a request whose process has its stdin closed but is still running", async () => {
    const client = await startFake({ FAKE_OMP_SCENARIO: "sleep" });
    await client.handshake(HANDSHAKE);
    void client.prompt("sleep");
    const closing = client.close();
    expect(await client.request({ type: "get_state" })).toEqual({
      ok: false,
      error: { kind: "closed", message: "omp's stdin is closed; no further commands can be sent" },
    });
    client.kill("SIGKILL");
    await closing;
  });
});

describe("turns", () => {
  it("runs a turn: host tool before tool start, report accepted, prompt_result completed and settled", async () => {
    const calls: HostToolCall[] = [];
    const client = await startFake(
      { FAKE_OMP_REPORT: '{"status":"done","summary":"ok"}' },
      {
        onHostToolCall: (call) => {
          calls.push(call);
          return { text: "Report received." };
        },
      },
    );
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    const turn = await client.prompt("Do the thing.");
    expect(turn).toMatchObject({
      ok: true,
      value: { result: { status: "completed", agentInvoked: true, sessionSettled: true } },
    });
    expect(calls).toMatchObject([
      { toolName: "submit_report", arguments: { status: "done", summary: "ok" } },
    ]);
    const types = seen.map((frame) => frame.type);
    expect(types.indexOf("host_tool_call")).toBeLessThan(types.indexOf("tool_execution_start"));
    expect(types).toContain("message_update");
    expect(
      seen.filter((frame) => frame.type === "message_end").map((frame) => (frame.message as Frame).role),
    ).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("passes the host's rejections back until it accepts", async () => {
    let calls = 0;
    const client = await startFake(
      {},
      {
        onHostToolCall: () => {
          calls += 1;
          return calls < 3
            ? { text: "files.0.path: expected string", isError: true }
            : { text: "Report received." };
        },
      },
    );
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    expect(await client.prompt("go")).toMatchObject({ ok: true, value: { result: { status: "completed" } } });
    expect(calls).toBe(3);
    const ends = seen.filter((frame) => frame.type === "tool_execution_end");
    expect(ends.map((frame) => frame.isError)).toEqual([true, true, false]);
    expect(JSON.stringify(ends[0])).toContain("files.0.path: expected string");
  });

  it.each([
    [
      "a handler that throws",
      {
        onHostToolCall: () => {
          throw new Error("validator crashed");
        },
      },
      "validator crashed",
    ],
    ["no handler", {}, "No host tool named submit_report."],
  ])("replies isError for %s", async (_, options, text) => {
    const client = await startFake({}, options);
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    await client.prompt("go");
    const end = seen.find((frame) => frame.type === "tool_execution_end");
    expect(end).toMatchObject({ isError: true, result: { content: [{ type: "text", text }] } });
  });

  it("replies isError when the handler returns something that is not a reply", async () => {
    const client = await startFake({}, { onHostToolCall: () => undefined as unknown as HostToolReply });
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    expect(await client.prompt("go")).toMatchObject({ ok: true, value: { result: { status: "completed" } } });
    const ends = seen.filter((frame) => frame.type === "tool_execution_end");
    expect(ends.map((frame) => frame.isError)).toEqual([true, true, true]);
    expect(JSON.stringify(ends[0])).toContain("did not return a reply");
  });

  it("waits for session_settled when prompt_result says the session is not settled", async () => {
    const client = await startFake({ FAKE_OMP_LATE_SETTLE: "1" }, { onHostToolCall: accept });
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    const turn = await client.prompt("go");
    expect(turn).toMatchObject({ ok: true, value: { result: { sessionSettled: false } } });
    await waitForFrame(seen, (frame) => frame.type === "session_settled");
    const result = seen.findIndex((frame) => frame.type === "prompt_result");
    expect(seen.slice(result + 1).map((frame) => frame.type)).toEqual(["session_settled"]);
    if (turn.ok) expect(turn.value.endedAt - turn.value.promptSentAt).toBeGreaterThanOrEqual(100);
  });

  it("settles a turn whose prompt ran no agent, without waiting for session_settled", async () => {
    const client = await startFake({ FAKE_OMP_NO_AGENT: "1" });
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    const turn = await client.prompt("go");
    expect(turn).toMatchObject({
      ok: true,
      value: { result: { status: "completed", agentInvoked: false, sessionSettled: false } },
    });
    expect(await client.close()).toEqual({ code: 0, signal: null, stderrTail: "", forced: null });
    expect(seen.map((frame) => frame.type)).not.toContain("session_settled");
  });

  it("aborts a running tool: the turn ends aborted", async () => {
    const client = await startFake({ FAKE_OMP_SCENARIO: "sleep" });
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    const turn = client.prompt("sleep");
    await waitForFrame(seen, (frame) => frame.type === "tool_execution_start");
    expect(await client.abort()).toMatchObject({ ok: true, value: { command: "abort" } });
    expect(await turn).toMatchObject({ ok: true, value: { result: { status: "aborted" } } });
    const ends = seen.filter((frame) => frame.type === "message_end").map((frame) => frame.message as Frame);
    expect(ends.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });

  it("aborts the host-tool handler on host_tool_cancel and sends no result", async () => {
    const dir = tempDir();
    const log = { stdout: join(dir, "a.jsonl"), stdin: join(dir, "b.jsonl"), promptRef: "ref" };
    let cancelled = false;
    const client = await startFake(
      {},
      {
        log,
        onHostToolCall: (_, signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => {
              cancelled = true;
              resolve({ text: "too late" });
            }),
          ),
      },
    );
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    const turn = client.prompt("go");
    await waitForFrame(seen, (frame) => frame.type === "host_tool_call");
    await client.abort();
    expect(await turn).toMatchObject({ ok: true, value: { result: { status: "aborted" } } });
    expect(cancelled).toBe(true);
    await client.close();
    expect(seen.map((frame) => frame.type)).toContain("host_tool_cancel");
    expect(lines(log.stdin).map((line) => JSON.parse(line).type)).not.toContain("host_tool_result");
  });

  it("an omp that ignores abort leaves the turn open until it is killed", async () => {
    const client = await startFake({ FAKE_OMP_SCENARIO: "ignore-abort" });
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    const turn = client.prompt("sleep");
    await waitForFrame(seen, (frame) => frame.type === "tool_execution_start");
    expect(await client.abort()).toMatchObject({ ok: true });
    client.kill("SIGTERM");
    const early = await Promise.race([turn, delay(300, "still running")]);
    expect(early).toBe("still running");
    client.kill("SIGKILL");
    expect(await turn).toMatchObject({ ok: false, error: { kind: "exited", exit: { signal: "SIGKILL" } } });
  });

  it("abort reaches a bash child in its own process group", async () => {
    const pidFile = join(tempDir(), "child.pid");
    const client = await startFake({ FAKE_OMP_SCENARIO: "bash-child", FAKE_OMP_CHILD_PIDFILE: pidFile });
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    const turn = client.prompt("run it");
    await waitForFrame(seen, (frame) => frame.type === "tool_execution_start");
    const child = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(child)).toBe(true);
    await client.abort();
    expect(await turn).toMatchObject({ ok: true, value: { result: { status: "aborted" } } });
    for (let i = 0; i < 100 && isAlive(child); i += 1) await delay(20);
    expect(isAlive(child)).toBe(false);
  });

  it("a crash mid-turn fails the turn with the exit and the stderr tail", async () => {
    const client = await startFake({ FAKE_OMP_SCENARIO: "crash" });
    await client.handshake(HANDSHAKE);
    expect(await client.prompt("go")).toEqual({
      ok: false,
      error: {
        kind: "exited",
        message: "omp ended (exit code 1): fake omp: simulated crash",
        exit: { code: 1, signal: null, stderrTail: "fake omp: simulated crash\n", forced: null },
      },
    });
  });

  it("returns omp's refusal of a prompt", async () => {
    const client = await startFake({ FAKE_OMP_SCENARIO: "sleep" });
    await client.handshake(HANDSHAKE);
    void client.prompt("first");
    expect(await client.prompt("second")).toMatchObject({
      ok: false,
      error: { kind: "rejected", command: "prompt" },
    });
  });
});

describe("large frames", () => {
  it("reassembles v2 rpc_chunk frames and logs tool details cut to head and tail", async () => {
    const dir = tempDir();
    const log = {
      stdout: join(dir, "a.jsonl"),
      stdin: join(dir, "b.jsonl"),
      promptRef: "job.json#attempts[0].prompt",
    };
    const client = await startFake(
      { FAKE_OMP_SCENARIO: "big-frame", FAKE_OMP_WIRE_LOG: join(dir, "wire.jsonl") },
      { log, onHostToolCall: accept },
    );
    const seen = collect(client);
    await client.handshake(HANDSHAKE);
    expect(await client.prompt("read big.txt")).toMatchObject({
      ok: true,
      value: { result: { status: "completed" } },
    });
    await client.close();
    const end = seen.find((frame) => frame.type === "tool_execution_end") as Frame & {
      result: { details: { displayContent: { text: string } } };
    };
    expect(end.result.details.displayContent.text).toHaveLength(3 * 1024 * 1024);
    const logged = lines(log.stdout);
    expect(logged).toHaveLength(seen.length);
    expect(Math.max(...logged.map((line) => line.length))).toBeLessThan(40 * 1024 + 3 * LOG_KEEP);
    expect(logged.some((line) => line.includes("rpc_chunk"))).toBe(false);
    // The wire itself carried the two big frames as rpc_chunk runs; only the client reassembled them.
    const wireFrames = lines(join(dir, "wire.jsonl")).map((line) => JSON.parse(line) as WireFrame);
    const chunks = wireFrames.filter((frame) => frame.type === "rpc_chunk");
    expect(new Set(chunks.map((frame) => frame.chunkId)).size).toBe(2);
    for (const chunk of chunks) expect(chunk.byteLength).toBeGreaterThan(1024 * 1024);
    expect(wireFrames.some((frame) => frame.type === "tool_execution_end" && frame.toolName === "read")).toBe(
      false,
    );
    expect(
      JSON.parse(logged.find((line) => line.startsWith('{"type":"tool_execution_end"')) ?? "{}").result
        .details,
    ).toEqual({
      $truncated: JSON.stringify(end.result.details).length,
      head: expect.any(String),
      tail: expect.any(String),
    });
    expect(lines(log.stdin).find((line) => line.includes('"prompt"'))).toMatch(
      /"message":\{"\$ref":"job.json#attempts\[0\].prompt"\}/,
    );
  });
});

describe("close and exit", () => {
  it("close keeps draining stdout, so a frame sent after close still arrives", async () => {
    // No host tools: a turn omp can finish without us, since close() has already closed our side.
    const client = await startFake({ FAKE_OMP_LATE_SETTLE: "1" });
    const seen = collect(client);
    await client.handshake({ ...HANDSHAKE, hostTools: [] });
    const turn = client.prompt("go");
    const closing = client.close();
    await waitForFrame(seen, (frame) => frame.type === "session_settled");
    expect(await turn).toMatchObject({ ok: true, value: { result: { sessionSettled: false } } });
    expect(await closing).toEqual({ code: 0, signal: null, stderrTail: "", forced: null });
    const after: Frame[] = [];
    for await (const frame of client.frames) after.push(frame);
    expect(after).toEqual([]);
  });

  it("drops the pipes shortly after exit when a grandchild holds stdout", async () => {
    const pidFile = join(tempDir(), "pids");
    const client = await startFake({ FAKE_OMP_PIDFILE: pidFile });
    await client.handshake(HANDSHAKE);
    const grandchild = Number(readFileSync(pidFile, "utf8").split(" ")[1]);
    try {
      const started = Date.now();
      expect(await client.close()).toMatchObject({ code: 0 });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(isAlive(grandchild)).toBe(true);
    } finally {
      process.kill(grandchild, "SIGKILL");
    }
  });

  it("reports a missing binary as a start error", async () => {
    const started = await startOmpRpc({ command: "/nonexistent/omp", args: [], cwd: tempDir(), env: {} });
    expect(started).toMatchObject({
      ok: false,
      error: { kind: "start", message: expect.stringContaining("ENOENT") },
    });
  });

  it("reports a log it cannot open as a start error", async () => {
    const file = join(tempDir(), "file");
    writeFileSync(file, "");
    for (const log of [
      { stdout: join(file, "a.jsonl"), stdin: join(tempDir(), "b.jsonl"), promptRef: "r" },
      { stdout: join(tempDir(), "a.jsonl"), stdin: join(file, "b.jsonl"), promptRef: "r" },
    ]) {
      const started = await startOmpRpc({
        command: FAKE_OMP,
        args: READONLY_ARGS,
        cwd: tempDir(),
        env: {},
        log,
      });
      expect(started).toMatchObject({
        ok: false,
        error: { kind: "start", message: expect.stringContaining("cannot open log") },
      });
    }
  });
});
