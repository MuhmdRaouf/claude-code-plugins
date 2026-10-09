/**
 * Pieces every table view shares: the daisyUI table (md, pinned header) in its scroll wrap — with fixed
 * widths for the columns that ask, so long cells truncate instead of pushing the first columns out of
 * view; on narrow screens the wrap scrolls instead of dropping columns — focusable clickable rows,
 * sortable column headers, the CSV export button, and time cells in the reader's chosen mode.
 */

import type { ComponentChildren, Ref } from "preact";
import { fmtAgo, fmtCount, fmtTime } from "../fmt.ts";
import type { IconName } from "../icons.ts";
import type { ClientState, Sort } from "../state.ts";
import { useApp } from "./context.ts";
import { Icon } from "./Icon.tsx";

/** The header row every table shares: quiet, sentence case, above the rows. */
export const HEAD_CELL = "bg-base-200/60 text-sm font-medium text-base-content/70";

export type Column<K extends string> = {
  key: K;
  label: string;
  numeric?: boolean;
  /** a Tailwind width class fixing this column (`table-fixed`); columns without one share what is left */
  width?: string;
};

/** The daisyUI table: md rows (44px, `text-row`), a pinned header, horizontally scrollable in its wrap.
 *  Columns with a `width` are laid out fixed so the flexible ones truncate; the wrap's element goes to
 *  `wrapRef` for views that track or reset its scroll. */
export function Table({
  dataKey,
  class: cls = "",
  columns,
  wrapRef,
  children,
}: {
  /** the marker the export and tests use to find this table's wrap */
  dataKey?: string;
  class?: string;
  columns?: { key: string; width?: string }[];
  /** receives the scrollable wrap element */
  wrapRef?: Ref<HTMLDivElement>;
  children?: ComponentChildren;
}) {
  return (
    <div
      {...(wrapRef === undefined ? {} : { ref: wrapRef })}
      class="table-wrap max-h-[calc(100dvh-17rem)] min-h-64 overflow-auto"
      {...(dataKey === undefined ? {} : { "data-key": dataKey })}
    >
      <table
        class={["table table-pin-rows text-row", columns === undefined ? "" : "table-fixed", cls]
          .filter(Boolean)
          .join(" ")}
      >
        {columns !== undefined && (
          <colgroup>
            {columns.map((column) => (
              <col key={column.key} class={column.width || undefined} />
            ))}
          </colgroup>
        )}
        {children}
      </table>
    </div>
  );
}

/**
 * One table row. Clickable rows focus (tabIndex 0), open on Enter or Space, and carry the pointer
 * affordance; the rest stay plain. The classes carry the row's state: failed (a faint error tint), the
 * open row (primary at 8%, with the view drawing the 3px primary bar on its first cell), a row that just
 * arrived, an ended one dimmed. `class` carries extras a view needs on top.
 */
export function TableRow({
  onOpen,
  failed = false,
  active = false,
  fresh = false,
  dimmed = false,
  /** emitted as data-action, for rows the controller finds by delegation */
  action,
  value,
  /** emitted as aria-label */
  label,
  class: cls = "",
  children,
}: {
  /** opening the row (click, Enter, Space) */
  onOpen?: (() => void) | undefined;
  failed?: boolean;
  active?: boolean;
  fresh?: boolean;
  /** an ended row (an agent that finished): still readable, quieter than the rest */
  dimmed?: boolean;
  action?: string | undefined;
  value?: string | undefined;
  label?: string | undefined;
  class?: string;
  children?: ComponentChildren;
}) {
  const state = [
    "row",
    failed ? "bg-error/5" : "",
    active ? "bg-primary/8" : "",
    fresh ? "row-new" : "",
    dimmed ? "opacity-60" : "",
    cls,
  ]
    .filter(Boolean)
    .join(" ");
  const shared = {
    ...(action === undefined ? {} : { "data-action": action }),
    ...(value === undefined ? {} : { "data-value": value }),
    ...(label === undefined ? {} : { "aria-label": label }),
  };
  if (onOpen === undefined)
    return (
      <tr class={state} {...shared}>
        {children}
      </tr>
    );
  return (
    <tr
      class={`${state} cursor-pointer transition-colors hover:bg-base-200/50`}
      tabIndex={0}
      onClick={() => onOpen()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      {...shared}
    >
      {children}
    </tr>
  );
}

function SortHeader<K extends string>({
  column,
  sort,
  action,
}: {
  column: Column<K>;
  sort: Sort<K>;
  action: string;
}) {
  const { act } = useApp();
  const on = sort.key === column.key;
  const ascending = on && sort.dir === "asc";
  const arrow: IconName = !on ? "chevronsUpDown" : ascending ? "chevronUp" : "chevronDown";
  return (
    <th
      class={[HEAD_CELL, column.numeric === true ? "num text-right" : ""].filter(Boolean).join(" ")}
      scope="col"
      aria-sort={!on ? "none" : ascending ? "ascending" : "descending"}
    >
      <button
        type="button"
        class={`sort-btn -mx-1.5 inline-flex items-center gap-1 rounded-field px-1.5 py-1 hover:text-base-content${column.numeric === true ? " flex-row-reverse" : ""}${on ? " sort-on text-base-content" : ""}`}
        data-action={action}
        data-value={column.key}
        title={`Sort by ${column.label.toLowerCase()}`}
        onClick={() => act(action, column.key)}
      >
        <span>{column.label}</span>
        <Icon name={arrow} class={`icon icon-xs${on ? " text-primary" : " opacity-60"}`} />
      </button>
    </th>
  );
}

/** Sortable column headers: each label is a button; the sorted column carries aria-sort and an arrow. */
export function TableHead<K extends string>({
  columns,
  sort,
  action,
}: {
  columns: Column<K>[];
  sort: Sort<K>;
  action: string;
}) {
  return (
    <thead>
      <tr>
        {columns.map((column) => (
          <SortHeader key={column.key} column={column} sort={sort} action={action} />
        ))}
      </tr>
    </thead>
  );
}

/** Static column headers (no sort): the same quiet header row the sortable one draws. */
export function TableHeadStatic({
  columns,
}: {
  columns: { key: string; label: string; numeric?: boolean }[];
}) {
  return (
    <thead>
      <tr>
        {columns.map((column) => (
          <th
            key={column.key}
            class={[HEAD_CELL, column.numeric === true ? "num text-right" : ""].filter(Boolean).join(" ")}
            scope="col"
          >
            {column.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

/** A time cell in the reader's chosen mode, with the other mode as its tooltip. */
export function timeText(state: ClientState, ts: number, now: number): { text: string; title: string } {
  const clock = fmtTime(ts);
  const ago = fmtAgo(ts, now);
  return state.timeMode === "absolute" ? { text: clock, title: ago } : { text: ago, title: clock };
}

export function ExportButton({ kind, count }: { kind: string; count: number }) {
  const { act } = useApp();
  return (
    <button
      type="button"
      class="btn btn-sm btn-ghost"
      data-action="export"
      data-value={kind}
      title={`Download the ${fmtCount(count, "row")} shown as CSV`}
      onClick={() => act("export", kind)}
    >
      <Icon name="download" />
      <span>Export CSV</span>
    </button>
  );
}
