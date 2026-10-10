// theme.test.ts — the palette choice: what is kept, how it resolves, what lands on <html>, and
// the migration of a choice kept under the old "dark"/"light" names.
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
  it("offers System, Mocha and Latte, in menu order, with their icons", () => {
    expect(THEMES.map(([k, l, i]) => [k, l, i])).toEqual([
      ["system", "System", "monitor"],
      ["mocha", "Mocha", "moon"],
      ["latte", "Latte", "sun"],
    ]);
  });
});

describe("resolvedTheme", () => {
  it("keeps an explicit palette and follows the system otherwise", () => {
    expect(resolvedTheme("latte", true)).toBe("latte");
    expect(resolvedTheme("mocha", false)).toBe("mocha");
    expect(resolvedTheme("system", true)).toBe("mocha");
    expect(resolvedTheme("system", false)).toBe("latte");
  });
});

describe("currentTheme", () => {
  it("reads the kept choice, falling back to System", () => {
    expect(currentTheme(store())).toBe("system");
    expect(currentTheme(store({ "huddle:theme": '"mocha"' }))).toBe("mocha");
    expect(currentTheme(store({ "huddle:theme": '"latte"' }))).toBe("latte");
    expect(currentTheme(store({ "huddle:theme": '"system"' }))).toBe("system");
    expect(currentTheme(store({ "huddle:theme": "nonsense" }))).toBe("system");
  });

  it("migrates a legacy dark/light choice to mocha/latte in the same read", () => {
    const dark = store({ "huddle:theme": '"dark"' });
    expect(currentTheme(dark)).toBe("mocha");
    expect(dark.getItem("huddle:theme")).toBe('"mocha"');
    const light = store({ "huddle:theme": '"light"' });
    expect(currentTheme(light)).toBe("latte");
    expect(light.getItem("huddle:theme")).toBe('"latte"');
  });
});

describe("applyTheme / setTheme", () => {
  it("puts the shared theme's name on <html>", () => {
    applyTheme("latte", true);
    expect(document.documentElement.dataset.theme).toBe("latte");
    applyTheme("mocha", false);
    expect(document.documentElement.dataset.theme).toBe("mocha");
    applyTheme("system", true);
    expect(document.documentElement.dataset.theme).toBe("mocha");
    applyTheme("system", false);
    expect(document.documentElement.dataset.theme).toBe("latte");
  });

  it("keeps the choice and applies it in one step", () => {
    const s = store();
    setTheme(s, "mocha", false);
    expect(s.getItem("huddle:theme")).toBe('"mocha"');
    expect(document.documentElement.dataset.theme).toBe("mocha");
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
