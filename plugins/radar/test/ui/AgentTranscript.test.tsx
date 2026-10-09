import { render } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import type { ComponentChildren } from "preact";
import { describe, expect, it, vi } from "vitest";
import { AgentTranscript } from "../../src/ui/app/AgentTranscript.tsx";
import { AppContext, type AppValue } from "../../src/ui/app/context.ts";
import type { ClientState, ContextMessage } from "../../src/ui/state.ts";
import { initialClientState } from "../../src/ui/state.ts";
import { makeAgentView, makeSessionView } from "../helpers.ts";

const NOW = 1_790_000_000_000;

const DETAIL = makeSessionView({
  id: "s1",
  agents: [
    makeAgentView({ id: "main", requests: 5, model: "claude-opus-5-5", live: true, lastAt: NOW }),
    makeAgentView({
      id: "a1",
      parentId: "main",
      kind: "subagent",
      name: "digger",
      requests: 2,
      live: false,
      lastAt: NOW - 60_000,
    }),
  ],
});

function message(over: Partial<ContextMessage> & { role: ContextMessage["role"] }): ContextMessage {
  return {
    kind: "text",
    requestId: "req-1",
    ts: NOW - 30_000,
    bytes: 24,
    preview: "fix the limiter",
    blocks: [{ type: "text", text: "fix the limiter" }],
    ...over,
  };
}

const USER = message({ role: "user" });
const ASSISTANT = message({
  role: "assistant",
  requestId: "req-1",
  ts: NOW - 20_000,
  bytes: 96,
  preview: "on it",
  blocks: [
    { type: "text", text: "on it" },
    { type: "thinking", thinking: "reading the code" },
  ],
});
const TOOLY = message({
  role: "assistant",
  requestId: "req-2",
  ts: NOW - 10_000,
  bytes: 240,
  preview: "Bash",
  blocks: [{ type: "tool_use", id: "call1", name: "Bash", input: { command: "ls" } }],
});

function ready(over: Record<string, unknown> = {}): ClientState["agentTranscript"] {
  return {
    status: "ready",
    requestId: "req-1",
    messages: [USER, ASSISTANT],
    totals: { messages: 2, approxTokens: 40, usage: null, cacheTokens: 0 },
    note: "System prompt and tools are not in the transcript.",
    next: null,
    loadingOlder: false,
    ...over,
  } as ClientState["agentTranscript"];
}

/** Render the slide-over against a state box the test keeps mutating between rerenders. */
function mount(state: Partial<ClientState>, now = NOW) {
  const act = vi.fn<AppValue["act"]>();
  const current: ClientState = { ...initialClientState(), ...state };
  const tree = (value: ClientState): ComponentChildren => (
    <AppContext.Provider value={{ state: value, now, url: "127.0.0.1:4000", act }}>
      <AgentTranscript />
    </AppContext.Provider>
  );
  const result = render(tree(current));
  const rerender = (over: Partial<ClientState>): void => {
    Object.assign(current, over);
    result.rerender(tree({ ...current }));
  };
  return { ...result, act, rerender };
}

function body(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-slide-over-body]");
  if (el === null) throw new Error("no slide-over body");
  return el;
}

/** Pin the slide-over's body to fake dimensions and tell it where the reader sits. */
function scroll(body: HTMLElement, top: number): void {
  Object.defineProperty(body, "scrollHeight", { configurable: true, value: 1000, writable: true });
  Object.defineProperty(body, "clientHeight", { configurable: true, value: 400, writable: true });
  Object.defineProperty(body, "scrollTop", { configurable: true, value: top, writable: true });
  body.dispatchEvent(new Event("scroll"));
}

describe("AgentTranscript", () => {
  it("renders nothing while closed", () => {
    const { container } = mount({ agentNode: null, agentTranscript: null });
    expect(container.querySelector("dialog")).toBeNull();
  });

  it("renders the conversation as a chat, prompts starting and answers ending, each with its time", () => {
    const { container } = mount({
      agentNode: "s1/main",
      agentTranscript: ready(),
      details: { s1: DETAIL },
    });
    const chats = [...container.querySelectorAll(".chat")];
    expect(chats.map((chat) => chat.classList.contains("chat-start"))).toEqual([true, false]);
    expect(chats.map((chat) => chat.classList.contains("chat-end"))).toEqual([false, true]);
    expect(chats[0]?.querySelector(".badge")?.textContent).toBe("user");
    expect(chats[1]?.querySelector(".badge")?.textContent).toBe("assistant");
    expect(chats[1]?.querySelector("time")?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    // the blocks render through the inspector's renderers: a thinking row and its folds are all there
    expect(container.textContent).toContain("Thinking");
    expect(container.textContent).toContain("System prompt and tools are not in the transcript.");
  });

  it("renders a tool call bubble through the shared block renderer, folded as in the inspector", () => {
    const { container } = mount({
      agentNode: "s1/main",
      agentTranscript: ready({ messages: [USER, TOOLY] }),
      details: { s1: DETAIL },
    });
    expect(container.textContent).toContain("Tool call");
    expect(container.textContent).toContain("Bash");
  });

  it("shows the header facts and offers Show its requests", async () => {
    const { act, container } = mount({
      agentNode: "s1/main",
      agentTranscript: ready(),
      details: { s1: DETAIL },
    });
    const title = container.querySelector("#transcript-title");
    expect(title?.textContent).toContain("Main");
    expect(title?.textContent).toContain("main"); // the kind badge
    expect(title?.querySelector(".model-chip")?.textContent).toContain("Opus 5.5");
    expect(title?.querySelector(".badge-success")?.textContent).toContain("Live");
    expect(title?.textContent).toContain("5 requests");
    const show = title?.querySelector<HTMLButtonElement>('[data-action="agent-requests"]');
    expect(show?.textContent).toBe("Show its requests");
    await userEvent.click(show as HTMLElement);
    expect(act).toHaveBeenCalledWith("agent-requests", JSON.stringify({ sessionId: "s1", agentId: "main" }));
  });

  it("shows a subagent's name, kind and an Ended badge when it is done", () => {
    const { container } = mount({
      agentNode: "s1/a1",
      agentTranscript: ready(),
      details: { s1: DETAIL },
    });
    const title = container.querySelector("#transcript-title");
    expect(title?.textContent).toContain("digger");
    expect(title?.textContent).toContain("subagent");
    expect(title?.textContent).toContain("Ended");
    expect(title?.querySelector(".badge-success")).toBeNull();
  });

  it("falls back to the node id while the session detail has not arrived", () => {
    const { container } = mount({ agentNode: "s1/main", agentTranscript: ready() });
    expect(container.querySelector("#transcript-title")?.textContent).toContain("s1/main");
  });

  it("offers the page before this one and loads it through the controller", async () => {
    const { act, container } = mount({
      agentNode: "s1/main",
      agentTranscript: ready({ next: "900:req-0:0" }),
      details: { s1: DETAIL },
    });
    const more = container.querySelector<HTMLButtonElement>('[data-action="agent-transcript-more"]');
    expect(more?.textContent).toBe("Load earlier messages");
    await userEvent.click(more as HTMLElement);
    expect(act).toHaveBeenCalledWith("agent-transcript-more");
    // while it loads the button says so
    const loading = mount({
      agentNode: "s1/main",
      agentTranscript: ready({ next: "900:req-0:0", loadingOlder: true }),
      details: { s1: DETAIL },
    });
    expect(loading.container.querySelector('[data-action="agent-transcript-more"]')?.textContent).toBe(
      "Loading…",
    );
  });

  it("follows the newest message while the reader is at the bottom", () => {
    const view = mount({
      agentNode: "s1/main",
      agentTranscript: ready(),
      details: { s1: DETAIL },
    });
    expect(body().scrollTop).toBe(0); // happy-dom has no layout, so the first pin is a no-op
    scroll(body(), 600); // at the bottom: 600 + 400 >= 1000 - 80
    view.rerender({
      agentTranscript: ready({
        messages: [USER, ASSISTANT, message({ role: "user", requestId: "req-2", ts: NOW - 5_000 })],
      }),
    });
    expect(body().scrollTop).toBe(1000);
    expect(body().querySelector("button")?.textContent).not.toBe("New messages");
  });

  it("stays put when the reader scrolled up and offers the New messages jump", async () => {
    const view = mount({
      agentNode: "s1/main",
      agentTranscript: ready(),
      details: { s1: DETAIL },
    });
    scroll(body(), 0); // away from the bottom: 0 + 400 < 1000 - 80
    view.rerender({
      agentTranscript: ready({
        messages: [USER, ASSISTANT, message({ role: "user", requestId: "req-2", ts: NOW - 5_000 })],
      }),
    });
    expect(body().scrollTop).toBe(0);
    const jump = [...body().querySelectorAll("button")].find(
      (button) => button.textContent === "New messages",
    );
    expect(jump?.className).toContain("btn-primary");
    expect(jump?.className).toContain("btn-sm");
    await userEvent.click(jump as HTMLElement);
    expect(body().scrollTop).toBe(1000);
    expect([...body().querySelectorAll("button")].some((b) => b.textContent === "New messages")).toBe(false);
  });

  it("never mistakes an earlier page for new messages", () => {
    const view = mount({
      agentNode: "s1/main",
      agentTranscript: ready(),
      details: { s1: DETAIL },
    });
    scroll(body(), 0);
    view.rerender({
      agentTranscript: ready({
        messages: [message({ role: "user", requestId: "req-0", ts: NOW - 90_000 }), USER, ASSISTANT],
      }),
    });
    expect(body().scrollTop).toBe(0);
    expect(
      [...body().querySelectorAll("button")].some((button) => button.textContent === "New messages"),
    ).toBe(false);
  });

  it("says the words for nothing stored, missing, off and broken", async () => {
    const empty = mount({
      agentNode: "s1/main",
      agentTranscript: ready({ messages: [] }),
      details: { s1: DETAIL },
    });
    expect(empty.container.textContent).toContain("Nothing stored for this agent yet");
    empty.unmount();
    const missing = mount({ agentNode: "s1/main", agentTranscript: { status: "missing" } });
    expect(missing.container.textContent).toContain("Not in the history store");
    missing.unmount();
    const off = mount({ agentNode: "s1/main", agentTranscript: { status: "off" } });
    expect(off.container.textContent).toContain("History is off");
    off.unmount();
    const broken = mount({
      agentNode: "s1/main",
      agentTranscript: { status: "error", cause: "GET … → 500" },
    });
    expect(broken.container.querySelector('[role="alert"]')?.textContent).toContain(
      "The stored transcript could not be read: GET … → 500",
    );
    await userEvent.click(
      broken.container.querySelector<HTMLButtonElement>('[data-action="agent-transcript"]') as HTMLElement,
    );
    expect(broken.act).toHaveBeenCalledWith("agent-transcript", "s1/main");
  });

  it("shows the skeleton while the page loads", () => {
    const { container } = mount({ agentNode: "s1/main", agentTranscript: { status: "loading" } });
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });
});
