// theme.ts — System · Mocha · Latte, kept per browser under "huddle:theme" and applied to
// <html data-theme> before anything paints (index.html's inline script does it too; this is the
// running half). Mocha is the dark Catppuccin, latte the light one — the shared theme.css names.
// A choice kept under the old names ("dark", "light") reads as its new one and is written back
// migrated.

import type { IconName } from "../icons.tsx";
import { readPref, type Storage, writePref } from "../storage.ts";

/** The choices, in menu order: the key, its label and its icon. */
export const THEMES: readonly (readonly [key: ThemePref, label: string, icon: IconName])[] = [
  ["system", "System", "monitor"],
  ["mocha", "Mocha", "moon"],
  ["latte", "Latte", "sun"],
];

/** What can be kept: "system" follows prefers-color-scheme. */
export type ThemePref = "system" | "mocha" | "latte";

/** The palette that lands on <html>: one of the shared theme.css names. */
export type Palette = Exclude<ThemePref, "system">;

/** Does this browser prefer the dark palette right now? */
export const prefersDark = (mq: { matches: boolean }): boolean => mq.matches;

/** The palette <html> should carry: the choice itself, or the system's when it follows that. */
export function resolvedTheme(pref: ThemePref, systemDark: boolean): Palette {
  if (pref === "system") return systemDark ? "mocha" : "latte";
  return pref;
}

/** The saved choice, "system" when none was kept yet. A legacy "dark"/"light" moves to
 *  "mocha"/"latte" in the same read. */
export function currentTheme(storage: Storage): ThemePref {
  const raw = readPref<string>(storage, "theme", "system");
  if (raw === "mocha" || raw === "latte") return raw;
  if (raw === "dark" || raw === "light") {
    const moved: Palette = raw === "dark" ? "mocha" : "latte";
    writePref(storage, "theme", moved);
    return moved;
  }
  return "system";
}

/** Puts the palette on <html>. */
export function applyTheme(pref: ThemePref, systemDark: boolean): void {
  document.documentElement.dataset.theme = resolvedTheme(pref, systemDark);
}

/** Keeps the choice and puts it on <html>; the menus re-render from the storage themselves. */
export function setTheme(storage: Storage, pref: ThemePref, systemDark: boolean): void {
  writePref(storage, "theme", pref);
  applyTheme(pref, systemDark);
}
