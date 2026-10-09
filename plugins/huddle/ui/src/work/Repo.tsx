// Repo.tsx — the repo views: the channel's code tree, the drift report (every snippet a task
// quotes, checked against the file now), the PNG diagrams, and any view a local extension
// serves (Markdown reports, tables of rows, plain JSON). The view chips come from the channel's
// declared views; a path under Code browses the tree, a name under Diagrams picks the picture.
// Port of work.js RNAMES/repoView/codeHref/box/repoCode/repoDrift/repoDiagrams/repoGeneric.

import { highlight, langOf, type TokenKind } from "@muhmdraouf/ui/code.tsx";
import { Markdown } from "@muhmdraouf/ui/markdown.tsx";
import { Panel } from "@muhmdraouf/ui/page.tsx";
import type { Stamp } from "@muhmdraouf/ui/time.ts";
import type { ComponentChild, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Api } from "../api.ts";
import { errText } from "../app/context.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { Empty, Pill, Skeleton, StatusIcon, Time } from "../kit.tsx";
import type { PlanStep } from "../store.ts";
import { stepState, taskHref } from "./model.ts";

// ── the wire shapes the repo routes answer with ──────────────────────────────

/** One row of a tree listing. */
export type RepoEntry = { path: string; name: string; dir?: boolean | undefined };

/** GET /repo/tree: a folder's entries, or a file's flag with its folder's README. */
export type RepoTree = { entries?: RepoEntry[]; file?: boolean; readme?: string; error?: string };

/** GET /repo/file: a file's text with the total line count, or its binary size. */
export type RepoFile = { text?: string; total?: number; size?: number; binary?: boolean; error?: string };

/** One task that touches a path (GET /repo/refs). */
export type RepoRef = { id: string; title?: string };

/** One drift row: how a task's quoted snippet compares to the file now (GET /repo/drift). */
export type DriftRow = { state: string; step: string; path?: string; score?: number | null };

/** GET /repo/drift: the rows and when they were last checked. */
export type DriftReply = { rows?: DriftRow[]; at?: Stamp };

// ── the pure half: names, picks, orders, cells ───────────────────────────────

/** The built-in views' words; an extension's view capitalises itself. */
const RNAMES: Record<string, string> = { code: "Code", drift: "Drift", diagrams: "Diagrams" };

/** A view's chip word: the built-in's name, or the extension's own, capitalised. */
export function repoLabel(k: string): string {
  return RNAMES[k] ?? (k ? `${k.charAt(0).toUpperCase()}${k.slice(1)}` : k);
}

/** Which view the route names and the path under it: a declared view wins, else the first one
 *  serves, and only a route that named the serving view carries a path (work.js repoView). */
export function repoPick(
  views: readonly string[],
  parts: readonly string[],
): { view: string | null; rest: string } {
  const first = parts[0];
  if (first !== undefined && views.includes(first)) return { view: first, rest: parts.slice(1).join("/") };
  return { view: views[0] ?? null, rest: "" };
}

/** A repo path's link: Code carrying the path, one part per address segment. */
export const codeHref = (ch: string, p: string): string =>
  `#/c/${ch}/work/repo/code/${p.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;

/** A repo view's link. */
export const viewHref = (ch: string, v: string, rest = ""): string =>
  `#/c/${ch}/work/repo/${v}${rest ? `/${rest}` : ""}`;

/** The drift table's order: the rows that no longer match first, the matching ones after. */
export const driftOrdered = (rows: readonly DriftRow[]): DriftRow[] => [
  ...rows.filter((r) => r.state !== "ok"),
  ...rows.filter((r) => r.state === "ok"),
];

/** A drift state as a status pill: its tone and its word. */
export function driftPill(state: string): { status: string; label: string } {
  if (state === "ok") return { status: "done", label: "Matches" };
  if (state === "partial") return { status: "doing", label: "Partly changed" };
  return { status: "blocked", label: state === "missing" ? "File missing" : "Changed" };
}

/** Is this reply one Markdown document per row? An empty one still is — it says so. */
export const isMdDocs = (r: unknown): r is { md: string }[] =>
  Array.isArray(r) && r.every((x) => !!x && typeof x === "object" && typeof x.md === "string");

/** Is this reply a table of row objects? */
export const isRows = (r: unknown): r is Record<string, unknown>[] =>
  Array.isArray(r) && r.length > 0 && r.every((x) => !!x && typeof x === "object");

/** The columns a table shows: the rows' keys in first-seen order, eight at most. */
export function tableKeys(rows: readonly Record<string, unknown>[]): string[] {
  return [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 8);
}

/** One table cell: arrays join, objects clip, scalars go through inline Markdown. */
export function cellNode(x: unknown): ComponentChild {
  if (x === null || x === undefined) return "";
  if (Array.isArray(x)) {
    return x.every((y) => typeof y !== "object") ? x.map((y) => String(y)).join(", ") : `${x.length}`;
  }
  if (typeof x === "object") return JSON.stringify(x).slice(0, 120);
  return <Markdown text={String(x)} />;
}

// ── the shared frame ─────────────────────────────────────────────────────────

/** A token's colour in a code mockup: the hues the theme scopes per palette. */
const TOKEN_CLASS: Record<TokenKind, string> = {
  kw: "text-[var(--hue-mauve)]",
  str: "text-[var(--hue-green)]",
  num: "text-[var(--hue-peach)]",
  com: "text-base-content/50 italic",
  key: "text-[var(--hue-blue)]",
  param: "text-[var(--hue-teal)]",
};

/** A file's text as a daisyUI code mockup: line numbers down the left, the offline highlighter's
 *  tokens over them. */
export function MockupCode({ text, lang }: { text: string; lang: string }): JSX.Element {
  return (
    <div class="mockup-code before:hidden rounded-none font-mono text-xs">
      {highlight(text, lang).map((toks, i) => (
        <pre key={i} data-prefix={String(i + 1)}>
          <code>
            {toks.map((t, j) =>
              t.kind ? (
                <span key={j} class={TOKEN_CLASS[t.kind]}>
                  {t.text}
                </span>
              ) : (
                t.text
              ),
            )}
          </code>
        </pre>
      ))}
    </div>
  );
}

/** A titled card: an icon and the title in a head row, the body under it, flush bodies touching
 *  the edges (tables, code). The shared Panel is the surface; this only spells its icon. Port of
 *  work.js box. */
export function Box({
  title,
  icon,
  right,
  flush = false,
  children,
}: {
  title: ComponentChild;
  icon: IconName;
  right?: ComponentChild | undefined;
  flush?: boolean | undefined;
  children: ComponentChild;
}): JSX.Element {
  return (
    <Panel
      title={title}
      icon={<Icon name={icon} class="size-4.5" />}
      actions={right}
      flush={flush}
      {...(typeof title === "string" ? { label: title } : {})}
    >
      {children}
    </Panel>
  );
}

/** What every repo view reads: the channel, the services, and the tasks for their chips. */
export type RepoProps = {
  ch: string;
  api: Api;
  /** The current time, for the drift report's checked stamp. */
  now: number;
  /** The route's parts under "repo": the view, then its path. */
  parts: readonly string[];
  /** The views the server serves; empty when the channel has no repo. */
  views: readonly string[];
  /** The repo the channel is pointed at, shown beside the chips. */
  repoPath?: string | undefined;
  /** The board's steps by id, for the tasks that touch a path. */
  byId: Map<string, PlanStep>;
  /** Opens a task's drawer. */
  onOpenTask: (id: string) => void;
};

/** The repo shell: the view chips and the repo path, then the view itself. */
export function Repo(props: RepoProps): JSX.Element {
  const { ch, views, parts } = props;
  const pick = repoPick(views, parts);
  const shared = {
    ch: props.ch,
    api: props.api,
    now: props.now,
    byId: props.byId,
    onOpenTask: props.onOpenTask,
  };
  return (
    <div class="flex min-w-0 flex-col gap-5">
      <nav class="flex flex-wrap items-center gap-3" aria-label="Repo views">
        {/* biome-ignore lint/a11y/useSemanticElements: the view switch's group role */}
        <div class="join" role="group" aria-label="Repo view">
          {views.map((k) => (
            <a
              key={k}
              class={`btn join-item btn-sm${k === pick.view ? " btn-primary" : ""}`}
              href={viewHref(ch, k)}
              aria-current={k === pick.view ? "page" : undefined}
            >
              {repoLabel(k)}
            </a>
          ))}
        </div>
        <span class="flex-1" />
        <code class="hidden truncate text-meta muted lg:block">{props.repoPath ?? ""}</code>
      </nav>
      {!pick.view ? (
        <Empty
          text="No repo here"
          hint="This channel has no repo to browse. Point one at it in its settings."
          icon="folder"
        />
      ) : pick.view === "code" ? (
        <RepoCode {...shared} path={pick.rest} />
      ) : pick.view === "drift" ? (
        <RepoDrift {...shared} />
      ) : pick.view === "diagrams" ? (
        <RepoDiagrams {...shared} name={pick.rest} />
      ) : (
        <RepoGeneric {...shared} view={pick.view} />
      )}
    </div>
  );
}

/** What the code view assembles once its reads land. */
type CodeState = {
  tree: RepoTree;
  refs: RepoRef[];
  file: RepoFile | null;
  /** The folder the listing shows: the file's parent, or the path itself. */
  dirPath: string;
  path: string;
};

/** The code view's reads: the tree, then the folder's own listing, the tasks that touch the
 *  path and the file's text, all at once (work.js repoCode's Promise.all). */
async function loadCode(api: Api, ch: string, p: string): Promise<CodeState> {
  const t = (await api.api(api.channelPath(ch, `/repo/tree?path=${encodeURIComponent(p)}`))) as RepoTree;
  const dirPath = t.file ? p.split("/").slice(0, -1).join("/") : p;
  const [dir, refs, file] = await Promise.all([
    t.file ? api.api(api.channelPath(ch, `/repo/tree?path=${encodeURIComponent(dirPath)}`)) : t,
    p
      ? api.api(api.channelPath(ch, `/repo/refs?path=${encodeURIComponent(p)}`)).catch(() => [])
      : Promise.resolve([]),
    t.file ? api.api(api.channelPath(ch, `/repo/file?path=${encodeURIComponent(p)}`)) : Promise.resolve(null),
  ]);
  return {
    tree: dir as RepoTree,
    refs: Array.isArray(refs) ? (refs as RepoRef[]) : [],
    file: (file as RepoFile | null) ?? null,
    dirPath,
    path: p,
  };
}

/** The tree listing down the left: Up, then one row per entry, the current path marked. */
function RepoListing({
  ch,
  tree,
  dirPath,
  path,
}: {
  ch: string;
  tree: RepoTree;
  dirPath: string;
  path: string;
}): JSX.Element {
  return (
    <Panel label="Files" flush class="max-h-[70dvh] overflow-y-auto">
      <ul class="menu w-full">
        {dirPath ? (
          <li>
            <a href={codeHref(ch, dirPath.split("/").slice(0, -1).join("/"))}>
              <Icon name="left" class="size-4" />
              Up
            </a>
          </li>
        ) : null}
        {(tree.entries ?? []).map((e) => (
          <li key={e.path}>
            <a href={codeHref(ch, e.path)} aria-current={e.path === path ? "page" : undefined}>
              <span class="muted shrink-0">
                <Icon name={e.dir ? "folder" : "file"} class="size-4" />
              </span>
              <span class="truncate">{e.name}</span>
            </a>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** The tasks that touch the path, as drawer-opening chips; none, no card. */
function RepoRefs({
  api,
  ch,
  refs,
  byId,
  onOpenTask,
}: {
  api: Api;
  ch: string;
  refs: readonly RepoRef[];
  byId: Map<string, PlanStep>;
  onOpenTask: (id: string) => void;
}): JSX.Element | null {
  if (!refs.length) return null;
  return (
    <Box title={`Tasks that touch this (${refs.length})`} icon="link" flush>
      <div class="flex flex-wrap gap-1.5 p-4">
        {refs.slice(0, 80).map((s) => (
          <a
            key={s.id}
            class="badge badge-ghost gap-1.5 hover:underline"
            href={taskHref(api, ch, s.id)}
            onClick={(e) => {
              e.preventDefault();
              onOpenTask(s.id);
            }}
          >
            <StatusIcon status={stepState(byId.get(s.id))} class="size-3.5" />
            <span class="font-mono">{s.id}</span>
            <span class="max-w-48 truncate">{s.title}</span>
          </a>
        ))}
      </div>
    </Box>
  );
}

/** The file's card: highlighted in a code mockup, or its Markdown, or the note a binary or a
 *  failed read deserves. */
function fileMain(f: RepoFile, path: string): ComponentChild {
  if (f.error) return <Empty text={f.error} icon="alert" />;
  if (f.binary) return <Empty text={`A binary file (${f.size ?? 0} bytes).`} icon="file" />;
  if (/\.md$/i.test(path))
    return (
      <Panel label={path}>
        <div class="prose-h">
          <Markdown text={f.text ?? ""} />
        </div>
      </Panel>
    );
  return (
    <Box
      title={path.split("/").at(-1) ?? path}
      icon="code"
      flush
      right={<span class="text-meta muted tnum">{(f.text ?? "").split("\n").length} lines</span>}
    >
      <MockupCode text={f.text ?? ""} lang={langOf(path)} />
    </Box>
  );
}

/** The right side under the refs: the file, else the folder's README, else the note there is
 *  none. */
function codeMain(st: CodeState): ComponentChild {
  if (st.file) return fileMain(st.file, st.path);
  if (st.tree.readme)
    return (
      <Box title="README" icon="book">
        <div class="prose-h">
          <Markdown text={st.tree.readme} />
        </div>
      </Box>
    );
  return <Empty text="No README in this folder." icon="book" />;
}

/** The code view: the tree down the left, the tasks that touch the path and the file (or the
 *  folder's README) on the right. Port of work.js repoCode. */
export function RepoCode({
  ch,
  api,
  path,
  byId,
  onOpenTask,
}: {
  ch: string;
  api: Api;
  path: string;
  byId: Map<string, PlanStep>;
  onOpenTask: (id: string) => void;
}): JSX.Element {
  const p = path.replace(/^\/+|\/+$/g, "");
  const [st, setSt] = useState<CodeState | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSt(undefined);
    setErr(null);
    loadCode(api, ch, p)
      .then((x) => {
        if (alive) setSt(x);
      })
      .catch((e: unknown) => {
        if (alive) setErr(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [api, ch, p]);

  if (err)
    return (
      <div class="pt-2">
        <Empty text={err} icon="alert" />
      </div>
    );
  if (st === undefined) return <Skeleton rows={6} />;

  const parts = st.path ? st.path.split("/") : [];
  const crumbs = (
    <nav class="flex flex-wrap items-center gap-1 font-mono text-sm muted" aria-label="Path">
      <a class="link link-primary" href={codeHref(ch, "")}>
        repo
      </a>
      {parts.map((x, i) => (
        <span key={`${x}/${i}`}>
          {" / "}
          <a class="link link-primary" href={codeHref(ch, parts.slice(0, i + 1).join("/"))}>
            {x}
          </a>
        </span>
      ))}
    </nav>
  );
  if (st.tree.error) {
    return (
      <>
        {crumbs}
        <Empty text={st.tree.error} icon="alert" />
      </>
    );
  }
  return (
    <>
      {crumbs}
      <div class="grid items-start gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <RepoListing ch={ch} tree={st.tree} dirPath={st.dirPath} path={st.path} />
        <div class="flex min-w-0 flex-col gap-5">
          <RepoRefs api={api} ch={ch} refs={st.refs} byId={byId} onOpenTask={onOpenTask} />
          {codeMain(st)}
        </div>
      </div>
    </>
  );
}

/** The drift report: every snippet a task quotes, checked against the file now; the ones that no
 *  longer match come first. Port of work.js repoDrift. */
export function RepoDrift({
  ch,
  api,
  now,
  onOpenTask,
}: {
  ch: string;
  api: Api;
  now: number;
  byId: Map<string, PlanStep>;
  onOpenTask: (id: string) => void;
}): JSX.Element {
  const [d, setD] = useState<DriftReply | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setD(undefined);
    setErr(null);
    api
      .api(api.channelPath(ch, "/repo/drift"))
      .then((r) => {
        if (alive) setD((r as DriftReply) ?? {});
      })
      .catch((e: unknown) => {
        if (alive) setErr(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [api, ch]);
  if (err)
    return (
      <div class="pt-2">
        <Empty text={err} icon="alert" />
      </div>
    );
  if (d === undefined) return <Skeleton rows={6} />;
  const rows = d.rows ?? [];
  const bad = rows.filter((r) => r.state !== "ok").length;
  return (
    <div class="flex min-w-0 flex-col gap-5">
      <p class="max-w-[72ch] text-[0.9375rem] muted">
        Every code snippet a task quotes from a file, checked against the file now.{" "}
        {bad ? `${bad} of ${rows.length} no longer match.` : rows.length ? `All ${rows.length} match.` : ""}{" "}
        Checked <Time ts={d.at} now={now} />.
      </p>
      <Box title="Snippet drift" icon="code" flush>
        <div class="overflow-x-auto">
          <table class="table table-pin-rows text-row">
            <thead>
              <tr class="bg-base-200/60 text-sm text-base-content/70">
                <th>State</th>
                <th>Task</th>
                <th>File</th>
                <th class="text-right tnum">Lines kept</th>
              </tr>
            </thead>
            <tbody>
              {driftOrdered(rows).map((r) => {
                const pill = driftPill(r.state);
                const file = String(r.path ?? "").replace(/:\d.*$/, "");
                return (
                  <tr key={`${r.step}/${r.path}`} class="hover:bg-base-200/50">
                    <td class="whitespace-nowrap">
                      <Pill status={pill.status} label={pill.label} />
                    </td>
                    <td>
                      <a
                        class="link link-primary font-mono text-sm"
                        href={taskHref(api, ch, r.step)}
                        onClick={(e) => {
                          e.preventDefault();
                          onOpenTask(r.step);
                        }}
                      >
                        {r.step}
                      </a>
                    </td>
                    <td>
                      <a class="link link-primary font-mono text-sm" href={codeHref(ch, file)}>
                        {r.path}
                      </a>
                    </td>
                    <td class="text-right tnum">
                      {r.score === null || r.score === undefined ? "" : `${r.score}%`}
                    </td>
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td colSpan={4} class="px-5 py-4 text-sm muted">
                    No snippet quotes a file.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Box>
    </div>
  );
}

/** The diagrams: one chip per PNG in docs/architecture, the picked one below it. Port of
 *  work.js repoDiagrams. */
export function RepoDiagrams({
  ch,
  api,
  name,
}: {
  ch: string;
  api: Api;
  name: string;
  byId: Map<string, PlanStep>;
  onOpenTask: (id: string) => void;
  now: number;
}): JSX.Element {
  const [ds, setDs] = useState<string[] | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setDs(undefined);
    setErr(null);
    api
      .api(api.channelPath(ch, "/repo/diagrams"))
      .then((r) => {
        if (alive) setDs(Array.isArray(r) ? (r as string[]) : []);
      })
      .catch((e: unknown) => {
        if (alive) setErr(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [api, ch]);
  if (err)
    return (
      <div class="pt-2">
        <Empty text={err} icon="alert" />
      </div>
    );
  if (ds === undefined) return <Skeleton rows={6} />;
  if (!ds.length)
    return (
      <Empty
        text="No PNG diagrams in docs/architecture."
        hint="Drop .png files there and they show up here."
        icon="ext"
      />
    );
  const cur = name && ds.includes(name) ? name : (ds[0] ?? "");
  const label = (x: string): string => x.replace(/\.png$/, "").replace(/-/g, " ");
  return (
    <div class="flex min-w-0 flex-col gap-5">
      {/* biome-ignore lint/a11y/useSemanticElements: the legacy chip group's role, kept word for word */}
      <div class="join flex-wrap" role="group" aria-label="Diagrams">
        {ds.map((x) => (
          <a
            key={x}
            class={`btn join-item btn-sm${x === cur ? " btn-primary" : ""}`}
            href={viewHref(ch, "diagrams", encodeURIComponent(x))}
            aria-current={x === cur ? "page" : undefined}
          >
            {label(x)}
          </a>
        ))}
      </div>
      <Panel label="Diagram" class="overflow-auto">
        <img
          class="mx-auto min-w-0 max-w-full"
          src={api.channelPath(ch, `/diagram?name=${encodeURIComponent(cur)}`)}
          alt={`Diagram: ${label(cur)}`}
        />
      </Panel>
      <p class="text-meta muted">
        From <code>docs/architecture/{cur}</code>.
      </p>
    </div>
  );
}

/** A view from a local extension: one Markdown document per row, a table of rows, or plain JSON.
 *  Port of work.js repoGeneric. */
export function RepoGeneric({
  ch,
  api,
  view,
}: {
  ch: string;
  api: Api;
  view: string;
  byId: Map<string, PlanStep>;
  onOpenTask: (id: string) => void;
  now: number;
}): JSX.Element {
  const [r, setR] = useState<unknown | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setR(undefined);
    setErr(null);
    api
      .api(api.channelPath(ch, `/repo/${encodeURIComponent(view)}`))
      .then((x) => {
        if (alive) setR(x);
      })
      .catch((e: unknown) => {
        if (alive) setErr(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [api, ch, view]);
  if (err)
    return (
      <div class="pt-2">
        <Empty text={err} icon="alert" />
      </div>
    );
  if (r === undefined) return <Skeleton rows={6} />;
  const refused =
    r !== null && typeof r === "object" && !Array.isArray(r) && "error" in r
      ? String((r as { error: unknown }).error)
      : null;
  if (refused)
    return (
      <div class="pt-2">
        <Empty text={refused} icon="alert" />
      </div>
    );
  if (isMdDocs(r))
    return (
      <div class="flex min-w-0 flex-col gap-5">
        {r.map((x, i) => (
          <Panel key={i} label={`${repoLabel(view)} document ${i + 1}`}>
            <div class="prose-h">
              <Markdown text={x.md} />
            </div>
          </Panel>
        ))}
        {!r.length ? <Empty text="Nothing here." icon="file" /> : null}
      </div>
    );
  if (isRows(r)) {
    const keys = tableKeys(r);
    return (
      <Panel label={repoLabel(view)} flush class="min-w-0">
        <div class="overflow-x-auto">
          <table class="table text-row">
            <thead>
              <tr class="bg-base-200/60 text-sm text-base-content/70">
                {keys.map((k) => (
                  <th key={k}>{k}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.map((x, i) => (
                <tr key={i} class="hover:bg-base-200/50 align-top">
                  {keys.map((k) => (
                    <td key={k}>{cellNode(x[k])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    );
  }
  return (
    <Box title={repoLabel(view)} icon="code" flush>
      <MockupCode text={JSON.stringify(r ?? null, null, 2)} lang="json" />
    </Box>
  );
}
