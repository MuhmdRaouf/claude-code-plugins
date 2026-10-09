import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Block, Blocks } from "../../src/ui/app/Content.tsx";
import { Drawer } from "../../src/ui/app/Drawer.tsx";
import type { ContentState } from "../../src/ui/state.ts";
import { makeRequest } from "../helpers.ts";
import { renderApp } from "./render.tsx";

const NOW = 1_790_000_000_000;

describe("the stored blocks", () => {
  it("renders a text block through the markdown with a copy button", () => {
    const { container } = renderApp(<Block block={{ type: "text", text: "Fix the **radar**" }} />, {}, NOW);
    expect(container.querySelector(".prose-h")?.textContent).toContain("Fix the");
    expect(container.querySelector("b")?.textContent).toBe("radar");
    expect(container.querySelector(".block-copy")).toBeTruthy();
  });

  it("renders a tool call as its name plus readable JSON, with the JSON on the clipboard button", () => {
    const { container } = renderApp(
      <Block block={{ type: "tool_use", name: "Bash", input: { command: "bun test" } }} />,
      {},
      NOW,
    );
    expect(container.textContent).toContain("Tool call");
    expect(container.textContent).toContain("Bash");
    const pre = container.querySelector(".mockup-code code")?.textContent ?? "";
    expect(pre).toContain('"command": "bun test"');
  });

  it("renders a tool result with its call's id and an error badge only when it failed", () => {
    const ok = renderApp(
      <Block block={{ type: "tool_result", tool_use_id: "call_1", content: "done" }} />,
      {},
      NOW,
    );
    expect(ok.container.textContent).toContain("call_1");
    expect(ok.container.textContent).toContain("done");
    expect(ok.container.querySelector(".badge-error")).toBeNull();
    ok.unmount();
    const bad = renderApp(
      <Block block={{ type: "tool_result", tool_use_id: "call_2", is_error: true, content: "boom" }} />,
      {},
      NOW,
    );
    expect(bad.container.querySelector(".badge-error")?.textContent).toBe("Error");
    expect(bad.container.textContent).toContain("boom");
  });

  it("shows a tool result's text the transcript importer kept, not an empty result", () => {
    const { container } = renderApp(
      <Block block={{ type: "tool_result", tool_use_id: "call_3", text: "3 files changed" }} />,
      {},
      NOW,
    );
    expect(container.textContent).toContain("3 files changed");
    expect(container.textContent).not.toContain("Empty result.");
  });

  it("folds thinking under a disclosure, open on request", async () => {
    const { container } = renderApp(
      <Block block={{ type: "thinking", thinking: "Let me think" }} />,
      {},
      NOW,
    );
    const details = container.querySelector("details.block-think");
    expect(details).toBeTruthy();
    expect(details?.getAttribute("open")).toBeNull(); // folded: closed until the reader asks
    expect(container.textContent).toContain("Thinking");
    expect(container.textContent).toContain("12 B");
    await userEvent.click(container.querySelector("summary") as HTMLElement);
    expect(details?.getAttribute("open")).not.toBeNull();
    expect(container.textContent).toContain("Let me think");
  });

  it("folds a long block behind Show all with its size, and unfolds on click", async () => {
    const long = "x".repeat(20_000);
    const view = renderApp(<Block block={{ type: "text", text: long }} />, {}, NOW);
    const shown = view.container.querySelector(".prose-h")?.textContent ?? "";
    expect(shown.length).toBeLessThan(3_000);
    const button = view.container.querySelector(".block-fold-btn") as HTMLElement;
    expect(button.textContent).toBe("Show all (20 kB)");
    // the fold lives inside the block's own collapse, so open that first
    await userEvent.click(view.container.querySelector("summary") as HTMLElement);
    await userEvent.click(button);
    expect(view.container.querySelector(".block-fold-btn")).toBeNull();
    expect((view.container.querySelector(".prose-h")?.textContent ?? "").length).toBeGreaterThan(19_000);
  });

  it("renders an image block as a labelled item: kind, media type, size — never the data", () => {
    const { container } = renderApp(
      <Block
        block={{
          type: "image",
          media_type: "image/png",
          bytes: 86_016,
          text: "[image image/png, 86016 bytes]",
        }}
      />,
      {},
      NOW,
    );
    expect(container.querySelector(".block-media")).toBeTruthy();
    expect(container.textContent).toContain("Image, image/png, 86 kB");
  });

  it("says when a block's text was cut at ingest, with the original size", () => {
    const text = `${"x".repeat(50)}…[truncated 3000000 bytes]`;
    const { container } = renderApp(<Block block={{ type: "text", text, truncated: 3_000_000 }} />, {}, NOW);
    const badge = container.querySelector(".badge-warning");
    expect(badge?.textContent).toBe("cut from 3 MB");
    expect(badge?.getAttribute("title")).toContain("the original text was 3 MB");
  });

  it("renders an unknown shape as JSON and never as nothing", () => {
    const { container } = renderApp(<Block block={{ type: "image", data: "abc" } as never} />, {}, NOW);
    expect(container.textContent).toContain("image");
    expect(container.querySelector(".mockup-code code")?.textContent).toContain("abc");
  });

  it("splits a side into its blocks, and says when a side has nothing", () => {
    const many = renderApp(
      <Blocks
        side={[
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ]}
      />,
      {},
      NOW,
    );
    expect(many.container.querySelectorAll("details.collapse")).toHaveLength(2);
    many.unmount();
    const plain = renderApp(<Blocks side="just words" />, {}, NOW);
    expect(plain.container.querySelectorAll("details.collapse")).toHaveLength(1);
    plain.unmount();
    const none = renderApp(<Blocks side={null} />, {}, NOW);
    expect(none.container.textContent).toContain("Nothing recorded on this side.");
  });
});

describe("the drawer's Input and Output tabs", () => {
  const REQUEST = makeRequest({ id: "a", model: "glm-5.3" });

  const openOn = (
    tab: "input" | "output" | "context" | "raw",
    raw: Record<string, unknown> = {},
    over = {},
  ) => {
    const content = raw as ContentState;
    return renderApp(
      <Drawer />,
      {
        request: "a",
        requests: [REQUEST],
        summary: {
          sessions: 1,
          liveSessions: 1,
          agents: 1,
          requests: 1,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          errors: 0,
          toolCalls: 0,
          latencyP50: null,
          latencyP95: null,
          startedAt: null,
          now: 0,
        },
        drawerTab: tab,
        content: { a: content },
        ...over,
      },
      NOW,
    );
  };

  it("shows the five tabs with Overview on by default, and the summary body under it", () => {
    const { container } = renderApp(<Drawer />, { request: "a", requests: [REQUEST] }, NOW);
    const tabs = [...container.querySelectorAll("[data-action='drawer-tab']")];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Overview", "Input", "Output", "Context", "Raw"]);
    expect(tabs[0]?.className).toContain("tab-active");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Est. cost");
    expect(container.textContent).not.toContain("Reading the stored side");
  });

  it("renders each side's blocks, and the words for loading, missing, off and failure", () => {
    const ready = openOn("input", {
      status: "ready",
      input: [{ type: "text", text: "the prompt" }],
      output: [{ type: "text", text: "the answer" }],
      bytes: 22,
    });
    expect(ready.container.textContent).toContain("the prompt");
    ready.unmount();

    const cases: [string, Record<string, unknown>, string][] = [
      ["input", { status: "loading" }, "Reading the stored side"],
      ["input", { status: "missing" }, "Not recorded: older than history or captured before history existed"],
      ["output", { status: "off" }, "History is off"],
      ["output", { status: "error" }, "could not be read"],
      ["output", { status: "ready", output: null }, "Nothing recorded on this side"],
    ];
    for (const [tab, content, words] of cases) {
      const view = openOn(tab as "input" | "output", content);
      expect(view.container.textContent).toContain(words);
      view.unmount();
    }
  });

  it("never leaves a tab blank, even with an empty block array", () => {
    const view = openOn("input", { status: "ready", input: [], output: [] });
    expect(
      view.container.querySelector(".inspector-content")?.textContent?.trim()?.length ?? 0,
    ).toBeGreaterThan(0);
    expect(view.container.textContent).toContain("Nothing recorded on this side");
  });
});
