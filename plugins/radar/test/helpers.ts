import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AgentView,
  type RequestRecord,
  type SessionView,
  type ToolCallRecord,
  ZERO_TOKENS,
} from "../src/shared/model.ts";

export type TestEnv = {
  env: NodeJS.ProcessEnv;
  home: string;
  state: string;
  config: string;
  zai: string;
};

/**
 * A whole temp world: HOME, RADAR_HOME, CLAUDE_CONFIG_DIR and ZAI_STATE_DIR all point into one
 * throwaway directory, so no test can read or write anything real — not the user's transcripts, not the
 * zai jobs dir, not a live server.json. Built from scratch (never spread from process.env) so a stray
 * variable set in the surrounding shell cannot leak a real path in.
 */
export function makeEnv(): TestEnv {
  const home = mkdtempSync(join(tmpdir(), "radar-test-"));
  return {
    env: {
      HOME: home,
      RADAR_HOME: join(home, "state"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      ZAI_STATE_DIR: join(home, "zai"),
    },
    home,
    state: join(home, "state"),
    config: join(home, "claude"),
    zai: join(home, "zai"),
  };
}

/** Entries → one jsonl document (trailing newline included). */
export function jsonl(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** mkdir -p the parent, then write with 0600 — the mode every spool/state file is supposed to have. */
export function writeText(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

/** Append, the way the spool and transcripts grow — never truncates. */
export function appendText(path: string, text: string): string {
  appendFileSync(path, text);
  return path;
}

export function makeRequest(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: "req-1",
    sessionId: "s1",
    agentId: "main",
    model: "claude-sonnet-5-5",
    upstream: "https://api.anthropic.com",
    ts: 1_000,
    latencyMs: 100,
    tokens: { ...ZERO_TOKENS, input: 10, output: 5 },
    stopReason: null,
    provider: "Anthropic",
    ...overrides,
  };
}

export function makeTool(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "tool-1",
    sessionId: "s1",
    agentId: "main",
    name: "Bash",
    startedAt: 1_000,
    durationMs: 50,
    ok: true,
    ...overrides,
  };
}

export function makeAgentView(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: "main",
    sessionId: "s1",
    parentId: null,
    kind: "main",
    name: "main",
    agentType: null,
    description: null,
    model: null,
    requests: 0,
    errors: 0,
    tools: 0,
    tokens: { ...ZERO_TOKENS },
    live: true,
    lastAt: null,
    ...overrides,
  };
}

export function makeSessionView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "s1",
    cwd: "/Users/smoke/work/app",
    project: "app",
    name: null,
    branch: null,
    repo: null,
    parentSessionId: null,
    startedAt: 1_000,
    endedAt: null,
    live: true,
    status: null,
    activity: {
      bucketMs: 18_750,
      counts: new Array<number>(48).fill(0),
      models: new Array<string>(48).fill(""),
    },
    model: "claude-sonnet-5-5",
    upstream: "https://api.anthropic.com",
    ccVersion: "2.0.0",
    requestCount: 0,
    errorCount: 0,
    toolCount: 0,
    tokens: { ...ZERO_TOKENS },
    agents: [],
    liveAgentCount: 0,
    external: false,
    ...overrides,
  };
}

/** http.ts resolves the static dir from process.env at server-creation time; pin it for a scope, restore after. */
export async function withPublicDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.RADAR_PUBLIC_DIR;
  process.env.RADAR_PUBLIC_DIR = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.RADAR_PUBLIC_DIR;
    } else {
      process.env.RADAR_PUBLIC_DIR = previous;
    }
  }
}

/** Poll `probe` until it returns a truthy value or the deadline passes; throws with `label` on timeout. */
export async function waitFor<T>(label: string, timeoutMs: number, probe: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((sleep) => setTimeout(sleep, 20));
  }
}
