import { screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Banner } from "../../src/ui/app/Banner.tsx";
import { renderApp } from "./render.tsx";

describe("Banner", () => {
  it("is a daisyUI error alert that says what happened and what to do", () => {
    const { container } = renderApp(<Banner message="stream lost" />);
    const banner = screen.getByRole("alert");
    expect(banner.className).toContain("alert");
    expect(banner.className).toContain("alert-error");
    expect(container.querySelector('svg[data-icon="alert"]')).toBeTruthy();
    expect(screen.getByText("Lost contact with the radar server")).toBeTruthy();
    expect(banner.textContent).toContain("stream lost. It reconnects on its own; press R to retry now.");
  });
});
