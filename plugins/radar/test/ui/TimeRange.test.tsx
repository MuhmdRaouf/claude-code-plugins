import { fireEvent, screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TimeRange } from "../../src/ui/app/TimeRange.tsx";
import { renderApp } from "./render.tsx";

const NOW = new Date(2026, 9, 6, 18, 30).getTime();

/** Type into a datetime-local input by setting its value directly (happy-dom has no picker UI). */
function setInput(box: Element, value: string): void {
  fireEvent.input(box, { target: { value } });
}

describe("TimeRange", () => {
  it("names the range in words on a full-size trigger, then lists presets", async () => {
    const { act } = renderApp(<TimeRange />, { range: { preset: "1h", from: 0, to: null } }, NOW);
    const trigger = screen.getByRole("button", { name: /Last 1 hour/ });
    expect(trigger.className).toContain("btn");
    expect(trigger.className).not.toContain("btn-sm");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    for (const label of ["Last 5 minutes", "Last 15 minutes", "Last 6 hours", "All time"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    await userEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(act).toHaveBeenCalledWith("range", "7d");
    // preset click closes the panel
    expect(screen.queryByRole("button", { name: "Last 5 minutes" })).toBeNull();
  });

  it("marks the active preset, and none while the range is custom", async () => {
    const from = new Date(2026, 9, 6, 14, 0).getTime();
    const to = new Date(2026, 9, 6, 18, 0).getTime();
    renderApp(<TimeRange />, { range: { preset: null, from, to } }, NOW);
    // a custom span is announced by both ends on the trigger
    const trigger = screen.getByRole("button", { name: /6 Oct 14:00 – 6 Oct 18:00/ });
    await userEvent.click(trigger);
    expect(document.querySelectorAll(".menu .menu-active")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(false);
  });

  it("applies a custom range as absolute ms and disables Apply when From >= To", async () => {
    const { act } = renderApp(<TimeRange />, { range: { preset: "1h", from: 0, to: null } }, NOW);
    await userEvent.click(screen.getByRole("button", { name: /Last 1 hour/ }));
    const fromBox = screen.getByLabelText("Custom range from") as HTMLInputElement;
    const toBox = screen.getByLabelText("Custom range to") as HTMLInputElement;
    // opening seeds the fieldset with the window on screen (last hour, To empty = now)
    expect(fromBox.value).toBe("2026-10-06T17:30");
    expect(toBox.value).toBe("");
    setInput(fromBox, "2026-10-06T14:00");
    setInput(toBox, "2026-10-06T14:00");
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("From must be before To.")).toBeTruthy();
    setInput(toBox, "2026-10-06T16:00");
    expect(screen.queryByText("From must be before To.")).toBeNull();
    await userEvent.click(apply);
    const from = new Date(2026, 9, 6, 14, 0).getTime();
    const to = new Date(2026, 9, 6, 16, 0).getTime();
    expect(act).toHaveBeenCalledWith("range-custom", `from=${from}&to=${to}`);
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("disables the auto-refresh select with a reason when the range has a fixed end", async () => {
    const from = new Date(2026, 9, 6, 14, 0).getTime();
    const to = new Date(2026, 9, 6, 18, 0).getTime();
    renderApp(<TimeRange />, { range: { preset: null, from, to }, refresh: 15000 }, NOW);
    await userEvent.click(screen.getByRole("button", { name: /6 Oct 14:00/ }));
    const select = screen.getByLabelText("Auto refresh") as HTMLSelectElement;
    expect(select.hasAttribute("disabled")).toBe(true);
    expect(select.value).toBe("15000");
    const tip = select.closest(".tooltip");
    expect(tip?.getAttribute("data-tip")).toMatch(/ends at now/);
  });

  it("offers auto-refresh choices and dispatches the change while the range is open-ended", async () => {
    const { act } = renderApp(<TimeRange />, { range: { preset: "1h", from: 0, to: null } }, NOW);
    await userEvent.click(screen.getByRole("button", { name: /Last 1 hour/ }));
    const select = screen.getByLabelText("Auto refresh") as HTMLSelectElement;
    expect(select.hasAttribute("disabled")).toBe(false);
    expect((select.closest(".tooltip") as HTMLElement).getAttribute("data-tip")).toBeNull();
    await userEvent.selectOptions(select, "60000");
    expect(act).toHaveBeenCalledWith("auto-refresh", "60000");
  });

  it("copies a link that freezes the relative range", async () => {
    const { act } = renderApp(<TimeRange />, { range: { preset: "1h", from: 0, to: null } }, NOW);
    await userEvent.click(screen.getByRole("button", { name: /Last 1 hour/ }));
    await userEvent.click(screen.getByRole("button", { name: /Copy link/ }));
    expect(act).toHaveBeenCalledWith("range-copy");
  });

  it("closes the panel on Escape", async () => {
    renderApp(<TimeRange />, { range: { preset: "1h", from: 0, to: null } }, NOW);
    await userEvent.click(screen.getByRole("button", { name: /Last 1 hour/ }));
    expect(screen.getByRole("button", { name: "All time" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "All time" })).toBeNull();
  });
});
