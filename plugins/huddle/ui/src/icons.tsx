// icons.tsx — the icon set of the owner UI: Lucide-style strokes, inline, offline. Every entry of
// the table is the inside of one 24×24 svg; an unknown name renders an empty svg, never an error.
import type { JSX } from "preact";

/** Every icon name the UI can draw. */
export type IconName =
  | "inbox"
  | "activity"
  | "list"
  | "columns"
  | "graph"
  | "map"
  | "book"
  | "pencil"
  | "note"
  | "code"
  | "sliders"
  | "search"
  | "sun"
  | "moon"
  | "monitor"
  | "bell"
  | "pause"
  | "play"
  | "send"
  | "msg"
  | "ask"
  | "turn"
  | "key"
  | "alert"
  | "x"
  | "plus"
  | "check"
  | "checkc"
  | "circle"
  | "half"
  | "ban"
  | "minusc"
  | "clock"
  | "hourglass"
  | "zzz"
  | "logout"
  | "link"
  | "copy"
  | "undo"
  | "ext"
  | "right"
  | "left"
  | "down"
  | "up"
  | "more"
  | "users"
  | "arrowdown"
  | "arrow"
  | "trash"
  | "download"
  | "upload"
  | "terminal"
  | "plug"
  | "keyboard"
  | "hash"
  | "layers"
  | "file"
  | "folder"
  | "sparkle"
  | "brain"
  | "baton"
  | "flag";

/** The inside of every icon, keyed by name: the shapes a 24×24 stroke svg draws. */
export const P: Record<IconName, readonly JSX.Element[]> = {
  inbox: [
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />,
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />,
  ],
  activity: [<path d="M22 12h-4l-3 9L9 3l-3 9H2" />],
  list: [<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />],
  columns: [<rect x="3" y="3" width="18" height="18" rx="2" />, <path d="M9 3v18M15 3v18" />],
  graph: [
    <rect x="3" y="3" width="7" height="7" rx="1.5" />,
    <rect x="14" y="14" width="7" height="7" rx="1.5" />,
    <path d="M6.5 10v3.5a2 2 0 0 0 2 2H14" />,
  ],
  map: [<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z" />, <path d="M9 3v15M15 6v15" />],
  book: [<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />],
  pencil: [<path d="M12 20h9" />, <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />],
  note: [
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />,
    <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2zM9 13h6M9 17h4" />,
  ],
  code: [<path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />],
  sliders: [<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />],
  search: [<circle cx="11" cy="11" r="7" />, <path d="m21 21-4.3-4.3" />],
  sun: [
    <circle cx="12" cy="12" r="4" />,
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />,
  ],
  moon: [<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />],
  monitor: [<rect x="2" y="3" width="20" height="14" rx="2" />, <path d="M8 21h8M12 17v4" />],
  bell: [<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />, <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />],
  pause: [
    <rect x="6" y="4" width="4" height="16" rx="1" />,
    <rect x="14" y="4" width="4" height="16" rx="1" />,
  ],
  play: [<path d="m6 3 14 9-14 9z" />],
  send: [<path d="m22 2-7 20-4-9-9-4z" />, <path d="M22 2 11 13" />],
  msg: [<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />],
  ask: [<circle cx="12" cy="12" r="10" />, <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />],
  turn: [<path d="m16 3 4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16" />],
  key: [<circle cx="7.5" cy="15.5" r="5.5" />, <path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />],
  alert: [
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />,
    <path d="M12 9v4M12 17h.01" />,
  ],
  x: [<path d="M18 6 6 18M6 6l12 12" />],
  plus: [<path d="M12 5v14M5 12h14" />],
  check: [<path d="M20 6 9 17l-5-5" />],
  checkc: [<circle cx="12" cy="12" r="9" />, <path d="m8.5 12 2.5 2.5 4.5-5" />],
  circle: [<circle cx="12" cy="12" r="9" />],
  half: [<circle cx="12" cy="12" r="9" />, <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />],
  ban: [<circle cx="12" cy="12" r="9" />, <path d="m5.7 5.7 12.6 12.6" />],
  minusc: [<circle cx="12" cy="12" r="9" />, <path d="M8 12h8" />],
  clock: [<circle cx="12" cy="12" r="9" />, <path d="M12 7v5l3 2" />],
  hourglass: [
    <path d="M5 22h14M5 2h14M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2" />,
  ],
  zzz: [<path d="M4 7h6l-6 7h6M14 4h6l-6 7h6" />],
  logout: [<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />],
  link: [
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />,
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />,
  ],
  copy: [<rect x="8" y="8" width="13" height="13" rx="2" />, <path d="M4 16V4a2 2 0 0 1 2-2h10" />],
  undo: [<path d="M3 7v6h6" />, <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />],
  ext: [<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />],
  right: [<path d="m9 18 6-6-6-6" />],
  left: [<path d="m15 18-6-6 6-6" />],
  down: [<path d="m6 9 6 6 6-6" />],
  up: [<path d="m18 15-6-6-6 6" />],
  more: [<circle cx="5" cy="12" r="1" />, <circle cx="12" cy="12" r="1" />, <circle cx="19" cy="12" r="1" />],
  users: [
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />,
    <circle cx="9" cy="7" r="4" />,
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />,
  ],
  arrowdown: [<path d="M12 5v14M19 12l-7 7-7-7" />],
  arrow: [<path d="M5 12h14M13 5l7 7-7 7" />],
  trash: [<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />],
  download: [<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />],
  upload: [<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />],
  terminal: [<path d="m4 17 6-6-6-6M12 19h8" />],
  plug: [<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z" />],
  keyboard: [
    <rect x="2" y="5" width="20" height="14" rx="2" />,
    <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 17h8M10 13h4" />,
  ],
  hash: [<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />],
  layers: [<path d="m12 2 10 5-10 5L2 7z" />, <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />],
  file: [<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />, <path d="M14 2v6h6" />],
  folder: [
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z" />,
  ],
  sparkle: [
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />,
  ],
  brain: [
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />,
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />,
    <path d="M12 5v13" />,
  ],
  baton: [<circle cx="12" cy="5" r="2" />, <path d="M12 7v4M5 21l3-6h8l3 6M8 15l4-4 4 4" />],
  flag: [<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7" />],
};

/** An icon: one stroked svg with the shapes of its name; an unknown name draws nothing inside. */
export function Icon({
  name,
  class: c = "size-4",
}: {
  name: IconName;
  class?: string | undefined;
}): JSX.Element {
  const shapes = P[name] ?? [];
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
      {shapes}
    </svg>
  );
}

/** The huddle mark: the rounded square with its ring and three members, gradients included. */
export function Logo({ class: c = "size-16" }: { class?: string | undefined }): JSX.Element {
  return (
    <svg viewBox="0 0 128 128" class={c} aria-hidden="true">
      <defs>
        <linearGradient id="huddle-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#313244" />
          <stop offset="1" stop-color="#11111b" />
        </linearGradient>
        <linearGradient id="huddle-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#cba6f7" />
          <stop offset="1" stop-color="#89b4fa" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#huddle-bg)" />
      <rect x="4.5" y="4.5" width="119" height="119" rx="27.5" fill="none" stroke="#45475a" />
      <circle
        cx="64"
        cy="66"
        r="30"
        fill="none"
        stroke="url(#huddle-ring)"
        stroke-width="5"
        stroke-dasharray="11 7"
        stroke-linecap="round"
        opacity=".9"
      />
      <circle cx="64" cy="66" r="11" fill="#cba6f7" />
      <circle cx="64" cy="66" r="4.5" fill="#1e1e2e" />
      <circle cx="64" cy="33" r="10" fill="#89b4fa" stroke="#1e1e2e" stroke-width="4" />
      <circle cx="35.4" cy="82.5" r="10" fill="#a6e3a1" stroke="#1e1e2e" stroke-width="4" />
      <circle cx="92.6" cy="82.5" r="10" fill="#f5c2e7" stroke="#1e1e2e" stroke-width="4" />
    </svg>
  );
}
