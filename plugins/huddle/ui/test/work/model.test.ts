import { describe, expect, it } from "vitest";
import type { Api } from "../../src/api.ts";
import { readPref, type Storage } from "../../src/storage.ts";
import type { Board, PlanStep, SessionList } from "../../src/store.ts";
import {
  asTask,
  changedSteps,
  critical,
  FILTERS,
  type Filters,
  fprint,
  hasSteps,
  here,
  importPlanArgs,
  importToastText,
  inScope,
  legend,
  nextStepId,
  noFilters,
  owners,
  phases,
  prefKey,
  readFilters,
  type Step,
  scope,
  sessHref,
  setTaskStatusArgs,
  statusMatch,
  statusToast,
  statusUndoNote,
  stepState,
  taskHref,
  visible,
  writeFilters,
} from "../../src/work/model.ts";

/** Site storage over a map, the way the tests seed and read it. */
const store = (): Storage & { dump(): string } => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    dump: () => [...m.entries()].map(([k, v]) => `${k}=${v}`).join(","),
  };
};

const api = (): Api => ({
  api: async () => ({}),
  op: async () => ({}),
  channelPath: (ch, p) => `/api/c/${ch}${p}`,
  channelHref: (ch, p) => `#/c/${ch}${p}`,
});

/** One step with the fields the tests name. */
const s = (id: string, over: Partial<PlanStep> = {}): Step => ({
  id,
  title: `Task ${id}`,
  status: "todo",
  ...over,
});

const board = (steps: Step[], phaseList: Board["phases"] = [{ n: 1, title: "One" }]): Board =>
  ({ phases: phaseList, steps }) as Board;

const NO: Filters = noFilters();
const sc = (b: Board | null, over: Partial<Filters> = {}) => scope({ ...NO, ...over }, b);

describe("FILTERS", () => {
  it("spells the six segments in strip order", () => {
    expect(FILTERS.map(([k, l]) => [k, l])).toEqual([
      ["all", "All"],
      ["mine", "Mine"],
      ["ready", "Ready"],
      ["waiting", "Waiting"],
      ["blocked", "Blocked"],
      ["notes", "Has notes"],
    ]);
  });
});

describe("filter state", () => {
  it("scopes keys per channel and reads the defaults", () => {
    expect(prefKey("ch", "wfilter")).toBe("wfilter:ch");
    expect(readFilters(store(), "ch")).toEqual({ f: "all", owner: "", phase: "all", q: "" });
  });

  it("writes and reads back every part", () => {
    const st = store();
    const f: Filters = { f: "ready", owner: "owner", phase: "2", q: "alpha" };
    writeFilters(st, "ch", f);
    expect(readFilters(st, "ch")).toEqual(f);
    expect(readPref(st, prefKey("ch", "wfilter"), "all")).toBe("ready");
  });

  it("clears back to the defaults", () => {
    const st = store();
    writeFilters(st, "ch", { f: "blocked", owner: "owl", phase: "3", q: "q" });
    writeFilters(st, "ch", noFilters());
    expect(readFilters(st, "ch")).toEqual({ f: "all", owner: "", phase: "all", q: "" });
  });

  it("keeps the filters apart per channel", () => {
    const st = store();
    writeFilters(st, "a", { ...NO, f: "mine" });
    expect(readFilters(st, "b").f).toBe("all");
  });
});

describe("phases", () => {
  it("is empty without a board", () => {
    expect(phases(null)).toEqual([]);
  });

  it("takes the declared phases in number order", () => {
    const b = board(
      [s("t1")],
      [
        { n: 2, title: "Two" },
        { n: 1, title: "One" },
      ],
    );
    expect(phases(b).map((p) => [p.n, p.title])).toEqual([
      [1, "One"],
      [2, "Two"],
    ]);
  });

  it("implies a phase from the steps, carrying the declared body when there is one", () => {
    const b = board([s("t1", { phase_n: 3 })], [{ n: 1, title: "One" }]) as Board & {
      phases: { summary?: string }[];
    };
    b.phases = [{ n: 1, title: "One", summary: "## why" }];
    const ps = phases(b);
    expect(ps.map((p) => [p.n, p.title, p.implied, p.summary])).toEqual([
      [1, "One", undefined, "## why"],
      [3, "Phase 3", true, undefined],
    ]);
  });
});

describe("matching", () => {
  const b = board([
    s("t1", { owner: "owner", status: "doing" }),
    s("t2", { owner: "owl", status: "blocked", blocked_by: ["t1"] }),
    s("t3", { owner: null, status: "done", comments: { n: 2, open: 1, kinds: [] } }),
    s("t4", { status: "skipped", phase_n: 2 }),
  ]);

  it("reads a step as its status model", () => {
    expect(stepState(null)).toBe("todo");
    expect(stepState(s("t", { status: "doing" }))).toBe("doing");
    expect(stepState(s("t", { status: "todo", blocked_by: ["x"] }))).toBe("waiting");
    expect(asTask(s("t")).status).toBe("todo");
  });

  it("passes everything under the default scope", () => {
    expect(visible(b.steps, "all", sc(b))).toHaveLength(4);
  });

  it("keeps only the owner's tasks under mine", () => {
    expect(visible(b.steps, "mine", sc(b)).map((x) => x.id)).toEqual(["t1"]);
  });

  it("keeps open unblocked tasks under ready", () => {
    expect(visible(b.steps, "ready", sc(b)).map((x) => x.id)).toEqual(["t1"]);
    expect(statusMatch(s("t9", { status: "todo", blocked_by: ["t1"] }), "ready")).toBe(false);
    expect(statusMatch(s("t9", { status: "done" }), "ready")).toBe(false);
  });

  it("keeps the waiting and the blocked apart", () => {
    expect(visible(b.steps, "blocked", sc(b)).map((x) => x.id)).toEqual(["t2"]);
    const waiting = board([s("w1", { status: "todo", blocked_by: ["t1"] })]);
    expect(visible(waiting.steps, "waiting", sc(waiting)).map((x) => x.id)).toEqual(["w1"]);
  });

  it("keeps the tasks with open notes under notes", () => {
    expect(visible(b.steps, "notes", sc(b)).map((x) => x.id)).toEqual(["t3"]);
    expect(statusMatch(s("t9"), "notes")).toBe(false);
  });

  it("filters by owner, including nobody", () => {
    expect(visible(b.steps, "all", sc(b, { owner: "owl" })).map((x) => x.id)).toEqual(["t2"]);
    expect(visible(b.steps, "all", sc(b, { owner: "-" })).map((x) => x.id)).toEqual(["t3", "t4"]);
    expect(inScope(s("t9", { owner: "owl" }), sc(b, { owner: "owl" }))).toBe(true);
  });

  it("filters by phase only while the plan has more than one", () => {
    expect(visible(b.steps, "all", sc(b, { phase: "2" })).map((x) => x.id)).toEqual(["t4"]);
    const one = board(
      [s("t1", { phase_n: 1 }), s("t2", { phase_n: 1, owner: "owl" })],
      [{ n: 1, title: "One" }],
    );
    expect(visible(one.steps, "all", sc(one, { phase: "2" }))).toHaveLength(2);
    expect(inScope(s("t9"), sc(b, { phase: "2" }))).toBe(false);
  });

  it("filters by a fuzzy query over id, title and owner", () => {
    const q = sc(b, { q: "t2" });
    expect(visible(b.steps, "all", q).map((x) => x.id)).toEqual(["t2"]);
    expect(inScope(s("x1", { title: "Nothing here" }), q)).toBe(false);
    expect(inScope(s("x1", { owner: "owl", title: "Nothing" }), sc(b, { q: "owl" }))).toBe(true);
  });

  it("lists the owners on the board, sorted, without the blanks", () => {
    expect(owners(b.steps)).toEqual(["owl", "owner"]);
  });
});

describe("critical", () => {
  it("is empty without unfinished work or a chain of two", () => {
    expect(critical([])).toEqual([]);
    expect(critical([s("a", { status: "done" })])).toEqual([]);
    expect(critical([s("a"), s("b", { depends: ["a"] })])).toEqual(["a", "b"]);
  });

  it("follows the longest chain through the dependencies, oldest first", () => {
    const steps = [
      s("root", { status: "done" }),
      s("a", { depends: ["root", "side"] }),
      s("side"),
      s("b", { depends: ["a", "side"] }),
      s("c", { depends: ["b"] }),
      s("late", { depends: ["a"] }),
    ];
    expect(critical(steps)).toEqual(["side", "a", "b", "c"]);
  });

  it("survives a dependency cycle without running away", () => {
    expect(critical([s("a", { depends: ["b"] }), s("b", { depends: ["a"] })])).toEqual(["b", "a"]);
  });

  it("drops dependencies the board does not have", () => {
    expect(critical([s("a", { depends: ["ghost"] }), s("b", { depends: ["a"] })])).toEqual(["a", "b"]);
  });
});

describe("here", () => {
  it("maps the steps the sessions still in are working", () => {
    const sess = {
      sessions: [
        { name: "alpha", step: "t1", state: "working" },
        { name: "beta", step: "t1", state: "working" },
        { name: "gone", step: "t2", state: "left" },
        { name: "idle", step: null, state: "idle" },
      ],
    } as unknown as SessionList;
    expect(here(sess).get("t1")).toEqual(["alpha", "beta"]);
    expect(here(sess).has("t2")).toBe(false);
    expect(here(null).size).toBe(0);
  });
});

describe("the repaint flash", () => {
  it("primes on the first paint and flashes the changed rows after", () => {
    const first = changedSteps([s("a"), s("b")], null);
    expect(first.hot.size).toBe(0);
    expect(fprint(s("a"))).toBe("todo||Task a|0|0|0");
    const second = changedSteps([s("a"), s("b", { status: "doing" }), s("c")], first.seen);
    expect(second.hot).toEqual(new Set(["b", "c"]));
    const third = changedSteps([s("a")], second.seen);
    expect(third.hot).toEqual(new Set());
    expect(changedSteps([s("a", { owner: "owl" })], third.seen).hot).toEqual(new Set(["a"]));
  });
});

describe("the little words", () => {
  it("legends a step set, zeros out", () => {
    const steps = [
      s("a", { status: "done" }),
      s("b", { status: "skipped" }),
      s("c", { status: "doing" }),
      s("d", { status: "doing" }),
      s("e", { status: "todo", blocked_by: ["c"] }),
      s("f", { status: "blocked" }),
    ];
    expect(legend(steps)).toBe("2 of 6 done, 2 doing, 1 waiting, 1 blocked");
    expect(legend([s("a", { status: "todo" })])).toBe("0 of 1 done");
  });

  it("tells whether the plan has tasks", () => {
    expect(hasSteps(board([]))).toBe(false);
    expect(hasSteps(board([s("a")]))).toBe(true);
    expect(hasSteps(null)).toBe(false);
  });

  it("spells the drawer links the API's way", () => {
    expect(taskHref(api(), "ch", "t 1")).toBe("#/c/ch/work?t=t%201");
    expect(sessHref(api(), "ch", "alpha")).toBe("#/c/ch/team?s=alpha");
  });

  it("builds the import args and the import toast", () => {
    expect(importPlanArgs({ plan: { steps: [] } })).toEqual({ plan: { steps: [] } });
    expect(importPlanArgs({ steps: [] })).toEqual({ plan: { steps: [] } });
    expect(importToastText({ tasks: 3, phases: 2 })).toBe("Imported 3 tasks in 2 phases.");
    expect(importToastText({ tasks: 3, phases: 2, errors: ["bad phase", "no gate", "extra"] })).toBe(
      "Imported 3 tasks in 2 phases, with 3 problems: bad phase; no gate.",
    );
    expect(importToastText(null)).toBe("Imported 0 tasks in 0 phases.");
  });

  it("builds the pieces of a status change", () => {
    expect(setTaskStatusArgs("t1", "done")).toEqual({ id: "t1", status: "done", note: "" });
    expect(setTaskStatusArgs("t1", "doing", "note")).toEqual({ id: "t1", status: "doing", note: "note" });
    expect(statusToast("t1", "done")).toBe("t1 is done");
    expect(statusUndoNote("todo")).toBe("undo: back to todo");
  });

  it("picks a session's next task", () => {
    const b = board([
      s("t1", { owner: "alpha", status: "doing" }),
      s("t2", { owner: "alpha", status: "todo" }),
      s("t3", { owner: "alpha", status: "done" }),
    ]);
    expect(nextStepId("alpha", "t1", [], b)).toBe("t2");
    expect(nextStepId("alpha", "t2", [{ session: "alpha", task: { id: "t9" } }], b)).toBe("t9");
    expect(nextStepId("beta", null, [], b)).toBe(null);
    expect(nextStepId("alpha", "t2", [{ session: "alpha", task: null }], b)).toBe(null);
    const done = board([
      s("t1", { owner: "alpha", status: "doing" }),
      s("t3", { owner: "alpha", status: "done" }),
    ]);
    expect(nextStepId("alpha", "t1", [], done)).toBe(null);
  });
});
