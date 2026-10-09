import { screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { SessionListItem } from "../../src/store/store.ts";
import { ScopeHeader } from "../../src/ui/app/ScopeHeader.tsx";
import { renderApp } from "./render.tsx";

function item(id: string, over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    project: "app",
    cwd: "/w/app",
    name: `Session ${id}`,
    branch: null,
    repo: "/w/app",
    parentSessionId: null,
    startedAt: null,
    endedAt: null,
    live: true,
    status: "working",
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

describe("the top bar's brand row", () => {
  it("carries the glowing word, the 40px logo and the version badge", () => {
    renderApp(<ScopeHeader />);
    const brand = document.querySelector("[data-brand]");
    expect(brand?.querySelector('[data-icon="logo"]')?.className).toContain("size-10");
    expect(screen.getByText("Radar").className).toContain("neon-text");
    expect(screen.getByText("Radar").className).toContain("text-xl");
    expect(screen.getByText(/^v/).className).toContain("badge-ghost");
    // the hamburger slides the rail in below lg only
    const opener = document.querySelector('label[for="radar-rail"]');
    expect(opener?.getAttribute("aria-label")).toBe("Open the sessions rail");
    expect(opener?.className).toContain("lg:hidden");
    expect(opener?.className).toContain("btn-square");
  });
});

describe("the selection bar", () => {
  it("reads All sessions with the count while nothing is picked", () => {
    const { container } = renderApp(<ScopeHeader />, { sessions: [item("s1"), item("s2")] });
    const bar = container.querySelector("[data-selection-bar]");
    expect(bar?.textContent).toContain("All sessions");
    expect(bar?.textContent).toContain("2");
    expect(bar?.className).toContain("text-base-content/60");
  });

  it("shows one removable badge per pick, Clear, and +N with the rest named in its title", async () => {
    const { act } = renderApp(<ScopeHeader />, {
      sessions: [item("s1"), item("s2"), item("s3"), item("s4"), item("s5")],
      selected: ["s1", "s2", "s3", "s4", "s5"],
    });
    const bar = document.querySelector("[data-selection-bar]");
    expect(bar?.textContent).toContain("Viewing");
    const badges = [...(bar?.querySelectorAll(".badge.badge-primary") ?? [])];
    expect(badges).toHaveLength(3); // first three picks as badges, the rest as +2
    expect(badges[0]?.className).toContain("badge-soft");
    expect(badges[0]?.className).toContain("badge-lg");
    expect(badges[0]?.textContent).toContain("Session s1");
    const rest = bar?.querySelector('.badge[title*="Session s4"]');
    expect(rest?.textContent).toBe("+2");
    expect(rest?.getAttribute("title")).toBe("Session s4, Session s5");
    // each badge carries its × with the stop-viewing label, running the toggle action
    const stop = screen.getByRole("button", { name: "Stop viewing Session s1" });
    expect(stop.getAttribute("data-action")).toBe("session");
    expect(stop.getAttribute("data-value")).toBe("s1");
    await userEvent.click(stop);
    expect(act).toHaveBeenCalledWith("session", "s1");
    // Clear runs clearSelection and says view-all to a screen reader
    const clear = screen.getByRole("button", { name: "View all sessions" });
    expect(clear.getAttribute("data-action")).toBe("clearSelection");
    await userEvent.click(clear);
    expect(act).toHaveBeenCalledWith("clearSelection");
  });

  it("names a pick the store has not seen by its id, and reads the fleet when nothing is picked", () => {
    const ghost = renderApp(<ScopeHeader />, { selected: ["ghost"] });
    expect(document.querySelector("[data-selection-bar]")?.textContent).toContain("ghost");
    ghost.unmount();
    renderApp(<ScopeHeader />, { sessions: [] });
    expect(document.querySelector("[data-selection-bar]")?.textContent).toContain("All sessions");
  });
});

describe("the live word", () => {
  it("is a glowing success dot and Live while connected, a warning Reconnecting while not", () => {
    const up = renderApp(<ScopeHeader />, { connected: true });
    const live = screen.getByTitle("Connected to the radar server");
    expect(live.textContent).toContain("Live");
    expect(live.querySelector(".status-success")).not.toBeNull();
    expect(live.querySelector(".neon-dot")).not.toBeNull();
    up.unmount();
    renderApp(<ScopeHeader />, { connected: false });
    const down = screen.getByTitle("The live stream is down and reconnects on its own");
    expect(down.textContent).toContain("Reconnecting");
    expect(down.querySelector(".status-warning")).not.toBeNull();
  });
});

describe("the alerts bell", () => {
  it("wears the count as an error indicator badge and opens the Alerts tab", async () => {
    const alert = { id: "a1" } as never;
    const { act } = renderApp(<ScopeHeader />, { alerts: [alert, alert, alert] });
    const bell = screen.getByRole("button", { name: "Alerts, 3 open" });
    expect(bell.className).toContain("btn-square");
    expect(bell.querySelector(".indicator-item.badge-error")?.textContent).toBe("3");
    expect(bell.querySelector(".indicator")).not.toBeNull();
    expect(bell.getAttribute("data-action")).toBe("tab");
    await userEvent.click(bell);
    expect(act).toHaveBeenCalledWith("tab", "alerts");
  });

  it("wears no badge while nothing fires", () => {
    renderApp(<ScopeHeader />);
    expect(screen.getByRole("button", { name: "Alerts" }).querySelector(".indicator-item")).toBeNull();
  });
});

describe("the theme dropdown", () => {
  it("lists System, Mocha and Latte with the current one pressed, and runs the theme action", async () => {
    const { act } = renderApp(<ScopeHeader />, { theme: "dark" });
    const summary = document.querySelector("[data-theme-dropdown] > summary");
    expect(summary?.getAttribute("aria-label")).toBe("Theme: Mocha (dark)");
    expect(summary?.querySelector('[data-icon="moon"]')).not.toBeNull();
    await userEvent.click(summary as HTMLElement);
    const choices = [...document.querySelectorAll('[data-action="theme"]')];
    expect(choices.map((choice) => choice.getAttribute("data-value"))).toEqual(["system", "dark", "light"]);
    expect(choices[1]?.className).toContain("menu-active");
    await userEvent.click(choices[0] as HTMLElement);
    expect(act).toHaveBeenCalledWith("theme", "system");
  });

  it("shows the system choice's monitor icon by default, and keeps the time-format choice", async () => {
    const { act } = renderApp(<ScopeHeader />, { theme: "system", timeMode: "relative" });
    await userEvent.click(document.querySelector("[data-theme-dropdown] > summary") as HTMLElement);
    expect(document.querySelector('[data-icon="monitor"]')).not.toBeNull();
    const select = screen.getByLabelText("Time format") as HTMLSelectElement;
    expect(select.value).toBe("relative");
    await userEvent.selectOptions(select, "absolute");
    expect(act).toHaveBeenCalledWith("time-mode", "absolute");
  });
});

describe("the shortcuts modal", () => {
  it("opens from the ? button and lists every key, X clearing the selection among them", async () => {
    renderApp(<ScopeHeader />);
    const dialog = document.querySelector<HTMLDialogElement>("#radar-shortcuts");
    expect(dialog).not.toBeNull();
    expect(dialog?.hasAttribute("open")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(dialog?.hasAttribute("open")).toBe(true);
    const text = dialog?.textContent ?? "";
    for (const word of [
      "Refresh now",
      "Newer request",
      "Previous request",
      "Walk the session cards",
      "Toggle a session in the view",
      "Clear the selection",
    ]) {
      expect(text).toContain(word);
    }
    expect(dialog?.querySelectorAll("kbd").length).toBeGreaterThanOrEqual(8);
  });
});
