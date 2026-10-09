import { screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Summary } from "../../src/shared/model.ts";
import { ZERO_TOKENS } from "../../src/shared/model.ts";
import type { SessionListItem } from "../../src/store/store.ts";
import { Rail } from "../../src/ui/app/Rail.tsx";
import { ShortcutsModal } from "../../src/ui/app/ScopeHeader.tsx";
import { renderApp } from "./render.tsx";

const NOW = 1_800_000_000_000;

function item(id: string): SessionListItem {
  return {
    id,
    project: null,
    cwd: null,
    name: null,
    branch: null,
    repo: null,
    parentSessionId: null,
    startedAt: null,
    endedAt: null,
    live: false,
    status: null,
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
  };
}

function summary(startedAt: number | null): Summary {
  return {
    sessions: 1,
    liveSessions: 1,
    agents: 1,
    requests: 0,
    tokens: { ...ZERO_TOKENS },
    errors: 0,
    toolCalls: 0,
    latencyP50: null,
    latencyP95: null,
    startedAt,
    now: NOW,
  };
}

describe("Rail", () => {
  it("is exactly 24rem wide on base-200, pinned from both sides so the drawer cannot resize it", () => {
    renderApp(<Rail />);
    const aside = document.querySelector("aside[aria-label='Sessions rail']");
    expect(aside).not.toBeNull();
    const classes = (aside as HTMLElement).className.split(" ");
    for (const pinned of ["w-96", "min-w-96", "max-w-96"]) {
      expect(classes).toContain(pinned);
    }
    expect(classes).toContain("bg-base-200");
  });

  it("shows the skeleton while connecting and the session list once a snapshot arrived", () => {
    const connecting = renderApp(<Rail />);
    expect(document.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    expect(screen.queryByText("All sessions")).toBeNull();
    connecting.unmount();
    renderApp(<Rail />, { summary: summary(NOW), sessions: [item("s1")] });
    expect(document.querySelectorAll(".skeleton")).toHaveLength(0);
    expect(screen.getByText("All sessions")).toBeTruthy();
  });

  it("carries no brand of its own: the wordmark lives in the top bar now", () => {
    renderApp(<Rail />, { summary: summary(NOW), sessions: [item("s1")] });
    expect(screen.queryByText("Radar")).toBeNull();
  });

  it("keeps the facts to one connection line and the Shortcuts key — no wall of text", () => {
    renderApp(<Rail />, { summary: summary(NOW - 125_000), updatedAt: NOW - 5_000, connected: true }, NOW);
    const footer = document.querySelector("[data-rail-footer]");
    expect(footer?.textContent).toContain("Connected, updated 5s ago");
    expect(footer?.querySelector(".status-success")).not.toBeNull();
    expect(footer?.querySelector(".neon-dot")).not.toBeNull();
    // the old footer's facts are gone: uptime and host moved to Settings, the keys live in the modal
    expect(footer?.textContent).not.toContain("Up ");
    expect(footer?.textContent).not.toContain("The live stream reconnects");
    expect(document.querySelectorAll("kbd")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Shortcuts" })).toBeTruthy();
  });

  it("says Catching up while the server reports it is still reading its backlog", () => {
    renderApp(
      <Rail />,
      { summary: summary(NOW), updatedAt: NOW - 5_000, connected: true, catchingUp: true },
      NOW,
    );
    const footer = document.querySelector("[data-rail-footer]");
    expect(footer?.textContent).toContain("Catching up");
    expect(footer?.querySelector(".status-info")).not.toBeNull();
    expect(footer?.textContent).not.toContain("Connected, updated");
  });

  it("says Reconnecting while the stream is down", () => {
    renderApp(<Rail />, { summary: summary(NOW), connected: false, updatedAt: NOW - 5_000 }, NOW);
    const footer = document.querySelector("[data-rail-footer]");
    expect(footer?.textContent).toContain("Reconnecting");
    expect(footer?.querySelector(".status-warning")).not.toBeNull();
  });

  it("opens the shared shortcuts modal from its Shortcuts button", async () => {
    renderApp(
      <>
        <ShortcutsModal />
        <Rail />
      </>,
      { summary: summary(NOW), sessions: [item("s1")] },
    );
    const dialog = document.querySelector<HTMLDialogElement>("#radar-shortcuts");
    await userEvent.click(screen.getByRole("button", { name: "Shortcuts" }));
    expect(dialog?.hasAttribute("open")).toBe(true);
  });
});
