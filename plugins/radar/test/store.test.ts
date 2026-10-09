import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addCost } from "../src/cost/prices.ts";
import {
  MAX_RECORDS,
  MAX_SESSIONS,
  OUTSIDE_SESSION,
  type SpoolLine,
  type Tokens,
  type ToolCallRecord,
  ZERO_TOKENS,
} from "../src/shared/model.ts";
import { type Change, createStore, type SessionListItem, sessionTree } from "../src/store/store.ts";
import { iso, makeRequest, makeTool } from "./helpers.ts";

const T0 = Date.parse("2026-01-01T10:00:00Z");
const T1 = T0 + 1_000;
const T2 = T0 + 2_000;
const T3 = T0 + 3_000;
const T9 = T0 + 9_000;
const DAY = 86_400_000;

function line(overrides: Partial<SpoolLine> = {}): SpoolLine {
  return { ts: iso(T1), event: "UserPromptSubmit", session_id: "s1", ...overrides };
}

function tokens(input: number, output: number, cacheRead: number, cacheWrite: number): Tokens {
  return { input, output, cacheRead, cacheWrite };
}

describe("addSpoolLine", () => {
  it("creates sessions, keeps first-writer meta and orders the list by recency", () => {
    const store = createStore();
    store.addSpoolLine(
      line({ ts: iso(T0), cwd: "/w/app", base_url: "http://127.0.0.1:8787", cc_version: "2.0.0" }),
    );
    store.addSpoolLine(line({ ts: iso(T1), model_env: { ANTHROPIC_MODEL: "glm-5.3" } }));
    store.addSpoolLine(line({ ts: iso(T1), cwd: "/later" })); // meta only fills holes
    store.addSpoolLine(line({ ts: iso(T2), session_id: "s2", cwd: "/w/other" }));
    expect(store.sessionDetail("s1")).toMatchObject({
      id: "s1",
      cwd: "/w/app",
      project: "app",
      upstream: "http://127.0.0.1:8787",
      ccVersion: "2.0.0",
      model: "glm-5.3",
      startedAt: T0,
      live: false, // seen is not live: only the registry or a SessionStart hook says live
      external: false,
    });
    const list = store.sessionList();
    expect(list.map((item) => item.id)).toEqual(["s2", "s1"]);
    expect(list[0]).toMatchObject({ id: "s2", project: "other", lastAt: T2, live: false });
  });

  it("records sessionless lines as events without inventing a session", () => {
    const store = createStore();
    store.addSpoolLine({ ts: iso(T1), event: "Notification" });
    expect(store.sessionList()).toEqual([]);
    expect(store.events({})).toHaveLength(1);
    expect(store.events({})[0]).toMatchObject({
      kind: "Notification",
      sessionId: null,
      agentId: null,
      label: null,
    });
  });

  it("labels every line from the first field it recognises", () => {
    const store = createStore();
    const cases: Array<[SpoolLine, string | null]> = [
      [line({ prompt: "x".repeat(200) }), "x".repeat(120)],
      [
        {
          ts: iso(T1),
          event: "route",
          session_id: "s1",
          model: "glm-5.3",
          upstream: "http://127.0.0.1:8787",
        },
        "glm-5.3 → http://127.0.0.1:8787",
      ],
      [
        line({ event: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a/b.ts" } }),
        "Read /a/b.ts",
      ],
      [
        line({ event: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "f".repeat(100) } }),
        `Edit ${"f".repeat(90)}`,
      ],
      [line({ event: "PreToolUse", tool_name: "Bash", tool_input: "raw" }), "Bash"],
      [line({ event: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "" } }), "Edit"],
      [line({ event: "SubagentStart", agent_type: "researcher" }), "researcher"],
      [line({ event: "Stop", reason: "end_turn" }), "end_turn"],
      [line({ event: "SessionStart", source: "startup" }), "startup"],
      [line({ event: "Notification", message: "m".repeat(200) }), "m".repeat(120)],
      [line({ event: "PreCompact", trigger: "auto" }), "auto"],
      [line({ event: "Notification" }), null],
    ];
    for (const [input, expected] of cases) {
      store.addSpoolLine(input);
      expect(store.events({ limit: 1 })[0]?.label).toBe(expected);
    }
  });

  it("filters events newest-first by session, since and limit", () => {
    const store = createStore();
    store.addSpoolLine(line({ ts: iso(T0), prompt: "a" }));
    store.addSpoolLine(line({ ts: iso(T1), prompt: "b" }));
    store.addSpoolLine(line({ ts: iso(T2), session_id: "s2", prompt: "c" }));
    const newest = store.events({});
    expect(newest.map((event) => event.label)).toEqual(["c", "b", "a"]);
    expect(newest[0]).toMatchObject({
      kind: "UserPromptSubmit",
      sessionId: "s2",
      agentId: null,
      ts: T2,
      seq: 3,
    });
    expect(newest[0]?.payload).toMatchObject({ prompt: "c" });
    expect(store.events({ session: "s1" }).map((event) => event.ts)).toEqual([T1, T0]);
    expect(store.events({ since: T1 }).map((event) => event.ts)).toEqual([T2, T1]);
    expect(store.events({ limit: 2 }).map((event) => event.ts)).toEqual([T2, T1]);
  });
});

describe("lifecycle", () => {
  it("ends, restarts and re-parents sessions and subagents from hook events alone", () => {
    const store = createStore();
    store.addSpoolLine(line({ ts: iso(T0), event: "SessionEnd" }));
    expect(store.sessionDetail("s1")).toMatchObject({ live: false, endedAt: T0, startedAt: T0 });
    store.addSpoolLine(line({ ts: iso(T1), event: "SessionStart", cwd: "/w/app" }));
    expect(store.sessionDetail("s1")).toMatchObject({
      live: true,
      endedAt: null,
      startedAt: T0,
      cwd: "/w/app",
    });

    store.addSpoolLine(
      line({
        ts: iso(T2),
        event: "SubagentStart",
        agent_id: "w1",
        agent_type: "researcher",
        prompt: "p".repeat(100),
      }),
    );
    const agents = store.sessionDetail("s1")?.agents ?? [];
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({
      id: "w1",
      parentId: "main",
      kind: "subagent",
      name: "p".repeat(80), // the subagent's title is its prompt's head
      live: true,
      lastAt: T2,
    });
    expect(store.sessionList()[0]?.title).toBe("p".repeat(80));

    store.addSpoolLine(line({ ts: iso(T3), event: "SubagentStop", agent_id: "w1" }));
    expect(store.sessionDetail("s1")?.agents.find((agent) => agent.id === "w1")?.live).toBe(false);
    store.addSpoolLine(line({ ts: iso(T3), event: "SessionEnd" }));
    expect(store.sessionDetail("s1")?.agents.every((agent) => !agent.live)).toBe(true);
  });

  it("pairs hook tool events by tool_use_id, else by a time-keyed fallback id", () => {
    const store = createStore();
    const seen: ToolCallRecord[] = [];
    store.onUpdate((change) => seen.push(...change.tools));
    store.addSpoolLine(
      line({ ts: iso(T0), event: "PreToolUse", tool_name: "Read", tool_use_id: "tu1", agent_id: "w1" }),
    );
    expect(seen).toEqual([]); // a start alone records nothing
    store.addSpoolLine(
      line({ ts: iso(T2), event: "PostToolUse", tool_name: "Read", tool_use_id: "tu1", agent_id: "w1" }),
    );
    expect(seen).toEqual([
      { id: "tu1", sessionId: "s1", agentId: "w1", name: "Read", startedAt: T0, durationMs: 2_000, ok: true },
    ]);
    store.addSpoolLine(line({ ts: iso(T3), event: "PostToolUseFailure", tool_name: "Bash" }));
    expect(seen[1]).toEqual({
      id: `hook:s1:Bash:${T3}`,
      sessionId: "s1",
      agentId: null,
      name: "Bash",
      startedAt: T3,
      durationMs: null,
      ok: false,
    });
  });
});

describe("applyRegistry", () => {
  function entry(
    sessionId: string,
    over: Partial<{
      pid: number;
      name: string | null;
      nameSource: string | null;
      status: string | null;
      cwd: string | null;
      startedAt: number | null;
    }> = {},
  ): {
    pid: number;
    sessionId: string;
    name: string | null;
    nameSource: string | null;
    status: string | null;
    cwd: string | null;
    startedAt: number | null;
  } {
    return {
      pid: 100,
      sessionId,
      name: null,
      nameSource: null,
      status: null,
      cwd: null,
      startedAt: null,
      ...over,
    };
  }

  it("makes a registered session live with its busy/idle state, and the user's name wins", () => {
    const store = createStore();
    store.addSpoolLine(line({ ts: iso(T0), event: "SessionStart", cwd: "/w/app" }));
    store.upsertSession({ id: "s1", slug: "from-the-transcript" });
    store.applyRegistry([entry("s1", { name: "ProxBeam", nameSource: "user", status: "busy" })], T9);
    expect(store.sessionDetail("s1")).toMatchObject({
      live: true,
      status: "working",
      endedAt: null,
      name: "ProxBeam",
    });
    // a name Claude Code did not get from the user never outranks the transcript's own titles
    store.applyRegistry([entry("s1", { name: "Auto name", nameSource: "ai", status: "idle" })], T9);
    expect(store.sessionDetail("s1")).toMatchObject({ live: true, status: "idle" });
    expect(store.sessionDetail("s1")?.name).toBe("from-the-transcript");
  });

  it("ends a session the registry no longer lists, at its last activity, hook or no hook", () => {
    const store = createStore();
    store.addSpoolLine(line({ ts: iso(T0), event: "SessionStart" }));
    store.applyRegistry([entry("s1")], T1);
    expect(store.sessionDetail("s1")).toMatchObject({ live: true });
    store.addRequest(makeRequest({ id: "r1", ts: T2 }));
    store.applyRegistry([], T3);
    expect(store.sessionDetail("s1")).toMatchObject({ live: false, endedAt: T2, status: null });
  });

  it("keeps jobs running on their own and never makes a live session of the unattached traffic", () => {
    const store = createStore();
    store.upsertSession({ id: "zai:j1", external: true });
    store.upsertAgent({ sessionId: "zai:j1", id: "j1", kind: "external" });
    store.addRequest(makeRequest({ id: "r9", sessionId: OUTSIDE_SESSION, ts: T1 }));
    store.applyRegistry([], T9);
    expect(store.sessionDetail("zai:j1")).toMatchObject({ live: true, external: true });
    const unattached = store.sessionDetail(OUTSIDE_SESSION);
    expect(unattached).toMatchObject({ live: false, name: "Unattached", endedAt: T1 });
  });

  it("counts live agents on the list item, the same rule the session view's agents carry", () => {
    const store = createStore();
    store.addSpoolLine(line({ ts: iso(T0), event: "SessionStart" }));
    store.addSpoolLine(line({ ts: iso(T1), event: "SubagentStart", agent_id: "w1" }));
    store.addSpoolLine(line({ ts: iso(T1), event: "SubagentStart", agent_id: "w2" }));
    store.addRequest(makeRequest({ id: "r1", ts: T1, agentId: "w1" }));
    store.addRequest(makeRequest({ id: "r2", ts: T1, agentId: "w2" }));
    store.applyRegistry([entry("s1")], T1 + 4 * 60_000);
    // main plus two fresh subagents: every one of them live, and counted
    expect(store.sessionDetail("s1")?.agents.map((agent) => agent.live)).toEqual([true, true, true]);
    expect(store.sessionList().find((item) => item.id === "s1")).toMatchObject({
      agentCount: 3,
      liveAgentCount: 3,
    });
    // five minutes of silence retires the subagents; the total stays its own number
    store.applyRegistry([entry("s1")], T1 + 6 * 60_000);
    expect(store.sessionList().find((item) => item.id === "s1")).toMatchObject({
      agentCount: 3,
      liveAgentCount: 1,
    });
  });

  it("reads the same live words on the list item's count and the session view's rows", () => {
    const store = createStore();
    store.addSpoolLine(line({ ts: iso(T0), event: "SessionStart" }));
    store.addSpoolLine(line({ ts: iso(T1), event: "SubagentStart", agent_id: "w1" }));
    store.addSpoolLine(line({ ts: iso(T1), event: "SubagentStart", agent_id: "w2" }));
    store.addRequest(makeRequest({ id: "r1", ts: T1, agentId: "w1" }));
    store.addRequest(makeRequest({ id: "r2", ts: T1, agentId: "w2" }));
    // at every pass — fresh work and stale — the count on the card is exactly the rows that say Live
    for (const now of [T1 + 4 * 60_000, T1 + 6 * 60_000]) {
      store.applyRegistry([entry("s1")], now);
      const detail = store.sessionDetail("s1");
      const listed = store.sessionList().find((item) => item.id === "s1");
      expect(listed?.liveAgentCount).toBe(detail?.agents.filter((agent) => agent.live).length);
    }
  });

  it("carries the main agent's now line and context fullness for live sessions, and nothing once ended", () => {
    const store = createStore();
    store.addSpoolLine(line({ ts: iso(T0), event: "SessionStart" }));
    store.addRequest(
      makeRequest({
        id: "r1",
        ts: T1,
        agentId: "main",
        what: "↳ prompt: fix the rail",
        tokens: { input: 10_000, output: 0, cacheRead: 5_000, cacheWrite: 1_000 },
      }),
    );
    // a subagent's newer call never speaks for the session, and a run total is no one call's context
    store.addRequest(makeRequest({ id: "r2", ts: T2, agentId: "w1", what: "subagent's call" }));
    store.addRequest(
      makeRequest({
        id: "r3",
        ts: T3,
        agentId: "main",
        totals: true,
        what: "the run's total",
        tokens: { input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    );
    store.applyRegistry([entry("s1", { status: "busy" })], T9);
    const listed = store.sessionList().find((item) => item.id === "s1");
    expect(listed?.live).toBe(true);
    expect(listed?.now).toEqual({ what: "↳ prompt: fix the rail", ts: T1 });
    // that same call's context: input + cacheRead + cacheWrite, in the 200k window the run total did not widen
    expect(listed?.context).toEqual({ used: 16_000, window: 200_000 });
    // the newest main call wins, and a model id that says 1M widens the window
    store.addRequest(
      makeRequest({
        id: "r4",
        ts: T9,
        agentId: "main",
        model: "claude-opus-5[1m]",
        what: "↳ prompt: think big",
        tokens: { input: 900_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    );
    const widened = store.sessionList().find((item) => item.id === "s1");
    expect(widened?.now).toEqual({ what: "↳ prompt: think big", ts: T9 });
    expect(widened?.context).toEqual({ used: 900_000, window: 1_000_000 });
    // once the registry no longer lists the session, both fields are null
    store.applyRegistry([], T9 + DAY);
    const ended = store.sessionList().find((item) => item.id === "s1");
    expect(ended?.live).toBe(false);
    expect(ended?.now).toBeNull();
    expect(ended?.context).toBeNull();
  });

  it("keeps a subagent live under a live parent while its last request is under five minutes old", () => {
    const store = createStore();
    store.addSpoolLine(line({ ts: iso(T0), event: "SessionStart" }));
    store.addSpoolLine(line({ ts: iso(T1), event: "SubagentStart", agent_id: "w1" }));
    store.addRequest(makeRequest({ id: "r1", ts: T1, agentId: "w1" }));
    const live = () => store.sessionDetail("s1")?.agents.find((agent) => agent.id === "w1")?.live;
    store.applyRegistry([entry("s1")], T1 + 4 * 60_000);
    expect(live()).toBe(true); // fresh work under a live parent
    store.applyRegistry([entry("s1")], T1 + 6 * 60_000);
    expect(live()).toBe(false); // stale now
  });

  it("counts a subagent's start as its work until its first request, and never undoes an end", () => {
    const store = createStore();
    store.addSpoolLine(line({ ts: iso(T0), event: "SessionStart" }));
    store.addSpoolLine(line({ ts: iso(T1), event: "SubagentStart", agent_id: "w1" }));
    const live = (id: string) =>
      store.sessionDetail("s1")?.agents.find((agent) => agent.id === id)?.live ?? null;
    store.applyRegistry([entry("s1")], T1 + 4 * 60_000);
    expect(live("w1")).toBe(true); // started, not yet working: the start is recent enough
    store.applyRegistry([entry("s1")], T1 + 6 * 60_000);
    expect(live("w1")).toBe(false); // five minutes of nothing: not live, whatever the hooks said
    store.addSpoolLine(line({ ts: iso(T1 + 60_000), event: "SubagentStart", agent_id: "w2" }));
    store.addRequest(makeRequest({ id: "r1", ts: T1, agentId: "w2" }));
    store.addSpoolLine(line({ ts: iso(T1 + 60_000), event: "SubagentStop", agent_id: "w2" }));
    store.applyRegistry([entry("s1")], T1 + 61_000);
    expect(live("w2")).toBe(false); // an explicit end stands, however fresh its last request is
  });

  it("ends a stale never-ended subagent with its parent when the parent's pid is gone", () => {
    const store = createStore();
    store.addSpoolLine(line({ ts: iso(T0), event: "SessionStart" }));
    store.addSpoolLine(line({ ts: iso(T1), event: "SubagentStart", agent_id: "w1" }));
    store.addRequest(makeRequest({ id: "r1", ts: T1, agentId: "w1" }));
    const agents = () => store.sessionDetail("s1")?.agents ?? [];
    store.applyRegistry([entry("s1")], T1 + 30 * 60_000); // half an hour stale: not live, end or no end
    expect(agents().find((agent) => agent.id === "w1")?.live).toBe(false);
    store.addSpoolLine(line({ ts: iso(T2), event: "SessionEnd" }));
    store.applyRegistry([], T2); // the parent's pid is gone too
    expect(store.sessionDetail("s1")).toMatchObject({ live: false });
    expect(agents().every((agent) => !agent.live)).toBe(true);
  });

  it("displays a registry session's start as the registry's startedAt, not the records' earliest", () => {
    const store = createStore();
    // the transcript reaches back three days through resumes; the open session began a day ago
    store.addRequest(makeRequest({ id: "r1", ts: T0 - 3 * DAY }));
    expect(store.sessionDetail("s1")?.startedAt).toBe(T0 - 3 * DAY);
    store.applyRegistry([entry("s1", { startedAt: T0 - DAY })], T9);
    expect(store.sessionDetail("s1")?.startedAt).toBe(T0 - DAY);
    store.addRequest(makeRequest({ id: "r2", ts: T0 - 2 * DAY })); // another old record cannot drag it back
    expect(store.sessionDetail("s1")?.startedAt).toBe(T0 - DAY);
  });

  it("notifies once, and only when something moved", () => {
    const store = createStore();
    store.addSpoolLine(line({ ts: iso(T0), event: "SessionStart" }));
    const seen: Change[] = [];
    store.onUpdate((change) => seen.push(change));
    store.applyRegistry([entry("s1", { status: "busy" })], T1);
    store.applyRegistry([entry("s1", { status: "busy" })], T2); // the same registry again: silence
    store.applyRegistry([entry("s1", { status: "idle" })], T3);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ sessions: true, touched: ["s1"] });
  });

  it("creates a session the registry lists that ingest has not discovered yet", () => {
    const store = createStore();
    // an idle session from days ago, outside every since window ingest walks: the registry is enough
    store.applyRegistry(
      [
        entry("s9", {
          status: "idle",
          name: "playground-56",
          nameSource: "derived",
          cwd: "/w/app",
          startedAt: T1,
        }),
      ],
      T9,
    );
    expect(store.sessionDetail("s9")).toMatchObject({
      id: "s9",
      live: true,
      status: "idle",
      cwd: "/w/app",
      startedAt: T1,
      endedAt: null,
      name: "playground-56", // the registry's derived name: a registry session is never nameless
    });
    // and a registry that no longer lists it ends it like any other session
    store.applyRegistry([], T9 + 5_000);
    expect(store.sessionDetail("s9")).toMatchObject({ live: false });
  });

  it("names a session by rank: the user's registry name, the titles, the derived name", () => {
    const store = createStore();
    store.applyRegistry([entry("s1", { name: "app-56", nameSource: "derived" })], T9);
    expect(store.sessionDetail("s1")?.name).toBe("app-56"); // the derived name stands when alone
    store.upsertSession({ id: "s1", slug: "from-the-transcript" });
    expect(store.sessionDetail("s1")?.name).toBe("from-the-transcript"); // a title outranks it
    store.applyRegistry([entry("s1", { name: "Hers", nameSource: "user" })], T9);
    expect(store.sessionDetail("s1")?.name).toBe("Hers"); // and the user outranks everything
    // a user name that goes away falls back down the same order, never to a derived name first
    store.applyRegistry([entry("s1", { name: "app-56", nameSource: "derived" })], T9);
    expect(store.sessionDetail("s1")?.name).toBe("from-the-transcript");
  });

  it("names a session by the repo's own name, never a path, when nothing else names it", () => {
    const store = createStore();
    store.upsertSession({
      id: "s1",
      cwd: "/Users/raouf/.work/onthegosystems/wpml-org/app",
      repo: "/Users/raouf/.work/onthegosystems/wpml-org/app",
    });
    expect(store.sessionDetail("s1")).toMatchObject({
      name: "app",
      // the path stays where the workspace is shown: the repo field, the card's tooltip
      repo: "/Users/raouf/.work/onthegosystems/wpml-org/app",
    });
  });
});

describe("sessionTree", () => {
  function item(id: string, over: Partial<SessionListItem> = {}): SessionListItem {
    return {
      id,
      project: null,
      cwd: null,
      name: null,
      branch: null,
      repo: null,
      parentSessionId: null,
      startedAt: null,
      endedAt: null,
      live: false,
      status: null,
      activity: { bucketMs: 1, counts: [], models: [] },
      model: null,
      agentCount: 0,
      liveAgentCount: 0,
      requestCount: 0,
      tokens: 0,
      lastAt: 0,
      external: false,
      title: null,
      ...over,
    };
  }

  it("keeps jobs off the top level: a job hangs under the session that submitted it", () => {
    const tree = sessionTree([
      item("s1", { live: true, lastAt: 9 }),
      item("zai:j1", { external: true, parentSessionId: "s1", live: true, lastAt: 8 }),
      item("zai:j0", { external: true, parentSessionId: "s1", lastAt: 7 }),
    ]);
    expect(tree.map((node) => node.id)).toEqual(["s1"]);
    expect(tree[0]?.jobs?.map((job) => job.id)).toEqual(["zai:j1", "zai:j0"]);
  });

  it("hangs a job whose parent is itself a job under their first main ancestor", () => {
    const tree = sessionTree([
      item("s1", { lastAt: 9 }),
      item("zai:j1", { external: true, parentSessionId: "s1", lastAt: 8 }),
      item("zai:j2", { external: true, parentSessionId: "zai:j1", lastAt: 7 }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.jobs?.map((job) => job.id)).toEqual(["zai:j1", "zai:j2"]);
  });

  it("sends a job with no origin, a lost parent or itself as parent to the Unattached group", () => {
    const tree = sessionTree([
      item("s1", { lastAt: 9 }),
      item("zai:loose", { external: true, live: true, lastAt: 8 }),
      item("kimi:gone", { external: true, parentSessionId: "not-listed", lastAt: 7 }),
      item("zai:self", { external: true, parentSessionId: "zai:self", lastAt: 6 }),
      item(OUTSIDE_SESSION, { name: "Unattached", lastAt: 1 }),
    ]);
    const unattached = tree.find((node) => node.id === OUTSIDE_SESSION);
    expect(tree.filter((node) => node.id.includes(":"))).toEqual([]);
    expect(unattached?.jobs?.map((job) => job.id)).toEqual(["zai:loose", "kimi:gone", "zai:self"]);
  });
});

describe("addRequest", () => {
  it("merges by id, keeping the first model and upstream, taking new facts only", () => {
    const store = createStore();
    store.addRequest(
      makeRequest({
        id: "r1",
        ts: T0,
        model: "m1",
        upstream: "u1",
        latencyMs: null,
        tokens: ZERO_TOKENS,
        stopReason: null,
      }),
    );
    store.addRequest(
      makeRequest({
        id: "r1",
        ts: T1,
        model: "",
        upstream: "",
        latencyMs: 5,
        tokens: tokens(1, 1, 0, 0),
        stopReason: "end_turn",
      }),
    );
    const list = store.requests({ session: "s1" });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "r1",
      ts: T0,
      model: "m1",
      upstream: "u1",
      latencyMs: 5,
      stopReason: "end_turn",
    });
    expect(list[0]?.tokens).toEqual(tokens(1, 1, 0, 0));
    expect(store.sessionDetail("s1")).toMatchObject({ startedAt: T0, model: "m1" });
    expect(store.sessionDetail("s1")?.agents.find((agent) => agent.id === "main")?.model).toBe("m1");
  });

  it("filters, sorts newest-first and slices to the limit", () => {
    const store = createStore();
    store.addRequest(makeRequest({ id: "r1", ts: 100, model: "a" }));
    store.addRequest(makeRequest({ id: "r2", ts: 300, model: "b" }));
    store.addRequest(makeRequest({ id: "r3", ts: 200, sessionId: "s2" }));
    store.addRequest(makeRequest({ id: "r4", ts: 50, agentId: "w1" }));
    expect(store.requests({}).map((request) => request.id)).toEqual(["r2", "r3", "r1", "r4"]);
    expect(store.requests({ limit: 2 }).map((request) => request.id)).toEqual(["r2", "r3"]);
    expect(store.requests({ session: "s1" }).map((request) => request.id)).toEqual(["r2", "r1", "r4"]);
    expect(store.requests({ model: "a" }).map((request) => request.id)).toEqual(["r1"]);
    expect(store.requests({ agent: "w1" }).map((request) => request.id)).toEqual(["r4"]);
    expect(store.requests({ since: 150 }).map((request) => request.id)).toEqual(["r2", "r3"]);
    expect(store.requestsFor({ session: "s1" }).map((request) => request.id)).toEqual(["r1", "r2", "r4"]);
  });

  it("answers the list reads off a cached newest-first order, fresh again after the next change", () => {
    const store = createStore();
    store.addRequest(makeRequest({ id: "r1", ts: 100 }));
    store.addToolCall(makeTool({ id: "t1", startedAt: 200 }));
    store.addToolCall(makeTool({ id: "t2", startedAt: 300, sessionId: "s2", ok: false }));
    const requests = () => store.requests({ limit: 10 }).map((request) => request.id);
    const tools = () => store.tools({ limit: 10 }).map((tool) => tool.id);
    // a burst of reads within one version all see the same newest-first answer, without re-sorting
    expect(requests()).toEqual(["r1"]);
    expect(requests()).toEqual(requests());
    expect(store.tools({ limit: 1 })).toEqual([
      makeTool({ id: "t2", startedAt: 300, sessionId: "s2", ok: false }),
    ]);
    expect(tools()).toEqual(["t2", "t1"]);
    expect(store.tools({ failed: true }).map((tool) => tool.id)).toEqual(["t2"]);
    expect(store.tools({ session: "s1" }).map((tool) => tool.id)).toEqual(["t1"]);
    expect(store.sessionCount()).toBe(2);
    // the next change moves the version, and the cached answers move with it
    store.addRequest(makeRequest({ id: "r2", ts: 400 }));
    store.addToolCall(makeTool({ id: "t3", startedAt: 500, ok: false }));
    expect(requests()).toEqual(["r2", "r1"]);
    expect(tools()).toEqual(["t3", "t2", "t1"]);
    expect(store.sessionCount()).toBe(2);
  });

  it("names the session after its main agent's model, never a subagent's latest one", () => {
    const store = createStore();
    store.addRequest(makeRequest({ id: "r1", ts: 100, model: "claude-opus-5-5" }));
    store.addRequest(makeRequest({ id: "r2", ts: 200, agentId: "w1", model: "zai:glm-5.3-flash" }));
    expect(store.sessionDetail("s1")).toMatchObject({ model: "claude-opus-5-5" });
    expect(store.sessionList()[0]).toMatchObject({ model: "claude-opus-5-5" });
  });

  it("falls back to the latest model until the main agent has a request", () => {
    const store = createStore();
    store.addRequest(makeRequest({ id: "r1", ts: 100, agentId: "w1", model: "zai:glm-5.3-flash" }));
    expect(store.sessionDetail("s1")).toMatchObject({ model: "zai:glm-5.3-flash" });
    store.addRequest(makeRequest({ id: "r2", ts: 200, model: "claude-opus-5-5" }));
    expect(store.sessionDetail("s1")).toMatchObject({ model: "claude-opus-5-5" });
  });

  it("reads a job session's model from the job's own agent, not its subagents", () => {
    const store = createStore();
    store.upsertSession({ id: "s1", external: true });
    store.upsertAgent({ sessionId: "s1", id: "job-1", kind: "external", model: "zai:glm-5.3" });
    store.addRequest(makeRequest({ id: "r1", ts: 100, agentId: "job-1", model: "zai:glm-5.3" }));
    store.addRequest(
      makeRequest({
        id: "r2",
        ts: 200,
        agentId: "sub-1",
        sessionId: "s1",
        model: "claude-opus-5-5",
      }),
    );
    expect(store.sessionDetail("s1")).toMatchObject({ model: "zai:glm-5.3" });
  });
});

describe("addToolCall", () => {
  it("merges duration and success as they firm up", () => {
    const store = createStore();
    const seen: ToolCallRecord[] = [];
    store.onUpdate((change) => seen.push(...change.tools));
    store.addToolCall(makeTool({ id: "t1", durationMs: null, ok: false }));
    store.addToolCall(makeTool({ id: "t1", durationMs: 50, ok: false }));
    store.addToolCall(makeTool({ id: "t1", durationMs: 60, ok: true }));
    expect(seen).toHaveLength(3);
    expect(seen[1]).toMatchObject({ durationMs: 50, ok: false });
    expect(seen[2]).toMatchObject({ id: "t1", durationMs: 60, ok: true });
    expect(store.models().tools).toEqual([{ name: "Bash", count: 1, failures: 0 }]);
    expect(store.sessionDetail("s1")).toMatchObject({ toolCount: 1, errorCount: 0 });
  });
});

describe("upserts", () => {
  it("keeps the first session facts, the earliest start, and lets external flip freely", () => {
    const store = createStore();
    store.upsertSession({
      id: "s1",
      cwd: "/a",
      upstream: "u1",
      ccVersion: "1.0",
      startedAt: 100,
      external: false,
    });
    store.upsertSession({
      id: "s1",
      cwd: "/b",
      upstream: "u2",
      ccVersion: "2.0",
      startedAt: 50,
      external: true,
    });
    expect(store.sessionDetail("s1")).toMatchObject({
      cwd: "/a",
      upstream: "u1",
      ccVersion: "1.0",
      startedAt: 50,
      external: true,
    });
  });

  it("ends a session and every agent in it", () => {
    const store = createStore();
    store.upsertSession({ id: "s1" });
    store.upsertAgent({ sessionId: "s1", id: "w1" });
    store.endSession("s1", 900);
    const detail = store.sessionDetail("s1");
    expect(detail).toMatchObject({ live: false, endedAt: 900 });
    expect(detail?.agents.every((agent) => !agent.live)).toBe(true);
  });

  it("upserts external agents with their own shape and retires them on end", () => {
    const store = createStore();
    store.upsertAgent({
      sessionId: "s1",
      id: "w1",
      parentId: null,
      kind: "external",
      name: "zai job",
      model: "zai:glm-5.3",
      title: "Fix tests",
    });
    store.upsertAgent({ sessionId: "s1", id: "w1", model: "zai:other" }); // model seeds once
    const w1 = store.sessionDetail("s1")?.agents.find((agent) => agent.id === "w1");
    expect(w1).toMatchObject({
      id: "w1",
      parentId: null,
      kind: "external",
      name: "Fix tests",
      model: "zai:glm-5.3",
      live: true,
    });
    store.endAgent("s1", "w1", 500);
    expect(store.sessionDetail("s1")?.agents.find((agent) => agent.id === "w1")?.live).toBe(false);
  });

  it("carries an agent's meta type and task, naming it type and task ahead of its prompt", () => {
    const store = createStore();
    store.upsertAgent({ sessionId: "s1", id: "a1", agentType: "Explore", description: "find it" });
    expect(store.sessionDetail("s1")?.agents.find((agent) => agent.id === "a1")).toMatchObject({
      name: "Explore — find it",
      agentType: "Explore",
      description: "find it",
    });
    store.upsertAgent({ sessionId: "s1", id: "a1", title: "The search" });
    expect(store.sessionDetail("s1")?.agents.find((agent) => agent.id === "a1")?.name).toBe(
      "Explore — find it", // the meta file's name outranks the prompt head
    );
  });
});

describe("names, branches and repos", () => {
  it("takes the first non-empty of custom title, agent name, AI title and slug, latest value of each", () => {
    const store = createStore();
    store.upsertSession({ id: "s1", slug: "first-slug" });
    expect(store.sessionDetail("s1")?.name).toBe("first-slug");
    store.upsertSession({ id: "s1", customTitle: "Port the router" });
    expect(store.sessionDetail("s1")?.name).toBe("Port the router");
    store.upsertSession({ id: "s1", agentName: "Scout", aiTitle: "Porting" });
    expect(store.sessionDetail("s1")?.name).toBe("Port the router");
    store.upsertSession({ id: "s1", customTitle: "", slug: "second-slug" }); // empty values change nothing
    store.upsertSession({ id: "s1", customTitle: "Port the router, part two" });
    expect(store.sessionDetail("s1")?.name).toBe("Port the router, part two");
    store.upsertSession({ id: "s2", slug: "a" });
    store.upsertSession({ id: "s2", slug: "b" });
    expect(store.sessionDetail("s2")?.name).toBe("b"); // latest slug wins within its own key
  });

  it("never leaves a session unnamed: slug, then repo, then the id's first eight characters", () => {
    const store = createStore();
    // a session nothing named — no titles, no registry name, no repo — still reads as its id
    store.upsertSession({ id: "13fbb7a3-aaaa-bbbb" });
    expect(store.sessionDetail("13fbb7a3-aaaa-bbbb")?.name).toBe("Session 13fbb7a3");
    expect(store.sessionList().find((item) => item.id === "13fbb7a3-aaaa-bbbb")?.name).toBe(
      "Session 13fbb7a3",
    );
    // a repo outranks the id, and the transcript's slug outranks the repo
    store.upsertSession({ id: "13fbb7a3-aaaa-bbbb", repo: "proxbeam" });
    expect(store.sessionDetail("13fbb7a3-aaaa-bbbb")?.name).toBe("proxbeam");
    store.upsertSession({ id: "13fbb7a3-aaaa-bbbb", slug: "fix-the-valve" });
    expect(store.sessionDetail("13fbb7a3-aaaa-bbbb")?.name).toBe("fix-the-valve");
  });

  it("keeps the latest branch and a job's repo and parent session", () => {
    const store = createStore();
    store.upsertSession({ id: "j1", branch: "zai/one", repo: "/w/main", parentSessionId: "s9" });
    store.upsertSession({ id: "j1", branch: "zai/two" });
    expect(store.sessionDetail("j1")).toMatchObject({
      branch: "zai/two",
      repo: "/w/main",
      parentSessionId: "s9",
    });
    expect(store.sessionList().find((item) => item.id === "j1")).toMatchObject({
      branch: "zai/two",
      repo: "/w/main",
      parentSessionId: "s9",
    });
  });

  it("derives a plain session's repo from its cwd and caches it there", () => {
    const repo = mkdtempSync(join(tmpdir(), "radar-repo-"));
    const worktree = mkdtempSync(join(tmpdir(), "radar-wt-"));
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
    const store = createStore();
    store.upsertSession({ id: "s1", cwd: join(repo, "src") });
    store.upsertSession({ id: "s2", cwd: worktree });
    expect(store.sessionDetail("s1")?.repo).toBe(repo);
    expect(store.sessionDetail("s2")?.repo).toBe(repo); // the worktree folds into its main checkout
    rmSync(join(repo, ".git"), { recursive: true });
    expect(store.sessionDetail("s1")?.repo).toBe(repo); // answered from the cache, not walked again
    expect(store.sessionDetail("nope")).toBeNull();
  });
});

describe("views", () => {
  it("models() reuses the aggregations over everything stored", () => {
    const store = createStore();
    store.addRequest(
      makeRequest({
        model: "glm-5.3",
        upstream: "http://127.0.0.1:8787",
        tokens: tokens(10, 0, 0, 0),
        stopReason: "end_turn", // a finished request: an in-flight one is never priced
      }),
    );
    store.addToolCall(makeTool({ ok: false }));
    const out = store.models();
    expect(out.models).toEqual([
      {
        model: "glm-5.3",
        provider: "Z.ai",
        requests: 1,
        errors: 0,
        tokens: tokens(10, 0, 0, 0),
        latencyP50: 100,
        costUsd: 0.000014,
      },
    ]);
    expect(out.upstreams[0]).toMatchObject({
      upstream: "http://127.0.0.1:8787",
      host: "127.0.0.1:8787",
      requests: 1,
    });
    expect(out.tools).toEqual([{ name: "Bash", count: 1, failures: 1 }]);
  });

  it("summary() counts live sessions and totals across the board", () => {
    const store = createStore();
    expect(store.summary()).toMatchObject({ sessions: 0, liveSessions: 0, requests: 0, tokens: ZERO_TOKENS });
    store.addRequest(makeRequest({ tokens: tokens(1, 2, 3, 4) }));
    store.upsertSession({ id: "s2", startedAt: 5 });
    expect(store.summary()).toMatchObject({ sessions: 2, liveSessions: 0 });
    store.applyRegistry(
      [
        {
          pid: 101,
          sessionId: "s1",
          name: null,
          nameSource: null,
          status: "busy",
          cwd: null,
          startedAt: null,
        },
        {
          pid: 102,
          sessionId: "s2",
          name: null,
          nameSource: null,
          status: "idle",
          cwd: null,
          startedAt: null,
        },
      ],
      T9,
    );
    expect(store.summary()).toMatchObject({
      sessions: 2,
      liveSessions: 2,
      requests: 1,
      tokens: tokens(1, 2, 3, 4),
    });
  });

  it("computes latency p95 per agent from its own requests, and a dash under five timed ones", () => {
    const store = createStore();
    for (const [i, latency] of [100, 200, 300, 400, 500, 1000].entries()) {
      store.addRequest(makeRequest({ id: `r${i}`, ts: T1 + i, latencyMs: latency }));
    }
    // six timed requests: the linear-interpolation p95 lands between the two top values
    expect(store.sessionDetail("s1")?.agents.find((agent) => agent.id === "main")?.latencyP95).toBe(875);
    // five requests but one untimed: four samples say nothing
    store.addRequest(makeRequest({ id: "r9", ts: T1 + 9, latencyMs: null }));
    store.upsertAgent({ sessionId: "s1", id: "w1" });
    for (const i of [0, 1, 2]) {
      store.addRequest(makeRequest({ id: `w${i}`, ts: T1 + i, agentId: "w1", latencyMs: 50 + i }));
    }
    expect(store.sessionDetail("s1")?.agents.find((agent) => agent.id === "w1")?.latencyP95).toBeNull();
  });

  it("splits a session's cost by family over the very requests the card's estimate sums", () => {
    const store = createStore();
    store.addRequest(makeRequest({ id: "r1", ts: T1, stopReason: "end_turn" })); // claude, via anthropic
    store.addRequest(
      makeRequest({
        id: "r2",
        model: "glm-5.3",
        upstream: "https://api.z.ai",
        ts: T1,
        tokens: tokens(1e6, 0, 0, 0),
        stopReason: "end_turn",
      }),
    );
    store.addRequest(
      makeRequest({
        id: "r3",
        model: "kimi-k3",
        upstream: "https://api.moonshot.ai",
        ts: T1,
        tokens: tokens(0, 0, 0, 1e6),
        stopReason: "end_turn",
      }),
    );
    store.addRequest(
      makeRequest({ id: "r4", model: "not-a-model", ts: T1, stopReason: "end_turn" }), // unpriced: nowhere
    );
    const listed = store.sessionList().find((item) => item.id === "s1");
    const split = listed?.costSplitUsd;
    expect(split?.claude).toBeGreaterThan(0);
    expect(split?.glm).toBeGreaterThan(0);
    expect(split?.other).toBeGreaterThan(0);
    const parts = addCost(addCost(split?.claude ?? null, split?.glm ?? null), split?.other ?? null);
    expect(parts).toBeCloseTo(listed?.costUsd ?? -1); // the header's parts add up to the card's number
  });
});

describe("bounds", () => {
  it("keeps at most MAX_SESSIONS sessions, dropping the stalest", () => {
    const store = createStore();
    for (let i = 0; i <= MAX_SESSIONS + 4; i += 1) {
      store.addSpoolLine(line({ ts: iso(T0 + i), session_id: `s${i}` }));
    }
    const list = store.sessionList();
    expect(list).toHaveLength(MAX_SESSIONS);
    expect(list.some((item) => item.id === "s0")).toBe(false);
    expect(list.some((item) => item.id === `s${MAX_SESSIONS + 4}`)).toBe(true);
  });

  /** Names the boundary records so eviction can be asserted by label. */
  function promptAt(i: number, last: number): string {
    if (i === 0) return "first";
    if (i === 1) return "second";
    return i === last ? "last" : "mid";
  }

  it("keeps at most MAX_RECORDS records, shedding the oldest events first", () => {
    const store = createStore();
    const total = MAX_RECORDS + 2;
    for (let i = 0; i < total; i += 1) {
      const prompt = promptAt(i, total - 1);
      store.addSpoolLine({ ts: iso(T0 + i), event: "UserPromptSubmit", session_id: "bulk", prompt });
    }
    const events = store.events({ limit: 1_000_000 });
    expect(events.length).toBeLessThanOrEqual(MAX_RECORDS); // a batch can leave the store under the cap
    expect(events[0]?.label).toBe("last"); // the newest record is never among the shed
    expect(events.some((event) => event.label === "first" || event.label === "second")).toBe(false);
  });

  /** Kept records of one session, and the oldest timestamp any of them carries. */
  function keptOf(store: ReturnType<typeof createStore>, session: string): { count: number; oldest: number } {
    const mine = store.raw().requests.filter((record) => record.sessionId === session);
    return {
      count: mine.length,
      oldest: mine.reduce((min, record) => Math.min(min, record.ts), Number.POSITIVE_INFINITY),
    };
  }

  it("sheds by timestamp, never by arrival order: an older batch that lands last is the one that goes", () => {
    const store = createStore();
    for (let i = 0; i < 100_000; i += 1) {
      // the fresh records arrive first — under insertion-order draining they would be the ones shed
      store.addRequest(makeRequest({ id: `fresh-${i}`, sessionId: "fresh", ts: T0 + i }));
    }
    for (let i = 0; i < 100_001; i += 1) {
      store.addRequest(makeRequest({ id: `aged-${i}`, sessionId: "aged", ts: T0 - 100_001 + i }));
    }
    expect(keptOf(store, "fresh")).toMatchObject({ count: 100_000 });
    const aged = keptOf(store, "aged");
    expect(aged.count).toBe(80_001); // exactly one batch over the cap, taken from the oldest by ts
    expect(aged.oldest).toBe(T0 - 80_001);
  });

  it("keeps a live session's records while younger unprotected records are shed instead", () => {
    const store = createStore();
    store.applyRegistry(
      [
        {
          pid: 4711,
          sessionId: "open",
          name: null,
          nameSource: null,
          status: "busy",
          cwd: null,
          startedAt: T0,
        },
      ],
      T9,
    );
    for (let i = 0; i < 60_000; i += 1) {
      store.addRequest(makeRequest({ id: `open-${i}`, sessionId: "open", agentId: "main", ts: T0 + i }));
    }
    for (let i = 0; i < 140_001; i += 1) {
      store.addRequest(makeRequest({ id: `closed-${i}`, sessionId: "closed", ts: T0 + 60_000 + i }));
    }
    const open = keptOf(store, "open");
    expect(open).toMatchObject({ count: 60_000 }); // the oldest records held, and every one of them kept
    const closed = keptOf(store, "closed");
    expect(closed.count).toBe(120_001); // the shedding took the dead session's oldest, not the live one's
    expect(closed.oldest).toBe(T0 + 80_000);
  });

  it("sheds across collections by timestamp: an old tool call goes before any newer request", () => {
    const store = createStore();
    for (let i = 0; i < 60_000; i += 1) {
      store.addToolCall(makeTool({ id: `tool-${i}`, sessionId: "s1", startedAt: T0 + i }));
    }
    for (let i = 0; i < 140_001; i += 1) {
      store.addRequest(makeRequest({ id: `req-${i}`, sessionId: "s1", ts: T0 + 60_000 + i }));
    }
    expect(store.raw().tools).toHaveLength(40_000);
    expect(store.raw().requests).toHaveLength(140_001);
  });
});

describe("notifications", () => {
  it("delivers deltas to listeners until they unsubscribe, versioning every change", () => {
    const store = createStore();
    const seen: Change[] = [];
    const off = store.onUpdate((change) => seen.push(change));
    const before = store.version();
    store.addSpoolLine(line({}));
    store.addRequest(makeRequest({ ts: T2 }));
    off();
    store.addToolCall(makeTool({}));
    expect(seen).toHaveLength(2);
    expect(seen[0]?.sessions).toBe(true);
    expect(seen[0]?.events).toHaveLength(1);
    expect(seen[0]?.events[0]?.kind).toBe("UserPromptSubmit");
    expect(seen[1]?.requests).toHaveLength(1);
    expect(store.version()).toBe(before + 3);
  });
});

describe("scale", () => {
  it("answers sessionDetail and sessionList for 300 agents over 10,000 requests in under 300 ms", () => {
    const store = createStore();
    store.upsertSession({ id: "s1", cwd: "/w/app" });
    for (let a = 0; a < 300; a += 1) {
      store.upsertAgent({ sessionId: "s1", id: `w${a}`, kind: "subagent", name: `worker ${a}` });
    }
    for (let i = 0; i < 10_000; i += 1) {
      store.addRequest(
        makeRequest({
          id: `r${i}`,
          sessionId: "s1",
          agentId: `w${i % 300}`,
          ts: T0 + i,
          tokens: tokens(10, 5, 0, 0),
        }),
      );
    }
    const started = performance.now();
    const listed = store.sessionList();
    let agents = 0;
    let requestCount = 0;
    for (const item of listed) {
      const view = store.sessionDetail(item.id);
      agents += view?.agents.length ?? 0;
      requestCount += view?.requestCount ?? 0;
    }
    const elapsed = performance.now() - started;
    expect(listed).toHaveLength(1);
    expect(agents).toBe(301); // the 300 subagents plus the session's own main
    expect(requestCount).toBe(10_000);
    expect(elapsed).toBeLessThan(300);
  });
});
