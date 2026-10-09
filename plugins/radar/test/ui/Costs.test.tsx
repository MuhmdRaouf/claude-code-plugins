import { screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AttributionNode } from "../../src/cost/attribution.ts";
import { ZERO_TOKENS } from "../../src/shared/model.ts";
import { CostsView, providerSpend, totalText } from "../../src/ui/app/views/Costs.tsx";
import { costText } from "../../src/ui/fmt.ts";
import { renderApp } from "./render.tsx";

const NOW = 1_800_000_000_000;

const at = (over: Partial<AttributionNode>): AttributionNode => ({
  kind: "model",
  key: "m",
  label: "m",
  note: null,
  requests: 1,
  tokens: { ...ZERO_TOKENS },
  costUsd: null,
  unpriced: 0,
  mix: [],
  children: [],
  ...over,
});

const GLM = at({
  key: "glm-5.3",
  label: "glm-5.3",
  requests: 3,
  tokens: { ...ZERO_TOKENS, input: 10 },
  costUsd: 2,
  unpriced: 1,
  mix: [{ model: "glm-5.3", tokens: 10 }],
});
const CLAUDE = at({ key: "claude-x", label: "claude-x", mix: [{ model: "claude-x", tokens: 4 }] });
const KIMI = at({
  key: "kimi-k3",
  label: "kimi-k3",
  requests: 2,
  costUsd: 5,
  mix: [{ model: "kimi-k3", tokens: 8 }],
});
const MAIN = at({
  kind: "agent",
  key: "s1:main",
  label: "main",
  requests: 3,
  tokens: { ...ZERO_TOKENS, input: 10 },
  costUsd: 2,
  unpriced: 1,
  mix: [{ model: "glm-5.3", tokens: 10 }],
  children: [GLM],
});
const READER = at({
  kind: "agent",
  key: "s1:w1",
  label: "read around",
  note: "Explore",
  costUsd: null,
  unpriced: 1,
  mix: [{ model: "claude-x", tokens: 4 }],
  children: [CLAUDE],
});
const RUNNER = at({
  kind: "agent",
  key: "j1:main",
  label: "runner",
  requests: 2,
  costUsd: 5,
  mix: [{ model: "kimi-k3", tokens: 8 }],
  children: [KIMI],
});
const FIX_IT = at({
  kind: "session",
  key: "s1",
  label: "fix it",
  requests: 4,
  costUsd: 2,
  unpriced: 2,
  mix: [
    { model: "glm-5.3", tokens: 10 },
    { model: "claude-x", tokens: 4 },
  ],
  children: [MAIN, READER],
});
const JOB = at({
  kind: "session",
  key: "j1",
  label: "the job",
  requests: 2,
  costUsd: 5,
  mix: [{ model: "kimi-k3", tokens: 8 }],
  children: [RUNNER],
});
const REPO = at({
  kind: "repo",
  key: "/w/app",
  label: "~/app",
  requests: 6,
  tokens: { ...ZERO_TOKENS, input: 22 },
  costUsd: 7,
  unpriced: 2,
  mix: [
    { model: "kimi-k3", tokens: 8 },
    { model: "glm-5.3", tokens: 10 },
    { model: "claude-x", tokens: 4 },
  ],
  // the flat order on purpose: sorting is the view's job, and the first test asserts it
  children: [FIX_IT, JOB],
});
const TREE = [REPO];

describe("cost text", () => {
  it("says unpriced when nothing has a price, else the estimate", () => {
    expect(costText(null)).toBe("unpriced");
    expect(costText(undefined)).toBe("unpriced");
    expect(costText(1)).toBe("est. $1.00");
  });
});

describe("cost total split", () => {
  it("names each provider once more than one is priced, and stays plain for a single one", () => {
    expect(totalText(null, [])).toBe("unpriced");
    expect(totalText(2, [{ family: "GLM", usd: 2 }])).toBe("est. $2.00");
    expect(
      totalText(41.2, [
        { family: "Claude", usd: 33.29 },
        { family: "GLM", usd: 7.91 },
      ]),
    ).toBe("est. $41.20 (Claude $33.29 list price, GLM $7.91)");
  });

  it("sums a tree's priced model rows into per-family parts, heaviest first", () => {
    expect(providerSpend(TREE)).toEqual([
      { family: "Kimi", usd: 5 },
      { family: "GLM", usd: 2 },
    ]);
  });
});

describe("CostsView", () => {
  it("says loading while the ledger is on its way", () => {
    const { container } = renderApp(<CostsView />, {}, NOW);
    expect(screen.getByText("Loading")).toBeTruthy();
    expect(screen.getByText("Adding up the usage ledger…")).toBeTruthy();
    expect(container.querySelector("table")).toBeNull();
    expect(panelMetaOf(container)).toBe("Loading");
  });

  it("shows an empty period when nothing was spent", () => {
    renderApp(<CostsView />, { attributionTree: [] }, NOW);
    expect(screen.getByText("Nothing spent in this period")).toBeTruthy();
    expect(screen.getByText("Today: unpriced, 0 requests, 0 tokens")).toBeTruthy();
  });

  it("drills down by default: repo, then sessions by spend, agents, models, each with a mix bar", () => {
    const { container } = renderApp(<CostsView />, { attributionTree: TREE }, NOW);
    const names = [...container.querySelectorAll(".attr-name")].map((n) => n.textContent);
    expect(names).toEqual([
      "~/app",
      "the job",
      "runner",
      "kimi-k3",
      "fix it",
      "main",
      "GLM 5.3",
      "read around",
      "claude-x",
    ]);
    expect(panelMetaOf(container)).toBe(
      "Today: est. $7.00 (Kimi $5.00 list price, GLM $2.00), 6 requests, 22 tokens",
    );
    // the footnote prices Claude at list and says what a subscription may already cover
    expect(container.textContent).toContain("A Claude subscription may cover");
    expect(screen.getAllByText("tokens only")).toHaveLength(2); // the agent row and its model
    // one bar per row, one segment per model behind it
    expect(container.querySelectorAll(".attr-mix .bar-track")).toHaveLength(9);
    expect(container.querySelectorAll(".attr-mix .bar-seg")).toHaveLength(12);
    expect(container.querySelector(".attr-note")?.textContent).toBe("Explore");
    const sorts = [...container.querySelectorAll("[data-action='sort-attribution']")].map((b) =>
      b.getAttribute("data-value"),
    );
    expect(sorts).toEqual(["label", "requests", "input", "output", "cacheRead", "cacheWrite", "cost"]);
    expect(container.querySelectorAll("[data-action='attribution-range']")).toHaveLength(3);
    expect(container.querySelectorAll("[data-value='attribution']")).toHaveLength(1);
    // deeper rows indent one step per level
    const depths = [...container.querySelectorAll("td.attr-label")].map(
      (td) => ((td as HTMLElement).getAttribute("style")?.match(/padding-left:\s*(\d+)px/) ?? [])[1] ?? "",
    );
    expect(depths).toEqual(["4", "26", "48", "70", "26", "48", "70", "48", "70"]);
  });

  it("sorts every level by the chosen column, labels ascending here", () => {
    const { container } = renderApp(
      <CostsView />,
      { attributionTree: TREE, attributionSort: { key: "label", dir: "asc" } },
      NOW,
    );
    const names = [...container.querySelectorAll(".attr-name")].map((n) => n.textContent);
    expect(names).toEqual([
      "~/app",
      "fix it",
      "main",
      "GLM 5.3",
      "read around",
      "claude-x",
      "the job",
      "runner",
      "kimi-k3",
    ]);
    expect(container.querySelector("th[aria-sort='ascending'] button")?.getAttribute("data-value")).toBe(
      "label",
    );
    expect(container.querySelectorAll("th[aria-sort='none']")).toHaveLength(6);
  });

  it("sorts by any column on click", async () => {
    const { act } = renderApp(<CostsView />, { attributionTree: TREE }, NOW);
    await userEvent.click(screen.getByTitle("Sort by requests"));
    expect(act).toHaveBeenCalledWith("sort-attribution", "requests");
    await userEvent.click(screen.getByTitle("Sort by breakdown"));
    expect(act).toHaveBeenCalledWith("sort-attribution", "label");
  });

  it("collapses a session by click, hiding its subtree, and expands it again from state", async () => {
    const { container, act } = renderApp(
      <CostsView />,
      { attributionTree: TREE, costsCollapsed: new Set(["session:j1"]) },
      NOW,
    );
    const names = [...container.querySelectorAll(".attr-name")].map((n) => n.textContent);
    expect(names).toEqual(["~/app", "the job", "fix it", "main", "GLM 5.3", "read around", "claude-x"]);
    const toggle = screen.getByRole("button", { name: "Expand the job" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(screen.getByRole("button", { name: "Collapse ~/app" }));
    expect(act).toHaveBeenCalledWith("costs-collapse", "repo:/w/app");
    await userEvent.click(toggle);
    expect(act).toHaveBeenCalledWith("costs-collapse", "session:j1");
  });

  it("collapses and reopens from the keyboard, on Enter and Space alone", async () => {
    const { act } = renderApp(
      <CostsView />,
      { attributionTree: TREE, costsCollapsed: new Set(["session:j1"]) },
      NOW,
    );
    const toggle = screen.getByRole("button", { name: "Expand the job" });
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(act).toHaveBeenCalledWith("costs-collapse", "session:j1");
    await userEvent.keyboard(" ");
    expect(act).toHaveBeenCalledWith("costs-collapse", "session:j1");
    await userEvent.keyboard("a"); // any other key leaves the tree alone
    expect(act).toHaveBeenCalledTimes(2);
  });

  it("runs the period and export actions", async () => {
    const { act } = renderApp(<CostsView />, { attributionTree: TREE }, NOW);
    await userEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(act).toHaveBeenCalledWith("attribution-range", "week");
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(act).toHaveBeenCalledWith("export", "attribution");
  });

  it("says tokens only for an unpriced group, and unpriced totals too", () => {
    const { container } = renderApp(<CostsView />, { attributionTree: [CLAUDE] }, NOW);
    expect(screen.getByText("tokens only")).toBeTruthy();
    expect(panelMetaOf(container)).toBe("Today: unpriced, 1 request, 0 tokens");
    expect(container.querySelector(".attr-mix .bar-seg")).toBeTruthy();
  });

  it("annotates a priced cell with what the estimate leaves out", () => {
    renderApp(<CostsView />, { attributionTree: [{ ...FIX_IT, children: [MAIN] }] }, NOW);
    // the same estimate at every level, each carrying its own unpriced count
    const titles = screen.getAllByText("$2.00").map((el) => el.getAttribute("title"));
    expect(titles).toEqual([
      "2 requests unpriced, not included",
      "1 request unpriced, not included",
      "1 request unpriced, not included",
    ]);
  });
});

/** The panel head's muted count beside the title (the shared Panel's meta slot). */
function panelMetaOf(container: Element): string {
  return container.querySelector("section h2")?.nextElementSibling?.textContent ?? "";
}
