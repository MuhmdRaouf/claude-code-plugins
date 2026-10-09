import { screen, within } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppContext } from "../../src/ui/app/context.ts";
import { isProviderModel, newSince, RequestsView, viaText } from "../../src/ui/app/views/Requests.tsx";
import { type ClientState, initialClientState } from "../../src/ui/state.ts";
import { makeAgentView, makeRequest, makeSessionView } from "../helpers.ts";
import { renderApp } from "./render.tsx";

const NOW = 1_790_000_000_000;

/** The indexed item; throws instead of letting `noUncheckedIndexedAccess` turn into an undefined deref. */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at index ${index}`);
  return item;
}

function drawerRows(container: Element): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('tr[data-action="drawer"]')];
}

/** The panel head's muted count beside the title (the shared Panel's meta slot). */
function panelMeta(container: Element): string {
  return container.querySelector("section h2")?.nextElementSibling?.textContent ?? "";
}

function requestsState(over: Partial<ClientState> = {}): Partial<ClientState> {
  return {
    requests: [
      makeRequest({ id: "r-fresh", ts: NOW - 1_000, stopReason: "end_turn" }),
      makeRequest({ id: "r-old", ts: NOW - 10_000 }),
    ],
    ...over,
  };
}

describe("requests view", () => {
  it("tabulates every column with formatted cells and drawer-targeted rows", async () => {
    const { container, act } = renderApp(<RequestsView />, requestsState({ request: "r-old" }), NOW);
    const heads = [...container.querySelectorAll("th")];
    expect(heads.map((th) => th.textContent)).toEqual([
      "Time",
      "Agent",
      "What",
      "Model",
      "Status",
      "Latency",
      "Input",
      "Output",
      "Cache read",
      "Cache write",
      "Est. cost",
    ]);
    expect(heads.filter((th) => th.className.endsWith("num text-right"))).toHaveLength(7);
    const rows = drawerRows(container);
    expect(rows.map((row) => row.className)).toEqual([
      "row row-new cursor-pointer transition-colors hover:bg-base-200/50",
      "row bg-primary/8 cursor-pointer transition-colors hover:bg-base-200/50",
    ]);
    expect(at(rows, 1).className).toContain("bg-primary/8"); // the open row
    expect(at(rows, 1).querySelector("td")?.className).toContain(
      "shadow-[inset_3px_0_0_0_var(--color-primary)]",
    );
    expect(rows.map((row) => row.getAttribute("tabindex"))).toEqual(["0", "0"]);
    expect(at(rows, 1).getAttribute("aria-label")).toMatch(
      /^claude-sonnet-5-5 at \d{2}:\d{2}:\d{2}, open details$/,
    );
    expect(at(rows, 1).getAttribute("data-value")).toBe("r-old");
    const cells = within(at(rows, 1)).getAllByRole("cell");
    expect(at(cells, 0).textContent).toBe("10s ago"); // relative by default
    expect(at(cells, 0).getAttribute("title")).toMatch(/^\d{1,2}:\d{2}/); // the wall clock on hover
    expect(at(cells, 1).textContent).toBe("Main"); // the main agent by name, its id on hover
    expect(at(cells, 1).getAttribute("title")).toBe("main");
    expect(at(cells, 2).textContent).toBe("–"); // nothing captured, so no `what`
    expect(at(cells, 3).textContent).toBe("Sonnet 5.5"); // ModelChip short name, raw id on the chip's title
    expect(at(cells, 3).querySelector(".model-chip")?.getAttribute("title")).toBe("claude-sonnet-5-5");
    expect(at(cells, 4).textContent).toBe("–"); // no HTTP status recorded: the call succeeded
    expect(at(cells, 5).textContent).toBe("100ms");
    expect(at(cells, 5).className).toBe("num text-right");
    expect(at(cells, 6).textContent).toBe("10");
    expect(at(cells, 10).textContent).toMatch(/^[$<–]/); // priced from the record, or a dash when not
    expect(container.querySelector(".table-wrap")?.getAttribute("data-key")).toBe("requests-table");
    expect(panelMetaOf(container)).toBe("2 in this view");

    await userEvent.click(at(rows, 1));
    expect(act).toHaveBeenCalledWith("drawer", "r-old");
  });

  it("shows a failed request's HTTP status as a red badge, its reason on hover", () => {
    const { container } = renderApp(
      <RequestsView />,
      {
        requests: [
          makeRequest({
            id: "r-fail",
            ts: NOW - 1_000,
            stopReason: "502",
            error: "connection failed (ECONNREFUSED)",
          }),
        ],
      },
      NOW,
    );
    const cell = at(within(at(drawerRows(container), 0)).getAllByRole("cell"), 4);
    expect(cell.textContent).toBe("HTTP 502");
    expect(cell.querySelector(".badge-error")).toBeTruthy();
    expect(cell.querySelector(".badge")?.getAttribute("title")).toBe("connection failed (ECONNREFUSED)");
  });

  it("shows a request's what line with its full text on hover, and the unknowns as dashes", () => {
    const { container } = renderApp(
      <RequestsView />,
      {
        requests: [
          makeRequest({
            id: "r-what",
            ts: NOW - 1_000,
            what: "↳ prompt: fix the limiter  → Edit store.ts, Bash git status",
          }),
          makeRequest({ id: "r-bare", ts: NOW - 2_000, agentId: "agent-a6aca2" }),
        ],
      },
      NOW,
    );
    const what = at(within(at(drawerRows(container), 0)).getAllByRole("cell"), 2);
    expect(what.textContent).toBe("Prompt: Edit store.ts, Bash git status");
    expect(what.querySelector(".text-primary")?.textContent).toBe("Prompt: ");
    expect(what.getAttribute("title")).toBe("↳ prompt: fix the limiter  → Edit store.ts, Bash git status");
    const bare = at(within(at(drawerRows(container), 1)).getAllByRole("cell"), 2);
    expect(bare.textContent).toBe("–");
    expect(bare.getAttribute("title")).toBeNull();
    // a subagent still shows as its raw id until the session's own agents arrive
    const agent = at(within(at(drawerRows(container), 1)).getAllByRole("cell"), 1);
    expect(agent.textContent).toBe("agent-a6aca2");
    expect(agent.getAttribute("title")).toBe("agent-a6aca2");
  });

  it("names an agent after its session's own agents, live or in a history tree", () => {
    const sub = makeAgentView({ id: "w1", kind: "subagent", name: "Explore — find the flaky test" });
    const { container } = renderApp(
      <RequestsView />,
      {
        requests: [makeRequest({ id: "r1", ts: NOW - 1_000, agentId: "w1" })],
        details: { s1: makeSessionView({ id: "s1", agents: [sub] }) },
      },
      NOW,
    );
    const agent = at(within(at(drawerRows(container), 0)).getAllByRole("cell"), 1);
    expect(agent.textContent).toBe("Explore — find the flaky test");
    expect(agent.getAttribute("title")).toBe("w1");
  });

  it("shows a still-streaming request as pending, never priced", () => {
    const { container } = renderApp(
      <RequestsView />,
      {
        requests: [
          makeRequest({
            id: "r-live",
            ts: NOW - 1_000,
            stopReason: null,
            tokens: { input: 143_860, output: 0, cacheRead: 0, cacheWrite: 0 },
          }),
        ],
      },
      NOW,
    );
    const cells = within(at(drawerRows(container), 0)).getAllByRole("cell");
    expect(at(cells, 10).textContent).toBe("pending");
    expect(container.querySelector(".loading")).toBeNull(); // no fake streaming chrome in the row
  });

  it("opens the drawer from the keyboard, on Enter and Space alone", async () => {
    const { container, act } = renderApp(<RequestsView />, requestsState({ request: null }), NOW);
    const row = at(drawerRows(container), 0);
    row.focus();
    await userEvent.keyboard("{Enter}");
    expect(act).toHaveBeenCalledWith("drawer", "r-fresh");
    await userEvent.keyboard("{space}");
    expect(act).toHaveBeenCalledWith("drawer", "r-fresh");
    const opened = act.mock.calls.length;
    await userEvent.keyboard("a"); // any other key leaves the drawer closed
    expect(act.mock.calls.length).toBe(opened);
  });

  it("shows the clock in the time cell in absolute mode, with the age as its tooltip", () => {
    const { container } = renderApp(<RequestsView />, requestsState({ timeMode: "absolute" }), NOW);
    const timeCell = at(within(at(drawerRows(container), 1)).getAllByRole("cell"), 0);
    expect(timeCell.textContent).toMatch(/^\d{1,2}:\d{2}/);
    expect(timeCell.getAttribute("title")).toBe("10s ago");
  });

  it("flashes only requests from the last second and a half", () => {
    const { container } = renderApp(
      <RequestsView />,
      {
        requests: [
          makeRequest({ id: "edge-in", ts: NOW - 1_500 }),
          makeRequest({ id: "edge-out", ts: NOW - 1_501 }),
        ],
        request: null,
      },
      NOW,
    );
    expect(drawerRows(container).map((row) => row.className)).toEqual([
      "row row-new cursor-pointer transition-colors hover:bg-base-200/50",
      "row cursor-pointer transition-colors hover:bg-base-200/50",
    ]);
  });

  it("offers a model filter once more than one model is in view, and narrows the table by it", async () => {
    const mixed = {
      requests: [
        makeRequest({ id: "a", ts: NOW - 5_000 }),
        makeRequest({ id: "b", ts: NOW - 6_000, model: "glm-5.3", provider: "Z.ai" }),
        makeRequest({ id: "c", ts: NOW - 7_000, model: "glm-5.3", provider: "Z.ai" }),
      ],
    };
    const { container, act } = renderApp(<RequestsView />, mixed, NOW);
    const chips = [...container.querySelectorAll<HTMLButtonElement>('button[data-action="model"]')];
    expect(chips.map((chip) => chip.getAttribute("data-value"))).toEqual([
      "",
      "glm-5.3",
      "claude-sonnet-5-5",
    ]);
    expect(chips.map((chip) => chip.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(
      [...container.querySelectorAll('button[data-action="model"] span.num')].map((c) => c.textContent),
    ).toEqual(["2", "1"]);
    // a provider model's rows say whose model it is; Claude rows do not repeat "Anthropic"
    expect([...container.querySelectorAll(".model-provider")].map((name) => name.textContent)).toEqual([
      "Z.ai",
      "Z.ai",
    ]);
    await userEvent.click(at(chips, 0));
    expect(act).toHaveBeenLastCalledWith("model", "");
    await userEvent.click(at(chips, 1));
    expect(act).toHaveBeenLastCalledWith("model", "glm-5.3");

    const narrowed = renderApp(<RequestsView />, { ...mixed, model: "glm-5.3" }, NOW);
    expect(drawerRows(narrowed.container).map((row) => row.getAttribute("data-value"))).toEqual(["b", "c"]);

    renderApp(<RequestsView />, { ...mixed, model: "kimi-k3" }, NOW);
    expect(screen.getByText("No kimi-k3 requests in this view")).toBeTruthy();
  });

  it("offers no model filter while a single model is in view", () => {
    const { container } = renderApp(<RequestsView />, requestsState(), NOW);
    expect(container.querySelectorAll('button[data-action="model"]')).toHaveLength(0);
  });

  it("caps the table at the newest 300 and says so", () => {
    const many = Array.from({ length: 305 }, (_, i) => makeRequest({ id: `r${i}`, ts: NOW - 10_000 - i }));
    const { container } = renderApp(<RequestsView />, { requests: many }, NOW);
    expect(drawerRows(container)).toHaveLength(300);
    expect(panelMeta(container)).toBe("Newest 300 of 305");
  });

  it("shows the empty state before any request streams in", () => {
    renderApp(<RequestsView />, {}, NOW);
    expect(screen.getByText("No requests in this view yet")).toBeTruthy();
  });
});

describe("new requests pill", () => {
  /** Re-render the live panel with a modified state against the same container. */
  function rerenderWith(first: ReturnType<typeof renderApp>, state: Partial<ClientState>): void {
    first.rerender(
      <AppContext.Provider
        value={{
          state: { ...initialClientState(), ...state },
          now: NOW,
          url: "127.0.0.1:4000",
          act: first.act,
        }}
      >
        <RequestsView />
      </AppContext.Provider>,
    );
  }

  it("counts arrivals once the reader scrolls away and resets when they jump back", async () => {
    const first = renderApp(<RequestsView />, requestsState({ request: null }), NOW);
    expect(screen.queryByRole("button", { name: /new request/ })).toBeNull();

    // the reader scrolls the table wrap down
    const wrap = first.container.querySelector(".table-wrap");
    expect(wrap).toBeTruthy();
    (wrap as HTMLElement).scrollTop = 40;
    (wrap as HTMLElement).dispatchEvent(new Event("scroll"));

    // a newer request lands while they are away: the pill appears at the table top
    const arrived = [
      makeRequest({ id: "r-new1", ts: NOW - 500 }),
      makeRequest({ id: "r-fresh", ts: NOW - 1_000, stopReason: "end_turn" }),
      makeRequest({ id: "r-old", ts: NOW - 10_000 }),
    ];
    rerenderWith(first, { request: null, requests: arrived });
    const pill = screen.getByRole("button", { name: "1 new request, jump to newest" });
    expect(pill.className).toContain("btn-primary");
    expect(pill.className).toContain("btn-block");

    // jumping back clears the count
    await userEvent.click(pill);
    expect(screen.queryByRole("button", { name: /new request/ })).toBeNull();
  });

  it("counts arrivals while a row is open", () => {
    const first = renderApp(<RequestsView />, requestsState({ request: "r-old" }), NOW);
    expect(screen.queryByRole("button", { name: /new request/ })).toBeNull();

    const arrived = [
      makeRequest({ id: "r-new1", ts: NOW - 500 }),
      makeRequest({ id: "r-new2", ts: NOW - 700 }),
      makeRequest({ id: "r-fresh", ts: NOW - 1_000, stopReason: "end_turn" }),
      makeRequest({ id: "r-old", ts: NOW - 10_000 }),
    ];
    rerenderWith(first, requestsState({ request: "r-old", requests: arrived }));
    expect(screen.getByRole("button", { name: "2 new requests, jump to newest" })).toBeTruthy();
  });

  it("counts only requests newer than the held moment (newSince)", () => {
    const requests = [
      makeRequest({ id: "a", ts: 300 }),
      makeRequest({ id: "b", ts: 200 }),
      makeRequest({ id: "c", ts: 100 }),
    ];
    expect(newSince(requests, null)).toBe(0);
    expect(newSince(requests, 200)).toBe(1);
    expect(newSince(requests, 0)).toBe(3);
  });
});

describe("requests sorting and export", () => {
  it("makes every table header a sort button and marks the sorted column", async () => {
    const { container, act } = renderApp(
      <RequestsView />,
      { requests: [makeRequest({ id: "a", ts: NOW - 1_000 })] },
      NOW,
    );
    const sorts = [...container.querySelectorAll<HTMLButtonElement>('button[data-action="sort-requests"]')];
    expect(sorts.map((button) => button.getAttribute("data-value"))).toEqual([
      "time",
      "agent",
      "what",
      "model",
      "status",
      "latency",
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "cost",
    ]);
    const heads = [...container.querySelectorAll("th")];
    expect(heads.map((th) => th.getAttribute("aria-sort"))).toEqual([
      "descending",
      ...Array.from({ length: 10 }, () => "none"),
    ]);
    expect(at(heads, 0).querySelector('svg[data-icon="chevronDown"]')).toBeTruthy();
    expect(at(heads, 1).querySelector('svg[data-icon="chevronsUpDown"]')).toBeTruthy();
    expect(at(sorts, 0).className).toContain("sort-on");
    expect(at(sorts, 0).querySelector("svg.text-primary")).toBeTruthy(); // the sorted column's arrow
    expect(at(sorts, 1).className).not.toContain("sort-on");
    expect(at(sorts, 5).getAttribute("title")).toBe("Sort by latency");
    await userEvent.click(at(sorts, 3));
    expect(act).toHaveBeenCalledWith("sort-requests", "model");

    const byModel = renderApp(
      <RequestsView />,
      { requests: [makeRequest({ id: "a", ts: NOW - 1_000 })], requestSort: { key: "model", dir: "asc" } },
      NOW,
    );
    const modelHead = at([...byModel.container.querySelectorAll("th")], 3);
    expect(modelHead.getAttribute("aria-sort")).toBe("ascending");
    expect(modelHead.querySelector('svg[data-icon="chevronUp"]')).toBeTruthy();
  });

  it("offers a CSV export of what the table shows", async () => {
    const { container, act } = renderApp(<RequestsView />, { requests: [makeRequest()] }, NOW);
    const button = at([...container.querySelectorAll<HTMLButtonElement>('button[data-action="export"]')], 0);
    expect(button.getAttribute("data-value")).toBe("requests");
    expect(button.textContent).toBe("Export CSV");
    expect(button.getAttribute("title")).toBe("Download the 1 row shown as CSV");
    await userEvent.click(button);
    expect(act).toHaveBeenCalledWith("export", "requests");
  });
});

describe("requests pure helpers", () => {
  it("marks provider-served models, not Anthropic or unknown providers", () => {
    expect(isProviderModel("Z.ai")).toBe(true);
    expect(isProviderModel("Anthropic")).toBe(false);
    expect(isProviderModel("other")).toBe(false);
    expect(isProviderModel("")).toBe(false);
  });
});

describe("upstream and router", () => {
  // the table no longer carries an Upstream column; the fact lives in the drawer (R-drawer's lane)
  it("words the way a request went, for the drawer's overview", () => {
    expect(viaText(undefined)).toBeNull();
    expect(viaText("kimi")).toBe("via kimi router");
    expect(viaText("[::1]:9000")).toBe("via router at [::1]:9000");
  });
});

/** The panel head's muted count beside the title (the shared Panel's meta slot). */
function panelMetaOf(container: Element): string {
  return container.querySelector("section h2")?.nextElementSibling?.textContent ?? "";
}
