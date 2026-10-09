import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api.ts";
import { readPref, type Storage, writePref } from "../../src/storage.ts";
import type { Attention, Board, PlanStep, SessionList } from "../../src/store.ts";
import { prefKey, type Step, type ViewId } from "../../src/work/model.ts";
import { SegBar, setTaskStatus, Work } from "../../src/work/Work.tsx";

/** The value the test needs, or a loud failure — the tests carry no non-null assertions. */
function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("the test could not find what it needs");
  return x;
}

/** Site storage over a map, empty for every test. */
const store = (): Storage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

/** One step with the fields the tests name. */
const s = (id: string, over: Partial<PlanStep> = {}): Step => ({
  id,
  title: `Task ${id}`,
  status: "todo",
  ...over,
});

const board = (steps: Step[]): Board => ({ phases: [{ n: 1, title: "One" }], steps }) as Board;

const byId = (steps: Step[]): Map<string, PlanStep> => new Map(steps.map((x) => [x.id, x]));

/** The Work shell's API spy. */
const apiF = (): Api =>
  ({
    api: vi.fn(async () => []),
    op: vi.fn(async () => ({ result: { tasks: 2, phases: 1 } })),
    channelPath: (ch: string, p: string) => `/api/c/${ch}${p}`,
    channelHref: (ch: string, p: string) => `#/c/${ch}${p}`,
  }) as unknown as Api;

const base = {
  ch: "ch",
  view: "list" as ViewId | undefined,
  sessions: null as SessionList | null,
  attention: null as
    | (Attention & { next?: readonly { session: string; task?: { id: string } | null }[] })
    | null,
  now: 0,
  onOpenTask: vi.fn(),
  onOpenSession: vi.fn(),
  onCompose: vi.fn(),
  onNavigate: vi.fn(),
  orchestrator: null as string | null | undefined,
  toast: vi.fn(),
  reloadBoard: vi.fn(),
  touchAttention: vi.fn(),
};

/** The Work shell over one board, with the mocks the test names. */
const work = (
  steps: Step[],
  over: Partial<typeof base> = {},
  over2: { api?: Api; store?: Storage; board?: Board | null } = {},
) => {
  const st = over2.store ?? store();
  const props = {
    ...base,
    board: over2.board === undefined ? board(steps) : over2.board,
    byId: byId(steps),
    api: over2.api ?? apiF(),
    store: st,
    ...over,
  };
  return { props, st, ...render(<Work {...props} />) };
};

const plan = { plan: { phases: [{ n: 1, title: "One" }], steps: [{ id: "t1", title: "One" }] } };

/** happy-dom delivers hand-made change events here; fireEvent's do not reach these nodes. */
const changeTo = (el: HTMLSelectElement, value: string): void => {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
};

/** happy-dom delivers a hand-made change here; fireEvent's does not reach the file input. */
const fileChange = (input: HTMLInputElement, files: File[]): void => {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

/** A JSON plan file over the given body. */
const file = (body: unknown, name = "plan.json"): File =>
  new File([JSON.stringify(body)], name, { type: "application/json" });

describe("Work shell", () => {
  it("shows the four view tabs, the current one selected, and navigates by click", () => {
    const onNavigate = vi.fn();
    const { container } = work([s("t1")], { view: "list", onNavigate });
    const tabs = [...container.querySelectorAll("[role='tab']")];
    expect(tabs.map((t) => t.getAttribute("data-tab"))).toEqual(["list", "board", "graph", "map"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    expect(tabs[2]?.textContent).toContain("Graph");
    fireEvent.click(must(tabs[1]));
    expect(onNavigate).toHaveBeenCalledWith("board");
    expect(container.querySelector("#wpanel")?.getAttribute("aria-labelledby")).toBe("wt-list");
  });

  it("reads a bare Work address as the Map, with the Map tab selected", () => {
    const st = store();
    const { container } = work([s("t1", { phase_n: 1 })], { view: undefined }, { store: st });
    const tabs = [...container.querySelectorAll("[role='tab']")];
    expect(tabs.find((t) => t.getAttribute("data-tab") === "map")?.getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(tabs.find((t) => t.getAttribute("data-tab") === "list")?.getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(container.querySelector("#wpanel")?.getAttribute("aria-labelledby")).toBe("wt-map");
    expect(screen.getByRole("img", { name: "Progress: 0 of 1 done" })).not.toBeNull();
    // the defaulted Map is not the browser's choice, so the kept wview stays as it was
    expect(readPref(st, "wview:ch", "list")).toBe("list");
  });

  it("opens the composer for a new task, carrying the picked phase", () => {
    const onCompose = vi.fn();
    const st = store();
    writePref(st, prefKey("ch", "wphase"), "2");
    work([s("t1")], { onCompose }, { store: st });
    fireEvent.click(screen.getByText("New task"));
    expect(onCompose).toHaveBeenCalledWith({ phase: 2 }, expect.anything());
  });

  it("opens the composer without a phase while every phase shows", () => {
    const onCompose = vi.fn();
    work([s("t1")], { onCompose });
    fireEvent.click(screen.getByText("New task"));
    expect(onCompose).toHaveBeenCalledWith({ phase: undefined }, expect.anything());
  });

  it("has an empty panel before the board loads, with the shell still up", () => {
    const { container } = work([], {}, { board: null });
    expect(container.querySelector("#wpanel")?.children).toHaveLength(0);
    expect(screen.getByText("New task")).not.toBeNull();
  });
});

describe("Work import", () => {
  /** The file input once the shell is up. */
  const imp = (body: unknown): HTMLInputElement => {
    const input = document.getElementById("imp") as HTMLInputElement;
    fileChange(input, [file(body)]);
    return input;
  };

  it("hands the plan file to import_plan, toasts the counts, reloads the board", async () => {
    const { props } = work([s("t1")]);
    const input = imp(plan);
    const op = props.api.op as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(op).toHaveBeenCalledWith("ch", "import_plan", { plan: plan.plan }));
    await waitFor(() => expect(props.reloadBoard).toHaveBeenCalled());
    expect(props.toast).toHaveBeenCalledWith("Imported 2 tasks in 1 phases.", { bad: false });
    expect(input.value).toBe("");
  });

  it("unwraps a bare plan body and reads the empty result", async () => {
    const { props } = work([s("t1")]);
    const body = { phases: [], steps: [] };
    imp(body);
    await waitFor(() => expect(props.api.op).toHaveBeenCalledWith("ch", "import_plan", { plan: body }));
    await waitFor(() =>
      expect(props.toast).toHaveBeenCalledWith("Imported 2 tasks in 1 phases.", { bad: false }),
    );
  });

  it("flags the import's problems", async () => {
    const api = apiF();
    (api.op as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: { tasks: 1, phases: 1, errors: ["no gate"] },
    });
    const { props } = work([s("t1")], {}, { api });
    imp(plan);
    await waitFor(() =>
      expect(props.toast).toHaveBeenCalledWith("Imported 1 tasks in 1 phases, with 1 problems: no gate.", {
        bad: true,
      }),
    );
  });

  it("toasts the refusal when the op fails", async () => {
    const api = apiF();
    (api.op as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no gate on t1"));
    const { props } = work([s("t1")], {}, { api });
    imp(plan);
    await waitFor(() =>
      expect(props.toast).toHaveBeenCalledWith("The plan was not imported: no gate on t1", { bad: true }),
    );
    expect(props.reloadBoard).not.toHaveBeenCalled();
  });

  it("toasts a plan the browser cannot read", async () => {
    const { props } = work([s("t1")]);
    const input = document.getElementById("imp") as HTMLInputElement;
    fileChange(input, [new File(["{oops"], "p.json")]);
    await waitFor(() =>
      expect(props.toast).toHaveBeenCalledWith(expect.stringContaining("The plan was not imported:"), {
        bad: true,
      }),
    );
  });

  it("reads nothing while the file input is empty", () => {
    const { props } = work([s("t1")]);
    const input = document.getElementById("imp") as HTMLInputElement;
    fileChange(input, []);
    expect(props.api.op).not.toHaveBeenCalled();
  });
});

describe("Work filters", () => {
  const steps = [
    s("t1", { owner: "owner", status: "doing" }),
    s("t2", { owner: "owl", status: "blocked", blocked_by: ["t1"] }),
    s("t3", { status: "done" }),
  ];

  /** The rows the panel's list shows right now. */
  const rows = (): number => document.querySelectorAll("#wpanel tbody tr").length;

  it("shows the segments with their counts, and switches by click, kept per browser", () => {
    const { st } = work(steps, { view: "list" });
    const group = screen.getByRole("group", { name: "Filter" });
    const seg = (label: string): HTMLButtonElement =>
      [...group.querySelectorAll("button")].find((b) =>
        b.textContent?.startsWith(label),
      ) as HTMLButtonElement;
    expect(must(seg("All")).getAttribute("aria-pressed")).toBe("true");
    expect(must(seg("Mine")).textContent).toContain("1");
    expect(must(seg("Blocked")).textContent).toContain("1");
    expect(must(seg("Ready")).textContent).toBe("Ready1");
    fireEvent.click(seg("Mine"));
    expect(must(seg("Mine")).getAttribute("aria-pressed")).toBe("true");
    expect(readPref(st, prefKey("ch", "wfilter"), "all")).toBe("mine");
    expect(rows()).toBe(1);
    expect(must(seg("All")).getAttribute("aria-pressed")).toBe("false");
  });

  it("reads the kept filters back from storage", () => {
    const st = store();
    writePref(st, prefKey("ch", "wfilter"), "mine");
    work(steps, {}, { store: st });
    expect(rows()).toBe(1);
    const mine = [...screen.getByRole("group", { name: "Filter" }).querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Mine"),
    );
    expect(mine?.getAttribute("aria-pressed")).toBe("true");
  });

  it("filters by owner through the select", async () => {
    work(steps, { view: "list" });
    const own = document.getElementById("wown") as HTMLSelectElement;
    expect(own.textContent).toContain("Any owner");
    changeTo(own, "owl");
    await waitFor(() => expect(rows()).toBe(1));
    changeTo(own, "-");
    await waitFor(() => expect(rows()).toBe(1));
  });

  it("offers the phase select once the plan has two phases, and filters by it", async () => {
    const b: Board = {
      phases: [
        { n: 1, title: "One" },
        { n: 2, title: "Two" },
      ],
      steps: [s("t1", { phase_n: 1 }), s("t2", { phase_n: 2 })],
    } as Board;
    const { st } = work(b.steps as Step[], { view: "list" }, { board: b });
    const ph = document.getElementById("wph") as HTMLSelectElement | null;
    expect(ph).not.toBeNull();
    expect(must(ph).textContent).toContain("Every phase");
    expect(must(ph).textContent).toContain("Phase 1: One");
    changeTo(must(ph), "2");
    await waitFor(() => expect(rows()).toBe(1));
    expect(readPref(st, prefKey("ch", "wphase"), "all")).toBe("2");
  });

  it("has no phase select while the plan has one phase", () => {
    work(steps);
    expect(document.getElementById("wph")).toBeNull();
  });

  it("filters by the query box over id, title and owner", () => {
    work(steps);
    const q = document.getElementById("wq") as HTMLInputElement;
    expect(q.getAttribute("aria-label")).toBe("Filter tasks");
    expect(q.getAttribute("placeholder")).toBe("Filter by id, title or owner");
    fireEvent.input(q, { target: { value: "owl" } });
    expect(rows()).toBe(1);
  });

  it("shows the segmented bar and its legend over the scope the filters keep", () => {
    work(steps, { view: "list" });
    expect(screen.getByTitle("1 done, 1 doing, 1 blocked, 3 in all")).not.toBeNull();
    expect(document.querySelector(".text-xs.muted.tnum")?.textContent).toBe(
      "1 of 3 done, 1 doing, 1 blocked",
    );
  });

  it("clears every filter from the list's empty state", () => {
    const st = store();
    writePref(st, prefKey("ch", "wfilter"), "mine");
    writePref(st, prefKey("ch", "wq"), "zzz");
    work(steps, {}, { store: st });
    fireEvent.click(screen.getByText("Clear filters"));
    expect(readPref(st, prefKey("ch", "wfilter"), "all")).toBe("all");
    expect(readPref(st, prefKey("ch", "wq"), "")).toBe("");
    expect(rows()).toBe(3);
  });
});

describe("Work status changes", () => {
  // fresh steps per test: a status change rewrites the board's rows in place
  const steps = (): Step[] => [s("t1"), s("t2", { status: "doing" })];

  /** Drops a card onto one of the board's columns and returns the mocks. */
  const dropOn = async (col: string, id = "t1") => {
    const api = apiF();
    const { props, container } = work(steps(), { view: "board" }, { api });
    const e = new DragEvent("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { getData: () => id } });
    must(container.querySelector(`section[data-col='${col}']`)).dispatchEvent(e);
    await waitFor(() => expect(api.op as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1));
    return props;
  };

  it("drags a card into a column: the op, the toast with Undo, the reload", async () => {
    const props = await dropOn("done");
    expect(props.api.op).toHaveBeenCalledWith("ch", "task_status", { id: "t1", status: "done", note: "" });
    expect(props.toast).toHaveBeenCalledWith("t1 is done", { undo: expect.any(Function) });
    expect(props.reloadBoard).toHaveBeenCalled();
    expect(props.touchAttention).toHaveBeenCalled();
  });

  it("undoes a status change: back to the old status, noted", async () => {
    const props = await dropOn("done");
    const undo = props.toast.mock.calls[0]?.[1]?.undo as (() => void) | undefined;
    undo?.();
    await waitFor(() =>
      expect(props.api.op).toHaveBeenCalledWith("ch", "task_status", {
        id: "t1",
        status: "todo",
        note: "undo: back to todo",
      }),
    );
  });

  it("toasts the server's refusal, and changes nothing else", async () => {
    const api = apiF();
    (api.op as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("t1 waits on t2"));
    const { props, container } = work(steps(), { view: "board" }, { api });
    const e = new DragEvent("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { getData: () => "t2" } });
    must(container.querySelector("section[data-col='done']")).dispatchEvent(e);
    await waitFor(() => expect(props.toast).toHaveBeenCalledWith("t1 waits on t2", { bad: true }));
    expect(props.reloadBoard).not.toHaveBeenCalled();
  });

  it("explains an old server without the op", async () => {
    const api = apiF();
    (api.op as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("no operation: task_status"), { status: 404 }),
    );
    const { props, container } = work(steps(), { view: "board" }, { api });
    const e = new DragEvent("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { getData: () => "t1" } });
    must(container.querySelector("section[data-col='done']")).dispatchEvent(e);
    await waitFor(() =>
      expect(props.toast).toHaveBeenCalledWith(
        "This Huddle server does not support “task_status” yet. Update the server.",
        {
          bad: true,
        },
      ),
    );
  });
});

describe("Work passes the map its data", () => {
  it("hands the map the roster, the attention's next, and the critical path", () => {
    const steps = [s("t1"), s("t2", { depends: ["t1"] })];
    const sessions = {
      sessions: [{ name: "alpha", state: "working", unread: 0, open: 0, holds_turn: false }],
    } as unknown as SessionList;
    const attention = { next: [{ session: "alpha", task: { id: "t2" } }] } as unknown as Attention;
    work(steps, { view: "map", sessions, attention, orchestrator: "alpha" });
    expect(screen.getByText("Sessions")).not.toBeNull();
    expect(screen.getByText("Phases")).not.toBeNull();
    expect(screen.getByText("Critical path")).not.toBeNull();
    expect(screen.getAllByText("t2").length).toBeGreaterThan(0);
    expect(screen.getByTitle("Orchestrator")).not.toBeNull();
  });
});

describe("SegBar", () => {
  it("draws one segment per non-zero count, in the legacy order", () => {
    const steps: Step[] = [
      s("a", { status: "done" }),
      s("b", { status: "skipped" }),
      s("c", { status: "doing" }),
      s("d", { status: "todo", blocked_by: ["c"] }),
      s("e", { status: "blocked" }),
    ];
    const { container } = render(<SegBar steps={steps} />);
    expect(container.querySelectorAll("i")).toHaveLength(4);
    expect(screen.getByTitle("2 done, 1 doing, 1 waiting, 1 blocked, 5 in all")).not.toBeNull();
    expect(
      screen.getByRole("img", { name: "Progress: 2 done, 1 doing, 1 waiting, 1 blocked, 5 in all" }),
    ).not.toBeNull();
  });

  it("labels nothing when asked, and survives an empty set", () => {
    const { container } = render(<SegBar steps={[]} label={false} />);
    expect(container.querySelectorAll("i")).toHaveLength(0);
    expect(screen.getByTitle(", 0 in all").getAttribute("aria-label")).toBe(", 0 in all");
  });
});

describe("setTaskStatus", () => {
  const deps = (over: Record<string, unknown> = {}) =>
    ({
      api: apiF(),
      ch: "ch",
      toast: vi.fn(),
      byId: byId([s("t1", { status: "todo" })]),
      ...over,
    }) as unknown as Parameters<typeof setTaskStatus>[0];

  it("does nothing without a task to change or when the status is the same", async () => {
    const d = deps();
    await expect(setTaskStatus(d, "ghost", "done")).resolves.toBe(false);
    await expect(setTaskStatus(d, "t1", "todo")).resolves.toBe(false);
    expect(d.api.op).not.toHaveBeenCalled();
  });

  it("prefers the drawer's open task for the previous status", async () => {
    const d = deps({ current: s("t1", { status: "doing" }) });
    await expect(setTaskStatus(d, "t1", "done")).resolves.toBe(true);
    expect(d.api.op).toHaveBeenCalledWith("ch", "task_status", { id: "t1", status: "done", note: "" });
  });

  it("passes the note through and patches the row in place", async () => {
    const d = deps();
    await expect(setTaskStatus(d, "t1", "doing", "with care")).resolves.toBe(true);
    expect(d.api.op).toHaveBeenCalledWith("ch", "task_status", {
      id: "t1",
      status: "doing",
      note: "with care",
    });
    expect(d.byId.get("t1")?.status).toBe("doing");
    expect(d.toast).toHaveBeenCalledWith("t1 is doing", { undo: expect.any(Function) });
  });
});
