/**
 * The small shared vocabulary every panel is built from: cards with a titled head, badges, status dots,
 * segmented controls and empty states. Pure UINode builders; colour arrives only as semantic tokens.
 */

import { type IconName, icon } from "./icons.ts";
import { STATUS_COLOR, type StatusTone } from "./palette.ts";
import { el, leaf, type UINode } from "./types.ts";

/** A status dot; `pulse` marks something live. Always sits next to a word, never alone. */
export function dot(tone: StatusTone, pulse = false): UINode {
  return leaf("span", pulse ? "dot dot-pulse" : "dot", "", {
    style: `--tone:${STATUS_COLOR[tone]}`,
    "aria-hidden": "true",
  });
}

/** Dot + word, coloured by tone (the word carries the meaning for anyone who cannot see the colour). */
export function status(tone: StatusTone, word: string, pulse = false): UINode {
  return el("span", `status status-${tone}`, [dot(tone, pulse), leaf("span", "status-word", word)]);
}

/** A tinted pill: tone colours its text, border and a faint fill. */
export function badge(text: string, tone: StatusTone, iconName?: IconName): UINode {
  const children: UINode[] = [];
  if (iconName !== undefined) children.push(icon(iconName, "icon icon-xs"));
  children.push(leaf("span", "", text));
  return el("span", `badge badge-${tone}`, children);
}

/** An icon in a softly tinted rounded square; `color` is a palette token. */
export function iconTile(name: IconName, color: string, cls = "icon-tile"): UINode {
  return el("span", cls, [icon(name, "icon")], { style: `--tone:${color}` });
}

/** The head row of a card: icon, title, an optional quiet subtitle, and right-aligned controls. */
export function cardHead(
  iconName: IconName,
  title: string,
  subtitle: string | null,
  controls: UINode[] = [],
): UINode {
  const titles: UINode[] = [leaf("h2", "card-title", title)];
  if (subtitle !== null) titles.push(leaf("span", "card-sub", subtitle));
  const children: UINode[] = [
    el("div", "card-heading", [icon(iconName, "icon card-icon"), el("div", "card-titles", titles)]),
  ];
  if (controls.length > 0) children.push(el("div", "card-controls", controls));
  return el("div", "card-head", children);
}

export type Segment = { label: string; value: string; on: boolean; count?: string };

/** A segmented control: one group of toggle buttons sharing a data-action. */
export function segmented(action: string, label: string, segments: Segment[]): UINode {
  return el(
    "div",
    "segmented",
    segments.map((segment): UINode => {
      const children: UINode[] = [leaf("span", "", segment.label)];
      if (segment.count !== undefined) children.push(leaf("span", "segment-count", segment.count));
      return el("button", segment.on ? "segment segment-on" : "segment", children, {
        type: "button",
        "data-action": action,
        "data-value": segment.value,
        "aria-pressed": segment.on ? "true" : "false",
      });
    }),
    { role: "group", "aria-label": label },
  );
}

/** An empty state that says what is missing and what makes it appear. */
export function emptyState(title: string, hint: string, iconName: IconName = "inbox"): UINode {
  return el("div", "empty", [
    el("span", "empty-icon", [icon(iconName, "icon")]),
    leaf("p", "empty-title", title),
    leaf("p", "empty-hint", hint),
  ]);
}

/** A labelled value inside a card or drawer. */
export function field(label: string, value: string, code = false): UINode {
  return el("div", "field", [
    leaf("span", "field-label", label),
    leaf("span", code ? "field-value code" : "field-value", value),
  ]);
}

/** Inline code-ish text (model ids, hosts, session ids) — the only place the monospace face appears. */
export function code(text: string, cls = ""): UINode {
  return leaf("span", cls === "" ? "code" : `code ${cls}`, text);
}
