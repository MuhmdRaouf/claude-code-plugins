import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ENV_ALLOWLIST } from "../../src/adapters/env.ts";
import { createShellGates, lastLines } from "../../src/adapters/shell-gates.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";
import { isPidAlive } from "../support/wait.ts";

describe("shell gates", () => {
  it("runs the command in cwd with sh -c and records exit code and duration", async () => {
    const cwd = tempDir();
    const logPath = join(tempDir(), "logs", "gate-1-0.log");
    const gates = createShellGates(REFERENCE_PROVIDER.name);

    const passed = await gates.run(
      cwd,
      { run: 'pwd && sleep 0.2 && test -n "$0"', timeoutMs: 5000 },
      {},
      logPath,
    );
    const failed = await gates.run(cwd, { run: "echo boom >&2; exit 3", timeoutMs: 5000 }, {}, logPath);

    expect(passed).toMatchObject({ exitCode: 0, timedOut: false, tail: `${cwd}\n` });
    expect(passed.durationMs).toBeGreaterThanOrEqual(200);
    expect(passed.durationMs).toBeLessThan(10_000);
    expect(failed).toMatchObject({
      run: "echo boom >&2; exit 3",
      exitCode: 3,
      timedOut: false,
      tail: "boom\n",
    });
    expect(readFileSync(logPath, "utf8")).toBe("boom\n");
  });
  it("keeps the last 60 lines / 8000 chars as tail and the full output in the log file", async () => {
    const cwd = tempDir();
    const logPath = join(cwd, "gate.log");
    const gates = createShellGates(REFERENCE_PROVIDER.name);
    const manyLines = 'i=1; while [ $i -le 5000 ]; do echo "line $i"; i=$((i+1)); done';
    const longLines = `for i in 1 2 3; do printf '%0200d\\n' $i; done; ${"printf '%0300d\\n' 7; ".repeat(40)}`;

    const lines = await gates.run(cwd, { run: manyLines, timeoutMs: 10_000 }, {}, logPath);
    const fullLog = readFileSync(logPath, "utf8");
    const chars = await gates.run(cwd, { run: longLines, timeoutMs: 10_000 }, {}, logPath);

    const expectedLines = Array.from({ length: 60 }, (_, i) => `line ${4941 + i}\n`).join("");
    expect(lines.tail).toBe(expectedLines);
    expect(fullLog.split("\n")).toHaveLength(5001);
    expect(fullLog.startsWith("line 1\nline 2\n")).toBe(true);
    expect(chars.tail.length).toBe(8000);
    expect(readFileSync(logPath, "utf8").endsWith(chars.tail)).toBe(true);
    expect(readFileSync(logPath, "utf8").length).toBe(3 * 201 + 40 * 301);
  });

  it("lastLines counts a trailing newline as the end of the last line", () => {
    expect(lastLines("a\nb\nc\n", 2)).toBe("b\nc\n");
    expect(lastLines("a\nb\nc", 2)).toBe("b\nc");
    expect(lastLines("a\nb\n", 5)).toBe("a\nb\n");
    expect(lastLines("\n\n", 5)).toBe("\n\n");
    expect(lastLines("", 3)).toBe("");
  });
  it("kills the process group on timeout: timedOut true, exitCode null", async () => {
    const cwd = tempDir();
    // The timeout starts at spawn: 1.5 s leaves the shell time to start its background job and write bg.pid first.
    const gate = { run: "sleep 30 & echo $! > bg.pid; echo started; sleep 30", timeoutMs: 1500 };

    const result = await createShellGates(REFERENCE_PROVIDER.name).run(cwd, gate, {}, join(cwd, "gate.log"));

    // The shell may still report its killed background job before it dies itself.
    expect(result).toMatchObject({
      exitCode: null,
      timedOut: true,
      tail: expect.stringMatching(/^started\n/),
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(1500);
    expect(result.durationMs).toBeLessThan(10_000);
    const background = Number(readFileSync(join(cwd, "bg.pid"), "utf8"));
    await expect.poll(() => isPidAlive(background), { timeout: 5000 }).toBe(false);
  });

  it("SIGKILLs a group that ignores SIGTERM after the grace period", async () => {
    const cwd = tempDir();
    // 1 s for the shell to install its trap before the SIGTERM comes; a TERM before the trap would end it at once.
    const gate = { run: "trap '' TERM; sleep 30 & echo $! > bg.pid; wait; wait", timeoutMs: 1000 };

    const result = await createShellGates(REFERENCE_PROVIDER.name).run(cwd, gate, {}, join(cwd, "gate.log"));

    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(result.durationMs).toBeGreaterThanOrEqual(3000);
    expect(result.durationMs).toBeLessThan(15_000);
    const background = Number(readFileSync(join(cwd, "bg.pid"), "utf8"));
    await expect.poll(() => isPidAlive(background), { timeout: 5000 }).toBe(false);
  });

  it("kills background leftovers when the gate itself exits", async () => {
    const cwd = tempDir();
    const gate = { run: "sleep 30 > /dev/null 2>&1 & echo $! > bg.pid; echo done", timeoutMs: 5000 };

    const result = await createShellGates(REFERENCE_PROVIDER.name).run(cwd, gate, {}, join(cwd, "gate.log"));

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, tail: "done\n" });
    const background = Number(readFileSync(join(cwd, "bg.pid"), "utf8"));
    await expect.poll(() => isPidAlive(background), { timeout: 5000 }).toBe(false);
  });

  it("does not wait for a detached holder of the output pipe beyond a short drain", async () => {
    const cwd = tempDir();
    // A new session escapes the group kill and keeps stdout open.
    const escapingHolder = `${JSON.stringify(process.execPath)} -e "const c = require('child_process').spawn('sleep', ['30'], { detached: true, stdio: ['ignore', 1, 2] }); require('fs').writeFileSync('holder.pid', String(c.pid)); c.unref()"`;

    const result = await createShellGates(REFERENCE_PROVIDER.name).run(
      cwd,
      { run: `${escapingHolder}; echo out`, timeoutMs: 10_000 },
      {},
      join(cwd, "g.log"),
    );

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, tail: "out\n" });
    expect(result.durationMs).toBeLessThan(10_000);
    process.kill(Number(readFileSync(join(cwd, "holder.pid"), "utf8")), "SIGKILL");
  });

  it("a gate that cannot start fails with the reason in the tail", async () => {
    const cwd = join(tempDir(), "missing");
    const result = await createShellGates(REFERENCE_PROVIDER.name).run(
      cwd,
      { run: "true", timeoutMs: 1000 },
      {},
      join(tempDir(), "g.log"),
    );
    expect(result).toMatchObject({
      exitCode: null,
      timedOut: false,
      tail: expect.stringContaining("could not start gate"),
    });
  });
  it("passes allowlisted env plus passEnv only", async () => {
    const cwd = tempDir();
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "orchestrator-secret");
    vi.stubEnv("ZAI_API_KEY", "zai-secret");
    vi.stubEnv("LANG", "C.UTF-8");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    const result = await createShellGates(REFERENCE_PROVIDER.name).run(
      cwd,
      { run: "env | LC_ALL=C sort", timeoutMs: 5000 },
      { ZAI_ARTIFACTS: "/tmp/artifacts", PATH: "/custom/bin:/usr/bin:/bin" },
      join(cwd, "env.log"),
    );

    const names = result.tail
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(0, line.indexOf("=")));
    const allowed = new Set<string>([...ENV_ALLOWLIST, "ZAI_ARTIFACTS", "PWD", "SHLVL", "_", "OLDPWD"]);
    expect(names.filter((name) => !allowed.has(name))).toEqual([]);
    expect(result.tail).toContain("ZAI_ARTIFACTS=/tmp/artifacts\n");
    expect(result.tail).toContain("PATH=/custom/bin:/usr/bin:/bin\n");
    expect(result.tail).toContain("LANG=C.UTF-8\n");
    expect(result.tail).not.toContain("secret");
  });
});
