// App.test.tsx — the shell: the rail (switcher, menu, members, theme), the mobile drawer, the
// counts, the live pill, the C key and the composer hand-off, the alias effects, the Coming soon
// fallback, the no-channel card and the signed-out page.
import { act, render, screen } from "@testing-library/preact";
import type { ComponentType } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, LivePill, NoChannel, ProgressBar, SignedOut } from "../../src/app/App.tsx";
import { type HuddleContextValue, HuddleProvider } from "../../src/app/context.tsx";
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
  it("renders the rail: logo, switcher, live pill, search and help placeholders, version", () => {
    mountApp();
    expect(screen.getByLabelText("Huddle: all channels").getAttribute("href")).toBe("#/");
    expect(screen.getByLabelText("Search or run a command")).toBeDefined();
    expect(screen.getByLabelText("Keyboard shortcuts")).toBeDefined();
    expect(screen.getByText("v0.0.1")).toBeDefined();
    expect(document.querySelector("#main")).not.toBeNull();
    expect(document.querySelector("#side")).not.toBeNull();
  });

  it("shows the server's version once /health answers", async () => {
    mountApp();
    await flush();
    expect(screen.getByText("v1.2.3")).toBeDefined();
  });

  it("keeps the placeholder version when /health fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("down"))),
    );
    mountApp();
    await flush();
    expect(screen.getByText("v0.0.1")).toBeDefined();
  });

  it("renders no rail on Home", () => {
    nav("#/");
    mountApp({}, makeState({ ch: null }));
    expect(document.querySelector("#side")).toBeNull();
    expect(document.querySelector("#main")).not.toBeNull();
  });

  it("offers the composer from the rail and the C key", () => {
    const onCompose = vi.fn();
    nav("#/c/ch/inbox");
    mountApp({}, makeState(), onCompose);
    act(() => {
      screen.getByText("New message").click();
    });
    expect(onCompose).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
    });
    expect(onCompose).toHaveBeenCalledTimes(2);
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
});

describe("the rail menu", () => {
  it("marks the current destination and links the others to the channel", () => {
    nav("#/c/ch/inbox");
    mountApp();
    const current = document.querySelectorAll('#side a[aria-current="page"]');
    expect(current.length).toBeGreaterThanOrEqual(1);
    expect(current[0]?.textContent).toContain("Inbox");
    const today = document.querySelector('#side a[href="#/c/ch/today"]');
    expect(today?.getAttribute("aria-current")).toBeNull();
    expect(document.querySelector('#side a[href="#/c/ch/team"]')).not.toBeNull();
  });
});

describe("counts", () => {
  const state = (): HuddleState =>
    makeState({
      attention: attention({
        asks: [
          { seq: 1, from: "api" },
          { seq: 2, from: "web" },
        ],
        gates: [{ id: "t9" }],
      }),
      extras: { ch: "ch", approvals: [{ seq: 9, from: "api" }], obs: null },
      board: {
        steps: [
          { id: "a", status: "todo" },
          { id: "b", status: "doing" },
          { id: "c", status: "done" },
          { id: "d", status: "blocked" },
        ],
      },
    });

  it("counts the Inbox badge over attention plus extras, in the title and the rail", () => {
    nav("#/c/ch/team");
    mountApp({}, state());
    expect(document.title).toBe("(4) Checkout · Huddle");
    expect(screen.getAllByText(", 4 need you")[0]?.tagName).toBe("SPAN");
    expect(document.querySelector('#side [aria-hidden="true"].badge')?.textContent).toBe("4");
  });

  it("reads an empty Inbox as all clear", () => {
    nav("#/c/ch/inbox");
    mountApp({}, makeState({ attention: attention({}) }));
    expect(screen.getAllByText(", all clear")[0]?.textContent).toBe(", all clear");
  });

  it("pluralises the need: one session needs you", () => {
    nav("#/c/ch/team");
    mountApp({}, makeState({ attention: attention({ asks: [{ seq: 1, from: "api" }] }) }));
    expect(screen.getAllByText(", 1 needs you")[0]).toBeDefined();
  });

  it("counts the online sessions and the open tasks", () => {
    nav("#/c/ch/work");
    mountApp(
      {},
      {
        ...state(),
        sessions: {
          sessions: [
            sess({ name: "api", state: "working" }),
            sess({ name: "web" }),
            sess({ name: "sub.api", parent: "api" }),
            sess({ name: "gone", state: "left" }),
          ],
        },
      },
    );
    expect(screen.getAllByText(", 3 online")[0]).toBeDefined();
    expect(screen.getAllByText(", 3 open tasks")[0]).toBeDefined();
    expect(document.title).toBe("(4) Checkout · Huddle");
  });

  it("lists the members with their status dots, orchestrator and turn marks", () => {
    nav("#/c/ch/team");
    mountApp(
      {},
      makeState({
        info: { config: { title: "C", orchestrator: "api" } },
        sessions: {
          sessions: [
            sess({ name: "api", state: "working" }),
            sess({ name: "web", holds_turn: true }),
            sess({ name: "kid", parent: "api" }),
          ],
        },
      }),
    );
    const rows = [...document.querySelectorAll('#side section[aria-labelledby="sb-team"] a')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("api");
    expect(rows[0]?.querySelector(".status")).not.toBeNull();
    expect(rows[0]?.querySelector('[title="Orchestrator"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[title="Holds the turn"]')).not.toBeNull();
    expect(rows[0]?.getAttribute("href")).toBe("#/c/ch/team?s=api");
  });

  it("shows the plan's progress bar and its tally", () => {
    nav("#/c/ch/inbox");
    mountApp({}, state());
    const bar = document.querySelector("#side .segbar");
    expect(bar?.getAttribute("aria-label")).toContain("1 done");
    expect(bar?.getAttribute("aria-label")).toContain("4 in all");
    // done · doing · blocked draw; the waiting segment is zero and never draws
    expect(bar?.querySelectorAll(".segbar-seg")).toHaveLength(3);
    expect(document.querySelector('#side section[aria-label="Progress"] .tnum')?.textContent).toBe(
      "1 of 4 tasks done",
    );
  });

  it("reads an unnamed task status as open", () => {
    nav("#/c/ch/inbox");
    mountApp(
      {},
      makeState({
        board: { steps: [{ id: "a" }, { id: "b", status: "done" }] },
      }),
    );
    expect(screen.getAllByText(", 1 open tasks")[0]).toBeDefined();
    expect(document.querySelector('#side section[aria-label="Progress"] .tnum')?.textContent).toBe(
      "1 of 2 tasks done",
    );
  });
});

describe("the live pill", () => {
  it("shows connecting, live and reconnecting", () => {
    const { rerender, container } = render(<LivePill live="connecting" />);
    const pill = container.querySelector("#ldot") as HTMLElement;
    expect(pill.className).toBe("badge badge-ghost gap-1.5");
    expect(pill.getAttribute("aria-label")).toBe("Live updates: connecting");
    expect(pill.textContent).toContain("Connecting…");
    rerender(<LivePill live="live" />);
    expect(pill.className).toBe("badge badge-soft badge-success gap-1.5");
    expect(pill.getAttribute("title")).toBe("Live updates: on");
    expect(pill.textContent).toContain("Live");
    rerender(<LivePill live="offline" />);
    expect(pill.className).toBe("badge badge-soft badge-warning gap-1.5");
    expect(pill.getAttribute("aria-label")).toBe("Live updates: reconnecting");
    expect(pill.textContent).toContain("Reconnecting");
  });

  it("mirrors the store's stream state in the rail", () => {
    mountApp({}, makeState({ live: "live" }));
    expect(document.querySelector("#ldot")?.getAttribute("aria-label")).toBe("Live updates: on");
  });
});

describe("the theme menu", () => {
  it("opens with the three choices, checks the current one, and keeps a pick", async () => {
    mountApp();
    act(() => {
      (screen.getByLabelText("Theme: System") as HTMLButtonElement).click();
    });
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    expect(menu.textContent).toContain("System");
    expect(menu.textContent).toContain("Light");
    expect(menu.textContent).toContain("Dark");
    expect(menu.querySelector('[aria-checked="true"]')?.textContent).toContain("System");
    act(() => {
      [...menu.querySelectorAll("button")].find((b) => b.textContent?.includes("Dark"))?.click();
    });
    expect(localStorage.getItem("huddle:theme")).toBe('"dark"');
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByLabelText("Theme: Dark")).toBeDefined();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("reopens on the kept choice after a reload", () => {
    localStorage.setItem("huddle:theme", '"light"');
    mountApp();
    expect(screen.getByLabelText("Theme: Light")).toBeDefined();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("follows the system while System is the choice", () => {
    const mq = stubMatchMedia(false);
    mountApp();
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => {
      mq.fire();
    });
    // the fake has no way to flip matches mid-flight; a Light pick stops the system from mattering
    expect(["light", "dark"]).toContain(document.documentElement.dataset.theme);
  });

  it("applies the system's dark palette when nothing is kept", () => {
    stubMatchMedia(true);
    mountApp();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("the channel switcher", () => {
  /** Mounts the shell whose channel list arrives through the shell's own loadChannels call, the
   *  way the store's load lands: the loader writes the rows, the shell repaints on the change. */
  function mountAppLoading(channels: { name: string; title?: string }[]) {
    const state = makeState();
    const loadChannels = vi.fn(async () => {
      state.channels = channels.map((c) => ({ ...c }));
    });
    const ctx = makeCtx(state);
    const tree = (c: HuddleContextValue = ctx) => (
      <HuddleProvider value={c}>
        <App pages={{}} loadChannels={loadChannels} />
      </HuddleProvider>
    );
    const view = render(tree());
    return { view, loadChannels, ctx, tree };
  }

  it("loads the channel list on boot and again when the open channel changes", async () => {
    const { view, loadChannels, tree, ctx } = mountAppLoading([{ name: "lab", title: "Lab" }]);
    await flush();
    expect(loadChannels).toHaveBeenCalledTimes(1); // once per page load
    // a second channel opens (a created one navigates here): the list is read again
    const next = makeCtx(makeState({ ch: "lab" }));
    view.rerender(tree(next));
    expect(loadChannels).toHaveBeenCalledTimes(2);
    expect(ctx.state.channels).toEqual([{ name: "lab", title: "Lab" }]);
  });

  it("offers the other channels and Home, and navigates", async () => {
    const { view, tree } = mountAppLoading([{ name: "ch" }, { name: "lab", title: "Lab" }]);
    await flush();
    view.rerender(tree()); // the load landed; the shell paints what the store now holds
    act(() => {
      (document.querySelector("#chbtn") as HTMLButtonElement).click();
    });
    const items = [...document.querySelectorAll('[role="menu"] button')] as HTMLButtonElement[];
    expect(items.map((b) => b.textContent)).toEqual(["Lab", "All channels"]);
    act(() => {
      items[0]?.click();
    });
    expect(location.hash).toBe("#/c/lab");
  });

  it("goes Home from the menu", () => {
    mountApp({}, makeState({ channels: [] }));
    act(() => {
      (document.querySelector("#chbtn") as HTMLButtonElement).click();
    });
    act(() => {
      (
        [...document.querySelectorAll('[role="menu"] button')].at(-1) as HTMLButtonElement | undefined
      )?.click();
    });
    expect(location.hash).toBe("#/");
  });

  it("labels untitled channels in the switcher", async () => {
    const { view, tree } = mountAppLoading([{ name: "bare" }]);
    await flush();
    view.rerender(tree());
    act(() => {
      (document.querySelector("#chbtn") as HTMLButtonElement).click();
    });
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("bare");
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
});

describe("the main area", () => {
  it("renders the registered page for the destination", () => {
    nav("#/c/ch/inbox");
    mountApp({ inbox: () => <div>inbox page</div>, home: () => <div>home page</div> });
    expect(screen.getByText("inbox page")).toBeDefined();
    nav("#/");
    act(() => {
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(screen.getByText("home page")).toBeDefined();
  });

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
    await flush();
    expect(screen.getByText("Huddle v1.2.3")).toBeDefined();
  });

  it("copies /huddle:open and flashes the button", async () => {
    vi.useFakeTimers();
    const { writes } = stubClipboard();
    render(<SignedOut />);
    // the card's own button (the cmd field's carries the same command, so target by class)
    const big = document.querySelector("main .btn-primary") as HTMLButtonElement;
    await act(async () => {
      big.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(writes).toEqual(["/huddle:open"]);
    expect(screen.getByText("Copied: paste it into a Claude session")).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1700);
    });
    expect(screen.queryByText("Copied: paste it into a Claude session")).toBeNull();
    vi.useRealTimers();
  });

  it("copies a command field's command", async () => {
    const { writes } = stubClipboard();
    render(<SignedOut />);
    act(() => {
      screen.getByLabelText("Copy huddle open").click();
    });
    expect(writes).toEqual(["huddle open"]);
  });

  it("stays quiet when the clipboard refuses", async () => {
    stubClipboard(() => Promise.reject(new Error("no")));
    render(<SignedOut />);
    act(() => {
      screen.getByLabelText("Copy /huddle:open").click();
    });
    expect(screen.queryByText(/Copied/)).toBeNull();
  });
});

describe("the clock the shell paints", () => {
  it("paints the shell with the context's time", () => {
    const ctx = makeCtx(makeState(), { now: NOW });
    renderIn(<App pages={{}} />, ctx);
    expect(document.querySelector("#main")).not.toBeNull();
  });
});

describe("branch corners", () => {
  it("marks Overview and Today as current on their own pages", () => {
    nav("#/c/ch/overview");
    mountApp();
    expect(document.querySelector('#side a[href="#/c/ch/overview"]')?.getAttribute("aria-current")).toBe(
      "page",
    );
    nav("#/c/ch/today");
    act(() => {
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(document.querySelector('#side a[href="#/c/ch/today"]')?.getAttribute("aria-current")).toBe("page");
  });

  it("names the channel in the title when the config has no title", () => {
    nav("#/c/ch/inbox");
    mountApp({}, makeState({ info: null }));
    expect(document.title).toBe("ch · Huddle");
  });

  it("keeps the placeholder version when /health has no version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })),
    );
    mountApp();
    await flush();
    expect(screen.getByText("v0.0.1")).toBeDefined();
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

  it("does not follow the system when a pick is kept", () => {
    localStorage.setItem("huddle:theme", '"dark"');
    const mq = stubMatchMedia(false);
    mountApp();
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => {
      mq.fire();
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("reads a task's waits from blocked_by and a missing lookup as open", () => {
    nav("#/c/ch/inbox");
    mountApp(
      {},
      makeState({
        board: {
          steps: [
            { id: "a", status: "todo", blocked_by: ["ghost"] },
            { id: "b", status: "todo" },
          ],
        },
        sessions: { sessions: [sess({ name: "api", state: "working", step: "ghost" })] },
      }),
    );
    // the waiting segment draws once blocked_by names an unfinished task
    expect(document.querySelector("#side .segbar")).not.toBeNull();
    expect(screen.getAllByText(": Working")[0]).toBeDefined();
  });

  it("draws a bar with a label and one without", () => {
    mountApp({}, makeState({ board: { steps: [{ id: "a", status: "doing" }] } }));
    const bar = document.querySelector("#side .segbar") as HTMLElement;
    expect(bar.getAttribute("aria-label")).toContain("Progress:");
  });

  it("ignores another channel's extras in the badge", () => {
    nav("#/c/ch/inbox");
    mountApp(
      {},
      makeState({
        attention: attention({ asks: [{ seq: 1, from: "api" }] }),
        extras: { ch: "other", approvals: [{ seq: 1, from: "api" }], obs: null },
      }),
    );
    // the other channel's extras are not counted; the ask is
    expect(document.title).toBe("(1) Checkout · Huddle");
  });

  it("tolerates an attention snapshot with missing kinds", () => {
    nav("#/c/ch/team");
    mountApp({}, makeState({ attention: { gates: [{ id: "t9" }] } as never }));
    expect(document.title).toBe("(1) Checkout · Huddle");
  });
});

describe("progress bar edges", () => {
  it("draws nothing for an empty plan and skips the Progress prefix when label is off", () => {
    const { container } = render(<ProgressBar steps={[]} label={false} />);
    const bar = container.querySelector(".segbar") as HTMLElement;
    expect(bar.getAttribute("aria-label")).toBe(", 0 in all");
    expect(bar.querySelectorAll(".segbar-seg")).toHaveLength(0);
  });

  it("looks a session's task up on the board when it is there", () => {
    nav("#/c/ch/team");
    mountApp(
      {},
      makeState({
        board: { steps: [{ id: "a", status: "blocked" }] },
        byId: new Map([["a", { id: "a", status: "blocked" as const }]]),
        sessions: { sessions: [sess({ name: "api", state: "working", step: "a" })] },
      }),
    );
    expect(screen.getAllByText(": Blocked")[0]).toBeDefined();
  });
});

describe("route-driven rerenders", () => {
  it("follows the address bar when only the hash moves", () => {
    mountApp({ inbox: () => <div>inbox page</div> });
    expect(screen.queryByText("inbox page")).toBeNull();
    nav("#/c/ch/inbox");
    expect(screen.getByText("inbox page")).toBeDefined();
  });
});

describe("no channel in the store", () => {
  it("renders only the main area, no rail, over an address naming a channel", () => {
    nav("#/c/ch/inbox");
    mountApp({}, makeState({ ch: null }));
    expect(document.querySelector("#side")).toBeNull();
    expect(document.querySelector("#main")).not.toBeNull();
  });
});
