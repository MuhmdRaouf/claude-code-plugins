// extras.js — the owner's extras in the dashboard (server side: src/extras.ts, src/digest.ts):
//   Today     what got done since a moment, per session, what is blocked, the open questions,
//             and the estimated cost per session when Observatory runs (#/c/<ch>/today)
//   Inbox     approval requests (a session asked Claude Code's permission for a command a rule
//             names) and Observatory's alerts for this channel's sessions, with "Pause"
//   Settings  desktop notifications (this whole Huddle) and the channel's approval rules
//   Overview  and Team: the estimated cost per session, when Observatory runs
// Observatory absent: its parts are simply not drawn. S.ext holds what this module loaded.
import { $, $$, esc, S, LS, cu, href, api, op, act, I, av, tsEl, hrEmpty, toast, copy, soon, preserve, sPill, who } from "./core.js";
import * as D from "./data.js";
import { routeTok, taskHref, sessHref } from "./app.js";

S.ext = null;
const usd = n => n == null ? "" : n >= 100 ? `$${n.toFixed(0)}` : n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : "$0";
const KIND = { stuck: "Stuck", loop: "Looping", retry_storm: "Retry storm", budget: "Budget", context: "Context filling up" };

// ── data: approval requests and Observatory, for the open channel ──────────────
let POLL = 0;
export async function load() {
  const ch = S.ch; if (!ch) return;
  const [a, o] = await Promise.all([api(cu("/x/approvals")).catch(() => null), api(cu("/x/observatory")).catch(() => null)]);
  if (S.ch !== ch) return;
  S.ext = { ch, approvals: a?.approvals || [], obs: o && o.available ? o : null };
  D.changed("att"); // the Inbox, its count and the nav repaint from here
  D.changed("ext");
}
// how many of these need the owner (part of the Inbox count)
export const needs = () => S.ext && S.ext.ch === S.ch ? S.ext.approvals.length + (S.ext.obs?.alerts?.length || 0) : 0;
export const needsText = () => { if (!S.ext || S.ext.ch !== S.ch) return ""; const a = S.ext.approvals.length, o = S.ext.obs?.alerts?.length || 0;
  return [a && `${a} permission request${a > 1 ? "s" : ""}`, o && `${o} Observatory alert${o > 1 ? "s" : ""}`].filter(Boolean).join(" · "); };
D.countExtras(needs);
export const costOf = n => S.ext?.ch === S.ch ? S.ext?.obs?.cost?.[n] : undefined;
/** A small "est. $x today" figure for a session (Team roster), nothing without Observatory. */
export const costChip = n => { const c = costOf(n); return c == null ? "" : `<span class="flex items-baseline gap-1 text-xs text-muted" title="Estimated cost today, from Observatory"><span class="font-semibold text-fg tabular-nums">${usd(c)}</span>today</span>`; };

D.onChange((what, x) => {
  if (what === "event" && x?.topic === "approval.request") soon("ext", load, 300);
  else if (S.ch && S.ext?.ch !== S.ch && what !== "att" && what !== "ext") soon("ext", load, 50); // a channel just opened
});
// Observatory's alerts change on their own: read again every 30 s while a channel is open and visible
clearInterval(POLL);
POLL = setInterval(() => { if (S.ch && !document.hidden && S.ext?.obs) load(); }, 30_000);

// ── Inbox: approval requests and Observatory alerts ───────────────────────────
const item = (key, body) => `<li class="hr-card p-4" data-item="${esc(key)}">${body}</li>`;
const section = (id, title, n, body, extra = "") => n ? `<section class="flex flex-col gap-2" aria-labelledby="ih-${id}"><h2 class="h2 flex items-center gap-2 px-1" id="ih-${id}">${title}<span class="text-xs font-medium text-muted tabular-nums">${n}</span><span class="flex-1"></span>${extra}</h2><ul class="flex flex-col gap-2">${body}</ul></section>` : "";
export function inboxHTML() {
  if (!S.ext || S.ext.ch !== S.ch) return "";
  const ap = S.ext.approvals, al = S.ext.obs?.alerts || [];
  return section("approvals", "Asked for your permission", ap.length, ap.map(a => item("x" + a.seq, `<div class="flex flex-wrap items-center gap-3"><span class="hr-stat-icon hr-tint-accent">${I("key")}</span>
      <div class="min-w-0 flex-1 basis-56"><div class="text-[13px]"><a class="font-medium hover:underline" href="${sessHref(a.from)}">${esc(a.from)}</a> wants to run a command your rules name: <b class="font-medium">${esc((a.labels || []).join(", ") || "a command")}</b></div>
        <div class="text-xs text-muted">${tsEl(a.ts)} · Claude Code asks for the go-ahead in that session's window; answer there.</div></div>
      <div class="flex gap-1.5"><a class="btn" href="${sessHref(a.from)}">${I("users", "size-4")}Open session</a><button class="btn btn-ghost" data-xdismiss="${a.seq}">Dismiss</button></div></div>`)).join(""),
      ap.length > 1 ? `<button class="btn btn-ghost btn-sm font-normal" data-xdismiss-all>Dismiss all</button>` : "")
    + section("obs", "Alerts from Observatory", al.length, al.map(a => item("o" + a.id, `<div class="flex flex-wrap items-center gap-3"><span class="hr-stat-icon ${a.kind === "budget" ? "hr-tint-bad" : "c-peach"}">${I("alert")}</span>
      <div class="min-w-0 flex-1 basis-56"><div class="text-[13px]"><a class="font-medium hover:underline" href="${sessHref(a.session)}">${esc(a.session)}</a>${a.agent ? ` <span class="text-faint">(a subagent)</span>` : ""}: <b class="font-medium">${esc(KIND[a.kind] || a.kind)}</b></div>
        <div class="text-xs text-muted">${esc(a.detail)}${a.since ? ` · since ${tsEl(new Date(a.since).toISOString())}` : ""}${a.cost != null ? ` · ${usd(a.cost)} so far` : ""}</div></div>
      <div class="flex gap-1.5"><a class="btn" href="${sessHref(a.session)}">Open session</a>${(S.sess?.sessions || []).some(s => s.name === a.session && s.control === "pause") ? `<span class="hr-pill hr-pill-waiting">Paused</span>` : `<button class="btn btn-pri" data-xpause="${esc(a.session)}" data-xwhy="${esc(KIND[a.kind] || a.kind)}">${I("pause", "size-4")}Pause ${esc(a.session)}</button>`}</div></div>`)).join(""));
}
export function wireInbox(m) {
  $$("[data-xdismiss]", m).forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await api(cu("/x/approvals/dismiss?as=owner"), { body: { seq: +b.dataset.xdismiss } }); S.ext.approvals = r.approvals; D.changed("att"); } catch (e) { toast(e.message, { bad: true }); b.disabled = false; } });
  $$("[data-xdismiss-all]", m).forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await api(cu("/x/approvals/dismiss?as=owner"), { body: { all: true } }); S.ext.approvals = r.approvals; D.changed("att"); toast("Dismissed"); } catch (e) { toast(e.message, { bad: true }); b.disabled = false; } });
  $$("[data-xpause]", m).forEach(b => b.onclick = async () => { const n = b.dataset.xpause; b.disabled = true;
    if (await act("pause", { target: n, why: `Observatory: ${b.dataset.xwhy}` }, `${n} paused`, { undo: () => act("resume", { target: n }, `${n} resumed`).then(() => { D.loadSess(); D.loadAtt(); }) })) { await D.loadSess(); D.loadAtt(); } else b.disabled = false; });
}

// ── Overview: the estimated cost per session ──────────────────────────────────
export function overviewHTML() {
  const o = S.ext?.ch === S.ch ? S.ext?.obs : null;
  if (!o || !o.cost) return "";
  const rows = Object.entries(o.cost).sort((a, b) => b[1] - a[1]), top = rows[0]?.[1] || 0;
  return `<section class="hr-card" aria-labelledby="ovcost-h"><div class="hr-card-head"><div class="min-w-0"><h2 class="hr-label" id="ovcost-h">Estimated cost today</h2><p class="text-xs text-muted">Per session, from Observatory</p></div><span class="flex-1"></span><span class="hr-stat-val text-[22px]">${usd(o.total || 0)}</span></div>
    <div class="flex flex-col gap-3 p-4">${rows.length ? rows.map(([n, c]) => `<div class="flex items-center gap-3 text-[13px]">${av(n, true)}<a class="w-32 truncate font-medium hover:underline" href="${sessHref(n)}">${esc(n)}</a><span class="hr-bar flex-1" role="img" aria-label="${esc(n)}: ${usd(c)}"><i class="hr-bar-fill" style="width:${top ? (c / top * 100).toFixed(1) : 0}%"></i></span><span class="w-16 text-right tabular-nums">${usd(c)}</span></div>`).join("")
      : `<p class="text-[13px] text-muted">No spend recorded for this channel's sessions today.</p>`}</div></section>`;
}

// ── Today: the digest ─────────────────────────────────────────────────────────
const WINS = [["24h", "24 hours"], ["3d", "3 days"], ["7d", "7 days"]];
let DG = null;
export async function todayView(sub, tok) {
  const win = LS.get("dgwin:" + S.ch, "24h");
  const r = await op("digest", { since: win, json: true }).catch(e => ({ error: e.message }));
  if (tok !== routeTok()) return;
  DG = r.result || null;
  $("#main").innerHTML = `<div class="mx-auto flex max-w-6xl flex-col gap-5 p-4 sm:p-6 lg:p-8" id="dgwrap">
    <header class="flex flex-wrap items-end gap-3"><div class="min-w-0 flex-1 max-sm:basis-full"><h1 class="h1" id="dg-h">Today</h1><p class="page-sub">What each session got done, what is stuck and what still waits for an answer.</p></div>
      <div class="hr-seg" role="group" aria-label="Since">${WINS.map(([k, l]) => `<button type="button" class="hr-seg-item ${k === win ? "hr-seg-on" : ""}" data-dgwin="${k}" aria-pressed="${k === win}">${l}</button>`).join("")}</div>
      <button class="btn" id="dgcopy">${I("copy", "size-4")}Copy as text</button></header>
    <div id="dgbody">${r.error ? `<div class="empty">${I("alert", "size-6 text-red-ink")}<b>The digest did not load</b>${esc(r.error)}</div>` : paintDigest(DG)}</div></div>`;
  $$("[data-dgwin]").forEach(b => b.onclick = () => { LS.set("dgwin:" + S.ch, b.dataset.dgwin); todayView(sub, tok); });
  $("#dgcopy").onclick = async () => { const t = await op("digest", { since: LS.get("dgwin:" + S.ch, "24h") }).catch(() => null); if (t?.text) copy(t.text, "Copied the digest"); };
  S.repaint = what => { if (["event", "task", "ext"].includes(what) && S.dest === "today") soon("dg", async () => {
    const x = await op("digest", { since: LS.get("dgwin:" + S.ch, "24h"), json: true }).catch(() => null);
    if (x?.result && S.dest === "today" && $("#dgbody")) { DG = x.result; preserve(() => { $("#dgbody").innerHTML = paintDigest(DG); }); }
  }, 1500); };
}
const stat = (icon, tint, label, value, sub) => `<div class="hr-stat"><div class="flex min-w-0 items-center gap-2"><span class="hr-label min-w-0 flex-1 truncate">${esc(label)}</span><span class="hr-stat-icon ${tint}">${icon}</span></div><p class="hr-stat-val">${esc(value)}</p>${sub ? `<p class="hr-stat-sub">${esc(sub)}</p>` : ""}</div>`;
const tl = (id, title) => `<a class="inline-flex min-w-0 max-w-full items-center gap-1.5 hover:underline" href="${taskHref(id)}"><span class="tid">${esc(id)}</span><span class="truncate">${esc(title || S.byId?.get(id)?.title || "")}</span></a>`;
const list = (title, rows) => rows.length ? `<div class="flex flex-col gap-1.5"><h4 class="sec-t">${title}</h4><ul class="flex flex-col gap-1.5 text-[13px]">${rows.join("")}</ul></div>` : "";
function sessCard(s) {
  const live = (S.sess?.sessions || []).find(x => x.name === s.name);
  const body = [
    list("Finished", s.done.map(d => `<li class="flex min-w-0 items-start gap-2"><span class="mt-0.5 text-green-ink">${I(d.status === "skipped" ? "minusc" : "checkc", "size-4")}</span><span class="min-w-0 flex-1">${tl(d.id, d.title)}${d.note ? `<span class="block truncate text-xs text-muted" title="${esc(d.note)}">${esc(d.note)}</span>` : ""}</span></li>`)),
    list("Knowledge shared", s.knowledge.map(k => `<li class="flex min-w-0 items-center gap-2"><span class="text-faint">${I("book", "size-4")}</span><a class="truncate hover:underline" href="${href(`/knowledge/${k.id}`)}">${esc(k.title || `#${k.id}`)}</a><span class="hr-chip hr-tint-violet">${esc(k.kind || "")}</span></li>`)),
    list("Notes", s.notes.slice(0, 6).map(n => `<li class="flex min-w-0 items-start gap-2"><span class="mt-0.5 text-faint">${I("note", "size-4")}</span><span class="min-w-0 flex-1"><span class="text-xs text-muted">${esc(n.kind)} on </span>${tl(n.task, n.title)}<span class="block truncate text-xs text-muted">${esc(n.body)}</span></span></li>`).concat(s.notes.length > 6 ? [`<li class="text-xs text-muted">and ${s.notes.length - 6} more</li>`] : [])),
    list("Asked for permission", s.approvals.length ? [`<li class="flex items-center gap-2"><span class="text-faint">${I("key", "size-4")}</span>${s.approvals.length}× · ${esc([...new Set(s.approvals.flatMap(a => a.labels))].join(", "))}</li>`] : []),
  ].filter(Boolean).join("");
  return `<article class="hr-card flex flex-col" aria-labelledby="dg-${esc(s.name)}"><div class="hr-card-head">${av(s.name)}<div class="min-w-0 flex-1"><h3 class="hr-label truncate" id="dg-${esc(s.name)}">${s.name === "owner" ? "You" : `<a class="hover:underline" href="${sessHref(s.name)}">${esc(s.name)}</a>`}</h3><p class="truncate text-xs text-muted">${esc(s.role || (s.state === "left" ? "left the channel" : ""))}${s.events ? `${s.role ? " · " : ""}${s.events} event${s.events === 1 ? "" : "s"}` : ""}${s.asked ? ` · ${s.asked} open question${s.asked === 1 ? "" : "s"}` : ""}</p></div>
      ${s.cost != null ? `<span class="hr-chip hr-tint-info" title="Estimated cost, from Observatory">${usd(s.cost)}</span>` : ""}${live ? sPill(live, true) : ""}</div>
    <div class="flex flex-1 flex-col gap-4 p-4">${body || `<p class="text-[13px] text-muted">Nothing finished or shared in this window.</p>`}</div></article>`;
}
function paintDigest(d) {
  if (!d) return hrEmpty("Nothing to show", "", "clock");
  const T = d.totals, c = d.cost;
  return `<div class="flex flex-col gap-5">
    <div class="hr-stats ${c.available ? "xl:grid-cols-5" : ""}">
      ${stat(I("checkc", "size-4"), "hr-tint-good", "Tasks finished", T.done, `${T.events} events since ${new Date(d.since).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`)}
      ${stat(I("book", "size-4"), "hr-tint-info", "Knowledge added", T.knowledge, `${T.notes} note${T.notes === 1 ? "" : "s"} on tasks`)}
      ${stat(I("ban", "size-4"), "hr-tint-bad", "Blocked now", T.blocked, T.blocked ? "Need a hand" : "Nothing stuck")}
      ${stat(I("ask", "size-4"), "c-mauve", "Open questions", T.questions, T.questions ? "Waiting for an answer" : "All answered")}
      ${c.available ? stat(`<span class="text-xs font-bold">$</span>`, "hr-tint-accent", "Estimated cost", usd(c.total || 0), `This ${c.range}, from Observatory`) : ""}
    </div>
    ${d.sessions.length ? `<section aria-labelledby="dgs-h" class="flex flex-col gap-3"><h2 class="h2 px-1" id="dgs-h">By session</h2><div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">${d.sessions.map(sessCard).join("")}</div></section>` : hrEmpty("No activity in this window", "Sessions show up here once they join and work.", "users")}
    <div class="grid gap-4 lg:grid-cols-2">
      <section class="hr-card" aria-labelledby="dgb-h"><div class="hr-card-head"><h2 class="hr-label" id="dgb-h">Blocked now</h2><span class="flex-1"></span><span class="text-xs text-muted tabular-nums">${d.blocked.length}</span></div>
        ${d.blocked.length ? `<ul class="flex flex-col divide-y divide-line">${d.blocked.map(b => `<li class="flex flex-col gap-1 px-4 py-3 text-[13px]">${tl(b.id, b.title)}<span class="text-xs text-muted">${b.owner ? `${esc(who(b.owner))}` : "Nobody owns it"}${b.note ? ` · “${esc(b.note)}”` : ""}${b.waits_on?.length ? ` · waits on ${b.waits_on.map(esc).join(", ")}` : ""}</span></li>`).join("")}</ul>` : `<div class="p-4">${hrEmpty("Nothing is blocked")}</div>`}</section>
      <section class="hr-card" aria-labelledby="dgq-h"><div class="hr-card-head"><h2 class="hr-label" id="dgq-h">Open questions</h2><span class="flex-1"></span>${d.questions.some(q => !q.to || q.to === "owner") ? `<a class="btn btn-ghost btn-sm" href="${href("/inbox")}">Answer in Inbox</a>` : ""}</div>
        ${d.questions.length ? `<ul class="flex flex-col divide-y divide-line">${d.questions.map(q => `<li class="flex items-start gap-3 px-4 py-3 text-[13px]">${av(q.from, true)}<div class="min-w-0 flex-1"><div class="text-xs text-muted"><b class="text-fg">${esc(q.from)}</b> → ${esc(q.to ? who(q.to) : "everyone")} · ${tsEl(q.at)}</div><p class="line-clamp-2">${esc(q.msg)}</p></div></li>`).join("")}</ul>` : `<div class="p-4">${hrEmpty("No open questions")}</div>`}</section>
    </div></div>`;
}

// ── Settings: desktop notifications and approval rules ───────────────────────
export async function settingsHTML() {
  const [st, rr] = await Promise.all([api("/api/settings").catch(() => null), api(cu("/x/rules")).catch(() => null)]);
  const card = (id, title, icon, body) => `<section class="card" aria-labelledby="${id}"><h2 class="card-h" id="${id}">${I(icon, "size-4 text-faint")}${title}</h2><div class="card-b">${body}</div></section>`;
  const where = st?.notifier === "osascript" ? "macOS Notification Center" : st?.notifier === "notify-send" ? "your desktop (notify-send)" : st?.notifier === "log" ? "a log file (HUDDLE_NOTIFY_LOG)" : null;
  return (st ? card("set-nt", "Desktop notifications", "bell", `<div class="flex flex-col gap-3 text-[13px]">
      <div class="flex items-center gap-3"><span class="flex-1" id="dn-l">Notify this computer when something needs you<span class="help block">A question to you, a session someone paused, a request for your permission, a blocked task. At most once per session and kind every 10 minutes, for every channel on this Huddle. ${where ? `They go to ${where}.` : "This computer has no notifier Huddle can use (macOS, or Linux with notify-send)."}</span></span>
        <button class="toggle" role="switch" id="set-dnotify" aria-checked="${!!st.notify}" aria-labelledby="dn-l" ${st.forced_off ? "disabled" : ""}></button></div>
      ${st.forced_off ? `<p class="help">Turned off for this server by HUDDLE_NOTIFY=0.</p>` : ""}
      <p class="help">Same switch in a terminal: <code>huddle setup --no-notify</code> or <code>--notify</code>.</p></div>`) : "")
    + (rr ? card("set-ap", "Approval rules", "key", `<div class="flex flex-col gap-1 text-[13px]"><p class="mb-2 text-muted">Before a session in this channel runs one of these commands, Claude Code asks for the go-ahead in that session's window (its own permission prompt), and the request shows in your Inbox. Nothing is ever refused or held up by Huddle itself.</p>
      <ul class="flex flex-col divide-y divide-line">${rr.rules.map(r => `<li class="flex items-center gap-3 py-2.5"><span class="min-w-0 flex-1" id="ar-l-${r.id}"><b class="font-medium">${esc(r.label)}</b>${r.default ? ` <span class="text-xs text-faint">(on by default)</span>` : ""}<span class="help block">${esc(r.help)}</span></span><button class="toggle" role="switch" data-xrule="${r.id}" aria-checked="${!!r.on}" aria-labelledby="ar-l-${r.id}"></button></li>`).join("")}</ul></div>`) : "");
}
export function wireSettings(m) {
  const dn = $("#set-dnotify", m);
  if (dn) dn.onclick = async () => { const on = dn.getAttribute("aria-checked") !== "true"; dn.disabled = true;
    try { const r = await api("/api/settings", { body: { notify: on } }); dn.setAttribute("aria-checked", String(!!r.notify)); toast(r.notify ? "Desktop notifications on" : "Desktop notifications off"); } catch (e) { toast(e.message, { bad: true }); } finally { dn.disabled = false; } };
  $$("[data-xrule]", m).forEach(b => b.onclick = async () => { const id = b.dataset.xrule, on = b.getAttribute("aria-checked") !== "true"; b.disabled = true;
    try { const r = await api(cu("/x/rules?as=owner"), { body: { rules: { [id]: on } } }); for (const x of r.rules) $(`[data-xrule="${x.id}"]`, m)?.setAttribute("aria-checked", String(!!x.on)); toast(`${r.rules.find(x => x.id === id)?.label}: ${on ? "ask first" : "no longer asked"}`); }
    catch (e) { toast(e.message, { bad: true }); } finally { b.disabled = false; } });
}
