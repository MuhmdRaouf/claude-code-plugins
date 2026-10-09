// icons.tsx — the handful of stroke icons the overlays draw themselves: toast alert/check/dismiss/undo
// and the menu's check mark. Paths are the ones the huddle icon set (the core.I port) uses, kept here so
// the shared package stays self-contained; radar can adopt the same shapes for its own overlays.
import type { JSX } from "preact";

/** The icons the shared overlays need. */
export type IconName = "alert" | "check" | "x" | "undo";

/** Icon name → the svg shapes inside a 24×24 stroke box. */
const P: Record<IconName, readonly JSX.Element[]> = {
  alert: [
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />,
    <path d="M12 9v4M12 17h.01" />,
  ],
  x: [<path d="M18 6 6 18M6 6l12 12" />],
  check: [<path d="M20 6 9 17l-5-5" />],
  undo: [<path d="M3 7v6h6" />, <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />],
};

/** One stroke icon at `class` size, hidden from screen readers (the text around it carries the meaning). */
export function Icon({
  name,
  class: c = "size-4",
}: {
  name: IconName;
  class?: string | undefined;
}): JSX.Element {
  return (
    <svg
      class={`${c} shrink-0`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {P[name]}
    </svg>
  );
}
