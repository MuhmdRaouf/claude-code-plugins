// theme.test.ts — the palette choice: what is kept, how it resolves, and what lands on <html>.
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, currentTheme, resolvedTheme, setTheme, THEMES } from "../../src/app/theme.ts";

/** A storage over a map, like the browser's but per test; only what readPref/writePref call. */
function store(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => {
      m.set(k, v);
    },
  } as Storage;
}

afterEach(() => {
  document.documentElement.dataset.theme = "";
});

describe("THEMES", () => {
  it("offers System, Light and Dark, in menu order, with their icons", () => {
    expect(THEMES.map(([k, l, i]) => [k, l, i])).toEqual([
      ["system", "System", "monitor"],
      ["light", "Light", "sun"],
      ["dark", "Dark", "moon"],
    ]);
  });
});

describe("resolvedTheme", () => {
  it("keeps an explicit choice and follows the system otherwise", () => {
    expect(resolvedTheme("light", true)).toBe("light");
    expect(resolvedTheme("dark", false)).toBe("dark");
    expect(resolvedTheme("system", true)).toBe("dark");
    expect(resolvedTheme("system", false)).toBe("light");
  });
});

describe("currentTheme", () => {
  it("reads the kept choice, falling back to System", () => {
    expect(currentTheme(store())).toBe("system");
    expect(currentTheme(store({ "huddle:theme": '"dark"' }))).toBe("dark");
    expect(currentTheme(store({ "huddle:theme": '"light"' }))).toBe("light");
    expect(currentTheme(store({ "huddle:theme": "nonsense" }))).toBe("system");
  });
});

describe("applyTheme / setTheme", () => {
  it("puts the resolved palette on <html>", () => {
    applyTheme("light", true);
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("dark", false);
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyTheme("system", true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyTheme("system", false);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("keeps the choice and applies it in one step", () => {
    const s = store();
    setTheme(s, "dark", false);
    expect(s.getItem("huddle:theme")).toBe('"dark"');
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("prefersDark", () => {
  it("reads the media query's answer", async () => {
    const { prefersDark } = await import("../../src/app/theme.ts");
    expect(prefersDark({ matches: true })).toBe(true);
    expect(prefersDark({ matches: false })).toBe(false);
    vi.restoreAllMocks();
  });
});
