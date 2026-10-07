// core.js — shared state and helpers for every module of the owner UI: DOM and API helpers,
// formatting, icons, the status model (one derived status per session, task states, human verbs
// for the timeline), toasts, dialogs and drawers that keep focus, fuzzy match, markdown and the
// dependency picker. No imports, so any module can use it without import cycles.

// ── DOM, storage, API ────────────────────────────────────────────────────────
export const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const enc = encodeURIComponent;
// per-viewer conveniences only (theme, filters, last view, drafts); every access may throw
export const LS = {
  get(k, d) { try { const v = localStorage.getItem("huddle:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("huddle:" + k, JSON.stringify(v)); } catch {} },
};
// One channel is open at a time; its board, sessions, timeline and attention are cached and kept
// fresh by the live stream. A view sets S.repaint(what) so a refresh redraws only what is shown.
export const S = { ch: null, info: null, board: null, byId: new Map(), sess: null, tl: null, att: null, channels: null,
  dest: null, sub: null, repaint: null, task: null, sessName: null };
export const cu = p => `/api/c/${enc(S.ch)}${p}`;   // channel API path
export const href = p => `#/c/${S.ch}${p}`;          // channel route
export async function api(p, o = {}) {
  const init = { method: o.method || (o.body !== undefined ? "POST" : "GET"), headers: {} };
  if (o.body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(o.body); }
  const r = await fetch(p, init);
  const ct = r.headers.get("content-type") || "";
  const j = ct.includes("json") ? await r.json().catch(() => null) : await r.text();
  if (r.status === 401 && j && j.signin) signedOut();
  if (!r.ok) { const e = new Error((j && j.error) || (typeof j === "string" && j) || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
}
// this browser's sign-in ended (Huddle restarted from scratch, it was kicked, the link expired):
// one page that says how to get back in, instead of every view failing on its own
let OUT = false;
export const LOGO = (c = "size-9") => `<svg viewBox="0 0 26 26" class="${c}" aria-hidden="true"><path d="M5 17 Q13 2 21 17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.2 2.2" opacity=".75"/><circle cx="13" cy="9.6" r="2.4" fill="currentColor"/><rect x="2.5" y="17" width="5" height="6" rx="2.5" fill="currentColor"/><rect x="18.5" y="17" width="5" height="6" rx="2.5" fill="currentColor"/></svg>`;
// a command shown like a read-only field: a leading icon, the command, a copy button at the end
const cmdField = (id, label, cmd, icon) => `<div class="flex flex-col gap-1.5"><span class="text-[13px] font-medium" id="${id}-l">${label}</span>
  <div class="flex h-10 items-center gap-2.5 rounded-lg border border-line2 bg-bg pr-1 pl-3" aria-labelledby="${id}-l"><span class="text-faint">${I(icon)}</span><code class="min-w-0 flex-1 truncate text-[13px]">${esc(cmd)}</code><button type="button" class="btn btn-ghost btn-icon text-muted" data-copycmd="${esc(cmd)}" aria-label="Copy ${esc(cmd)}">${I("copy")}</button></div></div>`;
export const isSignedOut = () => OUT;
export function signedOut() {
  if (OUT) return; OUT = true;
  document.title = "Huddle: signed out";
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  document.body.className = "";
  document.body.innerHTML = `<main class="signin"><div class="flex w-full max-w-md flex-col gap-8">
    <div class="flex flex-col items-center gap-3 text-center"><span class="signin-logo">${LOGO()}</span><h1 class="text-3xl font-bold tracking-tight">Huddle</h1><p class="text-[15px] text-muted">Sign in to see your channels and sessions</p></div>
    <section class="card flex flex-col gap-5 p-6" aria-labelledby="so-h">
      <div class="c-peach flex items-start gap-2.5 rounded-lg border p-3 text-[13px]" style="border-color:color-mix(in srgb,var(--peach) 30%,var(--panel));background:color-mix(in srgb,var(--peach) 9%,var(--panel))" role="status"><span class="ink mt-px">${I("logout")}</span><p><b class="font-semibold" id="so-h">Signed out.</b> <span class="text-muted">This browser's sign-in ended: Huddle was set up again, its member was removed, or the link expired.</span></p></div>
      <p class="text-[13px] text-muted">Get a new sign-in link from any session in this huddle, then open it here.</p>
      ${cmdField("so-c", "In a Claude session", "/huddle:open", "terminal")}
      ${cmdField("so-t", "Or in a terminal", "huddle open", "terminal")}
      <button type="button" class="btn btn-pri h-10 w-full text-[14px]" id="so-copy">${I("copy")}Copy /huddle:open</button>
    </section>
    <p class="text-center text-xs text-faint" id="so-ver">Huddle</p></div></main>`;
  const done = (b, t) => { const was = b.innerHTML; b.innerHTML = `${I("check")}${t}`; setTimeout(() => { b.innerHTML = was; }, 1600); };
  const cp = (txt, b, t) => navigator.clipboard?.writeText(txt).then(() => done(b, t), () => {});
  document.getElementById("so-copy").onclick = e => cp("/huddle:open", e.currentTarget, "Copied: paste it into a Claude session");
  for (const b of document.querySelectorAll("[data-copycmd]")) b.onclick = () => cp(b.dataset.copycmd, b, "");
  fetch("/health").then(r => r.json()).then(h => { document.getElementById("so-ver").textContent = `Huddle v${h.version}`; }).catch(() => {});
}
export const op = (name, args = {}) => api(cu(`/op/${name}?as=owner`), { body: args });
// an owner action: toast the server's refusal (409 "waits on …", 423 paused, …) and return null
export async function act(name, args, ok, o = {}) {
  try { const r = await op(name, args); if (ok) toast(ok, o); return r.result ?? true; }
  catch (e) { toast(e.status === 404 && /no operation/.test(e.message) ? `This Huddle server does not support “${name}” yet. Update the server.` : e.message, { bad: true }); return null; }
}
// orchestrator controls: shown only when the channel's config carries the key
export const hasOrch = () => S.info?.config && S.info.config.orchestrator !== undefined;

// ── time and scheduling ──────────────────────────────────────────────────────
export const ago = ts => {
  if (!ts) return "—"; const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
export const tsEl = ts => `<time data-ts="${esc(ts)}" datetime="${esc(ts)}" title="${esc(ts ? new Date(ts).toLocaleString() : "")}">${ago(ts)}</time>`;
const timers = {};
export const soon = (k, f, ms = 350) => { clearTimeout(timers[k]); timers[k] = setTimeout(f, ms); };
export function copy(t, what = "Copied") { navigator.clipboard?.writeText(t).then(() => toast(what), () => toast("Could not copy. Select the text and copy it by hand.", { bad: true })); }
// Re-render a region without losing what the owner is typing: values of [data-keep] fields and
// the focused element (with its selection) survive, matched by id.
export function preserve(fn) {
  const a = document.activeElement, keep = {};
  for (const el of $$("[data-keep]")) if (el.id) keep[el.id] = el.type === "checkbox" ? el.checked : el.value;
  const f = a?.id ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
  fn();
  for (const [id, v] of Object.entries(keep)) { const el = document.getElementById(id); if (el) { if (el.type === "checkbox") el.checked = v; else el.value = v; } }
  if (f) { const el = document.getElementById(f.id); if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); try { if (f.s != null) el.setSelectionRange(f.s, f.e); } catch {} } }
}
// polite announcements for screen readers (new Inbox items, results of an action)
export function announce(t) { const el = $("#announce"); if (!el) return; el.textContent = ""; setTimeout(() => { el.textContent = t; }, 60); }

// ── icons (Lucide-style strokes, inline, offline) ────────────────────────────
const P = {
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  columns: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18"/>',
  graph: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M6.5 10v3.5a2 2 0 0 0 2 2H14"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  note: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2zM9 13h6M9 17h4"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  ask: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
  turn: '<path d="m16 3 4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkc: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  half: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  minusc: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  hourglass: '<path d="M5 22h14M5 2h14M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"/>',
  zzz: '<path d="M4 7h6l-6 7h6M14 4h6l-6 7h6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V4a2 2 0 0 1 2-2h10"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  right: '<path d="m9 18 6-6-6-6"/>', left: '<path d="m15 18-6-6 6-6"/>', down: '<path d="m6 9 6 6 6-6"/>', up: '<path d="m18 15-6-6-6 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  arrowdown: '<path d="M12 5v14M19 12l-7 7-7-7"/>', arrow: '<path d="M5 12h14M13 5l7 7-7 7"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 17h8M10 13h4"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/>',
  sparkle: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  brain: '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/>',
  baton: '<circle cx="12" cy="5" r="2"/><path d="M12 7v4M5 21l3-6h8l3 6M8 15l4-4 4 4"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
};
export const I = (n, c = "size-4") => `<svg class="${c} shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ""}</svg>`;

// ── task status: always icon + word, never color alone ──────────────────────
export const STAT = ["todo", "doing", "done", "blocked", "skipped"];
export const FIN = new Set(["done", "skipped"]);
export const STATM = {
  todo: { l: "To do", i: "circle", c: "c-idle" }, doing: { l: "Doing", i: "half", c: "c-yellow" }, done: { l: "Done", i: "checkc", c: "c-green" },
  blocked: { l: "Blocked", i: "ban", c: "c-red" }, skipped: { l: "Skipped", i: "minusc", c: "c-idle" },
  waiting: { l: "Waiting", i: "hourglass", c: "c-peach" },
};
// what a task shows: its status, except an open task whose dependencies are unfinished is "waiting"
export const tState = t => !t ? "todo" : (!FIN.has(t.status) && t.status !== "blocked" && (t.blocked_by?.length || t.unmet?.length) ? "waiting" : t.status);
export const stPill = (s, label) => hrPill(s, label);
export const stIcon = (s, c = "size-4") => { const m = STATM[s] || STATM.todo; return `<span class="${m.c} ink inline-flex" title="${m.l}">${I(m.i, c)}<span class="sr-only">${m.l}</span></span>`; };

// ── session status: one derived status, in this priority ─────────────────────
// Paused › Blocked › Waiting › Working › Idle › Left. A paused session is never also "working".
export const SSTM = {
  paused: { l: "Paused", i: "pause", c: "c-mauve" }, blocked: { l: "Blocked", i: "ban", c: "c-red" }, waiting: { l: "Waiting", i: "hourglass", c: "c-peach" },
  working: { l: "Working", i: "activity", c: "c-yellow" }, idle: { l: "Idle", i: "zzz", c: "c-idle" }, left: { l: "Left", i: "logout", c: "c-idle" },
};
export function sStatus(s) {
  if (!s) return "idle";
  if (s.state === "left") return "left";
  if (s.control === "pause") return "paused";
  const t = s.step ? S.byId.get(s.step) : null;
  if (s.state === "blocked" || t?.status === "blocked") return "blocked";
  if (s.state === "waiting" || (t && tState(t) === "waiting")) return "waiting";
  if (s.state === "working" && !s.stale) return "working";
  return "idle";
}
export const sWhy = s => { const k = sStatus(s);
  return k === "paused" ? `Paused by ${s.control_by === "owner" ? "you" : s.control_by || "someone"}${s.control_at ? " " + ago(s.control_at) : ""}. Its changes are refused until you resume it.`
    : k === "idle" && s.stale && s.state !== "idle" ? `No sign of life since ${ago(s.last_seen)}.` : k === "waiting" ? "Waiting for another task or a reply." : k === "blocked" ? "Blocked: it cannot go on without help." : ""; };
export const sPill = (s, sm = false) => { const k = sStatus(s); return `<span class="hr-pill hr-pill-${HRPILL[k] || "idle"} ${sm ? "h-5 px-1.5 text-2xs" : ""}" title="${esc(sWhy(s))}">${SSTM[k].l}</span>`; };
const AVC = ["c-blue", "c-teal", "c-sky", "c-lavender", "c-pink", "c-flamingo", "c-sapphire"];
export const avColor = n => { let h = 0; for (const ch of String(n).split(".")[0]) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return AVC[h % AVC.length]; };
export const av = (n, sm = false) => `<span class="av ${sm ? "av-sm" : ""} ${n === "owner" ? "c-mauve" : avColor(n)}" aria-hidden="true">${esc(n === "owner" ? "Y" : String(n).split(".").at(-1)[0].toUpperCase())}</span>`;
export const who = n => n === "owner" ? "You" : n;
export const whoL = n => n === "owner" ? "you" : n; // mid-sentence

// ── the kit: stat cards, pills, empty states, the area chart, count-up ──
// status word → pill hue; task states and session states share one table
const HRPILL = { todo: "idle", doing: "doing", done: "done", skipped: "idle", blocked: "blocked", waiting: "waiting",
  paused: "violet", working: "doing", idle: "idle", left: "idle", needs: "needs", info: "info", violet: "violet" };
export const hrPill = (s, label) => `<span class="hr-pill hr-pill-${HRPILL[s] || "idle"}">${esc(label ?? STATM[s]?.l ?? SSTM[s]?.l ?? s)}</span>`;
// one stat card: muted title left, tinted icon right, the value (data-count: hrCountUp ticks it), a muted subline
export const hrStat = ({ icon, tint = "", label, value, sub = "", delta = null, ov = "", subov = "" }) => `<div class="hr-stat">
  <div class="flex min-w-0 items-center gap-2"><span class="hr-label min-w-0 flex-1 truncate">${esc(label)}</span>${delta ? `<span class="hr-delta-${delta.up ? "up" : "down"}">${esc(delta.text)}</span>` : ""}<span class="hr-stat-icon ${tint}">${I(icon, "size-4")}</span></div>
  <p class="hr-stat-val"${ov ? ` data-ov="${esc(ov)}"` : ""} data-count="${Number(value) || 0}">${Number(value) || 0}</p>
  ${sub ? `<p class="hr-stat-sub"${subov ? ` data-ovtxt="${esc(subov)}"` : ""}>${esc(sub)}</p>` : ""}</div>`;
export const hrEmpty = (text, hint = "", icon = "") => `<div class="hr-empty">${icon ? I(icon, "size-6 mb-1") : ""}<p>${esc(text)}</p>${hint ? `<span class="hr-empty-hint">${esc(hint)}</span>` : ""}</div>`;

// numbers tick: a 300 ms count-up from whatever the element showed (0 on first paint). The final
// value is painted first, so reduced-motion users (and any missed frame) keep seeing it.
const RM = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export function hrTick(el, to, from) {
  to = Math.round(to) || 0;
  if (from === undefined) from = Number(el.dataset.cur) || 0;
  el.dataset.cur = String(to);
  if (RM() || from === to || !el.isConnected) { el.textContent = to; return; }
  const t0 = performance.now();
  const step = t => { const k = Math.min(1, (t - t0) / 300), e = 1 - (1 - k) ** 2;
    el.textContent = Math.round(from + (to - from) * e);
    if (k < 1 && el.isConnected) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
export const hrCountUp = (root = document) => { for (const el of $$("[data-count]", root)) hrTick(el, Number(el.dataset.count) || 0, 0); };

// areaChart(svg, series, opts) — a smooth area chart (Catmull-Rom → cubic Bézier) drawn into an
// existing <svg> with createElementNS only: 2px stroke, gradient fill, dashed grid, mono 10px
// labels, hover crosshair + tooltip card. series: [{ values, tint, label }]; opts: { h, w, axis:
// [[index, label]], yfmt, tip: i → [title, …rows], note, label }. Returns redraw(series, opts)
// for window switches and live updates; an empty window draws the grid with a centred note.
const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (n, a = {}) => { const e = document.createElementNS(SVGNS, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); return e; };
const nice = v => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p; };
function spline(pts, floor = Infinity) { // floor: the baseline's y; a control point never dips below it
  const f = y => Math.min(y, floor);
  if (pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${f(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${f(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}
export function areaChart(svg, series, opts = {}) {
  const wrap = svg.parentElement;
  if (wrap && getComputedStyle(wrap).position === "static") wrap.classList.add("relative");
  const tip = document.createElement("div");
  tip.className = "hr-chart-tip absolute z-10"; tip.style.display = "none";
  wrap?.append(tip);
  if (opts.label) { svg.setAttribute("role", "img"); svg.setAttribute("aria-label", opts.label); }
  let cur = null, cross = null, dots = [];
  const hide = () => { tip.style.display = "none"; if (cross) cross.style.display = "none"; for (const d of dots) d.style.display = "none"; };
  const draw = () => {
    if (!svg.isConnected) { ro.disconnect(); return; }
    svg.replaceChildren();
    const w = svg.clientWidth || opts.w || 600, h = opts.h || 220;
    svg.setAttribute("width", w); svg.setAttribute("height", h); svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const L = 38, R = 10, T = 10, B = 18, iw = Math.max(10, w - L - R), ih = Math.max(10, h - T - B);
    const n = Math.max(1, ...series.map(s => s.values.length));
    const x = i => L + (n > 1 ? i * iw / (n - 1) : iw / 2);
    const ymax = nice(Math.max(1, ...series.flatMap(s => s.values.map(Number))));
    const grid = svgEl("g");
    for (const f of [.25, .5, .75, 1]) {
      const y = T + ih * (1 - f);
      grid.append(svgEl("line", { class: "hr-chart-grid", x1: L, x2: L + iw, y1: y, y2: y }));
      const t = svgEl("text", { class: "hr-chart-axis", x: L - 6, y: y + 3, "text-anchor": "end" });
      t.textContent = (opts.yfmt || String)(+(ymax * f).toFixed(2)); grid.append(t);
    }
    svg.append(grid);
    for (const [i, s] of opts.axis || []) {
      const t = svgEl("text", { class: "hr-chart-axis", x: x(i), y: h - 4, "text-anchor": i <= 0 ? "start" : i >= n - 1 ? "end" : "middle" });
      t.textContent = s; svg.append(t);
    }
    const total = series.reduce((a, s) => a + s.values.reduce((x2, y2) => x2 + Number(y2), 0), 0);
    dots = [];
    if (!total) { // empty state: the grid and a centred note
      const t = svgEl("text", { class: "hr-chart-axis", x: w / 2, y: T + ih / 2, "text-anchor": "middle" });
      t.textContent = opts.note || "No data yet"; svg.append(t);
    } else {
      const defs = svgEl("defs"), grad = svgEl("linearGradient", { id: "hr-chart-grad", x1: 0, y1: 0, x2: 0, y2: 1 });
      for (const [o, op] of [[0, 0.25], [1, 0]]) { const st = svgEl("stop", { offset: o }); st.setAttribute("style", `stop-color:var(--primary);stop-opacity:${op}`); grad.append(st); }
      defs.append(grad); svg.append(defs);
      series.forEach((sr, si) => {
        const pts = sr.values.map((v, i) => [x(i), T + ih * (1 - Math.min(Number(v) || 0, ymax) / ymax)]);
        const line = spline(pts, T + ih);
        if (line) {
          svg.append(svgEl("path", { class: `hr-chart-fill${si === 0 ? " grad" : ""}${sr.tint ? " " + sr.tint : ""}`, d: `${line}L${pts.at(-1)[0].toFixed(1)} ${T + ih}L${pts[0][0].toFixed(1)} ${T + ih}Z` }));
          svg.append(svgEl("path", { class: `hr-chart-line${sr.tint ? " " + sr.tint : ""}`, d: line }));
        } else svg.append(svgEl("circle", { cx: pts[0][0], cy: pts[0][1], r: 3, style: `fill:var(--primary);stroke:var(--panel);stroke-width:1.5` }));
      });
      cross = svgEl("line", { class: "hr-chart-cross", y1: T, y2: T + ih }); cross.style.display = "none"; svg.append(cross);
      dots = series.map(sr => { const d = svgEl("circle", { r: 3.5, style: "stroke:var(--panel);stroke-width:1.5" }); d.style.display = "none"; svg.append(d); return d; });
    }
    cur = { L, iw, n, T, ih, total, x, ymax };
  };
  svg.onpointermove = e => {
    if (!cur || !cur.total) return;
    const r = svg.getBoundingClientRect();
    const step = cur.n > 1 ? cur.iw / (cur.n - 1) : cur.iw;
    const i = Math.max(0, Math.min(cur.n - 1, Math.round((e.clientX - r.left - cur.L) / step)));
    const px = cur.x(i);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.style.display = "";
    series.forEach((sr, si) => {
      const cy = cur.T + cur.ih * (1 - Math.min(Number(sr.values[i]) || 0, cur.ymax) / cur.ymax);
      const d = dots[si]; if (!d) return;
      d.setAttribute("cx", px.toFixed(1)); d.setAttribute("cy", cy.toFixed(1)); d.style.display = "";
    });
    tip.replaceChildren();
    (opts.tip ? opts.tip(i) : [String(i)]).forEach((row, ri) => { const p = document.createElement("p"); if (!ri) p.className = "text-faint"; p.textContent = row; tip.append(p); });
    tip.style.display = "";
    const py = Number(dots[0]?.getAttribute("cy")) || cur.T;
    tip.style.left = `${Math.max(0, Math.min(r.width - tip.offsetWidth - 2, px + 12))}px`;
    tip.style.top = `${Math.max(0, py - tip.offsetHeight - 10)}px`;
  };
  svg.onpointerleave = hide;
  const ro = new ResizeObserver(draw); ro.observe(svg);
  draw();
  const redraw = (ns, no) => { if (ns) series = ns; if (no) opts = { ...opts, ...no }; draw(); };
  redraw.redraw = redraw; // the views call chart.redraw(series, opts)
  return redraw;
}

// ── the timeline in human verbs; the raw topic stays in a tooltip ───────────
export const famOf = t => /^task\./.test(t) ? "task" : /^turn\./.test(t) ? "turn" : /^control\./.test(t) ? "control" : t === "ask" || t === "msg" || t === "reply" ? "msg" : /^kb\./.test(t) ? "kb" : /^session\./.test(t) ? "session" : "other";
const tq = id => id ? `<b class="font-medium text-fg">${esc(id)}</b>` : "";
// {v: verb phrase (HTML), i: icon, c: color class}
export function verb(e) {
  const d = e.data || {}, task = d.task || e.ref, to = e.to ? (e.to === "owner" ? "you" : esc(e.to)) : "everyone";
  switch (e.topic) {
    case "task.status": return { v: ({ done: "finished", doing: "started", blocked: "is blocked on", skipped: "skipped", todo: "reopened" })[d.status] ? `${({ done: "finished", doing: "started", blocked: "is blocked on", skipped: "skipped", todo: "reopened" })[d.status]} ${tq(task)}` : `moved ${tq(task)}`, i: STATM[d.status]?.i || "circle", c: STATM[d.status]?.c || "c-idle" };
    case "task.created": return { v: `planned ${tq(task)}${e.to ? ` for ${to}` : ""}`, i: "plus", c: "c-idle" };
    case "task.assigned": return { v: `gave ${tq(task)} to ${d.owner ? (d.owner === "owner" ? "you" : esc(d.owner)) : "nobody"}`, i: "users", c: "c-idle" };
    case "task.ready": return { v: `unblocked ${tq(task)}${e.to ? ` for ${to}` : ""}`, i: "check", c: "c-green" };
    case "kb.added": return { v: "remembered", i: "brain", c: "c-teal" };
    case "ask": return { v: `asked ${to}`, i: "ask", c: "c-mauve" };
    case "msg": return { v: d.approved ? `approved ${tq(task)}` : d.brief ? `briefed ${to}` : `told ${to}`, i: d.approved ? "key" : d.brief ? "baton" : "msg", c: d.approved ? "c-green" : "c-idle" };
    case "reply": return { v: `answered ${to}`, i: "undo", c: "c-idle" };
    case "turn.pass": return { v: `handed the turn to ${to}`, i: "turn", c: "c-idle" };
    case "turn.take": return { v: "took the turn", i: "turn", c: "c-idle" };
    case "control.pause": return { v: `paused ${to}`, i: "pause", c: "c-mauve" };
    case "control.resume": return { v: `resumed ${to}`, i: "play", c: "c-idle" };
    case "session.joined": {
      if (d.context === "fresh") return { v: `started fresh${d.skipped != null ? ` (skipped ${d.skipped})` : ""}`, i: "sparkle", c: "c-idle" };
      if (d.context === "sync") return { v: d.skipped ? `caught up on ${d.skipped} event${d.skipped === 1 ? "" : "s"}` : "joined, up to date", i: "undo", c: "c-idle" };
      return { v: "joined", i: "users", c: "c-idle" };
    }
    case "session.left": return { v: "left", i: "logout", c: "c-idle" };
    case "brief": return { v: `briefed ${to}`, i: "note", c: "c-idle" };
    default: return { v: `posted ${esc(e.topic)}`, i: "activity", c: "c-idle" };
  }
}
// the text that follows the verb, minus what the verb already says
export function evText(e) {
  const m = String(e.msg || "");
  switch (e.topic) {
    case "task.status": return m.includes(" · ") ? m.slice(m.indexOf(" · ") + 3) : "";
    case "task.created": case "task.ready": { const t = e.data?.task || e.ref; const x = t && m.startsWith(t + " ") ? m.slice(t.length + 1) : m; return x.replace(/: everything it waits on is done$/, "").replace(/ → [\w.-]+( after .*)?$/, ""); }
    case "task.assigned": return "";
    case "kb.added": return m.replace(/^\[\w+\]\s*/, "");
    case "session.joined": case "session.left": return m.replace(new RegExp(`^${e.from.replace(/\./g, "\\.")} (joined|returned|left):? ?`), "");
    case "control.pause": case "control.resume": return /^\S+ (pause|resume)d \S+$/.test(m) ? "" : m;
    case "turn.pass": case "turn.take": return /hands the turn to|takes the turn$/.test(m) ? "" : m;
    default: return m;
  }
}

// ── toasts (with Undo) ───────────────────────────────────────────────────────
export function toast(t, o = {}) {
  if (typeof o === "boolean") o = { bad: o };
  const box = $("#toasts"); if (!box) return;
  const el = document.createElement("div");
  el.className = "toast hr-toast " + (o.bad ? "hr-toast-bad" : "hr-toast-good");
  el.setAttribute("role", o.bad ? "alert" : "status");
  el.innerHTML = `<span class="ink">${I(o.bad ? "alert" : "check", "size-4")}</span><span class="min-w-0 flex-1">${esc(t)}</span>${o.undo ? `<button class="btn btn-sm" data-undo>${I("undo", "size-3.5")}Undo</button>` : ""}<button class="btn btn-ghost btn-icon" data-x aria-label="Dismiss">${I("x", "size-3.5")}</button>`;
  while (box.children.length >= 4) box.firstElementChild.remove();
  box.append(el);
  try { if (box.matches(":popover-open")) box.hidePopover(); box.showPopover(); } catch {}
  const kill = () => { clearTimeout(tm); el.classList.add("out"); setTimeout(() => el.remove(), 180); };
  const tm = setTimeout(kill, o.undo ? 8000 : o.bad ? 6000 : 3000);
  el.querySelector("[data-x]").onclick = kill;
  const u = el.querySelector("[data-undo]"); if (u) u.onclick = () => { kill(); o.undo(); };
}

// ── dialogs and drawers: modal (focus stays inside), Esc closes, focus returns to the trigger ──
const RET = new WeakMap();
export function openDlg(d, trigger) {
  if (!d.open) { RET.set(d, trigger || document.activeElement); d.showModal(); }
}
export function closeDlg(d) { if (d.open) d.close(); }
for (const d of document.querySelectorAll("dialog")) {
  d.addEventListener("close", () => {
    const t = RET.get(d); RET.delete(d);
    const back = t && t.isConnected && !t.closest("dialog:not([open])") ? t : $("#main");
    // a drawer that closes because another one opened keeps the focus in the new one
    setTimeout(() => { if (!document.querySelector("dialog[open]")) back?.focus?.({ preventScroll: true }); }, 0);
  });
  d.addEventListener("click", e => { if (e.target === d) d.close(); }); // click on the scrim
}
// ── fuzzy match: every word must match (substring best, then subsequence) ─────
export function fuzzy(q, s) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean); s = String(s).toLowerCase();
  let total = 0;
  for (const w of words) {
    const i = s.indexOf(w);
    if (i >= 0) { total += 60 + w.length * 4 - Math.min(i, 30) + (i === 0 || /[\s.\-_/:]/.test(s[i - 1]) ? 25 : 0); continue; }
    let si = 0, sc = 0, last = -2;
    for (const ch of w) { const j = s.indexOf(ch, si); if (j < 0) return -1; sc += j === last + 1 ? 3 : 1; if (j === 0 || /[\s.\-_/]/.test(s[j - 1])) sc += 2; last = j; si = j + 1; }
    total += sc;
  }
  return total - s.length * 0.02;
}

// ── markdown (inline + blocks) and the highlighter ───────────────────────────
export function md(s) {
  let e = esc(s);
  e = e.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\bhttps?:\/\/[^\s<)]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  return e;
}
export const paras = s => String(s ?? "").split(/\n{2,}/).filter(x => x.trim()).map(p => `<p>${md(p).replace(/\n/g, "<br>")}</p>`).join("") || `<p class="hint">—</p>`;
export function mdBlock(src) {
  const out = []; let list = null, fence = null, para = [], quote = false;
  const flush = () => { if (para.length) { const h = md(para.join(" ")); out.push(quote ? `<blockquote class="border-l-2 border-line2 pl-3 text-muted">${h}</blockquote>` : `<p>${h}</p>`); para = []; } };
  let table = null;
  const cells = l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
  const endTable = () => { if (table) { const [h, ...rows] = table; out.push(`<div class="my-2 overflow-x-auto"><table class="w-full text-left text-[13px]"><thead><tr class="border-b border-line">${h.map(c => `<th class="px-2 py-1.5 font-semibold">${md(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr class="border-b border-line/60 align-top">${r.map(c => `<td class="px-2 py-1.5">${md(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`); table = null; } };
  const close = () => { flush(); endTable(); if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(src ?? "").replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const l = raw.replace(/\s+$/, ""); let m;
    if (fence) { if (/^```/.test(l)) { out.push(codeBlock(fence.lines.join("\n"), fence.lang, 1, "my-2 rounded-lg border border-line")); fence = null; } else fence.lines.push(raw); continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) { if (!table) { close(); table = []; } if (!/^[\s|:-]+$/.test(l)) table.push(cells(l)); continue; }
    if (table) endTable();
    if (list && /^\s{2,}\S/.test(raw) && !/^\s*([-*]|\d+\.)\s/.test(l)) { out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, " " + md(l.trim()) + "</li>"); continue; }
    if ((m = /^```(\w*)/.exec(l))) { close(); fence = { lang: m[1], lines: [] }; continue; }
    if (!l.trim()) { close(); continue; }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) { close(); const n = Math.min(m[1].length + 1, 4); out.push(`<h${n}>${md(m[2])}</h${n}>`); continue; }
    if ((m = /^(\s*)[-*]\s+(.*)$/.exec(l))) { if (list !== "ul") { close(); out.push(`<ul>`); list = "ul"; } out.push(`<li style="margin-left:${m[1].length * 8}px">${md(m[2])}</li>`); continue; }
    if ((m = /^\s*\d+\.\s+(.*)$/.exec(l))) { if (list !== "ol") { close(); out.push(`<ol>`); list = "ol"; } out.push(`<li>${md(m[1])}</li>`); continue; }
    const q = /^\s*>\s?(.*)$/.exec(l);
    if (list || (para.length && !!q !== quote)) close();
    quote = !!q; para.push(q ? q[1] : l.trim());
  }
  if (fence) out.push(codeBlock(fence.lines.join("\n"), fence.lang, 1, "my-2 rounded-lg border border-line"));
  close(); return `<div class="prose-h">${out.join("")}</div>`;
}
// hcl yaml sh nix make json ts — small, offline, good enough
function hl(code, lang) {
  const L2 = (lang || "").toLowerCase(), out = [];
  for (const line of String(code).split("\n")) {
    let e = esc(line), cm = "";
    const ci = commentIdx(line, L2);
    if (ci >= 0) { cm = `<span class="hc">${esc(line.slice(ci))}</span>`; e = esc(line.slice(0, ci)); }
    e = e.replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;|'[^']*')/g, '<span class="hs">$1</span>');
    if (L2 === "hcl" || L2 === "tf" || L2 === "terraform") e = e.replace(/^(\s*)(resource|module|variable|output|locals|provider|data|terraform|required_providers|backend|dynamic|for_each|count|depends_on|lifecycle)\b/, '$1<span class="hk">$2</span>').replace(/^(\s*)([\w-]+)(\s*=)/, '$1<span class="hv">$2</span>$3');
    else if (L2 === "yaml" || L2 === "yml") e = e.replace(/^(\s*-?\s*)([\w./@-]+)(:)(?=\s|$)/, '$1<span class="hv">$2</span>$3');
    else if (L2 === "nix") e = e.replace(/\b(let|in|with|inherit|rec|import|if|then|else)\b/g, '<span class="hk">$1</span>').replace(/^(\s*)([\w.-]+)(\s*=)/, '$1<span class="hv">$2</span>$3');
    else if (L2 === "make" || L2 === "makefile") e = e.replace(/^([\w.-]+)(:)/, '<span class="hk">$1</span>$2').replace(/(\$\([^)]*\))/g, '<span class="hp">$1</span>');
    else if (/^(sh|bash|shell|zsh)$/.test(L2)) e = e.replace(/^(\s*)(make|ssh|curl|kubectl|docker|nix|git|export|cd|bun|npm|npx|node|huddle|huddle-mcp|claude)\b/, '$1<span class="hk">$2</span>').replace(/(\s)(--?[\w-]+)/g, '$1<span class="hp">$2</span>');
    else if (/^(ts|js|typescript|javascript)$/.test(L2)) e = e.replace(/\b(const|let|var|function|return|if|else|for|while|import|export|from|async|await|new|class|type)\b/g, '<span class="hk">$1</span>');
    else if (L2 === "json") e = e.replace(/(<span class="hs">&quot;[^<]*&quot;<\/span>)(\s*:)/g, m => m.replace('class="hs"', 'class="hv"'));
    e = e.replace(/(^|[\s=:\[,(])(\d+(?:\.\d+)*)(?=[\s,\]);]|$)/g, '$1<span class="hn">$2</span>').replace(/\b(true|false|null)\b/g, '<span class="hn">$1</span>');
    out.push(e + cm);
  }
  return out;
}
function commentIdx(line, L2) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q && line[i - 1] !== "\\") q = null; continue; }
    if (c === '"' || (c === "'" && L2 !== "hcl" && L2 !== "make")) q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1])) && !/^(json|ts|js)$/.test(L2)) return i;
    else if (c === "/" && line[i + 1] === "/" && /^(hcl|ts|js)$/.test(L2)) return i;
  }
  return -1;
}
export const codeBlock = (code, lang, from = 1, cls = "") => `<pre class="code ${cls}">${hl(code, lang).map((l, i) => `<span class="ln">${from + i}</span>${l}`).join("\n")}</pre>`;
export const langOf = p => /\.tf$|\.hcl$|\.tftest/.test(p) ? "hcl" : /\.ya?ml$/.test(p) ? "yaml" : /\.nix$/.test(p) ? "nix" : /Makefile$/.test(p) ? "make" : /\.json$/.test(p) ? "json" : /\.sh$/.test(p) ? "sh" : /\.[jt]sx?$/.test(p) ? "ts" : "";
export const skel = (rows = 4, cls = "h-14") => `<div class="flex flex-col gap-2" aria-busy="true" aria-label="Loading">${Array.from({ length: rows }, () => `<div class="skel ${cls}"></div>`).join("")}</div>`;

// ── dependency picker: chips + search over the plan's tasks ──────────────────
// State lives here (PICK), so a re-render of the surrounding view keeps the selection.
const PICK = new Map();
export const pickVal = id => PICK.get(id) || [];
export function pickSet(id, ids) { PICK.set(id, [...ids]); }
export function pickerHTML(id, ids, o = {}) {
  if (ids) PICK.set(id, [...ids]);
  const sel = pickVal(id);
  const chip = t => { const s = S.byId.get(t), k = s ? tState(s) : "blocked"; return `<span class="tag h-7 max-w-full pr-0.5" title="${esc(s ? s.title : "No such task")}">${stIcon(k, "size-3.5")}<span class="font-mono">${esc(t)}</span><span class="max-w-40 truncate">${esc(s ? s.title : "missing")}</span><button type="button" class="inline-flex size-6 items-center justify-center rounded hover:bg-hover" data-pk-rm="${esc(t)}" aria-label="Remove ${esc(t)}">${I("x", "size-3")}</button></span>`; };
  const full = o.max && sel.length >= o.max;
  return `<div class="relative" data-picker="${esc(id)}">
    <div class="flex flex-wrap items-center gap-1 rounded-lg border border-line2 bg-bg p-1 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
      ${sel.map(chip).join("")}
      <input id="${esc(id)}-q" class="h-7 min-w-28 flex-1 bg-transparent px-1.5 text-[13px] outline-none placeholder:text-faint ${full ? "hidden" : ""}" placeholder="${esc(o.placeholder || "Search tasks by id or title")}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${esc(id)}-menu" aria-label="${esc(o.label || "Add a task")}">
    </div>
    <div id="${esc(id)}-menu" class="menu absolute inset-x-0 top-full mt-1 max-h-72 overflow-y-auto" role="listbox" hidden></div></div>`;
}
export function wirePicker(id, o = {}) {
  const root = document.querySelector(`[data-picker="${CSS.escape(id)}"]`); if (!root) return;
  const q = root.querySelector("input"), menu = root.querySelector('[role="listbox"]');
  let items = [], k = 0;
  const repaint = () => { root.outerHTML = pickerHTML(id, null, o); wirePicker(id, o); const n = document.getElementById(id + "-q"); if (n && !n.classList.contains("hidden")) n.focus(); };
  const set = ids => { PICK.set(id, ids); repaint(); o.onChange?.(ids); };
  root.querySelectorAll("[data-pk-rm]").forEach(b => b.onclick = () => set(pickVal(id).filter(x => x !== b.dataset.pkRm)));
  const show = () => {
    const v = q.value.trim(), sel = new Set(pickVal(id));
    const pool = (S.board?.steps || []).filter(s => !sel.has(s.id) && s.id !== o.exclude);
    items = (v ? pool.map(s => [fuzzy(v, s.id + " " + s.title), s]).filter(x => x[0] >= 0).sort((a, b) => b[0] - a[0]).map(x => x[1]) : pool.filter(s => !FIN.has(s.status))).slice(0, 8);
    k = 0;
    menu.innerHTML = items.map((s, i) => `<button type="button" role="option" id="${esc(id)}-o${i}" data-i="${i}" aria-selected="${i === k}" class="${i === k ? "bg-hover" : ""}">${stIcon(tState(s), "size-3.5")}<span class="tid">${esc(s.id)}</span><span class="truncate">${esc(s.title)}</span></button>`).join("") || `<p class="hint px-2 py-1.5">${v ? "No task matches." : "No open tasks."}</p>`;
    menu.hidden = false; q.setAttribute("aria-expanded", "true"); q.setAttribute("aria-activedescendant", items.length ? `${id}-o0` : "");
    menu.querySelectorAll("[data-i]").forEach(b => b.onmousedown = e => { e.preventDefault(); pick(+b.dataset.i); });
  };
  const hl2 = () => { menu.querySelectorAll("[data-i]").forEach((b, i) => { b.classList.toggle("bg-hover", i === k); b.setAttribute("aria-selected", String(i === k)); if (i === k) b.scrollIntoView({ block: "nearest" }); }); q.setAttribute("aria-activedescendant", `${id}-o${k}`); };
  const pick = i => { const s = items[i]; if (!s) return; set([...pickVal(id), s.id]); };
  q.onfocus = show; q.oninput = show;
  q.onblur = () => setTimeout(() => { menu.hidden = true; q.setAttribute("aria-expanded", "false"); }, 120);
  q.onkeydown = e => {
    if (e.key === "ArrowDown") { e.preventDefault(); k = Math.min(k + 1, items.length - 1); hl2(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); k = Math.max(k - 1, 0); hl2(); }
    else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { if (!menu.hidden && items[k]) { e.preventDefault(); e.stopPropagation(); pick(k); } }
    else if (e.key === "Escape") { if (!menu.hidden) { e.stopPropagation(); e.preventDefault(); menu.hidden = true; } }
    else if (e.key === "Backspace" && !q.value && pickVal(id).length) set(pickVal(id).slice(0, -1));
  };
}

// a small menu anchored to a button (theme, "Add section", board "Move to", bottom bar)
export function popMenu(btn, items, dir = "down") {
  $("#popmenu")?.remove();
  const m = document.createElement("div");
  m.id = "popmenu"; m.className = "menu fixed"; m.setAttribute("role", "menu");
  m.innerHTML = items.map((it, i) => `<button role="${it.checked != null ? "menuitemradio" : "menuitem"}" ${it.checked != null ? `aria-checked="${it.checked}"` : ""} data-i="${i}">${it.icon ? I(it.icon, "size-4 text-faint") : ""}${it.html || esc(it.label)}<span class="flex-1"></span>${it.checked ? I("check", "size-4") : it.badge || ""}</button>`).join("");
  (btn.closest("dialog") || document.body).append(m);
  const r = btn.getBoundingClientRect(), w = m.offsetWidth;
  m.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
  if (dir === "up") m.style.bottom = `${innerHeight - r.top + 6}px`; else m.style.top = `${Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8)}px`;
  btn.setAttribute("aria-expanded", "true");
  (m.querySelector('[aria-checked="true"]') || m.querySelector("button"))?.focus();
  const close = (refocus) => { m.remove(); btn.setAttribute("aria-expanded", "false"); document.removeEventListener("click", outside, true); if (refocus) btn.focus(); };
  const outside = e => { if (!m.contains(e.target)) close(false); };
  setTimeout(() => document.addEventListener("click", outside, true));
  m.onkeydown = e => {
    const bs = $$("button", m), i = bs.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === "Tab") close(false);
    else if (e.key === "ArrowDown") { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
    else if (e.key === "Home") { e.preventDefault(); bs[0].focus(); } else if (e.key === "End") { e.preventDefault(); bs.at(-1).focus(); }
  };
  $$("[data-i]", m).forEach(b => b.onclick = () => { close(true); items[+b.dataset.i].run(); });
}

// tabs (role=tablist): arrow keys move between tabs, the selected one is the only tab stop
export function wireTabs(list, onPick) {
  if (!list) return;
  const tabs = $$('[role="tab"]', list);
  tabs.forEach((t, i) => {
    t.tabIndex = t.getAttribute("aria-selected") === "true" ? 0 : -1;
    t.onclick = e => { e.preventDefault(); onPick(t.dataset.tab, t); };
    t.onkeydown = e => {
      const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
      if (n == null) return; e.preventDefault(); const x = tabs[(n + tabs.length) % tabs.length]; x.focus(); onPick(x.dataset.tab, x);
    };
  });
}

// toasts stay above dialogs opened after them (both live in the top layer, stacked in show order)
new MutationObserver(() => { const box = document.getElementById("toasts"); if (box?.children.length) try { box.hidePopover(); box.showPopover(); } catch {} })
  .observe(document.body, { attributes: true, attributeFilter: ["open"], subtree: true });
