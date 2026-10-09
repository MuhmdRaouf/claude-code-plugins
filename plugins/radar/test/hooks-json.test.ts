import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * hooks.json is load-bearing: Claude Code runs it in every session, and a malformed file (hook
 * objects listed directly under an event instead of matcher groups) makes the plugin's hooks
 * silently not run — or worse, a bad entry can break the session. This is the same shape check
 * the repository gate runs, kept here so a regression fails `npm test` first.
 */
type HookEntry = { type?: unknown; command?: unknown; timeout?: unknown };
type Group = { matcher?: unknown; hooks?: unknown };

const parsed = JSON.parse(
  readFileSync(fileURLToPath(new URL("../plugin/hooks/hooks.json", import.meta.url)), "utf8"),
) as { hooks?: Record<string, Group[]> };

/** Every event Claude Code fires that the plugin observes. */
const EXPECTED_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreCompact",
  "Notification",
];

/** Events fired per tool call: a hook on them would start a process for every tool Claude runs. */
const TOOL_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];

/**
 * The one command every hook runs: the bundled entrypoint under bun when it is on Claude Code's PATH, else node, behind a
 * guard that exits 0 at once when neither exists, with stderr discarded and any failure exit turned into 0 (a regex: the
 * literal ${…} would trip lint).
 */
const COMMAND =
  /^R=\$\(command -v bun \|\| command -v node\) \|\| exit 0; "\$R" "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/hook\.js" 2>\/dev\/null \|\| exit 0$/;

/** One group must hold only command hooks with a command and a bounded timeout. */
function expectCommandGroup(event: string, group: Group): void {
  expect(Array.isArray(group?.hooks), `${event}: group without hooks[]`).toBe(true);
  for (const entry of group.hooks as HookEntry[]) {
    expect(entry.type, `${event}: hook type must be command`).toBe("command");
    const command = entry.command;
    expect(typeof command, `${event}: hook needs a command`).toBe("string");
    expect(String(command).length, `${event}: command is empty`).toBeGreaterThan(0);
    expect(entry.timeout, `${event}: timeout must be a number <= 10`).toBeLessThanOrEqual(10);
  }
}

/** Every hook runs the bundled entrypoint behind the guard. */
function expectGroupWiring(event: string, group: Group): void {
  for (const entry of group.hooks as HookEntry[]) {
    expect(entry.command, `${event}: runs the bundled hook`).toMatch(COMMAND);
  }
}

describe("plugin/hooks/hooks.json", () => {
  it("covers every event exactly once", () => {
    expect(Object.keys(parsed.hooks ?? {}).sort()).toEqual([...EXPECTED_EVENTS].sort());
  });

  it("lists matcher groups of command hooks for every event, never bare hook objects", () => {
    for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
      expect(Array.isArray(groups), `${event}: must be an array of matcher groups`).toBe(true);
      expect(groups.length, `${event}: at least one group`).toBeGreaterThan(0);
      for (const group of groups) expectCommandGroup(event, group);
    }
  });

  it("never runs a process per tool call: tool calls come from the transcripts", () => {
    for (const event of TOOL_EVENTS) expect(parsed.hooks?.[event], event).toBeUndefined();
  });

  it("runs the bundled hook entrypoint behind the bun-or-node guard", () => {
    for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
      for (const group of groups) expectGroupWiring(event, group);
    }
  });
});
