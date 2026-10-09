// page.tsx — the two frames every Radar and Huddle page is built from, so both dashboards read the same:
// PageIntro opens a page (a glowing icon tile, the title, one plain sentence on what the page shows and what
// to do with it, and the page's own actions on the right), and Panel holds one block of content (a header
// with title, count and actions over a body that is padded, or flush for a table).

import type { ComponentChildren, JSX } from "preact";

/** What a page intro shows: the page's icon, its title, what to expect from it, and its actions. */
export type PageIntroProps = {
  icon: ComponentChildren;
  title: ComponentChildren;
  /** One or two plain sentences: what this page shows and what the reader can do here. */
  description: ComponentChildren;
  /** Buttons, filters or a range picker that act on the whole page. */
  actions?: ComponentChildren;
};

/** The top of a page: icon tile, title and description on the left, the page's actions on the right. */
export function PageIntro({ icon, title, description, actions }: PageIntroProps): JSX.Element {
  return (
    <header class="mb-5 flex flex-wrap items-start gap-x-6 gap-y-3" data-page-intro>
      <div class="flex min-w-0 flex-1 items-start gap-4">
        <span
          class="neon-tile grid size-11 shrink-0 place-items-center rounded-box [&_svg]:size-5.5"
          aria-hidden="true"
        >
          {icon}
        </span>
        <div class="min-w-0">
          <h1 class="text-2xl font-semibold leading-tight tracking-tight">{title}</h1>
          <p class="mt-1 max-w-[72ch] text-[0.9375rem] leading-snug text-base-content/65">{description}</p>
        </div>
      </div>
      {actions ? <div class="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** What a panel holds: an optional header (title, a count or note beside it, actions) and its body. */
export type PanelProps = {
  title?: ComponentChildren;
  /** A count or short note after the title, muted. */
  meta?: ComponentChildren;
  icon?: ComponentChildren;
  actions?: ComponentChildren;
  /** Flush bodies (tables, lists) run edge to edge; the default pads the body. */
  flush?: boolean;
  class?: string;
  /** Accessible name when the panel has no visible title. */
  label?: string;
  children: ComponentChildren;
};

/** One block of content on the shared panel surface. A flush panel clips its table to the rounded corners. */
export function Panel({
  title,
  meta,
  icon,
  actions,
  flush = false,
  class: c = "",
  label,
  children,
}: PanelProps): JSX.Element {
  const head = title !== undefined || actions !== undefined;
  return (
    <section class={`panel min-w-0 ${flush ? "overflow-hidden" : ""} ${c}`.trim()} aria-label={label}>
      {head ? (
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-base-content/8 px-5 py-3.5">
          <div class="flex min-w-0 flex-1 items-center gap-2.5">
            {icon ? (
              <span class="text-primary [&_svg]:size-4.5" aria-hidden="true">
                {icon}
              </span>
            ) : null}
            {title !== undefined ? <h2 class="truncate text-base font-semibold">{title}</h2> : null}
            {meta !== undefined ? <span class="shrink-0 text-sm text-base-content/60">{meta}</span> : null}
          </div>
          {actions ? <div class="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div class={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}
