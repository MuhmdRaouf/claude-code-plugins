import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Summary } from "../src/shared/model.ts";
import { DEFAULT_RANGE } from "../src/shared/time-range.ts";
import type { SessionListItem } from "../src/store/store.ts";
import { type HttpResponse, hashOf, hashParse, type Io, RadarController } from "../src/ui/app/controller.ts";
import { exportName } from "../src/ui/export.ts";
import type { ClientState, ThemePref } from "../src/ui/state.ts";
import { makeRequest, makeSessionView, makeTool } from "./helpers.ts";

type Answer = HttpResponse;
type Call = { path: string; init?: { body?: string; method?: string } };

const ok = (body: unknown): Answer => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number, body: unknown = {}): Answer => ({
  ok: false,
  status,
  json: async () => body,
});

/** An answer whose JSON hangs until the test resolves it with the body, so loads can be interleaved. */
function deferred(): { answer: Answer; resolve: (body: unknown) => void } {
  let resolve: (body: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((res) => {
    resolve = res;
  });
  return { answer: { ok: true, status: 200, json: () => promise }, resolve };
}

/** Storage that always fails, the way private mode does. */
const brokenStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem: () => {
    throw new Error("storage off");
  },
  setItem: () => {
    throw new Error("storage off");
  },
  removeItem: () => {
    throw new Error("storage off");
  },
};

const SUMMARY: Summary = {
  sessions: 2,
  liveSessions: 1,
  agents: 3,
  requests: 9,
  tokens: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 },
  errors: 0,
  toolCalls: 4,
  latencyP50: null,
  latencyP95: null,
  startedAt: null,
  now: 0,
};

const MODELS = { models: [], upstreams: [], tools: [] };

const ATTRIBUTION_ROW = {
  key: "app",
  label: "app",
  requests: 3,
  tokens: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0.5,
  unpriced: 0,
};

const ATTRIBUTION_NODE = {
  ...ATTRIBUTION_ROW,
  kind: "repo",
  note: null,
  mix: [{ model: "glm-5.3", tokens: 14 }],
  children: [],
};

function item(id: string, lastAt: number): SessionListItem {
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
    activity: {
      bucketMs: 18_750,
      counts: new Array<number>(48).fill(0),
      models: new Array<string>(48).fill(""),
    },
    model: null,
    agentCount: 0,
    liveAgentCount: 0,
    requestCount: 0,
    tokens: 0,
    lastAt,
    external: false,
    title: null,
  };
}

const SNAPSHOT = {
  type: "snapshot",
  summary: SUMMARY,
  sessions: [item("s1", 20), item("s2", 10)],
  models: MODELS,
};

function sessionsMessage(sessions: SessionListItem[] = [item("s1", 20), item("s2", 10)]): unknown {
  return { type: "sessions", summary: SUMMARY, sessions, models: MODELS };
}

function defaultAnswers(): Map<string, Answer> {
  return new Map<string, Answer>([
    ["/api/alerts", ok({ alerts: [{ id: "a1" }, { id: "a2" }] })],
    ["/api/budget-status", ok({ version: 1, updatedAt: 0, stopped: [], spend: [] })],
    ["/api/spend", ok({ todayUsd: 1.25 })],
    ["/api/attribution?by=tree&range=day", ok({ tree: [ATTRIBUTION_NODE] })],
    ["/api/router", ok({ windowMs: 60_000, buckets: 12, providers: [], recent: [] })],
    ["/api/advisor", ok({ runsChecked: 0, candidates: 0, savingUsd: null, byModel: [], examples: [] })],
    [
      "/api/budgets",
      ok({
        budgets: [{ id: "b1", scope: "provider:zai", period: "month", limitUsd: 10, action: "warn" }],
        providers: ["zai", "kimi"],
      }),
    ],
    ["/api/settings", ok({ settings: { notifications: true } })],
    ["/api/health", ok({ ok: true, version: "0.0.1", startedAt: 5, port: 4000, sessions: 2, uptimeMs: 100 })],
    ["/api/requests?limit=1000", ok({ requests: [makeRequest()] })],
    [
      "/api/events?limit=500",
      ok({
        events: [
          { seq: 1, ts: 900, kind: "Notice", sessionId: "s1", agentId: null, label: null, payload: null },
        ],
      }),
    ],
    ["/api/tools?limit=1000", ok({ tools: [makeTool()] })],
    // the list items are ended sessions, so their details are ended sessions too: the live words agree
    ["/api/sessions/s1", ok({ session: makeSessionView({ live: false }) })],
    ["/api/sessions/s2", ok({ session: makeSessionView({ id: "s2", live: false }) })],
  ]);
}

function mapStorage(store: Map<string, string>): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  return {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
  };
}

type Harness = {
  controller: RadarController;
  answers: Map<string, Answer>;
  calls: Call[];
  streams: { push(data: string): void; fail(): void; open(): void; closed: boolean }[];
  downloads: { name: string; text: string }[];
  themes: ThemePref[];
  revealed: number[];
  focused: string[];
  replaced: string[];
  pushed: string[];
  clipboard: string[];
  location: { hash: string };
  storage: Map<string, string>;
};

function makeHarness(
  options: { hash?: string; storage?: Map<string, string>; broken?: boolean } = {},
): Harness {
  const answers = defaultAnswers();
  const calls: Call[] = [];
  const streams: Harness["streams"] = [];
  const downloads: Harness["downloads"] = [];
  const themes: ThemePref[] = [];
  const revealed: number[] = [];
  const focused: string[] = [];
  const replaced: string[] = [];
  const pushed: string[] = [];
  const clipboard: string[] = [];
  const location = { hash: options.hash ?? "" };
  const store = options.storage ?? new Map<string, string>();
  const storage = options.broken === true ? brokenStorage : mapStorage(store);

  class FakeStream {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((message: { data: string }) => void) | null = null;
    closed = false;

    constructor() {
      streams.push(this);
    }

    close(): void {
      this.closed = true;
    }

    open(): void {
      this.onopen?.();
    }

    fail(): void {
      this.onerror?.();
    }

    push(data: string): void {
      this.onmessage?.({ data });
    }
  }

  const io: Io = {
    fetch: vi.fn((path: string, init?: { body?: string; method?: string }): Promise<Answer> => {
      calls.push(init === undefined ? { path } : { path, init });
      const answer = answers.get(path);
      return Promise.resolve(answer ?? fail(404));
    }),
    EventSource: FakeStream,
    storage,
    location,
    replaceHash: (hash: string) => {
      replaced.push(hash);
      location.hash = hash;
    },
    pushHash: (hash: string) => {
      pushed.push(hash);
      location.hash = hash;
    },
    now: () => Date.now(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    download: (name: string, text: string) => {
      downloads.push({ name, text });
    },
    href: () => "http://127.0.0.1:47400/",
    clipboard: (text: string) => {
      clipboard.push(text);
    },
    applyTheme: (pref: ThemePref) => {
      themes.push(pref);
    },
    revealView: () => {
      revealed.push(Date.now());
    },
    focusOpener: (id: string) => {
      focused.push(id);
    },
  };

  return {
    controller: new RadarController(io),
    answers,
    calls,
    streams,
    downloads,
    themes,
    revealed,
    focused,
    replaced,
    pushed,
    clipboard,
    location,
    storage: store,
  };
}

/** Let every fetch and its state change land without firing the 250 ms notification or the 10 s poll. */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await vi.advanceTimersByTimeAsync(0);
}

/** Backfill done, stream attached, polled data in. */
async function started(harness: Harness): Promise<void> {
  harness.controller.start();
  await settle();
}

function callsTo(harness: Harness, path: string): number {
  return harness.calls.filter((call) => call.path === path).length;
}

function putBody(harness: Harness, path: string): unknown {
  const put = harness.calls.find((call) => call.path === path && call.init?.method !== undefined);
  return JSON.parse(put?.init?.body ?? "{}") as unknown;
}

function putCount(harness: Harness, path: string): number {
  return harness.calls.filter((call) => call.path === path && call.init?.method !== undefined).length;
}

async function withSettingsLoaded(harness: Harness): Promise<void> {
  await harness.controller.loadTab("settings");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("preferences at construction", () => {
  it("defaults to the overview tab, the system theme and relative times", () => {
    const harness = makeHarness();
    const state = harness.controller.getState();
    expect(state.tab).toBe("overview");
    expect(state.theme).toBe("system");
    expect(state.timeMode).toBe("relative");
  });

  it("reads the tab from the URL hash, with or without the slash", () => {
    expect(makeHarness({ hash: "#requests" }).controller.getState().tab).toBe("requests");
    expect(makeHarness({ hash: "#/tools" }).controller.getState().tab).toBe("tools");
    expect(makeHarness({ hash: "#nope" }).controller.getState().tab).toBe("overview");
  });

  it("reads the saved theme and time mode", () => {
    const storage = new Map<string, string>([
      ["radar-theme", "dark"],
      ["radar-time", "absolute"],
    ]);
    const state = makeHarness({ storage }).controller.getState();
    expect(state.theme).toBe("dark");
    expect(state.timeMode).toBe("absolute");
  });

  it("falls back to the defaults on a saved value it does not know", () => {
    const storage = new Map<string, string>([
      ["radar-theme", "blue"],
      ["radar-time", "sometimes"],
    ]);
    const state = makeHarness({ storage }).controller.getState();
    expect(state.theme).toBe("system");
    expect(state.timeMode).toBe("relative");
  });

  it("falls back to the defaults when storage is off", () => {
    const state = makeHarness({ broken: true }).controller.getState();
    expect(state.theme).toBe("system");
    expect(state.timeMode).toBe("relative");
  });
});

describe("subscriptions and notifications", () => {
  it("notifies at once for a reader action and stops after unsubscribe", () => {
    const harness = makeHarness();
    const seen: ClientState[] = [];
    const unsubscribe = harness.controller.subscribe((state) => seen.push(state));
    harness.controller.act("range", "24h");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.range).toEqual({ preset: "24h", from: 0, to: null });
    unsubscribe();
    harness.controller.act("range", "5m");
    expect(seen).toHaveLength(1);
    expect(harness.controller.getState().range).toEqual({ preset: "5m", from: 0, to: null });
  });

  it("coalesces live updates into one notification per 250 ms", async () => {
    const harness = makeHarness();
    const seen: number[] = [];
    harness.controller.subscribe((state) => seen.push(state.requests.length));
    await started(harness);
    seen.length = 0;
    harness.streams.at(-1)?.push(JSON.stringify({ type: "request", request: makeRequest({ id: "r1" }) }));
    harness.streams.at(-1)?.push(JSON.stringify({ type: "request", request: makeRequest({ id: "r2" }) }));
    expect(seen).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([3]);
  });

  it("flush() notifies at once and cancels the queued notification", async () => {
    const harness = makeHarness();
    const seen: number[] = [];
    harness.controller.subscribe((state) => seen.push(state.requests.length));
    await started(harness);
    seen.length = 0;
    harness.streams.at(-1)?.push(JSON.stringify({ type: "request", request: makeRequest({ id: "r1" }) }));
    harness.controller.flush();
    expect(seen).toEqual([2]);
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual([2]);
    harness.controller.flush();
    expect(seen).toEqual([2, 2]);
  });
});

describe("act: view actions", () => {
  it("switches tab, rewrites the hash, reveals the view and loads the tab's data", async () => {
    const harness = makeHarness();
    harness.controller.act("tab", "costs");
    await settle();
    const state = harness.controller.getState();
    expect(state.tab).toBe("costs");
    expect(harness.location.hash).toBe("#costs");
    expect(harness.replaced).toEqual(["#costs"]);
    expect(harness.revealed).toHaveLength(1);
    expect(state.attributionTree).toEqual([ATTRIBUTION_NODE]);
  });

  it("does not rewrite the hash when it already names the tab", () => {
    const harness = makeHarness();
    harness.controller.act("tab", "tools");
    harness.controller.act("tab", "tools");
    expect(harness.replaced).toEqual(["#tools"]);
    expect(harness.revealed).toHaveLength(2);
  });

  it("ignores a tab it does not know", () => {
    const harness = makeHarness();
    harness.controller.act("tab", "nope");
    expect(harness.controller.getState().tab).toBe("overview");
    expect(harness.replaced).toEqual([]);
    expect(harness.revealed).toHaveLength(0);
  });

  it("selects and clears a session, resetting the model filter and the picked agent", () => {
    const harness = makeHarness();
    harness.controller.act("model", "claude-sonnet-5-5");
    harness.controller.act("agent", "a1");
    harness.controller.act("session", "s1");
    expect(harness.controller.getState().session).toBe("s1");
    expect(harness.controller.getState().selected).toEqual(["s1"]);
    expect(harness.controller.getState().agent).toBeNull();
    expect(harness.controller.getState().model).toBeNull();
    harness.controller.act("session", "");
    expect(harness.controller.getState().session).toBeNull();
    expect(harness.controller.getState().selected).toEqual([]);
    expect(callsTo(harness, "/api/sessions/s1")).toBe(0);
  });

  it("toggles sessions in and out of the picked set, and clearSelection empties it", () => {
    const harness = makeHarness();
    harness.controller.act("model", "m1");
    harness.controller.act("agent", "a1");
    harness.controller.act("session", "s1");
    harness.controller.act("session", "s2");
    expect(harness.controller.getState().selected).toEqual(["s1", "s2"]);
    expect(harness.controller.getState().session).toBeNull();
    expect(harness.controller.getState().agent).toBeNull();
    expect(harness.controller.getState().model).toBeNull();
    harness.controller.act("session", "s1"); // the second click on a card picks it back out
    expect(harness.controller.getState().selected).toEqual(["s2"]);
    expect(harness.controller.getState().session).toBe("s2");
    harness.controller.act("clearSelection");
    expect(harness.controller.getState().selected).toEqual([]);
    expect(harness.controller.getState().session).toBeNull();
  });

  it("fetches every picked session's detail once a snapshot lands", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.controller.act("session", "s1");
    harness.controller.act("session", "s2");
    harness.streams.at(-1)?.push(JSON.stringify(sessionsMessage()));
    await settle();
    expect(callsTo(harness, "/api/sessions/s1")).toBeGreaterThanOrEqual(1);
    expect(callsTo(harness, "/api/sessions/s2")).toBeGreaterThanOrEqual(1);
  });

  it("picks an agent on the session page and widens back, and narrows the live rail's filters", () => {
    const harness = makeHarness();
    harness.controller.act("session", "s1");
    harness.controller.act("agent", "a1");
    expect(harness.controller.getState().agent).toBe("a1");
    harness.controller.act("agent", "");
    expect(harness.controller.getState().agent).toBeNull();
    harness.controller.act("live-input", "sweep");
    harness.controller.act("live-repo", "/w/app");
    expect(harness.controller.getState().liveInput).toBe("sweep");
    expect(harness.controller.getState().liveRepo).toBe("/w/app");
    harness.controller.act("live-repo", "");
    expect(harness.controller.getState().liveRepo).toBeNull();
  });

  it("sets and clears the model filter", () => {
    const harness = makeHarness();
    harness.controller.act("model", "m1");
    expect(harness.controller.getState().model).toBe("m1");
    harness.controller.act("model", "");
    expect(harness.controller.getState().model).toBeNull();
  });

  it("filters tools to the failures and back", () => {
    const harness = makeHarness();
    harness.controller.act("tool-filter", "failed");
    expect(harness.controller.getState().toolFilter).toBe("failed");
    harness.controller.act("tool-filter", "everything");
    expect(harness.controller.getState().toolFilter).toBe("all");
  });

  it("changes the range only to a preset it knows, writing it into the URL in place", () => {
    const harness = makeHarness();
    harness.controller.act("range", "7d");
    expect(harness.controller.getState().range).toEqual({ preset: "7d", from: 0, to: null });
    expect(harness.replaced).toEqual(["#overview?range=7d"]);
    harness.controller.act("range", "nope");
    expect(harness.controller.getState().range).toEqual({ preset: "7d", from: 0, to: null });
    expect(harness.replaced).toHaveLength(1);
  });

  it("buckets the default hour from memory and never calls the flow route", async () => {
    const harness = makeHarness();
    await started(harness);
    expect(harness.calls.some((call) => call.path.startsWith("/api/history/flow"))).toBe(false);
  });

  it("fetches the flow route when the range reaches past what memory holds", async () => {
    const harness = makeHarness();
    const now = Date.now();
    const path = `/api/history/flow?from=${now - 7 * 86_400_000}&to=${now}&buckets=60`;
    const series = {
      from: now - 7 * 86_400_000,
      to: now,
      bucketMs: 10_800_000,
      requests: [1],
      kinds: { input: [1], output: [0], cacheRead: [0], cacheWrite: [0] },
    };
    harness.answers.set(path, ok({ ...series }));
    await started(harness);
    harness.controller.act("range", "7d");
    await settle();
    expect(callsTo(harness, path)).toBe(1);
    expect(harness.controller.getState().flowLoading).toBe(false);
    expect(harness.controller.getState().flow?.key).toBe("range=7d");
    expect(harness.controller.getState().flow?.series).toEqual(series);
  });

  it("keeps the stale flow out when the range changed mid-flight, and reports a failure", async () => {
    const harness = makeHarness();
    const now = Date.now();
    const gate = deferred();
    harness.answers.set(`/api/history/flow?from=${now - 7 * 86_400_000}&to=${now}&buckets=60`, gate.answer);
    await started(harness);
    harness.controller.act("range", "7d");
    expect(harness.controller.getState().flowLoading).toBe(true);
    harness.controller.act("range", "24h"); // in flight: not fetched twice, the answer will be dropped
    await settle();
    gate.resolve({ from: 0, to: 60, bucketMs: 1, requests: [1], kinds: {} });
    await settle();
    expect(harness.controller.getState().flow).toBeNull();
    expect(harness.controller.getState().flowLoading).toBe(false);
    const bad = makeHarness();
    const path = `/api/history/flow?from=100&to=${now}&buckets=60`;
    bad.answers.set(path, fail(503, { error: "history off" }));
    bad.controller.act("range-custom", "from=100");
    await settle();
    expect(bad.controller.getState().flowError).toBe(`GET ${path} → 503`);
  });

  it("applies a custom range from the picker's fieldset and ignores junk", () => {
    const harness = makeHarness();
    harness.controller.act("range-custom", "from=100&to=200");
    expect(harness.controller.getState().range).toEqual({ preset: null, from: 100, to: 200 });
    expect(harness.replaced).toEqual(["#overview?from=100&to=200"]);
    harness.controller.act("range-custom", "from=100"); // open-ended
    expect(harness.controller.getState().range).toEqual({ preset: null, from: 100, to: null });
    harness.controller.act("range-custom", "from=abc");
    harness.controller.act("range-custom", "to=200");
    harness.controller.act("range-custom", "from=300&to=200");
    expect(harness.controller.getState().range).toEqual({ preset: null, from: 100, to: null });
  });

  it("resets a custom range back to the last hour", () => {
    const harness = makeHarness();
    harness.controller.act("range-custom", "from=100&to=200");
    harness.controller.act("range-reset");
    expect(harness.controller.getState().range).toEqual({ preset: "1h", from: 0, to: null });
    expect(harness.replaced).toEqual(["#overview?from=100&to=200", "#overview"]);
  });

  it("freezes a relative range to absolute ends and copies the link", () => {
    const harness = makeHarness();
    const now = Date.now();
    harness.controller.act("range-copy");
    expect(harness.controller.getState().range).toEqual({
      preset: null,
      from: now - 3_600_000,
      to: now,
    });
    expect(harness.replaced).toEqual([`#overview?from=${now - 3_600_000}&to=${now}`]);
    expect(harness.clipboard).toEqual([`http://127.0.0.1:47400/#overview?from=${now - 3_600_000}&to=${now}`]);
  });

  it("keeps the range and the auto-refresh choice across a reload and Back/Forward", async () => {
    const now = Date.now();
    const restored = makeHarness({ hash: `#agents?range=24h` });
    expect(restored.controller.getState().range).toEqual({ preset: "24h", from: 0, to: null });
    const harness = makeHarness();
    await started(harness);
    harness.controller.act("range", "24h");
    // Back returns to the previous entry: the default hour, then forward to the saved 24h again
    harness.controller.act("hash", "#agents");
    expect(harness.controller.getState().range).toEqual({ preset: "1h", from: 0, to: null });
    harness.controller.act("hash", `#agents?range=24h&from=${now}`);
    expect(harness.controller.getState().range).toEqual({ preset: "24h", from: 0, to: null });
  });

  it("keeps the auto-refresh cadence in localStorage and ticks without re-pulling the lists", async () => {
    const storage = new Map<string, string>([["radar-refresh", "60000"]]);
    const harness = makeHarness({ storage });
    expect(harness.controller.getState().refresh).toBe(60000);
    await started(harness);
    const before = callsTo(harness, "/api/requests?limit=1000");
    await vi.advanceTimersByTimeAsync(60_000);
    // the live lists ride the stream's deltas; a tick re-pulls nothing
    expect(callsTo(harness, "/api/requests?limit=1000")).toBe(before);
    expect(callsTo(harness, "/api/events?limit=500")).toBe(before);
    expect(callsTo(harness, "/api/tools?limit=1000")).toBe(before);
    harness.controller.act("auto-refresh", "15000");
    expect(harness.controller.getState().refresh).toBe(15000);
    expect(storage.get("radar-refresh")).toBe("15000");
    harness.controller.act("auto-refresh", "7000");
    expect(harness.controller.getState().refresh).toBe(15000);
    harness.controller.act("auto-refresh", "0");
    expect(storage.get("radar-refresh")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(callsTo(harness, "/api/requests?limit=1000")).toBe(before);
  });

  it("ticks fetch only the flow when the range is history's to answer, nothing on a live range", async () => {
    const lists = (): number =>
      harness.calls.filter((call) =>
        ["/api/requests?limit=1000", "/api/events?limit=500", "/api/tools?limit=1000"].includes(call.path),
      ).length;
    const flowPath = (): string =>
      `/api/history/flow?from=${Date.now() - 7 * 86_400_000}&to=${Date.now()}&buckets=60`;
    const harness = makeHarness();
    await started(harness);
    harness.controller.act("range", "7d");
    await settle();
    harness.answers.set(flowPath(), ok({ from: 0, to: Date.now(), bucketMs: 1, requests: [], kinds: {} }));
    const listsAtHistory = lists();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    // the history flow is the one read a tick re-asks; the lists are never re-pulled
    const ticked = flowPath();
    expect(callsTo(harness, ticked)).toBe(1);
    expect(lists()).toBe(listsAtHistory);
    harness.controller.act("range-reset");
    await settle();
    const listsAfterReset = lists();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    // back on the default live hour, a tick fetches nothing at all
    expect(lists()).toBe(listsAfterReset);
    expect(callsTo(harness, ticked)).toBe(1);
  });

  it("falls back to the 5 s cadence when storage is off or the key is missing", () => {
    expect(makeHarness({ broken: true }).controller.getState().refresh).toBe(5000);
    expect(makeHarness().controller.getState().refresh).toBe(5000);
    expect(makeHarness({ storage: new Map([["radar-refresh", "junk"]]) }).controller.getState().refresh).toBe(
      5000,
    );
  });

  it("collapses and reopens an agent-tree key", () => {
    const harness = makeHarness();
    harness.controller.act("collapse", "s1/a");
    expect(harness.controller.getState().collapsed).toEqual(new Set(["s1/a"]));
    harness.controller.act("collapse", "s1/a");
    expect(harness.controller.getState().collapsed).toEqual(new Set());
  });

  it("opens the drawer and hands focus back to the opener row on close", () => {
    const harness = makeHarness();
    harness.controller.act("drawer", "req-1");
    expect(harness.controller.getState().request).toBe("req-1");
    harness.controller.act("close-drawer");
    expect(harness.controller.getState().request).toBeNull();
    expect(harness.focused).toEqual(["req-1"]);
    harness.controller.act("close-drawer");
    expect(harness.focused).toEqual(["req-1"]);
  });

  it("ignores close-drawer when no drawer is open", () => {
    const harness = makeHarness();
    harness.controller.act("close-drawer");
    expect(harness.focused).toEqual([]);
  });

  it("applies a theme it knows and remembers it, forgets system", () => {
    const harness = makeHarness();
    harness.controller.act("theme", "dark");
    expect(harness.themes).toEqual(["dark"]);
    expect(harness.controller.getState().theme).toBe("dark");
    expect(harness.storage.get("radar-theme")).toBe("dark");
    harness.controller.act("theme", "system");
    expect(harness.themes).toEqual(["dark", "system"]);
    expect(harness.storage.has("radar-theme")).toBe(false);
    harness.controller.act("theme", "sepia");
    expect(harness.themes).toEqual(["dark", "system"]);
    expect(harness.controller.getState().theme).toBe("system");
  });

  it("remembers absolute times and forgets relative ones, whatever the value", () => {
    const harness = makeHarness();
    harness.controller.act("time-mode", "absolute");
    expect(harness.controller.getState().timeMode).toBe("absolute");
    expect(harness.storage.get("radar-time")).toBe("absolute");
    harness.controller.act("time-mode", "nope");
    expect(harness.controller.getState().timeMode).toBe("relative");
    expect(harness.storage.has("radar-time")).toBe(false);
  });

  it("keeps going when storage is off", () => {
    const harness = makeHarness({ broken: true });
    harness.controller.act("theme", "dark");
    harness.controller.act("time-mode", "absolute");
    expect(harness.controller.getState().theme).toBe("dark");
    expect(harness.controller.getState().timeMode).toBe("absolute");
    expect(harness.themes).toEqual(["dark"]);
  });

  it("ignores an action it does not know", () => {
    const harness = makeHarness();
    const before = harness.controller.getState();
    harness.controller.act("levitate", "high");
    expect(harness.controller.getState()).toBe(before);
  });
});

describe("act: sorting", () => {
  it("sorts requests, flipping direction on the same column", () => {
    const harness = makeHarness();
    harness.controller.act("sort-requests", "cost");
    expect(harness.controller.getState().requestSort).toEqual({ key: "cost", dir: "desc" });
    harness.controller.act("sort-requests", "cost");
    expect(harness.controller.getState().requestSort).toEqual({ key: "cost", dir: "asc" });
    harness.controller.act("sort-requests", "agent");
    expect(harness.controller.getState().requestSort).toEqual({ key: "agent", dir: "asc" });
    harness.controller.act("sort-requests", "what"); // the What column is a text column
    expect(harness.controller.getState().requestSort).toEqual({ key: "what", dir: "asc" });
    harness.controller.act("sort-requests", "nope");
    expect(harness.controller.getState().requestSort).toEqual({ key: "what", dir: "asc" });
  });

  it("sorts tools, ignoring keys it does not know", () => {
    const harness = makeHarness();
    harness.controller.act("sort-tools", "tool");
    expect(harness.controller.getState().toolSort).toEqual({ key: "tool", dir: "asc" });
    harness.controller.act("sort-tools", "nope");
    expect(harness.controller.getState().toolSort).toEqual({ key: "tool", dir: "asc" });
  });

  it("sorts attribution, ignoring keys it does not know", () => {
    const harness = makeHarness();
    harness.controller.act("sort-attribution", "label");
    expect(harness.controller.getState().attributionSort).toEqual({ key: "label", dir: "asc" });
    harness.controller.act("sort-attribution", "nope");
    expect(harness.controller.getState().attributionSort).toEqual({ key: "label", dir: "asc" });
  });
});

describe("act: exports", () => {
  it("downloads the requests table as CSV", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.controller.act("export", "requests");
    const download = harness.downloads[0];
    expect(download?.name).toBe(exportName("requests", Date.now()));
    expect(download?.text.startsWith("time,request_id")).toBe(true);
    expect(download?.text).toContain("req-1");
  });

  it("downloads the tools table as CSV", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.controller.act("export", "tools");
    const download = harness.downloads[0];
    expect(download?.name).toBe(exportName("tools", Date.now()));
    expect(download?.text.startsWith("started,tool_use_id")).toBe(true);
    expect(download?.text).toContain("Bash");
  });

  it("downloads the costs tree as one flat CSV", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.controller.act("tab", "costs");
    await settle();
    harness.controller.act("export", "attribution");
    const download = harness.downloads[0];
    expect(download?.name).toBe(exportName("costs", Date.now()));
    expect(download?.text.startsWith("range,repo,session,agent,model")).toBe(true);
  });

  it("downloads nothing for a name it does not know", () => {
    const harness = makeHarness();
    harness.controller.act("export", "secrets");
    expect(harness.downloads).toEqual([]);
  });
});

describe("act: alerts", () => {
  it("drops the alert at once and tells the server", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/alerts/dismiss", ok({}));
    await started(harness);
    harness.controller.act("dismiss-alert", "a1");
    await settle();
    expect(harness.controller.getState().alerts.map((alert) => alert.id)).toEqual(["a2"]);
    const call = harness.calls.find((entry) => entry.path === "/api/alerts/dismiss");
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(call?.init?.body ?? "{}")).toEqual({ id: "a1" });
  });

  it("keeps the dismissal when the server refuses", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.controller.act("dismiss-alert", "a1");
    await settle();
    expect(harness.controller.getState().alerts.map((alert) => alert.id)).toEqual(["a2"]);
  });
});

describe("act: attribution controls", () => {
  it("collapses and reopens a tree row", () => {
    const harness = makeHarness();
    harness.controller.act("costs-collapse", "repo:app");
    expect(harness.controller.getState().costsCollapsed.has("repo:app")).toBe(true);
    harness.controller.act("costs-collapse", "repo:app");
    expect(harness.controller.getState().costsCollapsed.has("repo:app")).toBe(false);
  });

  it("changes the range and reloads", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/attribution?by=tree&range=week", ok({ tree: [] }));
    harness.controller.act("attribution-range", "week");
    await settle();
    const state = harness.controller.getState();
    expect(state.attributionRange).toBe("week");
    expect(state.attributionTree).toEqual([]);
  });

  it("ignores a range it does not know", () => {
    const harness = makeHarness();
    harness.controller.act("attribution-range", "quarter");
    expect(harness.controller.getState().attributionRange).toBe("day");
  });

  it("keeps a stale answer out when the range changed mid-flight", async () => {
    const harness = makeHarness();
    const gate = deferred();
    harness.answers.set("/api/attribution?by=tree&range=day", gate.answer);
    harness.controller.act("attribution-range", "week");
    gate.resolve({ tree: [{ ...ATTRIBUTION_NODE, label: "stale" }] });
    await settle();
    expect(harness.controller.getState().attributionTree).toBeNull();
  });

  it("keeps what is shown when the reload fails", async () => {
    const harness = makeHarness();
    harness.controller.act("tab", "costs");
    await settle();
    harness.answers.set("/api/attribution?by=tree&range=week", fail(500));
    harness.controller.act("attribution-range", "week");
    await settle();
    expect(harness.controller.getState().attributionTree).toBeNull();
  });
});

describe("budgets", () => {
  it("opens a fresh draft scoped to the first provider", async () => {
    const harness = makeHarness();
    await withSettingsLoaded(harness);
    harness.controller.act("new-budget");
    expect(harness.controller.getState().draft).toEqual({
      id: null,
      scope: "provider:zai",
      period: "month",
      limit: "10",
      action: "warn",
    });
    expect(harness.controller.getState().formMessage).toBeNull();
  });

  it("scopes a fresh draft to total when no provider is known", () => {
    const harness = makeHarness();
    harness.controller.act("new-budget");
    expect(harness.controller.getState().draft?.scope).toBe("total");
  });

  it("edits a saved budget and ignores an unknown id", async () => {
    const harness = makeHarness();
    await withSettingsLoaded(harness);
    harness.controller.act("edit-budget", "b1");
    expect(harness.controller.getState().draft).toEqual({
      id: "b1",
      scope: "provider:zai",
      period: "month",
      limit: "10",
      action: "warn",
    });
    harness.controller.act("cancel-budget");
    expect(harness.controller.getState().draft).toBeNull();
    harness.controller.act("edit-budget", "b9");
    expect(harness.controller.getState().draft).toBeNull();
  });

  it("keeps the form's choices in the draft", async () => {
    const harness = makeHarness();
    await withSettingsLoaded(harness);
    harness.controller.act("new-budget");
    harness.controller.act("draft-field", "scope=provider:kimi");
    harness.controller.act("draft-field", "period=week");
    harness.controller.act("draft-field", "action=stop");
    harness.controller.act("draft-field", "limit=7.5");
    expect(harness.controller.getState().draft).toEqual({
      id: null,
      scope: "provider:kimi",
      period: "week",
      limit: "7.5",
      action: "stop",
    });
  });

  it("keeps the draft when a field value is not one it knows", async () => {
    const harness = makeHarness();
    await withSettingsLoaded(harness);
    harness.controller.act("new-budget");
    harness.controller.act("draft-field", "period=quarter");
    harness.controller.act("draft-field", "action=nuke");
    expect(harness.controller.getState().draft).toEqual({
      id: null,
      scope: "provider:zai",
      period: "month",
      limit: "10",
      action: "warn",
    });
  });

  it("ignores field changes without a draft or without an = in the value", () => {
    const harness = makeHarness();
    harness.controller.act("draft-field", "scope=provider:kimi");
    harness.controller.act("new-budget");
    harness.controller.act("draft-field", "scope-no-equals");
    expect(harness.controller.getState().draft?.scope).toBe("total");
  });

  it("saves a new budget and re-polls the spend", async () => {
    const harness = makeHarness();
    await withSettingsLoaded(harness);
    harness.controller.act("new-budget");
    harness.controller.act("draft-field", "limit=25.5");
    const alertsBefore = callsTo(harness, "/api/alerts");
    harness.controller.act("save-budget");
    await settle();
    const state = harness.controller.getState();
    expect(state.draft).toBeNull();
    expect(state.formMessage).toEqual({ tone: "ok", text: "Budget added." });
    expect(putBody(harness, "/api/budgets")).toEqual({
      budgets: [
        { id: "b1", scope: "provider:zai", period: "month", limitUsd: 10, action: "warn" },
        {
          id: expect.stringMatching(/^b[0-9a-z]+$/),
          scope: "provider:zai",
          period: "month",
          limitUsd: 25.5,
          action: "warn",
        },
      ],
    });
    expect(callsTo(harness, "/api/alerts")).toBe(alertsBefore + 1);
  });

  it("saves an edit as a replacement", async () => {
    const harness = makeHarness();
    await withSettingsLoaded(harness);
    harness.controller.act("edit-budget", "b1");
    harness.controller.act("draft-field", "limit=99");
    harness.controller.act("save-budget");
    await settle();
    expect(harness.controller.getState().formMessage).toEqual({ tone: "ok", text: "Budget saved." });
    expect(putBody(harness, "/api/budgets")).toEqual({
      budgets: [{ id: "b1", scope: "provider:zai", period: "month", limitUsd: 99, action: "warn" }],
    });
  });

  it("refuses a limit the form rules reject and keeps the draft", async () => {
    const harness = makeHarness();
    await withSettingsLoaded(harness);
    harness.controller.act("new-budget");
    harness.controller.act("draft-field", "limit=0");
    harness.controller.act("save-budget");
    const state = harness.controller.getState();
    expect(state.formMessage).toEqual({ tone: "err", text: "Enter a limit above $0, like 25 or 7.50." });
    expect(state.draft?.limit).toBe("0");
    expect(putCount(harness, "/api/budgets")).toBe(0);
  });

  it("refuses a limit that is too large", async () => {
    const harness = makeHarness();
    await withSettingsLoaded(harness);
    harness.controller.act("new-budget");
    harness.controller.act("draft-field", "limit=2000000");
    harness.controller.act("save-budget");
    expect(harness.controller.getState().formMessage?.text).toBe(
      "That limit is too large; the most a budget takes is $1,000,000.",
    );
  });

  it("shows the server's error text when the save fails", async () => {
    const harness = makeHarness();
    await withSettingsLoaded(harness);
    harness.answers.set("/api/budgets", fail(400, { error: "nope" }));
    harness.controller.act("new-budget");
    harness.controller.act("save-budget");
    await settle();
    expect(harness.controller.getState().formMessage).toEqual({ tone: "err", text: "Not saved: nope" });
  });

  it("falls back to the status line when the answer is not JSON", async () => {
    const harness = makeHarness();
    await withSettingsLoaded(harness);
    harness.answers.set("/api/budgets", {
      ok: false,
      status: 400,
      json: () => Promise.reject(new Error("bad json")),
    });
    harness.controller.act("new-budget");
    harness.controller.act("save-budget");
    await settle();
    expect(harness.controller.getState().formMessage?.text).toBe("Not saved: PUT /api/budgets → 400");
  });

  it("saves nothing without a draft", () => {
    const harness = makeHarness();
    harness.controller.act("save-budget");
    expect(callsTo(harness, "/api/budgets")).toBe(0);
  });

  it("removes a budget", async () => {
    const harness = makeHarness();
    await withSettingsLoaded(harness);
    harness.controller.act("remove-budget", "b1");
    await settle();
    expect(harness.controller.getState().formMessage).toEqual({ tone: "ok", text: "Budget removed." });
    expect(putBody(harness, "/api/budgets")).toEqual({ budgets: [] });
  });

  it("removes from an empty list when none has arrived yet", async () => {
    const harness = makeHarness();
    harness.controller.act("remove-budget", "b1");
    await settle();
    expect(harness.controller.getState().formMessage).toEqual({ tone: "ok", text: "Budget removed." });
    expect(putBody(harness, "/api/budgets")).toEqual({ budgets: [] });
  });

  it("saves a new budget into an empty list when none has arrived yet", async () => {
    const harness = makeHarness();
    harness.controller.act("new-budget");
    harness.controller.act("draft-field", "limit=5");
    harness.controller.act("save-budget");
    await settle();
    expect(harness.controller.getState().formMessage).toEqual({ tone: "ok", text: "Budget added." });
    expect(putBody(harness, "/api/budgets")).toEqual({
      budgets: [
        {
          id: expect.stringMatching(/^b[0-9a-z]+$/),
          scope: "total",
          period: "month",
          limitUsd: 5,
          action: "warn",
        },
      ],
    });
  });

  it("toggles notifications off", async () => {
    const harness = makeHarness();
    await withSettingsLoaded(harness);
    harness.controller.act("toggle-notifications");
    await settle();
    expect(putBody(harness, "/api/settings")).toEqual({ notifications: false });
    expect(harness.controller.getState().settings).toEqual({ notifications: true });
    expect(harness.controller.getState().formMessage).toBeNull();
  });

  it("toggles off from the assumed default when no settings have arrived", async () => {
    const harness = makeHarness();
    harness.controller.act("toggle-notifications");
    await settle();
    expect(putBody(harness, "/api/settings")).toEqual({ notifications: false });
  });

  it("shows an error when the notification save fails", async () => {
    const harness = makeHarness();
    await withSettingsLoaded(harness);
    harness.answers.set("/api/settings", fail(409, { error: "read only" }));
    harness.controller.act("toggle-notifications");
    await settle();
    expect(harness.controller.getState().formMessage).toEqual({ tone: "err", text: "Not saved: read only" });
  });
});

describe("polled data", () => {
  it("fills alerts, budget status and today's spend", async () => {
    const harness = makeHarness();
    await started(harness);
    const state = harness.controller.getState();
    expect(state.alerts.map((alert) => alert.id)).toEqual(["a1", "a2"]);
    expect(state.budgetStatus).toEqual({ version: 1, updatedAt: 0, stopped: [], spend: [] });
    expect(state.spendToday).toBe(1.25);
  });

  it("keeps what is shown when the poll fails", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/spend", fail(500));
    await started(harness);
    const state = harness.controller.getState();
    expect(state.alerts).toEqual([]);
    expect(state.budgetStatus).toBeNull();
    expect(state.spendToday).toBeNull();
  });

  it("loads the router tab's data, keeping what is shown when it fails", async () => {
    const harness = makeHarness();
    harness.controller.act("tab", "router");
    await settle();
    expect(harness.controller.getState().router).toEqual({
      windowMs: 60_000,
      buckets: 12,
      providers: [],
      recent: [],
    });
    expect(harness.controller.getState().advisor).toEqual({
      runsChecked: 0,
      candidates: 0,
      savingUsd: null,
      byModel: [],
      examples: [],
    });
    harness.answers.set("/api/router", fail(500));
    harness.controller.act("tab", "router");
    await settle();
    expect(harness.controller.getState().router).not.toBeNull();
  });

  it("loads the settings tab's data, keeping what is shown when it fails", async () => {
    const harness = makeHarness();
    await withSettingsLoaded(harness);
    expect(harness.controller.getState().budgets).toHaveLength(1);
    expect(harness.controller.getState().providers).toEqual(["zai", "kimi"]);
    expect(harness.controller.getState().settings).toEqual({ notifications: true });
    harness.answers.set("/api/settings", fail(500));
    await withSettingsLoaded(harness);
    expect(harness.controller.getState().settings).toEqual({ notifications: true });
  });

  it("loads nothing extra for a tab the stream already feeds", async () => {
    const harness = makeHarness();
    const before = harness.calls.length;
    await harness.controller.loadTab("agents");
    expect(harness.calls).toHaveLength(before);
  });
});

describe("the stream", () => {
  it("marks the connection on open and off on error", async () => {
    const harness = makeHarness();
    await started(harness);
    const stream = harness.streams.at(-1);
    expect(harness.controller.getState().connected).toBe(false);
    stream?.open();
    expect(harness.controller.getState().connected).toBe(true);
    expect(harness.controller.getState().error).toBeNull();
    stream?.fail();
    expect(harness.controller.getState().connected).toBe(false);
  });

  it("backfills the lists again when the stream reopens, as a restart's reconnect must", async () => {
    const harness = makeHarness();
    await started(harness);
    const stream = harness.streams.at(-1);
    stream?.open(); // the boot connection
    await settle();
    const first = callsTo(harness, "/api/requests?limit=1000");
    expect(first).toBe(1);
    stream?.fail(); // the server went away
    stream?.open(); // it came back: the snapshot carries no record lists, so the backfill runs again
    await settle();
    expect(callsTo(harness, "/api/requests?limit=1000")).toBe(first + 1);
    expect(callsTo(harness, "/api/events?limit=500")).toBe(2);
    expect(callsTo(harness, "/api/tools?limit=1000")).toBe(2);
  });

  it("does not re-backfill on the first open, which the boot's own backfill just fed", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.streams.at(-1)?.open();
    await settle();
    expect(callsTo(harness, "/api/requests?limit=1000")).toBe(1);
  });

  it("folds a snapshot in without fetching a detail per session", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.streams.at(-1)?.push(JSON.stringify(SNAPSHOT));
    await settle();
    const state = harness.controller.getState();
    expect(state.summary).toEqual(SUMMARY);
    expect(state.sessions.map((session) => session.id)).toEqual(["s1", "s2"]);
    expect(state.updatedAt).not.toBeNull();
    // the sessions a view does not show are never fetched — jobs included
    expect(callsTo(harness, "/api/sessions/s1")).toBe(0);
    expect(callsTo(harness, "/api/sessions/s2")).toBe(0);
  });

  it("fetches the agents tab's own trees on a snapshot, the recent sessions only", async () => {
    const harness = makeHarness({ hash: "#agents" });
    await started(harness);
    harness.streams.at(-1)?.push(JSON.stringify(SNAPSHOT));
    await settle();
    expect(Object.keys(harness.controller.getState().details)).toEqual(["s1", "s2"]);
    expect(callsTo(harness, "/api/sessions/s1")).toBe(1);
    expect(callsTo(harness, "/api/sessions/s2")).toBe(1);
  });

  it("fetches only the picked session's detail as messages land", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.streams.at(-1)?.push(JSON.stringify(SNAPSHOT));
    await settle();
    harness.controller.act("session", "s2");
    await settle();
    expect(Object.keys(harness.controller.getState().details)).toEqual(["s2"]);
    expect(callsTo(harness, "/api/sessions/s2")).toBe(1);
    harness.streams.at(-1)?.push(JSON.stringify(sessionsMessage()));
    await settle();
    expect(callsTo(harness, "/api/sessions/s1")).toBe(0);
  });

  it("fetches a session the live rail expanded, and not the rest, as messages land", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.streams.at(-1)?.push(JSON.stringify(SNAPSHOT));
    await settle();
    harness.controller.act("tree", "s2");
    await settle();
    expect(callsTo(harness, "/api/sessions/s2")).toBe(1);
    harness.streams.at(-1)?.push(JSON.stringify(sessionsMessage()));
    await settle();
    // the expanded card's tree survives the next message; nothing else was fetched for it
    expect(callsTo(harness, "/api/sessions/s2")).toBe(1);
    expect(callsTo(harness, "/api/sessions/s1")).toBe(0);
  });

  it("does not refetch details it already has", async () => {
    const harness = makeHarness({ hash: "#agents" });
    await started(harness);
    harness.streams.at(-1)?.push(JSON.stringify(SNAPSHOT));
    await settle();
    const after = callsTo(harness, "/api/sessions/s1");
    harness.streams.at(-1)?.push(JSON.stringify(sessionsMessage()));
    await settle();
    expect(callsTo(harness, "/api/sessions/s1")).toBe(after);
  });

  it("refetches a live session's detail once the refresh window has passed", async () => {
    const harness = makeHarness();
    // a live session's detail: its live word matches the list item's, so only the window governs
    harness.answers.set("/api/sessions/s1", ok({ session: makeSessionView() }));
    await started(harness);
    // the agents tab is the view that shows a session's agent rows: only shown details are fetched
    harness.controller.act("tab", "agents");
    await settle();
    const live = { ...item("s1", 20), live: true };
    harness.streams.at(-1)?.push(JSON.stringify(sessionsMessage([live])));
    await settle();
    const after = callsTo(harness, "/api/sessions/s1");
    // a message inside the window serves the held copy: the live word has not had time to move
    harness.streams.at(-1)?.push(JSON.stringify(sessionsMessage([live])));
    await settle();
    expect(callsTo(harness, "/api/sessions/s1")).toBe(after);
    // five seconds on, the held copy is a server pass behind (subagents spawned or retired) and goes again
    await vi.advanceTimersByTimeAsync(5_000);
    harness.streams.at(-1)?.push(JSON.stringify(sessionsMessage([live])));
    await settle();
    expect(callsTo(harness, "/api/sessions/s1")).toBe(after + 1);
  });

  it("refetches when the list's live count moves off the held detail's rows: a subagent spawned", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/sessions/s1", ok({ session: makeSessionView() }));
    await started(harness);
    // the agents tab is the view that shows a session's agent rows: only shown details are fetched
    harness.controller.act("tab", "agents");
    await settle();
    const live = { ...item("s1", 20), live: true };
    harness.streams.at(-1)?.push(JSON.stringify(sessionsMessage([live])));
    await settle();
    const after = callsTo(harness, "/api/sessions/s1");
    // the card now counts one live agent the held detail's rows do not know: the word cannot wait the window
    harness.streams.at(-1)?.push(JSON.stringify(sessionsMessage([{ ...live, liveAgentCount: 1 }])));
    await settle();
    expect(callsTo(harness, "/api/sessions/s1")).toBe(after + 1);
  });

  it("refetches when the list's live word moves off the held detail's, either way", async () => {
    const harness = makeHarness();
    await started(harness);
    // the agents tab is the view that shows a session's agent rows: only shown details are fetched
    harness.controller.act("tab", "agents");
    await settle();
    harness.streams.at(-1)?.push(JSON.stringify(SNAPSHOT));
    await settle(); // ended items, ended details: the words agree
    const after = callsTo(harness, "/api/sessions/s1");
    harness.answers.set("/api/sessions/s1", ok({ session: makeSessionView() })); // the server says open now
    harness.streams.at(-1)?.push(JSON.stringify(sessionsMessage([{ ...item("s1", 20), live: true }])));
    await settle();
    expect(callsTo(harness, "/api/sessions/s1")).toBe(after + 1); // the session opened: the rows follow
    expect(harness.controller.getState().details.s1?.live).toBe(true);
    const since = callsTo(harness, "/api/sessions/s1");
    harness.answers.set("/api/sessions/s1", ok({ session: makeSessionView({ live: false }) })); // and closed
    harness.streams.at(-1)?.push(JSON.stringify(sessionsMessage()));
    await settle();
    expect(callsTo(harness, "/api/sessions/s1")).toBe(since + 1); // and it ended again: refetch, not "Live" forever
    expect(harness.controller.getState().details.s1?.live).toBe(false);
  });

  it("leaves a session tree loading when its fetch fails, and retries on the next message", async () => {
    const harness = makeHarness({ hash: "#agents" });
    harness.answers.set("/api/sessions/s1", fail(500));
    await started(harness);
    harness.streams.at(-1)?.push(JSON.stringify(SNAPSHOT));
    await settle();
    expect(harness.controller.getState().details.s1).toBeUndefined();
    expect(harness.controller.getState().details.s2).toBeDefined();
    harness.answers.set("/api/sessions/s1", ok({ session: makeSessionView() }));
    harness.streams.at(-1)?.push(JSON.stringify(sessionsMessage()));
    await settle();
    expect(harness.controller.getState().details.s1).toBeDefined();
  });

  it("fetches a session once while its detail is in flight", async () => {
    const harness = makeHarness({ hash: "#agents" });
    await started(harness);
    const gate = deferred();
    harness.answers.set("/api/sessions/s1", gate.answer);
    harness.streams.at(-1)?.push(JSON.stringify(sessionsMessage()));
    harness.streams.at(-1)?.push(JSON.stringify(sessionsMessage()));
    gate.resolve({ session: makeSessionView() });
    await settle();
    expect(callsTo(harness, "/api/sessions/s1")).toBe(1);
    expect(harness.controller.getState().details.s1).toBeDefined();
  });

  it("fetches nothing when the picked session is not in the list", async () => {
    const harness = makeHarness();
    await started(harness);
    const before = harness.calls.length;
    harness.controller.act("session", "ghost");
    await settle();
    expect(harness.calls).toHaveLength(before);
  });

  it("folds request, tool and event messages in", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.streams
      .at(-1)
      ?.push(JSON.stringify({ type: "request", request: makeRequest({ id: "r9", ts: 5_000 }) }));
    harness.streams.at(-1)?.push(JSON.stringify({ type: "tool", tool: makeTool({ id: "t9" }) }));
    harness.streams.at(-1)?.push(
      JSON.stringify({
        type: "event",
        event: {
          seq: 2,
          ts: 9_000,
          kind: "Notice",
          sessionId: null,
          agentId: null,
          label: null,
          payload: null,
        },
      }),
    );
    await settle();
    const state = harness.controller.getState();
    expect(state.requests.map((request) => request.id)).toContain("r9");
    expect(state.tools.map((tool) => tool.id)).toContain("t9");
    expect(state.events).toHaveLength(2);
  });

  it("ignores a message that is not JSON", async () => {
    const harness = makeHarness();
    await started(harness);
    const before = harness.controller.getState();
    harness.streams.at(-1)?.push("{oops");
    await settle();
    expect(harness.controller.getState().updatedAt).toBe(before.updatedAt);
    expect(harness.controller.getState().requests).toEqual(before.requests);
  });
});

describe("start and stop", () => {
  it("boots: theme, polled data, backfill, then the stream", async () => {
    const harness = makeHarness({ storage: new Map([["radar-theme", "light"]]) });
    harness.controller.start();
    await settle();
    expect(harness.themes).toEqual(["light"]);
    const state = harness.controller.getState();
    expect(state.requests).toHaveLength(1);
    expect(state.tools).toHaveLength(1);
    expect(state.events).toHaveLength(1);
    expect(state.error).toBeNull();
    expect(harness.streams).toHaveLength(1);
    expect(callsTo(harness, "/api/alerts")).toBe(1);
  });

  it("applies the boot tab's own data too", async () => {
    const harness = makeHarness({ hash: "#costs" });
    harness.controller.start();
    await settle();
    expect(harness.controller.getState().attributionTree).toEqual([ATTRIBUTION_NODE]);
  });

  it("shows the backfill's error and still attaches the stream", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/requests?limit=1000", fail(500));
    harness.controller.start();
    await settle();
    expect(harness.controller.getState().error).toBe("GET /api/requests?limit=1000 → 500");
    expect(harness.streams).toHaveLength(1);
  });

  it("describes a failure that is not an Error", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/events?limit=500", {
      ok: true,
      status: 200,
      json: () => Promise.reject("nope"),
    });
    harness.controller.start();
    await settle();
    expect(harness.controller.getState().error).toBe("nope");
    expect(harness.streams).toHaveLength(1);
  });

  it("re-answers the backfill on refetch()", async () => {
    const harness = makeHarness();
    await started(harness);
    await harness.controller.refetch();
    expect(harness.controller.getState().error).toBeNull();
    expect(callsTo(harness, "/api/requests?limit=1000")).toBe(2);
  });

  it("fetches the three lists once when a refresh lands on an in-flight backfill", async () => {
    const harness = makeHarness();
    const gates = [deferred(), deferred(), deferred()];
    harness.answers.set("/api/requests?limit=1000", gates[0]?.answer ?? fail(500));
    harness.answers.set("/api/events?limit=500", gates[1]?.answer ?? fail(500));
    harness.answers.set("/api/tools?limit=1000", gates[2]?.answer ?? fail(500));
    harness.controller.start();
    harness.controller.act("refresh"); // the boot backfill is still in flight
    gates[0]?.resolve({ requests: [] });
    gates[1]?.resolve({ events: [] });
    gates[2]?.resolve({ tools: [] });
    await settle();
    expect(callsTo(harness, "/api/requests?limit=1000")).toBe(1);
    expect(callsTo(harness, "/api/events?limit=500")).toBe(1);
    expect(callsTo(harness, "/api/tools?limit=1000")).toBe(1);
  });

  it("refetches on the refresh action and shows a failure as the error", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.controller.act("refresh");
    await settle();
    expect(callsTo(harness, "/api/requests?limit=1000")).toBe(2);
    harness.answers.set("/api/tools?limit=1000", fail(503));
    harness.controller.act("refresh");
    await settle();
    expect(harness.controller.getState().error).toBe("GET /api/tools?limit=1000 → 503");
  });

  it("polls insights every 10 s, plus the live tab's own data", async () => {
    const harness = makeHarness();
    await started(harness);
    const alertsAfterBoot = callsTo(harness, "/api/alerts");
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(callsTo(harness, "/api/alerts")).toBe(alertsAfterBoot + 1);

    harness.controller.act("tab", "costs");
    await settle();
    const attributionAfter = callsTo(harness, "/api/attribution?by=tree&range=day");
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(callsTo(harness, "/api/attribution?by=tree&range=day")).toBe(attributionAfter + 1);

    harness.controller.act("tab", "router");
    await settle();
    const routerAfter = callsTo(harness, "/api/router");
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(callsTo(harness, "/api/router")).toBe(routerAfter + 1);
  });

  it("stop() closes the stream, stills the polls and cancels the queued notification", async () => {
    const harness = makeHarness();
    const seen: number[] = [];
    harness.controller.subscribe((state) => seen.push(state.requests.length));
    await started(harness);
    seen.length = 0;
    const stream = harness.streams.at(-1);
    const callsBefore = harness.calls.length;
    harness.streams.at(-1)?.push(JSON.stringify({ type: "request", request: makeRequest({ id: "r1" }) }));
    harness.controller.stop();
    expect(stream?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toEqual([]);
    expect(harness.calls).toHaveLength(callsBefore);
    expect(harness.controller.getState().requests).toHaveLength(2);
  });

  it("stop() on a controller that never started", () => {
    const harness = makeHarness();
    harness.controller.stop();
    expect(harness.streams).toEqual([]);
  });
});

/* ------------------------------ history: hash ------------------------------ */

describe("the URL hash beyond the tab", () => {
  it("reads the rail's panel, search, repo and scope from the hash at construction", () => {
    const harness = makeHarness({
      hash: "#overview?panel=history&q=fix&repo=%2Fw%2Fapp&root=r1&node=n1",
    });
    const state = harness.controller.getState();
    expect(state.sessionsPanel).toBe("history");
    expect(state.historyInput).toBe("fix");
    expect(state.historyQuery).toBe("fix");
    expect(state.historyRepo).toBe("/w/app");
    expect(state.historyScope).toEqual({ rootId: "r1", nodeId: "n1" });
  });

  it("keeps a plain tab hash plain while the rail sits at its defaults", () => {
    const harness = makeHarness({ hash: "#requests" });
    harness.controller.act("panel", "live");
    expect(harness.pushed).toEqual([]);
    expect(
      hashOf("requests", {
        panel: "live",
        q: "",
        repo: null,
        scope: null,
        session: [],
        range: { ...DEFAULT_RANGE },
      }),
    ).toBe("#requests");
  });

  it("carries the picked sessions in the hash: one, several, none", () => {
    const rail = { panel: "live" as const, q: "", repo: null, scope: null, session: [] as string[] };
    expect(hashOf("overview", { ...rail, range: { ...DEFAULT_RANGE } })).toBe("#overview");
    expect(hashOf("overview", { ...rail, session: ["s1"], range: { ...DEFAULT_RANGE } })).toBe(
      "#overview?session=s1",
    );
    expect(hashOf("overview", { ...rail, session: ["s1", "s2"], range: { ...DEFAULT_RANGE } })).toBe(
      "#overview?session=s1,s2",
    );
    expect(hashParse("#overview?session=s1,s2").state.session).toEqual(["s1", "s2"]);
    expect(hashParse("#overview?session=s1").state.session).toEqual(["s1"]);
    expect(hashParse("#overview").state.session).toEqual([]);
    expect(hashParse("#overview?session=").state.session).toEqual([]);
  });

  it("reads a picked set from the starting hash and pushes selection changes back into the URL", () => {
    const harness = makeHarness({ hash: "#requests?session=s1,s2" });
    expect(harness.controller.getState().selected).toEqual(["s1", "s2"]);
    expect(harness.controller.getState().session).toBeNull();
    harness.controller.act("session", "s3");
    expect(harness.replaced.at(-1)).toBe("#requests?session=s1,s2,s3");
    harness.controller.act("clearSelection");
    expect(harness.replaced.at(-1)).toBe("#requests");
  });

  it("restores a picked set from a Back step", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.controller.act("hash", "#overview?session=s2");
    expect(harness.controller.getState().selected).toEqual(["s2"]);
    expect(harness.controller.getState().session).toBe("s2");
    harness.controller.act("hash", "#overview");
    expect(harness.controller.getState().selected).toEqual([]);
  });

  it("pushes the rail's state as a step Back can return to", () => {
    const harness = makeHarness();
    harness.controller.act("panel", "history");
    expect(harness.pushed).toEqual(["#overview?panel=history"]);
    harness.controller.act("history-repo", "/w/app");
    expect(harness.pushed.at(-1)).toBe("#overview?panel=history&repo=%2Fw%2Fapp");
  });

  it("restores the rail from a Back step, fetching what the restored state needs", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/history/roots?scope=history&limit=100&q=fix", ok({ roots: [], next: null }));
    harness.answers.set("/api/history/repos", ok({ repos: [] }));
    harness.answers.set("/api/history/requests?limit=200&node=n1", ok({ requests: [], next: null }));
    harness.controller.act("hash", "#overview?panel=history&q=fix&root=r1&node=n1");
    await settle();
    const state = harness.controller.getState();
    expect(state.sessionsPanel).toBe("history");
    expect(state.historyQuery).toBe("fix");
    expect(state.historyScope).toEqual({ rootId: "r1", nodeId: "n1" });
    expect(callsTo(harness, "/api/history/roots?scope=history&limit=100&q=fix")).toBe(1);
    expect(callsTo(harness, "/api/history/requests?limit=200&node=n1")).toBe(1);
  });
});

/* ---------------------------- history: the rail ---------------------------- */

function rootsAnswer(...ids: string[]): { roots: unknown[]; next: number | null } {
  return {
    roots: ids.map((id, index) => ({
      id,
      kind: "main",
      project: "app",
      repo: "/w/app",
      branch: "main",
      name: id === "r1/main" ? null : `Session ${index}`,
      label: null,
      model: "glm-5.3",
      jobState: null,
      startedAt: 1_000 - index,
      endedAt: 2_000,
      lastAt: 3_000,
      liveNodes: 0,
      nodes: 2,
      requests: 4,
      tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.5,
    })),
    next: ids.length > 1 ? 123 : null,
  };
}

describe("the history rail's data", () => {
  it("fetches the first page and the repo picker when the History tab opens", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/history/roots?scope=history&limit=100", ok(rootsAnswer("r1/main")));
    harness.answers.set("/api/history/repos", ok({ repos: [{ repo: "/w/app", roots: 2 }] }));
    harness.controller.act("panel", "history");
    await settle();
    const state = harness.controller.getState();
    expect(state.historyRoots?.map((root) => root.id)).toEqual(["r1/main"]);
    expect(state.historyRepos).toEqual([{ repo: "/w/app", roots: 2 }]);
    expect(state.historyNext).toBeNull();
  });

  it("does not refetch a page its filters already answer", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/history/roots?scope=history&limit=100", ok(rootsAnswer("r1/main")));
    harness.answers.set("/api/history/repos", ok({ repos: [] }));
    harness.controller.act("panel", "history");
    await settle();
    harness.controller.act("panel", "live");
    harness.controller.act("panel", "history");
    await settle();
    expect(callsTo(harness, "/api/history/roots?scope=history&limit=100")).toBe(1);
  });

  it("debounces the search box: one fetch per pause, not per keystroke", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/history/roots?scope=history&limit=100&q=fi", ok(rootsAnswer("r1/main")));
    harness.answers.set("/api/history/roots?scope=history&limit=100&q=fix+radar", ok(rootsAnswer("r2/main")));
    harness.answers.set("/api/history/repos", ok({ repos: [] }));
    harness.controller.act("panel", "history");
    await settle();
    harness.controller.act("history-input", "fi");
    await vi.advanceTimersByTimeAsync(100);
    harness.controller.act("history-input", "fix ");
    await vi.advanceTimersByTimeAsync(100);
    harness.controller.act("history-input", "fix radar");
    expect(callsTo(harness, "/api/history/roots?scope=history&limit=100&q=fix+radar")).toBe(0);
    await vi.advanceTimersByTimeAsync(249);
    expect(callsTo(harness, "/api/history/roots?scope=history&limit=100&q=fix+radar")).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(callsTo(harness, "/api/history/roots?scope=history&limit=100&q=fix+radar")).toBe(1);
    expect(harness.controller.getState().historyQuery).toBe("fix radar");
    expect(harness.controller.getState().historyRoots?.map((root) => root.id)).toEqual(["r2/main"]);
  });

  it("refetches from the first page when the repo filter changes", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/history/roots?scope=history&limit=100", ok(rootsAnswer("r1/main")));
    harness.answers.set(
      "/api/history/roots?scope=history&limit=100&repo=%2Fw%2Fother",
      ok(rootsAnswer("r2/main", "r3/main")),
    );
    harness.answers.set("/api/history/repos", ok({ repos: [] }));
    harness.controller.act("panel", "history");
    await settle();
    harness.controller.act("history-repo", "/w/other");
    await settle();
    const state = harness.controller.getState();
    expect(state.historyRepo).toBe("/w/other");
    expect(state.historyRoots?.map((root) => root.id)).toEqual(["r2/main", "r3/main"]);
    expect(state.historyNext).toBe(123);
  });

  it("appends the next page when a cursor exists", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/history/roots?scope=history&limit=100", {
      ok: true,
      status: 200,
      json: async () => ({ ...rootsAnswer("r1/main"), next: 55 }),
    });
    harness.answers.set("/api/history/roots?scope=history&limit=100&before=55", ok(rootsAnswer("r9/main")));
    harness.answers.set("/api/history/repos", ok({ repos: [] }));
    harness.controller.act("panel", "history");
    await settle();
    harness.controller.act("more-roots");
    await settle();
    expect(harness.controller.getState().historyRoots?.map((root) => root.id)).toEqual([
      "r1/main",
      "r9/main",
    ]);
  });

  it("says why the rail is empty when history answers 503", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/history/roots?scope=history&limit=100", fail(503));
    harness.answers.set("/api/history/repos", ok({ repos: [] }));
    harness.controller.act("panel", "history");
    await settle();
    const state = harness.controller.getState();
    expect(state.historyRoots).toEqual([]);
    expect(state.historyRootsError).toContain("503");
  });
});

/* --------------------------- history: the trees ---------------------------- */

describe("session trees in both rails", () => {
  it("fetches a history tree the first time its card expands, and only once", async () => {
    const harness = makeHarness();
    harness.controller.act("panel", "history");
    harness.answers.set(
      "/api/history/tree/r1%2Fmain",
      ok({
        nodes: [
          { id: "r1/main", kind: "main", parentId: null, live: true, requests: 2 },
          { id: "r1/a1", kind: "subagent", parentId: "r1/main", live: false, requests: 1 },
        ],
      }),
    );
    harness.controller.act("tree", "r1/main");
    await settle();
    harness.controller.act("tree", "r1/main");
    harness.controller.act("tree", "r1/main");
    await settle();
    expect(callsTo(harness, "/api/history/tree/r1%2Fmain")).toBe(1);
    expect(harness.controller.getState().historyTrees["r1/main"]).toHaveLength(2);
  });

  it("fetches a live session's detail once when its card expands", async () => {
    const harness = makeHarness();
    harness.controller.act("tree", "s1");
    await settle();
    harness.controller.act("tree", "s1");
    await settle();
    expect(callsTo(harness, "/api/sessions/s1")).toBe(1);
    expect(harness.controller.getState().details.s1).toBeDefined();
  });
});

/* ---------------------------- history: the scope --------------------------- */

describe("the history scope", () => {
  it("scopes the right pane to one node and loads its requests", async () => {
    const harness = makeHarness();
    harness.answers.set(
      "/api/history/requests?limit=200&node=r1%2Fa1",
      ok({ requests: [makeRequest({ id: "req1" })], next: null }),
    );
    harness.controller.act("scope", JSON.stringify({ rootId: "r1/main", nodeId: "r1/a1" }));
    await settle();
    const state = harness.controller.getState();
    expect(state.historyScope).toEqual({ rootId: "r1/main", nodeId: "r1/a1" });
    expect(state.historyRequests?.map((request) => request.id)).toEqual(["req1"]);
  });

  it("scopes to a whole session from the card, and one click back clears it", async () => {
    const harness = makeHarness();
    harness.answers.set(
      "/api/history/requests?limit=200&root=r1%2Fmain",
      ok({ requests: [makeRequest({ id: "req2" })], next: null }),
    );
    harness.controller.act("scope", JSON.stringify({ rootId: "r1/main", nodeId: null }));
    await settle();
    expect(harness.controller.getState().historyRequests?.map((r) => r.id)).toEqual(["req2"]);
    expect(harness.pushed.at(-1)).toBe("#overview?root=r1%2Fmain");
    harness.controller.act("scope-clear");
    await settle();
    const state = harness.controller.getState();
    expect(state.historyScope).toBeNull();
    expect(state.historyRequests).toBeNull();
    expect(harness.pushed.at(-1)).toBe("#overview");
  });

  it("appends the scope's next page behind its ts:id cursor", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/history/requests?limit=200&root=r1%2Fmain", {
      ok: true,
      status: 200,
      json: async () => ({ requests: [makeRequest({ id: "req1" })], next: "500:req1" }),
    });
    harness.answers.set(
      `/api/history/requests?limit=200&root=r1%2Fmain&before=${encodeURIComponent("500:req1")}`,
      ok({ requests: [makeRequest({ id: "req0" })], next: null }),
    );
    harness.controller.act("scope", JSON.stringify({ rootId: "r1/main", nodeId: null }));
    await settle();
    harness.controller.act("more-requests");
    await settle();
    expect(harness.controller.getState().historyRequests?.map((r) => r.id)).toEqual(["req1", "req0"]);
  });

  it("drops a stale answer when another scope was picked mid-flight", async () => {
    const harness = makeHarness();
    const gate = deferred();
    harness.answers.set("/api/history/requests?limit=200&root=r1%2Fmain", gate.answer);
    harness.controller.act("scope", JSON.stringify({ rootId: "r1/main", nodeId: null }));
    harness.controller.act("scope", JSON.stringify({ rootId: "r2/main", nodeId: null }));
    gate.resolve({ requests: [makeRequest({ id: "stale" })], next: null });
    await settle();
    expect(harness.controller.getState().historyScope).toEqual({ rootId: "r2/main", nodeId: null });
  });

  it("ignores a scope value that is not a picked node", async () => {
    const harness = makeHarness();
    harness.controller.act("scope", "not json");
    harness.controller.act("scope", JSON.stringify({ nodeId: "n1" }));
    expect(harness.controller.getState().historyScope).toBeNull();
  });
});

/* ------------------------- history: drawer content ------------------------- */

describe("the drawer's stored sides", () => {
  it("fetches a side once per request and caches it across tab switches", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.answers.set(
      "/api/history/content/a",
      ok({ input: [{ type: "text", text: "hello" }], output: null, bytes: 5 }),
    );
    harness.controller.act("drawer", "a");
    harness.controller.act("drawer-tab", "input");
    await settle();
    expect(callsTo(harness, "/api/history/content/a")).toBe(1);
    harness.controller.act("drawer-tab", "output");
    harness.controller.act("drawer-tab", "input");
    await settle();
    expect(callsTo(harness, "/api/history/content/a")).toBe(1);
    expect(harness.controller.getState().content.a).toEqual({
      status: "ready",
      input: [{ type: "text", text: "hello" }],
      output: null,
      bytes: 5,
    });
  });

  it("says why a side is missing, and when history is off", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.answers.set("/api/history/content/b", fail(404));
    harness.answers.set("/api/history/content/c", fail(503));
    harness.controller.act("drawer", "b");
    harness.controller.act("drawer-tab", "input");
    await settle();
    expect(harness.controller.getState().content.b).toEqual({ status: "missing" });
    harness.controller.act("drawer", "c");
    harness.controller.act("drawer-tab", "output");
    await settle();
    expect(harness.controller.getState().content.c).toEqual({ status: "off" });
  });

  it("fetches again for a different request, opening on Overview each time", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.answers.set("/api/history/content/a", ok({ input: null, output: null, bytes: 0 }));
    harness.answers.set("/api/history/content/b", ok({ input: null, output: null, bytes: 0 }));
    harness.controller.act("drawer", "a");
    harness.controller.act("drawer-tab", "input");
    await settle();
    expect(harness.controller.getState().drawerTab).toBe("input");
    harness.controller.act("drawer", "b");
    expect(harness.controller.getState().drawerTab).toBe("overview");
    harness.controller.act("drawer-tab", "input");
    await settle();
    expect(callsTo(harness, "/api/history/content/b")).toBe(1);
    expect(callsTo(harness, "/api/history/content/a")).toBe(1);
  });

  it("ignores a tab it does not know", () => {
    const harness = makeHarness();
    harness.controller.act("drawer-tab", "sideways");
    expect(harness.controller.getState().drawerTab).toBe("overview");
  });
});

/* ---------------------- the inspector's Context tab ----------------------- */

describe("the inspector's rebuilt conversation", () => {
  const CONTEXT = {
    requestId: "a",
    nodeId: "s1/main",
    model: "glm-5.3",
    totals: {
      messages: 2,
      approxTokens: 30,
      usage: { input: 100, output: 10, cacheRead: 60, cacheWrite: 0 },
      cacheTokens: 60,
    },
    messages: [
      {
        role: "user",
        kind: "text",
        requestId: "a",
        ts: 1000,
        bytes: 60,
        preview: "fix the limiter",
        blocks: [{ type: "text", text: "fix the limiter" }],
      },
    ],
    next: null as string | null,
  };

  it("fetches the conversation once when the Context tab opens and caches it", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.answers.set("/api/history/context/a?limit=40", ok({ ...CONTEXT, note: "not in the transcript" }));
    harness.controller.act("drawer", "a");
    harness.controller.act("drawer-tab", "context");
    await settle();
    expect(callsTo(harness, "/api/history/context/a?limit=40")).toBe(1);
    expect(harness.controller.getState().context.a).toEqual({
      status: "ready",
      messages: CONTEXT.messages,
      totals: CONTEXT.totals,
      note: "not in the transcript",
      next: null,
      loadingOlder: false,
    });
    harness.controller.act("drawer-tab", "overview");
    harness.controller.act("drawer-tab", "context");
    await settle();
    expect(callsTo(harness, "/api/history/context/a?limit=40")).toBe(1);
  });

  it("says why the conversation is gone, off or broken", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.answers.set("/api/history/context/b?limit=40", fail(404));
    harness.answers.set("/api/history/context/c?limit=40", fail(503));
    harness.answers.set("/api/history/context/d?limit=40", fail(500));
    harness.controller.act("drawer", "b");
    harness.controller.act("drawer-tab", "context");
    await settle();
    expect(harness.controller.getState().context.b).toEqual({ status: "missing" });
    harness.controller.act("drawer", "c");
    harness.controller.act("drawer-tab", "context");
    await settle();
    expect(harness.controller.getState().context.c).toEqual({ status: "off" });
    harness.controller.act("drawer", "d");
    harness.controller.act("drawer-tab", "context");
    await settle();
    expect(harness.controller.getState().context.d).toEqual({
      status: "error",
      cause: "GET /api/history/context/d?limit=40 → 500",
    });
    // an errored conversation retries on the next open
    harness.answers.set("/api/history/context/d?limit=40", ok(CONTEXT));
    harness.controller.act("drawer-tab", "overview");
    harness.controller.act("drawer-tab", "context");
    await settle();
    expect(harness.controller.getState().context.d?.status).toBe("ready");
  });

  it("prepends the page before this one, and leaves the page offer up when that fails", async () => {
    const harness = makeHarness();
    await started(harness);
    const page = {
      ...CONTEXT,
      next: "900:m0:0",
      messages: [
        { role: "user", kind: "text", requestId: "a", ts: 1000, bytes: 10, preview: "newest", blocks: [] },
      ],
    };
    harness.answers.set("/api/history/context/a?limit=40", ok(page));
    harness.controller.act("drawer", "a");
    harness.controller.act("drawer-tab", "context");
    await settle();
    harness.answers.set(
      "/api/history/context/a?limit=40&cursor=900%3Am0%3A0",
      ok({
        ...CONTEXT,
        messages: [
          { role: "user", kind: "text", requestId: "m0", ts: 900, bytes: 8, preview: "earlier", blocks: [] },
        ],
        next: null,
      }),
    );
    harness.controller.act("context-more");
    await settle();
    const held = harness.controller.getState().context.a;
    if (held?.status !== "ready") throw new Error("the conversation should have loaded");
    expect(held.messages.map((m) => m.preview)).toEqual(["earlier", "newest"]);
    expect(held.next).toBe(null);
    expect(held.loadingOlder).toBe(false);

    // a failing older page keeps what is shown and stops saying loading
    harness.answers.set("/api/history/context/b?limit=40", ok({ ...page, next: "1:x:0" }));
    harness.controller.act("drawer", "b");
    harness.controller.act("drawer-tab", "context");
    await settle();
    harness.controller.act("context-more");
    await settle();
    const failed = harness.controller.getState().context.b;
    if (failed?.status !== "ready") throw new Error("the conversation should have loaded");
    expect(failed.loadingOlder).toBe(false);
    expect(failed.next).toBe("1:x:0");
    // a second click while the page is still in flight does nothing: the failed page offered again is
    // fetched once more, not three times
    harness.controller.act("context-more");
    harness.controller.act("context-more");
    await settle();
    expect(
      harness.calls.filter((call) => call.path === "/api/history/context/b?limit=40&cursor=1%3Ax%3A0").length,
    ).toBe(2);
  });

  it("fetches the sides a Raw tab shows, and steps to neighbouring requests with the tab kept", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.answers.set("/api/history/content/a", ok({ input: null, output: null, bytes: 0 }));
    harness.controller.act("drawer", "a");
    harness.controller.act("drawer-tab", "raw");
    await settle();
    expect(callsTo(harness, "/api/history/content/a")).toBe(1);

    // three requests in the view, newest first: next walks to the older one, the tab stays on raw
    const newer = makeRequest({ id: "a", ts: 2000 });
    const older = makeRequest({ id: "old", ts: 1500 });
    harness.streams[0]?.push(JSON.stringify({ type: "request", request: newer }));
    harness.streams[0]?.push(JSON.stringify({ type: "request", request: older }));
    await settle();
    expect(harness.controller.getState().request).toBe("a");
    harness.controller.act("next-request");
    expect(harness.controller.getState().request).toBe("old");
    expect(harness.controller.getState().drawerTab).toBe("raw");
    harness.controller.act("prev-request");
    expect(harness.controller.getState().request).toBe("a");
    // the newest end does nothing
    harness.controller.act("prev-request");
    expect(harness.controller.getState().request).toBe("a");
  });

  it("scopes to the agent the overview names: the session in the live view, the node in a history scope", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.controller.act("scope-agent", JSON.stringify({ sessionId: "s1", agentId: "main" }));
    expect(harness.controller.getState().session).toBe("s1");
    // unknown shapes and empty ids do nothing
    harness.controller.act("scope-agent", "{oops");
    harness.controller.act("scope-agent", JSON.stringify({ sessionId: "", agentId: "main" }));
    harness.controller.act("scope-agent", JSON.stringify({ sessionId: "s1", agentId: "" }));
    expect(harness.controller.getState().session).toBe("s1");

    const node = {
      id: "s1/a1",
      kind: "subagent" as const,
      parentId: "s1/main",
      sessionId: "s1",
      agentId: "a1",
      label: null,
      agentType: "fork",
      description: "dig",
      project: null,
      cwd: null,
      model: "glm-5.3-flash",
      provider: "zai",
      toolUseId: null,
      spawnDepth: 1,
      jobState: null,
      repo: "/w/main",
      branch: "main",
      name: null,
      parentSessionId: null,
      startedAt: null,
      endedAt: null,
      lastAt: 1,
      live: false,
      requests: 1,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    harness.controller.act("panel", "history");
    harness.answers.set("/api/history/tree/s1%2Fmain", ok({ nodes: [node] }));
    harness.controller.act("tree", "s1/main");
    await settle();
    harness.controller.act("scope", JSON.stringify({ rootId: "s1/main", nodeId: null }));
    harness.controller.act("scope-agent", JSON.stringify({ sessionId: "s1", agentId: "a1" }));
    expect(harness.controller.getState().historyScope).toEqual({ rootId: "s1/main", nodeId: "s1/a1" });
    harness.controller.act("scope-agent", JSON.stringify({ sessionId: "s1", agentId: "main" }));
    expect(harness.controller.getState().historyScope).toEqual({ rootId: "s1/main", nodeId: null });
  });
});

/* ------------------------ history: the settings card ----------------------- */

describe("the history card in settings", () => {
  it("reads the store's size and retention with the settings tab", async () => {
    const harness = makeHarness();
    harness.answers.set(
      "/api/history/stats",
      ok({ bytes: 1024, nodes: 3, requests: 9, roots: 2, retentionDays: 30 }),
    );
    await harness.controller.loadTab("settings");
    await settle();
    expect(harness.controller.getState().historyStats).toEqual({
      bytes: 1024,
      nodes: 3,
      requests: 9,
      roots: 2,
      retentionDays: 30,
    });
    expect(harness.controller.getState().historyOff).toBe(false);
  });

  it("loads the ended-session count at boot, so the History badge is right from the start", async () => {
    const harness = makeHarness();
    harness.answers.set(
      "/api/history/stats",
      ok({ bytes: 1024, nodes: 3, requests: 9, roots: 7, retentionDays: 30 }),
    );
    await started(harness);
    expect(callsTo(harness, "/api/history/stats")).toBeGreaterThanOrEqual(1); // fetched on start
    expect(harness.controller.getState().historyStats?.roots).toBe(7); // whatever panel the reader is on
  });

  it("notes when history is off instead of failing the settings tab", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/history/stats", fail(503));
    await harness.controller.loadTab("settings");
    await settle();
    expect(harness.controller.getState().historyOff).toBe(true);
    expect(harness.controller.getState().historyStats).toBeNull();
    expect(harness.controller.getState().budgets).toEqual([
      { id: "b1", scope: "provider:zai", period: "month", limitUsd: 10, action: "warn" },
    ]);
  });

  it("saves a retention choice into the settings and the stats at once", async () => {
    const harness = makeHarness();
    await started(harness);
    // the fetch fake answers PUTs from the same map: the save answers the choice it saved
    harness.answers.set("/api/settings", ok({ settings: { notifications: true, historyRetentionDays: 7 } }));
    await harness.controller.loadTab("settings");
    await settle();
    harness.controller.act("retention", "7");
    await settle();
    expect(putCount(harness, "/api/settings")).toBe(1);
    expect(putBody(harness, "/api/settings")).toEqual({ historyRetentionDays: 7 });
    expect(harness.controller.getState().settings).toEqual({
      notifications: true,
      historyRetentionDays: 7,
    });
    expect(harness.controller.getState().formMessage).toEqual({ tone: "ok", text: "Retention saved." });
  });

  it("ignores a retention value it does not offer", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.controller.act("retention", "14");
    await settle();
    expect(putCount(harness, "/api/settings")).toBe(0);
  });

  it("arms clear history first, cancels on request, and wipes on the second click", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/history/clear", ok({ cleared: true }));
    harness.answers.set("/api/history/stats", ok({ bytes: 0, nodes: 0, requests: 0, retentionDays: 30 }));
    await started(harness);
    harness.controller.act("clear-history");
    expect(harness.controller.getState().clearConfirm).toBe(true);
    expect(putCount(harness, "/api/history/clear")).toBe(0);
    harness.controller.act("clear-history", "cancel");
    expect(harness.controller.getState().clearConfirm).toBe(false);
    harness.controller.act("clear-history");
    harness.controller.act("clear-history");
    await settle();
    const clear = harness.calls.find((call) => call.path === "/api/history/clear");
    expect(clear?.init?.method).toBe("POST");
    expect(harness.controller.getState().formMessage).toEqual({ tone: "ok", text: "History cleared." });
  });

  it("says so when the wipe fails", async () => {
    const harness = makeHarness();
    harness.answers.set("/api/history/clear", fail(500));
    await started(harness);
    harness.controller.act("clear-history");
    harness.controller.act("clear-history");
    await settle();
    expect(harness.controller.getState().formMessage?.tone).toBe("err");
  });
});

describe("the models tab's scoped fetch", () => {
  it("fetches the tables for the picked sessions and range, keyed by that scope", async () => {
    const harness = makeHarness();
    const now = Date.now();
    const path = `/api/models?from=${now - 3_600_000}&to=${now}`;
    const picked = `${path}&session=s1`;
    harness.answers.set(path, ok({ models: [], upstreams: [], tools: [] }));
    harness.answers.set(picked, ok({ models: [], upstreams: [], tools: [] }));
    await started(harness);
    harness.controller.act("tab", "models");
    await settle();
    expect(callsTo(harness, path)).toBe(1);
    expect(harness.controller.getState().modelsScoped?.key).toBe("range=1h|");
    expect(harness.controller.getState().modelsScoped?.data).toEqual({
      models: [],
      upstreams: [],
      tools: [],
    });
    // picking a session narrows the query and the key, and fetches that scope
    harness.controller.act("session", "s1");
    await settle();
    expect(callsTo(harness, picked)).toBe(1);
    expect(harness.controller.getState().modelsScoped?.key).toBe("range=1h|s1");
  });

  it("drops an answer whose scope moved while it was in flight, and names a failure", async () => {
    const harness = makeHarness();
    const now = Date.now();
    const path = `/api/models?from=${now - 3_600_000}&to=${now}`;
    const gate = deferred();
    harness.answers.set(path, gate.answer);
    await started(harness);
    harness.controller.act("tab", "models");
    harness.controller.act("session", "s1"); // in flight, so the answer will be dropped
    await settle();
    gate.resolve({ models: [], upstreams: [], tools: [] });
    await settle();
    expect(harness.controller.getState().modelsScoped).toBeNull();
    const bad = makeHarness();
    bad.answers.set(path, fail(503, {}));
    bad.controller.act("tab", "models");
    await settle();
    expect(bad.controller.getState().modelsError).toBe(`GET ${path} → 503`);
  });

  it("polls the server's own uptime with the insights", async () => {
    const harness = makeHarness();
    await started(harness);
    expect(harness.controller.getState().health).toEqual({ startedAt: 5, uptimeMs: 100 });
  });
});

/* --------------------------- the agent transcript --------------------------- */

describe("the agent transcript", () => {
  const READY = {
    requestId: "req-1",
    nodeId: "s1/main",
    model: "claude-sonnet-5-5",
    totals: { messages: 2, approxTokens: 40, usage: null, cacheTokens: 0 },
    messages: [
      {
        role: "user",
        kind: "text",
        requestId: "req-1",
        ts: 1_000,
        bytes: 24,
        preview: "fix the limiter",
        blocks: [{ type: "text", text: "fix the limiter" }],
      },
    ],
    next: null as string | null,
    note: "System prompt and tool definitions are not in the transcript." as string | null,
  };
  const PATH = "/api/history/agent/s1%2Fmain/transcript?limit=60";

  function holdAt(over: Partial<typeof READY> = {}): Answer {
    return ok({ ...READY, ...over });
  }

  async function open(harness: Harness): Promise<void> {
    harness.answers.set(PATH, holdAt());
    harness.controller.act("agent-transcript", "s1/main");
    await settle();
  }

  it("opens on a node, fetches its newest page and remembers itself in the hash", async () => {
    const harness = makeHarness();
    await started(harness);
    await open(harness);
    const state = harness.controller.getState();
    expect(state.agentNode).toBe("s1/main");
    expect(state.agentTranscript).toMatchObject({
      status: "ready",
      requestId: "req-1",
      messages: READY.messages,
      next: null,
      loadingOlder: false,
    });
    expect(harness.pushed).toContain("#overview?agent=s1%2Fmain");
    // reopening the same agent keeps the held page instead of refetching
    harness.controller.act("agent-transcript", "s1/main");
    await settle();
    expect(callsTo(harness, PATH)).toBe(1);
  });

  it("closes through the action and through a Back that lands before it", async () => {
    const harness = makeHarness();
    await started(harness);
    await open(harness);
    harness.controller.act("close-agent-transcript");
    expect(harness.controller.getState().agentNode).toBeNull();
    expect(harness.controller.getState().agentTranscript).toBeNull();
    expect(harness.pushed.at(-1)).toBe("#overview");
    // a hash that no longer names the agent closes it the same way
    await open(harness);
    expect(harness.controller.getState().agentNode).toBe("s1/main");
    harness.controller.act("hash", "#overview");
    expect(harness.controller.getState().agentNode).toBeNull();
    expect(harness.controller.getState().agentTranscript).toBeNull();
  });

  it("restores from the starting hash on reload: the node set, its page fetched", async () => {
    const harness = makeHarness({ hash: "#agents?agent=s1%2Fmain" });
    expect(harness.controller.getState().agentNode).toBe("s1/main");
    harness.answers.set(PATH, holdAt());
    await started(harness);
    expect(callsTo(harness, PATH)).toBe(1);
    expect(harness.controller.getState().agentTranscript).toMatchObject({ status: "ready" });
    // the boot hash already named the agent, so opening it pushed nothing
    expect(harness.pushed).toEqual([]);
  });

  it("prepends the page before this one through the held cursor", async () => {
    const harness = makeHarness();
    await started(harness);
    const older = {
      requestId: "req-0",
      nodeId: "s1/main",
      model: "claude-sonnet-5-5",
      totals: READY.totals,
      messages: [
        {
          role: "user",
          kind: "text",
          requestId: "req-0",
          ts: 500,
          bytes: 10,
          preview: "earlier",
          blocks: [{ type: "text", text: "earlier" }],
        },
      ],
      next: null,
    };
    harness.answers.set(PATH, holdAt({ next: "900:req-0:0", note: null }));
    harness.controller.act("agent-transcript", "s1/main");
    await settle();
    harness.answers.set(`${PATH}&cursor=900%3Areq-0%3A0`, ok(older));
    harness.controller.act("agent-transcript-more");
    await settle();
    const held = harness.controller.getState().agentTranscript;
    expect(held?.status).toBe("ready");
    if (held?.status === "ready") {
      expect(held.messages.map((message) => message.requestId)).toEqual(["req-0", "req-1"]);
      expect(held.next).toBeNull();
      expect(held.loadingOlder).toBe(false);
    }
    expect(callsTo(harness, `${PATH}&cursor=900%3Areq-0%3A0`)).toBe(1);
  });

  it("refreshes when the stream brings the open agent's new request, and only then", async () => {
    const harness = makeHarness();
    await started(harness);
    await open(harness);
    expect(callsTo(harness, PATH)).toBe(1);
    // a request of another agent of the same session never fetches
    harness.streams[0]?.push(
      JSON.stringify({
        type: "request",
        request: makeRequest({ id: "other-1", agentId: "researcher", stopReason: "end_turn" }),
      }),
    );
    await settle();
    expect(callsTo(harness, PATH)).toBe(1);
    // the agent's own new request does
    harness.answers.set(PATH, holdAt({ requestId: "req-2" }));
    harness.streams[0]?.push(
      JSON.stringify({ type: "request", request: makeRequest({ id: "req-2", ts: 2_000 }) }),
    );
    await settle();
    expect(callsTo(harness, PATH)).toBe(2);
    expect(harness.controller.getState().agentTranscript).toMatchObject({
      status: "ready",
      requestId: "req-2",
    });
    // the same request re-pushed in flight (no stop reason, no output yet) changes nothing
    harness.streams[0]?.push(
      JSON.stringify({
        type: "request",
        request: makeRequest({
          id: "req-2",
          ts: 2_000,
          tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
      }),
    );
    await settle();
    expect(callsTo(harness, PATH)).toBe(2);
    // its completed copy (the server re-pushes merged records) picks up the stored sides
    harness.streams[0]?.push(
      JSON.stringify({
        type: "request",
        request: makeRequest({ id: "req-2", ts: 2_000, stopReason: "end_turn" }),
      }),
    );
    await settle();
    expect(callsTo(harness, PATH)).toBe(3);
  });

  it("switches to another agent through the hash and shows its page, never the old one's", async () => {
    const harness = makeHarness();
    await started(harness);
    await open(harness);
    const OTHER = "/api/history/agent/s1%2Fa1/transcript?limit=60";
    harness.answers.set(
      OTHER,
      holdAt({
        requestId: "sub-1",
        nodeId: "s1/a1",
        messages: [
          { ...READY.messages[0], requestId: "sub-1", preview: "dig here" },
        ] as typeof READY.messages,
      }),
    );
    harness.controller.act("hash", "#agents?agent=s1%2Fa1");
    await settle();
    expect(callsTo(harness, OTHER)).toBe(1);
    const held = harness.controller.getState().agentTranscript;
    expect(held).toMatchObject({ status: "ready", requestId: "sub-1" });
    if (held?.status === "ready") expect(held.messages.map((m) => m.preview)).toEqual(["dig here"]);
  });

  it("refreshes live without the skeleton, keeping the earlier pages the reader loaded", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.answers.set(PATH, holdAt({ next: "900:req-0:0" }));
    harness.controller.act("agent-transcript", "s1/main");
    await settle();
    harness.answers.set(
      `${PATH}&cursor=900%3Areq-0%3A0`,
      ok({
        ...READY,
        requestId: "req-0",
        next: null,
        messages: [{ ...READY.messages[0], requestId: "req-0", ts: 500 }],
      }),
    );
    harness.controller.act("agent-transcript-more");
    await settle();
    // the fresh newest page starts at req-1 again and adds req-2; req-0 was only on the older page
    harness.answers.set(
      PATH,
      holdAt({
        requestId: "req-2",
        next: "1000:req-1:0",
        messages: [
          READY.messages[0],
          { ...READY.messages[0], requestId: "req-2", ts: 2_000 },
        ] as typeof READY.messages,
      }),
    );
    harness.streams[0]?.push(
      JSON.stringify({
        type: "request",
        request: makeRequest({ id: "req-2", ts: 2_000, stopReason: "end_turn" }),
      }),
    );
    expect(harness.controller.getState().agentTranscript?.status).toBe("ready"); // no skeleton while it reads
    await settle();
    const held = harness.controller.getState().agentTranscript;
    expect(held?.status).toBe("ready");
    if (held?.status === "ready") {
      expect(held.messages.map((m) => m.requestId)).toEqual(["req-0", "req-1", "req-2"]);
      expect(held.next).toBeNull(); // the loaded older page already reached the start
    }
  });

  it("coalesces pushes that land while a refresh reads into one more read", async () => {
    const harness = makeHarness();
    await started(harness);
    await open(harness);
    for (const id of ["req-2", "req-3", "req-4"])
      harness.streams[0]?.push(
        JSON.stringify({ type: "request", request: makeRequest({ id, ts: 2_000, stopReason: "end_turn" }) }),
      );
    await settle();
    await settle();
    // the open read, the first push's read, and one more for the two that landed while it ran
    expect(callsTo(harness, PATH)).toBe(3);
  });

  it("names the failure on a broken read and retries it from the error state", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.answers.set(PATH, fail(500, {}));
    harness.controller.act("agent-transcript", "s1/main");
    await settle();
    expect(harness.controller.getState().agentTranscript).toMatchObject({
      status: "error",
      cause: `GET ${PATH} → 500`,
    });
    harness.answers.set(PATH, holdAt());
    harness.controller.act("agent-transcript", "s1/main"); // the Retry button's action
    await settle();
    expect(harness.controller.getState().agentTranscript).toMatchObject({ status: "ready" });
    expect(callsTo(harness, PATH)).toBe(2);
  });

  it("says the agent is unknown when the route 404s, and history off on a 503", async () => {
    const harness = makeHarness();
    await started(harness);
    harness.answers.set(PATH, fail(404, {}));
    harness.controller.act("agent-transcript", "s1/main");
    await settle();
    expect(harness.controller.getState().agentTranscript).toEqual({ status: "missing" });
    const other = "/api/history/agent/s2%2Fmain/transcript?limit=60";
    harness.answers.set(other, fail(503, {}));
    harness.controller.act("agent-transcript", "s2/main");
    await settle();
    expect(harness.controller.getState().agentTranscript).toEqual({ status: "off" });
  });

  it("closes and narrows to the agent through Show its requests, picking the session first", async () => {
    const harness = makeHarness();
    await started(harness);
    await open(harness);
    harness.controller.act("agent-requests", JSON.stringify({ sessionId: "s1", agentId: "main" }));
    const state = harness.controller.getState();
    expect(state.agentNode).toBeNull();
    expect(state.agentTranscript).toBeNull();
    expect(state.session).toBe("s1");
    expect(state.agent).toBe("main");
  });
});
