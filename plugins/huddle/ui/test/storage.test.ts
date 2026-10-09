import { fuzzy } from "@muhmdraouf/ui/fuzzy.ts";
import { describe, expect, it } from "vitest";
import { readPref, type Storage, writePref } from "../src/storage.ts";

const memory = (): Storage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const broken: Storage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("preferences", () => {
  it("round-trips JSON under the huddle: prefix", () => {
    const store = memory();
    writePref(store, "theme", "dark");
    expect(store.data.get("huddle:theme")).toBe('"dark"');
    expect(readPref(store, "theme", "system")).toBe("dark");
  });

  it("falls back when the key is missing, the value is not JSON, or storage throws", () => {
    const store = memory();
    expect(readPref(store, "x", 3)).toBe(3);
    store.data.set("huddle:x", "{nope");
    expect(readPref(store, "x", 3)).toBe(3);
    expect(readPref(broken, "x", 3)).toBe(3);
    expect(() => writePref(broken, "x", 1)).not.toThrow();
  });

  it("reaches the shared library through the alias", () => {
    expect(fuzzy("work", "work board")).toBeGreaterThan(0);
  });
});
