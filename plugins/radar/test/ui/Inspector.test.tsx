import { screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Drawer } from "../../src/ui/app/Drawer.tsx";
import { fmtBytes } from "../../src/ui/fmt.ts";
import type { ContentState, ContextState } from "../../src/ui/state.ts";
import { makeRequest } from "../helpers.ts";
import { renderApp } from "./render.tsx";

const NOW = 1_790_000_000_000;
const REQUEST = makeRequest({ id: "a", model: "glm-5.3", ts: NOW - 5_000 });

/** The drawer open on the Context (or Raw) tab with `state` as that tab's stored answer. */
function openOn(tab: "context" | "raw", state: Record<string, unknown>, over = {}) {
  return renderApp(
    <Drawer />,
    {
      request: "a",
      requests: [REQUEST],
      drawerTab: tab,
      context: tab === "context" ? { a: state as ContextState } : {},
      content: tab === "raw" ? { a: state as ContentState } : {},
      ...over,
    },
    NOW,
  );
}

const USAGE = { input: 500, output: 60, cacheRead: 400, cacheWrite: 40 };

/** A captured prompt as the capture route serves it: the system text, one tool, the allowed headers. */
const CAPTURED = {
  status: "ready",
  hash: "h".repeat(64),
  system: "be brief",
  tools: [{ name: "Bash", description: "Run a shell command", input_schema: { type: "object" } }],
  bytes: 240,
  headers: { "request-id": "req_1", "retry-after": "7" },
};

const READY = {
  status: "ready",
  messages: [
    {
      role: "user",
      kind: "text",
      requestId: "r0",
      ts: NOW - 60_000,
      bytes: 24,
      preview: "fix the limiter",
      blocks: [{ type: "text", text: "fix the limiter" }],
    },
    {
      role: "assistant",
      kind: "text",
      requestId: "r0",
      ts: NOW - 59_000,
      bytes: 48,
      preview: "on it",
      blocks: [{ type: "text", text: "on it" }],
    },
    {
      role: "user",
      kind: "text",
      requestId: "a",
      ts: NOW - 5_000,
      bytes: 96,
      preview: "and add a test",
      blocks: [{ type: "text", text: "and add a test" }],
    },
  ],
  totals: { messages: 3, approxTokens: 42, usage: USAGE, cacheTokens: 440 },
  note: "System prompt and tool definitions are not in the transcript.",
  next: null,
  loadingOlder: false,
};

describe("the drawer header", () => {
  it("shows a failed request's provider reason beside its status badge", () => {
    const { container } = renderApp(
      <Drawer />,
      {
        request: "a",
        requests: [
          makeRequest({
            id: "a",
            model: "glm-5.3",
            ts: NOW - 5_000,
            stopReason: "502",
            error: "connection failed (ECONNREFUSED)",
          }),
        ],
      },
      NOW,
    );
    expect(container.querySelector("#drawer-title")?.textContent).toContain("HTTP 502");
    const reason = container.querySelector("#drawer-title .text-error");
    expect(reason?.textContent).toBe("connection failed (ECONNREFUSED)");
    expect(reason?.getAttribute("title")).toBe("connection failed (ECONNREFUSED)");
  });

  it("names a route line's parent agent among the identifiers", () => {
    const { container } = renderApp(
      <Drawer />,
      {
        request: "a",
        requests: [makeRequest({ id: "a", model: "glm-5.3", ts: NOW - 5_000, parentAgentId: "a31cd3de" })],
      },
      NOW,
    );
    expect(container.textContent).toContain("Parent agent");
    expect(container.textContent).toContain("a31cd3de");
  });
});

describe("the Context tab", () => {
  it("lists the conversation newest last, with the totals and the transcript's honest note", () => {
    const { container } = openOn("context", READY);
    const rows = [...container.querySelectorAll(".ctx-msg > summary")].map((row) => row.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("user");
    expect(rows[0]).toContain("24 B");
    expect(rows[0]).toContain("fix the limiter");
    expect(rows[1]).toContain("assistant");
    expect(rows[2]).toContain("and add a test"); // this request's input is the last turn
    expect(container.querySelector(".stats")?.textContent).toContain("3 messages");
    expect(container.querySelector(".stats")?.textContent).toContain("≈ 42");
    expect(container.querySelector(".stats")?.textContent).toContain("440");
    expect(container.textContent).toContain("System prompt and tool definitions are not in the transcript.");
  });

  it("opens a collapsed row into its blocks", async () => {
    const { container } = openOn("context", READY);
    const details = container.querySelector(".ctx-msg");
    expect(details?.getAttribute("open")).toBeNull(); // folded: closed until the reader asks
    expect(details?.querySelectorAll("details.collapse")).toHaveLength(1);
    await userEvent.click(details?.querySelector("summary") as HTMLElement);
    expect(details?.getAttribute("open")).not.toBeNull();
  });

  it("offers the page before this one while there is one, and says when the conversation is complete", async () => {
    const partial = { ...READY, totals: { ...READY.totals, messages: 6 }, next: `${NOW - 60_000}:r0:0` };
    const { act, unmount } = openOn("context", partial);
    await userEvent.click(screen.getByRole("button", { name: "Load 3 earlier messages" }));
    expect(act).toHaveBeenCalledWith("context-more");
    unmount();
    const done = openOn("context", READY);
    expect(done.container.textContent).toContain("The conversation begins here");
    expect(done.container.querySelector("[data-action='context-more']")).toBeNull();
  });

  it("shows the skeleton while the server rebuilds, and the words for missing, off and error", () => {
    const loading = openOn("context", { status: "loading" });
    expect(loading.container.querySelectorAll(".skeleton").length).toBeGreaterThan(3);
    expect(loading.container.textContent).toContain("Rebuilding the conversation");
    loading.unmount();
    const cases: [Record<string, unknown>, string][] = [
      [
        { status: "missing" },
        "Not in the history store: older than retention, or captured before history was on",
      ],
      [{ status: "off" }, "History is off, so the conversation cannot be rebuilt"],
      [{ status: "error" }, "The stored conversation could not be read"],
    ];
    for (const [state, words] of cases) {
      const view = openOn("context", state);
      expect(view.container.textContent).toContain(words);
      view.unmount();
    }
  });

  it("says plainly when nothing was captured for this request", () => {
    const view = openOn("context", {
      ...READY,
      messages: [],
      totals: { messages: 0, approxTokens: 0, usage: null, cacheTokens: 0 },
      note: null,
    });
    expect(view.container.textContent).toContain("Nothing was captured for this request's turn");
    expect(view.container.textContent).toContain("No usage reported for this request");
  });

  it("folds the captured prompt above the messages, its size and tool count on the row", () => {
    const { container } = openOn("context", READY, { capture: { a: CAPTURED } });
    const section = container.querySelector("details.collapse:not(.ctx-msg)");
    expect(section).toBeTruthy();
    expect(section?.getAttribute("open")).toBeNull(); // folded until the reader asks
    expect(section?.querySelector("summary")?.textContent).toContain("System prompt and tools");
    expect(section?.querySelector("summary")?.textContent).toContain(fmtBytes(CAPTURED.bytes));
    expect(section?.querySelector("summary")?.textContent).toContain("1 tool");
    // everything it holds sits inside the fold, ready when it opens
    expect(section?.textContent).toContain("be brief");
    expect(section?.textContent).toContain("Bash");
    expect(section?.textContent).toContain("Run a shell command");
    expect(section?.textContent).toContain('"type": "object"');
    expect(section?.textContent).toContain("request-id");
    expect(section?.textContent).toContain("req_1");
    // it sits above the conversation's turns
    const rows = [...container.querySelectorAll("details.collapse")];
    expect(rows[0]).toBe(section);
  });

  it("shows nothing of a prompt the request did not carry, and says so while it reads", () => {
    const absent = openOn("context", READY, { capture: { a: { status: "missing" } } });
    expect(absent.container.textContent).not.toContain("System prompt and tools");
    absent.unmount();
    const reading = openOn("context", READY);
    expect(reading.container.textContent).toContain("Reading the captured prompt");
    reading.unmount();
    const broken = openOn("context", READY, { capture: { a: { status: "error", cause: "→ 500" } } });
    expect(broken.container.textContent).toContain("The captured prompt could not be read");
  });
});

describe("the Raw tab", () => {
  it("pretty-prints the record and both sides, with one Copy as JSON button", () => {
    const { container } = openOn("raw", {
      status: "ready",
      input: [{ type: "text", text: "the prompt" }],
      output: null,
      bytes: 22,
    });
    const code = container.querySelector(".raw-code code")?.textContent ?? "";
    expect(code).toContain('"model": "glm-5.3"');
    expect(code).toContain('"input"');
    expect(container.querySelector(".mockup-code")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy as JSON" })).toBeTruthy();
    expect(container.textContent).toContain("The request record and both stored sides.");
  });

  it("says what is missing when the sides are loading, gone or broken", () => {
    const empty = openOn("raw", { status: "loading" });
    expect(empty.container.textContent).toContain("The stored sides load with the Input or Output tab");
    expect(empty.container.querySelector(".raw-code code")?.textContent).toContain('"request"');
    empty.unmount();
    const missing = openOn("raw", { status: "missing" });
    expect(missing.container.textContent).toContain("the stored sides are unavailable");
  });
});
