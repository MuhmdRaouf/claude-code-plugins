// SessionDrawer.test.tsx — the session drawer: it opens with the session the hash's ?s= names
// (its name, role, status, current task, cost, its events newest first), the composer is fixed
// to it, pause and resume go through the roster's ops, and closing drops ?s= from the address.
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api.ts";
import { HuddleContext, type HuddleContextValue } from "../../src/app/context.tsx";
import { pathOf } from "../../src/app/router.ts";
import type { Board, FeedEvent, SessionList } from "../../src/store.ts";
import {
  drawerSession,
  SessionDrawer,
  type SessionDrawerProps,
  sessionEvents,
} from "../../src/team/SessionDrawer.tsx";
import { makeCtx, makeState, NOW, sess } from "../helpers";

/** The value the test needs, or a loud failure — the tests carry no non-null assertions. */
function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("the test could not find what it needs");
  return x;
}

const board: Board = { steps: [{ id: "t1", title: "Ship it", status: "doing" }] } as Board;

const roster: SessionList = {
  sessions: [
    sess({ name: "api", state: "working", step: "t1", role: "builds the API" }),
    sess({ name: "gone", state: "left" }),
  ],
  config: {},
};

const ev = (seq: number, topic: string, extra: Record<string, unknown> = {}): FeedEvent =>
  ({ seq, topic, from: "api", ts: "2026-10-08T11:59:00Z", ...extra }) as FeedEvent;

const timeline: FeedEvent[] = [
  ev(1, "session.joined"),
  ev(2, "msg", { from: "api", to: "owner", msg: "starting on t1" }),
  ev(3, "msg", { from: "web", to: "api", msg: "which port?" }),
  ev(4, "msg", { from: "api.one", to: "owner", msg: "subagent checking in" }),
];

/** The api fake the composer reads; its ops are remembered. */
function apiF(): Api {
  return {
    api: vi.fn(async () => ({})),
    op: vi.fn(async () => ({ result: {} })),
    channelPath: (ch: string, p: string) => `/api/c/${ch}${p}`,
    channelHref: (ch: string, p: string) => `#/c/${ch}${p}`,
  };
}

type Base = SessionDrawerProps;

/** The drawer's props over one session, with spies the test asserts on. */
const props = (over: Partial<Base> = {}): Base => ({
  name: "api",
  ch: "ch",
  api: apiF(),
  now: NOW,
  sessions: roster,
  board,
  byId: (id: string) => board.steps.find((s) => s.id === id) ?? null,
  timeline,
  replies: new Map<number, string[]>(),
  costOf: () => undefined,
  toast: vi.fn(),
  onSent: vi.fn(),
  onOpenTask: vi.fn(),
  onClose: vi.fn(),
  ...over,
});

/** Renders the drawer under a context whose `act` the test watches. */
function drawer(over: Partial<Base> = {}, act: HuddleContextValue["act"] = vi.fn(async () => true)) {
  const view = render(
    <HuddleContext.Provider value={makeCtx(makeState({ sessions: roster, board }), { act })}>
      <SessionDrawer {...props(over)} />
    </HuddleContext.Provider>,
  );
  return { ...view, act };
}

/** Reads ?s= the way the shell's routeOf does. */
const hashSess = (): string | null => new URLSearchParams(location.hash.split("?")[1] ?? "").get("s");

beforeEach(() => {
  localStorage.clear();
  location.hash = "";
});

describe("SessionDrawer", () => {
  it("renders nothing without a name or a channel", () => {
    expect(drawer({ name: null }).container.textContent).toBe("");
    expect(drawer({ ch: null }).container.textContent).toBe("");
  });

  it("opens with the session the hash names: name, role, status, current task", () => {
    location.hash = "#/c/ch/team?s=api";
    // the shell hands the drawer what the address names (main.tsx: routeOf().sess)
    drawer({ name: hashSess() });
    const dlg = must(document.querySelector("dialog"));
    expect(dlg.getAttribute("aria-label")).toBe("Session api");
    expect(document.querySelector("[data-sess-name]")?.textContent).toBe("api");
    expect(screen.getByText("builds the API")).not.toBeNull();
    // the roster's derived status pill and the current plan task as a button
    expect(screen.getAllByText("Working").length).toBeGreaterThan(0);
    expect(must(document.querySelector("[data-sess-facts] .badge")).textContent).toContain("t1");
  });

  it("shows Radar's cost for the session when the channel has a figure", () => {
    drawer({ costOf: () => 3 });
    expect(document.body.textContent).toContain("$3.00");
    expect(screen.getAllByText("Cost today").length).toBeGreaterThan(0);
  });

  it("shows the session's events newest first, including its subagent's", () => {
    const { container } = drawer();
    const rows = [...container.querySelectorAll("[data-sess-events] [data-seq]")].map((r) =>
      r.getAttribute("data-seq"),
    );
    // the web→api ask stays out; api's own and its subagent's stay in, newest first
    expect(rows).toEqual(["4", "3", "2", "1"]);
  });

  it("opens a task the facts name", () => {
    const onOpenTask = vi.fn();
    drawer({ onOpenTask });
    fireEvent.click(must(document.querySelector("[data-sess-facts] .badge") as HTMLElement));
    expect(onOpenTask).toHaveBeenCalledWith("t1");
  });

  it("pauses, resumes, and skips the controls for a session that left", async () => {
    const act = vi.fn(async () => true);
    const toast = vi.fn();
    const view = drawer({ toast }, act);
    const pause = must(document.querySelector("[data-scontrol]") as HTMLButtonElement);
    expect(pause.textContent).toContain("Pause api");
    fireEvent.click(pause);
    await waitFor(() => expect(act).toHaveBeenCalledWith("pause", { target: "api" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("api paused"));
    view.unmount();

    const paused: SessionList = {
      sessions: [sess({ name: "api", state: "idle", control: "pause", control_by: "owner" })],
      config: {},
    };
    const act2 = vi.fn(async () => true);
    const toast2 = vi.fn();
    const v2 = render(
      <HuddleContext.Provider value={makeCtx(makeState({ sessions: paused }), { act: act2 })}>
        <SessionDrawer {...props({ sessions: paused, toast: toast2 })} />
      </HuddleContext.Provider>,
    );
    const resume = must(document.querySelector("[data-scontrol]") as HTMLButtonElement);
    expect(resume.textContent).toContain("Resume api");
    fireEvent.click(resume);
    await waitFor(() => expect(act2).toHaveBeenCalledWith("resume", { target: "api" }));
    await waitFor(() => expect(toast2).toHaveBeenCalledWith("api resumed"));
    v2.unmount();

    const left = drawer({ name: "gone" });
    expect(document.querySelector("[data-scontrol]")).toBeNull();
    left.unmount();
  });

  it("stays quiet through a refused control and recovers from a failed one", async () => {
    const refused = vi.fn(async () => null);
    const toast = vi.fn();
    const view = drawer({ toast }, refused);
    fireEvent.click(must(document.querySelector("[data-scontrol]") as HTMLButtonElement));
    await waitFor(() => expect(refused).toHaveBeenCalled());
    expect(toast).not.toHaveBeenCalled();
    expect((must(document.querySelector("[data-scontrol]")) as HTMLButtonElement).disabled).toBe(false);
    view.unmount();

    const broken = vi.fn(async () => {
      throw new Error("down");
    });
    const v2 = drawer({}, broken);
    fireEvent.click(must(document.querySelector("[data-scontrol]") as HTMLButtonElement));
    await waitFor(() =>
      expect((must(document.querySelector("[data-scontrol]")) as HTMLButtonElement).disabled).toBe(false),
    );
    v2.unmount();
  });

  it("shows what the timeline knows for a session the roster lost, and links its notes", () => {
    const api = apiF();
    const { container } = drawer({
      name: "ghost",
      sessions: null,
      timeline: [ev(9, "kb.added", { from: "ghost", ref: "kb:7", msg: "[note] Redis is up" })],
      api,
    });
    expect(screen.getByText("Unknown")).not.toBeNull();
    expect(screen.getByText("· not in the roster right now")).not.toBeNull();
    expect(document.querySelector("[data-sess-name]")?.textContent).toBe("ghost");
    // no roster row: no status pill and no pause
    expect(document.querySelector(".badge-info, .badge-warning")).toBeNull();
    expect(document.querySelector("[data-scontrol]")).toBeNull();
    // the remembered note links through the channel's knowledge
    const link = must(container.querySelector("[data-sess-events] .prose-h a"));
    expect(link.getAttribute("href")).toBe("#/c/ch/knowledge/7");
  });

  it("falls back to the session's own words when its step is not on the board", () => {
    const alone: SessionList = {
      sessions: [sess({ name: "api", state: "working", step: "ghost" })],
      config: {},
    };
    const { container } = render(
      <HuddleContext.Provider value={makeCtx(makeState({ sessions: alone }))}>
        <SessionDrawer {...props({ sessions: alone })} />
      </HuddleContext.Provider>,
    );
    expect(container.querySelector("[data-sess-facts] .badge")).toBeNull();
    expect(container.querySelector("[data-sess-facts]")?.textContent).toContain("No task yet");
  });

  it("fixes the composer to the session: no To menu, sends carry the recipient", async () => {
    const api = apiF();
    drawer({ api });
    expect(document.querySelector("select[id$='-to']")).toBeNull();
    expect(screen.getByText("Send to api")).not.toBeNull();
    fireEvent.input(must(document.querySelector("textarea[id$='-msg']") as HTMLTextAreaElement), {
      target: { value: "carry on" },
    });
    fireEvent.click(screen.getByText("Send to api"));
    await waitFor(() => expect(api.op).toHaveBeenCalledWith("ch", "send", { to: "api", msg: "carry on" }));
  });

  it("clears ?s= from the address when it closes", () => {
    location.hash = "#/c/ch/team?s=api";
    // the shell's close drops the drawer query, the way main.tsx wires it
    render(
      <HuddleContext.Provider value={makeCtx(makeState({ sessions: roster, board }))}>
        <SessionDrawer {...props({ onClose: () => (location.hash = pathOf(location.hash)) })} />
      </HuddleContext.Provider>,
    );
    expect(hashSess()).toBe("api");
    // the panel's own close button (the backdrop's submit button shares the label)
    const close = must(
      document.querySelector('[data-slide-over] button[aria-label="Close"]') as HTMLButtonElement,
    );
    fireEvent.click(close);
    expect(location.hash).toBe("#/c/ch/team");
    expect(hashSess()).toBeNull();
  });
});

describe("drawerSession and sessionEvents", () => {
  it("finds the roster row, or nothing", () => {
    expect(drawerSession(roster, "api")?.name).toBe("api");
    expect(drawerSession(roster, "ghost")).toBeUndefined();
    expect(drawerSession(null, "api")).toBeUndefined();
    expect(drawerSession(roster, null)).toBeUndefined();
  });

  it("collects the session's part of the timeline, newest first", () => {
    expect(sessionEvents(timeline, "api").map((e) => e.seq)).toEqual([4, 3, 2, 1]);
    expect(sessionEvents(null, "api")).toEqual([]);
  });
});
