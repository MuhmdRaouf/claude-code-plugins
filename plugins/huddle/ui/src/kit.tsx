// kit.tsx — the small pieces every view is built from: status pills and icons, the session pill
// with its reason, avatars, stat cards, empty states, the loading skeleton and relative times.
import { type Stamp, timeAgo } from "@muhmdraouf/ui/time.ts";
import type { JSX } from "preact";
import { Icon, type IconName } from "./icons.tsx";
import {
  avatarColor,
  type Session,
  SSTM,
  STATM,
  type StatMeta,
  sessionMeta,
  sessionStatus,
  sessionWhy,
  statMeta,
  type TaskLookup,
} from "./status.ts";

/** Status word → daisyUI badge tone; task states and session states share one table. */
const HUE: Record<string, string> = {
  todo: "badge-ghost",
  doing: "badge-info",
  done: "badge-success",
  skipped: "badge-ghost",
  blocked: "badge-error",
  waiting: "badge-warning",
  paused: "badge-secondary",
  working: "badge-info",
  idle: "badge-ghost",
  left: "badge-ghost",
  needs: "badge-error",
  info: "badge-info",
  violet: "badge-secondary",
};

/** The tone of a status word: ghost for a word the table does not know. */
const pillHue = (status: string): string => HUE[status] ?? "badge-ghost";

/** A status word as a badge: its tone from the table, its label from either status table, else the word. */
export function Pill({ status, label }: { status: string; label?: string | undefined }): JSX.Element {
  const word = label ?? statMeta(status)?.l ?? sessionMeta(status)?.l ?? status;
  return <span class={`badge badge-sm ${pillHue(status)}`}>{word}</span>;
}

/** A status word as its icon with a title and a screen-reader label; an unknown word shows "To do". */
export function StatusIcon({
  status,
  class: c = "size-4",
}: {
  status: string;
  class?: string | undefined;
}): JSX.Element {
  const m: StatMeta = statMeta(status) ?? STATM.todo;
  return (
    <span class={`${m.c} ink inline-flex`} title={m.l}>
      <Icon name={m.i} class={c} />
      <span class="sr-only">{m.l}</span>
    </span>
  );
}

/** A session's derived status as a badge; its title is the reason the session sits there. */
export function SessionPill({
  session,
  taskById,
  now,
  small = false,
}: {
  session: Session | null | undefined;
  taskById: TaskLookup;
  now: number;
  small?: boolean | undefined;
}): JSX.Element {
  const k = sessionStatus(session, taskById);
  return (
    <span class={`badge ${pillHue(k)}${small ? " badge-sm" : ""}`} title={sessionWhy(session, taskById, now)}>
      {SSTM[k].l}
    </span>
  );
}

/** A name as a coloured disc with the first letter of its last dot segment; the owner is mauve with a Y. */
export function Avatar({ name, small = false }: { name: string; small?: boolean | undefined }): JSX.Element {
  const letter = (name.split(".").at(-1)?.at(0) ?? "").toUpperCase();
  return (
    <span
      class={`avatar avatar-placeholder ${name === "owner" ? "c-mauve" : avatarColor(name)}`}
      aria-hidden="true"
    >
      <span class={`${small ? "w-6" : "w-8"} rounded-full tinted`}>
        <span class="ink text-sm font-semibold">{name === "owner" ? "Y" : letter}</span>
      </span>
    </span>
  );
}

/** A stat card's change marker: which way it points and its text. */
export type StatDelta = { up: boolean; text: string };

// The legacy value carried data-count for hrCountUp's 300 ms tick (core.js hrStat); the shared
// count-up has not moved to packages/ui yet, so the value shows directly.
/** A daisyUI stat: muted title, tinted figure, the value, an optional delta and subline. */
export function Stat({
  icon,
  tint = "",
  label,
  value,
  sub = "",
  delta = null,
}: {
  icon: IconName;
  tint?: string | undefined;
  label: string;
  value: number;
  sub?: string | undefined;
  delta?: StatDelta | null | undefined;
}): JSX.Element {
  return (
    <div class="stat panel px-4 py-3">
      <span
        class={`stat-figure tinted ink inline-flex size-7 shrink-0 items-center justify-center rounded-lg${tint ? ` ${tint}` : ""}`}
      >
        <Icon name={icon} />
      </span>
      <div class="stat-title flex min-w-0 items-center gap-2">
        <span class="min-w-0 flex-1 truncate">{label}</span>
        {delta ? (
          <span class={`badge badge-sm ${delta.up ? "badge-success" : "badge-error"} tnum`}>
            {delta.text}
          </span>
        ) : null}
      </div>
      <div class="stat-value text-[28px] tnum">{value}</div>
      {sub ? <div class="stat-desc">{sub}</div> : null}
    </div>
  );
}

/** An empty region: an optional icon, one line of text and an optional hint under it. */
export function Empty({
  text,
  hint = "",
  icon,
}: {
  text: string;
  hint?: string | undefined;
  icon?: IconName | undefined;
}): JSX.Element {
  return (
    <div class="flex flex-col items-center gap-1.5 rounded-box border border-dashed border-base-content/20 px-6 py-10 text-center text-sm muted">
      {icon ? <Icon name={icon} class="size-6 mb-1" /> : null}
      <p class="text-sm font-medium text-base-content">{text}</p>
      {hint ? <span class="max-w-sm text-sm muted">{hint}</span> : null}
    </div>
  );
}

/** The loading placeholder: a labelled stack of daisyUI skeleton rows, four of h-14 by default. */
export function Skeleton({
  rows = 4,
  class: c = "h-14",
}: {
  rows?: number | undefined;
  class?: string | undefined;
}): JSX.Element {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the loading region's live attributes
    <div class="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, () => (
        <div class={`skeleton ${c}`} />
      ))}
    </div>
  );
}

/** A timestamp as a <time> element: the absolute time in its title, the relative text inside. */
export function Time({ ts, now }: { ts: Stamp; now: number }): JSX.Element {
  return (
    <time
      data-ts={String(ts ?? "")}
      datetime={String(ts ?? "")}
      title={ts ? new Date(ts).toLocaleString() : ""}
    >
      {timeAgo(ts, now)}
    </time>
  );
}
