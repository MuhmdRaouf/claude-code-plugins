// theme.ts — System · Light · Dark, kept per browser under "huddle:theme" and applied to
// <html data-theme> before anything paints (index.html's inline script does it too; this is the
// running half). Port of app.js's applyTheme/setTheme.

import type { IconName } from "../icons.tsx";
import { readPref, type Storage, writePref } from "../storage.ts";

/** The choices, in menu order: the key, its label and its icon. */
export const THEMES: readonly (readonly [key: ThemePref, label: string, icon: IconName])[] = [
  ["system", "System", "monitor"],
  ["light", "Light", "sun"],
  ["dark", "Dark", "moon"],
];

/** What can be kept: "system" follows prefers-color-scheme. */
export type ThemePref = "system" | "light" | "dark";

/** Does this browser prefer the dark palette right now? */
export const prefersDark = (mq: { matches: boolean }): boolean => mq.matches;

/** The palette <html> should carry: the choice itself, or the system's when it follows that. */
export function resolvedTheme(pref: ThemePref, systemDark: boolean): "light" | "dark" {
  return pref === "light" || pref === "dark" ? pref : systemDark ? "dark" : "light";
}

/** The saved choice, "system" when none was kept yet. */
export const currentTheme = (storage: Storage): ThemePref => {
  const t = readPref<ThemePref>(storage, "theme", "system");
  return t === "light" || t === "dark" ? t : "system";
};

/** Puts the palette on <html> (app.js applyTheme's write). */
export function applyTheme(pref: ThemePref, systemDark: boolean): void {
  document.documentElement.dataset.theme = resolvedTheme(pref, systemDark);
}

/** Keeps the choice and puts it on <html>; the menus re-render from the storage themselves. */
export function setTheme(storage: Storage, pref: ThemePref, systemDark: boolean): void {
  writePref(storage, "theme", pref);
  applyTheme(pref, systemDark);
}
