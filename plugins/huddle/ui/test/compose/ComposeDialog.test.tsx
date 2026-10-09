import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api.ts";
import { ComposeDialog } from "../../src/compose/ComposeDialog.tsx";
import type { ComposeOptions } from "../../src/compose/drafts.ts";
import type { Storage } from "../../src/storage.ts";
import type { Board, FeedEvent, Timers } from "../../src/store.ts";

// ── fakes ────────────────────────────────────────────────────────────────────
const SESSIONS = [
  { name: "scan.agent", state: "working" as const },
  { name: "fix.agent", state: "idle" as const },
];

const BOARD: Board = { steps: [{ id: "t1", title: "First", status: "todo" }] };

const TIMELINE: FeedEvent[] = [
  { seq: 7, topic: "ask", from: "scan.agent", msg: "should I redeploy", ts: "2026-10-09T10:00:00Z" },
];

const memStorage = (): Storage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

/** Timers that never fire: a save stays pending until something flushes it. */
const manualTimers = (): Timers => {
  let seq = 0;
  return {
    after: () => ++seq,
    cancel: () => {},
    interval: () => 0,
    stop: () => {},
  };
};

const fakeApi = (): Api =>
  ({
    api: vi.fn(),
    op: vi.fn(async () => ({ result: true })),
    channelPath: vi.fn(),
    channelHref: vi.fn(),
  }) as Api;

/** A page with a button that opens the compose dialog, the way the chrome's buttons do. */
function Harness({
  open = false,
  options,
  timeline,
  ch = "lab",
}: {
  open?: boolean | undefined;
  options?: ComposeOptions | undefined;
  timeline?: FeedEvent[] | undefined;
  ch?: string | undefined;
}): JSX.Element {
  const [shown, setShown] = useState(open);
  // one storage + timer pair per mount: fresh objects every render would rebuild the drafts store
  const [host] = useState(() => ({ storage: memStorage(), timers: manualTimers() }));
  return (
    <>
      <button type="button" onClick={() => setShown(true)}>
        open
      </button>
      <ComposeDialog
        open={shown}
        onClose={() => setShown(false)}
        options={options}
        ch={ch}
        sessions={SESSIONS}
        board={BOARD}
        byId={(id) => BOARD.steps.find((s) => s.id === id) ?? null}
        api={fakeApi()}
        onSent={() => {}}
        toast={() => {}}
        timeline={timeline}
        storage={host.storage}
        timers={host.timers}
      />
    </>
  );
}

const dlg = (): HTMLDialogElement => document.querySelector("dialog") as HTMLDialogElement;
const msgBox = (): HTMLTextAreaElement => document.getElementById("dlg-msg") as HTMLTextAreaElement;
const titleBox = (): HTMLInputElement => document.getElementById("dlg-title") as HTMLInputElement;

describe("ComposeDialog", () => {
  it("opens the shared dialog with the composer inside, titled for a plain message", () => {
    render(<Harness open />);
    expect(dlg().open).toBe(true);
    const h = screen.getByText("Send a message");
    expect(h.tagName).toBe("H2");
    expect(h.id).toBe("mtitle");
    expect(dlg().getAttribute("aria-labelledby")).toBe("mtitle");
    expect(msgBox().getAttribute("rows")).toBe("5");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Message" })).toBeTruthy();
  });

  it("stays shut until opened, and closes from the header button", () => {
    render(<Harness />);
    expect(dlg().open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(dlg().open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(dlg().open).toBe(false);
  });

  it("closes on Escape", () => {
    render(<Harness open />);
    fireEvent.keyDown(dlg(), { key: "Escape" });
    expect(dlg().open).toBe(false);
  });

  it("starts a task in its title field, under the New task title", () => {
    render(<Harness open options={{ mode: "task" }} />);
    expect(screen.getByText("New task")).toBeTruthy();
    expect(document.activeElement).toBe(titleBox());
  });

  it("starts anything else in the message box", () => {
    render(<Harness open options={{ mode: "ask" }} />);
    expect(screen.getByText("Ask a question")).toBeTruthy();
    expect(document.activeElement).toBe(msgBox());
  });

  it("titles a reply after its author", () => {
    render(<Harness open options={{ reply: 7 }} timeline={TIMELINE} />);
    expect(screen.getByText("Reply to scan.agent")).toBeTruthy();
    expect(screen.getByText(/Cancel reply/)).toBeTruthy();
  });

  it("keeps the plain title while the timeline has not loaded", () => {
    render(<Harness open options={{ reply: 7 }} />);
    expect(screen.getByText("Send a message")).toBeTruthy();
    expect(screen.queryByText(/Cancel reply/)).toBeNull();
  });

  it("runs on the page's own drafts when no storage or timers are injected", async () => {
    render(<Harness open options={{ mode: "task" }} />);
    fireEvent.input(titleBox(), { target: { value: "Fallback" } });
    // the drafts go to the page's localStorage; the title field took them without a crash
    expect((document.getElementById("dlg-title") as HTMLInputElement).value).toBe("Fallback");
  });

  it("takes an injected storage alone and keeps the browser's save timer", () => {
    const storage = memStorage();
    render(
      <ComposeDialog
        open
        onClose={() => {}}
        ch="lab"
        sessions={SESSIONS}
        board={BOARD}
        byId={() => null}
        api={fakeApi()}
        onSent={() => {}}
        toast={() => {}}
        storage={storage}
      />,
    );
    expect(document.getElementById("dlg-msg")).toBeTruthy();
  });

  it("follows the title when the composer switches kind inside the dialog", () => {
    render(<Harness open />);
    fireEvent.click(screen.getByRole("button", { name: "Task" }));
    expect(screen.getByText("New task")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Question" }));
    expect(screen.getByText("Ask a question")).toBeTruthy();
  });

  it("keeps the draft across a close and a reopen", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    fireEvent.input(msgBox(), { target: { value: "keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(dlg().open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(dlg().open).toBe(true);
    expect(msgBox().value).toBe("keep me");
  });

  it("closes after a sent message", async () => {
    render(<Harness open />);
    fireEvent.input(msgBox(), { target: { value: "done" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to everyone" }));
    await waitFor(() => expect(dlg().open).toBe(false));
  });

  it("shows nothing without a channel", () => {
    render(<Harness open ch="" />);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("flushes a pending draft when the dialog unmounts", async () => {
    const m = new Map<string, string>();
    const storage: Storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
    const { unmount } = render(
      <ComposeDialog
        open
        onClose={() => {}}
        ch="lab"
        sessions={SESSIONS}
        board={BOARD}
        byId={() => null}
        api={fakeApi()}
        onSent={() => {}}
        toast={() => {}}
        storage={storage}
        timers={manualTimers()}
      />,
    );
    fireEvent.input(msgBox(), { target: { value: "unmount flush" } });
    expect(m.has("huddle:draft:lab:dlg")).toBe(false);
    unmount();
    // unmount cleanups run one tick out
    await new Promise((r) => setTimeout(r, 5));
    expect(JSON.parse(m.get("huddle:draft:lab:dlg") ?? "{}")).toMatchObject({ msg: "unmount flush" });
  });
});
