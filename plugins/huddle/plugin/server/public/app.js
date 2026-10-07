// app.js — Huddle's owner UI: routing, the chrome (channel switcher, sidebar, bottom bar, theme),
// Home (every channel), Knowledge and Settings. The other destinations live in inbox.js, team.js
// and work.js; the composer in compose.js; the palette and the keyboard in cmd.js.
// No framework, no build step for the JS: hash routes, one fetch per view, and the live stream
// (data.js) patches the cached data instead of refetching on a timer.
import { $, $$, esc, enc, LS, S, cu, href, api, op, act, tsEl, soon, copy, preserve, I, FIN, STATM, SSTM, sStatus, tState, av, toast, fuzzy, md, mdBlock, codeBlock,
  skel, popMenu, openDlg, closeDlg, hasOrch, ago, announce, hrPill, hrStat, hrEmpty, hrTick, hrCountUp, areaChart, isSignedOut } from "./core.js";
import * as D from "./data.js";
import * as Inbox from "./inbox.js";
import * as Team from "./team.js";
import * as Work from "./work.js";
import * as K from "./cmd.js";
import * as KB from "./kb.js";
import * as X from "./extras.js";

// signed out, the page is the sign-in card: views that finish loading later paint into a detached node
const main = () => $("#main") || document.createElement("main");
export const MAIN_CLS = "relative min-h-0 min-w-0 flex-1 overflow-y-auto outline-none";
let RT = 0; // route token: a slower, older view never paints over a newer one
export const routeTok = () => RT;

// ── routes ───────────────────────────────────────────────────────────────────
export const DESTS = [["inbox", "Inbox", "inbox", "i"], ["team", "Team", "users", "t"], ["work", "Work", "list", "w"], ["knowledge", "Knowledge", "book", "k"], ["settings", "Settings", "sliders", "s"]];
// the path part of the hash (without a drawer) and the drawer links built on it
export const path = () => location.hash.split("?")[0] || "#/";
export const taskHref = id => `${S.ch && path().startsWith(`#/c/${S.ch}/`) ? path() : href("/work")}?t=${enc(id)}`;
export const sessHref = n => `${S.ch && path().startsWith(`#/c/${S.ch}/`) ? path() : href("/team")}?s=${enc(n)}`;
export function go(h) { if (location.hash === h) route(); else location.hash = h; }
export const openTask = id => go(taskHref(id));
export const openSession = n => go(sessHref(n));
export const closeDrawer = () => { if (location.hash.includes("?")) go(path()); };

// route aliases (bookmarks, notifications, links in agents' context) redirect to the destinations
function redirect(ch, p) {
  const [v, ...rest] = p, a = rest.join("/");
  const work = LS.get("wview:" + ch, "list");
  if (v === "needs") return "inbox";
  if (v === "live") return "team";
  if (v === "plan") { const m = /^p\/(-?\d+)$/.exec(a); if (m) LS.set("wphase:" + ch, Number(m[1])); return "work/list"; }
  if (v === "board" || v === "graph") return "work/" + v;
  if (v === "review") { LS.set("wfilter:" + ch, "notes"); return "work/list"; }
  if (v === "kb") return "knowledge" + (a ? "/" + a : "");
  if (v === "repo") return "work/repo" + (a ? "/" + a : "");
  if (v === "t" && a) return `work/${work}?t=${enc(a)}`;
  return null;
}
async function route() {
  if (isSignedOut()) return;
  const tok = ++RT;
  const [hp, qs] = location.hash.replace(/^#\/?/, "").split("?");
  const q = new URLSearchParams(qs || "");
  const parts = hp.split("/").filter(Boolean).map(x => { try { return decodeURIComponent(x); } catch { return x; } });
  $("#popmenu")?.remove();
  if (parts[0] !== "c" || !parts[1]) { for (const d of $$("dialog[open]")) d.close(); S.dest = "home"; S.key = "home"; return homeView(tok); }
  const ch = parts[1];
  const r = redirect(ch, parts.slice(2));
  if (r) { history.replaceState(null, "", `#/c/${ch}/${r}`); return route(); }
  if (ch !== S.ch) {
    for (const d of $$("dialog[open]")) d.close();
    main().className = MAIN_CLS; main().innerHTML = `<div class="mx-auto max-w-4xl p-6">${skel(5)}</div>`;
    if (!(await openChannel(ch, tok))) return;
    if (tok !== RT) return;
  }
  let dest = parts[2];
  if (dest !== "overview" && dest !== "today" && !DESTS.some(d => d[0] === dest)) {
    dest = "overview"; // the channel's home: the at-a-glance view below
    history.replaceState(null, "", `#/c/${ch}/${dest}${qs ? "?" + qs : ""}`);
  }
  const sub = parts.slice(3), key = `${ch}/${dest}/${sub.join("/")}`;
  if (key !== S.key) {
    for (const d of $$("dialog[open]")) if (!/drawer$/.test(d.id)) d.close();
    S.key = key; S.dest = dest; S.sub = sub; S.repaint = null; OVCHART = null;
    renderNav();
    main().className = MAIN_CLS; main().scrollTop = 0;
    main().innerHTML = `<div class="mx-auto max-w-5xl p-4 sm:p-6">${skel(6)}</div>`;
    try { await ({ overview: overviewView, today: X.todayView, inbox: Inbox.view, team: Team.view, work: Work.view, knowledge: kbView, settings: settingsView })[dest](sub, tok); }
    catch (e) { console.error(e); if (tok === RT) main().innerHTML = `<div class="empty">${I("alert", "size-6 text-red-ink")}<b>This view did not load</b>${esc(e.message)}. Reload the page to try again.</div>`; }
    if (tok !== RT) return;
  }
  // drawers: ?t=<task> or ?s=<session>, over whatever view is open
  const t = q.get("t"), s = q.get("s");
  if (t) Work.openDrawer(t); else Work.closeDrawer();
  if (s && !t) Team.openDrawer(s); else Team.closeDrawer();
}
window.onhashchange = route;

async function openChannel(ch, tok) {
  D.disconnect();
  Object.assign(S, { ch, info: null, board: null, byId: new Map(), sess: null, tl: null, att: null, key: null });
  try { [S.info] = await Promise.all([api(cu("")), D.loadAtt()]); }
  catch (e) {
    if (tok !== RT) return false;
    S.ch = null; renderChrome();
    main().innerHTML = `<div class="empty mx-auto max-w-lg py-20">${I("hash", "size-8")}<h1 class="h1 text-fg">No channel “${esc(ch)}”</h1><p>A session's first <code>join</code> creates a channel, or you can create one on the <a class="link" href="#/">channels page</a>.</p></div>`;
    return false;
  }
  if (tok !== RT) return false;
  renderChrome();
  if (!S.channels) api("/api/channels").then(c => { S.channels = c; }).catch(() => {});
  D.connect();
  await Promise.all([D.loadSess(), D.loadBoard().catch(() => {})]);
  return true;
}

// ── chrome: channel switcher, sidebar, bottom bar, title ─────────────────────
D.onChange(what => { stamp(); if (["att", "sess", "board", "info"].includes(what)) soon("nav", renderNav, 50); });
function renderChrome() {
  $("#chbox").hidden = !S.ch;
  if (S.ch) $("#chname").textContent = S.info?.config?.title || S.ch;
  renderNav();
}
$("#chbtn").onclick = () => {
  const list = (S.channels || []).filter(c => c.name !== S.ch);
  popMenu($("#chbtn"), [...list.map(c => ({ label: c.title || c.name, icon: "hash", run: () => go(`#/c/${c.name}`) })), { label: "All channels", icon: "layers", run: () => go("#/") }]);
};

// ── the top bar's STATUS ● pill and Updated stamp ────────────────────────────
// data.js paints #ldot (class + dot) from the stream state; this repaints it as a dot and a
// word: mint pulsing when live, amber while reconnecting. Its role, aria-label and title are
// data.js's.
const LDOT = $("#ldot");
let liveKey = "";
const livePaint = () => {
  if (LDOT.className === liveKey) return; // our own rewrite settled; wait for data.js's next
  const [k, w] = /\bc-green\b/.test(LDOT.className) ? ["hr-live-ok", "Live"]
    : /\bc-peach\b/.test(LDOT.className) ? ["hr-live-warn", "Reconnecting"] : ["", "Connecting…"];
  liveKey = ("hr-live " + k).trim();
  LDOT.className = liveKey;
  LDOT.innerHTML = `<i class="hr-live-dot"></i><span>${w}</span>`;
};
new MutationObserver(livePaint).observe(LDOT, { attributes: true, attributeFilter: ["class"], childList: true });
livePaint();
const LUPD = document.createElement("span");
LUPD.id = "lupd"; LUPD.className = "hr-updated ml-1 hidden lg:inline";
LDOT.after(LUPD);
function stamp() { LUPD.textContent = "Updated " + new Date().toTimeString().slice(0, 8); }
export function renderNav() {
  const side = $("#side"), bn = $("#bnav"), n = D.inboxCount();
  document.title = `${n ? `(${n}) ` : ""}${S.ch ? `${S.info?.config?.title || S.ch} · ` : ""}Huddle`;
  if (!S.ch || S.dest === "home") { side.hidden = bn.hidden = true; return; }
  side.hidden = bn.hidden = false;
  $("#chname").textContent = S.info?.config?.title || S.ch;
  const ss = (S.sess?.sessions || []).filter(s => s.state !== "left"), tops = ss.filter(s => !s.parent);
  const steps = S.board?.steps || [], open = steps.filter(s => !FIN.has(s.status)).length;
  const count = k => k === "inbox" ? (n ? `<span class="nb ml-auto" aria-hidden="true">${n}</span>` : "")
    : k === "team" ? (ss.length ? `<span class="tnum ml-auto text-xs text-faint" aria-hidden="true">${ss.length}</span>` : "")
    : k === "work" ? (open ? `<span class="tnum ml-auto text-xs text-faint" aria-hidden="true">${open}</span>` : "") : "";
  const sr = k => k === "inbox" ? (n ? `, ${n} need${n === 1 ? "s" : ""} you` : ", all clear") : k === "team" ? `, ${ss.length} online` : k === "work" ? `, ${open} open tasks` : "";
  side.innerHTML = `<div class="flex flex-col gap-0.5" role="list"><a role="listitem" class="nav-i" href="${href("/overview")}" ${S.dest === "overview" ? `aria-current="page"` : ""}>${I("columns")}Overview<span class="sr-only">: the channel at a glance</span></a><a role="listitem" class="nav-i" href="${href("/today")}" ${S.dest === "today" ? `aria-current="page"` : ""}>${I("clock")}Today<span class="sr-only">: what got done, per session</span></a>${DESTS.map(([k, l, ic]) => `<a role="listitem" class="nav-i" href="${href("/" + k)}" ${S.dest === k ? `aria-current="page"` : ""}><span class="${k === "inbox" && n ? "text-mauve-ink" : ""}">${I(ic)}</span>${l}<span class="sr-only">${sr(k)}</span>${count(k)}</a>`).join("")}</div>
    ${tops.length ? `<section aria-labelledby="sb-team"><h2 id="sb-team" class="sec-t px-2.5 pb-1">Sessions</h2><ul class="flex flex-col">${tops.map(s => { const k = sStatus(s), m = SSTM[k]; return `<li><a class="nav-i h-8 font-normal" href="${sessHref(s.name)}"><span class="${m.c} ink">${I(m.i, "size-3.5")}</span><span class="min-w-0 flex-1 truncate">${esc(s.name)}</span><span class="sr-only">: ${m.l}</span>${isOrch(s.name) ? `<span class="text-faint" title="Orchestrator">${I("baton", "size-3.5")}<span class="sr-only">, orchestrator</span></span>` : ""}${s.holds_turn ? `<span class="text-faint" title="Holds the turn">${I("turn", "size-3.5")}<span class="sr-only">, holds the turn</span></span>` : ""}</a></li>`; }).join("")}</ul></section>` : ""}
    ${steps.length ? `<section class="mt-auto flex flex-col gap-1.5 px-2.5" aria-label="Progress">${progressBar(steps)}<span class="hint tnum">${steps.filter(s => FIN.has(s.status)).length} of ${steps.length} tasks done</span></section>` : ""}`;
  bn.innerHTML = DESTS.map(([k, l, ic]) => `<a class="bnav-i" href="${href("/" + k)}" ${S.dest === k ? `aria-current="page"` : ""}>${I(ic, "size-5")}<span>${l}<span class="sr-only">${sr(k)}</span></span>${k === "inbox" && n ? `<span class="nb absolute top-1.5 left-1/2 ml-1.5" aria-hidden="true">${n}</span>` : ""}</a>`).join("");
}
export const isOrch = n => !!n && S.info?.config?.orchestrator === n;
// one segmented bar: done · doing · waiting · blocked · to do; a zero never draws
export function progressBar(steps, label = true) {
  const t = steps.length || 1, c = k => steps.filter(s => (k === "done" ? FIN.has(s.status) : tState(s) === k)).length;
  const seg = [["done", "hr-tint-good"], ["doing", "hr-tint-warn"], ["waiting", "c-peach"], ["blocked", "hr-tint-bad"]].map(([k, cl]) => [k, cl, c(k)]).filter(x => x[2]);
  const txt = seg.map(([k, , n]) => `${n} ${k === "done" ? "done" : STATM[k].l.toLowerCase()}`).join(", ") + `, ${steps.length} in all`;
  return `<div class="hr-bar" role="img" aria-label="${label ? "Progress: " : ""}${esc(txt)}" title="${esc(txt)}">${seg.map(([, cl, n]) => `<i class="hr-bar-fill ${cl}" style="width:${(n / t * 100).toFixed(3)}%"></i>`).join("")}</div>`;
}

// ── theme: System (default) · Light · Dark, kept per browser ─────────────────
const mq = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => { const t = LS.get("theme", "system"); document.documentElement.dataset.theme = t === "light" || t === "dark" ? t : mq.matches ? "dark" : "light"; paintThemeBtn(); };
const THEMES = [["system", "System", "monitor"], ["light", "Light", "sun"], ["dark", "Dark", "moon"]];
const paintThemeBtn = () => { const t = LS.get("theme", "system"), m = THEMES.find(x => x[0] === t) || THEMES[0]; $("#theme").innerHTML = I(m[2]); $("#theme").setAttribute("aria-label", `Theme: ${m[1]}`); $("#theme").title = `Theme: ${m[1]}`; };
export function setTheme(t) { LS.set("theme", t); applyTheme(); $$("[data-theme-set]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.themeSet === t))); }
export const toggleTheme = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
mq.addEventListener?.("change", () => { if (LS.get("theme", "system") === "system") applyTheme(); });
$("#theme").onclick = () => popMenu($("#theme"), THEMES.map(([k, l, ic]) => ({ label: l, icon: ic, checked: LS.get("theme", "system") === k, run: () => setTheme(k) })));
applyTheme();

// ── modal helper ─────────────────────────────────────────────────────────────
export function openModal(title, html, trigger) { $("#mtitle").textContent = title; $("#mbody").innerHTML = html; openDlg($("#modal"), trigger); }
$("#mclose").onclick = () => closeDlg($("#modal"));

// ── Overview: the channel at a glance — hero, stat cards, activity chart ──────
let OVWIN = "15m", OVCHART = null; // the activity window (kept per channel) and the live chart
const OVV = { "15m": [15, 15], "1h": [60, 12], "24h": [1440, 24] }; // [window in minutes, bins]
const ovVals = () => {
  const steps = S.board?.steps || [], fin = steps.filter(s => FIN.has(s.status)).length,
    ss = (S.sess?.sessions || []).filter(s => s.state !== "left"), c = k => steps.filter(s => tState(s) === k).length;
  return { done: fin, total: steps.length, phases: S.board?.phases?.length || 0, pct: steps.length ? Math.round(fin / steps.length * 100) : 0,
    live: ss.length, tops: ss.filter(s => !s.parent).length, doing: c("doing"), waiting: c("waiting"), blocked: c("blocked"), todo: c("todo"),
    asks: S.att?.asks?.length || 0, kb: S.info?.stats?.knowledge || 0, ev: Math.max(S.info?.stats?.last || 0, S.tl?.at(-1)?.seq || 0) };
};
const ovSub = v => v.total ? `${v.pct}% of the plan${v.phases ? ` across ${v.phases} phase${v.phases === 1 ? "" : "s"}` : ""}` : "Nothing planned yet";
const ovTexts = v => ({ sub: ovSub(v), livesub: v.live ? `${v.tops} top-level, ${v.live - v.tops} subagent${v.live - v.tops === 1 ? "" : "s"}` : "Nobody online", asksub: v.asks ? "Waiting in your Inbox" : "All answered" });
// the ring: a circle of circumference 100, so the dash is the percentage
const ring = (pct, c = "size-24") => `<svg class="hr-ring ${c}" viewBox="0 0 36 36" role="img" aria-label="${pct}% of the tasks done"><circle class="track" cx="18" cy="18" r="15.9155"/><circle class="meter" data-ovring cx="18" cy="18" r="15.9155" stroke-dasharray="${pct} 100" transform="rotate(-90 18 18)" ${pct ? "" : `style="display:none"`}/><text x="18" y="21" text-anchor="middle" data-ovpct>${pct}%</text></svg>`;
// the plan's breakdown beside the ring: one bar per state that is not done, over all tasks
const ovRows = v => [["doing", "Doing", "hr-tint-warn", "in progress"], ["waiting", "Waiting on others", "c-peach", "on dependencies"], ["blocked", "Blocked", "hr-tint-bad", "need a hand"], ["todo", "To do", "hr-tint-muted", "ready to start"]].map(([k, l, t, cap]) =>
  `<div class="${t}"><div class="flex items-center justify-between gap-3 text-[13px]"><span class="text-muted">${l}</span><span class="font-medium tabular-nums">${v[k]}</span></div>
   <div class="hr-bar mt-1.5"><i class="hr-bar-fill" style="width:${v.total ? (v[k] / v.total * 100).toFixed(1) : 0}%;background:var(--c)"></i></div><p class="mt-1 text-xs text-muted">${cap}</p></div>`).join("");
// what needs the owner, as one line and one button; nothing when nothing does
function ovNeeds() {
  const A = S.att || {}, n = D.inboxCount(); if (!n) return "";
  const parts = [[A.asks, "question"], [A.gates, "approval"], [A.paused, "paused session"], [A.blocked, "blocked task"]].filter(([l]) => l?.length).map(([l, w]) => `${l.length} ${w}${l.length > 1 ? "s" : ""}`);
  if (X.needsText()) parts.push(...X.needsText().split(" · "));
  return `<section class="c-mauve flex flex-col gap-3 rounded-[10px] border p-4 sm:flex-row sm:items-center" style="border-color:color-mix(in srgb,var(--mauve) 32%,var(--panel));background:color-mix(in srgb,var(--mauve) 8%,var(--panel))" aria-labelledby="ov-needs">
    <span class="hr-stat-icon c-mauve">${I("inbox")}</span><div class="min-w-0 flex-1"><h2 class="text-[14px] font-semibold" id="ov-needs">${n} thing${n > 1 ? "s" : ""} need${n === 1 ? "s" : ""} you</h2><p class="text-[13px] text-muted">${esc(parts.join(", "))}.</p></div>
    <a class="btn btn-pri" href="${href("/inbox")}">Open Inbox</a></section>`;
}
function ovTopHTML() {
  const v = ovVals();
  return `<div id="ovneeds">${ovNeeds()}</div>
    <section class="hr-card-feature flex flex-col gap-6 p-5 md:flex-row md:items-center md:gap-8" aria-labelledby="ov-plan">
      <div class="flex items-center gap-5">${ring(v.pct)}<div class="hr-hero"><h2 class="hr-label" id="ov-plan">Plan progress</h2>
        <p class="flex items-baseline gap-1.5"><span class="hr-hero-num" data-ov="done" data-count="${v.done}">${v.done}</span><span class="text-lg text-muted tabular-nums">of <span data-ov="total">${v.total}</span> tasks done</span></p>
        <p class="hr-hero-sub" data-ovtxt="sub">${ovSub(v)}</p></div></div>
      <div class="grid min-w-0 flex-1 gap-3 sm:grid-cols-2 md:border-l md:border-line md:pl-8" id="ovrows">${ovRows(v)}</div></section>
    <div class="hr-stats">
      ${hrStat({ icon: "users", tint: "hr-tint-violet", label: "Sessions online", value: v.live, sub: ovTexts(v).livesub, ov: "live", subov: "livesub" })}
      ${hrStat({ icon: "ask", tint: "c-mauve", label: "Questions for you", value: v.asks, sub: ovTexts(v).asksub, ov: "asks", subov: "asksub" })}
      ${hrStat({ icon: "book", tint: "hr-tint-info", label: "Knowledge", value: v.kb, ov: "kb", sub: "Entries the sessions share" })}
      ${hrStat({ icon: "activity", tint: "hr-tint-accent", label: "Events", value: v.ev, ov: "ev", sub: "Published in this channel" })}
    </div>
    <div id="ovext" class="empty:hidden">${X.overviewHTML()}</div>`;
}
// events per minute, binned client-side over the timeline the page already loaded
function ovSeries(win) {
  const [mins, n] = OVV[win], bm = mins / n, now = Date.now(), per = new Array(n).fill(0);
  for (const e of S.tl || []) { const t = Date.parse(e.ts), i = Math.floor((now - t) / 60000 / bm); if (t && i >= 0 && i < n) per[n - 1 - i]++; }
  const fmt = v => v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  const lab = i => { const d = new Date(now - (n - i) * bm * 60000);
    return (win === "24h" ? d.toLocaleDateString([], { weekday: "short" }) + " " : "") + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
  const mid = n >> 1;
  return { series: [{ values: per.map(c => c / bm), label: "Events" }],
    opts: { h: 220, axis: [[0, lab(0)], [mid, lab(mid)], [n - 1, lab(n - 1)]], yfmt: fmt, note: "No activity in this window",
      label: `Events per minute over the last ${win}`, tip: i => [lab(i), `${per[i]} event${per[i] === 1 ? "" : "s"} in the bin · ${fmt(per[i] / bm)}/min`] } };
}
async function overviewView(sub, tok) {
  if (!S.tl) D.loadTL().catch(() => {});
  OVWIN = LS.get("ovwin:" + S.ch, "15m");
  const c = S.info?.config || {};
  main().innerHTML = `<div id="ovwrap" class="mx-auto flex max-w-6xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
    <header class="flex flex-wrap items-end gap-3"><div class="min-w-0 flex-1 max-sm:basis-full"><h1 class="h1">${esc(c.title || S.ch)}</h1><p class="page-sub">${c.description ? esc(c.description) : "The channel at a glance: the plan, the team and what needs you."}</p></div>
      <button class="btn" id="ovmsg">${I("send", "size-4")}Send a message</button></header>
    <div id="ovtop" class="flex flex-col gap-5">${ovTopHTML()}</div>
    <div id="ovconf"></div>
    <section class="hr-card" aria-labelledby="ovact-h">
      <div class="hr-card-head flex-wrap"><div class="min-w-0"><h2 class="hr-label" id="ovact-h">Activity</h2><p class="text-xs text-muted">Events per minute</p></div>
        <div class="hr-seg" role="group" aria-label="Activity window">${Object.keys(OVV).map(k => `<button type="button" class="hr-seg-item ${k === OVWIN ? "hr-seg-on" : ""}" data-win="${k}" aria-pressed="${k === OVWIN}">${{ "15m": "15 min", "1h": "1 hour", "24h": "24 hours" }[k]}</button>`).join("")}</div></div>
      <div class="p-4 pt-3"><div id="ovchart" class="relative"></div></div></section></div>`;
  $("#ovmsg").onclick = e => import("./compose.js").then(C => C.openCompose({ mode: "msg" }, e.currentTarget));
  import("./conflicts.js").then(C => { if (tok === RT) C.mount($("#ovconf")); });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "block w-full");
  $("#ovchart").append(svg);
  const s0 = ovSeries(OVWIN);
  OVCHART = areaChart(svg, s0.series, s0.opts);
  hrCountUp($("#ovwrap"));
  for (const b of $$("[data-win]")) b.onclick = () => {
    OVWIN = b.dataset.win; LS.set("ovwin:" + S.ch, OVWIN);
    for (const x of $$("[data-win]")) { const on = x.dataset.win === OVWIN; x.classList.toggle("hr-seg-on", on); x.setAttribute("aria-pressed", String(on)); }
    const s = ovSeries(OVWIN); OVCHART?.redraw(s.series, s.opts);
  };
  // live: tick the numbers, the ring, the bars and the chart in place, so a hover (and the count-up) survives
  S.repaint = what => {
    if (tok !== RT || S.dest !== "overview" || !["board", "sess", "att", "info", "tl", "event", "task", "ext"].includes(what)) return;
    const v = ovVals(), t = ovTexts(v);
    for (const [k, val] of Object.entries(v)) { const x = $(`[data-ov="${k}"]`); if (x) hrTick(x, val); }
    for (const [k, txt] of Object.entries(t)) { const x = $(`[data-ovtxt="${k}"]`); if (x && x.textContent !== txt) x.textContent = txt; }
    const m = $("[data-ovring]"); if (m) { m.setAttribute("stroke-dasharray", `${v.pct} 100`); m.style.display = v.pct ? "" : "none"; m.closest("svg").setAttribute("aria-label", `${v.pct}% of the tasks done`); }
    const pc = $("[data-ovpct]"); if (pc) pc.textContent = `${v.pct}%`;
    const rows = $("#ovrows"); if (rows) rows.innerHTML = ovRows(v);
    const nd = $("#ovneeds"); if (nd) { const h = ovNeeds(); if (nd.innerHTML !== h) nd.innerHTML = h; }
    const ox = $("#ovext"); if (ox) { const h = X.overviewHTML(); if (ox.innerHTML !== h) ox.innerHTML = h; }
    const s = ovSeries(OVWIN); OVCHART?.redraw(s.series, s.opts);
  };
}

// ── Home: every channel, sorted by what needs you ────────────────────────────
let HOMEPOLL = 0;
async function homeView(tok) {
  D.disconnect(); Object.assign(S, { ch: null, repaint: null, att: null, info: null, sess: null, board: null, tl: null });
  renderChrome();
  main().className = MAIN_CLS; main().scrollTop = 0;
  main().innerHTML = `<div class="mx-auto max-w-4xl p-4 sm:p-6">${skel(3, "h-28")}</div>`;
  const list = await homeData();
  if (tok !== RT || isSignedOut()) return;
  main().innerHTML = `<div class="mx-auto flex max-w-5xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
    <div class="flex flex-wrap items-end gap-3"><div class="min-w-0 flex-1 max-sm:basis-full"><h1 class="h1">Channels</h1><p class="page-sub">Each channel is one team of sessions. The ones that need you come first.</p></div>
      <button class="btn btn-pri" id="newch">${I("plus", "size-4")}New channel</button></div>
    <div id="chlist" aria-label="Channels"></div>
    <section class="hr-card" aria-labelledby="cx-h">${connectHTML(list[0]?.name || "my-channel")}</section></div>`;
  paintChannels(list);
  $("#newch").onclick = e => newChannel(e.currentTarget);
  wireConnect();
  clearInterval(HOMEPOLL);
  HOMEPOLL = setInterval(async () => {
    if (S.dest !== "home") { clearInterval(HOMEPOLL); return; } if (document.hidden) return;
    const l = await homeData(); if (S.dest === "home") paintChannels(l);
  }, 10_000);
}
async function homeData() {
  const list = await api("/api/channels").catch(() => []);
  S.channels = list;
  await Promise.all(list.map(async c => { const a = await api(`/api/c/${enc(c.name)}/attention`).catch(() => null); c.needs = a ? (a.asks?.length || 0) + (a.gates?.length || 0) + (a.paused?.length || 0) + (a.blocked?.length || 0) : 0; c.asks = a?.asks?.length || 0; }));
  return list.sort((a, b) => b.needs - a.needs || (b.stats?.last || 0) - (a.stats?.last || 0) || a.name.localeCompare(b.name));
}
function paintChannels(list) {
  const el = $("#chlist"); if (!el) return;
  const card = c => {
    const st = c.stats || {}, on = c.sessions || [], pct = st.tasks ? Math.round(st.done / st.tasks * 100) : 0;
    return `<a class="hr-card flex flex-col gap-4 p-5 transition-colors hover:border-line2 hover:bg-hover/40" href="#/c/${esc(c.name)}" data-ch="${esc(c.name)}">
      <div class="flex items-start gap-3"><span class="hr-stat-icon hr-tint-accent size-9">${I("hash", "size-4")}</span>
        <div class="min-w-0 flex-1"><div class="flex min-w-0 items-center gap-2"><h2 class="truncate text-[15px] font-semibold">${esc(c.title || c.name)}</h2>${c.title && c.title !== c.name ? `<span class="tid">${esc(c.name)}</span>` : ""}</div>
          <p class="mt-0.5 line-clamp-2 text-[13px] text-muted">${c.description ? esc(c.description) : "No description yet."}</p></div>
        ${c.needs ? hrPill("needs", `${c.needs} need${c.needs === 1 ? "s" : ""} you`) : hrPill("done", "All clear")}</div>
      <div class="mt-auto flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-line pt-4 text-xs text-muted">
        <span class="flex items-center gap-2">${on.length ? `<span class="flex items-center -space-x-1.5">${on.slice(0, 5).map(s => av(s.name, true)).join("")}${on.length > 5 ? `<span class="av av-sm c-idle" title="${on.length - 5} more online">+${on.length - 5}</span>` : ""}</span>${on.length} online` : `${I("users", "size-4 text-faint")}Nobody online`}</span>
        <span class="flex min-w-36 flex-1 items-center gap-2">${st.tasks ? `<span class="hr-bar max-w-40 flex-1" role="img" aria-label="${st.done} of ${st.tasks} tasks done"><i class="hr-bar-fill" style="width:${pct}%"></i></span><span class="tabular-nums">${st.done} of ${st.tasks} tasks</span>` : `${I("list", "size-4 text-faint")}No tasks yet`}</span>
        <span class="flex items-center gap-1.5 tabular-nums" title="Last event">${I("activity", "size-4 text-faint")}${st.last ? `Last event #${st.last}` : "No events yet"}</span></div></a>`;
  };
  el.innerHTML = list.length ? `<div class="grid gap-4 md:grid-cols-2">${list.map(card).join("")}</div>`
    : hrEmpty("No channels yet", "Create one with New channel, or let a session's first join create it.", "layers");
}
function newChannel(trigger) {
  openModal("New channel", `<form id="nch" class="flex flex-col gap-3 p-4" novalidate>
    <label class="label">Name <input class="input" id="nc-name" required pattern="[a-z0-9][a-z0-9\\-]{0,39}" placeholder="checkout-v2" autocomplete="off" aria-describedby="nc-nh nc-err"><span class="help" id="nc-nh">Lowercase letters, digits and dashes. Sessions use it in <code>.agents/huddle/huddle.json</code>.</span></label>
    <label class="label"><span>Title <span class="help">(optional)</span></span><input class="input" id="nc-title" placeholder="Checkout, version 2"></label>
    <label class="label"><span>What the team is doing <span class="help">(optional)</span></span><textarea class="input" id="nc-desc" rows="2"></textarea></label>
    <label class="label"><span>Allowed sessions <span class="help">(optional)</span></span><input class="input" id="nc-members" placeholder="api, web, docs" aria-describedby="nc-mh"><span class="help" id="nc-mh">Leave empty to let any local session join.</span></label>
    <p class="err" id="nc-err" role="alert"></p>
    <div class="flex justify-end gap-2"><button type="button" class="btn btn-ghost" id="nc-cancel">Cancel</button><button class="btn btn-pri" type="submit">Create channel</button></div></form>`, trigger);
  $("#nc-name").focus();
  $("#nc-cancel").onclick = () => closeDlg($("#modal"));
  $("#nch").onsubmit = async e => {
    e.preventDefault();
    const name = $("#nc-name").value.trim(), members = $("#nc-members").value.split(/[\s,]+/).filter(Boolean);
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) { $("#nc-err").textContent = "Use 1 to 40 lowercase letters, digits or dashes, starting with a letter or digit."; $("#nc-name").setAttribute("aria-invalid", "true"); $("#nc-name").focus(); return; }
    try { await api("/api/channels", { body: { name, title: $("#nc-title").value.trim() || undefined, description: $("#nc-desc").value.trim() || undefined, ...(members.length ? { members } : {}) } }); closeDlg($("#modal")); toast(`Created ${name}`); go(`#/c/${name}`); }
    catch (err) { $("#nc-err").textContent = err.message; }
  };
}

// ── Connect a session: install, invite, paste ─────────────────────────────────
const cxStep = (n, title, body) => `<li class="relative flex gap-4 pb-6 last:pb-0"><span class="relative z-10 inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-line2 bg-card text-xs font-semibold tabular-nums text-muted" aria-hidden="true">${n}</span>
  <div class="min-w-0 flex-1 pt-0.5"><h3 class="text-[14px] font-semibold">${title}</h3>${body}</div></li>`;
export function connectHTML(ch, as = "api") {
  return `<div class="hr-card-head" id="cx-h"><div class="flex min-w-0 items-center gap-3"><span class="hr-stat-icon hr-tint-accent">${I("plug", "size-4")}</span><div class="min-w-0"><h2 class="hr-label">Connect a session</h2><p class="text-xs text-muted">Bring another Claude session into <code>${esc(ch)}</code> in three steps.</p></div></div><a class="btn btn-ghost btn-sm shrink-0" href="/connect.md" target="_blank" rel="noopener">Full guide${I("ext", "size-3.5")}<span class="sr-only">(opens in a new tab)</span></a></div>
    <div class="card-b flex flex-col gap-4 p-5">
      <ol class="relative before:absolute before:top-3 before:bottom-3 before:left-3.5 before:w-px before:bg-line">
        ${cxStep(1, "Install Huddle once per machine", `<p class="mt-1 mb-2.5 text-[13px] text-muted">In Claude Code:</p>${cxCode("Claude Code", "/plugin marketplace add MuhmdRaouf/claude-code-plugins\n/plugin install huddle@muhmdraouf", 0)}`)}
        ${cxStep(2, "Invite the session", `<p class="mt-1 mb-2.5 text-[13px] text-muted">A join line for <code>${esc(ch)}</code>, valid 24 h, good for one project (its later sessions are in on their own).</p>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2"><button class="btn" id="cx-invite" data-ch="${esc(ch)}">${I("plus", "size-4")}Invite a session</button><span class="text-xs text-muted" id="cx-inv-note">or run <code>/huddle:invite</code> in a Claude session in this huddle</span></div>
          <div id="cx-inv" class="mt-3 empty:hidden" aria-live="polite"></div>`)}
        ${cxStep(3, "Paste it into the other session", `<p class="mt-1 text-[13px] text-muted">It joins this channel and shows its own dashboard link. Do not run <code>/huddle:setup</code> there: setup is for the first project.</p>`)}
      </ol>
      <details class="rounded-lg border border-line px-3 py-2 text-[13px]"><summary class="cursor-pointer font-medium text-muted hover:text-fg">Other clients (MCP over HTTP)</summary>
        <p class="my-2 text-muted">Any MCP client can call the channel's tools at <code>/mcp/&lt;channel&gt;?as=&lt;session&gt;</code> with a credential in the <code>x-huddle-token</code> header (the one <code>huddle join</code> keeps for a session).</p>
        ${cxCode("claude mcp add", `claude mcp add --transport http huddle "${location.origin}/mcp/${ch}?as=${as}" --header "x-huddle-token: <credential>"`, 1)}</details></div>`;
}
const CX = [];
function cxCode(t, c, i) { CX[i] = c; return `<div class="overflow-hidden rounded-lg border border-line"><div class="flex items-center gap-2 border-b border-line bg-sunken px-3 py-1 text-xs"><span class="min-w-0 flex-1 truncate font-medium text-muted">${esc(t)}</span><button class="btn btn-ghost btn-sm" data-cx="${i}">${I("copy", "size-3.5")}Copy<span class="sr-only"> ${esc(t)}</span></button></div>${codeBlock(c, "sh")}</div>`; }
export function wireConnect() {
  $$("[data-cx]").forEach(b => b.onclick = () => copy(CX[+b.dataset.cx], "Copied. Paste it where the step says."));
  const btn = $("#cx-invite");
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const inv = await api("/api/tokens", { body: { channel: btn.dataset.ch, description: "made in the dashboard" } });
      const line = `/huddle:join ${location.host} --token ${inv.token}`;
      CX[2] = line;
      $("#cx-inv").innerHTML = `${cxCode(`Join line for ${btn.dataset.ch} (valid until ${new Date(inv.expires).toLocaleString()})`, line, 2)}`;
      $$("#cx-inv [data-cx]").forEach(b => b.onclick = () => copy(CX[2], "Copied. Paste it into the other Claude session."));
    } catch (e) {
      $("#cx-inv").innerHTML = `<p class="text-[13px] text-red-ink">${esc(e.status === 403 ? "This browser may not invite (it was signed in by a member). Run /huddle:invite in the Claude session that started Huddle." : e.message)}</p>`;
    } finally { btn.disabled = false; }
  };
}

// ── Knowledge: list + reader; the newest entry opens by default ──────────────
const KB_KINDS = ["fact", "lesson", "decision", "context", "result", "howto"];
const KB_I = { fact: "checkc", lesson: "alert", decision: "flag", context: "file", result: "sparkle", howto: "terminal" };
const KB_L = { fact: "Fact", lesson: "Lesson", decision: "Decision", context: "Context", result: "Result", howto: "How-to" };
const kbTag = k => `<span class="hr-chip hr-tint-violet">${I(KB_I[k] || "book", "size-3.5")}${esc(KB_L[k] || k)}</span>`;
async function kbView(sub, tok) {
  const q = LS.get("kbq:" + S.ch, ""), kind = LS.get("kbk:" + S.ch, "");
  const load = () => api(cu(`/kb?q=${enc(LS.get("kbq:" + S.ch, ""))}&kind=${enc(LS.get("kbk:" + S.ch, ""))}&limit=50`)).catch(() => []);
  let list = await load();
  const id = /^\d+$/.test(sub[0] || "") ? Number(sub[0]) : list[0]?.id ?? null;
  const entry = id ? await api(cu(`/kb/${id}`)).catch(() => null) : null;
  if (tok !== RT) return;
  main().innerHTML = `<div class="mx-auto flex max-w-7xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
    <header class="${sub[0] ? "max-lg:hidden" : ""} flex flex-wrap items-end gap-3"><div class="min-w-0 flex-1 max-sm:basis-full"><h1 class="h1" id="kb-h">Knowledge</h1><p class="page-sub">What the sessions learned and shared, so nobody pays for it twice.</p></div>${KB.exportBtn()}<button class="btn btn-pri" id="kbadd">${I("plus", "size-4")}Remember something</button></header>
    <div class="grid items-start gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
    <section class="${sub[0] ? "max-lg:hidden" : ""} flex min-w-0 flex-col gap-3" aria-labelledby="kb-h">
      <div class="relative"><span class="pointer-events-none absolute top-2 left-2.5 text-faint">${I("search")}</span><input id="kbq" class="input pl-8" type="search" data-keep placeholder="Search what the sessions learned" aria-label="Search knowledge" value="${esc(q)}"></div>
      <div class="flex flex-wrap gap-1.5" role="group" aria-label="Kind"><button class="chip" data-k="" aria-pressed="${!kind}">All</button>${KB_KINDS.map(k => `<button class="chip" data-k="${k}" aria-pressed="${kind === k}">${I(KB_I[k], "size-3.5")}${KB_L[k]}</button>`).join("")}</div>
      <ul id="kblist" class="hr-card flex flex-col divide-y divide-line overflow-hidden" aria-label="Entries"></ul></section>
    <section id="kbr" class="${sub[0] ? "" : "max-lg:hidden"} min-w-0" aria-label="Entry">${entry ? kbEntry(entry) : hrEmpty("Nothing remembered yet", "Sessions call remember when they learn something the others should not pay for again.", "book")}</section></div></div>`;
  const paintList = l => { $("#kblist").innerHTML = l.map(k => `<li><a class="block px-4 py-3 transition-colors hover:bg-hover aria-[current=page]:bg-hover" href="${href(`/knowledge/${k.id}`)}" ${k.id === id ? `aria-current="page"` : ""}><div class="flex items-center gap-2">${kbTag(k.kind)}<b class="truncate text-[13px] font-medium">${esc(k.title)}</b></div>${KB.marks(k) ? `<div class="mt-1.5 flex flex-wrap gap-1">${KB.marks(k)}</div>` : ""}
    <div class="hit mt-1 line-clamp-2 text-xs text-muted">${esc(k.hit || "").replace(/«/g, "<mark>").replace(/»/g, "</mark>")}</div><div class="mt-1 text-2xs text-faint">${esc(k.by)} · ${tsEl(k.created_at)}${KB.ageText(k) ? ` · ${KB.ageText(k)}` : ""}${k.tags?.length ? " · " + k.tags.map(esc).join(", ") : ""}</div></a></li>`).join("") || `<li>${hrEmpty("No entry matches", "Try other words or another kind.")}</li>`; };
  paintList(list);
  S.repaint = what => { if (what === "kb") load().then(l => { if (S.dest === "knowledge" && $("#kblist")) paintList(l); }); };
  $("#kbq").oninput = e => soon("kbq", () => { LS.set("kbq:" + S.ch, e.target.value.trim()); S.repaint("kb"); }, 200);
  $$("[data-k]").forEach(b => b.onclick = () => { LS.set("kbk:" + S.ch, b.dataset.k); $$("[data-k]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); S.repaint("kb"); });
  $("#kbadd").onclick = e => kbForm(e.currentTarget);
  KB.wireExport();
  if (entry) KB.wireEntry(entry, n => { S.key = null; go(href(`/knowledge/${n}`)); });
}
const kbEntry = k => `<article class="hr-card"><div class="flex flex-col gap-2 border-b border-line p-4 sm:p-5"><a class="btn btn-ghost btn-sm -ml-2 w-fit lg:hidden" href="${href("/knowledge")}">${I("left", "size-3.5")}All entries</a>
  <div class="flex flex-wrap items-center gap-2">${kbTag(k.kind)}${KB.marks(k)}${k.superseded_by ? `<a class="hr-pill hr-pill-waiting" href="${href(`/knowledge/${k.superseded_by}`)}">Replaced by #${k.superseded_by}</a>` : ""}</div>
  <h2 class="text-lg font-semibold">${esc(k.title)}</h2>
  <div class="hint">By ${esc(k.by)} · ${tsEl(k.created_at)} · read ${k.hits} time${k.hits === 1 ? "" : "s"}${k.task ? ` · task <a class="link font-mono" href="${taskHref(k.task)}">${esc(k.task)}</a>` : ""}${k.supersedes ? ` · replaces <a class="link" href="${href(`/knowledge/${k.supersedes}`)}">#${k.supersedes}</a>` : ""}</div>
  ${k.tags?.length ? `<div class="flex flex-wrap gap-1">${k.tags.map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}</div>
  ${KB.entryExtras(k)}
  <div class="p-4 sm:p-5">${mdBlock(k.body)}</div>
  ${k.refs?.length ? `<div class="flex flex-wrap items-center gap-1.5 border-t border-line p-4"><span class="sec-t mr-1">References</span>${k.refs.map(r => `<span class="tag">${md(r)}</span>`).join("")}</div>` : ""}</article>`;
function kbForm(trigger) {
  openModal("Remember something", `<form class="flex flex-col gap-3 p-4" id="kbf">
    <div class="grid gap-3 sm:grid-cols-2"><label class="label">Kind <select class="input" id="kb-kind">${KB_KINDS.map(k => `<option value="${k}">${KB_L[k]}</option>`).join("")}</select></label><label class="label"><span>Task <span class="help">(optional)</span></span><input class="input" id="kb-task" placeholder="Task id"></label></div>
    <label class="label">Title <input class="input" id="kb-title" required placeholder="One line the others will search for"></label>
    <label class="label">Body <textarea class="input" id="kb-body" rows="6" required placeholder="Markdown works"></textarea></label>
    <label class="label"><span>Tags <span class="help">(optional, comma separated)</span></span><input class="input" id="kb-tags"></label>
    ${KB.scopeField()}
    <div class="rounded-lg border border-line bg-panel-2 p-3 text-[13px]" id="kb-dup" hidden role="status"></div>
    <p class="err" id="kb-err" role="alert"></p>
    <div class="flex justify-end gap-2"><button type="button" class="btn btn-ghost" id="kb-cancel">Cancel</button><button class="btn btn-pri" type="submit">Remember</button></div></form>`, trigger);
  $("#kb-title").focus();
  $("#kb-cancel").onclick = () => closeDlg($("#modal"));
  $("#kbf").onsubmit = async e => {
    e.preventDefault();
    const args = { kind: $("#kb-kind").value, title: $("#kb-title").value.trim(), body: $("#kb-body").value.trim(), tags: $("#kb-tags").value.split(/[\s,]+/).filter(Boolean), task: $("#kb-task").value.trim() || undefined };
    if (!args.title || !args.body) { $("#kb-err").textContent = "Add a title and a body."; return; }
    try { await KB.remember(args, id => { closeDlg($("#modal")); toast("Remembered"); go(href(`/knowledge/${id}`)); }); }
    catch (err) { $("#kb-err").textContent = err.message; }
  };
}

// ── Settings: channel · turn · repo · this browser · export · connect ────────
async function settingsView(sub, tok) {
  await D.loadInfo();
  if (tok !== RT) return;
  const c = S.info.config, st = S.info.stats || {}, th = LS.get("theme", "system");
  const members = () => [...new Set([...(c.members || []), ...D_names()])].filter(x => !x.includes("."));
  const card = (id, title, icon, body) => `<section class="card" aria-labelledby="${id}"><h2 class="card-h" id="${id}">${I(icon, "size-4 text-faint")}${title}</h2><div class="card-b">${body}</div></section>`;
  main().innerHTML = `<div class="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6"><div><h1 class="h1">Settings</h1><p class="mt-1 text-[13px] text-muted">Channel <code>${esc(S.ch)}</code>, created ${tsEl(c.created_at)}. ${st.events ?? 0} events, ${st.tasks ?? 0} tasks, ${st.knowledge ?? 0} knowledge entries.</p></div>
   ${card("set-ch", "Channel", "sliders", `<form class="flex flex-col gap-3" id="f-ch">
     <label class="label">Title <input class="input" id="cf-title" data-keep value="${esc(c.title)}"></label>
     <label class="label">What the team is doing <textarea class="input" id="cf-desc" data-keep rows="3">${esc(c.description)}</textarea></label>
     <label class="label">Allowed sessions <input class="input" id="cf-members" data-keep value="${esc((c.members || []).join(", "))}" placeholder="Any local session" aria-describedby="cf-mh"><span class="help" id="cf-mh">Session names, comma separated. A member's subagents may always join. Leave empty to let any local session join.</span></label>
     ${hasOrch() ? `<label class="label">Orchestrator <select class="input" id="cf-orch" data-keep aria-describedby="cf-oh"><option value="">None</option>${members().map(n => `<option ${n === c.orchestrator ? "selected" : ""}>${esc(n)}</option>`).join("")}</select><span class="help" id="cf-oh">The orchestrator plans the work for the others: it imports plans, assigns tasks, and briefs or restarts sessions.</span></label>` : ""}
     <div class="flex items-center gap-2"><button class="btn btn-pri" type="submit">Save channel</button><span class="err" role="alert"></span></div></form>`)}
   ${card("set-turn", "Turn", "turn", `<form class="flex flex-col gap-3" id="f-turn">
     <p class="text-[13px] text-muted">For ping-pong work, where only one session acts at a time. Without a turn, sessions work in parallel, ordered by task dependencies.</p>
     <label class="label">Starts with the turn <select class="input" id="cf-start" data-keep>${startOptions(c.start || "")}</select></label>
     <label class="label">Hand-over rules <textarea class="input font-mono text-xs" id="cf-hand" data-keep rows="4" spellcheck="false" aria-describedby="cf-hh">${esc(JSON.stringify(c.handover || {}, null, 2))}</textarea><span class="help" id="cf-hh">JSON: <code>{"api": {"to": "web", "topics": ["build.ready"]}}</code> passes the turn from api to web when api publishes build.ready.</span></label>
     <div class="flex items-center gap-2"><button class="btn btn-pri" type="submit">Save turn</button><span class="err" role="alert"></span></div></form>`)}
   ${card("set-repo", "Repo", "code", `<form class="flex flex-col gap-3" id="f-repo">
     <label class="label">Repo path <input class="input font-mono text-xs" id="cf-repo" data-keep value="${esc(c.repo || "")}" placeholder="/absolute/path/to/repo" aria-describedby="cf-rh"><span class="help" id="cf-rh">A folder Huddle can read. It adds Code, Drift and Diagrams under Work. ${(S.info.views || []).length ? `Available now: ${S.info.views.map(esc).join(", ")}.` : c.repo ? "Huddle cannot read this path." : ""}</span></label>
     <label class="label"><span>Profile <span class="help">(optional)</span></span><input class="input" id="cf-profile" data-keep value="${esc(c.profile || "")}"></label>
     <div class="flex items-center gap-2"><button class="btn btn-pri" type="submit">Save repo</button><span class="err" role="alert"></span></div></form>`)}
   ${card("set-br", "This browser", "monitor", `<div class="flex flex-col gap-4 text-[13px]">
     <div class="flex flex-wrap items-center gap-3"><span class="flex-1" id="th-l">Theme</span><div class="seg" role="group" aria-labelledby="th-l">${THEMES.map(([k, l, ic]) => `<button data-theme-set="${k}" aria-pressed="${th === k}">${I(ic, "size-3.5")}${l}</button>`).join("")}</div></div>
     <div class="flex items-center gap-3"><span class="flex-1" id="nt-l">Notify me when a session asks me something<span class="help block">${"Notification" in window ? `Browser permission: ${Notification.permission}` : "This browser cannot show notifications."}</span></span><button class="toggle" role="switch" id="set-notif" aria-checked="${D.notifyOn()}" aria-labelledby="nt-l"></button></div>
     <div class="flex items-center gap-3"><span class="flex-1">Filters, drafts and last views stay in this browser.</span><button class="btn" id="set-reset">Reset filters</button></div></div>`)}
   ${card("set-ex", "Export", "download", `<ul class="flex flex-col">${[["/export.md", "export.md", "The plan with your notes, as Markdown"], ["/plan.json", "plan.json", "Every task in full"], ["/timeline?limit=2000", "timeline.json", "The last 2000 events"]].map(([p, t, d]) => `<li><a class="row rounded-lg" href="${cu(p)}" target="_blank" rel="noopener">${I("download", "size-4 text-faint")}<b class="font-mono text-xs">${t}</b><span class="text-xs text-muted">${d}</span></a></li>`).join("")}</ul>`)}
   <div id="set-ext" class="flex flex-col gap-4 empty:hidden"></div>
   <section class="hr-card" aria-labelledby="cx-h">${connectHTML(S.ch)}</section></div>`;
  wireConnect();
  X.settingsHTML().then(h => { const el = $("#set-ext"); if (el && tok === RT) { el.innerHTML = h; X.wireSettings(el); } });
  $$("[data-theme-set]").forEach(b => b.onclick = () => setTheme(b.dataset.themeSet));
  $("#set-notif").onclick = async () => { await D.toggleNotify(); $("#set-notif").setAttribute("aria-checked", String(D.notifyOn())); };
  $("#set-reset").onclick = () => { try { for (const k of Object.keys(localStorage)) if (/^huddle:(wfilter|wowner|wphase|wq|wview|kbq|kbk|tlf|tls|kmore)/.test(k)) localStorage.removeItem(k); } catch {} toast("Filters reset"); };
  const save = (id, args) => { const f = $("#" + id); f.onsubmit = async e => { e.preventDefault(); const er = $(".err", f); er.textContent = ""; let a; try { a = args(); } catch (x) { er.textContent = x.message; return; }
    try { await op("configure", a); toast("Saved"); await D.loadInfo(); renderChrome(); } catch (x) { er.textContent = x.message; } }; };
  save("f-ch", () => ({ title: $("#cf-title").value.trim(), description: $("#cf-desc").value, members: $("#cf-members").value.split(/[\s,]+/).filter(Boolean), ...($("#cf-orch") ? { orchestrator: $("#cf-orch").value || null } : {}) }));
  save("f-turn", () => { let handover; try { handover = JSON.parse($("#cf-hand").value || "{}"); } catch (x) { throw new Error("The hand-over rules are not valid JSON: " + x.message); } return { start: $("#cf-start").value, handover }; });
  save("f-repo", () => ({ repo: $("#cf-repo").value.trim(), profile: $("#cf-profile").value.trim() }));
  S.repaint = what => { if (what === "sess") { const sel = $("#cf-start"); if (sel) { const v = sel.value; sel.innerHTML = startOptions(v); sel.value = v; } } };
}
const D_names = () => (S.sess?.sessions || []).map(s => s.name);
const startOptions = v => { const n = D_names().filter(x => !x.includes(".")); if (v && !n.includes(v)) n.push(v); return `<option value="">Nobody: work in parallel</option>${n.map(x => `<option ${x === v ? "selected" : ""}>${esc(x)}</option>`).join("")}`; };

// relative times stay live
setInterval(() => { for (const el of document.querySelectorAll("time[data-ts]")) { const t = ago(el.dataset.ts); if (el.textContent !== t) el.textContent = t; } }, 15_000);

fetch("/health").then(r => r.json()).then(h => { if (h.version) $("#ver").textContent = `v${h.version}`; }).catch(() => {});
K.init();
route();
