// Repo.test.tsx — the repo views: the pure half (picks, labels, drift order and pills, table
// shapes, cells), the shell's chips, the code view's reads and its file/README/refs rendering,
// the drift report, the diagrams and the extension views, plus the Work shell's repo tab.
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api.ts";
import type { PlanStep } from "../../src/store.ts";
import {
  Box,
  cellNode,
  codeHref,
  type DriftRow,
  driftOrdered,
  driftPill,
  isMdDocs,
  isRows,
  MockupCode,
  Repo,
  repoLabel,
  repoPick,
  tableKeys,
  viewHref,
} from "../../src/work/Repo.tsx";
import { Work } from "../../src/work/Work.tsx";

/** The value the test needs, or a loud failure — the tests carry no non-null assertions. */
function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("the test could not find what it needs");
  return x;
}

/** An api fake whose scripted answers the test can assert against. */
const apiF = (script: Record<string, unknown> = {}): Api => {
  const api = vi.fn(async (raw: string) => {
    const path = decodeURIComponent(raw);
    const hit = Object.entries(script).find(([k]) => path.includes(k));
    if (hit) return hit[1];
    throw new Error(`no answer scripted for ${path}`);
  });
  return {
    api: api as unknown as Api["api"],
    op: vi.fn(async () => ({})),
    channelPath: (ch: string, p: string) => `/api/c/${ch}${p}`,
    channelHref: (ch: string, p: string) => `#/c/${ch}${p}`,
  } as unknown as Api;
};

const calls = (api: Api): string[] =>
  (api.api as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));

const base = {
  ch: "ch",
  now: 0,
  views: ["code", "drift", "diagrams"],
  byId: new Map<string, PlanStep>(),
  onOpenTask: vi.fn(),
};

const repo = (over: Partial<typeof base & { parts: string[]; api: Api; repoPath: string }> = {}) => {
  const props = {
    ...base,
    parts: [],
    api: over.api ?? apiF(),
    ...over,
  };
  return render(<Repo {...props} />);
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("repo model", () => {
  it("picks the route's view when it is declared, else the first one, with the path only then", () => {
    expect(repoPick(["code", "drift"], ["drift", "a/b"])).toEqual({ view: "drift", rest: "a/b" });
    expect(repoPick(["code", "drift"], ["bogus", "x"])).toEqual({ view: "code", rest: "" });
    expect(repoPick(["drift"], [])).toEqual({ view: "drift", rest: "" });
    expect(repoPick([], ["code"])).toEqual({ view: null, rest: "" });
  });

  it("names the built-in views and capitalises an extension's own", () => {
    expect(repoLabel("code")).toBe("Code");
    expect(repoLabel("drift")).toBe("Drift");
    expect(repoLabel("diagrams")).toBe("Diagrams");
    expect(repoLabel("trends")).toBe("Trends");
    expect(repoLabel("")).toBe("");
  });

  it("links a path and a view the way the address bar spells them", () => {
    expect(codeHref("ch", "src/app/App.tsx")).toBe("#/c/ch/work/repo/code/src/app/App.tsx");
    expect(codeHref("ch", "/a b/")).toBe("#/c/ch/work/repo/code/a%20b");
    expect(viewHref("ch", "drift")).toBe("#/c/ch/work/repo/drift");
    expect(viewHref("ch", "diagrams", "flow.png")).toBe("#/c/ch/work/repo/diagrams/flow.png");
  });

  it("orders the drift rows bad-first and names each state", () => {
    const rows: DriftRow[] = [
      { state: "ok", step: "t1", path: "a.ts" },
      { state: "changed", step: "t2", path: "b.ts" },
      { state: "ok", step: "t3", path: "c.ts" },
      { state: "missing", step: "t4", path: "d.ts" },
    ];
    expect(driftOrdered(rows).map((r) => r.step)).toEqual(["t2", "t4", "t1", "t3"]);
    expect(driftPill("ok")).toEqual({ status: "done", label: "Matches" });
    expect(driftPill("partial")).toEqual({ status: "doing", label: "Partly changed" });
    expect(driftPill("missing")).toEqual({ status: "blocked", label: "File missing" });
    expect(driftPill("changed")).toEqual({ status: "blocked", label: "Changed" });
  });

  it("reads a reply's shape: markdown docs, row tables, and their columns", () => {
    expect(isMdDocs([{ md: "# hi" }])).toBe(true);
    expect(isMdDocs([{ md: 3 }])).toBe(false);
    expect(isMdDocs([])).toBe(true);
    expect(isRows([{ a: 1 }, { b: 2 }])).toBe(true);
    expect(isRows([])).toBe(false);
    expect(isRows(["x"])).toBe(false);
    expect(
      tableKeys([
        { a: 1, b: 2 },
        { b: 3, c: 4, d: 5, e: 6, f: 7, g: 8, h: 9, i: 10 },
      ]),
    ).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  it("renders one cell: arrays join, objects clip, scalars go through inline markdown", () => {
    expect(cellNode(null)).toBe("");
    expect(cellNode(undefined)).toBe("");
    expect(cellNode(["a", 2])).toBe("a, 2");
    expect(cellNode([{ x: 1 }])).toBe("1");
    expect(cellNode({ x: 1 })).toBe('{"x":1}');
    const { container } = render(<span>{cellNode("**b**")}</span>);
    expect(container.querySelector("b")?.textContent).toBe("b");
  });

  it("draws a code mockup with numbered, highlighted lines", () => {
    const { container } = render(<MockupCode text={'{"a": 1}'} lang="json" />);
    const lines = container.querySelectorAll("pre");
    expect(lines).toHaveLength(1);
    expect(must(lines[0]).getAttribute("data-prefix")).toBe("1");
    expect(container.querySelectorAll('[class*="hue-blue"]')).toHaveLength(1);
    const { container: c2 } = render(<MockupCode text={"# note"} lang="hcl" />);
    expect(c2.querySelectorAll(".italic")).toHaveLength(1);
  });

  it("frames a body in a titled card, flush or padded", () => {
    const { container } = render(
      <Box title="T" icon="code" right={<span>r</span>} flush>
        <table />
      </Box>,
    );
    expect(screen.getByText("T")).toBeDefined();
    expect(container.querySelector("h2")).not.toBeNull();
    expect(container.querySelector("table")).not.toBeNull();
  });
});

describe("Repo shell", () => {
  it("shows a chip per view, the current one marked, and the repo path", () => {
    repo({ repoPath: "~/proxbeam" });
    const nav = screen.getByLabelText("Repo views");
    const chips = [...nav.querySelectorAll("a")];
    expect(chips.map((c) => c.textContent)).toEqual(["Code", "Drift", "Diagrams"]);
    expect(must(chips[0]).getAttribute("aria-current")).toBe("page");
    expect(must(chips[0]).getAttribute("href")).toBe("#/c/ch/work/repo/code");
    expect(must(chips[1]).getAttribute("href")).toBe("#/c/ch/work/repo/drift");
    expect(screen.getByText("~/proxbeam")).toBeDefined();
  });

  it("serves the first view when the route names none, and the route's path under code", async () => {
    const api = apiF({ "/repo/tree": { entries: [{ path: "a", name: "a", dir: true }] } });
    repo({ api, parts: ["code", "src"] });
    await waitFor(() => expect(calls(api).some((c) => c.includes("/repo/tree?path=src"))).toBe(true));
    expect(calls(api).some((c) => c.includes("refs?path=src"))).toBe(true);
  });

  it("says so when the channel has no repo", () => {
    repo({ views: [] });
    expect(screen.getByText("No repo here")).toBeDefined();
    expect(screen.queryByLabelText("Repo views")?.querySelectorAll("a")).toHaveLength(0);
  });

  it("serves an extension's view by name", async () => {
    const api = apiF({ "/repo/trends": [{ md: "hello" }] });
    repo({ api, views: ["trends"], parts: ["trends"] });
    await waitFor(() => expect(screen.getByText("hello")).toBeDefined());
    expect(calls(api)[0]).toContain("/repo/trends");
  });
});

describe("RepoCode", () => {
  it("lists a folder: crumbs, the entries with Up, and the README card", async () => {
    const api = apiF({
      "/repo/tree": {
        entries: [
          { path: "src", name: "src", dir: true },
          { path: "hcl", name: "main.tf" },
        ],
        readme: "# Welcome",
      },
    });
    const { container } = repo({ api, parts: ["code"] });
    await waitFor(() => expect(screen.getByText("main.tf")).toBeDefined());
    const path = screen.getByLabelText("Path");
    expect(path.textContent).toContain("repo");
    const files = screen.getByLabelText("Files");
    const links = [...files.querySelectorAll("a")];
    expect(links.map((l) => l.textContent)).toEqual(["src", "main.tf"]);
    expect(screen.getByText("README")).toBeDefined();
    expect(container.querySelector("table")).toBeNull(); // a folder draws no file
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeDefined(); // the README's markdown
    expect(calls(api).some((c) => c.includes("/repo/file?"))).toBe(false);
  });

  it("opens a file: the parent folder beside it, the refs, and the numbered file", async () => {
    const api = apiF({
      "/repo/tree?path=src/app.tsx": { file: true },
      "/repo/tree?path=src": { entries: [{ path: "src/app.tsx", name: "app.tsx" }] },
      "/repo/refs": [{ id: "t1", title: "Wire the rail" }],
      "/repo/file": { text: "let a = 1", total: 1 },
    });
    const byId = new Map([["t1", { id: "t1", status: "doing" } as PlanStep]]);
    repo({ api, parts: ["code", "src/app.tsx"], byId });
    await waitFor(() => expect(screen.getByText("1 lines")).toBeDefined());
    expect(screen.getAllByText("app.tsx").length).toBeGreaterThan(0);
    expect(screen.getByText("Tasks that touch this (1)")).toBeDefined();
    expect(screen.getByText("Wire the rail")).toBeDefined();
    const pre = must(document.querySelector(".mockup-code pre"));
    expect(pre.getAttribute("data-prefix")).toBe("1");
    expect(document.querySelectorAll(".mockup-code pre")).toHaveLength(1);
  });

  it("opens a ref chip's drawer", async () => {
    const api = apiF({
      "/repo/tree?path=a.ts": { file: true },
      "/repo/tree?path=": { entries: [] },
      "/repo/refs": [{ id: "t9", title: "Do it" }],
      "/repo/file": { text: "x", total: 1 },
    });
    const onOpenTask = vi.fn();
    repo({ api, parts: ["code", "a.ts"], onOpenTask });
    const chip = await waitFor(() => must(screen.getByText("Do it").closest("a")));
    fireEvent.click(chip);
    expect(onOpenTask).toHaveBeenCalledWith("t9");
    expect(chip.getAttribute("href")).toContain("?t=t9");
  });

  it("renders a markdown file as prose, and a binary as a note", async () => {
    const api = apiF({
      "/repo/tree?path=r.md": { file: true },
      "/repo/tree?path=": { entries: [] },
      "/repo/refs": [],
      "/repo/file": { text: "# Hello", total: 1 },
    });
    const { container } = repo({ api, parts: ["code", "r.md"] });
    await waitFor(() => expect(container.querySelector(".prose-h")).not.toBeNull());
    expect(container.querySelector(".mockup-code")).toBeNull();
  });

  it("tells a binary file's size instead of drawing it", async () => {
    const api = apiF({
      "/repo/tree?path=x.bin": { file: true },
      "/repo/tree?path=": { entries: [] },
      "/repo/refs": [],
      "/repo/file": { binary: true, size: 2048 },
    });
    repo({ api, parts: ["code", "x.bin"] });
    await waitFor(() => expect(screen.getByText("A binary file (2048 bytes).")).toBeDefined());
  });

  it("shows a read's failure instead of a blank panel", async () => {
    const api = apiF({
      "/repo/tree?path=gone": { error: "no such folder" },
    });
    repo({ api, parts: ["code", "gone"] });
    await waitFor(() => expect(screen.getByText("no such folder")).toBeDefined());
  });

  it("shows the file read's failure, and the tree's own", async () => {
    const api = apiF({
      "/repo/tree?path=bad.ts": { file: true },
      "/repo/tree?path=": { entries: [] },
      "/repo/refs": [],
      "/repo/file": { error: "unreadable" },
    });
    repo({ api, parts: ["code", "bad.ts"] });
    await waitFor(() => expect(screen.getByText("unreadable")).toBeDefined());
  });

  it("says when a folder has no README", async () => {
    const api = apiF({ "/repo/tree": { entries: [] } });
    repo({ api, parts: ["code"] });
    await waitFor(() => expect(screen.getByText("No README in this folder.")).toBeDefined());
  });

  it("shows a thrown read as the empty state's text", async () => {
    const api = apiF();
    repo({ api, parts: ["code", "any"] });
    await waitFor(() => expect(screen.getByText(/no answer scripted for/)).toBeDefined());
  });
});

describe("RepoDrift", () => {
  it("reports the drift: the counts, the checked time, the bad rows first", async () => {
    const api = apiF({
      "/repo/drift": {
        at: 1_700_000_000_000,
        rows: [
          { state: "ok", step: "t1", path: "a.ts", score: 100 },
          { state: "changed", step: "t2", path: "b.ts:10", score: 40 },
        ],
      },
    });
    const onOpenTask = vi.fn();
    const { container } = repo({ api, parts: ["drift"], onOpenTask });
    await waitFor(() => expect(screen.getByText("Snippet drift")).toBeDefined());
    expect(screen.getByText(/1 of 2 no longer match/)).toBeDefined();
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(must(rows[0]).textContent).toContain("Changed");
    expect(must(rows[0]).textContent).toContain("40%");
    const task = must(screen.getByText("t2"));
    fireEvent.click(task);
    expect(onOpenTask).toHaveBeenCalledWith("t2");
    const file = must([...container.querySelectorAll("td a")].find((a) => a.textContent === "b.ts:10"));
    expect(file.getAttribute("href")).toBe(codeHref("ch", "b.ts"));
    expect(container.querySelector("time")).not.toBeNull();
  });

  it("reads an all-clear and an empty report", async () => {
    const api = apiF({ "/repo/drift": { at: 1, rows: [{ state: "ok", step: "t1", path: "a" }] } });
    repo({ api, parts: ["drift"] });
    await waitFor(() => expect(screen.getByText(/All 1 match/)).toBeDefined());

    const api2 = apiF({ "/repo/drift": { rows: [] } });
    const { container } = repo({ api: api2, parts: ["drift"] });
    await waitFor(() => expect(screen.getByText("No snippet quotes a file.")).toBeDefined());
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("shows a failed read", async () => {
    const api = apiF();
    repo({ api, parts: ["drift"] });
    await waitFor(() => expect(screen.getByText(/no answer scripted for/)).toBeDefined());
  });
});

describe("RepoDiagrams", () => {
  it("offers a chip per PNG and draws the picked one", async () => {
    const api = apiF({ "/repo/diagrams": ["flow-b.png", "map.png"] });
    const { container } = repo({ api, parts: ["diagrams"] });
    await waitFor(() => expect(screen.getByText("flow b")).toBeDefined());
    const chips = [...screen.getByLabelText("Diagrams").querySelectorAll("a")];
    expect(chips.map((c) => c.textContent)).toEqual(["flow b", "map"]);
    expect(must(chips[0]).getAttribute("aria-current")).toBe("page");
    expect(must(chips[0]).getAttribute("href")).toBe(viewHref("ch", "diagrams", "flow-b.png"));
    const img = must(container.querySelector("img"));
    expect(img.getAttribute("src")).toBe("/api/c/ch/diagram?name=flow-b.png");
    expect(img.getAttribute("alt")).toBe("Diagram: flow b");
    expect(screen.getByText(/docs\/architecture\/flow-b.png/)).toBeDefined();
  });

  it("serves the route's diagram when it exists, and says when none do", async () => {
    const api = apiF({ "/repo/diagrams": ["a.png"] });
    repo({ api, parts: ["diagrams", "a.png"] });
    await waitFor(() => {
      const img = document.querySelector("img");
      expect((img?.getAttribute("src") ?? "").includes("name=a.png")).toBe(true);
    });

    const api2 = apiF({ "/repo/diagrams": [] });
    repo({ api: api2, parts: ["diagrams"] });
    await waitFor(() => expect(screen.getByText("No PNG diagrams in docs/architecture.")).toBeDefined());
  });

  it("shows a failed read", async () => {
    const api = apiF();
    repo({ api, parts: ["diagrams"] });
    await waitFor(() => expect(screen.getByText(/no answer scripted for/)).toBeDefined());
  });
});

describe("RepoGeneric", () => {
  it("renders one card per markdown row, and 'Nothing here' when there are none", async () => {
    const api = apiF({ "/repo/digest": [{ md: "one" }, { md: "two" }] });
    repo({ api, views: ["digest"], parts: ["digest"] });
    await waitFor(() => expect(screen.getByText("two")).toBeDefined());
    expect(document.querySelectorAll("section")).toHaveLength(2);

    const api2 = apiF({ "/repo/digest": [] });
    repo({ api: api2, views: ["digest"], parts: ["digest"] });
    await waitFor(() => expect(screen.getByText("Nothing here.")).toBeDefined());
  });

  it("renders a table of rows with the first eight columns", async () => {
    const api = apiF({
      "/repo/rows": [
        { name: "one", n: 1, tags: ["a", "b"], meta: { k: 1 } },
        { name: "two", n: 2, tags: [], meta: null },
      ],
    });
    const { container } = repo({ api, views: ["rows"], parts: ["rows"] });
    await waitFor(() => expect(container.querySelector("table")).not.toBeNull());
    const head = [...must(container.querySelector("thead")).querySelectorAll("th")];
    expect(head.map((h) => h.textContent)).toEqual(["name", "n", "tags", "meta"]);
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(must(rows[0]).textContent).toContain("one");
    expect(must(rows[0]).textContent).toContain("a, b");
    expect(must(rows[0]).textContent).toContain('{"k":1}');
    expect(must(rows[1]).textContent).toContain("2");
  });

  it("falls back to the raw JSON, and shows the view's refusal", async () => {
    const api = apiF({ "/repo/stats": { ok: true } });
    const { container } = repo({ api, views: ["stats"], parts: ["stats"] });
    await waitFor(() => expect(container.querySelector(".mockup-code")).not.toBeNull());
    expect(must(container.querySelector(".mockup-code")).textContent).toContain('"ok": true');

    const api2 = apiF({ "/repo/stats": { error: "not served" } });
    repo({ api: api2, views: ["stats"], parts: ["stats"] });
    await waitFor(() => expect(screen.getByText("not served")).toBeDefined());
  });

  it("names the view in the JSON card's title", async () => {
    const api = apiF({ "/repo/trends": [1, 2] });
    repo({ api, views: ["trends"], parts: ["trends"] });
    await waitFor(() => expect(screen.getByText("Trends")).toBeDefined());
  });
});

describe("Work's repo tab", () => {
  const steps = [{ id: "t1", title: "Task t1", status: "todo" } as PlanStep];
  const board = { phases: [{ n: 1, title: "One" }], steps } as never;

  const work = (
    over: { view?: "repo" | "list"; sub?: string[]; repoViews?: string[] } = {},
    api: Api = apiF(),
  ) =>
    render(
      <Work
        ch="ch"
        view={over.view ?? "repo"}
        sub={over.sub ?? ["repo"]}
        repoViews={over.repoViews ?? ["code"]}
        repoPath="~/x"
        board={board}
        byId={new Map(steps.map((s) => [s.id, s]))}
        sessions={null}
        attention={null}
        now={0}
        api={api}
        toast={vi.fn()}
        store={localStorage}
        onOpenTask={vi.fn()}
        onOpenSession={vi.fn()}
        onCompose={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

  it("joins the Repo tab only when the channel serves repo views, and drops the filters there", () => {
    const { container, unmount } = work();
    const tabs = [...container.querySelectorAll("[role='tab']")];
    expect(tabs.map((t) => t.getAttribute("data-tab"))).toEqual(["list", "board", "graph", "map", "repo"]);
    expect(document.getElementById("wq")).toBeNull();
    unmount();

    const { container: c2 } = work({ repoViews: [] });
    expect([...c2.querySelectorAll("[role='tab']")].map((t) => t.getAttribute("data-tab"))).toEqual([
      "list",
      "board",
      "graph",
      "map",
    ]);
  });

  it("hands the route's path under repo to the view", async () => {
    const api = apiF({ "/repo/tree": { entries: [] } });
    const { container } = work({ sub: ["repo", "code", "deep"] }, api);
    await waitFor(() => {
      const t = container.querySelector("nav[aria-label='Path']")?.textContent ?? "";
      expect(t).toContain("deep");
    });
    expect(container.textContent).toContain("~/x");
  });

  it("keeps the view in the browser's prefs for the t/ alias", () => {
    localStorage.clear();
    work({ view: "repo" });
    expect(localStorage.getItem("huddle:wview:ch")).toBe('"repo"');
    localStorage.clear();
  });
});
