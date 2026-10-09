import { chmodSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Alert,
  type AlertInput,
  DEFAULT_THRESHOLDS,
  detectAlerts,
  trailingStreak,
} from "../src/alerts/engine.ts";
import {
  appleScriptText,
  createNotifier,
  notifiedPath,
  notifyCommand,
  spawnDetached,
} from "../src/alerts/notify.ts";
import type { BudgetSpend } from "../src/budget/budgets.ts";
import { contextWindow } from "../src/shared/context.ts";
import type { ApiErrorRecord, EventRecord } from "../src/shared/model.ts";
import { ZERO_TOKENS } from "../src/shared/model.ts";
import type { SessionListItem } from "../src/store/store.ts";
import { makeEnv, makeRequest, makeTool, writeText } from "./helpers.ts";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

function session(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: "s1",
    project: "app",
    cwd: "/w/app",
    name: null,
    branch: null,
    repo: null,
    parentSessionId: null,
    startedAt: NOW - 60 * MIN,
    endedAt: null,
    live: true,
    status: null,
    activity: {
      bucketMs: 18_750,
      counts: new Array<number>(48).fill(0),
      models: new Array<string>(48).fill(""),
    },
    model: null,
    agentCount: 1,
    liveAgentCount: 0,
    requestCount: 1,
    tokens: 0,
    lastAt: NOW,
    external: false,
    title: null,
    costUsd: 0.5,
    ...over,
  };
}

let seq = 0;
function event(kind: string, ts: number, sessionId = "s1"): EventRecord {
  seq += 1;
  return { seq, ts, kind, sessionId, agentId: null, label: null, payload: null };
}

function input(over: Partial<AlertInput> = {}): AlertInput {
  return {
    now: NOW,
    sessions: [session()],
    requests: [],
    tools: [],
    events: [],
    apiErrors: [],
    budgets: [],
    ...over,
  };
}

const kinds = (alerts: Alert[]): string[] => alerts.map((a) => a.kind);

describe("stuck", () => {
  const prompt = event("UserPromptSubmit", NOW - 30 * MIN);

  it("fires mid-turn after 10 quiet minutes", () => {
    const alerts = detectAlerts(
      input({
        events: [prompt],
        requests: [makeRequest({ ts: NOW - 12 * MIN, stopReason: null })],
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "stuck",
      sessionId: "s1",
      agentId: null,
      project: "app",
      since: NOW - 12 * MIN,
      costUsd: 0.5,
      severity: "err",
    });
    expect(alerts[0]?.detail).toMatch(/12 min/);
  });

  it("waits 30 minutes while a tool is running, and names a subagent", () => {
    const toolRun = (ago: number) =>
      detectAlerts(
        input({
          events: [event("UserPromptSubmit", NOW - 50 * MIN)],
          requests: [makeRequest({ ts: NOW - ago * MIN, stopReason: "tool_use", agentId: "w1" })],
        }),
      );
    expect(toolRun(20)).toEqual([]);
    expect(toolRun(31)[0]).toMatchObject({ kind: "stuck", agentId: "w1" });
    expect(toolRun(31)[0]?.detail).toMatch(/tool has been running/);
  });

  it("stays quiet when the session waits for the user", () => {
    const quiet = makeRequest({ ts: NOW - 20 * MIN, stopReason: null });
    const cases: Partial<AlertInput>[] = [
      { events: [prompt, event("Stop", NOW - 19 * MIN)], requests: [quiet] },
      { events: [prompt, event("Interrupted", NOW - 19 * MIN)], requests: [quiet] },
      { events: [prompt, event("Notification", NOW - 19 * MIN)], requests: [quiet] },
      { events: [prompt], requests: [makeRequest({ ts: NOW - 20 * MIN, stopReason: "end_turn" })] },
      { events: [], requests: [quiet] },
      { events: [prompt], requests: [quiet], sessions: [session({ live: false })] },
      { events: [prompt], requests: [quiet], sessions: [session({ external: true })] },
      {
        events: [event("UserPromptSubmit", NOW - 7 * 60 * MIN)],
        requests: [makeRequest({ ts: NOW - 7 * 60 * MIN })],
      },
      { events: [prompt], requests: [makeRequest({ ts: NOW - 5 * MIN })] },
    ];
    for (const [index, c] of cases.entries()) {
      expect([index, kinds(detectAlerts(input(c)))]).toEqual([index, []]);
    }
  });

  it("without hook lines, only a request that asked for a tool keeps the turn open", () => {
    const alerts = detectAlerts(
      input({ requests: [makeRequest({ ts: NOW - 40 * MIN, stopReason: "tool_use" })] }),
    );
    expect(kinds(alerts)).toEqual(["stuck"]);
  });

  it("counts tool results and agent events as activity", () => {
    const alerts = detectAlerts(
      input({
        events: [prompt, event("SubagentStart", NOW - 2 * MIN)],
        requests: [makeRequest({ ts: NOW - 20 * MIN, stopReason: null })],
        tools: [makeTool({ startedAt: NOW - 20 * MIN, durationMs: 19 * MIN })],
      }),
    );
    expect(alerts).toEqual([]);
  });
});

describe("loop", () => {
  const call = (i: number, key = "k", over = {}) =>
    makeTool({ id: `t${i}`, startedAt: NOW - (10 - i) * MIN, inputKey: key, ...over });

  it("finds the trailing run of identical calls", () => {
    expect(trailingStreak([])).toEqual([]);
    expect(trailingStreak([makeTool()])).toEqual([]);
    expect(trailingStreak([call(1, "a"), call(2), call(3)]).map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(trailingStreak([call(1, "k", { name: "Read" }), call(2)]).map((t) => t.id)).toEqual(["t2"]);
  });

  it("fires at five identical calls in a row, recent ones only, per agent", () => {
    const five = [1, 2, 3, 4, 5].map((i) => call(i));
    const alerts = detectAlerts(input({ tools: five }));
    expect(alerts[0]).toMatchObject({ kind: "loop", since: NOW - 9 * MIN, agentId: null, severity: "warn" });
    expect(alerts[0]?.detail).toBe("Bash called 5 times in a row with the same input");
    expect(detectAlerts(input({ tools: five.slice(1) }))).toEqual([]);
    const sub = five.map((t) => ({ ...t, agentId: "w1" }));
    expect(detectAlerts(input({ tools: sub }))[0]?.agentId).toBe("w1");
    expect(detectAlerts(input({ tools: five, now: NOW + 40 * MIN }))).toEqual([]);
    expect(detectAlerts(input({ tools: [...five, call(6, "other")] }))).toEqual([]);
  });
});

describe("context", () => {
  const big = (input: number, over = {}) =>
    makeRequest({ ts: NOW - MIN, tokens: { ...ZERO_TOKENS, input, cacheRead: 0 }, ...over });

  it("knows a session's window", () => {
    expect(contextWindow([big(10)])).toBe(200_000);
    expect(contextWindow([big(10, { model: "claude-opus-5[1m]" })])).toBe(1_000_000);
    expect(contextWindow([big(300_000)])).toBe(1_000_000);
  });

  it("fires at 85% of the window until a compaction", () => {
    expect(kinds(detectAlerts(input({ requests: [big(171_000)] })))).toEqual(["context"]);
    expect(detectAlerts(input({ requests: [big(160_000)] }))).toEqual([]);
    expect(
      detectAlerts(input({ requests: [big(171_000)], events: [event("PreCompact", NOW - 10)] })),
    ).toEqual([]);
    expect(detectAlerts(input({ requests: [big(171_000)], sessions: [session({ live: false })] }))).toEqual(
      [],
    );
    const sub = detectAlerts(input({ requests: [big(171_000, { agentId: "w1" })] }));
    expect(sub[0]).toMatchObject({ agentId: "w1" });
    expect(sub[0]?.detail).toMatch(/171k of 200k tokens \(86%\)/);
  });

  it("skips a request holding a run total: a job's sum is not one call's context", () => {
    const runTotal = makeRequest({
      ts: NOW - 2 * MIN,
      model: "glm-5.3-flash",
      tokens: { input: 2_000_000, output: 10_000, cacheRead: 574_000, cacheWrite: 0 },
      totals: true,
    });
    expect(kinds(detectAlerts(input({ requests: [runTotal] })))).toEqual([]);
    expect(contextWindow([runTotal])).toBe(200_000); // the run total does not make the window 1M
    // a per-call request at 90% of the window still alerts, alongside the run total
    const alerts = detectAlerts(input({ requests: [runTotal, big(180_000, { ts: NOW - 1000 })] }));
    expect(kinds(alerts)).toEqual(["context"]);
    expect(alerts[0]?.detail).toMatch(/180k of 200k tokens \(90%\)/);
  });
});

describe("retry storm", () => {
  const failure = (ago: number, over: Partial<ApiErrorRecord> = {}): ApiErrorRecord => ({
    ts: NOW - ago,
    sessionId: "s1",
    agentId: null,
    status: 429,
    source: "transcript",
    plugin: null,
    ...over,
  });

  it("fires at five failures within two minutes, per session", () => {
    const burst = [0, 10, 20, 30, 40].map((s) =>
      failure(3 * MIN - s * 1000, { status: s === 0 ? 529 : 429 }),
    );
    const alerts = detectAlerts(input({ apiErrors: burst }));
    expect(alerts[0]).toMatchObject({ kind: "retry_storm", sessionId: "s1", project: "app" });
    expect(alerts[0]?.detail).toBe("5 rate limits or server errors (429, 529) within 2 min");
    expect(detectAlerts(input({ apiErrors: burst.slice(1) }))).toEqual([]);
  });

  it("does not count failures spread out, stale or from the future", () => {
    const spread = [0, 1, 2, 3, 4].map((i) => failure(i * 3 * MIN));
    expect(detectAlerts(input({ apiErrors: spread }))).toEqual([]);
    const stale = [0, 1, 2, 3, 4].map((i) => failure(20 * MIN + i * 1000));
    expect(detectAlerts(input({ apiErrors: stale }))).toEqual([]);
    const future = [0, 1, 2, 3, 4].map((i) => failure(-MIN - i));
    expect(detectAlerts(input({ apiErrors: future }))).toEqual([]);
  });

  it("groups a router's failures under its provider when no session is known", () => {
    const burst = [1, 2, 3, 4, 5].map((i) =>
      failure(i * 1000, { sessionId: null, plugin: "zai", source: "router" }),
    );
    const alerts = detectAlerts(input({ apiErrors: burst }));
    expect(alerts[0]).toMatchObject({ kind: "retry_storm", sessionId: "", project: "", costUsd: null });
    expect(alerts[0]?.detail).toMatch(/at the Z.ai router$/);
    const unknown = burst.map((f) => ({ ...f, plugin: null }));
    expect(detectAlerts(input({ apiErrors: unknown }))[0]?.id).toMatch(/router:unknown/);
  });
});

describe("budget alerts", () => {
  const spend = (pct: number, action: "warn" | "stop" = "warn"): BudgetSpend => ({
    id: "b1",
    spentUsd: pct / 10,
    limitUsd: 10,
    pct,
    scope: "provider:zai",
    period: "month",
    action,
    periodStart: 5,
  });

  it("warns from 80% and turns loud at 100%, with a new id for each threshold", () => {
    expect(detectAlerts(input({ budgets: [spend(79)] }))).toEqual([]);
    const near = detectAlerts(input({ budgets: [spend(84, "stop")] }))[0];
    expect(near).toMatchObject({ kind: "budget", severity: "warn", id: "budget:b1:5:80", costUsd: 8.4 });
    expect(near?.detail).toBe("Z.ai monthly budget at 84% ($8.40 of $10.00), stops at 100%");
    const over = detectAlerts(input({ budgets: [spend(100, "stop")] }))[0];
    expect(over).toMatchObject({ severity: "err", id: "budget:b1:5:100" });
    expect(over?.detail).toMatch(/requests are stopped$/);
    expect(detectAlerts(input({ budgets: [spend(120)] }))[0]?.detail).toMatch(/warn only$/);
  });

  it("puts loud alerts first, then the newest", () => {
    const alerts = detectAlerts(
      input({
        budgets: [spend(85)],
        tools: [1, 2, 3, 4, 5].map((i) =>
          makeTool({ id: `t${i}`, startedAt: NOW - i * 1000, inputKey: "k" }),
        ),
        requests: [makeRequest({ sessionId: "s2", ts: NOW - 40 * MIN, stopReason: "tool_use" })],
        sessions: [session(), session({ id: "s2" })],
      }),
    );
    expect(kinds(alerts)).toEqual(["stuck", "loop", "budget"]);
    expect(DEFAULT_THRESHOLDS.loopRepeats).toBe(5);
  });
});

describe("desktop notifications", () => {
  const alert = (over: Partial<Alert> = {}): Alert => ({
    id: "stuck:s1:1",
    kind: "stuck",
    sessionId: "s1",
    agentId: null,
    project: "app",
    since: 1,
    detail: "No activity",
    costUsd: null,
    severity: "err",
    ...over,
  });

  it("builds an osascript line on macOS and escapes the text", () => {
    expect(appleScriptText('say "hi"\\\n')).toBe('say \\"hi\\"\\\\ ');
    const line = notifyCommand("darwin", {}, "T", 'b "q"');
    expect(line).toEqual({
      command: "osascript",
      args: ["-e", 'display notification "b \\"q\\"" with title "T"'],
    });
    expect(notifyCommand("win32", {}, "T", "b")).toBeNull();
    expect(notifyCommand("linux", { PATH: "/nonexistent" }, "T", "b")).toBeNull();
  });

  it("uses notify-send on Linux only when it is on PATH", () => {
    const { home } = makeEnv();
    writeText(`${home}/bin/notify-send`, "#!/bin/sh\n");
    chmodSync(`${home}/bin/notify-send`, 0o755);
    expect(notifyCommand("linux", { PATH: `:${home}/bin` }, "T", "b")).toEqual({
      command: "notify-send",
      args: ["--app-name=Radar", "T", "b"],
    });
  });

  it("notifies once per alert, at most once per subject in 10 minutes, and remembers across restarts", () => {
    const { env } = makeEnv();
    const calls: string[][] = [];
    let now = 1_000;
    const make = () =>
      createNotifier({
        env,
        enabled: () => true,
        runner: (command, args) => calls.push([command, ...args]),
        platform: "darwin",
        now: () => now,
      });
    const notifier = make();
    expect(notifier.consider([alert(), alert({ id: "retry", kind: "retry_storm" })])).toBe(1);
    expect(calls[0]?.[2]).toContain("app: No activity");
    expect(notifier.consider([alert()])).toBe(0);
    expect(notifier.consider([alert({ id: "stuck:s1:2" })])).toBe(0); // same subject within 10 min
    now += 11 * 60_000;
    expect(notifier.consider([alert({ id: "stuck:s1:3" })])).toBe(1);
    expect(
      notifier.consider([alert({ id: "budget:b1:5:80", kind: "budget", sessionId: "", project: "" })]),
    ).toBe(1);
    expect(calls[2]?.[2]).toMatch(/^display notification "No activity"/);
    expect(JSON.parse(readFileSync(notifiedPath(env), "utf8")).ids).toHaveProperty("stuck:s1:1");
    expect(make().consider([alert()])).toBe(0);
  });

  it("does nothing when turned off, by the toggle or the environment", () => {
    const { env } = makeEnv();
    const calls: string[][] = [];
    const runner = (command: string, args: string[]) => calls.push([command, ...args]);
    expect(
      createNotifier({ env, enabled: () => false, runner, platform: "darwin" }).consider([alert()]),
    ).toBe(0);
    const off = { ...env, RADAR_NOTIFY: "0" };
    expect(
      createNotifier({ env: off, enabled: () => true, runner, platform: "darwin" }).consider([alert()]),
    ).toBe(0);
    expect(createNotifier({ env, enabled: () => true, runner, platform: "win32" }).consider([alert()])).toBe(
      0,
    );
    expect(calls).toEqual([]);
  });

  it("spawns detached and never throws, even for a missing binary", async () => {
    expect(() => spawnDetached(process.execPath, ["-e", ""])).not.toThrow();
    expect(() => spawnDetached("/nonexistent/radar-notifier", [])).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it("reads a broken memory file as empty", () => {
    const { env } = makeEnv();
    writeText(notifiedPath(env), "{oops");
    const calls: string[][] = [];
    const notifier = createNotifier({
      env,
      enabled: () => true,
      runner: (c, a) => calls.push([c, ...a]),
      platform: "darwin",
    });
    expect(notifier.consider([alert()])).toBe(1);
    writeText(notifiedPath(env), JSON.stringify({ ids: { x: "no" } }));
    expect(
      createNotifier({ env, enabled: () => true, platform: "darwin", runner: () => undefined }).consider([]),
    ).toBe(0);
  });
});
