import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api.ts";
import type { Board, PlanStep } from "../../src/store.ts";
import { EmptyTasks, List } from "../../src/work/List.tsx";
import type { Phase, Step } from "../../src/work/model.ts";

/** The value the test needs, or a loud failure — the tests carry no non-null assertions. */
function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("the test could not find what it needs");
  return x;
}

const api = (search: unknown[] = []): Api =>
  ({
    api: vi.fn(async () => search),
    op: vi.fn(async () => ({})),
    channelPath: (ch: string, p: string) => `/api/c/${ch}${p}`,
    channelHref: (ch: string, p: string) => `#/c/${ch}${p}`,
  }) as unknown as Api;

/** One step with the fields the tests name. */
const s = (id: string, over: Partial<PlanStep> = {}): Step => ({
  id,
  title: `Task ${id}`,
  status: "todo",
  ...over,
});

const onePhase: Phase[] = [{ n: 1, title: "One" }];
const board = (steps: Step[], phases: Board["phases"] = onePhase): Board => ({ phases, steps }) as Board;

const base = {
  ch: "ch",
  api: api(),
  on: new Map<string, string[]>(),
  hot: new Set<string>(),
  phase: "all",
  q: "",
  anySteps: true,
  activeTaskId: null as string | null,
  onOpenTask: vi.fn(),
  onClear: vi.fn(),
};

/** The List over one board, with fresh spies per render. */
const list = (steps: Step[], over: Partial<typeof base> = {}, phases: Board["phases"] = onePhase) => {
  const props = {
    ...base,
    ps: phases as Phase[],
    rows: steps,
    board: board(steps, phases),
    byId: new Map(steps.map((x) => [x.id, x])),
    ...over,
  };
  return render(<List {...props} />);
};

describe("EmptyTasks", () => {
  it("offers the way out of the filters while tasks exist", () => {
    const onClear = vi.fn();
    render(<EmptyTasks anySteps onClear={onClear} />);
    expect(screen.getByText("No task matches.")).not.toBeNull();
    const b = screen.getByText("Clear filters");
    fireEvent.click(b);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("asks for a plan while the board is empty", () => {
    render(<EmptyTasks anySteps={false} />);
    expect(screen.getByText("No tasks yet")).not.toBeNull();
    expect(
      screen.getByText("Sessions add tasks as they plan. Add one with New task, or import a plan file."),
    ).not.toBeNull();
  });
});

describe("List rows", () => {
  it("shows one row per task: pill, id, title, owner, notes, avatars", () => {
    const on = new Map([["t1", ["alpha", "owl"]]]);
    const { container } = list(
      [s("t1", { owner: "owner", comments: { n: 2, open: 2, kinds: [] } }), s("t2", { owner: null })],
      { on },
    );
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    const row = container.querySelector("tr[data-tid='t1']");
    expect(row?.querySelector(".badge")?.textContent).toBe("To do");
    expect(row?.querySelector(".font-mono")?.textContent).toBe("t1");
    expect(row?.textContent).toContain("Task t1");
    expect(row?.textContent).toContain("You");
    const notes = row?.querySelectorAll("td")[4];
    expect(notes?.textContent).toBe("2");
    expect(notes?.getAttribute("title")).toBe("2 open notes");
    expect(row?.querySelectorAll(".avatar")).toHaveLength(2);
    expect(screen.getByTitle("alpha is on it")).not.toBeNull();
    const empty = container.querySelector("tr[data-tid='t2']");
    expect(empty?.textContent).toContain("nobody");
    const notesEmpty = empty?.querySelectorAll("td")[4];
    expect(notesEmpty?.getAttribute("title")).toBe(null);
  });

  it("links the row to the drawer, by row click and by the anchor", () => {
    const onOpenTask = vi.fn();
    const { container } = list([s("t1")], { onOpenTask });
    const row = container.querySelector("tr[data-tid='t1']");
    expect(row?.querySelector("a")?.getAttribute("href")).toBe("#/c/ch/work?t=t1");
    fireEvent.click(must(row));
    expect(onOpenTask).toHaveBeenCalledWith("t1");
    onOpenTask.mockClear();
    fireEvent.click(must(must(row).querySelector("a")));
    expect(onOpenTask).toHaveBeenCalledWith("t1");
  });

  it("marks the open task's row and the rows changed since the last paint", () => {
    const { container } = list([s("t1"), s("t2")], { activeTaskId: "t1", hot: new Set(["t2"]) });
    expect(container.querySelector("tr[data-tid='t1']")?.className).toContain("open bg-primary/8");
    expect(container.querySelector("tr[data-tid='t2']")?.className).toContain("flash");
  });

  it("marks a gated task and says what a waiting one waits on", () => {
    const { container } = list([
      s("t1", { gate: "owner", blocked_by: ["t2", "t3", "t9"] }),
      s("t2", { gate: "none" }),
    ]);
    const row = container.querySelector("tr[data-tid='t1']");
    expect(screen.getByTitle("Needs your approval")).not.toBeNull();
    expect(row?.textContent).toContain("waits on t2, t3…");
    expect(screen.getByText("Approval")).not.toBeNull();
    expect(container.querySelector("tr[data-tid='t2']")?.textContent).not.toContain("waits on");
  });

  it("mutes the title of a finished task", () => {
    const { container } = list([s("t1", { status: "done" })]);
    expect(container.querySelector("tr[data-tid='t1'] .truncate.muted")?.textContent).toBe("Task t1");
  });
});

describe("List grouping", () => {
  const twoPhases: Board["phases"] = [
    { n: 1, title: "One" },
    { n: 2, title: "Two" },
  ];

  it("groups the rows under their phase cards with each phase's progress", () => {
    const { container } = list(
      [s("t1", { phase_n: 1, status: "done" }), s("t2", { phase_n: 2, status: "todo" })],
      {},
      twoPhases,
    );
    const groups = container.querySelectorAll("section[aria-labelledby^='ph-']");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.getAttribute("aria-labelledby")).toBe("ph-1");
    expect(groups[0]?.textContent).toContain("One");
    expect(groups[0]?.textContent).toContain("1 of 1 done");
    expect(groups[1]?.textContent).toContain("0 of 1 done");
    expect(screen.getByRole("img", { name: "Progress: 1 of 1 done" })).not.toBeNull();
  });

  it("skips a phase the filters emptied, and stays flat while a phase is picked", () => {
    const { container } = list([s("t1", { phase_n: 1 })], { phase: "2" }, twoPhases);
    expect(container.querySelectorAll("section[aria-labelledby^='ph-']")).toHaveLength(0);
    expect(container.querySelector("section[aria-label='Tasks']")).not.toBeNull();
  });

  it("briefs the picked phase over the table, summary and diagram included", () => {
    const cur: Phase = {
      n: 2,
      title: "Two",
      summary: "why now",
      diagram: { nodes: [["h", "Host", "host", "a box"]] },
    };
    const { container } = list([s("t2", { phase_n: 2 })], { phase: "2" }, [...onePhase, cur]);
    expect(screen.getByText("Phase 2")).not.toBeNull();
    expect(screen.getByText("why now")).not.toBeNull();
    expect(container.querySelector("svg.pgraph")).not.toBeNull();
    expect(container.querySelector("section[aria-label='Tasks']")?.textContent).toContain("Task t2");
  });
});

describe("List empty states", () => {
  it("says no task matches while the board has tasks", () => {
    const onClear = vi.fn();
    list([], { anySteps: true, onClear });
    fireEvent.click(screen.getByText("Clear filters"));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("says no tasks yet while the plan is empty", () => {
    list([], { anySteps: false });
    expect(screen.getByText("No tasks yet")).not.toBeNull();
  });
});

describe("List search", () => {
  it("asks the server from three characters and shows the hits the list does not have", async () => {
    vi.useFakeTimers();
    try {
      const search = [
        { id: "t1", title: "Task t1", hit: "already shown" },
        { id: "t9", title: "Task t9", hit: "the «alpha» plan" },
      ];
      const a = api(search);
      const { container } = list([s("t1", { title: "Other" })], { api: a, q: "alpha" });
      expect(a.api).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(160);
      expect(a.api).toHaveBeenCalledWith("/api/c/ch/search?q=alpha");
      expect(await screen.findByText("Found in the task text")).not.toBeNull();
      const hit = container.querySelector("#wfound");
      expect(hit?.querySelectorAll("a")).toHaveLength(1);
      expect(hit?.textContent).toContain("t9");
      expect(hit?.querySelector("mark")?.textContent).toBe("alpha");
      expect(hit?.querySelector(".av, .badge:not(.font-mono)") === null).toBe(true);
      expect(hit?.querySelector("span[title='To do']")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps nothing while the query is short, and survives a failed search", async () => {
    vi.useFakeTimers();
    try {
      const a = api();
      (a.api as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("down"));
      list([s("t1")], { api: a, q: "al" });
      await vi.advanceTimersByTimeAsync(200);
      expect(a.api).not.toHaveBeenCalled();
      expect(screen.queryByText("Found in the task text")).toBeNull();
      list([s("t1")], { api: a, q: "alpha" });
      await vi.advanceTimersByTimeAsync(200);
      expect(screen.queryByText("Found in the task text")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("List branch corners", () => {
  it("opens a found task from the search card", async () => {
    vi.useFakeTimers();
    try {
      const onOpenTask = vi.fn();
      const { container } = list([s("t1", { title: "Other" })], {
        api: api([{ id: "t9", title: "Task t9", hit: "the «alpha» plan" }]),
        q: "alpha",
        onOpenTask,
      });
      await vi.advanceTimersByTimeAsync(160);
      const link = await vi.waitFor(() => {
        const a = container.querySelector("#wfound a");
        if (!a) throw new Error("no hits yet");
        return a;
      });
      fireEvent.click(link);
      expect(onOpenTask).toHaveBeenCalledWith("t9");
    } finally {
      vi.useRealTimers();
    }
  });

  it("briefs a phase with only a summary, or only a diagram", () => {
    const one: Phase = { n: 2, title: "Two", summary: "just words" };
    const { container: a } = list([s("t2", { phase_n: 2 })], { phase: "2" }, [...onePhase, one]);
    expect(a.querySelector("svg.pgraph")).toBeNull();
    expect(a.querySelector(".prose-h")?.textContent).toBe("just words");
    const two: Phase = { n: 2, title: "Two", diagram: { nodes: [["h", "Host"]] } };
    const { container: b } = list([s("t2", { phase_n: 2 })], { phase: "2" }, [...onePhase, two]);
    expect(b.querySelector(".prose-h")).toBeNull();
    expect(b.querySelector("svg.pgraph")).not.toBeNull();
  });

  it("shows the waiting line without a gate, and a gate without waiting", () => {
    const { container } = list([s("w", { blocked_by: ["t1", "t2"] }), s("g", { gate: "ask" })]);
    const w = container.querySelector("tr[data-tid='w']");
    expect(w?.textContent).toContain("waits on t1, t2");
    expect(w?.querySelector("[title='Needs your approval']")).toBeNull();
    const g = container.querySelector("tr[data-tid='g']");
    expect(g?.querySelector("[title='Needs your approval']")).not.toBeNull();
    expect(g?.textContent).not.toContain("waits on");
  });

  it("keeps a short waits line ellipsis-free and a noteless row untitled", () => {
    const { container } = list([s("w", { blocked_by: ["t1"] })]);
    expect(container.querySelector("tr[data-tid='w']")?.textContent).toContain("waits on t1");
    expect(container.querySelector("tr[data-tid='w']")?.textContent).not.toContain("…");
  });
});
