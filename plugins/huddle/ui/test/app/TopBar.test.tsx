// TopBar.test.tsx — the glass bar: the brand with its version, the channel word, the live pill,
// the inbox bell with its needs-you count, and the theme menu over the shared palettes.
import { act, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Brand,
  ChannelWord,
  InboxBell,
  LivePill,
  ThemeMenu,
  TopBar,
  useVersion,
} from "../../src/app/TopBar.tsx";
import { flush, stubMatchMedia } from "../helpers.tsx";

beforeEach(() => {
  localStorage.clear();
  stubMatchMedia(false);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ version: "1.2.3" }) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Brand", () => {
  it("links Home, names the word and keeps a version badge", () => {
    render(<Brand />);
    expect(screen.getByLabelText("Huddle: all channels").getAttribute("href")).toBe("#/");
    expect(screen.getByText("Huddle")).toBeDefined();
    expect(screen.getByText("v0.0.1")).toBeDefined();
  });

  it("shows the server's version once /health answers, and the placeholder when it fails", async () => {
    const probe = render(<VersionProbe />);
    await flush();
    expect(probe.container.textContent).toContain("1.2.3");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("down"))),
    );
    const fallback = render(<VersionProbe />);
    await flush();
    expect(fallback.container.textContent).toContain("0.0.1");
  });
});

/** The hook alone, so the /health read is testable without the whole brand. */
function VersionProbe() {
  return <span>{useVersion()}</span>;
}

describe("ChannelWord", () => {
  it("names the channel with its online count, and stays out without one", () => {
    const { container } = render(<ChannelWord name="Checkout" count={3} />);
    expect(screen.getByText("Checkout")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(container.querySelector("[data-channel-word]")).not.toBeNull();
    const empty = render(<ChannelWord name={null} count={0} />);
    expect(empty.container.querySelector("[data-channel-word]")).toBeNull();
  });
});

describe("the live pill", () => {
  it("shows connecting, live and reconnecting", () => {
    const { rerender, container } = render(<LivePill live="connecting" />);
    const pill = container.querySelector("#ldot") as HTMLElement;
    expect(pill.className).toBe("shrink-0 badge badge-ghost gap-1.5");
    expect(pill.getAttribute("aria-label")).toBe("Live updates: connecting");
    expect(pill.textContent).toContain("Connecting…");
    rerender(<LivePill live="live" />);
    expect(pill.className).toBe("shrink-0 badge badge-soft badge-success gap-1.5");
    expect(pill.getAttribute("title")).toBe("Live updates: on");
    expect(pill.textContent).toContain("Live");
    rerender(<LivePill live="offline" />);
    expect(pill.className).toBe("shrink-0 badge badge-soft badge-warning gap-1.5");
    expect(pill.getAttribute("aria-label")).toBe("Live updates: reconnecting");
    expect(pill.textContent).toContain("Reconnecting");
  });
});

describe("the inbox bell", () => {
  it("carries the needs-you count and links to the inbox", () => {
    const { container } = render(<InboxBell n={4} href="#/c/ch/inbox" />);
    const bell = screen.getByLabelText("Inbox, 4 needs you");
    expect(bell.getAttribute("href")).toBe("#/c/ch/inbox");
    expect(container.querySelector(".indicator-item")?.textContent).toBe("4");
  });

  it("reads quiet when nothing needs the owner", () => {
    const { container } = render(<InboxBell n={0} href="#/c/ch/inbox" />);
    expect(screen.getByLabelText("Inbox")).toBeDefined();
    expect(container.querySelector(".indicator-item")).toBeNull();
  });
});

describe("the theme menu", () => {
  it("opens with the three shared palettes, checks the current one, and keeps a pick", () => {
    render(<ThemeMenu />);
    act(() => {
      (screen.getByLabelText("Theme: System") as HTMLButtonElement).click();
    });
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    expect(menu.textContent).toContain("System");
    expect(menu.textContent).toContain("Mocha");
    expect(menu.textContent).toContain("Latte");
    expect(menu.querySelector('[aria-checked="true"]')?.textContent).toContain("System");
    act(() => {
      [...menu.querySelectorAll("button")].find((b) => b.textContent?.includes("Mocha"))?.click();
    });
    expect(localStorage.getItem("huddle:theme")).toBe('"mocha"');
    expect(document.documentElement.dataset.theme).toBe("mocha");
    expect(screen.getByLabelText("Theme: Mocha")).toBeDefined();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("reopens on the kept choice after a reload and migrates a legacy pick", () => {
    localStorage.setItem("huddle:theme", '"light"');
    render(<ThemeMenu />);
    expect(document.documentElement.dataset.theme).toBe("latte");
    expect(localStorage.getItem("huddle:theme")).toBe('"latte"');
    expect(screen.getByLabelText("Theme: Latte")).toBeDefined();
  });

  it("applies the system's dark palette when nothing is kept", () => {
    stubMatchMedia(true);
    render(<ThemeMenu />);
    expect(document.documentElement.dataset.theme).toBe("mocha");
  });

  it("does not follow the system once a palette is picked", () => {
    const mq = stubMatchMedia(false);
    render(<ThemeMenu />);
    expect(document.documentElement.dataset.theme).toBe("latte");
    act(() => {
      (screen.getByLabelText("Theme: System") as HTMLButtonElement).click();
    });
    [...(document.querySelector('[role="menu"]')?.querySelectorAll("button") ?? [])]
      .find((b) => b.textContent?.includes("Mocha"))
      ?.click();
    expect(document.documentElement.dataset.theme).toBe("mocha");
    act(() => {
      mq.fire();
    });
    expect(document.documentElement.dataset.theme).toBe("mocha");
  });
});

describe("TopBar", () => {
  it("lays out brand, channel word and the controls, with the neon line under it", () => {
    render(
      <TopBar
        channel="Checkout"
        online={3}
        live="live"
        inbox={2}
        inboxHref="#/c/ch/inbox"
        onPalette={() => {}}
        onHelp={() => {}}
      />,
    );
    expect(document.querySelector("header[data-scope-header]")).not.toBeNull();
    expect(document.querySelector("header .neon-line")).not.toBeNull();
    expect(screen.getByText("Checkout")).toBeDefined();
    expect(screen.getByLabelText("Search or run a command")).toBeDefined();
    expect(screen.getByLabelText("Inbox, 2 needs you")).toBeDefined();
    expect(screen.getByLabelText("Keyboard shortcuts")).toBeDefined();
    expect(screen.getByLabelText("Theme: System")).toBeDefined();
  });

  it("runs the palette and the shortcuts keys, and hides the channel word without a channel", () => {
    const onPalette = vi.fn();
    const onHelp = vi.fn();
    render(
      <TopBar
        channel={null}
        online={0}
        live="live"
        inbox={0}
        inboxHref="#/c/ch/inbox"
        onPalette={onPalette}
        onHelp={onHelp}
      />,
    );
    act(() => {
      screen.getByLabelText("Search or run a command").click();
    });
    act(() => {
      screen.getByLabelText("Keyboard shortcuts").click();
    });
    expect(onPalette).toHaveBeenCalledTimes(1);
    expect(onHelp).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-channel-word]")).toBeNull();
  });
});
