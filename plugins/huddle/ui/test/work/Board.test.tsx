import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api.ts";
import type { Board, PlanStep } from "../../src/store.ts";
import { BoardView, COLS } from "../../src/work/Board.tsx";
import type { Step } from "../../src/work/model.ts";

/** The value the test needs, or a loud failure — the tests carry no non-null assertions. */
function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("the test could not find what it needs");
  return x;
}

/** happy-dom delivers a hand-built DragEvent; fireEvent's does not reach Preact here. */
const drag = (el: Element, type: string, data: Record<string, unknown> = {}): boolean => {
  const e = new DragEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: data });
  return el.dispatchEvent(e);
};

/** One step with the fields the tests name. */
const s = (id: string, over: Partial<PlanStep> = {}): Step => ({
  id,
  title: `Task ${id}`,
  status: "todo",
  ...over,
});

const board = (steps: Step[]): Board => ({ phases: [{ n: 1, title: "One" }], steps }) as Board;

const base = {
  ch: "ch",
  api: {
    api: vi.fn(async () => []),
    op: vi.fn(async () => ({})),
    channelPath: (ch: string, p: string) => `/api/c/${ch}${p}`,
    channelHref: (ch: string, p: string) => `#/c/${ch}${p}`,
  } as unknown as Api,
  on: new Map<string, string[]>(),
  hot: new Set<string>(),
  activeTaskId: null as string | null | undefined,
  rows: [] as Step[],
  byId: new Map<string, PlanStep>(),
  onOpenTask: vi.fn(),
  onStatus: vi.fn(),
  onClear: vi.fn(),
};

/** The Board over one board, with fresh spies per render. */
const view = (steps: Step[], over: Partial<typeof base> = {}) => {
  const props = {
    ...base,
    board: board(steps),
    rows: steps,
    byId: new Map(steps.map((x) => [x.id, x])),
    ...over,
  };
  return render(<BoardView {...props} />);
};

describe("Board columns", () => {
  it("has the five columns in order", () => {
    expect(COLS).toEqual(["todo", "doing", "blocked", "done", "skipped"]);
  });

  it("shows one section per column with its count and its cards", () => {
    const { container } = view([
      s("t1", { status: "todo" }),
      s("t2", { status: "doing" }),
      s("t3", { status: "done" }),
    ]);
    const cols = container.querySelectorAll("section.board-col");
    expect(cols).toHaveLength(5);
    expect(cols[0]?.getAttribute("aria-labelledby")).toBe("kc-todo");
    expect(cols[0]?.querySelector("h2")?.textContent).toContain("2".replace("2", "1"));
    expect(cols[0]?.querySelector("h2")?.textContent).toContain("1");
    expect(cols[0]?.querySelectorAll("li .board-card")).toHaveLength(1);
    expect(cols[1]?.querySelector("h2")?.textContent).toContain("Doing");
    expect(cols[3]?.querySelectorAll("li .board-card")).toHaveLength(1);
  });

  it("collapses the empty Blocked and Skipped to rails", () => {
    const { container } = view([s("t1")]);
    const rails = container.querySelectorAll("section.board-col[aria-label]");
    expect(rails).toHaveLength(2);
    expect(rails[0]?.getAttribute("aria-label")).toBe("Blocked: empty");
    expect(rails[0]?.textContent).toContain("Blocked");
    expect(rails[1]?.getAttribute("aria-label")).toBe("Skipped: empty");
  });

  it("keeps Blocked a full column once it holds a card", () => {
    const { container } = view([s("t1", { status: "blocked" })]);
    expect(container.querySelectorAll("section.board-col[aria-label]")).toHaveLength(1);
    expect(screen.getByText("No done tasks")).not.toBeNull();
  });

  it("reads each card: id, gate, notes, avatars, owner, waits", () => {
    const on = new Map([["t1", ["alpha"]]]);
    const { container } = view(
      [
        s("t1", {
          status: "doing",
          owner: "owner",
          gate: "owner",
          comments: { n: 1, open: 1, kinds: [] },
          blocked_by: ["t2", "t3", "t4"],
        }),
      ],
      { on },
    );
    const card = container.querySelector("li[data-id='t1'] .board-card");
    expect(card?.querySelector(".font-mono")?.textContent).toBe("t1");
    expect(screen.getByTitle("Needs your approval")).not.toBeNull();
    expect(screen.getByTitle("Open notes")?.textContent).toContain("1");
    expect(screen.getByTitle("alpha is on it")).not.toBeNull();
    expect(card?.querySelector("a")?.getAttribute("href")).toBe("#/c/ch/work?t=t1");
    expect(card?.textContent).toContain("You");
    expect(card?.textContent).toContain("waits on t2, t3…");
  });

  it("says nobody when no owner works the card", () => {
    const { container } = view([s("t1", { status: "doing" })]);
    expect(container.querySelector("li .board-card")?.textContent).toContain("nobody");
  });

  it("opens the drawer by card click, by the title link", () => {
    const onOpenTask = vi.fn();
    const { container } = view([s("t1", { status: "doing" })], { onOpenTask });
    fireEvent.click(must(container.querySelector("li .board-card a")));
    expect(onOpenTask).toHaveBeenCalledWith("t1");
  });

  it("flashes the rows changed since the last paint", () => {
    const { container } = view([s("t1")], { hot: new Set(["t1"]) });
    expect(container.querySelector("li[data-id='t1']")?.className).toContain("flash");
  });

  it("wears the aura on the card whose drawer is open, and only on it", () => {
    const { container } = view([s("t1"), s("t2")], { activeTaskId: "t1" });
    const open = must(container.querySelector("li[data-id='t1'] .aura"));
    expect(open.className).toContain("aura-glow");
    expect(container.querySelector("li[data-id='t2'] .aura")).toBeNull();
  });
});

describe("Board moves", () => {
  it("drags a card in: the drop changes the status", () => {
    const onStatus = vi.fn();
    const { container } = view([s("t1")], { onStatus });
    const card = container.querySelector("li[data-id='t1'] .board-card");
    const getData = vi.fn(() => "t1");
    const setData = vi.fn();
    drag(must(card), "dragstart", { getData, setData });
    expect(setData).toHaveBeenCalledWith("text/plain", "t1");
    const col = container.querySelector("section[data-col='done']");
    drag(must(col), "dragover", { getData });
    expect(col?.className).toContain("over");
    drag(must(col), "dragleave", { getData });
    expect(col?.className).not.toContain("over");
    drag(must(col), "drop", { getData });
    expect(onStatus).toHaveBeenCalledWith("t1", "done");
  });

  it("drops on a collapsed rail too", () => {
    const onStatus = vi.fn();
    const { container } = view([s("t1")], { onStatus });
    drag(must(container.querySelector("section[data-col='skipped']")), "drop", { getData: () => "t1" });
    expect(onStatus).toHaveBeenCalledWith("t1", "skipped");
  });

  it("moves by the card's menu, every status but its own", async () => {
    const onStatus = vi.fn();
    const { container } = view([s("t1", { status: "todo" })], { onStatus });
    const btn = must(container.querySelector("button[data-mv='t1']"));
    expect(btn.getAttribute("aria-label")).toBe("Move t1");
    fireEvent.click(btn);
    const items = await vi.waitFor(() => {
      const found = [...document.body.querySelectorAll("button")].filter((b) =>
        b.textContent?.includes("Move to "),
      );
      if (found.length === 0) throw new Error("no menu yet");
      return found;
    });
    const labels = items.map((b) => b.textContent);
    expect(labels).toEqual([
      "DoingMove to Doing",
      "BlockedMove to Blocked",
      "DoneMove to Done",
      "SkippedMove to Skipped",
    ]);
    fireEvent.click(must(items.find((b) => b.textContent?.includes("Move to Done"))));
    expect(onStatus).toHaveBeenCalledWith("t1", "done");
  });
});

describe("Board empty state", () => {
  it("shows the plan's empty state when neither filters nor board hold tasks", () => {
    const onClear = vi.fn();
    view([], { onClear });
    expect(screen.getByText("No tasks yet")).not.toBeNull();
  });

  it("keeps the columns and their empty hints while the filters empty a full board", () => {
    view([s("t1")], { rows: [] });
    expect(screen.getByText("No to do tasks")).not.toBeNull();
    expect(screen.queryByText("No tasks yet")).toBeNull();
  });
});

describe("Board card corners", () => {
  it("drops the drag affordance when the drag ends", () => {
    const { container } = view([s("t1")]);
    const card = must(container.querySelector("li .board-card"));
    drag(must(card.closest("li")), "dragstart", { setData: vi.fn() });
    expect(card.className).toContain("drag");
    drag(card, "dragend");
    expect(card.className).not.toContain("drag");
  });

  it("keeps a two-task waits line off the ellipsis and the notes tag off a quiet card", () => {
    const { container } = view([s("t1", { status: "doing", blocked_by: ["a", "b"] })]);
    const card = must(container.querySelector("li .board-card"));
    expect(card.textContent).toContain("waits on a, b");
    expect(card.textContent).not.toContain("…");
    expect(card.querySelector("[title='Open notes']")).toBeNull();
  });
});
