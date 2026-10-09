/**
 * The dashboard's one time-range control: a dropdown button naming the range in words, the presets, a custom
 * From/To fieldset with its Apply validation, the auto-refresh choice (only while the range is open-ended) and
 * a "Copy link" that freezes a relative range into the URL. Pure `act` dispatches, so any header can mount it.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { PRESETS, type Preset, rangeLabel, rangeToHash, resolveRange } from "../../shared/time-range.ts";
import { REFRESH_CHOICES } from "../state.ts";
import { useApp } from "./context.ts";
import { Icon } from "./Icon.tsx";

/** The picker's word for an auto-refresh cadence. */
function refreshLabel(ms: number): string {
  if (ms === 0) return "Auto: off";
  if (ms < 60_000) return `Auto: ${ms / 1000} s`;
  return `Auto: ${ms / 60_000} min`;
}

/** A datetime-local input's value for a timestamp: local `YYYY-MM-DDTHH:MM`, "" while it means now. */
function inputOf(ts: number | null): string {
  if (ts === null) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = new Date(ts);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** A datetime-local input's value as epoch ms; "" reads as open-ended (null), junk as NaN. */
function msOf(value: string): number | null {
  return value === "" ? null : new Date(value).getTime();
}

export function TimeRange() {
  const { state, now, act } = useApp();
  const [open, setOpen] = useState(false);
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const range = state.range;
  const endsNow = range.to === null;

  /** While open, a click or an Escape anywhere outside the panel closes it (Escape inside too). */
  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setOpen(false);
        return;
      }
      if (event.target instanceof Node && box.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  /** Open (or close) the panel; opening seeds the fieldset with the window on screen, so Apply tweaks it. */
  const toggle = (next: boolean): void => {
    setOpen(next);
    if (!next) return;
    const resolved = resolveRange(range, now);
    setFromText(inputOf(resolved.from));
    setToText(inputOf(range.to));
  };

  const pickPreset = (key: Preset): void => {
    act("range", key);
    setOpen(false);
  };

  const fromMs = msOf(fromText);
  const toMs = msOf(toText);
  const problem =
    Number.isNaN(fromMs) || Number.isNaN(toMs)
      ? "Enter a valid date and time."
      : fromMs !== null && toMs !== null && fromMs >= toMs
        ? "From must be before To."
        : null;

  const apply = (): void => {
    if (fromMs === null || problem !== null) return;
    act("range-custom", rangeToHash({ preset: null, from: fromMs, to: toMs }));
    setOpen(false);
  };

  return (
    <div class="dropdown dropdown-end" ref={box} data-time-range="">
      <button
        type="button"
        class="btn"
        aria-expanded={open ? "true" : "false"}
        aria-haspopup="true"
        onClick={() => toggle(!open)}
      >
        <Icon name="clock" class="size-4.5" />
        <span>{rangeLabel(range, now)}</span>
      </button>
      {open && (
        <div class="dropdown-content z-50 mt-2 w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow-xl">
          <ul class="menu menu-sm grid grid-cols-2 gap-x-2 p-0" aria-label="Time range presets">
            {PRESETS.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  class={range.preset === entry.key ? "menu-active" : ""}
                  onClick={() => pickPreset(entry.key)}
                >
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
          <div class="my-2 border-t border-base-300" />
          <fieldset class="fieldset p-1">
            <legend class="fieldset-legend">Custom range</legend>
            <label class="label" for="range-from">
              From
            </label>
            <input
              id="range-from"
              type="datetime-local"
              class="input w-full"
              aria-label="Custom range from"
              value={fromText}
              onInput={(event) => setFromText(event.currentTarget.value)}
            />
            <label class="label" for="range-to">
              To
            </label>
            <input
              id="range-to"
              type="datetime-local"
              class="input w-full"
              placeholder="now"
              aria-label="Custom range to"
              value={toText}
              onInput={(event) => setToText(event.currentTarget.value)}
            />
            {problem !== null && <p class="label text-error">{problem}</p>}
            <button
              type="button"
              class="btn btn-primary mt-1"
              disabled={fromMs === null || problem !== null}
              onClick={apply}
            >
              Apply
            </button>
          </fieldset>
          <div class="mt-2 flex items-center justify-between gap-2 border-t border-base-300 pt-2">
            <span
              class="tooltip"
              data-tip={endsNow ? undefined : "Auto refresh needs a range that ends at now"}
            >
              <select
                class="select"
                aria-label="Auto refresh"
                disabled={!endsNow}
                value={String(state.refresh)}
                onChange={(event) => act("auto-refresh", event.currentTarget.value)}
              >
                {REFRESH_CHOICES.map((ms) => (
                  <option key={ms} value={String(ms)}>
                    {refreshLabel(ms)}
                  </option>
                ))}
              </select>
            </span>
            <button type="button" class="btn btn-ghost" onClick={() => act("range-copy")}>
              <Icon name="copy" class="size-4.5" />
              Copy link
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
