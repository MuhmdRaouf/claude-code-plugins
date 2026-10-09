// TaskDrawer.test.tsx — the task drawer: the fetch and its miss, the head's stepping and close,
// Escape (and an open edit's claim on it), the status change through setTaskStatus, the owner and
// dependency updates, the section editor and its JSON guard, the notes, the gate's approval, the
// verify ticks, the snippet tabs with their drift, and the file excerpt dialog.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { Api } from "../../src/api.ts";
import { readPref, type Storage, writePref } from "../../src/storage.ts";
import type { Board, HuddleStore, PlanStep, SessionList } from "../../src/store.ts";
import { type TaskDetail, TaskDrawer, type TaskDrawerProps, writeTick } from "../../src/work/TaskDrawer.tsx";

const NOW = Date.parse("2026-10-08T12:00:00Z");

/** The value the test needs, or a loud failure — the tests carry no non-null assertions. */
function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("the test could not find what it needs");
  return x;
}

/** Site storage over a map, empty for every test. */
const memStorage = (): Storage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

/** One board step with the fields the tests name. */
const step = (id: string, over: Partial<PlanStep> = {}): PlanStep => ({
  id,
  title: `Task ${id}`,
  status: "todo",
  ...over,
});

const boardOf = (steps: PlanStep[]): Board => ({ phases: [{ n: 1, title: "One" }], steps }) as Board;

/** The task detail GET /task/<id> answers with. */
const detail = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  id: "t1",
  title: "Ship the thing",
  status: "todo",
  what: "It is a thing",
  value: "It ships",
  depends: [],
  comments: [],
  edited: {},
  ...over,
});

/** The GET routes a test hands out; anything else is a loud miss. */
const apiF = (routes: Record<string, unknown> = {}): Api => {
  const api: Api = {
    api: vi.fn(async (path: string) => {
      const hit = Object.entries(routes).find(([k]) => path.includes(k));
      if (!hit) throw new Error(`unexpected GET ${path}`);
      if (hit[1] instanceof Error) throw hit[1];
      return hit[1];
    }),
    op: vi.fn(async () => ({ result: {} })),
    channelPath: (ch: string, p: string) => `/api/c/${ch}${p}`,
    channelHref: (ch: string, p: string) => `#/c/${ch}${p}`,
  };
  return api;
};

/** happy-dom delivers hand-made change events here; fireEvent's do not reach these nodes. */
const changeTo = (el: HTMLSelectElement, value: string): void => {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
};

type Base = TaskDrawerProps;

/** The drawer's props over one small plan, with spies the test asserts on. */
const props = (over: Partial<Base> = {}): TaskDrawerProps => {
  const steps = [step("t1"), step("t2", { status: "doing" }), step("t3")];
  const base: Base = {
    id: "t1",
    ch: "ch",
    api: apiF({ "/task/t1": detail(), "/repo/drift": { rows: [] } }),
    now: NOW,
    board: boardOf(steps),
    byId: new Map(steps.map((s) => [s.id, s])),
    sessions: null,
    views: [],
    toast: vi.fn(),
    copy: vi.fn(),
    store: memStorage(),
    live: undefined,
    onClose: vi.fn(),
    onOpenTask: vi.fn(),
    onOpenSession: vi.fn(),
    reloadBoard: vi.fn(),
    touchAttention: vi.fn(),
  };
  return { ...base, ...over };
};

const drawer = (over: Partial<Base> = {}) => render(<TaskDrawer {...props(over)} />);

const GET = (p: Api): Mock => p.api as unknown as Mock;
const OP = (p: Api): Mock => p.op as unknown as Mock;

beforeEach(() => {
  localStorage.clear();
});

describe("TaskDrawer mount", () => {
  it("renders nothing without an id or a channel", () => {
    expect(drawer({ id: null }).container.textContent).toBe("");
    expect(drawer({ ch: null }).container.textContent).toBe("");
  });

  it("shows the skeleton, then the task with its filled sections", async () => {
    const p = props();
    drawer(p);
    expect(document.querySelector(".skeleton")).not.toBeNull();
    await waitFor(() => expect(screen.getByText("Ship the thing")).not.toBeNull());
    expect(document.querySelector('[data-sec="what"]')).not.toBeNull();
    // the empty sections stay out, and "Add section" offers them
    expect(document.querySelector('[data-sec="rollback"]')).toBeNull();
    fireEvent.click(screen.getByText("Add section"));
    await waitFor(() => expect(screen.getByText("How to use it")).not.toBeNull());
    expect(GET(p.api)).toHaveBeenCalledWith("/api/c/ch/task/t1");
  });

  it("says so when the task is gone", async () => {
    drawer({ api: apiF({ "/task/t1": new Error("no such task") }) });
    await waitFor(() => expect(screen.getByText("No task t1")).not.toBeNull());
  });

  it("opens its dialog as #tdrawer, the id the keyboard layer's guard knows", async () => {
    drawer(props());
    await waitFor(() => expect(screen.getByText("Ship the thing")).not.toBeNull());
    const dlgs = document.querySelectorAll("dialog[open]");
    expect(dlgs.length).toBe(1);
    expect(dlgs[0]?.id).toBe("tdrawer");
  });

  it("steps through the plan and closes from the head", async () => {
    const onOpenTask = vi.fn();
    const onClose = vi.fn();
    drawer({ onOpenTask, onClose });
    await waitFor(() => expect(screen.getByText("1 of 3 in the plan")).not.toBeNull());
    // t1 is the plan's first step: its previous button is out
    expect((must(screen.getByLabelText("Previous task")) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(must(screen.getByLabelText("Next task: t2")));
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask).toHaveBeenCalledWith("t2");
    // the slide-over's own X (the backdrop's accessible close shares the label)
    fireEvent.click(must(document.querySelector("[data-slide-over] [aria-label='Close']")));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape, and an open edit takes the Escape first", async () => {
    const onClose = vi.fn();
    drawer({ onClose });
    await waitFor(() => expect(screen.getByText("Ship the thing")).not.toBeNull());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(must(document.querySelector('[data-edit="what"]')));
    expect(document.getElementById("edta")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.getElementById("edta")).toBeNull();
  });

  it("refreshes the open task when the store moves the board", async () => {
    let fire: (what: string, x?: unknown) => void = () => {};
    const live = {
      subscribe: vi.fn((f: (what: string, x?: unknown) => void) => {
        fire = f;
        return () => {};
      }),
    } as unknown as HuddleStore;
    const p = props({ live });
    drawer(p);
    await waitFor(() => expect(GET(p.api)).toHaveBeenCalledTimes(1));
    fire("board");
    await waitFor(() => expect(GET(p.api)).toHaveBeenCalledTimes(2), { timeout: 3000 });
  });
});

describe("TaskDrawer status", () => {
  it("changes the status through setTaskStatus, carrying the evidence note", async () => {
    const toast = vi.fn();
    const p = props({ toast });
    OP(p.api).mockResolvedValue({ result: detail({ status: "done" }) });
    drawer(p);
    await waitFor(() => expect(screen.getByText("Ship the thing")).not.toBeNull());
    const note = must(document.getElementById("stnote")) as HTMLInputElement;
    fireEvent.input(note, { target: { value: "all green" } });
    fireEvent.click(must(document.querySelector('[data-st="done"]')));
    await waitFor(() =>
      expect(OP(p.api)).toHaveBeenCalledWith("ch", "task_status", {
        id: "t1",
        status: "done",
        note: "all green",
      }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith("t1 is done", expect.anything()));
    // the evidence line empties and the drawer refetches its own task
    await waitFor(() => expect((must(document.getElementById("stnote")) as HTMLInputElement).value).toBe(""));
    await waitFor(() => expect(GET(p.api)).toHaveBeenCalledTimes(2));
    expect(p.touchAttention).toHaveBeenCalled();
  });

  it("shows who set the status last, and a waiting pill while it waits", async () => {
    drawer({
      // the payload GET /task/<id> really sends: the unfinished dependencies as `unmet`
      api: apiF({
        "/task/t1": detail({
          status: "todo",
          unmet: [{ id: "t2", owner: "web", status: "doing", title: "Task t2" }],
          status_by: "api",
          status_at: "2026-10-08T11:00:00Z",
          status_note: "waiting on the build",
        }),
      }),
      byId: new Map([
        ["t1", step("t1")],
        ["t2", step("t2", { status: "doing" })],
      ]),
    });
    await waitFor(() => expect(screen.getByText(/by api/)).not.toBeNull());
    expect(screen.getByText("Waiting", { selector: ".badge" })).not.toBeNull();
  });

  it("hands a status refusal to the toast", async () => {
    const toast = vi.fn();
    const p = props({ toast });
    OP(p.api).mockRejectedValue(new Error("t1 waits on t2"));
    drawer(p);
    await waitFor(() => expect(screen.getByText("Ship the thing")).not.toBeNull());
    fireEvent.click(must(document.querySelector('[data-st="doing"]')));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("t1 waits on t2", { bad: true }));
  });
});

describe("TaskDrawer owner and dependencies", () => {
  it("reassigns the owner with Undo", async () => {
    const toast = vi.fn();
    const p = props({
      toast,
      sessions: {
        sessions: [{ name: "api", state: "working", unread: 0, open: 0, holds_turn: false, step: "t1" }],
      } as unknown as SessionList,
    });
    OP(p.api).mockImplementation(async (_ch, _name, args) => ({ result: detail({ owner: args.owner }) }));
    drawer(p);
    await waitFor(() => expect(screen.getByText("api: working")).not.toBeNull());
    changeTo(must(document.getElementById("owner-sel")) as HTMLSelectElement, "api");
    await waitFor(() =>
      expect(OP(p.api)).toHaveBeenCalledWith("ch", "task_update", { id: "t1", owner: "api" }),
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("t1 now belongs to api", { undo: expect.any(Function) }),
    );
  });

  it("labels both dependency directions and updates them through the picker", async () => {
    const onOpenTask = vi.fn();
    const p = props({
      onOpenTask,
      api: apiF({ "/task/t1": detail({ depends: ["t2"], needed_by: ["t3"] }) }),
    });
    OP(p.api).mockImplementation(async (_ch, _name, args) => ({
      result: detail({ depends: args.after, needed_by: ["t3"] }),
    }));
    drawer(p);
    await waitFor(() => expect(screen.getByText("Blocked by")).not.toBeNull());
    expect(screen.getByText("Blocks")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("Remove t2"));
    await waitFor(() => expect(OP(p.api)).toHaveBeenCalledWith("ch", "task_update", { id: "t1", after: [] }));
    await waitFor(() => expect(p.toast).toHaveBeenCalledWith("t1 no longer waits on t2", expect.anything()));
    fireEvent.click(must(document.querySelector("[data-blocks] button")));
    expect(onOpenTask).toHaveBeenCalledWith("t3");
  });

  it("explains an unmet wait and tags the details", async () => {
    drawer({
      api: apiF({
        "/task/t1": detail({
          unmet: [{ id: "t2", owner: "api", status: "doing", title: "Task t2" }],
          kind: "feature",
          risk: "low",
          gate: "owner",
        }),
      }),
    });
    await waitFor(() => expect(screen.getByText(/It waits on/)).not.toBeNull());
    expect(screen.getByText(/is woken then/)).not.toBeNull();
    expect(screen.getByText("feature")).not.toBeNull();
    expect(screen.getByText("Needs your approval")).not.toBeNull();
    expect(screen.getByText("low risk")).not.toBeNull();
  });

  it("approves a gated task, with a note when asked", async () => {
    const p = props({ api: apiF({ "/task/t1": detail({ gate: "owner" }) }) });
    OP(p.api).mockResolvedValue({ result: { ok: true } });
    drawer(p);
    await waitFor(() => expect(screen.getByText(/waits for your go-ahead/)).not.toBeNull());
    fireEvent.click(screen.getByText("With a note"));
    const note = must(document.getElementById("gnote")) as HTMLInputElement;
    fireEvent.input(note, { target: { value: "looks good" } });
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() =>
      expect(OP(p.api)).toHaveBeenCalledWith("ch", "approve", { id: "t1", msg: "looks good" }),
    );
    await waitFor(() => expect(p.toast).toHaveBeenCalledWith("Approved t1", undefined));
  });

  it("marks an already-approved gate as approved", async () => {
    drawer({
      api: apiF({
        "/task/t1": detail({
          gate: "owner",
          comments: [{ id: 1, kind: "direction", body: "Approved by the owner: fine" }],
        }),
      }),
    });
    await waitFor(() => expect(screen.getByText("You approved it.")).not.toBeNull());
  });

  it("treats another session's approval the same, the note the server writes for it", async () => {
    drawer({
      api: apiF({
        "/task/t1": detail({
          gate: "owner",
          comments: [{ id: 2, kind: "direction", body: "Approved by orchestrator" }],
        }),
      }),
    });
    await waitFor(() => expect(screen.getByText("You approved it.")).not.toBeNull());
    expect(document.querySelector("[data-approve]")).toBeNull();
  });
});

describe("TaskDrawer sections", () => {
  it("edits a text field and saves it back", async () => {
    const p = props();
    OP(p.api).mockResolvedValue({ result: detail({ what: "rewritten" }) });
    drawer(p);
    await waitFor(() => expect(screen.getByText("Ship the thing")).not.toBeNull());
    fireEvent.click(must(document.querySelector('[data-edit="what"]')));
    const ta = must(document.getElementById("edta")) as HTMLTextAreaElement;
    expect(ta.value).toBe("It is a thing");
    fireEvent.input(ta, { target: { value: "rewritten" } });
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(OP(p.api)).toHaveBeenCalledWith("ch", "task_update", {
        id: "t1",
        field: "what",
        value: "rewritten",
      }),
    );
    await waitFor(() => expect(p.toast).toHaveBeenCalledWith("Saved", {}));
  });

  it("guards a JSON field: the parse error stays under the editor and no op runs", async () => {
    const p = props({
      api: apiF({ "/task/t1": detail({ verify: [{ cmd: "bun test" }] }) }),
    });
    drawer(p);
    await waitFor(() => expect(document.querySelector('[data-sec="verify"]')).not.toBeNull());
    fireEvent.click(must(document.querySelector('[data-edit="verify"]')));
    const ta = must(document.getElementById("edta")) as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "{oops" } });
    fireEvent.click(must(document.getElementById("edsave")));
    await waitFor(() => expect(screen.getByText(/That is not valid JSON:/)).not.toBeNull());
    expect(OP(p.api)).not.toHaveBeenCalled();
  });

  it("restores a field to the plan's text from its edited mark", async () => {
    const p = props({
      api: apiF({
        "/task/t1": detail({ edited: { what: { at: "2026-10-08T10:00:00Z", by: "api" } } }),
      }),
    });
    drawer(p);
    await waitFor(() => expect(screen.getByText(/Edited/)).not.toBeNull());
    fireEvent.click(screen.getByText("Undo edit"));
    await waitFor(() =>
      expect(OP(p.api)).toHaveBeenCalledWith("ch", "task_update", {
        id: "t1",
        field: "what",
        value: null,
      }),
    );
  });

  it("ticks a verify check and keeps it in this browser", async () => {
    const st = memStorage();
    drawer({
      store: st,
      api: apiF({ "/task/t1": detail({ verify: [{ cmd: "bun test", expect: "green" }] }) }),
    });
    await waitFor(() => expect(screen.getByLabelText("Checked: bun test")).not.toBeNull());
    fireEvent.click(screen.getByLabelText("Checked: bun test"));
    expect(readPref<Record<string, boolean>>(st, "ck:ch:t1", {})).toEqual({ "0": true });
    writeTick(st, "ch", "t1", 0, false);
    expect(readPref(st, "ck:ch:t1", {})).toEqual({});
  });

  it("copies a verify command", async () => {
    const copy = vi.fn();
    drawer({
      copy,
      api: apiF({ "/task/t1": detail({ verify: [{ cmd: "bun test" }] }) }),
    });
    await waitFor(() => expect(screen.getByLabelText("Copy the command")).not.toBeNull());
    fireEvent.click(screen.getByLabelText("Copy the command"));
    expect(copy).toHaveBeenCalledWith("bun test", "Copied");
  });

  it("renders alternatives, how steps and refs", async () => {
    drawer({
      api: apiF({
        "/task/t1": detail({
          alternatives: [{ option: "One **way**", why_not: "too slow" }],
          how: ["first `step`", "second"],
          refs: ["RFC 1"],
        }),
      }),
    });
    await waitFor(() => expect(document.querySelector('[data-sec="alternatives"]')).not.toBeNull());
    expect(screen.getByText("way")).not.toBeNull();
    expect(screen.getByText("too slow")).not.toBeNull();
    expect(screen.getByText("first")).not.toBeNull();
    expect(screen.getByText("RFC 1")).not.toBeNull();
  });
});

describe("TaskDrawer snippets and files", () => {
  const snips = [
    { title: "One", lang: "sh", code: "echo one" },
    { title: "Two", code: "echo two" },
  ];

  it("switches snippet tabs and keeps the pick per browser", async () => {
    const st = memStorage();
    const p = props({ store: st, api: apiF({ "/task/t1": detail({ snippets: snips }) }) });
    drawer(p);
    await waitFor(() => expect(screen.getByText("echo one")).not.toBeNull());
    fireEvent.click(screen.getByText("Two"));
    await waitFor(() => expect(screen.getByText("echo two")).not.toBeNull());
    expect(readPref(st, "tab:t1", 0)).toBe(1);
  });

  it("copies the shown snippet", async () => {
    const copy = vi.fn();
    drawer({ copy, api: apiF({ "/task/t1": detail({ snippets: snips }) }) });
    await waitFor(() => expect(screen.getByText("echo one")).not.toBeNull());
    fireEvent.click(must(document.querySelector('[data-copysnip="0"]')));
    expect(copy).toHaveBeenCalledWith("echo one", "Copied the snippet");
  });

  it("wears the drift pill the repo check answered", async () => {
    drawer({
      views: ["drift"],
      api: apiF({
        "/task/t1": detail({ snippets: [must(snips[0])] }),
        "/repo/drift": { rows: [{ step: "t1", i: 0, state: "partial", score: 50 }] },
      }),
    });
    await waitFor(() => expect(screen.getByText("Partly changed")).not.toBeNull());
  });

  it("opens a file excerpt when the channel serves the code view", async () => {
    const p = props({
      views: ["code"],
      api: apiF({
        "/task/t1": detail({ files: ["docs/x.md"] }),
        "/repo/code": { excerpt: "hello\nworld", from: 3, total: 10 },
      }),
    });
    drawer(p);
    await waitFor(() => expect(screen.getByText("docs/x.md")).not.toBeNull());
    fireEvent.click(screen.getByText("docs/x.md"));
    await waitFor(() => expect(screen.getByText(/of 10/)).not.toBeNull());
    expect(screen.getByText("hello")).not.toBeNull();
    // the excerpt's dialog closes from its own header, not from the slide-over's
    fireEvent.click(must(document.querySelector("dialog.dlg[open] [aria-label='Close']")));
    await waitFor(() => expect(document.querySelector("dialog.dlg[open]")).toBeNull());
    expect(document.querySelector("dialog[open]")).not.toBeNull();
  });

  it("says what a folder, a missing file, a binary and a refusal are", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ dir: true }, /That is a folder/],
      [{ missing: true }, /Not in the repo yet/],
      [{ binary: true, size: 3 }, /A binary file \(3 bytes\)/],
      [{ error: "denied" }, /denied/],
    ];
    for (const [answer, text] of cases) {
      const p = props({
        views: ["code"],
        api: apiF({ "/task/t1": detail({ files: ["docs/x.md"] }), "/repo/code": answer }),
      });
      const { unmount } = drawer(p);
      await waitFor(() => expect(screen.getByText("docs/x.md")).not.toBeNull());
      fireEvent.click(screen.getByText("docs/x.md"));
      await waitFor(() => expect(screen.getByText(text)).not.toBeNull());
      unmount();
    }
  });

  it("keeps a file plain when there is no code view, and reports a failed read", async () => {
    const p = props({
      api: apiF({
        "/task/t1": detail({ files: ["docs/x.md"] }),
        "/repo/code": new Error("boom"),
      }),
    });
    drawer(p);
    await waitFor(() => expect(screen.getByText("docs/x.md")).not.toBeNull());
    expect(document.querySelector("[data-file]")).toBeNull();
    const p2 = props({
      views: ["code"],
      api: apiF({
        "/task/t1": detail({ files: ["docs/x.md"] }),
        "/repo/code": new Error("boom"),
      }),
    });
    cleanup();
    drawer(p2);
    await waitFor(() => expect(screen.getByText("docs/x.md")).not.toBeNull());
    fireEvent.click(screen.getByText("docs/x.md"));
    await waitFor(() => expect(screen.getByText("boom")).not.toBeNull());
  });
});

describe("TaskDrawer notes", () => {
  it("adds a note with the picked kind and clears the box", async () => {
    const p = props();
    OP(p.api).mockResolvedValue({ result: detail() });
    drawer(p);
    await waitFor(() => expect(screen.getByText("Ship the thing")).not.toBeNull());
    fireEvent.click(screen.getByText("Question"));
    const ta = must(document.getElementById("cbody")) as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "which port?" } });
    fireEvent.click(must(document.getElementById("csave")));
    await waitFor(() =>
      expect(OP(p.api)).toHaveBeenCalledWith("ch", "note", {
        id: "t1",
        kind: "question",
        body: "which port?",
      }),
    );
    await waitFor(() => expect(ta.value).toBe(""));
    expect(p.reloadBoard).toHaveBeenCalled();
  });

  it("refocuses an empty note box instead of sending", async () => {
    const p = props();
    drawer(p);
    await waitFor(() => expect(screen.getByText("Ship the thing")).not.toBeNull());
    fireEvent.click(must(document.getElementById("csave")));
    expect(OP(p.api)).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.getElementById("cbody"));
  });

  it("sends the note with ⌘/Ctrl+Enter from the note box, as the hint prints", async () => {
    const p = props();
    OP(p.api).mockResolvedValue({ result: detail() });
    drawer(p);
    await waitFor(() => expect(screen.getByText("Ship the thing")).not.toBeNull());
    const ta = must(document.getElementById("cbody")) as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "which port?" } });
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(OP(p.api)).toHaveBeenCalledWith("ch", "note", {
        id: "t1",
        kind: "change",
        body: "which port?",
      }),
    );
  });

  it("resolves, reopens and deletes notes", async () => {
    const p = props({
      api: apiF({
        "/task/t1": detail({
          comments: [
            { id: 7, kind: "change", body: "rename it", by: "api", created_at: "2026-10-08T09:00:00Z" },
            { id: 8, kind: "question", body: "which port?", resolved: 1, created_at: "2026-10-08T09:30:00Z" },
          ],
        }),
      }),
    });
    OP(p.api).mockResolvedValue({ result: { ok: true } });
    drawer(p);
    await waitFor(() => expect(screen.getByText("which port?")).not.toBeNull());
    // newest note first, with its Resolved pill
    expect(screen.getByText("Resolved")).not.toBeNull();
    fireEvent.click(screen.getByText("Reopen"));
    await waitFor(() =>
      expect(OP(p.api)).toHaveBeenCalledWith("ch", "note_edit", { id: 8, resolved: false }),
    );
    fireEvent.click(must(document.querySelector('[data-res="7"]')));
    await waitFor(() => expect(OP(p.api)).toHaveBeenCalledWith("ch", "note_edit", { id: 7, resolved: true }));
    fireEvent.click(must(document.querySelector('[data-del="7"]')));
    await waitFor(() => expect(OP(p.api)).toHaveBeenCalledWith("ch", "note_edit", { id: 7, remove: true }));
  });
});

describe("TaskDrawer helpers", () => {
  it("offers the roster plus the current owner, Nobody first", async () => {
    const { ownerOptions } = await import("../../src/work/TaskDrawer.tsx");
    const sessions = {
      sessions: [
        { name: "api", state: "working" },
        { name: "gone", state: "left" },
        { name: "owl", state: "idle" },
      ],
    } as unknown as SessionList;
    expect(ownerOptions(sessions, "api").map((o) => o.label)).toEqual(["Nobody", "Me", "api", "owl"]);
    // a current owner the roster lost still shows
    expect(ownerOptions(sessions, "ghost").map((o) => o.value)).toContain("ghost");
  });

  it("parses what an editor holds and reads it back per field kind", async () => {
    const { editText, parseEdit, editHelp, filled, isApproved } = await import(
      "../../src/work/TaskDrawer.tsx"
    );
    expect(editText("how", ["a", "b"])).toBe("a\nb");
    expect(editText("verify", [])).toBe("[]");
    expect(editText("what", "hello")).toBe("hello");
    expect(editText("what", undefined)).toBe("");
    expect(parseEdit("how", " a \n\nb ")).toEqual({ ok: true, value: ["a", "b"] });
    expect(parseEdit("what", "x")).toEqual({ ok: true, value: "x" });
    const bad = parseEdit("snippets", "{");
    expect(bad.ok).toBe(false);
    expect(editHelp("files")).toBe("One item per line.");
    expect(editHelp("alternatives")).toContain("JSON:");
    expect(editHelp("what")).toContain("Plain text");
    expect(filled(detail({ files: ["a"] }), "files")).toBe(true);
    expect(filled({ ...detail(), what: "" }, "what")).toBe(false);
    expect(
      isApproved(detail({ comments: [{ id: 1, kind: "direction", body: "Approved by the owner" }] })),
    ).toBe(true);
  });
});

describe("TaskDrawer edges", () => {
  it("steps back from a later task, and wears the drift words the row knows", async () => {
    const onOpenTask = vi.fn();
    const p = props({
      id: "t2",
      onOpenTask,
      views: ["drift"],
      api: apiF({
        "/task/t2": detail({ id: "t2", title: "Second", snippets: [{ title: "S", code: "x" }] }),
        "/repo/drift": { rows: [{ step: "t2", i: 0, state: "ok", score: 100 }] },
      }),
    });
    drawer(p);
    await waitFor(() => expect(screen.getByText("Matches the repo")).not.toBeNull());
    fireEvent.click(must(screen.getByLabelText("Previous task: t1")));
    expect(onOpenTask).toHaveBeenCalledWith("t1");
  });

  it("leaves an unknown snippet index plain", async () => {
    drawer({
      api: apiF({ "/task/t1": detail({ snippets: [{ title: "One", code: "x" }] }) }),
      store: (() => {
        const st = memStorage();
        writePref(st, "tab:t1", 5);
        return st;
      })(),
    });
    await waitFor(() => expect(screen.getByText("One")).not.toBeNull());
    // tab 5 clamps to the one snippet there is
    expect(screen.getByText("x")).not.toBeNull();
  });

  it("opens an unmet wait and the title editor, and reruns the Add section menu", async () => {
    const onOpenTask = vi.fn();
    const p = props({
      onOpenTask,
      api: apiF({ "/task/t1": detail({ unmet: [{ id: "t2", owner: "api", status: "doing" }] }) }),
    });
    drawer(p);
    await waitFor(() => expect(screen.getByText(/It waits on/)).not.toBeNull());
    fireEvent.click(must(screen.getByText(/It waits on/).querySelector("button")));
    expect(onOpenTask).toHaveBeenCalledWith("t2");
    fireEvent.click(must(screen.getByLabelText("Edit the title")));
    expect(document.getElementById("edta")).not.toBeNull();
    fireEvent.keyDown(must(document.getElementById("edta")), { key: "Escape" });
    expect(document.getElementById("edta")).toBeNull();
  });

  it("keeps Escape away from the drawer while the excerpt dialog is open", async () => {
    const onClose = vi.fn();
    const p = props({
      onClose,
      views: ["code"],
      api: apiF({
        "/task/t1": detail({ files: ["docs/x.md"] }),
        "/repo/code": { excerpt: "hello", from: 1, total: 1 },
      }),
    });
    drawer(p);
    await waitFor(() => expect(screen.getByText("docs/x.md")).not.toBeNull());
    fireEvent.click(screen.getByText("docs/x.md"));
    await waitFor(() => expect(document.querySelector("dialog[open]")).not.toBeNull());
    fireEvent.keyDown(window, { key: "Escape" });
    // the dialog owns this Escape; the drawer stays
    expect(onClose).not.toHaveBeenCalled();
  });

  it("explains an old server for approve, and toasts a refused update", async () => {
    const toast = vi.fn();
    const p = props({
      toast,
      api: apiF({ "/task/t1": detail({ gate: "owner" }) }),
    });
    OP(p.api).mockRejectedValue(Object.assign(new Error("no operation: approve"), { status: 404 }));
    drawer(p);
    await waitFor(() => expect(screen.getByText(/waits for your go-ahead/)).not.toBeNull());
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "This Huddle server does not support “approve” yet. Update the server.",
        { bad: true },
      ),
    );
    cleanup();
    const p2 = props({ toast });
    OP(p2.api).mockRejectedValueOnce(new Error("you may not"));
    OP(p2.api).mockResolvedValue({ result: detail() });
    drawer(p2);
    await waitFor(() => expect(screen.getByText("Ship the thing")).not.toBeNull());
    changeTo(must(document.getElementById("owner-sel")) as HTMLSelectElement, "owner");
    await waitFor(() => expect(toast).toHaveBeenNthCalledWith(2, "you may not", { bad: true }));
  });

  it("drops a busy approve on a refusal and takes the note back with Escape", async () => {
    const p = props({ api: apiF({ "/task/t1": detail({ gate: "owner" }) }) });
    OP(p.api).mockRejectedValue(new Error("no"));
    drawer(p);
    await waitFor(() => expect(screen.getByText(/waits for your go-ahead/)).not.toBeNull());
    fireEvent.click(screen.getByText("With a note"));
    const note = must(document.getElementById("gnote")) as HTMLInputElement;
    fireEvent.input(note, { target: { value: "hmm" } });
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(p.toast).toHaveBeenCalledWith("no", { bad: true }));
    await waitFor(() =>
      expect((must(screen.getByText("Approve")) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.keyDown(note, { key: "Escape" });
    expect(document.getElementById("gnote")).toBeNull();
  });

  it("sends the gate note with Enter, and clears an editor error on typing", async () => {
    const p = props({ api: apiF({ "/task/t1": detail({ gate: "owner", verify: [{ cmd: "x" }] }) }) });
    OP(p.api).mockResolvedValue({ result: { ok: true } });
    drawer(p);
    await waitFor(() => expect(screen.getByText(/waits for your go-ahead/)).not.toBeNull());
    fireEvent.click(screen.getByText("With a note"));
    const note = must(document.getElementById("gnote")) as HTMLInputElement;
    fireEvent.input(note, { target: { value: "go" } });
    fireEvent.keyDown(note, { key: "Enter" });
    await waitFor(() => expect(OP(p.api)).toHaveBeenCalledWith("ch", "approve", { id: "t1", msg: "go" }));
    // the editor's error line clears as soon as the text moves
    fireEvent.click(must(document.querySelector('[data-edit="verify"]')));
    const ta = must(document.getElementById("edta")) as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "{oops" } });
    fireEvent.click(must(document.getElementById("edsave")));
    await waitFor(() => expect(screen.getByText(/That is not valid JSON:/)).not.toBeNull());
    fireEvent.input(ta, { target: { value: "[]" } });
    expect(screen.queryByText(/That is not valid JSON:/)).toBeNull();
  });

  it("skips a status click that changes nothing", async () => {
    const p = props({ api: apiF({ "/task/t1": detail({ status: "todo" }) }) });
    drawer(p);
    await waitFor(() => expect(screen.getByText("Ship the thing")).not.toBeNull());
    fireEvent.click(must(document.querySelector('[data-st="todo"]')));
    expect(OP(p.api)).not.toHaveBeenCalled();
  });

  it("takes an Add section menu pick straight into its editor", async () => {
    const p = props();
    drawer(p);
    await waitFor(() => expect(screen.getByText("Ship the thing")).not.toBeNull());
    fireEvent.click(screen.getByText("Add section"));
    fireEvent.click(must(screen.getByText("How to undo it")));
    await waitFor(() => expect(document.querySelector('[data-editor="rollback"]')).not.toBeNull());
  });
});
