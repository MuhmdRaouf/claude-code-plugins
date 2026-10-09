// menu.tsx — a small menu anchored to a button: the theme picker, "Add section", the board's "Move to",
// the bottom bar. It opens near the anchor (right-aligned with it, inside the viewport), the checked entry
// starts focused, the arrows and Home/End walk the entries, and Escape, Tab or a click outside close it.
// Port of core.js popMenu; the parent closes it by unmounting when `onClose` fires.

import type { ComponentChildren, JSX } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.tsx";

/** One entry of a popup menu; `checked` turns it into a radio entry, `badge` pins a right-aligned extra. */
export type MenuItem = {
  label: ComponentChildren;
  /** A ready icon vnode (sized by the caller); it picks up the menu's faint ink */
  icon?: ComponentChildren | undefined;
  checked?: boolean | undefined;
  badge?: ComponentChildren | undefined;
  run: () => void;
};

/** Why the menu closed: an entry ran or Escape closed it (`picked`, the anchor refocuses), or a click
 * outside or Tab dismissed it (no refocus). */
export type MenuClose = { picked: boolean };

/**
 * The popup for `anchor`, portalled into the anchor's dialog or the body and pinned under (or, with `dir`
 * "up", above) it. Every close — an entry, Escape, Tab, a click outside — calls `onClose`, which the parent
 * answers by taking the menu off the page; picking an entry first runs its own action.
 */
export function PopMenu({
  anchor,
  items,
  onClose,
  dir = "down",
}: {
  anchor: HTMLElement | null | undefined;
  items: readonly MenuItem[];
  onClose: (why: MenuClose) => void;
  dir?: "up" | "down" | undefined;
}): JSX.Element | null {
  const menu = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const closer = useRef<(picked: boolean) => void>(() => {});

  const close = (picked: boolean): void => {
    if (picked && anchor instanceof HTMLElement) anchor.focus();
    onClose({ picked });
  };
  closer.current = close;

  // the anchor's dialog hosts the menu, so it stays inside the modal's top layer; while it is up the
  // anchor reads as expanded
  useEffect(() => {
    setHost(anchor?.closest("dialog") ?? document.body);
    anchor?.setAttribute("aria-expanded", "true");
    return () => anchor?.setAttribute("aria-expanded", "false");
  }, [anchor]);

  // measure the painted menu once, then pin it inside the viewport and focus the checked entry
  useEffect(() => {
    const m = menu.current;
    if (!m || pos || !host) return;
    const r = anchor?.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(window.innerWidth - m.offsetWidth - 8, (r?.right ?? 0) - m.offsetWidth),
    );
    const top =
      dir === "up"
        ? window.innerHeight - (r?.top ?? 0) + 6
        : Math.min((r?.bottom ?? 0) + 4, window.innerHeight - m.offsetHeight - 8);
    setPos({ left, top });
    const first = m.querySelector('[aria-checked="true"]') ?? m.querySelector("button");
    if (first instanceof HTMLElement) first.focus();
  }, [anchor, dir, host, pos]);

  // a click anywhere outside the menu closes it without an entry; the timeout keeps the click that
  // opened the menu from closing it again
  useEffect(() => {
    if (!host) return;
    const outside = (e: Event): void => {
      if (!menu.current?.contains(e.target as Node)) closer.current(false);
    };
    const t = setTimeout(() => document.addEventListener("click", outside, true), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("click", outside, true);
    };
  }, [host]);

  if (!host) return null;

  /** Where the focus sits among the entries; outside the menu it reads as "before the first". */
  const at = (root: HTMLDivElement): number => {
    const active = document.activeElement;
    return active instanceof HTMLButtonElement ? [...root.querySelectorAll("button")].indexOf(active) : -1;
  };

  /** Put the focus on the entry `step` places from `from`, wrapping at the ends. */
  const focusWalk = (root: HTMLDivElement, from: number, step: number): void => {
    const bs = [...root.querySelectorAll("button")];
    const n = bs.length;
    if (n === 0) return;
    const to = (((from + step) % n) + n) % n;
    for (const [i, b] of bs.entries()) if (i === to) b.focus();
  };

  return createPortal(
    <div
      ref={menu}
      class="menu fixed"
      role="menu"
      style={pos ? `left:${pos.left}px;top:${pos.top}px` : "visibility:hidden"}
      onKeyDown={(e) => {
        const root = e.currentTarget;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close(true);
        } else if (e.key === "Tab") {
          close(false);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          focusWalk(root, at(root), 1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          focusWalk(root, at(root), -1);
        } else if (e.key === "Home") {
          e.preventDefault();
          focusWalk(root, 0, 0);
        } else if (e.key === "End") {
          e.preventDefault();
          focusWalk(root, -1, 0);
        }
      }}
    >
      {items.map((it, i) => (
        // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the checked entry reads as a radio, word for word like the legacy menu
        <button
          type="button"
          key={i}
          role={it.checked === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={it.checked === undefined ? undefined : it.checked ? "true" : "false"}
          onClick={() => {
            close(true);
            it.run();
          }}
        >
          {it.icon ? <span class="text-faint">{it.icon}</span> : null}
          {it.label}
          <span class="flex-1" />
          {it.checked ? <Icon name="check" class="size-4" /> : (it.badge ?? null)}
        </button>
      ))}
    </div>,
    host,
  );
}
