import { screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ToolCallRecord } from "../../src/shared/model.ts";
import type { SessionListItem } from "../../src/store/store.ts";
import { ToolsView } from "../../src/ui/app/views/Tools.tsx";
import type { ClientState } from "../../src/ui/state.ts";
import { makeTool } from "../helpers.ts";
import { renderApp } from "./render.tsx";

const NOW = 1_790_000_000_000;

const MODELS: ClientState["models"] = {
  models: [],
  upstreams: [],
  tools: [
    { name: "Read", count: 4, failures: 0 },
    { name: "Bash", count: 10, failures: 1 },
  ],
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

/** Render the tools view against a session called "app", with the given recent calls. */
function toolsView(tools: ToolCallRecord[], over: Partial<ClientState> = {}) {
  return renderApp(
    <ToolsView />,
    { models: MODELS, tools, sessions: [item("s1", { project: "app" })], ...over },
    NOW,
  );
}

describe("Tools view", () => {
  it("ranks tools by calls with success/failure bars", () => {
    const { container } = renderApp(<ToolsView />, { models: MODELS }, NOW);
    const titles = [...container.querySelectorAll("section h2")].map((el) => el.textContent);
    expect(titles).toEqual(["Most used tools", "Recent calls"]);
    const names = [...container.querySelectorAll("[data-rank-name]")].map((el) => el.textContent);
    expect(names).toEqual(["Bash", "Read"]);
    const metas = [...container.querySelectorAll("[data-rank-meta]")].map((el) => el.textContent);
    expect(metas).toEqual(["10 calls", "4 calls"]);
    const badges = [...container.querySelectorAll(".badge:not(.segment-count)")].map((el) => el.textContent);
    expect(badges).toEqual(["1 failed", "No failures"]);
    const track = container.querySelector(".bar-track");
    // happy-dom serialises the inline style with spaces; compare its tokens, not its spacing
    const segs = [...(track?.children ?? [])].map((seg) =>
      (seg.getAttribute("style") ?? "")
        .replace(/[;\s]+$/, "")
        .replace(/\s*:\s*/g, ":")
        .replace(/;\s*/g, ";"),
    );
    expect(segs).toEqual([
      "width:90.00%;background:var(--series-5)",
      "width:10.00%;background:var(--danger)",
    ]);
    expect(container.querySelector(".empty-title")?.textContent).toBe("No tool calls in this view");
  });

  it("writes a singular rank meta for one call", () => {
    const { container } = renderApp(
      <ToolsView />,
      { models: { models: [], upstreams: [], tools: [{ name: "Grep", count: 1, failures: 0 }] } },
      NOW,
    );
    expect(container.querySelector("[data-rank-meta]")?.textContent).toBe("1 call");
    expect(container.querySelector(".badge")?.textContent).toBe("No failures");
  });

  it("lists recent calls with a result badge and an all/failed filter", async () => {
    const tools = [
      makeTool({ id: "ok", name: "Read", startedAt: NOW - 2_000, ok: true, durationMs: 1_200 }),
      makeTool({
        id: "bad",
        name: "Bash",
        startedAt: NOW - 1_000,
        ok: false,
        agentId: null,
        sessionId: "s1",
      }),
      makeTool({ id: "far", name: "Grep", startedAt: NOW - 3_000, sessionId: "unknown-session-id" }),
      makeTool({ id: "none", name: "Glob", startedAt: NOW - 4_000, sessionId: null as unknown as string }),
    ];
    const { container, act } = toolsView(tools);
    const heads = [...container.querySelectorAll("th")].map((th) => th.textContent);
    expect(heads).toEqual(["Time", "Tool", "Session", "Agent", "Duration", "Result"]);
    const rows = [...container.querySelectorAll("tr")].filter((tr) => tr.className.startsWith("row"));
    expect(rows.map((tr) => tr.className)).toEqual(["row bg-error/5", "row", "row", "row"]);
    const session = rows.map((tr) => tr.children[2]?.textContent);
    expect(session).toEqual(["app", "app", "unknown-", "No session"]);
    expect(rows[0]?.children[3]?.textContent).toBe("main");
    expect(rows[1]?.children[4]?.textContent).toBe("1.2s");
    const results = rows.map((tr) => tr.children[5]?.textContent);
    expect(results).toEqual(["Failed", "Succeeded", "Succeeded", "Succeeded"]);
    const filter = [...container.querySelectorAll('[data-action="tool-filter"]')];
    expect(filter.map((button) => button.textContent)).toEqual(["All4", "Failed1"]);
    expect(container.querySelector(".table-wrap")?.getAttribute("data-key")).toBe("tools-table");
    await userEvent.click(screen.getByRole("button", { name: "Failed 1" }));
    expect(act).toHaveBeenCalledWith("tool-filter", "failed");
    await userEvent.click(screen.getByRole("button", { name: "All 4" }));
    expect(act).toHaveBeenCalledWith("tool-filter", "all");
  });

  it("narrowed to failures says so and shows the empty state once every call passed", () => {
    const tools = [
      makeTool({ id: "ok", name: "Read", startedAt: NOW - 2_000, ok: true }),
      makeTool({ id: "bad", name: "Bash", startedAt: NOW - 1_000, ok: false }),
    ];
    const every = toolsView(tools).container;
    expect(panelMetaOf(every, 1)).toBe("Every call in this view");
    const failed = toolsView(tools, { toolFilter: "failed" }).container;
    expect(panelMetaOf(failed, 1)).toBe("Only the calls that failed");
    expect(failed.querySelectorAll("tr.row")).toHaveLength(1);
    const allGood = toolsView([tools[0] as ToolCallRecord], { toolFilter: "failed" }).container;
    expect(allGood.querySelector(".empty-title")?.textContent).toBe("No failed tool calls");
    expect(allGood.querySelector(".empty-hint")?.textContent).toBe("Every tool call in this view succeeded.");
  });

  it("explains an empty ranking", () => {
    const { container } = renderApp(<ToolsView />, {}, NOW);
    const titles = [...container.querySelectorAll(".empty-title")].map((el) => el.textContent);
    expect(titles).toEqual(["No tool calls yet", "No tool calls in this view"]);
    expect(container.querySelector(".empty-hint")?.textContent).toBe(
      "Tool calls appear once an agent reads, edits or runs something.",
    );
  });

  it("makes every table header a sort button and marks the sorted column", async () => {
    const { container, act } = toolsView([makeTool()], { toolSort: { key: "duration", dir: "desc" } });
    const sorts = [...container.querySelectorAll('[data-action="sort-tools"]')];
    expect(sorts.map((button) => button.getAttribute("data-value"))).toEqual([
      "time",
      "tool",
      "session",
      "agent",
      "duration",
      "result",
    ]);
    const sorted = [...container.querySelectorAll('th[aria-sort="descending"]')].map((th) => th.textContent);
    expect(sorted).toEqual(["Duration"]);
    expect(container.querySelectorAll('th[aria-sort="none"]')).toHaveLength(5);
    expect(sorts[4]?.className).toContain("sort-on");
    expect(sorts[0]?.className).not.toContain("sort-on");
    expect(sorts[4]?.getAttribute("title")).toBe("Sort by duration");
    await userEvent.click(screen.getByRole("button", { name: "Duration" }));
    expect(act).toHaveBeenCalledWith("sort-tools", "duration");
  });

  it("offers a CSV export of what the table shows", async () => {
    const { container, act } = toolsView([makeTool(), makeTool({ id: "b" })]);
    const exportBtn = container.querySelector('[data-action="export"]');
    expect(exportBtn?.getAttribute("data-value")).toBe("tools");
    expect(exportBtn?.textContent).toBe("Export CSV");
    expect(exportBtn?.getAttribute("title")).toBe("Download the 2 rows shown as CSV");
    await userEvent.click(screen.getByRole("button", { name: /Export CSV/ }));
    expect(act).toHaveBeenCalledWith("export", "tools");
  });

  it("shows each call's time in the reader's mode with the other mode as its tooltip", () => {
    const tools = [makeTool({ id: "t", name: "Read", startedAt: NOW - 60_000 })];
    const cell = toolsView(tools).container.querySelector("td.time");
    expect(cell?.textContent).toBe("1m ago");
    expect(cell?.getAttribute("title")).toMatch(/^\d{1,2}:\d{2}/);
    const clock = toolsView(tools, { timeMode: "absolute" }).container.querySelector("td.time");
    expect(clock?.textContent).toMatch(/^\d{1,2}:\d{2}/);
    expect(clock?.getAttribute("title")).toBe("1m ago");
  });
});

/** The panel head's muted count beside the title (the shared Panel's meta slot); `which` picks a panel. */
function panelMetaOf(container: Element, which = 0): string {
  return [...container.querySelectorAll("section h2")][which]?.nextElementSibling?.textContent ?? "";
}
