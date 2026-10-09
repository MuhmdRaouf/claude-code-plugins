// tabs.tsx — a tablist where the selected tab is the only tab stop: the arrows walk the tabs, Home and End
// jump to the ends, and every walk selects as it goes. Port of core.js wireTabs over the markup the legacy
// work view rendered (`role=tablist` of `role=tab` buttons with a `data-tab`).

import type { ComponentChildren, JSX } from "preact";
import { useRef } from "preact/hooks";

/** One tab: its route key, what the button shows. */
export type Tab = {
  id: string;
  label: ComponentChildren;
  /** A ready icon vnode (sized by the caller) shown before the label */
  icon?: ComponentChildren | undefined;
};

/** The index a key walks to from `at`, wrapping at the ends; NaN for a key the strip ignores. */
const keyTo = (n: number, key: string, at: number): number => {
  if (key === "ArrowRight") return (at + 1 + n) % n;
  if (key === "ArrowLeft") return (at - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return Number.NaN;
};

/** The work view's tab strip: a `.seg` tablist whose selection the parent owns via `value`. */
export function Tabs({
  tabs,
  value,
  onPick,
  label = "View",
  panel = "wpanel",
  class: c = "seg",
}: {
  tabs: readonly Tab[];
  value: string;
  onPick: (id: string) => void;
  label?: string | undefined;
  /** The id of the tabpanel the tabs control */
  panel?: string | undefined;
  class?: string | undefined;
}): JSX.Element {
  const list = useRef<HTMLDivElement>(null);

  const choose = (id: string, focus: boolean): void => {
    const el = list.current?.querySelector(`[data-tab="${CSS.escape(id)}"]`);
    if (focus && el instanceof HTMLElement) el.focus();
    onPick(id);
  };

  const onKey = (id: string, key: string): void => {
    const at = tabs.findIndex((x) => x.id === id);
    const to = keyTo(tabs.length, key, at);
    if (Number.isNaN(to)) return;
    // the walk only lands inside the strip, so the one matching index is the pick
    for (const [i, t] of tabs.entries()) if (i === to) choose(t.id, true);
  };

  return (
    <div ref={list} class={c} role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <TabButton key={t.id} t={t} on={t.id === value} panel={panel} onPick={onPick} onKey={onKey} />
      ))}
    </div>
  );
}

/** One tab button: the legacy work strip's `role=tab` with its data-tab and roving tabindex. */
function TabButton({
  t,
  on,
  panel,
  onPick,
  onKey,
}: {
  t: Tab;
  on: boolean;
  panel: string;
  onPick: (id: string) => void;
  onKey: (id: string, key: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      id={`wt-${t.id}`}
      data-tab={t.id}
      aria-selected={on}
      aria-controls={panel}
      tabIndex={on ? 0 : -1}
      onClick={(e) => {
        e.preventDefault();
        onPick(t.id);
      }}
      onKeyDown={(e) => onKey(t.id, e.key)}
    >
      {t.icon}
      {t.label}
    </button>
  );
}
