import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSpoolLine,
  collectModelEnv,
  type HookIo,
  makeIo,
  parsePayload,
  pruneSpool,
  runHook,
} from "../src/hook/record.ts";
import { hookErrorLog, spoolDir } from "../src/shared/paths.ts";
import { DEFAULT_UPSTREAM } from "../src/shared/provider.ts";
import { makeEnv, writeText } from "./helpers.ts";

const NOW = new Date("2026-01-15T06:30:00.000Z");

type FakeIo = {
  io: HookIo;
  appended: Array<{ path: string; text: string }>;
  logged: Array<{ path: string; text: string }>;
};

/** A hook IO that records instead of writing — runHook stays pure enough to test every branch. */
function fakeIo(env: NodeJS.ProcessEnv = {}, appendLine?: (path: string, text: string) => void): FakeIo {
  const appended: Array<{ path: string; text: string }> = [];
  const logged: Array<{ path: string; text: string }> = [];
  const io: HookIo = {
    env,
    now: () => NOW,
    pid: 4242,
    ppid: 4243,
    appendLine: appendLine ?? ((path, text) => appended.push({ path, text })),
    logError: (path, text) => logged.push({ path, text }),
  };
  return { io, appended, logged };
}

describe("parsePayload", () => {
  it("treats blank stdin as an empty payload", () => {
    expect(parsePayload("")).toEqual({});
    expect(parsePayload("  \n ")).toEqual({});
  });

  it("returns JSON objects as-is and folds other JSON shapes into {}", () => {
    expect(parsePayload('{"a":1}')).toEqual({ a: 1 });
    expect(parsePayload("[1,2]")).toEqual({});
    expect(parsePayload('"text"')).toEqual({});
    expect(parsePayload("42")).toEqual({});
  });

  it("returns null only for unparseable input", () => {
    expect(parsePayload("{oops")).toBeNull();
  });
});

describe("collectModelEnv", () => {
  it("keeps model-id vars only, masking their values like any string", () => {
    expect(
      collectModelEnv({
        ANTHROPIC_MODEL: "sk-abcd12345",
        ANTHROPIC_SMALL_FAST_MODEL: "haiku",
        CLAUDE_CODE_SUBAGENT_MODEL: "glm-5.3",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
        ANTHROPIC_API_KEY: "nope",
      }),
    ).toEqual({
      ANTHROPIC_MODEL: "[redacted]",
      ANTHROPIC_SMALL_FAST_MODEL: "haiku",
      CLAUDE_CODE_SUBAGENT_MODEL: "glm-5.3",
    });
  });

  it("returns undefined when nothing matches or values are empty", () => {
    expect(collectModelEnv({ ANTHROPIC_BASE_URL: "http://x", HOME: "/h" })).toBeUndefined();
    expect(collectModelEnv({ ANTHROPIC_MODEL: "" })).toBeUndefined();
  });
});

describe("buildSpoolLine", () => {
  it("maps every known field, scrubs the fuzzy ones and stamps pid/ppid", () => {
    const { io } = fakeIo();
    const line = buildSpoolLine(
      {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        transcript_path: "/t/s1.jsonl",
        cwd: "/w/app",
        agent_type: "general-purpose",
        tool_name: "Bash",
        tool_use_id: "tu1",
        source: "startup",
        reason: "clear",
        trigger: "prompt",
        prompt: "hello Bearer abc123 token",
        tool_input: { command: "ls", api_key: "zzz" },
        tool_response: { ok: true, token: "Bearer sk-abcdefgh12" },
      },
      io,
    );
    expect(line).toEqual({
      ts: NOW.toISOString(),
      event: "PreToolUse",
      session_id: "s1",
      transcript_path: "/t/s1.jsonl",
      cwd: "/w/app",
      agent_type: "general-purpose",
      tool_name: "Bash",
      tool_use_id: "tu1",
      source: "startup",
      reason: "clear",
      trigger: "prompt",
      prompt: "hello Bearer [redacted] token",
      tool_input: { command: "ls", api_key: "[redacted]" },
      tool_response: { ok: true, token: "[redacted]" },
      pid: 4242,
      ppid: 4243,
    });
  });

  it("defaults the event to unknown and prefers agent_id over agentId", () => {
    const { io } = fakeIo();
    expect(buildSpoolLine({}, io)).toEqual({
      ts: NOW.toISOString(),
      event: "unknown",
      pid: 4242,
      ppid: 4243,
    });
    expect(buildSpoolLine({ agentId: "w1" }, io)).toMatchObject({ event: "unknown", agent_id: "w1" });
    expect(buildSpoolLine({ agent_id: "first", agentId: "second" }, io)).toMatchObject({ agent_id: "first" });
  });

  it("adds upstream, model env and version on SessionStart only", () => {
    const bare = fakeIo();
    expect(buildSpoolLine({ hook_event_name: "SessionStart" }, bare.io)).toEqual({
      ts: NOW.toISOString(),
      event: "SessionStart",
      base_url: DEFAULT_UPSTREAM,
      pid: 4242,
      ppid: 4243,
    });
    const rich = fakeIo({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      CLAUDE_CODE_VERSION: "2.1.0",
      CLAUDE_CODE_MODEL: "glm-5.3",
    });
    expect(buildSpoolLine({ hook_event_name: "SessionStart" }, rich.io)).toMatchObject({
      base_url: "http://127.0.0.1:8787",
      model_env: { CLAUDE_CODE_MODEL: "glm-5.3" },
      cc_version: "2.1.0",
    });
    expect(buildSpoolLine({ hook_event_name: "SessionEnd" }, rich.io)).not.toHaveProperty("base_url");
  });

  it("rides unknown keys along scrubbed and never duplicates its own", () => {
    const { io } = fakeIo();
    const line = buildSpoolLine(
      {
        event: "hijack",
        hook_event_name: "Notification",
        pid: 999,
        base_url: "http://elsewhere",
        surprise: "sk-abcdefgh99",
        nested: { password: "hunter2", safe: 1 },
      },
      io,
    );
    expect(line.event).toBe("Notification");
    expect(line.pid).toBe(4242);
    expect(line.base_url).toBeUndefined();
    expect(line.surprise).toBe("[redacted]");
    expect(line.nested).toEqual({ password: "[redacted]", safe: 1 });
  });
});

describe("runHook", () => {
  it("appends one spool line for the payload's date and returns the event name", () => {
    const { env } = makeEnv();
    const { io, appended } = fakeIo(env);
    const result = runHook(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "hi" }),
      io,
    );
    expect(result).toBe("UserPromptSubmit");
    expect(appended).toHaveLength(1);
    expect(appended[0]?.path).toBe(join(spoolDir(env), "2026-01-15.jsonl"));
    expect(appended[0]?.text.endsWith("\n")).toBe(true);
    expect(JSON.parse(appended[0]?.text ?? "")).toMatchObject({
      ts: NOW.toISOString(),
      event: "UserPromptSubmit",
      session_id: "s1",
      prompt: "hi",
      pid: 4242,
    });
  });

  it("records blank stdin as an unknown event", () => {
    const { env } = makeEnv();
    const { io, appended } = fakeIo(env);
    expect(runHook("   ", io)).toBe("unknown");
    expect(JSON.parse(appended[0]?.text ?? "")).toMatchObject({ event: "unknown" });
  });

  it("logs unparseable stdin instead of appending", () => {
    const { env } = makeEnv();
    const { io, appended, logged } = fakeIo(env);
    expect(runHook("{oops", io)).toBeNull();
    expect(appended).toEqual([]);
    expect(logged).toEqual([{ path: hookErrorLog(env), text: "unparseable stdin (5 bytes)" }]);
  });

  it("survives a failing append by logging the reason", () => {
    const { env } = makeEnv();
    const { io, logged } = fakeIo(env, () => {
      throw new Error("disk full");
    });
    expect(runHook("{}", io)).toBeNull();
    expect(logged).toEqual([{ path: hookErrorLog(env), text: "disk full" }]);
  });
});

describe("makeIo", () => {
  it("appends through real IO: dirs 0700, files 0600, one parseable line", () => {
    const { env } = makeEnv();
    const io = makeIo(env, () => NOW, 11, 12);
    const path = join(spoolDir(env), "2026-01-15.jsonl");
    io.appendLine(path, "x\n");
    expect(readFileSync(path, "utf8")).toBe("x\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(spoolDir(env)).mode & 0o777).toBe(0o700);
    expect(runHook(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1" }), io)).toBe(
      "PreToolUse",
    );
    const spooled = readFileSync(path, "utf8").trim().split("\n");
    expect(JSON.parse(spooled[spooled.length - 1] ?? "")).toMatchObject({
      event: "PreToolUse",
      pid: 11,
      ppid: 12,
    });
  });

  it("appends timestamped error lines", () => {
    const { env, state } = makeEnv();
    mkdirSync(state, { recursive: true });
    const io = makeIo(env, () => NOW, 1, 2);
    const path = hookErrorLog(env);
    io.logError(path, "boom");
    io.logError(path, "again");
    expect(readFileSync(path, "utf8")).toBe(`${NOW.toISOString()} boom\n${NOW.toISOString()} again\n`);
  });

  it("stays silent when even the error log cannot be written", () => {
    const { env } = makeEnv(); // no state dir exists yet
    const io = makeIo(env, () => NOW, 1, 2);
    io.logError(hookErrorLog(env), "x");
    expect(existsSync(hookErrorLog(env))).toBe(false);
  });

  it("shrinks an oversized error log to its newer half, cut at a line boundary", () => {
    const { env } = makeEnv();
    const path = writeText(hookErrorLog(env), `${"a".repeat(50)}\n`.repeat(21_000));
    const io = makeIo(env, () => NOW, 1, 2);
    io.logError(path, "boom");
    const content = readFileSync(path, "utf8");
    expect(content.length).toBeGreaterThan(500_000);
    expect(content.length).toBeLessThan(525_000);
    expect(content.startsWith("a".repeat(50))).toBe(true);
    expect(content.endsWith(`${NOW.toISOString()} boom\n`)).toBe(true);
  });
});

describe("pruneSpool", () => {
  it("drops the oldest days first until the spool fits its cap", () => {
    const { env } = makeEnv();
    const dir = spoolDir(env);
    for (const day of ["2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15"]) {
      writeText(join(dir, `${day}.jsonl`), `${"x".repeat(99)}\n`.repeat(10)); // 1000 bytes each
    }
    writeText(join(dir, "notes.txt"), "y".repeat(5000)); // not a spool file: never counted, never deleted
    pruneSpool(dir, 2500);
    expect(readdirSync(dir).sort()).toEqual(["2026-01-14.jsonl", "2026-01-15.jsonl", "notes.txt"]);
  });

  it("keeps the newer half of a single day that is past the cap, cut at a line boundary", () => {
    const { env } = makeEnv();
    const path = writeText(join(spoolDir(env), "2026-01-15.jsonl"), `${"z".repeat(9)}\n`.repeat(100));
    pruneSpool(spoolDir(env), 400);
    const left = readFileSync(path, "utf8");
    expect(left.length).toBeLessThanOrEqual(200);
    expect(left.length).toBeGreaterThan(0);
    expect(
      left
        .split("\n")
        .filter(Boolean)
        .every((line) => line === "z".repeat(9)),
    ).toBe(true);
  });

  it("never throws: a missing spool dir is simply nothing to prune", () => {
    const { env } = makeEnv();
    expect(() => pruneSpool(join(spoolDir(env), "missing"))).not.toThrow();
  });

  it("runs after every real append, so the spool cannot grow without bound", () => {
    const { env } = makeEnv();
    const dir = spoolDir(env);
    writeText(join(dir, "2020-01-01.jsonl"), "x".repeat(70 * 1_048_576)); // an old day past the whole budget
    const io = makeIo(env, () => NOW, 1, 2);
    expect(runHook(JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }), io)).toBe("Stop");
    expect(readdirSync(dir)).toEqual(["2026-01-15.jsonl"]);
  });
});
