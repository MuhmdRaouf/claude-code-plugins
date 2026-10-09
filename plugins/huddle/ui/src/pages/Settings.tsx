// Settings.tsx — the channel's settings: channel (title, description, members, orchestrator),
// turn (start and hand-over rules), repo (path and profile), this browser (theme, notifications,
// filters), the exports, and the connect card (app.js settingsView + startOptions; the extras
// card arrives with the slice that owns it). The notify switch is injected: it is the live
// stream's, and tests hand a fake in.

import { Panel } from "@muhmdraouf/ui/page.tsx";
import type { Stamp } from "@muhmdraouf/ui/time.ts";
import type { ComponentChildren, JSX, RefObject } from "preact";
import { useCallback, useRef, useState } from "preact/hooks";
import { errText, useHuddle } from "../app/context.tsx";
import { currentTheme, setTheme, THEMES, type ThemePref } from "../app/theme.ts";
import { Icon, type IconName } from "../icons.tsx";
import { type ChannelInfo, type HuddleStore, hasOrch } from "../store.ts";
import { ConnectCard } from "./Home.tsx";

/** The notification switch: is it on, and what turning it does (live.ts notifyOn/toggleNotify). */
export type NotifySwitch = { on(): boolean; toggle(): Promise<void> };

/** The config fields the settings read (channel row config; everything else passes through). */
export type SettingsConfig = {
  title?: string;
  description?: string;
  repo?: string;
  profile?: string;
  orchestrator?: unknown;
  members?: string[];
  start?: string;
  handover?: Record<string, unknown>;
  created_at?: Stamp;
} & Record<string, unknown>;

/** The stats line's numbers (channel row stats). */
export type SettingsStats = { events?: number; tasks?: number; knowledge?: number };

/** One settings card: a heading with an icon and the body (app.js settingsView's card). */
function Card({
  title,
  icon,
  children,
}: {
  title: string;
  icon: IconName;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <Panel title={title} label={title} icon={<Icon name={icon} />}>
      {children}
    </Panel>
  );
}

/** The turn's starting options: nobody (work in parallel) or one top-level session; a kept value
 *  that no longer names a session stays listed (app.js startOptions). */
export function startOptions(
  names: readonly string[],
  v: string,
): { value: string; label: string; selected: boolean }[] {
  const n = names.filter((x) => !x.includes("."));
  if (v && !n.includes(v)) n.push(v);
  return [
    { value: "", label: "Nobody: work in parallel", selected: v === "" },
    ...n.map((x) => ({ value: x, label: x, selected: x === v })),
  ];
}

/** The exports a channel serves, as rows (app.js settingsView's Export card). */
const EXPORTS: readonly (readonly [path: string, file: string, what: string])[] = [
  ["/export.md", "export.md", "The plan with your notes, as Markdown"],
  ["/plan.json", "plan.json", "Every task in full"],
  ["/timeline?limit=2000", "timeline.json", "The last 2000 events"],
];

/** The keys "Reset filters" clears, per-viewer settings only (app.js's reset). */
const RESET = /^huddle:(wfilter|wowner|wphase|wq|wview|kbq|kbk|tlf|tls|kmore)/;

/** What one form's save does: build the configure args, say a refusal in the form, save, reload. */
type Save = (err: RefObject<HTMLSpanElement | null>, build: () => Record<string, unknown>) => Promise<void>;

/** The orchestrator field: only there when the channel's config carries the key (hasOrch). */
function OrchField({
  info,
  options,
  current,
}: {
  info: ChannelInfo | null;
  options: string[];
  current: unknown;
}): JSX.Element | null {
  if (!hasOrch(info)) return null;
  return (
    <label class="flex flex-col gap-1.5 text-sm font-medium">
      Orchestrator{" "}
      <select class="input input-sm" id="cf-orch" name="cf-orch" aria-describedby="cf-oh">
        <option value="">None</option>
        {options.map((n) => (
          <option key={n} selected={n === current}>
            {n}
          </option>
        ))}
      </select>
      <span class="text-xs font-normal muted" id="cf-oh">
        The orchestrator plans the work for the others: it imports plans, assigns tasks, and briefs or
        restarts sessions.
      </span>
    </label>
  );
}

/** The channel card: title, description, allowed sessions, orchestrator, and its save
 *  (app.js settingsView's set-ch card). */
function ChannelForm({
  info,
  sessionNames,
  err,
  save,
}: {
  info: ChannelInfo | null;
  sessionNames: string[];
  err: RefObject<HTMLSpanElement | null>;
  save: Save;
}): JSX.Element {
  const c = (info?.config ?? {}) as SettingsConfig;
  const orchOptions = [...new Set([...(c.members ?? []), ...sessionNames])].filter((x) => !x.includes("."));
  return (
    <Card title="Channel" icon="sliders">
      <form
        class="flex flex-col gap-3"
        id="f-ch"
        onSubmit={(e) => {
          e.preventDefault();
          const f = e.currentTarget;
          const orch = f.elements.namedItem("cf-orch");
          void save(err, () => ({
            title: (f.elements.namedItem("cf-title") as HTMLInputElement).value.trim(),
            description: (f.elements.namedItem("cf-desc") as HTMLTextAreaElement).value,
            members: (f.elements.namedItem("cf-members") as HTMLInputElement).value
              .split(/[\s,]+/)
              .filter(Boolean),
            ...(orch ? { orchestrator: (orch as HTMLSelectElement).value || null } : {}),
          }));
        }}
      >
        <label class="flex flex-col gap-1.5 text-sm font-medium">
          Title <input class="input input-sm" id="cf-title" name="cf-title" value={c.title ?? ""} />
        </label>
        <label class="flex flex-col gap-1.5 text-sm font-medium">
          What the team is doing{" "}
          <textarea class="input input-sm" id="cf-desc" name="cf-desc" rows={3}>
            {c.description ?? ""}
          </textarea>
        </label>
        <label class="flex flex-col gap-1.5 text-sm font-medium">
          Allowed sessions{" "}
          <input
            class="input input-sm"
            id="cf-members"
            name="cf-members"
            value={(c.members ?? []).join(", ")}
            placeholder="Any local session"
            aria-describedby="cf-mh"
          />
          <span class="text-xs font-normal muted" id="cf-mh">
            Session names, comma separated. A member's subagents may always join. Leave empty to let any local
            session join.
          </span>
        </label>
        <OrchField info={info} options={orchOptions} current={c.orchestrator} />
        <div class="flex items-center gap-2">
          <button class="btn btn-primary" type="submit">
            Save channel
          </button>
          <span class="err" role="alert" ref={err} />
        </div>
      </form>
    </Card>
  );
}

/** The turn card: who starts with the turn and the hand-over rules as JSON, and its save
 *  (app.js settingsView's set-turn card). */
function TurnForm({
  info,
  sessionNames,
  err,
  save,
}: {
  info: ChannelInfo | null;
  sessionNames: string[];
  err: RefObject<HTMLSpanElement | null>;
  save: Save;
}): JSX.Element {
  const c = (info?.config ?? {}) as SettingsConfig;
  return (
    <Card title="Turn" icon="turn">
      <form
        class="flex flex-col gap-3"
        id="f-turn"
        onSubmit={(e) => {
          e.preventDefault();
          const f = e.currentTarget;
          void save(err, () => {
            let handover: Record<string, unknown>;
            const raw = (f.elements.namedItem("cf-hand") as HTMLTextAreaElement).value;
            try {
              handover = JSON.parse(raw || "{}") as Record<string, unknown>;
            } catch (x) {
              throw new Error(`The hand-over rules are not valid JSON: ${errText(x)}`);
            }
            return { start: (f.elements.namedItem("cf-start") as HTMLSelectElement).value, handover };
          });
        }}
      >
        <p class="text-sm muted">
          For ping-pong work, where only one session acts at a time. Without a turn, sessions work in
          parallel, ordered by task dependencies.
        </p>
        <label class="flex flex-col gap-1.5 text-sm font-medium">
          Starts with the turn{" "}
          <select class="input input-sm" id="cf-start" name="cf-start">
            {startOptions(sessionNames, c.start ?? "").map((o) => (
              <option key={o.value} value={o.value} selected={o.selected}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label class="flex flex-col gap-1.5 text-sm font-medium">
          Hand-over rules{" "}
          <textarea
            class="input input-sm font-mono text-xs"
            id="cf-hand"
            name="cf-hand"
            rows={4}
            spellcheck={false}
            aria-describedby="cf-hh"
          >
            {JSON.stringify(c.handover ?? {}, null, 2)}
          </textarea>
          <span class="text-xs font-normal muted" id="cf-hh">
            JSON: <code>{`{"api": {"to": "web", "topics": ["build.ready"]}}`}</code> passes the turn from api
            to web when api publishes build.ready.
          </span>
        </label>
        <div class="flex items-center gap-2">
          <button class="btn btn-primary" type="submit">
            Save turn
          </button>
          <span class="err" role="alert" ref={err} />
        </div>
      </form>
    </Card>
  );
}

/** The repo card: the folder Huddle reads for the Code, Drift and Diagrams views, and its save
 *  (app.js settingsView's set-repo card). */
function RepoForm({
  info,
  err,
  save,
}: {
  info: ChannelInfo | null;
  err: RefObject<HTMLSpanElement | null>;
  save: Save;
}): JSX.Element {
  const c = (info?.config ?? {}) as SettingsConfig;
  const views = info?.views ?? [];
  return (
    <Card title="Repo" icon="code">
      <form
        class="flex flex-col gap-3"
        id="f-repo"
        onSubmit={(e) => {
          e.preventDefault();
          const f = e.currentTarget;
          void save(err, () => ({
            repo: (f.elements.namedItem("cf-repo") as HTMLInputElement).value.trim(),
            profile: (f.elements.namedItem("cf-profile") as HTMLInputElement).value.trim(),
          }));
        }}
      >
        <label class="flex flex-col gap-1.5 text-sm font-medium">
          Repo path{" "}
          <input
            class="input input-sm font-mono text-xs"
            id="cf-repo"
            name="cf-repo"
            value={c.repo ?? ""}
            placeholder="/absolute/path/to/repo"
            aria-describedby="cf-rh"
          />
          <span class="text-xs font-normal muted" id="cf-rh">
            A folder Huddle can read. It adds Code, Drift and Diagrams under Work.{" "}
            {views.length
              ? `Available now: ${views.join(", ")}.`
              : c.repo
                ? "Huddle cannot read this path."
                : ""}
          </span>
        </label>
        <label class="flex flex-col gap-1.5 text-sm font-medium">
          <span>
            Profile <span class="text-xs font-normal muted">(optional)</span>
          </span>
          <input class="input input-sm" id="cf-profile" name="cf-profile" value={c.profile ?? ""} />
        </label>
        <div class="flex items-center gap-2">
          <button class="btn btn-primary" type="submit">
            Save repo
          </button>
          <span class="err" role="alert" ref={err} />
        </div>
      </form>
    </Card>
  );
}

/** This browser's card: the theme segment, the notification switch and the filter reset
 *  (app.js settingsView's set-br card). */
function BrowserCard({ notify }: { notify: NotifySwitch }): JSX.Element {
  const { toast } = useHuddle();
  const [theme, setThemeState] = useState<ThemePref>(() => currentTheme(localStorage));
  const [notifyOn, setNotifyOn] = useState(notify.on());
  const flip = (): void => {
    void notify.toggle().then(() => setNotifyOn(notify.on()));
  };
  const reset = (): void => {
    try {
      for (const k of Object.keys(localStorage)) if (RESET.test(k)) localStorage.removeItem(k);
    } catch {
      // site data is blocked: nothing to reset
    }
    toast("Filters reset");
  };
  return (
    <Card title="This browser" icon="monitor">
      <div class="flex flex-col gap-4 text-sm">
        <div class="flex flex-wrap items-center gap-3">
          <span class="flex-1" id="th-l">
            Theme
          </span>
          {/* biome-ignore lint/a11y/useSemanticElements: the segment's group role, kept for the tests */}
          <div class="join join-sm" role="group" aria-labelledby="th-l">
            {THEMES.map(([k, l, ic]) => (
              <button
                key={k}
                type="button"
                data-theme-set={k}
                class={`btn join-item btn-sm${theme === k ? " btn-primary" : ""}`}
                aria-pressed={theme === k}
                onClick={() => {
                  setTheme(localStorage, k, window.matchMedia("(prefers-color-scheme: dark)").matches);
                  setThemeState(k);
                }}
              >
                <Icon name={ic} class="size-3.5" />
                {l}
              </button>
            ))}
          </div>
        </div>
        <div class="flex items-center gap-3">
          <span class="flex-1" id="nt-l">
            Notify me when a session asks me something
            <span class="help block">
              {"Notification" in window
                ? `Browser permission: ${Notification.permission}`
                : "This browser cannot show notifications."}
            </span>
          </span>
          <input
            type="checkbox"
            class="toggle"
            role="switch"
            id="set-notif"
            aria-checked={notifyOn}
            aria-labelledby="nt-l"
            checked={notifyOn}
            onClick={flip}
          />
        </div>
        <div class="flex items-center gap-3">
          <span class="flex-1">Filters, drafts and last views stay in this browser.</span>
          <button type="button" class="btn" id="set-reset" onClick={reset}>
            Reset filters
          </button>
        </div>
      </div>
    </Card>
  );
}

/** The channel's settings page. Renders the channel row the store holds — the live stream
 *  refreshes it, and the page re-renders with it; only a save reads the row again, so the forms
 *  never overwrite other people's changes with a stale copy. Saves go through op/configure;
 *  refusals are said in the form they came from. */
export function Settings({
  notify,
  store,
}: {
  notify: NotifySwitch;
  /** The store, when the shell hands it over: a save reads the channel row through it. */
  store?: HuddleStore | undefined;
}): JSX.Element | null {
  const { state, api, toast } = useHuddle();
  const ch = state.ch;
  const info = state.info;
  const errCh = useRef<HTMLSpanElement>(null);
  const errTurn = useRef<HTMLSpanElement>(null);
  const errRepo = useRef<HTMLSpanElement>(null);

  const reload = useCallback((): Promise<void> => store?.loadInfo() ?? Promise.resolve(), [store]);

  if (!ch) return null;

  const save: Save = async (err, build) => {
    if (err.current) err.current.textContent = "";
    let a: Record<string, unknown>;
    try {
      a = build();
    } catch (x) {
      if (err.current) err.current.textContent = errText(x);
      return;
    }
    try {
      await api.op(ch, "configure", a);
      toast("Saved");
      await reload();
    } catch (x) {
      if (err.current) err.current.textContent = errText(x);
    }
  };
  const sessionNames = (state.sessions?.sessions ?? []).map((s) => s.name);

  return (
    <div class="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4">
      <ChannelForm info={info} sessionNames={sessionNames} err={errCh} save={save} />
      <TurnForm info={info} sessionNames={sessionNames} err={errTurn} save={save} />
      <RepoForm info={info} err={errRepo} save={save} />
      <BrowserCard notify={notify} />
      <Card title="Export" icon="download">
        <ul class="flex flex-col">
          {EXPORTS.map(([p, t, d]) => (
            <li key={t}>
              <a
                class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-base-content/10"
                href={api.channelPath(ch, p)}
                target="_blank"
                rel="noopener"
              >
                <Icon name="download" class="size-4 text-base-content/50" />
                <b class="font-mono text-xs">{t}</b>
                <span class="text-xs muted">{d}</span>
              </a>
            </li>
          ))}
        </ul>
      </Card>
      <div id="set-ext" class="flex flex-col gap-4 empty:hidden" />
      <ConnectCard ch={ch} />
    </div>
  );
}
