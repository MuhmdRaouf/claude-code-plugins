import { describe, expect, it } from "vitest";
import {
  claudeFromBefore,
  isClaudeCode,
  type ProcessStart,
  parseProcessList,
  RETIRED_MAX_MS,
  retiredExit,
} from "../../src/domain/retirement.ts";

const RETIRED_AT = new Date(2026, 9, 8, 12, 0, 0, 400).getTime();
const at = (offsetMs: number): number => RETIRED_AT + offsetMs;
const claude = (startedAt: number, command = "claude"): ProcessStart => ({ pid: 1, startedAt, command });

describe("which processes are Claude Code sessions", () => {
  it("matches the claude program, by any path, with its arguments", () => {
    expect(isClaudeCode("claude")).toBe(true);
    expect(isClaudeCode("/Users/me/.local/bin/claude --resume abc")).toBe(true);
    expect(isClaudeCode("claude -p hello world")).toBe(true);
  });

  it("matches the npm package run under node or bun, whatever Linux names the process", () => {
    expect(isClaudeCode("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe(true);
    expect(
      isClaudeCode(
        "/opt/bun/bin/bun /home/me/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.mjs",
      ),
    ).toBe(true);
  });

  it("ignores the desktop app, look-alikes and programs that only mention claude", () => {
    expect(isClaudeCode("/Applications/Claude.app/Contents/MacOS/Claude")).toBe(false);
    expect(isClaudeCode("claude-helper")).toBe(false);
    expect(isClaudeCode("grep claude")).toBe(false);
    expect(isClaudeCode("node /srv/zai-router.js")).toBe(false);
    expect(isClaudeCode("")).toBe(false);
  });
});

describe("when a retired router exits", () => {
  it("stays while a claude process from before the retirement runs", () => {
    expect(retiredExit({ retiredAt: RETIRED_AT, now: at(60_000), processes: [claude(at(-3_600_000))] })).toBe(
      "stay",
    );
    expect(
      retiredExit({
        retiredAt: RETIRED_AT,
        now: at(60_000),
        processes: [claude(at(-1000), "/Users/me/.local/bin/claude")],
      }),
    ).toBe("stay");
  });

  it("exits once only newer claude processes, or other programs, are left", () => {
    expect(retiredExit({ retiredAt: RETIRED_AT, now: at(60_000), processes: [] })).toBe("exit");
    expect(
      retiredExit({
        retiredAt: RETIRED_AT,
        now: at(60_000),
        processes: [claude(at(5000)), claude(at(-5000), "Claude"), claude(at(-5000), "claude-helper")],
      }),
    ).toBe("exit");
  });

  it("counts a claude started in the retirement's own second as older: ps reports whole seconds", () => {
    const sameSecond = Math.floor(RETIRED_AT / 1000) * 1000;
    expect(claudeFromBefore([claude(sameSecond)], RETIRED_AT)).toBe(true);
    expect(claudeFromBefore([claude(sameSecond + 1000)], RETIRED_AT)).toBe(false);
  });

  it("stays when the process list cannot be read, until the 7-day cap", () => {
    expect(retiredExit({ retiredAt: RETIRED_AT, now: at(60_000), processes: undefined })).toBe("stay");
    expect(retiredExit({ retiredAt: RETIRED_AT, now: at(RETIRED_MAX_MS - 1), processes: undefined })).toBe(
      "stay",
    );
    expect(retiredExit({ retiredAt: RETIRED_AT, now: at(RETIRED_MAX_MS), processes: undefined })).toBe(
      "exit",
    );
    expect(
      retiredExit({ retiredAt: RETIRED_AT, now: at(RETIRED_MAX_MS), processes: [claude(at(-1000))] }),
    ).toBe("exit");
    expect(
      retiredExit({ retiredAt: RETIRED_AT, now: at(100), processes: [claude(at(-1000))], maxMs: 100 }),
    ).toBe("exit");
  });
});

describe("reading ps", () => {
  it("parses pid, local start time and the command, keeping spaces in a path", () => {
    const out = [
      " 3023 Thu Oct  8 16:28:43 2026     claude",
      "81812 Wed Oct  7 21:20:40 2026     /Applications/Some App.app/Contents/MacOS/Claude",
      "",
      "garbage line",
      "   12 Thu Foo  8 16:28:43 2026 x",
    ].join("\n");
    expect(parseProcessList(out)).toEqual([
      { pid: 3023, startedAt: new Date(2026, 9, 8, 16, 28, 43).getTime(), command: "claude" },
      {
        pid: 81812,
        startedAt: new Date(2026, 9, 7, 21, 20, 40).getTime(),
        command: "/Applications/Some App.app/Contents/MacOS/Claude",
      },
    ]);
  });
});
