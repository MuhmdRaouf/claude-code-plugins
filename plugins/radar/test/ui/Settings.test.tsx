import { screen, within } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Budget, BudgetSpend } from "../../src/budget/budgets.ts";
import { SettingsView } from "../../src/ui/app/views/Settings.tsx";
import { draftOf, newDraft } from "../../src/ui/state.ts";
import { renderApp } from "./render.tsx";

const NOW = 1_790_000_000_000;

const BUDGET: Budget = { id: "b1", scope: "provider:zai", period: "day", limitUsd: 5, action: "stop" };

const SPEND = (pct: number): BudgetSpend => ({
  id: "b1",
  spentUsd: pct / 10,
  limitUsd: 10,
  pct,
  scope: "provider:zai",
  period: "day",
  action: "stop",
  periodStart: 0,
});

const buttonsWithAction = (action: string): HTMLElement[] =>
  screen.queryAllByRole("button").filter((b) => b.dataset.action === action);

describe("SettingsView budgets", () => {
  it("invites a first budget when none is saved", () => {
    const { container } = renderApp(<SettingsView />, { budgets: [] }, NOW);
    expect(container.textContent).toContain("No budgets");
    expect(buttonsWithAction("new-budget")).toHaveLength(1);
  });

  it("says it is still loading before the saved budgets arrive", () => {
    renderApp(<SettingsView />, {}, NOW);
    expect(screen.getByText("Loading budgets…")).toBeTruthy();
  });

  it("lists saved budgets with spend, badges and edit/remove buttons", () => {
    renderApp(
      <SettingsView />,
      {
        budgets: [BUDGET, { ...BUDGET, id: "b2", scope: "total", action: "warn" }],
        budgetStatus: { version: 1, updatedAt: NOW, stopped: [], spend: [SPEND(50)] },
      },
      NOW,
    );
    expect(screen.getByText("Z.ai, $5.00 per day")).toBeTruthy();
    expect(screen.getByText("$5.00 so far (50%)")).toBeTruthy();
    expect(screen.getByText("Total, $5.00 per day")).toBeTruthy();
    expect(screen.getByText("Stops at 100%")).toBeTruthy();
    expect(screen.getByText("Warns")).toBeTruthy();
    expect(screen.getByText("–")).toBeTruthy();
    expect(screen.getByText("Stops at 100%").closest(".badge")?.className).toBe("badge badge-err");
    expect(screen.getByText("Warns").closest(".badge")?.className).toBe("badge badge-info");
    expect(buttonsWithAction("edit-budget")).toHaveLength(2);
    expect(buttonsWithAction("remove-budget")).toHaveLength(2);
  });

  it("runs new-budget, edit-budget and remove-budget with the budget's id", async () => {
    const { act } = renderApp(
      <SettingsView />,
      {
        budgets: [BUDGET],
        budgetStatus: { version: 1, updatedAt: NOW, stopped: [], spend: [SPEND(100)] },
      },
      NOW,
    );
    await userEvent.click(buttonsWithAction("new-budget")[0] as HTMLElement);
    expect(act).toHaveBeenCalledWith("new-budget");
    await userEvent.click(screen.getByRole("button", { name: "Edit the Z.ai budget" }));
    expect(act).toHaveBeenCalledWith("edit-budget", "b1");
    await userEvent.click(screen.getByRole("button", { name: "Remove the Z.ai budget" }));
    expect(act).toHaveBeenCalledWith("remove-budget", "b1");
  });

  it("renders the new-budget form with the draft's choices and an error message", () => {
    renderApp(
      <SettingsView />,
      {
        budgets: [],
        providers: ["zai"],
        draft: { ...newDraft(["zai"]), scope: "provider:acme" },
        formMessage: { tone: "err", text: "Enter a limit" },
      },
      NOW,
    );
    const scope = screen.getByRole("combobox", { name: "Scope" });
    expect(
      within(scope)
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(["total", "provider:zai", "provider:acme"]);
    expect((scope as HTMLSelectElement).value).toBe("provider:acme");
    expect((screen.getByRole("combobox", { name: "Period" }) as HTMLSelectElement).value).toBe("month");
    expect((screen.getByRole("combobox", { name: "At 100%" }) as HTMLSelectElement).value).toBe("warn");
    expect((screen.getByRole("textbox", { name: "Limit in US dollars" }) as HTMLInputElement).value).toBe(
      "10",
    );
    expect(screen.getByRole("alert").textContent).toContain("Enter a limit");
    expect(screen.getAllByRole("button", { name: "Add budget" })).toHaveLength(1);
    expect(buttonsWithAction("new-budget")).toHaveLength(0);
  });

  it("renders the edit form with a confirmation and no add button", () => {
    renderApp(
      <SettingsView />,
      {
        budgets: [BUDGET],
        draft: draftOf(BUDGET),
        formMessage: { tone: "ok", text: "Saved" },
      },
      NOW,
    );
    expect((screen.getByRole("textbox", { name: "Limit in US dollars" }) as HTMLInputElement).value).toBe(
      "5",
    );
    expect((screen.getByRole("combobox", { name: "Scope" }) as HTMLSelectElement).value).toBe("provider:zai");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Saved");
    expect(buttonsWithAction("new-budget")).toHaveLength(0);
  });

  it("keeps the list area present, not the empty state, while the form is open with no budgets", () => {
    const { container } = renderApp(
      <SettingsView />,
      { budgets: [], providers: ["zai"], draft: newDraft(["zai"]) },
      NOW,
    );
    expect(container.querySelector(".divide-y")).toBeTruthy();
    expect(container.textContent).not.toContain("No budgets");
  });

  it("reports draft-field as field=value for every control, and saves on Enter", async () => {
    const { act } = renderApp(
      <SettingsView />,
      { budgets: [], providers: ["zai"], draft: { ...newDraft(["zai"]), scope: "provider:acme" } },
      NOW,
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Scope" }), "provider:zai");
    expect(act).toHaveBeenCalledWith("draft-field", "scope=provider:zai");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Period" }), "week");
    expect(act).toHaveBeenCalledWith("draft-field", "period=week");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "At 100%" }), "stop");
    expect(act).toHaveBeenCalledWith("draft-field", "action=stop");
    const limit = screen.getByRole("textbox", { name: "Limit in US dollars" }) as HTMLInputElement;
    await userEvent.clear(limit);
    await userEvent.type(limit, "7.5");
    expect(act).toHaveBeenLastCalledWith("draft-field", "limit=7.5");
    await userEvent.type(limit, "{Enter}");
    expect(act).toHaveBeenCalledWith("save-budget");
  });

  it("saves and cancels from the form's buttons", async () => {
    const { act } = renderApp(
      <SettingsView />,
      { budgets: [], providers: ["zai"], draft: newDraft(["zai"]) },
      NOW,
    );
    await userEvent.click(buttonsWithAction("save-budget")[0] as HTMLElement);
    expect(act).toHaveBeenCalledWith("save-budget");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(act).toHaveBeenCalledWith("cancel-budget");
  });

  it("notes where the estimates come from", () => {
    const { container } = renderApp(<SettingsView />, { budgets: [] }, NOW);
    expect(container.textContent).toContain("Estimates at API list price");
    expect(container.textContent).toContain("A Claude subscription may cover Claude usage");
  });
});

describe("SettingsView notifications", () => {
  it("starts on and runs the toggle action when clicked", async () => {
    const { act } = renderApp(<SettingsView />, { budgets: [] }, NOW);
    const switchEl = screen.getByRole("checkbox", { name: "Desktop notifications" });
    expect(switchEl.getAttribute("aria-checked")).toBe("true");
    expect(switchEl.className).toBe("toggle toggle-primary");
    expect(screen.getByText("On")).toBeTruthy();
    await userEvent.click(switchEl);
    expect(act).toHaveBeenCalledWith("toggle-notifications");
  });

  it("shows Off when notifications are disabled", () => {
    renderApp(
      <SettingsView />,
      { budgets: [], settings: { notifications: false, historyRetentionDays: 30 } },
      NOW,
    );
    const switchEl = screen.getByRole("checkbox", { name: "Desktop notifications" });
    expect(switchEl.getAttribute("aria-checked")).toBe("false");
    expect((switchEl as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("Off")).toBeTruthy();
  });
});

describe("SettingsView history", () => {
  const STATS = { bytes: 49_152, nodes: 3, requests: 421, roots: 2, retentionDays: 30 };

  it("says it is still reading before the stats arrive, and that history is off when it is", () => {
    const loading = renderApp(<SettingsView />, { budgets: [] }, NOW);
    expect(loading.container.textContent).toContain("Reading the history store");
    loading.unmount();
    const off = renderApp(<SettingsView />, { budgets: [], historyOff: true }, NOW);
    expect(off.container.textContent).toContain("History is off");
  });

  it("shows the store's size, its sessions and requests, and the retention in force", () => {
    const { container } = renderApp(<SettingsView />, { budgets: [], historyStats: STATS }, NOW);
    expect(container.textContent).toContain("49.2 kB");
    expect(container.textContent).toContain("3 sessions");
    expect(container.textContent).toContain("421 requests");
    const on = buttonsWithAction("retention").find((b) => b.className.includes("segment-on"));
    expect(on?.textContent).toBe("30d");
  });

  it("offers 7, 30, 90 days and forever, and runs the retention action with the wire value", async () => {
    const { act } = renderApp(<SettingsView />, { budgets: [], historyStats: STATS }, NOW);
    const values = buttonsWithAction("retention").map((b) => b.dataset.value);
    expect(values).toEqual(["7", "30", "90", "0"]);
    await userEvent.click(buttonsWithAction("retention")[0] as HTMLElement);
    expect(act).toHaveBeenCalledWith("retention", "7");
    await userEvent.click(buttonsWithAction("retention")[3] as HTMLElement);
    expect(act).toHaveBeenCalledWith("retention", "0");
  });

  it("arms clear history before wiping, and both steps run through the one action", async () => {
    const { act, container } = renderApp(<SettingsView />, { budgets: [], historyStats: STATS }, NOW);
    expect(container.textContent).toContain("Clear history");
    expect(container.textContent).not.toContain("Delete every stored session");
    await userEvent.click(buttonsWithAction("clear-history")[0] as HTMLElement);
    expect(act).toHaveBeenCalledWith("clear-history");
  });
});

describe("SettingsView about", () => {
  it("reads the server's own uptime from health, never the summary's oldest session", () => {
    const about = renderApp(
      <SettingsView />,
      // a summary startedAt far older than the process, as an ingested week-old session produces
      { health: { startedAt: NOW - 125_000, uptimeMs: 125_000 } },
      NOW,
    );
    expect(about.container.querySelector("dd.num")?.textContent).toBe("2m05s");
    about.unmount();
    const unknown = renderApp(<SettingsView />, {}, NOW);
    expect(unknown.container.querySelector("dd.num")?.textContent).toBe("Not known yet");
  });
});
