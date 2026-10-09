// router.ts — the hash routes, parsed and built: Home (`#/`), a channel's destinations
// (`#/c/<ch>/{overview,today,inbox,team,work/knowledge,settings}`), the two drawers (`?t=<task>`,
// `?s=<session>`) and the alias redirects (bookmarks, notifications, links in agents' context).
// Pure: a hash goes in, a route comes out; the shell applies what it says. Port of app.js's
// routing block (path, taskHref, sessHref, redirect and the parse half of route).

import type { IconName } from "../icons.tsx";

/** Every destination a channel serves, Home included. */
export type Dest = "home" | "overview" | "today" | "inbox" | "team" | "work" | "knowledge" | "settings";

/** The sidebar and bottom nav entries: name, label, icon and keyboard hint (app.js DESTS). */
export const DESTS: readonly (readonly [
  name: Exclude<Dest, "home" | "overview" | "today">,
  label: string,
  icon: IconName,
  key: string,
])[] = [
  ["inbox", "Inbox", "inbox", "i"],
  ["team", "Team", "users", "t"],
  ["work", "Work", "list", "w"],
  ["knowledge", "Knowledge", "book", "k"],
  ["settings", "Settings", "sliders", "s"],
];

/** The destinations route() accepts in the address bar; anything else reads as Overview. */
const KNOWN: ReadonlySet<string> = new Set<string>(["overview", "today", ...DESTS.map((d) => d[0])]);

/** Reads a per-viewer preference the aliases carry over ("wview:<ch>"); tests pass a fake. */
export type PrefReader = (key: string, fallback: string) => string;

/** One alias hit: the canonical tail for `#/c/<ch>/…` and the per-viewer prefs it carries. */
export type Redirect = { to: string; prefs?: Record<string, string | number> };

/** What a hash says: the destination to paint, its sub path, both drawers, and the canonical
 *  address (`replace`) plus prefs to save when an alias or an unknown destination was used. */
export type Route = {
  dest: Dest;
  /** The channel the hash names, null on Home. */
  ch: string | null;
  /** The parts after the destination ("list" under Work, an id under Knowledge). */
  sub: string[];
  /** The channel, destination and sub path as one string: the shell repaints when it changes. */
  key: string;
  /** The task drawer's task, from ?t=. */
  task: string | null;
  /** The session drawer's session, from ?s=; the task drawer wins when both are present. */
  sess: string | null;
  /** The canonical hash for the address bar, or null when the hash already is canonical. */
  replace: string | null;
  /** Per-viewer preferences an alias carried ("wphase:<ch>", "wfilter:<ch>"), to save. */
  prefs: Record<string, string | number>;
};

/** Decodes a path part; a broken escape stays as written. */
const safeDec = (x: string): string => {
  try {
    return decodeURIComponent(x);
  } catch {
    return x;
  }
};

/** The path part of a hash, without a drawer query; empty reads as Home (app.js path). */
export const pathOf = (hash: string): string => hash.split("?")[0] || "#/";

/** A channel link: #/c/<ch><p> (core.js href, without the channel's drawer). */
export const channelHref = (ch: string, p = ""): string => `#/c/${ch}${p}`;

/** A task drawer link over the current channel view; over Work when the view is not the
 *  channel's (app.js taskHref). The drawer query rides on whatever path is open. */
export function taskHref(ch: string, p: string, id: string): string {
  return `${p.startsWith(`#/c/${ch}/`) ? p : channelHref(ch, "/work")}?t=${encodeURIComponent(id)}`;
}

/** A session drawer link over the current channel view; over Team otherwise (app.js sessHref). */
export function sessHref(ch: string, p: string, name: string): string {
  return `${p.startsWith(`#/c/${ch}/`) ? p : channelHref(ch, "/team")}?s=${encodeURIComponent(name)}`;
}

/** Which canonical destination an alias stands for: needs→Inbox, live→Team, plan→Work's list
 *  (carrying the phase), board and graph→Work, review→Work's list filtered to notes, kb→Knowledge,
 *  repo→Work's repo views, t/<id>→the task drawer over the channel's last Work view (app.js
 *  redirect). Anything else is not an alias. */
export function redirect(ch: string, p: readonly string[], readPref: PrefReader): Redirect | null {
  const [v, ...rest] = p;
  const a = rest.join("/");
  const work = readPref(`wview:${ch}`, "list");
  if (v === "needs") return { to: "inbox" };
  if (v === "live") return { to: "team" };
  if (v === "plan") return planRedirect(ch, a);
  if (v === "board" || v === "graph") return { to: `work/${v}` };
  if (v === "review") return { to: "work/list", prefs: { [`wfilter:${ch}`]: "notes" } };
  if (v === "kb") return kbRedirect(a);
  if (v === "repo") return repoRedirect(a);
  if (v === "t") return taskRedirect(a, work);
  return null;
}

/** plan → Work's list, carrying the phase the hash named (app.js's wphase). */
function planRedirect(ch: string, a: string): Redirect {
  const m = /^p\/(-?\d+)$/.exec(a);
  return m ? { to: "work/list", prefs: { [`wphase:${ch}`]: Number(m[1]) } } : { to: "work/list" };
}

/** kb[/id] → Knowledge, optionally onto one entry. */
function kbRedirect(a: string): Redirect {
  return { to: `knowledge${a ? `/${a}` : ""}` };
}

/** repo[/view] → Work's repo views. */
function repoRedirect(a: string): Redirect {
  return { to: `work/repo${a ? `/${a}` : ""}` };
}

/** t/<id> → the task drawer over the channel's last Work view; no id, no alias. */
function taskRedirect(a: string, work: string): Redirect | null {
  return a ? { to: `work/${work}?t=${encodeURIComponent(a)}` } : null;
}

/** The drawers a hash carries; the shell lets a task drawer win over a session drawer. */
const drawers = (q: URLSearchParams): { task: string | null; sess: string | null } => ({
  task: q.get("t"),
  sess: q.get("s"),
});

/** The channel half of a hash: destination (unknown ones read as Overview), sub path, drawers,
 *  and the canonical address to rewrite to when the hash was not canonical. */
function parseChannel(
  ch: string,
  parts: string[],
  qs: string | undefined,
  q: URLSearchParams,
  readPref: PrefReader,
): Route {
  const r = redirect(ch, parts.slice(2), readPref);
  if (r) {
    const canonical = `#/c/${ch}/${r.to}`;
    const next = parseHash(canonical, readPref);
    return { ...next, replace: canonical, prefs: { ...r.prefs, ...next.prefs } };
  }
  const raw = parts[2];
  const dest: Dest = raw !== undefined && KNOWN.has(raw) ? (raw as Dest) : "overview";
  const sub = parts.slice(3);
  return {
    dest,
    ch,
    sub,
    key: `${ch}/${dest}/${sub.join("/")}`,
    ...drawers(q),
    replace: dest !== raw ? `#/c/${ch}/${dest}${qs ? `?${qs}` : ""}` : null,
    prefs: {},
  };
}

/** Parses a hash into a route: Home when it is not a channel's, an alias through its canonical
 *  form, an unknown destination as Overview with the address to rewrite (app.js route's parse). */
export function parseHash(hash: string, readPref: PrefReader): Route {
  const [hp = "", qs] = hash.replace(/^#\/?/, "").split("?");
  const q = new URLSearchParams(qs ?? "");
  const parts = hp.split("/").filter(Boolean).map(safeDec);
  if (parts[0] !== "c" || !parts[1]) {
    return {
      dest: "home",
      ch: null,
      sub: [],
      key: "home",
      ...drawers(q),
      replace: null,
      prefs: {},
    };
  }
  return parseChannel(parts[1] ?? "", parts, qs, q, readPref);
}
