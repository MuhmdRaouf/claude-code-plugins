import { screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { RequestRecord, Summary } from "../../src/shared/model.ts";
import { ZERO_TOKENS } from "../../src/shared/model.ts";
import type { SessionListItem } from "../../src/store/store.ts";
import { Drawer, latencyTone } from "../../src/ui/app/Drawer.tsx";
import type { ClientState } from "../../src/ui/state.ts";
import { makeAgentView, makeRequest, makeSessionView } from "../helpers.ts";
import { renderApp } from "./render.tsx";

const NOW = 1_800_000_000_000;

const SUMMARY: Summary = {
  sessions: 3,
  liveSessions: 2,
  agents: 7,
  requests: 12_345,
  tokens: { ...ZERO_TOKENS, input: 1_000, output: 1_500 },
  errors: 2,
  toolCalls: 8,
  latencyP50: 41_000,
  latencyP95: 1_000,
  startedAt: NOW - 125_000,
  now: NOW,
};

function item(id: string, over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    project: null,
    cwd: null,
    name: null,
    branch: null,
    repo: null,
    parentSessionId: null,
    startedAt: null,
    endedAt: null,
    live: false,
    status: null,
    activity: {
      bucketMs: 18_750,
      counts: new Array<number>(48).fill(0),
      models: new Array<string>(48).fill(""),
    },
    model: null,
    agentCount: 0,
    liveAgentCount: 0,
    requestCount: 0,
    tokens: 0,
    lastAt: 0,
    external: false,
    title: null,
    ...over,
  };
}

/** The request the inspector details; test 1's shape, overridable per test. */
function pickedRequest(over: Partial<RequestRecord> = {}): RequestRecord {
  return makeRequest({
    id: "a",
    model: "glm-5.3",
    provider: "Z.ai",
    upstream: "http://127.0.0.1:8787",
    latencyMs: 700,
    ts: NOW - 30_000,
    tokens: { ...ZERO_TOKENS, input: 12_345, output: 678, cacheRead: 9_000, cacheWrite: 3 },
    ...over,
  });
}

/** The slide-over with `request` picked and a session for it, unless the state says otherwise. */
function openDrawer(request: RequestRecord, state: Partial<ClientState> = {}) {
  return renderApp(
    <Drawer />,
    {
      request: request.id,
      requests: [request],
      sessions: [item("s1", { project: "app" })],
      summary: SUMMARY,
      ...state,
    },
    NOW,
  );
}

/** The open slide-over's dialog element (present only while a request is picked). */
function dialog(container: ParentNode): HTMLDialogElement {
  const dlg = container.querySelector<HTMLDialogElement>("dialog");
  expect(dlg, "the drawer renders as an open dialog").not.toBeNull();
  return dlg as HTMLDialogElement;
}

/** Value of the stat titled `title` (its number and its description line). */
function stat(root: ParentNode, title: string): { value: string; desc: string } {
  for (const el of root.querySelectorAll<HTMLElement>(".stat")) {
    if (el.querySelector(".stat-title")?.textContent === title) {
      return {
        value: el.querySelector(".stat-value")?.textContent ?? "",
        desc: el.querySelector(".stat-desc")?.textContent ?? "",
      };
    }
  }
  return { value: "", desc: "" };
}

/** The value under the "Where it ran" fact named `label`. */
function fact(root: ParentNode, label: string): string | null {
  for (const dt of root.querySelectorAll("dt")) {
    if (dt.textContent === label) return dt.nextElementSibling?.textContent ?? null;
  }
  return null;
}

/** The tokens table, row by row, as the panel renders it. */
function tokenRows(root: ParentNode): string[] {
  const table = [...root.querySelectorAll("section")].find(
    (panel) => panel.querySelector("h2")?.textContent === "Tokens",
  );
  return [...(table?.querySelectorAll<HTMLElement>("tbody tr") ?? [])].map((row) => row.textContent);
}

describe("latencyTone", () => {
  it("draws the tone lines at 60% and 80% of the view's p95", () => {
    expect(latencyTone(0.59)).toBe("ok");
    expect(latencyTone(0.6)).toBe("warn");
    expect(latencyTone(0.79)).toBe("warn");
    expect(latencyTone(0.8)).toBe("err");
  });
});

describe("Drawer", () => {
  it("opens the picked request as a big slide-over whose header names the call", () => {
    const { container } = openDrawer(pickedRequest());
    const dlg = dialog(container);
    expect(dlg.getAttribute("aria-label")).toBe("Request details");
    expect(dlg.classList.contains("modal-end")).toBe(true);
    expect(dlg.getAttribute("open")).not.toBeNull();
    // the header: model chip, agent, stop reason, then the time and session muted underneath
    const header = dlg.querySelector("#drawer-title");
    expect(header?.textContent).toContain("GLM 5.3");
    expect(header?.textContent).toContain("Main");
    expect(header?.textContent).toContain("No stop reason");
    expect(header?.textContent).toContain("30s ago");
    expect(header?.textContent).toContain("app");
    // the width is the brief's: most of a wide screen, all of a narrow one
    expect(dlg.querySelector("[data-slide-over]")?.className).toContain("w-[min(68rem,94vw)]");
  });

  it("sizes the call up with four stats, the latency one judged against the view's p95", () => {
    const { container } = openDrawer(pickedRequest());
    const dlg = dialog(container);
    const latency = stat(dlg, "Latency");
    expect(latency.value).toBe("700ms");
    expect(latency.desc).toContain("Slower than most");
    expect(latency.desc).toContain("Measured against the view's p95 of 1s.");
    expect(stat(dlg, "Total tokens").value).toBe("22,026");
    expect(stat(dlg, "Total tokens").desc).toBe("12,345 in, 678 out");
    // the whole stats strip sits on the shared panel surface
    expect(dlg.querySelector(".stats")?.classList.contains("panel")).toBe(true);
  });

  it("shows the cost with the conditions that shaped it, or the words for no price", () => {
    // a glm request through a loopback router still prices: the model id alone names one offering
    const priced = openDrawer(pickedRequest());
    expect(stat(dialog(priced.container), "Est. cost").value).toBe("$0.02");
    expect(stat(dialog(priced.container), "Est. cost").desc).toBe("Z.ai list");
    priced.unmount();
    const unpriced = openDrawer(pickedRequest({ model: "env-local-model" }));
    expect(stat(dialog(unpriced.container), "Est. cost").value).toBe("tokens only");
    expect(stat(dialog(unpriced.container), "Est. cost").desc).toBe("No list price for this model.");
  });

  it("shows a request still streaming as a Streaming badge and a pending cost", () => {
    openDrawer(
      pickedRequest({
        id: "live",
        stopReason: null,
        tokens: { input: 143_860, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    );
    const dlg = dialog(document.body);
    const badges = [...dlg.querySelectorAll(".badge")].map((badge) => badge.textContent);
    expect(badges).toContain("Streaming");
    expect(stat(dlg, "Est. cost").value).toContain("pending");
    // not the idle "No stop reason": the request is still running
    expect(badges).not.toContain("No stop reason");
  });

  it("breaks the thinking share of the output out in the tokens table when the provider reports it", () => {
    openDrawer(
      pickedRequest({
        id: "think",
        tokens: { input: 10, output: 500, cacheRead: 3, cacheWrite: 2, thinking: 320 },
      }),
    );
    const rows = tokenRows(dialog(document.body));
    expect(rows).toEqual([
      "Input101.94%",
      "Output50097%",
      "Cache read30.58%",
      "Cache write (5 min)20.39%",
      "Thinking (of output)32062%",
      "Total515100%",
    ]);
  });

  it("draws the token mix as one stacked bar with a legend, then kind, tokens and share per row", () => {
    const { container } = openDrawer(pickedRequest());
    const dlg = dialog(container);
    expect(dlg.querySelectorAll(".bar-seg")).toHaveLength(4); // every reported kind carries a segment
    const first = dlg.querySelector<HTMLElement>(".bar-seg");
    expect(first?.getAttribute("style")?.replace(/\s+/g, "")).toContain("background:var(--color-info)");
    expect(tokenRows(dlg)).toEqual([
      "Input12,34556%",
      "Output6783.08%",
      "Cache read9,00041%",
      "Cache write (5 min)30.01%",
      "Total22,026100%",
    ]);
    const legend = [...dlg.querySelectorAll("section")]
      .find((panel) => panel.querySelector("h2")?.textContent === "Tokens")
      ?.querySelector(".gap-x-5");
    expect(legend?.textContent).toContain("Input");
    expect(legend?.textContent).toContain("12,345");
  });

  it("says where the call ran: session, agent, project, route, upstream and provider", async () => {
    const { container, act } = openDrawer(pickedRequest({ id: "w", agentId: "w1" }), {
      details: {
        s1: makeSessionView({
          agents: [makeAgentView({ id: "w1", kind: "subagent", name: "Explore — find the flaky test" })],
        }),
      },
    });
    const dlg = dialog(container);
    expect(fact(dlg, "Session")).toBe("app");
    expect(fact(dlg, "Agent")).toContain("Explore — find the flaky test");
    expect(fact(dlg, "Project")).toBe("app");
    expect(fact(dlg, "Through")).toBe("Direct");
    expect(fact(dlg, "Upstream")).toBe("127.0.0.1:8787");
    expect(fact(dlg, "Provider")).toBe("Z.ai");
    // the agent's name carries its id on hover, and a soft button narrows the view to that agent
    const name = [...dlg.querySelectorAll<HTMLElement>("dd span")].find(
      (span) => span.textContent === "Explore — find the flaky test",
    );
    expect(name?.getAttribute("title")).toBe("w1");
    const scope = screen.getByRole("button", { name: "Show this agent's requests" });
    expect(scope.className).toContain("btn-soft");
    expect(scope.getAttribute("data-action")).toBe("scope-agent");
    await userEvent.click(scope);
    expect(act).toHaveBeenCalledWith("scope-agent", JSON.stringify({ sessionId: "s1", agentId: "w1" }));
  });

  it("opens a history scope's row the live list never held, from the page the scope fetched", () => {
    const history = pickedRequest({ id: "req-history", ts: NOW - 3_600_000 });
    const { container } = openDrawer(history, {
      requests: [], // the /api/requests backfill never reached back this far
      historyScope: { rootId: "s1/main", nodeId: null },
      historyRequests: [history],
    });
    expect(fact(dialog(container), "Provider")).toBe("Z.ai"); // the picked row's own record rendered
  });

  it("names the Session fact after the session itself, the Project fact after the folder", () => {
    const { container } = openDrawer(pickedRequest(), {
      sessions: [item("s1", { project: "app", name: "Nightly sweep" })],
    });
    const dlg = dialog(container);
    expect(fact(dlg, "Session")).toBe("Nightly sweep");
    expect(fact(dlg, "Project")).toBe("app");
  });

  it("names fast and slow requests in words, and falls back to raw ids without a session row", () => {
    const at = (latencyMs: number) =>
      openDrawer(pickedRequest({ id: "x", latencyMs, stopReason: "end_turn" }), { sessions: [] });
    const fast = at(100);
    const fastDlg = dialog(fast.container);
    expect(stat(fastDlg, "Latency").desc).toContain("Fast for this view");
    expect(fact(fastDlg, "Session")).toBe("s1");
    expect(fact(fastDlg, "Project")).toBe("–");
    expect([...fastDlg.querySelectorAll(".badge")].map((b) => b.textContent)).toContain("end_turn");
    fast.unmount();

    const slow = at(900);
    expect(stat(dialog(slow.container), "Latency").desc).toContain("Among the slowest");
  });

  it("shows an HTTP status the router recorded instead of a stop reason badge", () => {
    openDrawer(pickedRequest({ stopReason: "429" }));
    const badges = [...dialog(document.body).querySelectorAll(".badge")].map((badge) => badge.textContent);
    expect(badges).toContain("HTTP 429");
    expect(badges).not.toContain("No stop reason");
  });

  it("counts the failed attempts the view holds just before the request as its retries, and warns", () => {
    const at = (seconds: number) =>
      makeRequest({
        id: `f${seconds}`,
        sessionId: "s1",
        agentId: "main",
        ts: NOW - 30_000 - seconds * 1000,
        stopReason: "429",
      });
    const fresh = openDrawer(pickedRequest(), { requests: [pickedRequest(), at(10), at(20), at(200)] });
    const dlg = dialog(fresh.container);
    expect(stat(dlg, "Retries").value).toBe("2");
    expect(stat(dlg, "Retries").desc).toBe("2 within 2 min (429)");
    expect(dlg.querySelector(".alert-warning")?.textContent).toContain("2 within 2 min (429)");
    expect(dlg.querySelector(".alert-warning")?.getAttribute("role")).toBe("alert");
    fresh.unmount();
    const quiet = openDrawer(pickedRequest());
    expect(stat(dialog(quiet.container), "Retries")).toEqual({ value: "0", desc: "None recorded" });
    expect(quiet.container.querySelector(".alert-warning")).toBeNull();
  });

  it("keeps the identifiers on hand with one copy button each", () => {
    const { container } = openDrawer(pickedRequest());
    const dlg = dialog(container);
    const codes = [...dlg.querySelectorAll("code")].map((code) => code.textContent);
    expect(codes).toContain("s1");
    expect(codes).toContain("a");
    expect(screen.getByRole("button", { name: "Copy session id" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy request id" })).toBeTruthy();
  });

  it("renders nothing at all without a picked request", () => {
    const { container } = renderApp(<Drawer />, {}, NOW);
    expect(container.querySelector("dialog")).toBeNull();
  });

  it("keeps the five tabs with the controller's actions, counting a side's blocks when held", async () => {
    const plain = openDrawer(pickedRequest());
    const tabs = [...dialog(plain.container).querySelectorAll("[data-action='drawer-tab']")];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Overview", "Input", "Output", "Context", "Raw"]);
    expect(tabs[0]?.className).toContain("tab-active");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("data-value")).toBe("input");
    // each tab wears its icon
    expect(tabs.every((tab) => tab.querySelector("svg") !== null)).toBe(true);
    plain.unmount();

    const counted = openDrawer(pickedRequest(), {
      content: {
        a: { status: "ready", input: [{ type: "text", text: "x" }], output: null, bytes: 9 },
      },
    });
    const countedTabs = [...dialog(counted.container).querySelectorAll("[data-action='drawer-tab']")];
    expect(countedTabs[1]?.textContent).toContain("1");
    expect(countedTabs[2]?.textContent).toContain("0");
    await userEvent.click(countedTabs[3] as HTMLElement);
    expect(counted.act).toHaveBeenCalledWith("drawer-tab", "context");
  });

  it("steps through the scope's requests from the header, newest first", async () => {
    const { act, container } = openDrawer(pickedRequest(), {
      requests: [pickedRequest(), makeRequest({ id: "older", ts: 1_000 })],
    });
    const dlg = dialog(container);
    const newer = screen.getByRole("button", { name: "Newer request (K)" });
    const older = screen.getByRole("button", { name: "Older request (J)" });
    expect((newer as HTMLButtonElement).disabled).toBe(true); // nothing newer in the scope
    expect((older as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(older);
    expect(act).toHaveBeenCalledWith("next-request");
    expect(dlg.querySelector("[data-action='prev-request']")).not.toBeNull();
  });

  it("closes from the slide-over's own close path, back through the controller's close action", async () => {
    const { act, container } = openDrawer(pickedRequest());
    // the X and the backdrop both answer to "Close"; the X comes first in the dialog
    const x = screen.getAllByRole("button", { name: "Close" })[0];
    expect(x).toBeTruthy();
    await userEvent.click(x as HTMLElement);
    expect(act).toHaveBeenCalledWith("close-drawer");
    // unmounting is the state's job; the dialog itself has already dropped its open flag
    expect(dialog(container).getAttribute("open")).toBeNull();
  });

  it("offers the whole record as JSON from the header", () => {
    const { container } = openDrawer(pickedRequest(), {
      content: { a: { status: "ready", input: "in", output: "out", bytes: 4 } },
    });
    dialog(container);
    expect(screen.getByRole("button", { name: "Copy as JSON" })).toBeTruthy();
  });
});
