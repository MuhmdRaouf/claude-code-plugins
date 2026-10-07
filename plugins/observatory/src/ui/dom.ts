/**
 * UINode trees → real elements. Text is set through textContent only — nothing user-derived is ever parsed
 * as HTML — and svg tags are created in the svg namespace so the charts come out as geometry, not
 * unknown-elements. This is the only module that touches document; main.ts owns all policy.
 */

import type { UINode } from "./types.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set([
  "svg",
  "path",
  "line",
  "rect",
  "circle",
  "polyline",
  "text",
  "g",
  "defs",
  "linearGradient",
  "stop",
]);

function create(tag: string): Element {
  return SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
}

function applySpec(element: Element, node: UINode): void {
  if (node.cls !== undefined && node.cls !== "") element.setAttribute("class", node.cls);
  if (node.d !== undefined) element.setAttribute("d", node.d);
  const attrs = node.attrs;
  if (attrs === undefined) return;
  for (const name of Object.keys(attrs)) element.setAttribute(name, attrs[name] ?? "");
}

/** One node (and its subtree) as a live element. */
export function mount(node: UINode): Element {
  const element = create(node.tag);
  applySpec(element, node);
  if (node.text !== undefined) element.textContent = node.text;
  for (const child of node.children ?? []) element.append(mount(child));
  return element;
}

/** What identifies a control across re-renders: its action and value, or an explicit data-key. */
function identity(element: Element | null): string | null {
  if (element === null) return null;
  const key = element.getAttribute("data-key");
  if (key !== null) return `key:${key}`;
  const action = element.getAttribute("data-action");
  if (action === null) return null;
  return `action:${action}:${element.getAttribute("data-value") ?? ""}`;
}

function findByIdentity(root: HTMLElement, wanted: string): HTMLElement | null {
  for (const candidate of root.querySelectorAll<HTMLElement>("[data-key],[data-action]")) {
    if (identity(candidate) === wanted) return candidate;
  }
  return null;
}

/**
 * Full re-render into `root`: the trees are small, so simplicity beats diffing. The once-a-second repaint
 * would otherwise throw away keyboard focus and inner scroll positions, so both are carried across by
 * identity (data-key, else data-action + data-value).
 */
export function mountInto(root: HTMLElement, node: UINode): void {
  const active = document.activeElement;
  const focused = active !== null && root.contains(active) ? identity(active) : null;
  const scrolls = new Map<string, { top: number; left: number }>();
  for (const element of root.querySelectorAll<HTMLElement>("[data-key]")) {
    if (element.scrollTop > 0 || element.scrollLeft > 0) {
      scrolls.set(`key:${element.getAttribute("data-key") ?? ""}`, {
        top: element.scrollTop,
        left: element.scrollLeft,
      });
    }
  }
  root.replaceChildren(mount(node));
  for (const [key, at] of scrolls) {
    const element = findByIdentity(root, key);
    if (element === null) continue;
    element.scrollTop = at.top;
    element.scrollLeft = at.left;
  }
  if (focused !== null) findByIdentity(root, focused)?.focus({ preventScroll: true });
}
