// picker.tsx — the dependency picker: chips for the tasks already chosen and a combobox that fuzzy-finds
// the rest, open tasks first. The keyboard walks the menu (arrows), takes the highlighted task (Enter),
// hides it for the dialog's own Escape, and Backspace on an empty query takes the last chip off.
// Port of core.js PICK/pickVal/pickSet/pickerHTML/wirePicker; the selection lives in the parent (the
// `value` prop) instead of a module map, so a re-render of the surrounding view keeps it the same way.

import { fuzzy } from "@muhmdraouf/ui/fuzzy.ts";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Icon } from "./icons.tsx";
import { StatusIcon } from "./kit.tsx";
import { FIN, type Task, taskState } from "./status.ts";

/** One task the menu can offer: the status model's fields plus the id and title the rows show. */
export type PickerTask = Task & { id: string; title: string };

/** How the picker behaves: what it is called, how many it takes, what it leaves alone. */
export type PickerProps = {
  /** Names the input and the menu (`<id>-q` / `<id>-menu`), the way the legacy markup did */
  id: string;
  /** The chosen task ids, owned by the parent */
  value: readonly string[];
  /** The whole board, the pool the menu ranks */
  tasks: readonly PickerTask[];
  /** Looks a chosen id up, for the chip's title and status */
  byId: (id: string) => (Task & { title: string }) | null | undefined;
  onChange?: ((ids: string[]) => void) | undefined;
  placeholder?: string | undefined;
  /** The input's aria-label */
  label?: string | undefined;
  /** The most chips it accepts; the input hides once reached */
  max?: number | undefined;
  /** A task id the menu never offers (the task being edited) */
  exclude?: string | undefined;
};

const MENU_SIZE = 8;

/**
 * The dependency picker for `value`, a controlled component: pick or remove a chip and `onChange` hands the
 * parent the new id list. With a query the menu ranks the board by fuzzy score; without one it offers the
 * first open tasks that are not chosen yet.
 */
export function Picker({
  id,
  value,
  tasks,
  byId,
  onChange,
  placeholder,
  label,
  max,
  exclude,
}: PickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);

  const full = max !== undefined && value.length >= max;
  const sel = new Set(value);
  const pool = tasks.filter((s) => !sel.has(s.id) && s.id !== exclude);
  const items = (
    query
      ? pool
          .map((s) => [fuzzy(query, `${s.id} ${s.title}`), s] as const)
          .filter((x) => x[0] >= 0)
          .sort((a, b) => b[0] - a[0])
          .map((x) => x[1])
      : pool.filter((s) => !FIN.has(s.status))
  ).slice(0, MENU_SIZE);
  const k = Math.min(at, Math.max(0, items.length - 1));

  const set = (ids: string[]): void => {
    // the legacy picker repainted itself whole, which also emptied the query; keep that reset
    setQuery("");
    setAt(0);
    onChange?.(ids);
  };
  const pick = (i: number): void => {
    const s = items[i];
    if (s) set([...value, s.id]);
  };
  /** Enter takes the highlighted task — unless a modifier says the composer meant something else. */
  const take = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || !open) return;
    const s = items[k];
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    pick(k);
  };
  /** Escape hides the menu first and only then falls through to the dialog around the picker. */
  const dismiss = (e: KeyboardEvent): void => {
    if (!open) return;
    e.stopPropagation();
    e.preventDefault();
    setOpen(false);
  };

  return (
    <div class="relative">
      <div class="flex flex-wrap items-center gap-1 rounded-lg border hairline bg-base-200 p-1 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
        {value.map((t) => {
          const s = byId(t);
          return (
            <span
              class="badge badge-ghost badge-sm h-7 max-w-full pr-0.5"
              title={s ? s.title : "No such task"}
            >
              <StatusIcon status={s ? taskState(s) : "blocked"} class="size-3.5" />
              <span class="font-mono">{t}</span>
              <span class="max-w-40 truncate">{s ? s.title : "missing"}</span>
              <button
                type="button"
                class="inline-flex size-6 items-center justify-center rounded hover:bg-base-content/10"
                aria-label={`Remove ${t}`}
                onClick={() => set(value.filter((x) => x !== t))}
              >
                <Icon name="x" class="size-3" />
              </button>
            </span>
          );
        })}
        <input
          id={`${id}-q`}
          class={`h-7 min-w-28 flex-1 bg-transparent px-1.5 text-sm outline-none placeholder:text-base-content/50${full ? " hidden" : ""}`}
          placeholder={placeholder ?? "Search tasks by id or title"}
          autocomplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-menu`}
          aria-label={label ?? "Add a task"}
          aria-activedescendant={open && items.length > 0 ? `${id}-o${k}` : undefined}
          value={query}
          onFocus={() => {
            setOpen(true);
            setQuery("");
            setAt(0);
          }}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setAt(0);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setAt(Math.min(k + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setAt(Math.max(k - 1, 0));
            } else if (e.key === "Enter") {
              take(e);
            } else if (e.key === "Escape") {
              dismiss(e);
            } else if (e.key === "Backspace" && query === "" && value.length > 0) {
              set(value.slice(0, -1));
            }
          }}
        />
      </div>
      <div
        id={`${id}-menu`}
        class="menu absolute inset-x-0 top-full mt-1 max-h-72 overflow-y-auto"
        role="listbox"
        hidden={!open}
      >
        {items.length === 0 ? (
          <p class="text-xs muted px-2 py-1.5">{query ? "No task matches." : "No open tasks."}</p>
        ) : (
          items.map((s, i) => (
            <button
              type="button"
              key={s.id}
              role="option"
              id={`${id}-o${i}`}
              aria-selected={i === k}
              class={i === k ? "bg-base-content/10" : ""}
              onMouseDown={(e) => {
                // keep the input's focus: the click must not read as leaving the picker
                e.preventDefault();
                pick(i);
              }}
            >
              <StatusIcon status={taskState(s)} class="size-3.5" />
              <span class="badge badge-ghost badge-sm font-mono">{s.id}</span>
              <span class="truncate">{s.title}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
