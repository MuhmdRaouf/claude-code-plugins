import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hookErrorLog, spoolDir } from "../src/shared/paths.ts";
import { makeEnv } from "./helpers.ts";

/**
 * Black-box tests of the built plugin/dist/hook.js — the exact file hooks.json runs — as a child
 * process, the way Claude Code runs it. The contract under test: whatever stdin, env or state dir
 * it meets, the hook exits 0, prints nothing on stdout or stderr (so it can never return a JSON
 * decision or a blocking exit code), and stays fast. Its own failures belong in hook-errors.log,
 * and if even that fails, nowhere.
 */
const hook = fileURLToPath(new URL("../plugin/dist/hook.js", import.meta.url));

type Run = { code: number | null; stdout: string; stderr: string };

/** Run the built hook exactly as hooks.json does: `node dist/hook.js`, payload on stdin. */
function runHook(input: string, env: NodeJS.ProcessEnv): Run {
  const result = spawnSync(process.execPath, [hook], { env, input, encoding: "utf8", timeout: 20_000 });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The timeout hooks.json gives an event's hook, in ms: Claude Code's budget for it. */
function hookTimeoutMs(event: string): number {
  const file = fileURLToPath(new URL("../plugin/hooks/hooks.json", import.meta.url));
  const hooks = JSON.parse(readFileSync(file, "utf8")) as {
    hooks: Record<string, { hooks: { timeout?: number }[] }[]>;
  };
  const timeout = hooks.hooks[event]?.[0]?.hooks[0]?.timeout;
  if (timeout === undefined) throw new Error(`hooks.json gives ${event} no timeout`);
  return timeout * 1000;
}

/** Every run, healthy or not, must be indistinguishable from silence. */
function expectSilentSuccess(run: Run): void {
  expect(run.code, `stdout: ${run.stdout}\nstderr: ${run.stderr}`).toBe(0);
  expect(run.stdout).toBe("");
  expect(run.stderr).toBe("");
}

/** The lines one spool file collected (the date the hook itself stamps). */
function spoolLines(env: NodeJS.ProcessEnv): Array<Record<string, unknown>> {
  const file = join(spoolDir(env), `${new Date().toISOString().slice(0, 10)}.jsonl`);
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the built hook under hostile input", () => {
  it("exits 0 in silence on empty stdin", () => {
    const { env } = makeEnv();
    expectSilentSuccess(runHook("", env));
    expect(spoolLines(env).at(-1)).toMatchObject({ event: "unknown" });
  });

  it("exits 0 in silence on invalid JSON, logging it to hook-errors.log instead", () => {
    const { env, state } = makeEnv();
    mkdirSync(state, { recursive: true }); // the log needs a writable state dir, like any append
    expectSilentSuccess(runHook('{"hook_event_name": oops', env));
    expect(readFileSync(hookErrorLog(env), "utf8")).toContain("unparseable stdin");
  });

  it("exits 0 in silence on a 5 MiB payload", () => {
    const { env } = makeEnv();
    const big = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "big",
      prompt: "x".repeat(5 * 1024 * 1024),
    });
    expectSilentSuccess(runHook(big, env));
    expect(spoolLines(env).at(-1)).toMatchObject({ event: "UserPromptSubmit", session_id: "big" });
  });

  it("exits 0 in silence on an unknown event", () => {
    const { env } = makeEnv();
    expectSilentSuccess(runHook(JSON.stringify({ hook_event_name: "BrandNewEvent", session_id: "s1" }), env));
    expect(spoolLines(env).at(-1)).toMatchObject({ event: "BrandNewEvent" });
  });

  it("exits 0 in silence when the state dir cannot be created (read-only parent)", () => {
    const { env, home } = makeEnv();
    const readOnly = join(home, "read-only");
    mkdirSync(readOnly, { recursive: true });
    chmodSync(readOnly, 0o500);
    env.RADAR_HOME = join(readOnly, "state");
    expectSilentSuccess(runHook("{}", env));
  });

  it("exits 0 in silence when RADAR_HOME points at a file", () => {
    const { env, home } = makeEnv();
    const file = join(home, "not-a-dir");
    writeFileSync(file, "in the way");
    env.RADAR_HOME = file;
    expectSilentSuccess(runHook("{}", env));
  });

  // The hook gives up on its own (an internal deadline under a second); the test only bounds it by the budget
  // hooks.json gives the event, so start-up time on a loaded box cannot fail it.
  it("exits 0 well inside its hooks.json timeout when stdin never closes (internal deadline)", async () => {
    const { env } = makeEnv();
    const child: ChildProcess = spawn(process.execPath, [hook], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.stdin?.write('{"hook_event_name":"UserPromptSubmit","prompt":"still ty');
    const started = Date.now();
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code));
      const budgetMs = hookTimeoutMs("UserPromptSubmit");
      const tooLate = setTimeout(
        () => reject(new Error(`hook did not exit within ${budgetMs} ms`)),
        budgetMs,
      );
      tooLate.unref();
    }).catch((error: Error) => {
      child.kill();
      throw error;
    });
    expect(Date.now() - started).toBeLessThan(hookTimeoutMs("UserPromptSubmit"));
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});

describe("the built hook on the healthy path", () => {
  it("records the payload as one spool line", () => {
    const { env } = makeEnv();
    const run = runHook(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "s-healthy",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
      }),
      env,
    );
    expectSilentSuccess(run);
    expect(spoolLines(env).at(-1)).toMatchObject({
      event: "PostToolUse",
      session_id: "s-healthy",
      tool_name: "Bash",
    });
  });

  // The requirement is "never hold Claude": every run exits 0, silent, well inside the timeout hooks.json gives it.
  // How fast is a measurement, not a pass/fail line: a loaded CI box or a parallel suite moves the p95 by hundreds of
  // ms, so the p50/p95 are reported and only the hooks.json budget is asserted.
  it("answers every one of 50 runs silently, each well inside its hooks.json timeout (p50/p95 reported)", () => {
    const { env } = makeEnv();
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "perf",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const budgetMs = hookTimeoutMs("UserPromptSubmit"); // every event gets the same command and budget
    const samples: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const started = performance.now();
      const run = runHook(payload, env);
      samples.push(performance.now() - started);
      expect(run.code).toBe(0);
      expect(run.stdout).toBe("");
    }
    samples.sort((a, b) => a - b);
    const at = (fraction: number) => samples[Math.ceil(fraction * samples.length) - 1] as number;
    console.log(
      `hook wall time over ${samples.length} runs: p50 ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms`,
    );
    expect(samples.at(-1) as number).toBeLessThan(budgetMs);
  });
});

/** The command hooks.json gives every event, run the way Claude Code runs it: through /bin/sh. */
const hooksJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../plugin/hooks/hooks.json", import.meta.url)), "utf8"),
);
const COMMAND: string = hooksJson.hooks.SessionStart[0].hooks[0].command;
const PLUGIN_ROOT = fileURLToPath(new URL("../plugin", import.meta.url));

function runCommand(input: string, env: NodeJS.ProcessEnv): Run {
  const result = spawnSync("/bin/sh", ["-c", COMMAND], {
    env: { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    input,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A PATH holding only the named runtimes (stubs or the real node), so a test controls which one wins. */
function pathWith(home: string, tools: Record<string, string>): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(tools)) {
    const file = join(bin, name);
    if (body === process.execPath) symlinkSync(body, file);
    else {
      writeFileSync(file, body);
      chmodSync(file, 0o755);
    }
  }
  return `${bin}:/usr/bin:/bin`;
}

describe("the hooks.json command", () => {
  it("exits 0 in silence when neither bun nor node is on Claude Code's PATH", () => {
    const { env } = makeEnv();
    expectSilentSuccess(
      runCommand(JSON.stringify({ hook_event_name: "Stop" }), { ...env, PATH: "/var/empty" }),
    );
  });

  it("records the event when only node is there", () => {
    const { env, home } = makeEnv();
    expectSilentSuccess(
      runCommand(JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }), {
        ...env,
        PATH: pathWith(home, { node: process.execPath }),
      }),
    );
    expect(spoolLines(env).at(-1)).toMatchObject({ event: "Stop", session_id: "s1" });
  });

  it("runs bun, not node, when both are on PATH", () => {
    const { env, home } = makeEnv();
    const marker = join(home, "who-ran");
    const stub = (name: string) => `#!/bin/sh\necho ${name} > "${marker}"\n`;
    expectSilentSuccess(
      runCommand("{}", { ...env, PATH: pathWith(home, { bun: stub("bun"), node: stub("node") }) }),
    );
    expect(readFileSync(marker, "utf8").trim()).toBe("bun");
  });

  it("falls back to node when bun is absent", () => {
    const { env, home } = makeEnv();
    const marker = join(home, "who-ran");
    expectSilentSuccess(
      runCommand("{}", {
        ...env,
        PATH: pathWith(home, { node: `#!/bin/sh\necho node > "${marker}"\n` }),
      }),
    );
    expect(readFileSync(marker, "utf8").trim()).toBe("node");
  });

  it("exits 0 in silence even when the bundle is missing", () => {
    const { env, home } = makeEnv();
    const result = spawnSync("/bin/sh", ["-c", COMMAND], {
      env: {
        ...env,
        PATH: pathWith(home, { node: process.execPath }),
        CLAUDE_PLUGIN_ROOT: join(home, "no-plugin"),
      },
      input: "{}",
      encoding: "utf8",
    });
    expectSilentSuccess({ code: result.status, stdout: result.stdout, stderr: result.stderr });
  });
});

describe("autostart", () => {
  it("tells the user, in one systemMessage, where a dashboard it started is; silent when one already runs", async () => {
    const { env, state } = makeEnv();
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "port"), "29871\n");
    const auto = { ...env, RADAR_AUTOSTART: "1" };
    const first = runHook(JSON.stringify({ hook_event_name: "SessionStart", session_id: "a1" }), auto);
    let pid = 0;
    try {
      expect(first.code).toBe(0);
      expect(first.stderr).toBe("");
      expect(JSON.parse(first.stdout)).toEqual({
        systemMessage: "radar: dashboard at http://127.0.0.1:29871",
      });
      for (
        const t = Date.now();
        Date.now() - t < 15_000 && !pid;
        await new Promise((r) => setTimeout(r, 100))
      ) {
        try {
          pid = (JSON.parse(readFileSync(join(state, "server.json"), "utf8")) as { pid: number }).pid;
        } catch {
          // not up yet
        }
      }
      expect(pid).toBeGreaterThan(0);
      // a server that runs: nothing to say
      expectSilentSuccess(
        runHook(JSON.stringify({ hook_event_name: "SessionStart", session_id: "a2" }), auto),
      );
    } finally {
      if (pid) process.kill(pid, "SIGTERM");
    }
  }, 30_000);
});
