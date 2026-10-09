import { render } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Icon, type IconName, Logo, P } from "../src/icons.tsx";

describe("Icon", () => {
  it("renders every icon of the table as a stroked svg with shapes inside", () => {
    const names = Object.keys(P) as IconName[];
    expect(names.length).toBeGreaterThan(50);
    for (const name of names) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg?.getAttribute("fill")).toBe("none");
      expect(svg?.getAttribute("stroke")).toBe("currentColor");
      expect(svg?.getAttribute("stroke-width")).toBe("2");
      expect(svg?.getAttribute("stroke-linecap")).toBe("round");
      expect(svg?.getAttribute("stroke-linejoin")).toBe("round");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.innerHTML ?? "").toMatch(/<(path|rect|circle)[ />]/);
      unmount();
    }
  });

  it("sizes size-4 by default and takes the class given, always shrink-0", () => {
    const plain = render(<Icon name="inbox" />);
    expect(plain.container.querySelector("svg")?.getAttribute("class")).toBe("size-4 shrink-0");
    plain.unmount();
    const small = render(<Icon name="inbox" class="size-3.5" />);
    expect(small.container.querySelector("svg")?.getAttribute("class")).toBe("size-3.5 shrink-0");
  });

  it("renders an unknown name as an empty svg", () => {
    const { container } = render(<Icon name={"nope" as IconName} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.innerHTML).toBe("");
  });

  it("keeps every shape attribute, fill=currentColor on the half icon included", () => {
    const { container } = render(<Icon name="half" />);
    expect(container.innerHTML).toContain('fill="currentColor"');
    const pause = render(<Icon name="pause" />);
    expect(pause.container.querySelectorAll("rect").length).toBe(2);
    expect(pause.container.innerHTML).toContain('rx="1"');
  });
});

describe("Logo", () => {
  it("renders the mark with its gradients, size-16 by default", () => {
    const { container } = render(<Logo />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toBe("size-16");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 128 128");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll("linearGradient").length).toBe(2);
    expect(container.querySelectorAll("stop").length).toBe(4);
    expect(container.querySelector('stop[stop-color="#cba6f7"]')).not.toBeNull();
    expect(container.querySelectorAll("circle").length).toBe(6);
  });

  it("takes a class", () => {
    const { container } = render(<Logo class="size-8" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toBe("size-8");
  });
});
