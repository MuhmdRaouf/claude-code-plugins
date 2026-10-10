// App.test.tsx — the shell: the grouped destination tabs with their counts, the rail drawer
// hand-off, the live pill in the bar, the C key and the composer hand-off, the alias effects,
// the Coming soon fallback, the no-channel card and the signed-out page.
import { act, render, screen } from "@testing-library/preact";
import type { ComponentType } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, inboxOf, NoChannel, SignedOut } from "../../src/app/App.tsx";
import { IntroActions } from "../../src/app/intro.tsx";
import type { ComposeOptions } from "../../src/compose/drafts.ts";
import type { HuddleState } from "../../src/store.ts";
import {
  attention,
  flush,
  makeCtx,
  makeState,
  NOW,
  renderIn,
  sess,
  stubClipboard,
  stubMatchMedia,
} from "../helpers.tsx";

beforeEach(() => {
  localStorage.clear();
  location.hash = "";
  stubMatchMedia(false);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ version: "1.2.3" }) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Mounts the shell over a state. */
function mountApp(
  pages: Record<string, ComponentType> = {},
  state: HuddleState = makeState(),
  onCompose?: ((prefill?: ComposeOptions) => void) | undefined,
) {
  return renderIn(<App pages={pages} onCompose={onCompose} />, makeCtx(state));
}

/** Moves the address bar the way a click would. */
const nav = (hash: string): void => {
  act(() => {
    location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
  });
};

describe("chrome", () => {
  it("renders the top bar over the main area, with the rail beside it", () => {
    mountApp();
    expect(screen.getByLabelText("Huddle: all channels")).toBeDefined();
    expect(screen.getByLabelText("Search or run a command")).toBeDefined();
    expect(screen.getByLabelText("Keyboard shortcuts")).toBeDefined();
    expect(document.querySelector("#main")).not.toBeNull();
    expect(document.querySelector("#side")).not.toBeNull();
    expect(document.querySelector("header .neon-line")).not.toBeNull();
  });

  it("names the channel and its online count in the bar", () => {
    mountApp(
      {},
      makeState({
        sessions: { sessions: [sess({ name: "api", state: "working" }), sess({ name: "web" })] },
      }),
    );
    expect(screen.getAllByText("Checkout").length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector("[data-channel-word]")?.textContent).toContain("2");
  });

  it("renders no rail and no tabs on Home", () => {
    nav("#/");
    mountApp({}, makeState({ ch: null }));
    expect(document.querySelector("#side")).toBeNull();
    expect(document.querySelector("[data-view-tabs]")).toBeNull();
    expect(document.querySelector("#main")).not.toBeNull();
  });

  it("offers the composer from the C key", () => {
    const onCompose = vi.fn();
    nav("#/c/ch/inbox");
    mountApp({}, makeState(), onCompose);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
    });
    expect(onCompose).toHaveBeenCalledTimes(1);
  });

  it("does not open the composer while the keystroke types into a field", () => {
    const onCompose = vi.fn();
    nav("#/c/ch/inbox");
    const { container } = mountApp({}, makeState(), onCompose);
    const input = document.createElement("input");
    container.append(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    });
    expect(onCompose).not.toHaveBeenCalled();
  });

  it("mirrors the store's stream state in the bar's live pill", () => {
    mountApp({}, makeState({ live: "live" }));
    expect(document.querySelector("#ldot")?.getAttribute("aria-label")).toBe("Live updates: on");
  });
});

describe("the grouped tabs", () => {
  it("lays the destinations out in three groups with icons", () => {
    mountApp();
    const groups = [...document.querySelectorAll("[data-view-tabs] [role='tablist']")];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Channel", "Work", "System"]);
    const tabs = [...document.querySelectorAll("[data-view-tabs] [role='tab']")];
    expect(tabs.map((t) => t.getAttribute("data-dest"))).toEqual([
      "overview",
      "today",
      "inbox",
      "team",
      "work",
      "knowledge",
      "settings",
    ]);
  });

  it("marks the current destination and navigates by hash", () => {
    nav("#/c/ch/inbox");
    mountApp();
    const current = document.querySelector("[data-view-tabs] [aria-current='page']");
    expect(current?.getAttribute("data-dest")).toBe("inbox");
    act(() => {
      (document.querySelector("[data-dest='team']") as HTMLButtonElement).click();
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(location.hash).toBe("#/c/ch/team");
    expect(document.querySelector("[data-view-tabs] [aria-current='page']")?.getAttribute("data-dest")).toBe(
      "team",
    );
  });

  it("counts what follows each tab: the inbox needs-you, the online sessions, the open tasks", () => {
    nav("#/c/ch/overview");
    mountApp(
      {},
      makeState({
        attention: attention({
          asks: [
            { seq: 1, from: "api" },
            { seq: 2, from: "web" },
          ],
        }),
        extras: { ch: "ch", approvals: [{ seq: 9, from: "api" }], obs: null },
        board: {
          steps: [
            { id: "a", status: "todo" },
            { id: "b", status: "doing" },
            { id: "c", status: "done" },
          ],
        },
        sessions: {
          sessions: [
            sess({ name: "api", state: "working" }),
            sess({ name: "web" }),
            sess({ name: "sub", parent: "api" }),
          ],
        },
      }),
    );
    const inbox = document.querySelector("[data-dest='inbox']");
    expect(inbox?.querySelector(".badge-error")?.textContent).toBe("3");
    expect(document.querySelector("[data-dest='team']")?.querySelector(".badge")?.textContent).toBe("3");
    expect(document.querySelector("[data-dest='work']")?.querySelector(".badge")?.textContent).toBe("2");
    expect(document.title).toBe("(3) Checkout · Huddle");
  });

  it("draws no badge when a count is zero", () => {
    mountApp();
    expect(document.querySelector("[data-dest='inbox'] .badge-error")).toBeNull();
    expect(document.querySelector("[data-dest='team'] .badge")).toBeNull();
    expect(document.querySelector("[data-dest='work'] .badge")).toBeNull();
  });

  it("keeps the inbox count out of another channel's extras", () => {
    nav("#/c/ch/inbox");
    mountApp(
      {},
      makeState({
        attention: attention({ asks: [{ seq: 1, from: "api" }] }),
        extras: { ch: "other", approvals: [{ seq: 1, from: "api" }], obs: null },
      }),
    );
    expect(document.title).toBe("(1) Checkout · Huddle");
  });

  it("counts the inbox over the attention snapshot alone", () => {
    const st = makeState({
      attention: attention({
        asks: [{ seq: 1, from: "api" }],
        gates: [{ id: "t9" }],
        paused: [{ name: "api" }],
        blocked: [],
      }),
    });
    expect(inboxOf(st)).toBe(3);
    expect(inboxOf(makeState({ attention: null, extras: null }))).toBe(0);
  });
});

describe("alias effects and drawers", () => {
  it("rewrites an alias to the canonical address", () => {
    nav("#/c/ch/needs");
    mountApp();
    expect(location.hash).toBe("#/c/ch/inbox");
  });

  it("saves the preferences an alias carried", () => {
    nav("#/c/ch/plan/p/3");
    mountApp();
    expect(localStorage.getItem("huddle:wphase:ch")).toBe("3");
    expect(location.hash).toBe("#/c/ch/work/list");
  });

  it("renders the destination the alias landed on through the registry", () => {
    nav("#/c/ch/review");
    mountApp({ work: () => <div>work page</div> });
    expect(screen.getByText("work page")).toBeDefined();
  });

  it("follows the address bar when only the hash moves", () => {
    mountApp({ inbox: () => <div>inbox page</div> });
    expect(screen.queryByText("inbox page")).toBeNull();
    nav("#/c/ch/inbox");
    expect(screen.getByText("inbox page")).toBeDefined();
  });
});

describe("the main area", () => {
  it("paints the destination's PageIntro: icon tile, title and one plain sentence", () => {
    nav("#/c/ch/team");
    mountApp({ team: () => <div>team page</div> });
    const intro = document.querySelector("#main header[data-page-intro]") as HTMLElement;
    expect(intro.textContent).toContain("Team");
    expect(intro.textContent).toContain("Who is in, what each is doing, and everything that happened.");
    expect(document.querySelector("#main .neon-tile")).not.toBeNull();
    expect(screen.getByText("team page")).toBeDefined();
  });

  it("lets Overview speak with the channel's own description when the config has one", () => {
    nav("#/c/ch/overview");
    mountApp(
      {
        overview: () => <div>overview page</div>,
      },
      makeState({ info: { config: { description: "The shop plan" } } }),
    );
    const intro = document.querySelector("#main header[data-page-intro]") as HTMLElement;
    expect(intro.textContent).toContain("Overview");
    expect(intro.textContent).toContain("The shop plan");
  });

  it("carries the channel's facts in the Settings intro", () => {
    nav("#/c/ch/settings");
    mountApp(
      { settings: () => <div>settings page</div> },
      makeState({
        info: {
          config: { title: "Checkout", created_at: "2026-10-01T09:00:00Z" },
          stats: { events: 11, tasks: 3, knowledge: 4 },
        },
      }),
    );
    const intro = document.querySelector("#main header[data-page-intro]") as HTMLElement;
    expect(intro.textContent).toContain("Channel ch, created");
    expect(intro.textContent).toContain("11 events");
    expect(intro.textContent).toContain("4 knowledge entries");
  });

  it("puts a page's page-wide controls into the intro's actions", () => {
    nav("#/c/ch/work");
    mountApp({
      work: () => (
        <>
          <IntroActions>
            <button type="button" id="wnew">
              New task
            </button>
          </IntroActions>
          <div>work page</div>
        </>
      ),
    });
    const actions = document.querySelector("#main header[data-page-intro] .flex.items-center.gap-2");
    expect(actions?.querySelector("#wnew")).not.toBeNull();
  });

  it("falls back to Coming soon for a destination nobody registered", () => {
    nav("#/c/ch/overview");
    mountApp({ inbox: () => <div>inbox page</div> });
    expect(screen.getByText("Coming soon.")).toBeDefined();
    expect(document.querySelector("#main")?.textContent).toContain("Overview");
  });

  it("renders nothing under main for Home when no page is registered", () => {
    nav("#/");
    mountApp({}, makeState({ ch: null }));
    expect(screen.queryByText("Coming soon.")).toBeNull();
  });

  it("sets the title for Home without a channel part", () => {
    nav("#/");
    mountApp({}, makeState({ ch: null, attention: attention({ asks: [{ seq: 1, from: "api" }] }) }));
    expect(document.title).toBe("(1) Huddle");
  });

  it("names the channel in the title when the config has no title", () => {
    nav("#/c/ch/inbox");
    mountApp({}, makeState({ info: null }));
    expect(document.title).toBe("ch · Huddle");
  });

  it("paints the shell with the context's time", () => {
    const ctx = makeCtx(makeState(), { now: NOW });
    renderIn(<App pages={{}} />, ctx);
    expect(document.querySelector("#main")).not.toBeNull();
  });
});

describe("the rail drawer", () => {
  it("mounts the rail with its drawer toggle, and the checkbox follows", () => {
    nav("#/c/ch/inbox");
    mountApp();
    const box = document.querySelector("#rail-drawer") as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
  });

  it("renders only the main area, no rail, over Home with no channel", () => {
    nav("#/c/ch/inbox");
    mountApp({}, makeState({ ch: null }));
    expect(document.querySelector("#side")).toBeNull();
    expect(document.querySelector("#main")).not.toBeNull();
  });
});

describe("NoChannel and SignedOut", () => {
  it("says the channel is not there and offers the channels page", () => {
    renderIn(<NoChannel ch="ghost" />);
    expect(screen.getByText(/No channel “ghost”/)).toBeDefined();
    expect(screen.getByText("channels page").getAttribute("href")).toBe("#/");
  });

  it("renders the sign-in card, sets the title and shows the server's version", async () => {
    render(<SignedOut />);
    expect(document.title).toBe("Huddle: signed out");
    expect(screen.getByText("Signed out.")).toBeDefined();
    expect(screen.getByText("In a Claude session")).toBeDefined();
    expect(screen.getByText("Or in a terminal")).toBeDefined();
    expect(screen.getAllByText("/huddle:setup").length).toBeGreaterThanOrEqual(2);
    await flush();
    expect(screen.getByText("Huddle v1.2.3")).toBeDefined();
  });

  it("offers /huddle:setup, the command that replaced /huddle:open", () => {
    render(<SignedOut />);
    expect(screen.getByLabelText("Copy /huddle:setup")).toBeDefined();
    expect(screen.queryByLabelText("Copy /huddle:open")).toBeNull();
    expect(screen.queryByLabelText("Copy huddle:open")).toBeNull();
  });

  it("copies /huddle:setup and flashes the button", async () => {
    vi.useFakeTimers();
    const { writes } = stubClipboard();
    render(<SignedOut />);
    // the card's own button (the cmd field's carries the same command, so target by class)
    const big = document.querySelector("main .btn-primary") as HTMLButtonElement;
    await act(async () => {
      big.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(writes).toEqual(["/huddle:setup"]);
    expect(screen.getByText("Copied: paste it into a Claude session")).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1700);
    });
    expect(screen.queryByText("Copied: paste it into a Claude session")).toBeNull();
    vi.useRealTimers();
  });

  it("copies a command field's command", () => {
    const { writes } = stubClipboard();
    render(<SignedOut />);
    act(() => {
      screen.getByLabelText("Copy huddle open").click();
    });
    expect(writes).toEqual(["huddle open"]);
  });

  it("stays quiet when the clipboard refuses", () => {
    stubClipboard(() => Promise.reject(new Error("no")));
    render(<SignedOut />);
    act(() => {
      screen.getByLabelText("Copy /huddle:setup").click();
    });
    expect(screen.queryByText(/Copied/)).toBeNull();
  });

  it("keeps the sign-in page's name when /health has no version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })),
    );
    render(<SignedOut />);
    await flush();
    expect(screen.queryByText(/Huddle v/)).toBeNull(); // no version: the bare name stays
    expect(document.querySelector("p.muted.text-center.text-xs")?.textContent).toBe("Huddle");
  });
});
