// Rail.test.tsx — the channel rail: the session cards (status dot, name, doing line and its ago
// tail, subagents, the open-questions badge), the filter, the channel switcher with the other
// channels' online counts, the drawer hand-off, and the footer's connection line.
import { act, fireEvent, screen } from "@testing-library/preact";
import { beforeEach, describe, expect, it } from "vitest";
import {
  asksFor,
  cardMatches,
  cardSessions,
  doingOf,
  Rail,
  RailFooter,
  type StepLookup,
  statusDot,
  statusWord,
  subCount,
} from "../../src/app/Rail.tsx";
import type { HuddleState } from "../../src/store.ts";
import { attention, makeCtx, makeState, renderIn, sess } from "../helpers.tsx";

const STEP = { id: "api", title: "Ship the API", status: "doing" as const };

beforeEach(() => {
  location.hash = "#/c/ch/overview";
});

/** A state with a roster the cards read. */
function railState(over: Partial<HuddleState> = {}): HuddleState {
  return makeState({
    board: { steps: [STEP] },
    byId: new Map([["api", STEP]]),
    sessions: {
      sessions: [
        sess({
          name: "api",
          state: "working",
          step: "api",
          role: "builds the API",
          last_seen: "2026-10-08T11:58:00Z",
        }),
        sess({ name: "web", state: "idle", role: "builds the client" }),
        sess({ name: "api.worker", parent: "api", state: "working" }),
        sess({ name: "owl", state: "waiting", task: "reviewing the plan" }),
        sess({ name: "gone", state: "left" }),
      ],
    },
    ...over,
  });
}

describe("card helpers", () => {
  it("maps every derived state to its dot class and word", () => {
    expect(statusDot("working")).toBe("status-success");
    expect(statusDot("waiting")).toBe("status-warning");
    expect(statusDot("blocked")).toBe("status-error");
    expect(statusDot("paused")).toBe("status-secondary");
    expect(statusDot("idle")).toBe("status-neutral");
    expect(statusDot("left")).toBe("status-neutral");
    expect(statusWord("left")).toBe("Offline");
    expect(statusWord("working")).toBe("Working");
  });

  it("reads the doing line: the step, the session's own words, then the role", () => {
    const byId: StepLookup = (id) => (id === "api" ? STEP : null);
    expect(doingOf(sess({ name: "api", step: "api" }), byId)).toEqual({ text: "api Ship the API", at: null });
    expect(doingOf(sess({ name: "owl", task: "reviewing the plan" }), byId).text).toBe("reviewing the plan");
    // the presence words never read as work
    expect(doingOf(sess({ name: "owl", task: "joined" }), byId).text).toBe("No task yet");
    expect(doingOf(sess({ name: "api", role: "builds the API" }), byId).text).toBe("builds the API");
    expect(doingOf(sess({ name: "api", task: "x", last_seen: "2026-10-08T11:58:00Z" }), byId).at).toBe(
      "2026-10-08T11:58:00Z",
    );
  });

  it("lists the top-level sessions still in, and counts the subs under one", () => {
    const list = railState().sessions?.sessions ?? [];
    expect(cardSessions(list).map((s) => s.name)).toEqual(["api", "web", "owl"]);
    expect(subCount(list, "api")).toBe(1);
    expect(subCount(list, "web")).toBe(0);
  });

  it("matches the filter text over name, role and own words", () => {
    expect(cardMatches(sess({ name: "api", role: "builds" }), "")).toBe(true);
    expect(cardMatches(sess({ name: "api" }), "AP")).toBe(true);
    expect(cardMatches(sess({ name: "api", role: "builds the API" }), "builds")).toBe(true);
    expect(cardMatches(sess({ name: "api", task: "reviewing" }), "review")).toBe(true);
    expect(cardMatches(sess({ name: "api" }), "owl")).toBe(false);
  });

  it("counts a session's open asks in the attention snapshot", () => {
    const st = railState({
      attention: attention({
        asks: [
          { seq: 1, from: "api" },
          { seq: 2, from: "api" },
          { seq: 3, from: "web" },
        ],
      }),
    });
    expect(asksFor(st, "api")).toBe(2);
    expect(asksFor(st, "owl")).toBe(0);
  });
});

describe("the rail cards", () => {
  it("renders one card per session with its dot, name, doing line and ago tail", () => {
    renderIn(<Rail />, makeCtx(railState()));
    const cards = [...document.querySelectorAll("#side [data-card]")];
    expect(cards.map((c) => c.getAttribute("data-sess"))).toEqual(["api", "web", "owl"]);
    const api = cards[0] as HTMLElement;
    expect(api.textContent).toContain("api");
    expect(api.textContent).toContain("api Ship the API");
    expect(api.querySelector(".status-success")).not.toBeNull();
    expect(api.textContent).toContain("· 2 min ago");
    expect(screen.getByText("builds the API")).toBeDefined();
  });

  it("carries the subagent count and the open-questions badge", () => {
    renderIn(
      <Rail />,
      makeCtx(
        railState({
          attention: attention({ asks: [{ seq: 1, from: "api" }] }),
        }),
      ),
    );
    const api = document.querySelector('#side [data-card][data-sess="api"]') as HTMLElement;
    expect(api.textContent).toContain("1 sub");
    expect(screen.getByTitle("1 open question for you").textContent).toBe("1");
  });

  it("speaks the status word to the screen reader and in the aria-label", () => {
    renderIn(<Rail />, makeCtx(railState()));
    expect(screen.getByLabelText("api, working")).not.toBeNull();
    expect(screen.getByLabelText("owl, waiting")).not.toBeNull();
    expect(document.querySelector("#side .sr-only")?.textContent).toBe("Working");
  });

  it("opens the session drawer over the current view on click, and filters narrow the cards", () => {
    const ctx = makeCtx(railState());
    renderIn(<Rail />, ctx);
    const input = screen.getByLabelText("Filter sessions") as HTMLInputElement;
    act(() => {
      fireEvent.input(input, { target: { value: "owl" } });
    });
    const cards = [...document.querySelectorAll("#side [data-card]")];
    expect(cards.map((c) => c.getAttribute("data-sess"))).toEqual(["owl"]);
    act(() => {
      (cards[0] as HTMLElement).click();
    });
    expect(location.hash).toBe("#/c/ch/overview?s=owl");
  });

  it("says nobody has joined yet when only left sessions remain", () => {
    const { container } = renderIn(
      <Rail />,
      makeCtx(railState({ sessions: { sessions: [sess({ name: "gone", state: "left" })] } })),
    );
    expect(container.textContent).toContain("Nobody has joined yet");
  });

  it("says nothing matches when the filter is too narrow", () => {
    renderIn(<Rail />, makeCtx(railState()));
    const input = screen.getByLabelText("Filter sessions") as HTMLInputElement;
    act(() => {
      fireEvent.input(input, { target: { value: "zzz" } });
    });
    expect(document.querySelector("#side [data-card-list]")?.textContent).toContain("Nothing matches");
  });

  it("shows skeletons until the roster arrives", () => {
    const { container } = renderIn(<Rail />, makeCtx(railState({ sessions: null })));
    expect(container.querySelector("#side .skeleton")).not.toBeNull();
    expect(container.querySelector("#side [data-card]")).toBeNull();
  });
});

describe("the channel switcher", () => {
  it("offers the other channels with their online counts and All channels", async () => {
    renderIn(
      <Rail />,
      makeCtx(
        railState({
          channels: [
            { name: "ch", title: "Checkout", sessions: [{ name: "api" }, { name: "web" }] },
            { name: "lab", title: "Lab", sessions: [{ name: "probe" }] },
            { name: "bare" },
          ],
        }),
      ),
    );
    expect(screen.getByLabelText("Channel: Checkout")).toBeDefined();
    act(() => {
      (document.querySelector("#chbtn") as HTMLButtonElement).click();
    });
    const items = [...document.querySelectorAll('[role="menu"] button')] as HTMLButtonElement[];
    expect(items.map((b) => b.textContent)).toEqual(["Lab1", "bare", "All channels"]);
    act(() => {
      items[0]?.click();
    });
    expect(location.hash).toBe("#/c/lab");
  });
});

describe("the rail footer", () => {
  it("reads connected with the last change, then reconnecting, then connecting", () => {
    const live = renderIn(<RailFooter />, makeCtx(railState({ live: "live" })));
    expect(screen.getByText("Connected, updated just now")).toBeDefined();
    live.unmount();
    renderIn(<RailFooter />, makeCtx(railState({ live: "offline" })));
    expect(screen.getByText("Reconnecting…")).toBeDefined();
    const off = renderIn(<RailFooter />, makeCtx(railState({ live: "offline" })));
    off.unmount();
    renderIn(<RailFooter />, makeCtx(railState({ live: "connecting" })));
    expect(screen.getByText("Connecting…")).toBeDefined();
  });

  it("offers the shortcuts key", () => {
    const onHelp = (): void => {};
    renderIn(<RailFooter onHelp={onHelp} />, makeCtx(railState()));
    expect(screen.getByText("Shortcuts")).toBeDefined();
  });
});
