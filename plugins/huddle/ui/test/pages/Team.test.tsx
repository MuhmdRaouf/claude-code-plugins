// Team.test.tsx — the Team page: the roster over the feed, the two filters and their kept prefs,
// and the reply path into the composer.
import { act, fireEvent, type RenderResult, screen } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HuddleProvider } from "../../src/app/context.tsx";
import { readTeamFilter, Team } from "../../src/pages/Team.tsx";
import type { FeedEvent, HuddleState } from "../../src/store.ts";
import { attention, makeCtx, makeState, renderIn, sess, stubMatchMedia } from "../helpers";

beforeEach(() => {
  localStorage.clear();
  location.hash = "";
  stubMatchMedia(false);
});

const ev = (seq: number, topic: string, extra: Record<string, unknown> = {}): FeedEvent =>
  ({ seq, topic, from: "api", ts: "2026-10-08T11:59:00Z", ...extra }) as FeedEvent;

/** The channel's state: one working session, a two-event feed, an open ask. */
function state(over: Partial<HuddleState> = {}): HuddleState {
  return makeState({
    sessions: { sessions: [sess({ name: "api", state: "working", step: "t1" })] },
    board: { steps: [{ id: "t1", title: "Ship it", status: "doing" }] },
    timeline: [
      ev(1, "task.status", { ref: "t1", data: { status: "doing" } }),
      ev(2, "ask", { to: "owner", needs_reply: true }),
    ],
    attention: attention({}),
    ...over,
  });
}

describe("Team", () => {
  it("renders the roster and the feed with their counts", () => {
    renderIn(<Team />, makeCtx(state()));
    expect(screen.getByText("1 online")).not.toBeNull();
    expect(document.querySelector('section[aria-label="Activity"]')).not.toBeNull();
    // the roster's row and the feed's rows both show up
    expect(screen.getByLabelText(/api, Working/)).not.toBeNull();
    expect(document.querySelector('[role="log"]')?.textContent).toContain("started t1");
  });

  it("filters the feed by family and keeps the choice per channel", () => {
    renderIn(<Team />, makeCtx(state()));
    act(() => {
      fireEvent.click(screen.getByText("Messages"));
    });
    // the ask stays (it is a message), the task update goes
    expect(document.querySelector('[data-seq="2"]')).not.toBeNull();
    expect(document.querySelector('[data-seq="1"]')).toBeNull();
    expect(readTeamFilter(localStorage, "ch")).toEqual({ family: "msg", session: "" });
  });

  it("opens a session from its roster row and a task from the feed, and filters by session", () => {
    renderIn(
      <Team />,
      makeCtx(
        state({
          // a knowledge event naming the task: its feed badge is the button that opens the task
          timeline: [ev(1, "kb.added", { ref: "t1" })],
          extras: {
            ch: "ch",
            approvals: [],
            obs: { available: true, total: 5, cost: { api: 5 }, range: "day" },
          },
        }),
      ),
    );
    // the session select writes the kept filter
    act(() => {
      const sel = document.querySelector("#tls") as HTMLSelectElement;
      sel.value = "api";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(readTeamFilter(localStorage, "ch")).toEqual({ family: "all", session: "api" });
    // the roster row opens the session
    act(() => {
      fireEvent.click(screen.getByLabelText(/api, Working/));
    });
    expect(location.hash).toBe("#/c/ch/team?s=api");
    // the feed's task badge (a button, not the roster's span) opens the task
    const badge = screen
      .getAllByText("t1")
      .find((el) => el.tagName === "BUTTON" && el.className.includes("badge"));
    act(() => {
      fireEvent.click(badge as HTMLElement);
    });
    expect(location.hash).toBe("#/c/ch/work?t=t1");
    // the session's estimated cost shows on its row
    expect(document.body.textContent).toContain("$5.00");
  });

  it("hands a Reply to the composer with the ask's seq", () => {
    const onCompose = vi.fn();
    renderIn(<Team onCompose={onCompose} />, makeCtx(state()));
    act(() => {
      fireEvent.click(screen.getByText("Reply"));
    });
    expect(onCompose).toHaveBeenCalledWith({ reply: 2 });
  });

  it("lists each speaker once and leaves the owner to the fixed You option", () => {
    renderIn(
      <Team />,
      makeCtx(
        state({
          timeline: [
            ev(1, "msg", { from: "owner" }),
            ev(2, "msg", { from: "api" }),
            ev(3, "msg", { from: "owner" }),
          ],
        }),
      ),
    );
    const owner = document.querySelectorAll('#tls option[value="owner"]');
    expect(owner).toHaveLength(1);
    expect(owner[0]?.textContent).toBe("You");
    expect([...document.querySelectorAll("#tls option")].map((o) => o.textContent)).toEqual([
      "Everyone",
      "You",
      "api",
    ]);
  });

  it("counts the events that arrived below the fold and clears them when the reader comes home", () => {
    const first = state();
    const view = renderIn(<Team />, makeCtx(first));
    const log = document.querySelector("#tl") as HTMLElement;
    Object.defineProperty(log, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(log, "clientHeight", { value: 100, configurable: true });
    // the reader scrolls back; then an event lands below the fold
    log.scrollTop = 0;
    fireEvent.scroll(log);
    const more = state({
      timeline: [
        ...(first.timeline as FeedEvent[]),
        ev(3, "msg", { from: "api" }),
        // an event the server sent without a seq counts for nothing but must not break the count
        { topic: "msg", from: "api" } as FeedEvent,
      ],
    });
    view.rerender(
      <HuddleProvider value={makeCtx(more)}>
        <Team />
      </HuddleProvider>,
    );
    expect(document.querySelector("#tlnew")?.textContent).toContain("1 new");
    // back at the bottom the count is gone
    log.scrollTop = 480;
    fireEvent.scroll(log);
    expect(document.querySelector("#tlnew")).toBeNull();
    view.unmount();
  });

  it("renders nothing without a channel, and the placeholders before the channel's data lands", () => {
    const bare = renderIn(<Team />, makeCtx(makeState({ ch: null, info: null })));
    expect(bare.container.textContent).toBe("");
    bare.unmount();
    const loading = renderIn(
      <Team />,
      makeCtx(
        makeState({
          sessions: null,
          board: null,
          timeline: null,
          info: { name: "ch", config: { orchestrator: "api" } },
        }),
      ),
    );
    expect(document.querySelector(".skeleton")).not.toBeNull();
    expect(screen.getByText("The feed has not loaded yet")).not.toBeNull();
    loading.unmount();
  });

  it("shows the turn banner only when the channel's start is a non-empty string", () => {
    // the server always sends `start` (null when unset): a null start is no turn
    const withNull = state({
      sessions: { sessions: [], config: { start: null } },
    });
    let view: RenderResult = renderIn(<Team />, makeCtx(withNull));
    expect(screen.queryByText(/holds the turn/)).toBeNull();
    view.unmount();
    // a named starter is a turn, from the sessions row or the channel row
    const named = state({ sessions: { sessions: [], config: { start: "api" } } });
    view = renderIn(<Team />, makeCtx(named));
    expect(screen.getByText(/holds the turn/)).not.toBeNull();
    view.unmount();
    const fromInfo = state({
      sessions: { sessions: [], config: {} },
      info: { name: "ch", config: { start: "web" } },
    });
    view = renderIn(<Team />, makeCtx(fromInfo));
    expect(screen.getByText(/holds the turn/)).not.toBeNull();
  });
});
