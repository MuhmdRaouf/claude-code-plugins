/**
 * Per-viewer conveniences only (theme, filters, last view, drafts), under the "huddle:" prefix. Every access may
 * throw (a private window, blocked site data), so a failed read gives the default and a failed write is dropped.
 */
export type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function readPref<T>(store: Storage, key: string, fallback: T): T {
  try {
    const raw = store.getItem(`huddle:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref(store: Storage, key: string, value: unknown): void {
  try {
    store.setItem(`huddle:${key}`, JSON.stringify(value));
  } catch {
    // site data is blocked: the preference lasts until the page reloads
  }
}
