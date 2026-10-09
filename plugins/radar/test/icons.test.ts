import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ICONS } from "../src/ui/icons.ts";
import { FAVICON_SVG, LOGO_SVG, svgDataUri } from "../src/ui/logo.ts";

describe("the icons", () => {
  it("define at least one shape per name, on Lucide's 24-unit grid", () => {
    const names = Object.keys(ICONS);
    expect(names.length).toBeGreaterThan(20);
    for (const shapes of Object.values(ICONS)) expect(shapes.length).toBeGreaterThan(0);
  });

  it("draw the logo as shape data, shown in colour from logo.ts", () => {
    expect(ICONS.logo).toEqual([{ circle: [12, 12, 8] }, { d: "M6 12h3l1.5-3 2 6 1.5-4 1 1h3" }]);
  });
});

describe("the logo", () => {
  it("carries gradient ids of its own, all prefixed obs-", () => {
    for (const svg of [LOGO_SVG, FAVICON_SVG]) {
      const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id) => id?.startsWith("obs-"))).toBe(true);
    }
  });

  it("is the page's favicon, inline, in its small drawing", () => {
    const html = readFileSync(new URL("../plugin/public/index.html", import.meta.url), "utf8");
    expect(html).toContain(`<link rel="icon" type="image/svg+xml" href='${svgDataUri(FAVICON_SVG)}' />`);
    // the same drawing, less the pulse's soft glow, which blurs at 16 px
    expect(LOGO_SVG).toContain('filter="url(#obs-blur)"');
    expect(FAVICON_SVG).not.toContain("filter");
    expect(svgDataUri('<svg a="#1">%</svg>')).toBe("data:image/svg+xml,%3Csvg a=%22%231%22%3E%25%3C/svg%3E");
  });
});
