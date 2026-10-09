import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { PlanStep, RosterSession } from "../../src/store.ts";
import { onlineCount, Roster } from "../../src/team/Roster.tsx";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const board = new Map<string, PlanStep>([
  ["t1", { id: "t1", title: "Ship it", status: "doing" }],
  ["t0", { id: "t0", title: "No status yet" }],
]);
const taskById = (id: string): PlanStep | null => board.get(id) ?? null;

/** A roster row: working, counted zero, with the extras the test names. */
const sess = (name: string, extra: Record<string, unknown> = {}): RosterSession =>
  ({ name, state: "working", ...extra }) as RosterSession;

/** The roster's row names, top to bottom, from the aria-labels. */
const rowNames = (container: Element): string[] =>
  [...container.querySelectorAll("button[aria-label]")].map(
    (b) => (b.getAttribute("aria-label") ?? "").split(",")[0] ?? "",
  );

describe("onlineCount", () => {
  it("counts the sessions that are still in", () => {
    expect(onlineCount([sess("a"), sess("b", { state: "left" }), sess("c")])).toBe(2);
    expect(onlineCount([])).toBe(0);
  });
});

describe("Roster", () => {
  it("nests subagents under their parent in order, skipping the kids that left", () => {
    const { container } = render(
      <Roster
        sessions={[
          sess("alpha"),
          sess("alpha.one", { parent: "alpha" }),
          sess("alpha.three", { parent: "alpha", state: "left" }),
          sess("beta"),
          sess("gamma", { parent: "ghost" }),
        ]}
        taskById={taskById}
        now={NOW}
        onOpen={() => undefined}
      />,
    );
    expect(rowNames(container)).toEqual(["alpha", "alpha.one", "beta", "gamma"]);
    const nested = container.querySelector('ul[aria-label="Subagents of alpha"]');
    expect(nested?.querySelectorAll("button")).toHaveLength(1);
    expect(nested?.querySelector("button")?.getAttribute("aria-label")).toContain("alpha.one");
    expect(nested?.textContent).toContain("one");
    expect(nested?.textContent).not.toContain("alpha.three");
  });

  it("folds the sessions that left into one 'N left' row", () => {
    const { container } = render(
      <Roster
        sessions={[sess("alpha"), sess("old", { state: "left" }), sess("gone", { state: "left" })]}
        taskById={taskById}
        now={NOW}
        onOpen={() => undefined}
      />,
    );
    const summary = container.querySelector("details > summary");
    expect(summary?.textContent).toContain("2 left");
    expect(container.querySelector("details ul")?.querySelectorAll("button")).toHaveLength(2);
  });

  it("shows the empty roster before anyone joins, with the way in", () => {
    const { container, unmount } = render(
      <Roster
        sessions={[]}
        taskById={taskById}
        now={NOW}
        onOpen={() => undefined}
        connectHref="#/c/ch/settings"
      />,
    );
    expect(screen.getByText("Nobody has joined yet")).not.toBeNull();
    expect(screen.getByText("Connect a session to this channel in Settings.")).not.toBeNull();
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("#/c/ch/settings");
    expect(link?.textContent).toContain("Connect a session");
    unmount();
    const bare = render(<Roster sessions={[]} taskById={taskById} now={NOW} onOpen={() => undefined} />);
    expect(bare.container.querySelector("a")).toBeNull();
  });

  it("marks the orchestrator and the session that holds the turn", () => {
    const { container } = render(
      <Roster
        sessions={[sess("alpha", { holds_turn: true }), sess("beta")]}
        taskById={taskById}
        now={NOW}
        orchestrator="beta"
        onOpen={() => undefined}
      />,
    );
    const chip = screen.getByTitle("Orchestrator: plans and assigns the work");
    expect(chip.className).toBe("badge badge-ghost badge-sm c-lavender ink gap-1");
    expect(chip.textContent).toBe("orchestrator");
    expect(rowNames(container)).toEqual(["alpha", "beta"]);
    expect(screen.getByTitle("Holds the turn")).not.toBeNull();
    expect(container.querySelector("button[aria-label]")?.getAttribute("aria-label")).toBe(
      "alpha, Working, holds the turn",
    );
  });

  it("leaves no orchestrator chip without one", () => {
    render(
      <Roster
        sessions={[sess("alpha")]}
        taskById={taskById}
        now={NOW}
        orchestrator={null}
        onOpen={() => undefined}
      />,
    );
    expect(screen.queryByTitle("Orchestrator: plans and assigns the work")).toBeNull();
  });

  it("labels every row with its name, status, and marks", () => {
    const { unmount } = render(
      <Roster
        sessions={[sess("alpha", { step: "t1" }), sess("beta", { control: "pause" })]}
        taskById={taskById}
        now={NOW}
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "alpha, Working" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "beta, Paused" })).not.toBeNull();
    unmount();
    const again = render(
      <Roster
        sessions={[sess("left", { state: "left" })]}
        taskById={taskById}
        now={NOW}
        onOpen={() => undefined}
      />,
    );
    expect(again.container.querySelector("details button")?.getAttribute("aria-label")).toBe("left, Left");
  });

  it("shows what each session is doing: its step, its words, or its role", () => {
    const { container } = render(
      <Roster
        sessions={[
          sess("on-step", { step: "t1" }),
          sess("own-words", { task: "Writing docs" }),
          sess("joined", { task: "joined", role: "Reviewer" }),
          sess("role-only", { role: "Watcher" }),
          sess("nothing"),
          sess("off-board", { step: "tX", task: "Between steps" }),
          sess("fresh", { step: "t0" }),
        ]}
        taskById={taskById}
        now={NOW}
        onOpen={() => undefined}
      />,
    );
    const row = (name: string): HTMLElement | null =>
      [...container.querySelectorAll("button")].find((b) =>
        (b.getAttribute("aria-label") ?? "").startsWith(name),
      ) ?? null;
    expect(row("on-step")?.querySelector(".font-mono")?.textContent).toBe("t1");
    expect(row("on-step")?.textContent).toContain("Ship it");
    expect(row("fresh")?.querySelector(".font-mono")?.textContent).toBe("t0");
    expect(row("fresh")?.textContent).toContain("No status yet");
    expect(row("own-words")?.textContent).toContain("Writing docs");
    expect(row("joined")?.textContent).toContain("Reviewer");
    expect(row("joined")?.textContent).not.toContain("joined joined");
    expect(row("role-only")?.querySelector(".text-base-content\\/50")?.textContent).toBe("Watcher");
    expect(row("nothing")?.querySelector(".text-base-content\\/50")?.textContent).toBe("No task yet");
    expect(row("off-board")?.textContent).toContain("Between steps");
  });

  it("counts unread and open asks, and shows today's cost for top sessions", () => {
    const { container } = render(
      <Roster
        sessions={[sess("alpha", { unread: 2, open: 3 }), sess("alpha.one", { parent: "alpha", unread: 1 })]}
        taskById={taskById}
        now={NOW}
        costOf={(n) => (n === "alpha" ? 1.5 : undefined)}
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByTitle("2 events it has not read yet")).not.toBeNull();
    expect(screen.getByTitle("3 open questions for it")).not.toBeNull();
    expect(screen.getByTitle("1 events it has not read yet")).not.toBeNull();
    const chips = container.querySelectorAll('[title="Estimated cost today, from Radar"]');
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe("$1.50today");
  });

  it("shows nothing under the name when there is nothing to count", () => {
    render(<Roster sessions={[sess("alpha")]} taskById={taskById} now={NOW} onOpen={() => undefined} />);
    expect(screen.queryByTitle("Estimated cost today, from Radar")).toBeNull();
    expect(screen.getByRole("button", { name: "alpha, Working" }).innerHTML).not.toContain("mt-1.5");
  });

  it("takes the cost chip away when Radar is silent", () => {
    render(
      <Roster
        sessions={[sess("alpha", { unread: 1 })]}
        taskById={taskById}
        now={NOW}
        costOf={() => undefined}
        onOpen={() => undefined}
      />,
    );
    expect(screen.queryByTitle("Estimated cost today, from Radar")).toBeNull();
    expect(screen.getByTitle("1 events it has not read yet")).not.toBeNull();
  });

  it("opens a session on a click, on Enter and on Space", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <Roster sessions={[sess("alpha")]} taskById={taskById} now={NOW} onOpen={onOpen} />,
    );
    const row = screen.getByRole("button", { name: "alpha, Working" });
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith("alpha");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(row, { key: " " });
    expect(onOpen).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(row, { key: "a" });
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(container.querySelector("button")).not.toBeNull();
  });

  it("shows the turn banner only for a channel that starts with the turn", () => {
    const { container, unmount } = render(
      <Roster
        sessions={[sess("alpha")]}
        taskById={taskById}
        now={NOW}
        onOpen={() => undefined}
        turnHolder="beta"
      />,
    );
    expect(container.querySelector("p")?.textContent).toContain("beta holds the turn: only it acts.");
    expect(container.querySelector("p b")?.textContent).toBe("beta");
    unmount();
    render(
      <Roster
        sessions={[sess("alpha")]}
        taskById={taskById}
        now={NOW}
        onOpen={() => undefined}
        turnHolder={null}
      />,
    );
    expect(screen.getByText("Nobody holds the turn.")).not.toBeNull();
    unmount();
    const bare = render(
      <Roster sessions={[sess("alpha")]} taskById={taskById} now={NOW} onOpen={() => undefined} />,
    );
    expect(bare.container.querySelector("p")).toBeNull();
  });

  it("highlights the session whose drawer is open", () => {
    const { container } = render(
      <Roster
        sessions={[sess("alpha"), sess("beta")]}
        taskById={taskById}
        now={NOW}
        onOpen={() => undefined}
        activeName="beta"
      />,
    );
    const rows = [...container.querySelectorAll("button")];
    expect(rows.find((b) => (b.getAttribute("aria-label") ?? "").startsWith("alpha"))?.className).not.toMatch(
      /bg-primary\/10$/,
    );
    expect(rows.find((b) => (b.getAttribute("aria-label") ?? "").startsWith("beta"))?.className).toMatch(
      /bg-primary\/10$/,
    );
  });

  it("gives subagent rows the small avatar, the short name and the small pill", () => {
    const { container } = render(
      <Roster
        sessions={[sess("alpha"), sess("alpha.one", { parent: "alpha" })]}
        taskById={taskById}
        now={NOW}
        onOpen={() => undefined}
      />,
    );
    const nested = container.querySelector('ul[aria-label="Subagents of alpha"]');
    const kid = nested?.querySelector("button");
    expect(kid?.className).toContain("gap-2.5");
    expect(kid?.querySelector(".avatar > span")?.className).toContain("w-6");
    expect(kid?.querySelector(".badge")?.className).toContain("badge-sm");
    expect(kid?.querySelector("b")?.textContent).toBe("one");
    const top = container.querySelector("ul:not([aria-label]) > li > button");
    expect(top?.className).toContain("px-3 py-2.5");
    expect(top?.querySelector(".badge")?.className).not.toContain("badge-sm");
  });
});
