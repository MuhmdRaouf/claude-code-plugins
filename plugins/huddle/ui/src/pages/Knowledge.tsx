// Knowledge.tsx — the knowledge pages (app.js kbView + kb.js): the list with its search and kind
// filters, the reader for one entry (its marks, its age, Verify and "Share with every channel"),
// and the Markdown export for a project's CLAUDE.md. The newest entry opens by default; the
// "Remember something" form lands with the dialogs slice.

import { Inline, Markdown } from "@muhmdraouf/ui/markdown.tsx";
import type { ComponentChild, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Api } from "../api.ts";
import { errText, type ToastFn, useHuddle } from "../app/context.tsx";
import { IntroActions } from "../app/intro.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { Empty, Time } from "../kit.tsx";
import { readPref, type Storage, writePref } from "../storage.ts";
import type { HuddleStore } from "../store.ts";

/** The kinds an entry can have, in filter order. */
export const KB_KINDS = ["fact", "lesson", "decision", "context", "result", "howto"] as const;

/** One knowledge entry's kind. */
export type KbKind = (typeof KB_KINDS)[number];

/** Kind → icon. */
const KB_I: Record<KbKind, IconName> = {
  fact: "checkc",
  lesson: "alert",
  decision: "flag",
  context: "file",
  result: "sparkle",
  howto: "terminal",
};

/** Kind → word. */
export const KB_L: Record<KbKind, string> = {
  fact: "Fact",
  lesson: "Lesson",
  decision: "Decision",
  context: "Context",
  result: "Result",
  howto: "How-to",
};

/** One knowledge entry, as the list (without the full text it still carries) and the reader see it. */
export type KbEntry = {
  id: number;
  kind: string;
  title: string;
  body: string;
  by: string;
  created_at?: string | null;
  hits?: number;
  task?: string | null;
  supersedes?: number | null;
  superseded_by?: number | null;
  moved_to?: number | null;
  scope?: string | null;
  origin?: string | null;
  verified_at?: string | null;
  verified_by?: string | null;
  stale?: string | null;
  tags?: string[] | null;
  refs?: string[] | null;
  age_days?: number | null;
  hit?: string | null;
};

/** A kind as a violet chip: its icon and word; an unknown kind falls back to the book and itself. */
export function KbTag({ kind }: { kind: string }): JSX.Element {
  const known = (KB_KINDS as readonly string[]).includes(kind) ? (kind as KbKind) : undefined;
  return (
    <span class="badge badge-ghost badge-sm c-lavender">
      <Icon name={known ? KB_I[known] : "book"} class="size-3.5" />
      {known ? KB_L[known] : kind}
    </span>
  );
}

/** How old an entry is, in words; under a day it says nothing (the written time says it). */
export function kbAge(k: { age_days?: number | null | undefined }): string {
  const d = k.age_days;
  return !d ? "" : d === 1 ? "1 day old" : `${d} days old`;
}

/** The small marks beside an entry's kind: verified, for every channel, and why it may be stale. */
export function kbMarks(k: KbEntry): ComponentChild[] {
  const out: ComponentChild[] = [];
  if (k.verified_at)
    out.push(
      <span class="badge badge-sm badge-success" title={`Verified by ${k.verified_by ?? ""}`}>
        Verified
      </span>,
    );
  if (k.scope === "server")
    out.push(
      <span
        class="badge badge-ghost badge-sm c-info"
        title={`${k.origin ? `From channel ${k.origin}; ` : ""}every channel on this server recalls it`}
      >
        <Icon name="layers" class="size-3.5" />
        Every channel
      </span>,
    );
  if (k.stale)
    out.push(
      <span class="badge badge-sm badge-warning" title={k.stale}>
        May be stale
      </span>,
    );
  return out;
}

/** A search hit with the server's «term» markers drawn as <mark>, the way the list highlights. */
export function Hits({ text }: { text?: string | null | undefined }): JSX.Element {
  const parts = String(text ?? "").split(/(«|»)/);
  const out: ComponentChild[] = [];
  let marked: string[] | null = null;
  for (const p of parts) {
    if (p === "«") {
      marked = [];
      continue;
    }
    if (p === "»") {
      if (marked) out.push(<mark>{marked.join("")}</mark>);
      marked = null;
      continue;
    }
    (marked ?? out).push(p);
  }
  if (marked) out.push(marked.join(""));
  return <>{out}</>;
}

/** Saves text as a file download: an object URL the browser is asked to open once. */
export function downloadText(text: string, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** The export menu's actions (kb.js wireExport): copy for CLAUDE.md, copy verified, download.
 *  The shared pop-menu lands in another slice; until then this renders as an inline row. */
export function ExportActions({
  ch,
  md,
  save,
  onDone,
}: {
  ch: string;
  md: (verified: boolean) => Promise<string>;
  save: (text: string, name: string) => void;
  onDone: () => void;
}): JSX.Element {
  const { toast, copy } = useHuddle();
  const run = (p: Promise<string>, f: (t: string) => void): void => {
    p.then(f)
      .catch((e: unknown) => toast(errText(e), { bad: true }))
      .finally(() => onDone());
  };
  return (
    <>
      <button
        type="button"
        class="btn btn-sm"
        role="menuitem"
        onClick={() => run(md(false), (t) => copy(t, "Copied. Paste it into the project's CLAUDE.md."))}
      >
        <Icon name="copy" class="size-3.5" />
        Copy as Markdown for CLAUDE.md
      </button>
      <button
        type="button"
        class="btn btn-sm"
        role="menuitem"
        onClick={() => run(md(true), (t) => copy(t, "Copied the verified entries."))}
      >
        <Icon name="checkc" class="size-3.5" />
        Copy verified entries only
      </button>
      <button
        type="button"
        class="btn btn-sm"
        role="menuitem"
        onClick={() => run(md(false), (t) => save(t, `${ch}-knowledge.md`))}
      >
        <Icon name="download" class="size-3.5" />
        Download .md
      </button>
    </>
  );
}

/** The sentence beside the actions: why it may be stale, who verified it, or that nobody did yet. */
function EntryNote({ k, now }: { k: KbEntry; now: number }): JSX.Element {
  const age = kbAge(k);
  if (k.stale)
    return (
      <p class="flex min-w-0 flex-1 basis-full items-center gap-2 text-sm text-warning sm:basis-auto">
        <Icon name="clock" class="size-4" />
        {`May be stale: ${k.stale}. Check it, then verify it or replace it.`}
      </p>
    );
  if (k.verified_at)
    return (
      <p class="flex min-w-0 flex-1 basis-full items-center gap-2 text-sm muted sm:basis-auto">
        <Icon name="checkc" class="size-4 text-success" />
        {`Verified by ${k.verified_by ?? ""} `}
        <Time ts={k.verified_at} now={now} />
      </p>
    );
  return (
    <p class="min-w-0 flex-1 basis-full text-sm muted sm:basis-auto">
      {age ? `${age[0]?.toUpperCase()}${age.slice(1)}, not verified yet.` : "Not verified yet."}
    </p>
  );
}

/** The reader's row above the body: why it may be stale, who verified it, and the actions. */
function EntryExtras({
  k,
  ch,
  api,
  now,
  go,
  reload,
  toast,
}: {
  k: KbEntry;
  ch: string;
  api: Api;
  now: number;
  go: (href: string) => void;
  /** Reads the entry again where it sits (Verify; a Share that kept the id). */
  reload: () => void;
  toast: ToastFn;
}): JSX.Element {
  const [busy, setBusy] = useState<"" | "v" | "s">("");
  if (k.moved_to)
    return (
      <div class="flex flex-wrap items-center gap-2 border-b hairline px-4 py-3 text-sm sm:px-5">
        <Icon name="layers" class="size-4 text-base-content/50" />
        <span class="muted">This entry is now for every channel:</span>
        <a class="link link-primary" href={api.channelHref(ch, `/knowledge/${k.moved_to}`)}>
          #{k.moved_to}
        </a>
      </div>
    );
  const undo = !!(k.verified_at && !k.stale);
  const verify = (): void => {
    setBusy("v");
    api
      .op(ch, "verify", { id: k.id, undo })
      .then(() => {
        toast(undo ? "No longer verified" : "Verified");
        reload();
      })
      .catch((e: unknown) => {
        toast(errText(e), { bad: true });
        setBusy("");
      });
  };
  const share = (): void => {
    setBusy("s");
    api
      .op(ch, "share", { id: k.id })
      .then((r) => {
        const id = (r as { result?: { id?: number } }).result?.id;
        toast(`Every channel on this server now recalls it (#${id})`);
        // a share that minted a new entry moves there; one that kept the id reads it again
        if (id && id !== k.id) go(api.channelHref(ch, `/knowledge/${id}`));
        else reload();
      })
      .catch((e: unknown) => {
        toast(errText(e), { bad: true });
        setBusy("");
      });
  };
  return (
    <div class="flex flex-wrap items-center gap-2 border-b hairline px-4 py-3 sm:px-5">
      <EntryNote k={k} now={now} />
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="btn btn-sm"
          data-kbv={undo ? "undo" : "do"}
          disabled={busy === "v"}
          onClick={verify}
        >
          <Icon name={undo ? "undo" : "checkc"} class="size-3.5" />
          {undo ? "Unverify" : "Verify"}
        </button>
        {k.scope === "server" ? null : (
          <button type="button" class="btn btn-sm" data-kbs disabled={busy === "s"} onClick={share}>
            <Icon name="layers" class="size-3.5" />
            Share with every channel
          </button>
        )}
      </div>
    </div>
  );
}

/** The reader for one entry: its marks, its history line, its body and its references. */
function EntryView({
  k,
  ch,
  api,
  now,
  go,
  reload,
  toast,
}: {
  k: KbEntry;
  ch: string;
  api: Api;
  now: number;
  go: (href: string) => void;
  reload: () => void;
  toast: ToastFn;
}): JSX.Element {
  const taskHref = k.task ? api.channelHref(ch, `/work?t=${encodeURIComponent(k.task)}`) : "";
  return (
    <article class="panel overflow-hidden">
      <div class="flex flex-col gap-2 border-b hairline p-5">
        <a class="btn btn-ghost btn-sm -ml-2 w-fit lg:hidden" href={api.channelHref(ch, "/knowledge")}>
          <Icon name="left" class="size-3.5" />
          All entries
        </a>
        <div class="flex flex-wrap items-center gap-2">
          <KbTag kind={k.kind} />
          {kbMarks(k)}
          {k.superseded_by ? (
            <a
              class="badge badge-sm badge-warning"
              href={api.channelHref(ch, `/knowledge/${k.superseded_by}`)}
            >
              {`Replaced by #${k.superseded_by}`}
            </a>
          ) : null}
        </div>
        <h2 class="text-lg font-semibold">{k.title}</h2>
        <div class="text-xs muted">
          {`By ${k.by} · `}
          <Time ts={k.created_at} now={now} />
          {` · read ${k.hits} time${k.hits === 1 ? "" : "s"}`}
          {k.task ? (
            <>
              {` · task `}
              <a class="link link-primary font-mono" href={taskHref}>
                {k.task}
              </a>
            </>
          ) : null}
          {k.supersedes ? (
            <>
              {` · replaces `}
              <a class="link link-primary" href={api.channelHref(ch, `/knowledge/${k.supersedes}`)}>
                {`#${k.supersedes}`}
              </a>
            </>
          ) : null}
        </div>
        {k.tags?.length ? (
          <div class="flex flex-wrap gap-1">
            {k.tags.map((t) => (
              <span key={t} class="badge badge-ghost badge-sm">
                {t}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <EntryExtras k={k} ch={ch} api={api} now={now} go={go} reload={reload} toast={toast} />
      <div class="p-5">
        <Markdown text={k.body} />
      </div>
      {k.refs?.length ? (
        <div class="flex flex-wrap items-center gap-1.5 border-t hairline p-5">
          <span class="text-xs font-medium text-base-content/50 mr-1">References</span>
          {k.refs.map((r) => (
            <span key={r} class="badge badge-ghost badge-sm">
              <Inline text={r} />
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

/** The kind filter: All, then one chip per kind, the pressed one marked. */
function KindChips({ kind, pick }: { kind: string; pick: (k: string) => void }): JSX.Element {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the legacy kind group's markup, kept word for word
    <div class="flex flex-wrap gap-1.5" role="group" aria-label="Kind">
      <button
        type="button"
        class={`btn btn-sm rounded-full${kind ? "" : " btn-primary"}`}
        data-k=""
        aria-pressed={!kind}
        onClick={() => pick("")}
      >
        All
      </button>
      {KB_KINDS.map((k) => (
        <button
          type="button"
          key={k}
          class={`btn btn-sm rounded-full${kind === k ? " btn-primary" : ""}`}
          data-k={k}
          aria-pressed={kind === k}
          onClick={() => pick(k)}
        >
          <Icon name={KB_I[k]} class="size-3.5" />
          {KB_L[k]}
        </button>
      ))}
    </div>
  );
}

/** The Knowledge page: search and kind filters on the left, the newest (or asked-for) entry on
 *  the right, and the Markdown export in the header. `id` is the entry the route names, if any. */
export function Knowledge({
  id,
  prefs = localStorage,
  store,
}: {
  id?: number | undefined;
  prefs?: Storage | undefined;
  /** The store, when the shell hands it over: the sessions' remember and share events refresh
   *  the list and the open entry live. */
  store?: HuddleStore | undefined;
} = {}): JSX.Element | null {
  const { state, api, now, go, toast } = useHuddle();
  const ch = state.ch;
  const [q, setQ] = useState<string>(() => readPref(prefs, ch ? `kbq:${ch}` : "kbq", ""));
  const [kind, setKind] = useState<string>(() => readPref(prefs, ch ? `kbk:${ch}` : "kbk", ""));
  const [list, setList] = useState<KbEntry[]>([]);
  const [entry, setEntry] = useState<KbEntry | null | undefined>(undefined);
  const [expOpen, setExpOpen] = useState(false);
  const [tick, setTick] = useState(0);
  // another channel keeps its own search and kind (Team.tsx's filter effect)
  useEffect(() => {
    setQ(readPref(prefs, ch ? `kbq:${ch}` : "kbq", ""));
    setKind(readPref(prefs, ch ? `kbk:${ch}` : "kbk", ""));
  }, [prefs, ch]);
  const needle = q.trim();
  const current = id ?? list[0]?.id ?? null;
  const deep = id !== undefined;
  useEffect(() => {
    if (!ch) return undefined;
    let alive = true;
    const load = (): void => {
      api
        .api(
          api.channelPath(
            ch,
            `/kb?q=${encodeURIComponent(needle)}&kind=${encodeURIComponent(kind)}&limit=50`,
          ),
        )
        .then((l) => {
          if (alive) setList((l as KbEntry[]) ?? []);
        })
        .catch(() => {
          if (alive) setList([]);
        });
    };
    load();
    // the sessions' remember and share events say "kb": read the list again
    const un = store?.subscribe((what) => {
      if (what === "kb") load();
    });
    return () => {
      alive = false;
      un?.();
    };
  }, [api, ch, needle, kind, store]);
  useEffect(() => {
    if (!ch || current === null) {
      setEntry(null);
      return undefined;
    }
    let alive = true;
    let first = true;
    const load = (): void => {
      if (first) setEntry(undefined);
      first = false;
      api
        .api(api.channelPath(ch, `/kb/${current}`))
        .then((k) => {
          if (alive) setEntry((k as KbEntry | null) ?? null);
        })
        .catch(() => {
          if (alive) setEntry(null);
        });
    };
    load();
    // a remember that touches the open entry, and a Verify or Share, read it again
    const un = store?.subscribe((what) => {
      if (what === "kb") load();
    });
    return () => {
      alive = false;
      un?.();
    };
  }, [api, ch, current, tick, store]);
  if (!ch) return null;
  const reload = (): void => setTick((n) => n + 1);
  const entryHref = (n: number): string => api.channelHref(ch, `/knowledge/${n}`);
  const onSearch = (value: string): void => {
    setQ(value);
    writePref(prefs, `kbq:${ch}`, value.trim());
  };
  const pickKind = (k: string): void => {
    setKind(k);
    writePref(prefs, `kbk:${ch}`, k);
  };
  const md = (verified: boolean): Promise<string> =>
    api.api(api.channelPath(ch, `/knowledge.md${verified ? "?verified=1" : ""}`)).then((t) => String(t));
  return (
    <div class="flex min-w-0 flex-col gap-5">
      <IntroActions>
        <div>
          <button
            type="button"
            class="btn"
            id="kbexp"
            aria-haspopup="menu"
            aria-expanded={expOpen}
            onClick={() => setExpOpen(!expOpen)}
          >
            <Icon name="download" class="size-4" /> Export
          </button>
          {expOpen ? (
            <div class="mt-2 flex flex-wrap gap-2" role="menu" aria-label="Export knowledge">
              <ExportActions ch={ch} md={md} save={downloadText} onDone={() => setExpOpen(false)} />
            </div>
          ) : null}
        </div>
      </IntroActions>
      <div class="grid items-start gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <section class={`${deep ? "max-lg:hidden " : ""}flex min-w-0 flex-col gap-3`} aria-labelledby="kb-h">
          <div class="relative">
            <span class="pointer-events-none absolute top-2 left-2.5 text-base-content/50">
              <Icon name="search" />
            </span>
            <input
              id="kbq"
              class="input input-sm pl-8"
              type="search"
              placeholder="Search what the sessions learned"
              aria-label="Search knowledge"
              value={q}
              onInput={(e) => onSearch(e.currentTarget.value)}
            />
          </div>
          <KindChips kind={kind} pick={pickKind} />
          <ul
            id="kblist"
            class="panel flex flex-col divide-y divide-base-content/10 overflow-hidden"
            aria-label="Entries"
          >
            {list.length ? (
              list.map((k) => {
                const marks = kbMarks(k);
                return (
                  <li key={k.id}>
                    <a
                      class="block px-4 py-3 transition-colors hover:bg-base-content/10 aria-[current=page]:bg-base-content/10"
                      href={entryHref(k.id)}
                      aria-current={k.id === current ? "page" : undefined}
                    >
                      <div class="flex items-center gap-2">
                        <KbTag kind={k.kind} />
                        <b class="truncate text-sm font-medium">{k.title}</b>
                      </div>
                      {marks.length ? <div class="mt-1 flex flex-wrap gap-1">{marks}</div> : null}
                      <div class="hit mt-1 line-clamp-2 text-xs muted">
                        <Hits text={k.hit} />
                      </div>
                      <div class="mt-1 text-xs text-base-content/50">
                        {`${k.by} · `}
                        <Time ts={k.created_at} now={now} />
                        {kbAge(k) ? ` · ${kbAge(k)}` : ""}
                        {k.tags?.length ? ` · ${k.tags.join(", ")}` : ""}
                      </div>
                    </a>
                  </li>
                );
              })
            ) : (
              <li>
                <Empty text="No entry matches" hint="Try other words or another kind." />
              </li>
            )}
          </ul>
        </section>
        <section id="kbr" class={`${deep ? "" : "max-lg:hidden "}min-w-0`} aria-label="Entry">
          {entry === undefined ? null : entry ? (
            <EntryView k={entry} ch={ch} api={api} now={now} go={go} reload={reload} toast={toast} />
          ) : (
            <Empty
              text="Nothing remembered yet"
              hint="Sessions call remember when they learn something the others should not pay for again."
              icon="book"
            />
          )}
        </section>
      </div>
    </div>
  );
}
