import { screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Alert } from "../../src/alerts/engine.ts";
import { AlertStrip, alertClasses } from "../../src/ui/app/AlertStrip.tsx";
import { AlertsView } from "../../src/ui/app/views/Alerts.tsx";
import { alertLabel } from "../../src/ui/palette.ts";
import { renderApp } from "./render.tsx";

const NOW = 1_800_000_000_000;

const DETAIL = "Bash called 5 times in a row with the same input";

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "a0",
    kind: "loop",
    sessionId: "s1",
    agentId: "w1-long-agent-id",
    project: "app",
    since: NOW - 120_000,
    detail: DETAIL,
    costUsd: 0.5,
    severity: "warn",
    ...overrides,
  };
}

/** The text of an alert's daisyUI row: the kind badge, the detail and the where/since/cost facts. */
const rowTextOf = (container: Element): string =>
  container.querySelector("[role='alert']")?.textContent ?? "";

/** The panel head's muted count beside the title (the shared Panel's meta slot). */
const panelMeta = (container: Element): string =>
  container.querySelector("section h2")?.nextElementSibling?.textContent ?? "";

describe("AlertStrip", () => {
  it("renders nothing while there are no alerts", () => {
    const { container } = renderApp(<AlertStrip />, {}, NOW);
    expect(container.textContent).toBe("");
    expect(container.querySelector("section")).toBeNull();
  });

  it("shows the three loudest alerts with dismiss buttons and a count", () => {
    const alerts = Array.from({ length: 4 }, (_, i) => makeAlert({ id: `a${i}` }));
    const { container } = renderApp(<AlertStrip />, { alerts }, NOW);
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(3);
    const dismisses = [...container.querySelectorAll("[data-action='dismiss-alert']")];
    expect(dismisses.map((b) => b.getAttribute("data-value"))).toEqual(["a0", "a1", "a2"]);
    expect(screen.getByText("4 active alerts")).toBeTruthy();
    const row = rowTextOf(container);
    expect(row).toContain("app, w1-long-agen");
    expect(row).toContain("since 2m ago");
    expect(row).toContain("est. $0.50");
  });

  it("reads the rows as daisyUI alerts, warning by default and error by severity", () => {
    expect(alertClasses("warn")).toBe("alert alert-soft alert-warning");
    expect(alertClasses("err")).toBe("alert alert-soft alert-error");
    const { container } = renderApp(<AlertStrip />, { alerts: [makeAlert()] }, NOW);
    const row = container.querySelector("[role='alert']");
    expect(row?.className).toContain("alert");
    expect(row?.className).toContain("alert-warning");
    expect(row?.className).not.toContain("alert-error");
  });

  it("runs the dismiss action with the alert's id on click", async () => {
    const { act } = renderApp(<AlertStrip />, { alerts: [makeAlert({ id: "a7" })] }, NOW);
    await userEvent.click(screen.getByRole("button", { name: `Dismiss: ${DETAIL}` }));
    expect(act).toHaveBeenCalledWith("dismiss-alert", "a7");
  });

  it("links to the alerts tab, naming the whole list when alerts were cut off", async () => {
    const alerts = Array.from({ length: 4 }, (_, i) => makeAlert({ id: `a${i}` }));
    const cut = renderApp(<AlertStrip />, { alerts }, NOW);
    await userEvent.click(screen.getByRole("button", { name: "All 4 alerts" }));
    expect(cut.act).toHaveBeenCalledWith("tab", "alerts");
    cut.unmount();
    const short = renderApp(<AlertStrip />, { alerts: [makeAlert({ agentId: null, costUsd: null })] }, NOW);
    expect(screen.getByRole("button", { name: "Alerts" })).toBeTruthy();
    expect(short.act).not.toHaveBeenCalled();
  });

  it("counts one alert in the singular", () => {
    const { container } = renderApp(<AlertStrip />, { alerts: [makeAlert()] }, NOW);
    expect(panelMeta(container)).toBe("1 active alert");
  });

  it("names where an alert happened", () => {
    const { container: allSessions } = renderApp(
      <AlertStrip />,
      { alerts: [makeAlert({ kind: "budget", sessionId: "", project: "" })] },
      NOW,
    );
    expect(rowTextOf(allSessions)).toContain("All sessions");
    const { container: router } = renderApp(
      <AlertStrip />,
      { alerts: [makeAlert({ kind: "retry_storm", sessionId: "", project: "" })] },
      NOW,
    );
    expect(rowTextOf(router)).toContain("Router");
    const { container: idOnly } = renderApp(
      <AlertStrip />,
      { alerts: [makeAlert({ project: "", agentId: null })] },
      NOW,
    );
    expect(rowTextOf(idOnly)).toContain("s1");
    expect(alertLabel("context")).toBe("Context nearly full");
  });

  it("paints an error-severity alert with the error tone", () => {
    const { container } = renderApp(<AlertStrip />, { alerts: [makeAlert({ severity: "err" })] }, NOW);
    const row = container.querySelector("[role='alert']");
    expect(row?.className).toContain("alert-error");
    expect(row?.className).not.toContain("alert-warning");
  });
});

describe("AlertsView", () => {
  it("says all clear and explains the kinds when nothing is active", () => {
    const { container } = renderApp(<AlertsView />, {}, NOW);
    expect(screen.getByText("All clear")).toBeTruthy();
    expect(screen.getByText("How alerts work")).toBeTruthy();
    expect(container.querySelector("ul")).toBeNull();
    expect(panelMeta(container)).toBe("0 active alerts");
  });

  it("lists every alert with its tone, and each kind in detection order", () => {
    const { container } = renderApp(
      <AlertsView />,
      { alerts: [makeAlert(), makeAlert({ id: "b", severity: "err" })] },
      NOW,
    );
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(2);
    expect(container.querySelectorAll(".alert-error")).toHaveLength(1);
    const terms = [...container.querySelectorAll("dt")].map((t) => t.textContent);
    expect(terms).toEqual(["Stuck", "Loop", "Retry storm", "Context nearly full", "Budget"]);
    expect(container.querySelectorAll("dd")).toHaveLength(5);
  });

  it("dismisses from the full list too", async () => {
    const { act } = renderApp(<AlertsView />, { alerts: [makeAlert({ id: "z9" })] }, NOW);
    await userEvent.click(screen.getByRole("button", { name: `Dismiss: ${DETAIL}` }));
    expect(act).toHaveBeenCalledWith("dismiss-alert", "z9");
  });
});
