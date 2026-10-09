import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ActivityRow,
  activityBoard,
  jobRows,
  modelUsage,
  orderRows,
  spoolRows,
  usageWindows,
  windowStart,
} from "../../src/app/activity.ts";
import type { RouteEvent, SpoolEvent } from "../../src/domain/route-events.ts";
import { radarHome } from "../../src/router/spool.ts";
import { aJob, anAttempt } from "../support/builders.ts";
import { fakeDeps } from "../support/fakes.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";

/** Local noon of a fixed day, so file names and midnight windows hold in any timezone. */
const NOON = new Date(2026, 9, 7, 12, 0, 0);
const at = (dayOffset: number, hour: number, minute = 0, second = 0): string =>
  new Date(2026, 9, 7 + dayOffset, hour, minute, second).toISOString();

/** A route event with only what the aggregations read. */
function route(fields: Partial<RouteEvent> & { readonly ts: string }): RouteEvent {
  return {
    event: "route",
    plugin: "zai",
    model: "glm-5.3",
    upstream: "api.z.ai",
    route: "provider",
    status: 200,
    latency_ms: 40,
    ...fields,
  };
}

const USAGE = {
  input_tokens: 100,
  output_tokens: 10,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 7,
};

describe("board rows from the spool", () => {
  const events: SpoolEvent[] = [
    route({ ts: at(0, 11, 50, 10), session_id: "session-one-aaaa", agent_id: "agent-aaa-111", usage: USAGE }),
    route({
      ts: at(0, 11, 50, 20),
      session_id: "session-one-aaaa",
      agent_id: "agent-aaa-111",
      model: "glm-5.3-flash",
      usage: USAGE,
    }),
    route({
      ts: at(0, 11, 50, 30),
      session_id: "session-one-aaaa",
      agent_id: "agent-bbb-222",
      parent_agent_id: "agent-aaa-111",
      usage: USAGE,
    }),
    route({ ts: at(0, 11, 50, 40), session_id: "session-two-bbbb", usage: USAGE }),
    // Another plugin's router shares the file; a router event is not a request; an event with no id belongs to no row.
    route({ ts: at(0, 11, 50, 45), plugin: "kimi", session_id: "session-kimi" }),
    { ts: at(0, 11, 50, 45), event: "router", plugin: "zai", port: 18787, state: "start", version: 1 },
    route({ ts: at(0, 11, 50, 45), route: "anthropic" }),
  ];

  it("one row per subagent and per main session: requests and tokens summed, short id, last request's model", () => {
    expect(spoolRows("zai", events, new Date(2026, 9, 7, 11, 50, 59).getTime())).toEqual([
      {
        kind: "subagent",
        id: "agent-aa",
        model: "glm-5.3-flash",
        state: "active",
        requests: 2,
        inputTokens: 200,
        outputTokens: 20,
        at: at(0, 11, 50, 20),
      },
      {
        kind: "subagent",
        id: "agent-bb",
        model: "glm-5.3",
        state: "active",
        requests: 1,
        inputTokens: 100,
        outputTokens: 10,
        at: at(0, 11, 50, 30),
      },
      {
        kind: "session",
        id: "session-",
        model: "glm-5.3",
        state: "active",
        requests: 1,
        inputTokens: 100,
        outputTokens: 10,
        at: at(0, 11, 50, 40),
      },
    ]);
  });

  it("active only within the minute, idle after; usage counters that are not numbers count as nothing", () => {
    const rows = spoolRows(
      "zai",
      [
        route({
          ts: at(0, 11, 59, 30),
          session_id: "s-fresh",
          usage: { input_tokens: "90", output_tokens: null },
        }),
        route({ ts: at(0, 10), session_id: "s-old", usage: USAGE }),
      ],
      NOON.getTime(),
    );

    expect(rows.map((row) => [row.id, row.state])).toEqual([
      ["s-fresh", "active"],
      ["s-old", "idle"],
    ]);
    expect(rows[0]?.inputTokens).toBe(90);
    expect(rows[0]?.outputTokens).toBe(0);
  });
});

describe("the merged board", () => {
  it("jobs map to rows, a dead driver marking a mid-flight job stale", () => {
    const running = aJob({ id: "261007-run001", state: "running" });
    const verifying = aJob({ id: "261007-ver001", state: "verifying" });
    const settled = aJob({
      id: "261007-rev001",
      state: "awaiting_review",
      attempts: [anAttempt({ verdict: "pass" })],
    });

    expect(
      jobRows(REFERENCE_PROVIDER, [
        { job: running, live: true },
        { job: verifying, live: false },
        { job: settled, live: false },
      ]),
    ).toEqual([
      {
        kind: "job",
        id: "261007-run001",
        model: "glm-5.3",
        state: "running",
        verdict: "no verdict",
        stale: false,
        at: running.updatedAt,
        title: "Rename the helper",
      },
      {
        kind: "job",
        id: "261007-ver001",
        model: "glm-5.3",
        state: "verifying",
        verdict: "no verdict",
        stale: true,
        at: verifying.updatedAt,
        title: "Rename the helper",
      },
      {
        kind: "job",
        id: "261007-rev001",
        model: "glm-5.3",
        state: "awaiting_review",
        verdict: "pass",
        stale: false,
        at: settled.updatedAt,
        title: "Rename the helper",
      },
    ]);
  });

  it("active rows first, then newest first — an active subagent outranks a newer idle session", () => {
    const rows: ActivityRow[] = [
      { kind: "session", id: "idle-new", state: "idle", at: at(0, 10) },
      { kind: "session", id: "idle-old", state: "idle", at: at(-1, 10) },
      { kind: "subagent", id: "active-b", state: "active", at: at(0, 11, 20) },
      { kind: "subagent", id: "active-a", state: "active", at: at(0, 11, 30) },
      { kind: "job", id: "queued", state: "queued", at: at(0, 9) },
    ];

    expect(orderRows(rows).map((row) => row.id)).toEqual([
      "active-a",
      "active-b",
      "queued",
      "idle-new",
      "idle-old",
    ]);
  });

  it("reads today's and yesterday's spool beside the job store, one merged board", async () => {
    const root = tempDir("core-activity-");
    const fakes = fakeDeps([], { RADAR_HOME: join(root, "radar") });
    fakes.clock.current = NOON.getTime();
    const spool = join(radarHome(fakes.deps.env), "spool");
    const write = (name: string, lines: readonly SpoolEvent[]): void => {
      mkdirSync(spool, { recursive: true });
      writeFileSync(join(spool, name), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    };
    write("2026-10-07.jsonl", [route({ ts: at(0, 11, 59, 30), session_id: "s-now", agent_id: "a-now" })]);
    write("2026-10-06.jsonl", [route({ ts: at(-1, 11), session_id: "s-yesterday" })]);
    write("2026-10-05.jsonl", [route({ ts: at(-2, 11), session_id: "s-too-old" })]);
    fakes.store.put(aJob({ id: "261007-job001", state: "awaiting_review", updatedAt: at(-1, 23) }));

    const rows = await activityBoard(fakes.deps, { repoRoot: "/repo", all: false });

    expect(rows.map((row) => `${row.kind} ${row.id} ${row.state}`)).toEqual([
      "subagent a-now active",
      "job 261007-job001 awaiting_review",
      "session s-yester idle",
    ]);
  });
});

describe("usage windows", () => {
  it("windowStart is local midnight, today included", () => {
    expect(windowStart(NOON, 1)).toBe(new Date(2026, 9, 7).getTime());
    expect(windowStart(NOON, 7)).toBe(new Date(2026, 9, 1).getTime());
    expect(windowStart(NOON, 30)).toBe(new Date(2026, 8, 8).getTime());
  });

  it("sums per model over the provider-bound requests only, in the window only", () => {
    const events: SpoolEvent[] = [
      route({ ts: at(0, 8), model: "glm-5.3-flash", usage: USAGE }),
      route({ ts: at(-2, 8), model: "glm-5.3", usage: { input_tokens: 1_000_000, output_tokens: 0 } }),
      route({ ts: at(-2, 8), model: "glm-5.3", usage: { input_tokens: 500_000, output_tokens: 250_000 } }),
      route({ ts: at(-2, 8), model: "claude-sonnet-5-5", route: "anthropic", usage: USAGE }),
      route({ ts: at(-2, 8), model: "kimi-k3", route: "peer:kimi", usage: USAGE }),
      route({ ts: at(-2, 8), plugin: "kimi", usage: USAGE }),
      route({ ts: at(-40, 8), model: "glm-5.3", usage: USAGE }),
    ];

    expect(modelUsage("zai", events, windowStart(NOON, 7))).toEqual([
      {
        model: "glm-5.3",
        requests: 2,
        inputTokens: 1_500_000,
        outputTokens: 250_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        model: "glm-5.3-flash",
        requests: 1,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 7,
      },
    ]);
    expect(modelUsage("zai", events, windowStart(NOON, 1))).toEqual([
      {
        model: "glm-5.3-flash",
        requests: 1,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 7,
      },
    ]);
  });

  it("the three windows read thirty days of spool with the injected clock", () => {
    const root = tempDir("core-activity-");
    const fakes = fakeDeps([], { RADAR_HOME: join(root, "radar") });
    fakes.clock.current = NOON.getTime();
    const spool = join(radarHome(fakes.deps.env), "spool");
    const write = (name: string, event: SpoolEvent): void => {
      mkdirSync(spool, { recursive: true });
      writeFileSync(join(spool, name), `${JSON.stringify(event)}\n`);
    };
    write("2026-10-07.jsonl", route({ ts: at(0, 8), usage: USAGE }));
    write("2026-10-02.jsonl", route({ ts: at(-5, 8), usage: USAGE }));
    write("2026-09-15.jsonl", route({ ts: at(-22, 8), usage: USAGE }));
    write("2026-09-01.jsonl", route({ ts: at(-36, 8), usage: USAGE }));

    expect(usageWindows(fakes.deps).map((window) => [window.label, window.rows[0]?.requests])).toEqual([
      ["Today", 1],
      ["Last 7 days", 2],
      ["Last 30 days", 3],
    ]);
  });
});
