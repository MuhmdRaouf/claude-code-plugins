import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api.ts";
import type { Board, PlanStep, RosterSession, SessionList } from "../../src/store.ts";
import { MapView } from "../../src/work/Map.tsx";
import type { NextTask, Step } from "../../src/work/model.ts";

/** The value the test needs, or a loud failure — the tests carry no non-null assertions. */
function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("the test could not find what it needs");
  return x;
}

const api: Api = {
  api: async () => [],
  op: async () => ({}),
  channelPath: (ch, p) => `/api/c/${ch}${p}`,
  channelHref: (ch, p) => `#/c/${ch}${p}`,
};

/** One step with the fields the tests name. */
const s = (id: string, over: Partial<PlanStep> = {}): Step => ({
  id,
  title: `Task ${id}`,
  status: "todo",
  ...over,
});

const board = (steps: Step[], phases: Board["phases"] = [{ n: 1, title: "One" }]): Board =>
  ({ phases, steps }) as Board;

/** One roster session with the fields the tests name. */
const sess = (name: string, over: Partial<RosterSession> = {}): RosterSession =>
  ({ name, state: "working", unread: 0, open: 0, holds_turn: false, ...over }) as RosterSession;

const base = {
  ch: "ch",
  api,
  byId: new Map<string, PlanStep>(),
  sessions: null as SessionList | null,
  next: [] as readonly NextTask[],
  orchestrator: null as string | null,
  crit: [] as string[],
  onOpenTask: vi.fn(),
  onOpenSession: vi.fn(),
};

const map = (
  steps: Step[],
  over: Partial<typeof base> = {},
  phases: Board["phases"] = [{ n: 1, title: "One" }],
) => {
  const b = board(steps, phases);
  return render(<MapView {...base} board={b} byId={new Map(b.steps.map((x) => [x.id, x]))} {...over} />);
};

describe("Map phases", () => {
  it("shows one card per phase with its number, title and progress", () => {
    map(
      [
        s("t1", { phase_n: 1, status: "done" }),
        s("t2", { phase_n: 1, status: "doing" }),
        s("t3", { phase_n: 2 }),
      ],
      {},
      [
        { n: 1, title: "One" },
        { n: 2, title: "Two" },
      ],
    );
    const cards = screen.getAllByText(/done/);
    expect(cards).toHaveLength(2);
    expect(screen.getByText("One")).not.toBeNull();
    expect(screen.getByText("Two")).not.toBeNull();
    expect(screen.getByText("1 of 2 done")).not.toBeNull();
    expect(screen.getByText("0 of 1 done")).not.toBeNull();
    expect(screen.getByRole("img", { name: "Progress: 1 of 2 done" })).not.toBeNull();
  });

  it("marks a finished phase complete", () => {
    map([s("t1", { phase_n: 1, status: "done" }), s("t2", { phase_n: 1, status: "skipped" })]);
    expect(screen.getByTitle("complete")).not.toBeNull();
  });

  it("implies a phase the plan never declared", () => {
    map([s("t1", { phase_n: 1, status: "done" }), s("t9", { phase_n: 3 })], {}, [{ n: 1, title: "One" }]);
    expect(screen.getByText("Phase 3")).not.toBeNull();
    expect(screen.getByText("0 of 1 done")).not.toBeNull();
  });

  it("has an empty state before the plan has phases", () => {
    map([], {}, []);
    expect(screen.getByText("No phases yet.")).not.toBeNull();
  });
});

describe("Map sessions", () => {
  it("shows each session online with its pill and its now task", () => {
    const st = s("t1", { status: "doing", title: "Wire the thing" });
    map([st], {
      sessions: {
        sessions: [
          sess("alpha", { step: "t1" }),
          sess("gone", { state: "left", step: "t1" }),
          sess("kid", { parent: "alpha", step: "t1" }),
        ],
      } as SessionList,
      byId: new Map([[st.id, st]]),
    });
    expect(screen.getAllByText("alpha")).toHaveLength(1);
    expect(screen.queryByText("gone")).toBeNull();
    expect(screen.queryByText("kid")).toBeNull();
    expect(screen.getByText("Working")).not.toBeNull();
    expect(screen.getByText("Now")).not.toBeNull();
    expect(screen.getAllByText("t1")).toHaveLength(1);
    expect(screen.getByText("Wire the thing")).not.toBeNull();
    expect(screen.getAllByText("nothing queued")).toHaveLength(1);
  });

  it("opens a session's drawer by its row link", () => {
    const st = s("t1", { status: "doing" });
    const onOpenSession = vi.fn();
    const { container } = map([st], {
      sessions: { sessions: [sess("alpha", { step: "t1" })] } as SessionList,
      byId: new Map([[st.id, st]]),
      onOpenSession,
    });
    const link = must(container.querySelector("section[aria-label='Sessions'] ul a"));
    expect(link.getAttribute("href")).toBe("#/c/ch/team?s=alpha");
    fireEvent.click(link);
    expect(onOpenSession).toHaveBeenCalledWith("alpha");
  });

  it("says what a session with no task is doing, and queues the attention snapshot's next", () => {
    map([], {
      sessions: { sessions: [sess("alpha", { task: "watching the logs" })] } as SessionList,
      next: [{ session: "alpha", task: { id: "t2" } }],
    });
    expect(screen.getByText("watching the logs")).not.toBeNull();
    expect(screen.getByText("t2")).not.toBeNull();
  });

  it("falls back to the session's own next step, and skips it when it is the one being worked", () => {
    const steps = [
      s("t1", { owner: "alpha", status: "doing" }),
      s("t2", { owner: "alpha", status: "todo" }),
      s("t3", { owner: "alpha", status: "done" }),
    ];
    map(steps, {
      sessions: { sessions: [sess("alpha", { step: "t1" })] } as SessionList,
      byId: new Map(steps.map((x) => [x.id, x])),
    });
    expect(screen.getByText("t2")).not.toBeNull();
  });

  it("marks the orchestrator with the baton", () => {
    const first = map([], { sessions: { sessions: [sess("alpha")] } as SessionList, orchestrator: "alpha" });
    expect(screen.getByTitle("Orchestrator")).not.toBeNull();
    first.unmount();
    map([], { sessions: { sessions: [sess("alpha")] } as SessionList, orchestrator: "beta" });
    expect(screen.queryByTitle("Orchestrator")).toBeNull();
  });

  it("has an empty state before anyone joins", () => {
    map([]);
    expect(screen.getByText("No session online.")).not.toBeNull();
  });
});

describe("Map critical path", () => {
  it("lists the chain as links with arrows between them", () => {
    const st = s("a", { title: "First" });
    const { container } = map([st], {
      byId: new Map([[st.id, st]]),
      crit: ["a", "b"],
    });
    const cp = must(container.querySelector("section[aria-label='Critical path']"));
    expect(cp.textContent).toContain("The longest chain of unfinished tasks. Any delay here delays the end.");
    expect(cp.querySelectorAll("ol > li")).toHaveLength(2);
    expect(cp.querySelectorAll("li > svg")).toHaveLength(1);
    const link = must(cp.querySelector("li a"));
    expect(link.getAttribute("href")).toBe("#/c/ch/work?t=a");
    fireEvent.click(link);
    expect(base.onOpenTask).toHaveBeenCalledWith("a");
    expect(must(screen.getByText("Show in Graph").closest("a")).getAttribute("href")).toBe(
      "#/c/ch/work/graph",
    );
  });

  it("opens a chain task's drawer by its link", () => {
    const st = s("a");
    const { container } = map([st], { byId: new Map([[st.id, st]]), crit: ["a"] });
    fireEvent.click(
      must(must(container.querySelector("section[aria-label='Critical path']")).querySelector("li a")),
    );
    expect(base.onOpenTask).toHaveBeenCalledWith("a");
  });

  it("says so when everything open can run in parallel", () => {
    map([s("a")]);
    expect(
      screen.getByText("No chain of unfinished tasks: everything open can run in parallel."),
    ).not.toBeNull();
  });
});

describe("Map attention", () => {
  it("reads nothing when the attention snapshot is missing", () => {
    map([], { sessions: { sessions: [sess("alpha")] } as SessionList, next: [] });
    expect(screen.getByText("nothing queued")).not.toBeNull();
  });
});

describe("Map corners", () => {
  it("queues nothing while the attention's pick is the task being worked", () => {
    const st = s("t1", { status: "doing" });
    map([st], {
      sessions: { sessions: [sess("alpha", { step: "t1" })] } as SessionList,
      byId: new Map([[st.id, st]]),
      next: [{ session: "alpha", task: { id: "t1" } }],
    });
    expect(screen.getByText("nothing queued")).not.toBeNull();
  });

  it("marks no phase complete while one task is open, and carries implied phases' counts", () => {
    map([s("t1", { phase_n: 1, status: "done" }), s("t2", { phase_n: 1 }), s("t3", { phase_n: 2 })], {}, [
      { n: 1, title: "One" },
    ]);
    expect(screen.queryByText("complete")).toBeNull();
    expect(screen.getByText("Phase 2")).not.toBeNull();
    expect(screen.getByText("0 of 1 done")).not.toBeNull();
  });

  it("shows nothing for a session without a task", () => {
    map([], { sessions: { sessions: [sess("alpha")] } as SessionList });
    expect(screen.getByText("nothing")).not.toBeNull();
  });
});
