import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { type StreamCommand, startStreaming } from "../../../src/adapters/process/stream.ts";
import { tempDir } from "../../support/tmp.ts";
import { isPidAlive as isAlive, untilGone } from "../../support/wait.ts";

/** `node -e script` in a temp dir, logging stdout to out.log there. */
function node(
  script: string,
  overrides: Partial<StreamCommand> = {},
): StreamCommand & { readonly logPath: string } {
  const dir = tempDir("core-stream-");
  return {
    command: process.execPath,
    args: ["-e", script],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "" },
    stdin: "",
    logPath: join(dir, "logs", "out.log"),
    timeoutMs: 30_000,
    graceMs: 1_000,
    ...overrides,
  };
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const all: string[] = [];
  for await (const line of lines) all.push(line);
  return all;
}

describe("startStreaming", () => {
  it("streams stdout line by line, logs it byte for byte, and keeps a last line without a newline", async () => {
    // "é" is split across two writes: the decoder must not tear it.
    const script = `
      process.stdout.write("one\\ntw");
      process.stdout.write(Buffer.from([0x6f, 0xc3]));
      setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a, 0x6c, 0x61, 0x73, 0x74])), 20);`;
    const cmd = node(script);
    const started = await startStreaming(cmd);
    if (!started.ok) throw new Error(started.error);

    expect(await collect(started.value.lines)).toEqual(["one", "twoé", "last"]);
    expect(await started.value.exit).toEqual({ code: 0, signal: null, stderrTail: "", forced: null });
    expect(readFileSync(cmd.logPath, "utf8")).toBe("one\ntwoé\nlast");
  });

  it("feeds stdin and keeps the tail of stderr", async () => {
    const script = `
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        process.stderr.write("x".repeat(5000) + "END");
        console.log(input.toUpperCase());
        process.exitCode = 3;
      });`;
    const started = await startStreaming(node(script, { stdin: "hello" }));
    if (!started.ok) throw new Error(started.error);

    expect(await collect(started.value.lines)).toEqual(["HELLO"]);
    const exit = await started.value.exit;
    expect(exit.code).toBe(3);
    expect(exit.stderrTail).toHaveLength(4_000);
    expect(exit.stderrTail.endsWith("xEND")).toBe(true);
  });

  it("a binary that cannot start is an error, not a process", async () => {
    const started = await startStreaming(node("", { command: "/nonexistent/worker-binary" }));

    expect(started).toMatchObject({ ok: false, error: expect.stringContaining("ENOENT") });
  });

  it("a log that cannot be opened is an error before anything starts", async () => {
    const dir = tempDir("core-stream-");
    writeFileSync(join(dir, "file"), "");

    const started = await startStreaming(node("", { logPath: join(dir, "file", "out.log") }));

    expect(started).toMatchObject({ ok: false, error: expect.stringContaining("cannot open log") });
  });

  it("past its timeout the group is terminated and the exit says forced timeout", async () => {
    const started = await startStreaming(node("setInterval(() => {}, 1000)", { timeoutMs: 100 }));
    if (!started.ok) throw new Error(started.error);

    expect(await started.value.exit).toMatchObject({ code: null, signal: "SIGTERM", forced: "timeout" });
  });

  it("interrupt terminates the group and the first reason wins", async () => {
    const started = await startStreaming(node("console.log('up'); setInterval(() => {}, 1000)"));
    if (!started.ok) throw new Error(started.error);
    const lines = started.value.lines[Symbol.asyncIterator]();
    expect((await lines.next()).value).toBe("up");

    await started.value.interrupt("stopped", 1_000);
    await started.value.interrupt("timeout", 1_000);

    expect(await started.value.exit).toMatchObject({ signal: "SIGTERM", forced: "stopped" });
  });
});

/** A scratch cwd for the spawned children. */
function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "engine-"));
}

/** A leader that forks a sleeping grandchild into its (inherited) group, prints its pid, then exits. */
const GRANDCHILD_SCRIPT =
  "const child = require('node:child_process').spawn(" +
  "process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });" +
  "child.unref();" +
  "process.stdout.write(String(child.pid), () => process.exit(0));";

describe("startStreaming as an engine runs it (stdin open, no log)", () => {
  it("does not signal the group after the engine has exited (its pid may be reused)", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const proc = await startStreaming({
        command: "/bin/sleep",
        args: ["0.2"],
        cwd: await scratch(),
        env: {},
        graceMs: 60_000,
      });
      expect(proc.ok).toBe(true);
      if (!proc.ok) return;
      proc.value.signal("SIGTERM");
      expect(kill).toHaveBeenCalledWith(-proc.value.pid, "SIGTERM");
      await proc.value.exit;
      kill.mockClear();
      proc.value.signal("SIGKILL");
      const late = kill.mock.calls.filter(([pid, sig]) => pid === -proc.value.pid && sig === "SIGKILL");
      expect(late).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });

  it("reports a start failure as a Result, not a throw", async () => {
    const proc = await startStreaming({
      command: "/no/such/binary",
      args: [],
      cwd: await scratch(),
      env: {},
    });
    expect(proc.ok).toBe(false);
    if (proc.ok) return;
    expect(proc.error).toContain("ENOENT");
  });

  it('the wall clock times the run out: the exit is forced "timeout" and the group dies', async () => {
    const proc = await startStreaming({
      command: "/bin/sleep",
      args: ["30"],
      cwd: await scratch(),
      env: {},
      timeoutMs: 250,
      graceMs: 500,
    });
    expect(proc.ok).toBe(true);
    if (!proc.ok) return;
    const exit = await proc.value.exit;
    expect(exit.forced).toBe("timeout");
    expect(exit.code).toBe(null);
    expect(exit.signal).not.toBe(null);
  });

  it("interrupt runs the engine's own stop first, then SIGTERMs the group", async () => {
    const order: string[] = [];
    const realKill = process.kill;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0 && signal === "SIGTERM") order.push("term");
      return signal === undefined ? realKill(pid) : realKill(pid, signal);
    });
    try {
      const proc = await startStreaming({
        command: "/bin/sleep",
        args: ["30"],
        cwd: await scratch(),
        env: {},
        graceMs: 5_000,
        soft: async () => {
          order.push("soft");
          await delay(200);
        },
      });
      expect(proc.ok).toBe(true);
      if (!proc.ok) return;
      await proc.value.interrupt("stopped");
      const exit = await proc.value.exit;
      expect(order).toEqual(["soft", "term"]);
      expect(exit.forced).toBe("stopped");
      expect(exit.signal).toBe("SIGTERM");
    } finally {
      kill.mockRestore();
    }
  });

  it("drains stdout even when nobody iterates the lines", async () => {
    const script =
      "process.stdout.write('one\\n'); process.stdout.write('two\\n'); process.stdout.write('three');";
    const proc = await startStreaming({
      command: process.execPath,
      args: ["-e", script],
      cwd: await scratch(),
      env: {},
    });
    expect(proc.ok).toBe(true);
    if (!proc.ok) return;
    const exit = await proc.value.exit;
    expect(exit.code).toBe(0);
    // Reading only after the run has ended still sees every line: nothing was left to backpressure.
    const seen: string[] = [];
    for await (const line of proc.value.lines) seen.push(line);
    expect(seen).toEqual(["one", "two", "three"]);
  });

  it("terminates a leftover grandchild once the leader exits when the engine opts in", async () => {
    const proc = await startStreaming({
      command: process.execPath,
      args: ["-e", GRANDCHILD_SCRIPT],
      cwd: await scratch(),
      env: {},
      graceMs: 2_000,
      reapGroupOnExit: true,
    });
    expect(proc.ok).toBe(true);
    if (!proc.ok) return;
    const exit = await proc.value.exit;
    const seen: string[] = [];
    for await (const line of proc.value.lines) seen.push(line);
    const grandchild = Number(seen[0]);
    expect(grandchild).toSatisfy((pid: number) => Number.isInteger(pid) && pid > 1);
    // The run still ended on its own; only the group it left behind was cleaned up.
    expect(exit.forced).toBe(null);
    expect(exit.code).toBe(0);
    await untilGone(grandchild);
  });

  it("leaves a leftover grandchild alone on leader exit by default", async () => {
    const proc = await startStreaming({
      command: process.execPath,
      args: ["-e", GRANDCHILD_SCRIPT],
      cwd: await scratch(),
      env: {},
      graceMs: 60_000,
    });
    expect(proc.ok).toBe(true);
    if (!proc.ok) return;
    const exit = await proc.value.exit;
    const seen: string[] = [];
    for await (const line of proc.value.lines) seen.push(line);
    const grandchild = Number(seen[0]);
    expect(grandchild).toSatisfy((pid: number) => Number.isInteger(pid) && pid > 1);
    expect(exit.forced).toBe(null);
    // Old behaviour: the grandchild outlives the run, so the test cleans it up itself.
    expect(isAlive(grandchild)).toBe(true);
    process.kill(grandchild, "SIGKILL");
    await untilGone(grandchild);
  });

  it("keeps benign startup stderr out of the tail while still reporting every line", async () => {
    const seen: [string, boolean][] = [];
    const script =
      "process.stderr.write('Still starting after 10s — phase: discover\\n');" +
      "process.stderr.write('FATAL: boom\\n', () => process.exit(3));";
    const proc = await startStreaming(
      {
        command: process.execPath,
        args: ["-e", script],
        cwd: await scratch(),
        env: {},
        isBenignStderr: (line) => /^Still starting after \d+s\b/.test(line),
      },
      (line, benign) => seen.push([line, benign]),
    );
    expect(proc.ok).toBe(true);
    if (!proc.ok) return;
    const exit = await proc.value.exit;
    expect(exit.code).toBe(3);
    expect(exit.stderrTail).toBe("FATAL: boom\n");
    expect(seen).toEqual([
      ["Still starting after 10s — phase: discover", true],
      ["FATAL: boom", false],
    ]);
  });
});
