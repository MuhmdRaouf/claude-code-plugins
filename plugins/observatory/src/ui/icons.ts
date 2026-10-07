/**
 * Line icons as inline svg node trees, drawn on Lucide's 24-unit grid (2px round strokes, no fills) so every
 * glyph shares one weight. Nothing is fetched: the shapes are data here and dom.ts mounts them as svg.
 * Icons are decorative by default (aria-hidden); pass a label when an icon is the only content of a control.
 */

import type { UINode } from "./types.ts";

type Shape =
  | { d: string }
  | { circle: [number, number, number] }
  | { rect: [number, number, number, number, number] }
  | { line: [number, number, number, number] }
  | { points: string };

const ICONS = {
  logo: [{ d: "M3 20h18" }, { d: "M5 20a7 7 0 0 1 14 0" }, { d: "m11 13 7-6" }, { circle: [19, 6, 1.5] }],
  activity: [{ d: "M22 12h-4l-3 9L9 3l-3 9H2" }],
  layers: [
    {
      d: "m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z",
    },
    { d: "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" },
    { d: "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" },
  ],
  bot: [
    { d: "M12 8V4H8" },
    { rect: [4, 8, 16, 12, 2] },
    { d: "M2 14h2" },
    { d: "M20 14h2" },
    { d: "M15 13v2" },
    { d: "M9 13v2" },
  ],
  arrows: [{ d: "M8 3 4 7l4 4" }, { d: "M4 7h16" }, { d: "m16 21 4-4-4-4" }, { d: "M20 17H4" }],
  wrench: [
    {
      d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
    },
  ],
  clock: [{ circle: [12, 12, 10] }, { d: "M12 6v6l4 2" }],
  history: [
    { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" },
    { d: "M3 3v5h5" },
    { d: "M12 7v5l4 2" },
  ],
  cpu: [
    { rect: [4, 4, 16, 16, 2] },
    { rect: [9, 9, 6, 6, 1] },
    { d: "M15 2v2" },
    { d: "M15 20v2" },
    { d: "M2 15h2" },
    { d: "M2 9h2" },
    { d: "M20 15h2" },
    { d: "M20 9h2" },
    { d: "M9 2v2" },
    { d: "M9 20v2" },
  ],
  alert: [
    { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" },
    { d: "M12 9v4" },
    { d: "M12 17h.01" },
  ],
  timer: [{ line: [10, 2, 14, 2] }, { line: [12, 14, 15, 11] }, { circle: [12, 14, 8] }],
  coins: [
    { circle: [8, 8, 6] },
    { d: "M18.09 10.37A6 6 0 1 1 10.34 18" },
    { d: "M7 6h1v4" },
    { d: "m16.71 13.88.7.71-2.82 2.82" },
  ],
  sun: [
    { circle: [12, 12, 4] },
    { d: "M12 2v2" },
    { d: "M12 20v2" },
    { d: "m4.93 4.93 1.41 1.41" },
    { d: "m17.66 17.66 1.41 1.41" },
    { d: "M2 12h2" },
    { d: "M20 12h2" },
    { d: "m6.34 17.66-1.41 1.41" },
    { d: "m19.07 4.93-1.41 1.41" },
  ],
  moon: [{ d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" }],
  monitor: [{ rect: [2, 3, 20, 14, 2] }, { line: [8, 21, 16, 21] }, { line: [12, 17, 12, 21] }],
  chevronRight: [{ d: "m9 18 6-6-6-6" }],
  chevronDown: [{ d: "m6 9 6 6 6-6" }],
  chevronUp: [{ d: "m18 15-6-6-6 6" }],
  chevronsUpDown: [{ d: "m7 15 5 5 5-5" }, { d: "m7 9 5-5 5 5" }],
  download: [{ d: "M12 15V3" }, { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }, { d: "m7 10 5 5 5-5" }],
  close: [{ d: "M18 6 6 18" }, { d: "m6 6 12 12" }],
  check: [{ d: "M20 6 9 17l-5-5" }],
  branch: [
    { line: [6, 3, 6, 15] },
    { circle: [18, 6, 3] },
    { circle: [6, 18, 3] },
    { d: "M18 9a9 9 0 0 1-9 9" },
  ],
  merge: [{ d: "M20 4v7a4 4 0 0 1-4 4H4" }, { d: "m9 10-5 5 5 5" }],
  plug: [
    { d: "M12 22v-5" },
    { d: "M9 8V2" },
    { d: "M15 8V2" },
    { d: "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" },
  ],
  inbox: [
    { points: "22 12 16 12 14 15 10 15 8 12 2 12" },
    {
      d: "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
    },
  ],
  play: [{ d: "M6 3l14 9-14 9V3z" }],
  stop: [{ rect: [5, 5, 14, 14, 2] }],
  pause: [{ circle: [12, 12, 10] }, { line: [10, 15, 10, 9] }, { line: [14, 15, 14, 9] }],
  message: [{ d: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z" }],
  fold: [
    { d: "M12 22v-6" },
    { d: "M12 8V2" },
    { d: "M4 12H2" },
    { d: "M10 12H8" },
    { d: "M16 12h-2" },
    { d: "M22 12h-2" },
    { d: "m15 19-3-3-3 3" },
    { d: "m15 5-3 3-3-3" },
  ],
  bell: [
    { d: "M10.27 21a2 2 0 0 0 3.46 0" },
    {
      d: "M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33",
    },
  ],
  dot: [{ circle: [12, 12, 3] }],
  wifiOff: [
    { d: "M12 20h.01" },
    { d: "M8.5 16.43a5 5 0 0 1 7 0" },
    { d: "M2 8.82a15 15 0 0 1 4.17-2.65" },
    { d: "M10.66 5c4.01-.36 8.14.9 11.34 3.76" },
    { d: "M16.85 11.25a10 10 0 0 1 2.22 1.68" },
    { d: "M5 13a10 10 0 0 1 5.24-2.76" },
    { d: "m2 2 20 20" },
  ],
  settings: [
    {
      d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    },
    { circle: [12, 12, 3] },
  ],
  trash: [
    { d: "M3 6h18" },
    { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" },
    { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" },
  ],
  pencil: [
    {
      d: "M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z",
    },
  ],
  plus: [{ d: "M5 12h14" }, { d: "M12 5v14" }],
  gauge: [{ d: "m12 14 4-4" }, { d: "M3.34 19a10 10 0 1 1 17.32 0" }],
  repeat: [
    { d: "m17 2 4 4-4 4" },
    { d: "M3 11v-1a4 4 0 0 1 4-4h14" },
    { d: "m7 22-4-4 4-4" },
    { d: "M21 13v1a4 4 0 0 1-4 4H3" },
  ],
  route: [
    { circle: [6, 19, 3] },
    { d: "M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" },
    { circle: [18, 5, 3] },
  ],
  dollar: [{ line: [12, 2, 12, 22] }, { d: "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" }],
  sparkle: [
    {
      d: "M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z",
    },
  ],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

export const ICON_NAMES = Object.keys(ICONS) as IconName[];

function shapeNode(shape: Shape): UINode {
  if ("d" in shape) return { tag: "path", d: shape.d };
  if ("circle" in shape) {
    const [cx, cy, r] = shape.circle;
    return { tag: "circle", attrs: { cx: String(cx), cy: String(cy), r: String(r) } };
  }
  if ("rect" in shape) {
    const [x, y, width, height, rx] = shape.rect;
    return {
      tag: "rect",
      attrs: { x: String(x), y: String(y), width: String(width), height: String(height), rx: String(rx) },
    };
  }
  if ("line" in shape) {
    const [x1, y1, x2, y2] = shape.line;
    return { tag: "line", attrs: { x1: String(x1), y1: String(y1), x2: String(x2), y2: String(y2) } };
  }
  return { tag: "polyline", attrs: { points: shape.points } };
}

/** One icon; `label` makes it an announced image instead of decoration. */
export function icon(name: IconName, cls = "icon", label?: string): UINode {
  const a11y: Record<string, string> =
    label === undefined ? { "aria-hidden": "true" } : { role: "img", "aria-label": label };
  return {
    tag: "svg",
    cls,
    attrs: {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "data-icon": name,
      ...a11y,
    },
    children: ICONS[name].map(shapeNode),
  };
}
