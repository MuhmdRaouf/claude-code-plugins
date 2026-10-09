// context.test.tsx — the shell's context: what a page reads, and the owner actions it takes.
import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import {
  createAct,
  createCopy,
  errText,
  type HuddleContextValue,
  HuddleProvider,
  useHuddle,
} from "../../src/app/context.tsx";
import { makeCtx, makeState, stubClipboard } from "../helpers.tsx";

describe("HuddleProvider / useHuddle", () => {
  it("hands the value to the tree below it", () => {
    let seen: HuddleContextValue | null = null;
    function Probe(): null {
      seen = useHuddle();
      return null;
    }
    const ctx = makeCtx(makeState());
    render(
      <HuddleProvider value={ctx}>
        <Probe />
      </HuddleProvider>,
    );
    expect(seen).toBe(ctx);
  });

  it("refuses to run without a provider", () => {
    function Probe(): null {
      useHuddle();
      return null;
    }
    expect(() => render(<Probe />)).toThrow(/no HuddleProvider/);
  });
});

describe("createAct", () => {
  it("posts to the open channel and gives the op's result", async () => {
    const op = vi.fn().mockResolvedValue({ result: "done" });
    const act = createAct(makeCtx(makeState()).api, () => "ch", vi.fn());
    // act closes over the api client the test hands in; give it the mock
    const withMock = createAct({ ...makeCtx(makeState()).api, op }, () => "ch", vi.fn());
    expect(await withMock("resume", { who: "api" })).toBe("done");
    expect(op).toHaveBeenCalledWith("ch", "resume", { who: "api" });
    expect(act).toBeDefined();
  });

  it("gives true when the op answers without a result", async () => {
    const act = createAct(
      { ...makeCtx(makeState()).api, op: () => Promise.resolve({}) },
      () => "ch",
      vi.fn(),
    );
    expect(await act("resume")).toBe(true);
  });

  it("toasts a refusal in red and gives null", async () => {
    const toast = vi.fn();
    const act = createAct(
      { ...makeCtx(makeState()).api, op: () => Promise.reject(new Error("waits on build")) },
      () => "ch",
      toast,
    );
    expect(await act("resume")).toBeNull();
    expect(toast).toHaveBeenCalledWith("waits on build", { bad: true });
  });

  it("explains a server that does not know the operation yet", async () => {
    const toast = vi.fn();
    const e = Object.assign(new Error("no operation resume here"), { status: 404 });
    const act = createAct({ ...makeCtx(makeState()).api, op: () => Promise.reject(e) }, () => "ch", toast);
    await act("resume");
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("does not support “resume” yet"), {
      bad: true,
    });
  });

  it("does nothing without an open channel", async () => {
    const op = vi.fn();
    const act = createAct({ ...makeCtx(makeState()).api, op }, () => null, vi.fn());
    expect(await act("resume")).toBeNull();
    expect(op).not.toHaveBeenCalled();
  });
});

describe("createCopy", () => {
  it("writes the clipboard and toasts the message", async () => {
    const { writes } = stubClipboard();
    const toast = vi.fn();
    createCopy(toast)("the text", "Copied the text");
    await vi.waitFor(() => expect(writes).toEqual(["the text"]));
    expect(toast).toHaveBeenCalledWith("Copied the text");
  });

  it("says the default word when no message came, and the failure's own when the clipboard refuses", async () => {
    const toast = vi.fn();
    stubClipboard(() => Promise.reject(new Error("no")));
    createCopy(toast)("the text");
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Could not copy. Select the text and copy it by hand.", {
        bad: true,
      }),
    );
    const good = vi.fn();
    stubClipboard();
    createCopy(good)("x");
    await vi.waitFor(() => expect(good).toHaveBeenCalledWith("Copied"));
  });
});

describe("errText", () => {
  it("takes an Error's message, or the value itself", () => {
    expect(errText(new Error("boom"))).toBe("boom");
    expect(errText("plain")).toBe("plain");
    expect(errText(7)).toBe("7");
  });
});

describe("pages read the context", () => {
  it("gives them the state, the time and the toast", () => {
    function Page(): preact.JSX.Element {
      const { state, now, toast } = useHuddle();
      return (
        <button type="button" onClick={() => toast(`ch is ${state.ch} at ${now}`)}>
          ping
        </button>
      );
    }
    const ctx = makeCtx(makeState(), { now: 5 });
    render(
      <HuddleProvider value={ctx}>
        <Page />
      </HuddleProvider>,
    );
    screen.getByText("ping").click();
    expect(ctx.toast).toHaveBeenCalledWith("ch is ch at 5");
  });
});
