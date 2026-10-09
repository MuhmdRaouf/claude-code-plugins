import { screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  Badge,
  EmptyState,
  IconTile,
  ModelChip,
  Panel,
  Segmented,
  shortModelName,
} from "../../src/ui/app/kit.tsx";
import { renderApp } from "./render.tsx";

describe("shortModelName", () => {
  it("reads families by their short names and keeps unknown ids raw", () => {
    expect(shortModelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(shortModelName("Claude Sonnet 5.5")).toBe("Sonnet 5.5");
    expect(shortModelName("glm-5.3")).toBe("GLM 5.3");
    expect(shortModelName("zai:glm-5.3-flash")).toBe("GLM 5.3 Flash");
    expect(shortModelName("kimi-k2-thinking")).toBe("kimi-k2-thinking");
    expect(shortModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(shortModelName("claude-fable-5-1")).toBe("Fable 5.1");
    expect(shortModelName("claude-sonnet-4-20250514")).toBe("Sonnet 4");
  });
});

describe("ModelChip", () => {
  it("shows a dot coloured by the model's family and the short name, the raw id as its title", () => {
    const { container } = renderApp(<ModelChip model="claude-opus-5-5" />);
    const chip = container.querySelector(".model-chip");
    expect(chip?.getAttribute("title")).toBe("claude-opus-5-5");
    expect(chip?.textContent).toBe("Opus 5.5");
    const dot = chip?.querySelector(".dot");
    expect(dot?.getAttribute("style")).toContain("var(--model-opus)");
    expect(chip?.querySelector(".dot-pulse")).toBeNull();
  });
});

describe("Panel", () => {
  it("draws the shared panel surface with a titled head, subtitle and right-aligned actions", () => {
    const { container } = renderApp(
      <Panel icon="bot" title="Agents" subtitle="3 running" actions={<button type="button">Do</button>}>
        <p>body</p>
      </Panel>,
    );
    const panel = container.querySelector("section");
    expect(panel?.className).toBe("panel min-w-0");
    expect(panel?.querySelector("h2")?.textContent).toBe("Agents");
    expect(panel?.textContent).toContain("3 running");
    expect(screen.getByRole("button", { name: "Do" })).toBeTruthy();
    expect(container.textContent).toContain("body");
  });

  it("renders headless and carries extra classes when given", () => {
    const { container } = renderApp(<Panel class="tree-block">just the box</Panel>);
    const panel = container.querySelector("section");
    expect(panel?.className).toBe("panel min-w-0  tree-block"); // the shared frame joins flush and class slots
    expect(panel?.querySelector("h2")).toBeNull();
    expect(panel?.textContent).toBe("just the box");
  });

  it("pads its body by default and leaves flush bodies to run edge to edge", () => {
    const padded = renderApp(<Panel title="T">body</Panel>);
    expect(padded.container.querySelector("section")?.querySelector("div.p-5")).toBeTruthy();
    const flush = renderApp(
      <Panel title="T" flush>
        body
      </Panel>,
    );
    expect(flush.container.querySelector("section")?.className).toContain("overflow-hidden");
    expect(flush.container.querySelector("section")?.querySelector("div.p-5")).toBeNull();
  });
});

describe("EmptyState", () => {
  it("offers the one verb button when the view has somewhere to go", async () => {
    const run = vi.fn();
    renderApp(
      <EmptyState title="No budgets" hint="Set one to watch spend." action={{ label: "New budget", run }} />,
    );
    expect(screen.getByText("No budgets")).toBeTruthy();
    const button = screen.getByRole("button", { name: "New budget" });
    expect(button.className).toBe("btn btn-sm mt-2");
    await userEvent.click(button);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("renders without a button when there is nowhere to go", () => {
    renderApp(<EmptyState title="Nothing here" hint="Wait for traffic." />);
    expect(document.querySelector("button")).toBeNull();
  });
});

describe("IconTile", () => {
  it("tints the tile with the given token, smaller when asked", () => {
    const { container } = renderApp(
      <>
        <IconTile name="bell" color="var(--warning)" />
        <IconTile name="close" color="var(--danger)" sm />
      </>,
    );
    const [full, small] = [...container.querySelectorAll("span")];
    expect(full?.getAttribute("style")).toContain("var(--warning)");
    expect(full?.className).toContain("size-8");
    expect(small?.className).toContain("size-[26px]");
    expect(small?.querySelector("svg[data-icon='close']")).toBeTruthy();
  });
});

describe("Segmented", () => {
  it("runs the action with the segment's value and marks the pressed one", async () => {
    const { container } = renderApp(
      <Segmented
        action="tool-filter"
        label="Filter"
        segments={[
          { label: "All", value: "all", on: true, count: "4" },
          { label: "Failed", value: "failed", on: false, count: "1" },
        ]}
      />,
    );
    const [on, off] = [...container.querySelectorAll("button")];
    expect(on?.getAttribute("aria-pressed")).toBe("true");
    expect(on?.className).toContain("btn-primary");
    expect(off?.className).toContain("btn-ghost");
    expect(on?.textContent).toBe("All4");
    expect(container.querySelector(".segment-count")?.className).toContain("num");
  });
});

describe("Badge", () => {
  it("keeps the daisyUI badge class with the tone hook and its optional icon", () => {
    const { container } = renderApp(
      <>
        <Badge text="Live" tone="ok" />
        <Badge text="Failed" tone="err" icon="close" />
      </>,
    );
    const [plain, withIcon] = [...container.querySelectorAll(".badge")];
    expect(plain?.className).toBe("badge badge-ok");
    expect(withIcon?.className).toBe("badge badge-err");
    expect(withIcon?.querySelector("svg[data-icon='close']")).toBeTruthy();
  });
});
