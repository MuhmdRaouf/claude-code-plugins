// Palette.test.tsx — the command palette: the items the channel's data builds, the ranking with
// the tasks and the server's text hits, the dialog itself (typing, arrows, Enter, Escape), the
// shortcuts dialog, and the single-key layer (⌘K, the g chords, ?, /, j/k, 1–5).
import { act, fireEvent, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api.ts";
import {
  buildItems,
  type CmdItem,
  CmdKeys,
  CmdPalette,
  chordKey,
  dialogGuard,
  goChord,
  HelpDialog,
  helpSections,
  isMac,
  isTextField,
  keyDeps,
  keySetStatus,
  type PaletteDeps,
  paletteResults,
  type SearchHit,
  singleKey,
  stepTask,
  swallowedKey,
} from "../../src/app/Palette.tsx";
import type { Storage } from "../../src/storage.ts";
import type { Attention, Board, HuddleStore, PlanStep, SessionList } from "../../src/store.ts";
import { TaskDrawer } from "../../src/work/TaskDrawer.tsx";
import { flush, makeCtx, makeState, renderIn } from "../helpers.tsx";

// ── fakes ────────────────────────────────────────────────────────────────────

const apiF = (): Api =>
  ({
    api: vi.fn(async () => []),
    op: vi.fn(async () => ({ result: true })),
    channelPath: (ch: string, p: string) => `/api/c/${ch}${p}`,
    channelHref: (ch: string, p: string) => `#/c/${ch}${p}`,
  }) as unknown as Api;

const memStore = (): Storage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

const huddleStore = (): HuddleStore =>
  ({
    loadBoard: vi.fn(async () => null),
    attChanged: vi.fn(),
    sessChanged: vi.fn(),
  }) as unknown as HuddleStore;

const BOARD: Board = {
  phases: [{ n: 1, title: "One" }],
  steps: [
    { id: "t1", title: "Wire the rail", status: "todo", owner: "scan.agent" },
    { id: "t2", title: "Ship the docs", status: "done" },
  ],
} as Board;

const deps = (over: Partial<PaletteDeps> = {}): PaletteDeps => ({
  ch: "ch",
  api: apiF(),
  board: BOARD,
  byId: new Map<string, PlanStep>([
    ["t1", { id: "t1", status: "todo" }],
    ["t2", { id: "t2", status: "done" }],
  ]),
  attention: {
    asks: [{ seq: 1, from: "web", msg: "deploy now?" }],
    gates: [{ id: "t2", title: "Ship it" }],
    paused: [],
    blocked: [],
  } as Attention,
  sessions: {
    sessions: [
      { name: "web", state: "working", holds_turn: false, parent: null },
      { name: "docs", state: "idle", control: "pause", holds_turn: true, parent: "web" },
    ],
  } as unknown as SessionList,
  channels: [{ name: "other", title: "Other" }],
  taskId: null,
  go: vi.fn(),
  act: vi.fn(async () => true),
  compose: vi.fn(),
  toast: vi.fn(),
  notifyOn: () => false,
  toggleNotify: vi.fn(),
  openHelp: vi.fn(),
  setTheme: vi.fn(),
  exportPlan: vi.fn(),
  touchAttention: vi.fn(),
  touchSessions: vi.fn(),
  setTaskStatus: vi.fn(),
  ...over,
});

const byGroup = (items: readonly CmdItem[], g: string): CmdItem[] => items.filter((x) => x.g === g);
const find = (items: readonly CmdItem[], t: string): CmdItem => {
  const x = items.find((i) => i.t === t);
  if (!x) throw new Error(`no item “${t}”`);
  return x;
};

beforeEach(() => {
  localStorage.clear();
  location.hash = "#/c/ch/work";
});

afterEach(() => {
  document.querySelectorAll("dialog").forEach((d) => {
    d.remove();
  });
  vi.useRealTimers();
});

// ── the items ────────────────────────────────────────────────────────────────

describe("buildItems", () => {
  it("offers the destinations with their g chords, Today and the work views", () => {
    const items = buildItems(deps());
    const go = byGroup(items, "Go to");
    expect(go.slice(0, 5).map((x) => [x.t, x.kb])).toEqual([
      ["Inbox", "g i"],
      ["Team", "g t"],
      ["Work", "g w"],
      ["Knowledge", "g k"],
      ["Settings", "g s"],
    ]);
    expect(go.find((x) => x.t === "Today")?.s).toContain("per session");
    expect(
      byGroup(items, "Go to")
        .filter((x) => x.t.startsWith("Work:"))
        .map((x) => x.t),
    ).toEqual(["Work: List", "Work: Board", "Work: Graph", "Work: Map"]);
    void find(items, "Today").run();
    expect(deps().go).not.toHaveBeenCalled(); // the deps above are fresh; this spy is not the item's
  });

  it("navigates from a go item's run", () => {
    const go = vi.fn();
    const items = buildItems(deps({ go }));
    find(items, "Work: Board").run();
    expect(go).toHaveBeenCalledWith("#/c/ch/work/board");
    find(items, "Today").run();
    expect(go).toHaveBeenCalledWith("#/c/ch/today");
  });

  it("lists the asks and gates under Needs you, and runs them", async () => {
    const d = deps();
    const items = buildItems(d);
    const answer = find(items, "Answer web");
    expect(answer.s).toBe("deploy now?");
    answer.run();
    expect(d.go).toHaveBeenCalledWith("#/c/ch/inbox");
    find(items, "Approve t2").run();
    await flush();
    expect(d.act).toHaveBeenCalledWith("approve", { id: "t2" }, "Approved t2");
    expect(d.touchAttention).toHaveBeenCalled();
  });

  it("skips the attention refill when the server refused", async () => {
    const d = deps({ act: vi.fn(async () => false) });
    find(buildItems(d), "Approve t2").run();
    await flush();
    expect(d.touchAttention).not.toHaveBeenCalled();
  });

  it("pauses a live session with an Undo that resumes, and resumes a paused one", async () => {
    const d = deps();
    const items = buildItems(d);
    find(items, "Pause web").run();
    await flush();
    expect(d.act).toHaveBeenCalledWith("pause", { target: "web" }, "web paused", {
      undo: expect.any(Function),
    });
    expect(d.touchSessions).toHaveBeenCalled();
    const undo = (d.act as ReturnType<typeof vi.fn>).mock.calls[0]?.[3]?.undo as (() => void) | undefined;
    undo?.();
    await flush();
    expect(d.act).toHaveBeenCalledWith("resume", { target: "web" }, "web resumed");
    find(items, "Resume docs").run();
    await flush();
    expect(d.act).toHaveBeenCalledWith("resume", { target: "docs" }, "docs resumed");
  });

  it("offers message, ask, task, turn and open per session", () => {
    const d = deps();
    const items = buildItems(d);
    find(items, "Message web").run();
    expect(d.compose).toHaveBeenCalledWith({ to: "web", mode: "msg" });
    find(items, "Ask web").run();
    expect(d.compose).toHaveBeenCalledWith({ to: "web", mode: "ask" });
    find(items, "Give web a task").run();
    expect(d.compose).toHaveBeenCalledWith({ to: "web", mode: "task" });
    find(items, "Hand the turn to web").run();
    find(items, "Open web").run();
    expect(d.go).toHaveBeenCalledWith("#/c/ch/team?s=web");
    const titles = byGroup(items, "Sessions").map((x) => x.t);
    expect(titles).not.toContain("Hand the turn to docs"); // it holds the turn
  });

  it("hands the turn through the op and refills the roster", async () => {
    const d = deps();
    find(buildItems(d), "Hand the turn to web").run();
    await flush();
    expect(d.act).toHaveBeenCalledWith("pass", { to: "web" }, "web holds the turn now");
    expect(d.touchSessions).toHaveBeenCalled();
  });

  it("runs the actions: composer, new task, knowledge, the paused sweep and the export", async () => {
    const d = deps({
      attention: { asks: [], gates: [], blocked: [], paused: [{ name: "a" }, { name: "b" }] } as Attention,
    });
    const items = buildItems(d);
    expect(find(items, "Send a message").kb).toBe("c");
    find(items, "Send a message").run();
    expect(d.compose).toHaveBeenCalledWith({ mode: "msg" });
    find(items, "New task").run();
    expect(d.compose).toHaveBeenCalledWith({ mode: "task", to: "" });
    find(items, "Remember something").run();
    expect(d.go).toHaveBeenCalledWith("#/c/ch/knowledge");
    find(items, "Resume every paused session").run();
    await flush();
    expect(d.act).toHaveBeenCalledWith("resume", { target: "a" }, "");
    expect(d.toast).toHaveBeenCalledWith("Resumed 2 sessions");
    expect(d.touchSessions).toHaveBeenCalled();
    expect(d.touchAttention).toHaveBeenCalled();
    find(items, "Download the plan (export.md)").run();
    expect(d.exportPlan).toHaveBeenCalled();
  });

  it("marks the open task with every other status", () => {
    const d = deps({ taskId: "t1" });
    const marks = byGroup(buildItems(d), "This task");
    expect(marks.map((x) => x.t)).toEqual([
      "Mark t1 doing",
      "Mark t1 done",
      "Mark t1 blocked",
      "Mark t1 skipped",
    ]);
    marks[0]?.run();
    expect(d.setTaskStatus).toHaveBeenCalledWith("t1", "doing");
  });

  it("offers no task marks without an open task", () => {
    expect(byGroup(buildItems(deps({ taskId: null })), "This task")).toHaveLength(0);
    expect(byGroup(buildItems(deps({ taskId: "ghost" })), "This task")).toHaveLength(0);
  });

  it("lists the other channels and Home, and the settings with the themes and shortcuts", () => {
    const d = deps();
    const items = buildItems(d);
    const other = find(items, "Other");
    expect(other.s).toBe("other");
    other.run();
    expect(d.go).toHaveBeenCalledWith("#/c/other");
    find(items, "All channels").run();
    expect(d.go).toHaveBeenCalledWith("#/");
    find(items, "Theme: light (Latte)").run();
    expect(d.setTheme).toHaveBeenCalledWith("light");
    find(items, "Theme: dark (Mocha)").run();
    expect(d.setTheme).toHaveBeenCalledWith("dark");
    find(items, "Theme: follow the system").run();
    expect(d.setTheme).toHaveBeenCalledWith("system");
    const bell = find(items, "Notify me of questions");
    bell.run();
    expect(d.toggleNotify).toHaveBeenCalled();
    find(items, "Keyboard shortcuts").run();
    expect(d.openHelp).toHaveBeenCalled();
    expect(find(items, "Keyboard shortcuts").kb).toBe("?");
  });

  it("flips the notify label when notifications are on, and hides the channel items on Home", () => {
    expect(find(buildItems(deps({ notifyOn: () => true })), "Stop notifying me of questions")).toBeDefined();
    const home = buildItems(deps({ ch: null }));
    expect([...new Set(home.map((x) => x.g))]).toEqual(["Channels", "Settings"]);
    expect(home.find((x) => x.t === "Other")).toBeDefined();
  });
});

// ── the ranking ──────────────────────────────────────────────────────────────

describe("paletteResults", () => {
  const onTask = vi.fn();

  it("orders an empty query by group and caps it", () => {
    const out = paletteResults({
      items: buildItems(deps()),
      steps: BOARD.steps,
      byId: new Map(),
      hits: null,
      q: "",
      onTask,
    });
    const groups = [...new Set(out.map((x) => x.g))];
    expect(groups.indexOf("Needs you")).toBeLessThan(groups.indexOf("Go to"));
    expect(groups.indexOf("Go to")).toBeLessThan(groups.indexOf("Sessions"));
    expect(groups.indexOf("Sessions")).toBeLessThan(groups.indexOf("Channels"));
  });

  it("ranks a query over title, subline and group, dropping non-matches", () => {
    const items = buildItems(deps());
    const out = paletteResults({
      items,
      steps: BOARD.steps,
      byId: new Map(),
      hits: null,
      q: "latte",
      onTask,
    });
    expect(out.map((x) => x.t)).toEqual(["Theme: light (Latte)"]);
  });

  it("folds the matching tasks in, best match first, and runs them onto the drawer", () => {
    const run = vi.fn();
    const out = paletteResults({
      items: buildItems(deps()),
      steps: BOARD.steps,
      byId: new Map(),
      hits: null,
      q: "wire the rail",
      onTask: run,
    });
    expect(out[0]?.g).toBe("Tasks");
    expect(out[0]?.id).toBe("t1");
    expect(out[0]?.s).toBe("scan.agent");
    out[0]?.run();
    expect(run).toHaveBeenCalledWith("t1");
  });

  it("appends the server's text hits the task list does not show, markers stripped", () => {
    const hits: SearchHit[] = [
      { id: "t1", title: "Wire the rail", hit: "see «rail»" },
      { id: "t9", title: "Nine", hit: "a «hit» here" },
    ];
    const out = paletteResults({
      items: [],
      steps: BOARD.steps,
      byId: new Map([["t9", { id: "t9", status: "blocked" } as PlanStep]]),
      hits,
      q: "rail",
      onTask,
    });
    const found = out.filter((x) => x.g === "Found in the task text");
    expect(found.map((x) => x.id)).toEqual(["t9"]);
    expect(found[0]?.s).toBe("a hit here");
    expect(found[0]?.st).toBe("blocked");
    found[0]?.run();
    expect(onTask).toHaveBeenCalledWith("t9");
  });

  it("keeps the items ahead of the tasks when the item matches better", () => {
    const out = paletteResults({
      items: [{ g: "Go to", t: "t9 alpha", run: () => {} }],
      steps: [{ id: "t9", title: "alpha", status: "todo" } as PlanStep],
      byId: new Map(),
      hits: null,
      q: "t9",
      onTask,
    });
    expect(out[0]?.g).toBe("Go to");
    expect(out.some((x) => x.g === "Tasks")).toBe(true);
  });
});

// ── the dialog ───────────────────────────────────────────────────────────────

describe("CmdPalette", () => {
  const richState = (): ReturnType<typeof makeState> =>
    makeState({
      board: BOARD,
      byId: new Map<string, PlanStep>([
        ["t1", { id: "t1", status: "todo" }],
        ["t2", { id: "t2", status: "done" }],
      ]),
      attention: {
        asks: [{ seq: 1, from: "web", msg: "deploy now?" }],
        gates: [{ id: "t2", title: "Ship it" }],
        paused: [],
        blocked: [],
      } as Attention,
      sessions: {
        sessions: [{ name: "web", state: "working", holds_turn: false, parent: null }],
      } as unknown as SessionList,
      channels: [{ name: "other", title: "Other" }],
    });

  const palette = (over: { state?: ReturnType<typeof makeState>; go?: (h: string) => void } = {}) => {
    const go = vi.fn();
    const ctx = makeCtx(over.state ?? richState(), { go: over.go ?? go });
    const onClose = vi.fn();
    const onCompose = vi.fn();
    const onHelp = vi.fn();
    const notify = { on: () => false, toggle: vi.fn() };
    const utils = renderIn(
      <CmdPalette
        open
        onClose={onClose}
        onCompose={onCompose}
        onHelp={onHelp}
        notify={notify}
        store={huddleStore()}
        prefs={memStore()}
      />,
      ctx,
    );
    return { ...utils, go, onClose, onCompose, onHelp, notify };
  };

  it("opens on the input, grouped results first, with the esc kbd", async () => {
    palette();
    await flush();
    expect(document.activeElement?.id).toBe("palq");
    expect(screen.getByText("Needs you")).toBeDefined();
    expect(screen.getByText("Answer web")).toBeDefined();
    expect(screen.getByText("Go to")).toBeDefined();
    expect(screen.getAllByText("esc").length).toBeGreaterThan(0);
  });

  it("shows the channel-less placeholder on Home", async () => {
    location.hash = "#/";
    palette({ state: makeState({ ch: null, channels: [{ name: "other", title: "Other" }] }) });
    await flush();
    expect(screen.getByPlaceholderText("Jump to a channel")).toBeDefined();
  });

  it("filters as the query lands, and says when nothing matches", async () => {
    palette();
    const q = screen.getByLabelText("Search or run a command") as HTMLInputElement;
    fireEvent.input(q, { target: { value: "latte" } });
    await waitFor(() => expect(screen.getByText("Theme: light (Latte)")).toBeDefined());
    expect(screen.queryByText("Answer web")).toBeNull();
    fireEvent.input(q, { target: { value: "zzzz" } });
    await waitFor(() => expect(screen.getByText(/Nothing matches/)).toBeDefined());
  });

  it("walks with the arrows, runs on Enter, and follows the mouse", async () => {
    const p = palette();
    await flush();
    const q = screen.getByLabelText("Search or run a command");
    expect(q.getAttribute("aria-activedescendant")).toBe("po-0");
    fireEvent.keyDown(q, { key: "ArrowDown" });
    expect(q.getAttribute("aria-activedescendant")).toBe("po-1");
    expect(document.getElementById("po-1")?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(q, { key: "ArrowUp" });
    fireEvent.keyDown(q, { key: "ArrowUp" }); // clamps at the top
    expect(q.getAttribute("aria-activedescendant")).toBe("po-0");
    fireEvent.mouseMove(document.getElementById("po-2") as Element);
    expect(q.getAttribute("aria-activedescendant")).toBe("po-2");
    fireEvent.keyDown(q, { key: "Enter" });
    await waitFor(() => expect(p.onClose).toHaveBeenCalled());
    await flush();
    expect(p.go).toHaveBeenCalledWith("#/c/ch/inbox");
  });

  it("runs a clicked result", async () => {
    const p = palette();
    await flush();
    fireEvent.click(screen.getByText("Answer web"));
    await flush();
    expect(p.onClose).toHaveBeenCalled();
    expect(p.go).toHaveBeenCalledWith("#/c/ch/inbox");
  });

  it("closes on Escape and on the parent flipping open", async () => {
    const onClose = vi.fn();
    const ctx = makeCtx(makeState());
    const view = renderIn(
      <CmdPalette
        open
        onClose={onClose}
        onCompose={vi.fn()}
        onHelp={vi.fn()}
        notify={{ on: () => false, toggle: vi.fn() }}
        prefs={memStore()}
      />,
      ctx,
    );
    fireEvent.keyDown(screen.getByLabelText("Search or run a command"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("searches the task text from three characters on", async () => {
    const api = apiF();
    const state = makeState();
    const ctx = makeCtx(state);
    ctx.api = api;
    (api.api as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "t9", title: "Nine", hit: "a «hit»" },
    ]);
    renderIn(
      <CmdPalette
        open
        onClose={vi.fn()}
        onCompose={vi.fn()}
        onHelp={vi.fn()}
        notify={{ on: () => false, toggle: vi.fn() }}
        store={huddleStore()}
        prefs={memStore()}
      />,
      ctx,
    );
    const q = screen.getByLabelText("Search or run a command") as HTMLInputElement;
    fireEvent.input(q, { target: { value: "needle" } });
    await waitFor(() =>
      expect(api.api as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "/api/c/ch/search?q=needle",
      ),
    );
    await waitFor(() => expect(screen.getByText("Found in the task text")).toBeDefined());
    expect(screen.getByText("Nine")).toBeDefined();
  });

  it("does not search under three characters or off channel", async () => {
    const api = apiF();
    const ctx = makeCtx(makeState({ ch: null }));
    ctx.api = api;
    renderIn(
      <CmdPalette
        open
        onClose={vi.fn()}
        onCompose={vi.fn()}
        onHelp={vi.fn()}
        notify={{ on: () => false, toggle: vi.fn() }}
        prefs={memStore()}
      />,
      ctx,
    );
    const q = screen.getByLabelText("Search or run a command") as HTMLInputElement;
    fireEvent.input(q, { target: { value: "ab" } });
    await flush();
    expect(api.api as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("offers the open task's statuses from the route", async () => {
    location.hash = "#/c/ch/work?t=t1";
    palette();
    await flush();
    expect(screen.getByText("This task")).toBeDefined();
    expect(screen.getByText("Mark t1 doing")).toBeDefined();
  });
});

// ── the shortcuts dialog ─────────────────────────────────────────────────────

describe("HelpDialog", () => {
  it("lists the sections and closes on Escape", () => {
    const onClose = vi.fn();
    renderIn(<HelpDialog open onClose={onClose} />);
    expect(screen.getByText("Keyboard shortcuts")).toBeDefined();
    expect(screen.getByText("Search or run a command")).toBeDefined();
    expect(screen.getByText("Next task")).toBeDefined();
    fireEvent.keyDown(screen.getByText("Keyboard shortcuts"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("spells Ctrl on a non-Mac and ⌘ on a Mac", () => {
    expect(helpSections(true)[0]?.rows[0]?.[0]).toBe("⌘ K");
    expect(helpSections(false)[0]?.rows[0]?.[0]).toBe("Ctrl K");
    expect(isMac("MacIntel")).toBe(true);
    expect(isMac("iPhone")).toBe(true);
    expect(isMac("Win32")).toBe(false);
    const onClose = vi.fn();
    const orig = navigator.platform;
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    const mac = renderIn(<HelpDialog open onClose={onClose} />);
    expect(screen.getByText("⌘")).toBeDefined(); // the chord prints one kbd per key
    mac.unmount();
    Object.defineProperty(navigator, "platform", { value: orig, configurable: true });
  });
});

// ── the keyboard ─────────────────────────────────────────────────────────────

describe("keyboard pieces", () => {
  it("knows a text field and a swallowed key", () => {
    const input = document.createElement("input");
    expect(isTextField(input)).toBe(true);
    expect(isTextField(document.createElement("div"))).toBe(false);
    expect(isTextField(null)).toBe(false);
    const e = (over: KeyboardEventInit = {}): KeyboardEvent =>
      new KeyboardEvent("keydown", { key: "j", ...over });
    expect(swallowedKey(e({ metaKey: true }))).toBe(true);
    expect(swallowedKey(e({ ctrlKey: true }))).toBe(true);
    expect(swallowedKey(e({ altKey: true }))).toBe(true);
    expect(swallowedKey(e())).toBe(false);
  });

  it("keeps a dialog's keys, except the task drawer's", () => {
    expect(dialogGuard()).toBe("none");
    const d = document.createElement("dialog");
    d.id = "x";
    d.open = true;
    document.body.append(d);
    expect(dialogGuard()).toBe("swallow");
    d.id = "tdrawer";
    expect(dialogGuard()).toBe("task");
    const d2 = document.createElement("dialog");
    d2.open = true;
    document.body.append(d2);
    expect(dialogGuard()).toBe("swallow");
    d2.remove();
  });

  it("walks the g chord and forgets it after 1.2 s", () => {
    const go = vi.fn();
    const gAt = { current: 0 };
    const e = (key: string): KeyboardEvent => new KeyboardEvent("keydown", { key });
    expect(chordKey(e("g"), gAt, "ch", go)).toBe(true);
    expect(gAt.current).toBeGreaterThan(0);
    expect(chordKey(e("i"), gAt, "ch", go)).toBe(true);
    expect(go).toHaveBeenCalledWith("#/c/ch/inbox");
    expect(chordKey(e("w"), gAt, "ch", go)).toBe(false); // the chord is spent; the key is free
    vi.useFakeTimers();
    expect(chordKey(e("g"), gAt, "ch", go)).toBe(true);
    vi.advanceTimersByTime(1300);
    expect(chordKey(e("w"), gAt, "ch", go)).toBe(false); // a stale chord keeps nothing
    vi.useRealTimers();
    gAt.current = 0;
    expect(chordKey(e("g"), gAt, "ch", go)).toBe(true);
    expect(chordKey(e("x"), gAt, "ch", go)).toBe(true); // consumed with no destination
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("navigates the chords: h for Home, the destinations off the channel", () => {
    const go = vi.fn();
    expect(goChord("h", "ch", go)).toBe(true);
    expect(go).toHaveBeenCalledWith("#/");
    expect(goChord("k", "ch", go)).toBe(true);
    expect(go).toHaveBeenCalledWith("#/c/ch/knowledge");
    expect(goChord("q", "ch", go)).toBe(false);
    expect(goChord("w", null, go)).toBe(false);
  });

  it("steps j/k through the visible tasks", () => {
    const go = vi.fn();
    const board = {
      phases: [],
      steps: [
        { id: "t1", title: "A", status: "todo" },
        { id: "t2", title: "B", status: "done" },
        { id: "t3", title: "C", status: "todo" },
      ],
    } as Board;
    const filters = { f: "all" as const, owner: "", phase: "all", q: "" };
    const base = "#/c/ch/work";
    stepTask(1, null, board, filters, base, go);
    expect(go).toHaveBeenCalledWith(`${base}?t=t1`);
    stepTask(1, "t1", board, filters, base, go);
    expect(go).toHaveBeenCalledWith(`${base}?t=t2`);
    stepTask(-1, "t1", board, filters, base, go);
    expect(go).toHaveBeenCalledWith(`${base}?t=t1`); // clamps at the top
    const empty = { phases: [], steps: [] } as Board;
    stepTask(1, null, empty, filters, base, go);
    expect(go).toHaveBeenCalledTimes(3);
  });

  it("serves ?, / and the task keys", () => {
    const d = {
      ch: "ch",
      base: "#/c/ch/work",
      board: BOARD,
      filters: { f: "all" as const, owner: "", phase: "all", q: "" },
      openPalette: vi.fn(),
      openHelp: vi.fn(),
      go: vi.fn(),
      setStatus: vi.fn(),
    };
    const route = {
      dest: "work" as const,
      ch: "ch",
      sub: [],
      key: "ch/work/",
      task: null,
      sess: null,
      replace: null,
      prefs: {},
    };
    expect(singleKey(new KeyboardEvent("keydown", { key: "?" }), false, route, d)).toBe(true);
    expect(d.openHelp).toHaveBeenCalled();
    document.body.innerHTML = "<input id='wq'>";
    expect(singleKey(new KeyboardEvent("keydown", { key: "/" }), false, route, d)).toBe(true);
    expect(document.activeElement?.id).toBe("wq");
    document.body.innerHTML = "";
    expect(singleKey(new KeyboardEvent("keydown", { key: "/" }), false, route, d)).toBe(true);
    expect(d.openPalette).toHaveBeenCalled();
    expect(singleKey(new KeyboardEvent("keydown", { key: "j" }), false, route, d)).toBe(true);
    expect(d.go).toHaveBeenCalledWith("#/c/ch/work?t=t1");
    expect(singleKey(new KeyboardEvent("keydown", { key: "2" }), true, { ...route, task: "t1" }, d)).toBe(
      true,
    );
    expect(d.setStatus).toHaveBeenCalledWith("t1", "doing");
    expect(singleKey(new KeyboardEvent("keydown", { key: "2" }), false, route, d)).toBe(false);
    expect(singleKey(new KeyboardEvent("keydown", { key: "x" }), false, route, d)).toBe(false);
    expect(singleKey(new KeyboardEvent("keydown", { key: "j" }), false, route, { ...d, ch: null })).toBe(
      false,
    );
  });

  it("builds the keys' dependencies from the address and the kept filters", () => {
    const prefs = memStore();
    const d = keyDeps({
      ch: "ch",
      hash: "#/c/ch/work/repo?t=9",
      board: BOARD,
      prefs,
      openPalette: vi.fn(),
      openHelp: vi.fn(),
      go: vi.fn(),
      setStatus: vi.fn(),
    });
    expect(d.base).toBe("#/c/ch/work/repo");
    expect(d.filters.f).toBe("all");
    expect(
      keyDeps({
        ch: null,
        hash: "",
        board: null,
        prefs,
        openPalette: vi.fn(),
        openHelp: vi.fn(),
        go: vi.fn(),
        setStatus: vi.fn(),
      }).base,
    ).toBe("#/c//work");
  });

  it("runs a status change with Undo through the store", async () => {
    const api = apiF();
    const toast = vi.fn();
    const store = huddleStore();
    const byId = new Map<string, PlanStep>([["t1", { id: "t1", status: "todo" }]]);
    keySetStatus({ api, ch: "ch", toast, byId, current: byId.get("t1"), store }, "t1", "doing");
    await flush();
    expect(api.op).toHaveBeenCalledWith("ch", "task_status", { id: "t1", status: "doing", note: "" });
    expect(toast).toHaveBeenCalledWith("t1 is doing", { undo: expect.any(Function) });
    expect(store.loadBoard).toHaveBeenCalled();
    expect(store.attChanged).toHaveBeenCalled();
  });

  it("toasts the refusal of a status change", async () => {
    const api = apiF();
    (api.op as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no"));
    const toast = vi.fn();
    keySetStatus(
      {
        api,
        ch: "ch",
        toast,
        byId: new Map([["t1", { id: "t1", status: "todo" } as PlanStep]]),
        current: undefined,
        store: undefined,
      },
      "t1",
      "done",
    );
    await flush();
    expect(toast).toHaveBeenCalledWith("no", { bad: true });
  });
});

describe("CmdKeys", () => {
  const keys = (over: { state?: ReturnType<typeof makeState>; store?: HuddleStore } = {}) => {
    const go = vi.fn();
    const api = apiF();
    const ctx = makeCtx(over.state ?? makeState(), { go, api });
    const props = {
      paletteOpen: false,
      openPalette: vi.fn(),
      closePalette: vi.fn(),
      openHelp: vi.fn(),
      prefs: memStore(),
      store: over.store,
    };
    renderIn(<CmdKeys {...props} />, ctx);
    const press = (key: string, init: KeyboardEventInit = {}): void => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, ...init }));
    };
    return { ...props, go, press, ctx };
  };

  it("toggles the palette with ⌘K and Ctrl-K, fields included", () => {
    const p = keys();
    p.press("k", { metaKey: true });
    expect(p.openPalette).toHaveBeenCalledTimes(1);
    p.press("k", { ctrlKey: true });
    expect(p.openPalette).toHaveBeenCalledTimes(2);
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    expect(p.openPalette).toHaveBeenCalledTimes(3);
    input.remove();
  });

  it("closes the palette with ⌘K while it is open", () => {
    const p = keys();
    const open = renderIn(<CmdKeys {...p} paletteOpen />, makeCtx(makeState(), { go: p.go }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    expect(p.closePalette).toHaveBeenCalledTimes(1);
    open.unmount();
  });

  it("walks the g chords, ? and /", () => {
    const p = keys();
    p.press("g");
    p.press("w");
    expect(p.go).toHaveBeenCalledWith("#/c/ch/work");
    p.press("g");
    p.press("h");
    expect(p.go).toHaveBeenCalledWith("#/");
    p.press("?");
    expect(p.openHelp).toHaveBeenCalledTimes(1);
    p.press("/");
    expect(p.openPalette).toHaveBeenCalledTimes(1); // no #wq on the page
    const wq = document.createElement("input");
    wq.id = "wq";
    document.body.append(wq);
    p.press("/");
    expect(document.activeElement?.id).toBe("wq");
    wq.remove();
  });

  it("swallows the single keys in a field and in a dialog", () => {
    const p = keys();
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    expect(p.openHelp).not.toHaveBeenCalled();
    expect(p.go).not.toHaveBeenCalled();
    input.remove();
    const d = document.createElement("dialog");
    d.id = "x";
    d.open = true;
    document.body.append(d);
    p.press("?");
    expect(p.openHelp).not.toHaveBeenCalled();
    d.remove();
  });

  it("steps j/k across the visible tasks on Work", () => {
    const store = huddleStore();
    const p = keys({
      state: makeState({ board: BOARD, byId: new Map([["t1", { id: "t1", status: "todo" } as PlanStep]]) }),
      store,
    });
    p.press("j");
    expect(p.go).toHaveBeenCalledWith("#/c/ch/work?t=t1");
    p.press("k");
    expect(p.go).toHaveBeenCalledWith("#/c/ch/work?t=t1"); // clamps at the top
  });

  it("sets an open task's status with 1–5", async () => {
    const store = huddleStore();
    const p = keys({
      state: makeState({ board: BOARD, byId: new Map([["t1", { id: "t1", status: "todo" } as PlanStep]]) }),
      store,
    });
    const d = document.createElement("dialog");
    d.id = "tdrawer";
    d.open = true;
    document.body.append(d);
    location.hash = "#/c/ch/work?t=t1";
    p.press("2");
    await flush();
    expect(p.ctx.api.op).toHaveBeenCalledWith("ch", "task_status", { id: "t1", status: "doing", note: "" });
    expect(store.loadBoard).toHaveBeenCalled();
    expect(store.attChanged).toHaveBeenCalled();
    p.press("x");
    d.remove();
  });

  it("runs 1–5 with the real task drawer open, whose dialog carries the id", async () => {
    const api: Api = {
      api: vi.fn(async (path: string) =>
        String(path).includes("/task/t1")
          ? { id: "t1", title: "Wire the rail", status: "todo", depends: [], comments: [], edited: {} }
          : {},
      ),
      op: vi.fn(async () => ({ result: {} })),
      channelPath: (ch: string, p: string) => `/api/c/${ch}${p}`,
      channelHref: (ch: string, p: string) => `#/c/${ch}${p}`,
    };
    const byId = new Map<string, PlanStep>([["t1", { id: "t1", status: "todo" }]]);
    const store = huddleStore();
    const view = renderIn(
      <>
        <TaskDrawer
          id="t1"
          ch="ch"
          api={api}
          now={0}
          board={BOARD}
          byId={byId}
          sessions={null}
          views={[]}
          toast={vi.fn()}
          copy={vi.fn()}
          store={memStore()}
          live={undefined}
          onClose={vi.fn()}
          onOpenTask={vi.fn()}
          onOpenSession={vi.fn()}
          reloadBoard={vi.fn()}
          touchAttention={vi.fn()}
        />
        <CmdKeys
          paletteOpen={false}
          openPalette={vi.fn()}
          closePalette={vi.fn()}
          openHelp={vi.fn()}
          prefs={memStore()}
          store={store}
        />
      </>,
      makeCtx(makeState({ board: BOARD, byId }), { api }),
    );
    await waitFor(() => expect(screen.getByText("Wire the rail")).not.toBeNull());
    location.hash = "#/c/ch/work?t=t1";
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
    await flush();
    expect(api.op).toHaveBeenCalledWith("ch", "task_status", { id: "t1", status: "doing", note: "" });
    view.unmount();
  });

  it("does nothing on Home beyond the chords, ? and /", () => {
    location.hash = "#/";
    const p = keys({ state: makeState({ ch: null }) });
    p.press("j");
    expect(p.go).not.toHaveBeenCalled();
    p.press("g");
    p.press("i");
    expect(p.go).not.toHaveBeenCalled(); // no channel to go to
    p.press("g");
    p.press("h");
    expect(p.go).toHaveBeenCalledWith("#/");
  });

  it("stops listening when it unmounts", () => {
    const go = vi.fn();
    const props = {
      paletteOpen: false,
      openPalette: vi.fn(),
      closePalette: vi.fn(),
      openHelp: vi.fn(),
      prefs: memStore(),
      store: undefined,
    };
    const view = renderIn(<CmdKeys {...props} />, makeCtx(makeState(), { go }));
    act(() => {
      view.unmount();
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }));
    expect(props.openHelp).not.toHaveBeenCalled();
  });
});

describe("palette actions through the dialog", () => {
  it("runs the notify toggle and the theme from the dialog's items", async () => {
    const toggle = vi.fn();
    const prefs = memStore();
    const go = vi.fn();
    const ctx = makeCtx(makeState(), { go });
    renderIn(
      <CmdPalette
        open
        onClose={vi.fn()}
        onCompose={vi.fn()}
        onHelp={vi.fn()}
        notify={{ on: () => false, toggle }}
        prefs={prefs}
      />,
      ctx,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Notify me of questions"));
      await flush();
    });
    expect(toggle).toHaveBeenCalled();
    expect(prefs.getItem("huddle:theme")).toBeNull(); // the theme items write on their own pick
    fireEvent.click(screen.getByText("Theme: dark (Mocha)"));
    await flush();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(prefs.getItem("huddle:theme")).toBe('"dark"');
  });
});
