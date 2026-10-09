/**
 * The shared vocabulary every panel is built from: the shared `panel` surface with its titled head,
 * badges, status dots, model chips, segmented controls and empty states. Colour arrives only as semantic
 * tokens; the pieces other views style from legacy.css keep their class hooks.
 */

import { modelColor } from "@muhmdraouf/ui/model-color.ts";
import { type PanelProps, Panel as SharedPanel } from "@muhmdraouf/ui/page.tsx";
import type { ComponentChildren, HTMLAttributes } from "preact";
import type { IconName } from "../icons.ts";
import { STATUS_COLOR, type StatusTone } from "../palette.ts";
import { useApp } from "./context.ts";
import { Icon } from "./Icon.tsx";

/** The chrome every panel shares: the shared panel surface, clipped content and room to breathe. */
export const PANEL = "panel min-w-0";

/** A status dot; `pulse` marks something live. Always sits next to a word, never alone. */
export function Dot({ tone, pulse = false }: { tone: StatusTone; pulse?: boolean }) {
  return (
    <span class={pulse ? "dot dot-pulse" : "dot"} style={`--tone:${STATUS_COLOR[tone]}`} aria-hidden="true" />
  );
}

/** Dot + word, coloured by tone (the word carries the meaning for anyone who cannot see the colour).
 *  The class is `presence`, not daisyUI's `status`: that name is a fixed-size dot component here, and
 *  reusing it squeezed the dot and its word into 0.5rem until the word clipped mid-letter. */
export function Status({ tone, word, pulse = false }: { tone: StatusTone; word: string; pulse?: boolean }) {
  return (
    <span class={`presence presence-${tone}`}>
      <Dot tone={tone} pulse={pulse} />
      <span class="presence-word">{word}</span>
    </span>
  );
}

/** A tinted pill: tone colours its text, border and a faint fill. */
export function Badge({ text, tone, icon }: { text: string; tone: StatusTone; icon?: IconName }) {
  return (
    <span class={`badge badge-${tone}`}>
      {icon !== undefined && <Icon name={icon} class="icon icon-xs" />}
      <span>{text}</span>
    </span>
  );
}

/** The short name a model is read by: never a raw id like claude-opus-5-5 when "Opus 5.5" says it. */
export function shortModelName(model: string): string {
  const s = model.toLowerCase().replace(/^[a-z]+:/, "");
  const claude = /(?:^|\b)claude[- ](opus|sonnet|haiku|fable)[- ](\d+)(?:[-.](\d{1,2}))?(?:\b|$)/.exec(s);
  if (claude !== null) {
    const family = `${claude[1]?.charAt(0).toUpperCase()}${claude[1]?.slice(1)}`;
    return claude[3] === undefined ? `${family} ${claude[2]}` : `${family} ${claude[2]}.${claude[3]}`;
  }
  const glm = /^glm-(\d+(?:\.\d+)?)(?:-(\w+))?/.exec(s);
  if (glm !== null) {
    const tier = glm[2] === undefined ? "" : ` ${glm[2].charAt(0).toUpperCase()}${glm[2].slice(1)}`;
    return `GLM ${glm[1]}${tier}`;
  }
  return model;
}

/** A model as its colour dot (modelColor, one palette everywhere) plus the short name; the raw id hovers. */
export function ModelChip({ model }: { model: string }) {
  return (
    <span class="model-chip inline-flex items-center gap-1.5 whitespace-nowrap" title={model}>
      <span class="dot" style={`--tone:${modelColor(model)}`} aria-hidden="true" />
      <span>{shortModelName(model)}</span>
    </span>
  );
}

/** An icon in a softly tinted rounded square; `color` is a palette token, `sm` the compact row size. */
export function IconTile({ name, color, sm = false }: { name: IconName; color: string; sm?: boolean }) {
  return (
    <span
      class={
        sm
          ? "inline-grid size-[26px] shrink-0 place-items-center rounded-[7px]"
          : "inline-grid size-8 shrink-0 place-items-center rounded-field"
      }
      style={`--tone:${color};color:var(--tone);background:color-mix(in srgb, var(--tone) 16%, transparent)`}
    >
      <Icon name={name} />
    </span>
  );
}

/** The head row of a panel: icon, title, an optional quiet subtitle, and right-aligned controls — the
 *  same head the shared PageIntro Panel draws, for the panels that compose their own body. */
export function CardHead({
  icon,
  title,
  subtitle = null,
  children,
}: {
  icon?: IconName | undefined;
  title: string;
  subtitle?: string | null;
  /** the controls on the right */
  children?: ComponentChildren;
}) {
  return (
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-base-content/8 px-5 py-3.5">
      <div class="flex min-w-0 flex-1 items-center gap-2.5">
        {icon !== undefined && (
          <span class="text-primary [&_svg]:size-4.5" aria-hidden="true">
            <Icon name={icon} />
          </span>
        )}
        <h2 class="truncate text-base font-semibold">{title}</h2>
        {subtitle !== null && <span class="shrink-0 text-sm text-base-content/60">{subtitle}</span>}
      </div>
      {children != null && children !== false && (
        <div class="flex flex-wrap items-center gap-2">{children}</div>
      )}
    </div>
  );
}

/** A panel: the shared panel surface with its titled head; pass no title for a headless panel. */
export function Panel({
  icon,
  title,
  subtitle = null,
  actions = null,
  flush = false,
  class: cls = "",
  children,
}: {
  icon?: IconName | undefined;
  title?: string;
  subtitle?: string | null;
  /** the controls on the right of the head */
  actions?: ComponentChildren;
  /** flush bodies (tables, lists) run edge to edge; the default pads the body */
  flush?: boolean;
  class?: string;
  children?: ComponentChildren;
}) {
  const props: PanelProps = {
    title: title === undefined ? undefined : title,
    meta: subtitle === null ? undefined : subtitle,
    icon: icon === undefined ? undefined : <Icon name={icon} />,
    actions: actions === null ? undefined : actions,
    flush,
    class: cls,
    children,
  };
  return <SharedPanel {...props} />;
}

export type Segment = { label: string; value: string; on: boolean; count?: string };

/** A segmented control: one daisyUI join of toggle buttons that all run the same action with their own value. */
export function Segmented({
  action,
  label,
  segments,
}: {
  action: string;
  label: string;
  segments: Segment[];
}) {
  const { act } = useApp();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar of toggles, not a form; a fieldset would bring its own border and legend
    <div class="segmented join" role="group" aria-label={label}>
      {segments.map((segment) => (
        <button
          key={segment.value}
          type="button"
          class={
            segment.on
              ? "segment segment-on btn btn-sm btn-soft btn-primary join-item"
              : "segment btn btn-sm btn-ghost join-item"
          }
          data-action={action}
          data-value={segment.value}
          aria-pressed={segment.on ? "true" : "false"}
          onClick={() => act(action, segment.value)}
        >
          <span>{segment.label}</span>
          {segment.count !== undefined && (
            <span class="segment-count badge badge-sm badge-ghost num">{segment.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** An empty state that says what is missing, what makes it appear, and the one verb that gets there. */
export function EmptyState({
  title,
  hint,
  icon = "inbox",
  action,
}: {
  title: string;
  hint: string;
  icon?: IconName;
  /** the one verb button, when the view has somewhere to go */
  action?: { label: string; run: () => void };
}) {
  return (
    <div class="empty flex flex-col items-center gap-1.5 px-6 py-12 text-center">
      <span class="empty-icon">
        <Icon name={icon} />
      </span>
      <p class="empty-title">{title}</p>
      <p class="empty-hint">{hint}</p>
      {action !== undefined && (
        <button type="button" class="btn btn-sm mt-2" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/** A labelled value inside a panel or drawer. */
export function Field({ label, value, code = false }: { label: string; value: string; code?: boolean }) {
  return (
    <div class="field">
      <span class="field-label">{label}</span>
      <span class={code ? "field-value code" : "field-value"}>{value}</span>
    </div>
  );
}

/** Inline code-ish text (model ids, hosts, session ids): the only place the monospace face appears. */
export function Code({
  text,
  class: cls = "",
  ...rest
}: { text: string; class?: string } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span class={cls === "" ? "code font-mono" : `code font-mono ${cls}`} {...rest}>
      {text}
    </span>
  );
}
