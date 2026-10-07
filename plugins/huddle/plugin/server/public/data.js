// data.js — the open channel's data and its live stream. Loaders fill S (board, sessions,
// attention, timeline, info); the SSE stream (GET /api/c/<ch>/live?as=owner) patches them in
// place and debounces reloads, never polling on a timer. Every change is broadcast with
// changed(what): the chrome (nav counts, sidebar) and the open view (S.repaint) redraw what shows it.
import { $, S, LS, cu, api, soon, toast, announce, who, signedOut } from "./core.js";

const subs = new Set();
export const onChange = f => { subs.add(f); return () => subs.delete(f); };
export function changed(what, x) { for (const f of subs) try { f(what, x); } catch (e) { console.error(e); } try { S.repaint?.(what, x); } catch (e) { console.error(e); } }

export async function loadInfo() { const ch = S.ch; try { const i = await api(cu("")); if (S.ch === ch) { S.info = i; changed("info"); } } catch {} }
export async function loadBoard() {
  const ch = S.ch, b = await api(cu("/board"));
  if (S.ch !== ch) return S.board;
  S.board = b; S.byId = new Map(b.steps.map(s => [s.id, s]));
  changed("board"); return b;
}
export async function loadSess() {
  const ch = S.ch; let s; try { s = await api(cu("/sessions")); } catch { return; }
  if (S.ch !== ch) return; S.sess = s; changed("sess");
}
// the Inbox: only what needs the owner (asks, approvals, paused sessions, blocked tasks)
let SEEN = null;
export async function loadAtt() {
  const ch = S.ch; if (!ch) return;
  let a; try { a = await api(cu("/attention")); } catch { return; }
  if (S.ch !== ch) return;
  S.att = a;
  const keys = inboxKeys(a);
  if (SEEN && SEEN.ch === ch) {
    const fresh = [...keys.entries()].filter(([k]) => !SEEN.keys.has(k)).map(([, t]) => t);
    if (fresh.length) announce(`New in Inbox: ${fresh.slice(0, 3).join("; ")}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ""}.`);
  }
  SEEN = { ch, keys };
  changed("att");
}
const inboxKeys = a => new Map([
  ...(a.asks || []).map(x => [`a${x.seq}`, `${who(x.from)} asks you`]),
  ...(a.gates || []).map(x => [`g${x.id}`, `${x.id} waits for your approval`]),
  ...(a.paused || []).map(x => [`p${x.name}`, `${x.name} is paused`]),
  ...(a.blocked || []).map(x => [`b${x.id}`, `${x.id} is blocked`]),
]);
export const inboxCount = () => { const a = S.att; return (a ? (a.asks?.length || 0) + (a.gates?.length || 0) + (a.paused?.length || 0) + (a.blocked?.length || 0) : 0) + XNEEDS(); };
// approval requests and Observatory's alerts (extras.js registers how many there are)
let XNEEDS = () => 0;
export const countExtras = f => { XNEEDS = f; };
export const attChanged = () => S.ch && soon("att", loadAtt, 500);
export const sessChanged = () => S.ch && soon("sess", loadSess, 400);
export const boardChanged = () => S.ch && soon("board", () => loadBoard().catch(() => {}), 350);

// ── timeline and who answered which ask ──────────────────────────────────────
export const REPL = new Map(); // ask seq → names that answered it
const addReply = e => { if (e.reply_to) { const a = REPL.get(e.reply_to) || []; if (!a.includes(e.from)) a.push(e.from); REPL.set(e.reply_to, a); } };
export async function loadTL() {
  const ch = S.ch, t = await api(cu("/timeline?limit=300")).catch(() => []);
  if (S.ch !== ch) return;
  S.tl = t; REPL.clear(); for (const e of t) addReply(e);
  changed("tl");
}
export async function olderTL() {
  const first = S.tl?.[0]?.seq; if (!first) return 0;
  const more = await api(cu(`/timeline?limit=300&before=${first}`)).catch(() => []);
  for (const e of more) addReply(e);
  S.tl = more.concat(S.tl); return more.length;
}

// ── the stream ───────────────────────────────────────────────────────────────
let ES = null, HELLO = 0;
export function connect() {
  disconnect();
  const ch = S.ch; HELLO = 0; dot(null);
  ES = new EventSource(cu("/live?as=owner"));
  ES.onopen = () => dot(true);
  ES.onerror = () => { dot(false); fetch("/api/whoami").then(r => r.status === 401 ? r.json().then(j => { if (j && j.signin) signedOut(); }) : null).catch(() => {}); };
  ES.onmessage = ev => { if (S.ch !== ch) return; let m; try { m = JSON.parse(ev.data); } catch { return; } handle(m); };
}
export function disconnect() { try { ES?.close(); } catch {} ES = null; }
function dot(on) {
  const d = $("#ldot"); if (!d) return;
  const t = on == null ? "Live updates: connecting" : on ? "Live updates: on" : "Live updates: reconnecting";
  d.className = "inline-flex size-6 items-center justify-center " + (on == null ? "c-idle" : on ? "c-green" : "c-peach");
  d.innerHTML = `<i class="dot ${on ? "live" : ""}"></i>`; d.title = t; d.setAttribute("aria-label", t);
}
function handle(m) {
  switch (m.type) {
    case "hello": dot(true); if (HELLO++ > 0) resync(); else if (!S.tl) loadTL(); break;
    case "event": onEvent(m.data); break;
    case "presence": onPresence(m.data); break;
    case "task": case "plan": boardChanged(); attChanged(); changed("task", m.data?.id); break;
    case "ack": sessChanged(); break;
    case "channel": loadInfo(); sessChanged(); attChanged(); break;
    case "conflict": changed("conflict", m.data); break; // two sessions edited one file (conflicts.js)
  }
}
// reconnected: anything sent while we were away was not pushed, so read it once
function resync() { loadTL(); loadSess(); boardChanged(); attChanged(); loadInfo(); }
function onEvent(e) {
  if (S.tl) {
    const last = S.tl.length ? S.tl[S.tl.length - 1].seq : 0;
    if (e.seq <= last) return;
    S.tl.push(e); if (S.tl.length > 3000) S.tl.splice(0, S.tl.length - 3000);
  }
  addReply(e);
  changed("event", e);
  sessChanged(); attChanged();
  if (/^kb\./.test(e.topic)) changed("kb");
  if (e.to === "owner" && e.from !== "owner" && e.topic !== "reply") toast(`${e.from}${e.topic === "ask" ? " asks you" : " to you"}: ${(e.msg || e.topic).slice(0, 140)}`);
  if (e.to === "owner" && e.needs_reply) notifyAsk(e);
}
function onPresence(p) {
  if (!p || !S.sess) return;
  const ss = S.sess.sessions, i = ss.findIndex(x => x.name === p.name);
  const was = i >= 0 ? ss[i].control : null;
  if (i >= 0) ss[i] = { ...ss[i], ...p }; else ss.push({ unread: 0, open: 0, holds_turn: false, ...p });
  if (p.control !== undefined && p.control !== was) attChanged();
  soon("presence", () => changed("sess"), 60);
}

// ── browser notifications for new asks (opt-in, per browser) ─────────────────
export const notifyOn = () => LS.get("notify", false) && "Notification" in window && Notification.permission === "granted";
export async function toggleNotify() {
  if (!("Notification" in window)) { toast("This browser cannot show notifications.", { bad: true }); return; }
  if (notifyOn()) { LS.set("notify", false); toast("Notifications off"); return; }
  const p = Notification.permission === "granted" ? "granted" : await Notification.requestPermission().catch(() => "denied");
  if (p !== "granted") { LS.set("notify", false); toast("The browser blocked notifications for this page. Allow them in the site settings.", { bad: true }); return; }
  LS.set("notify", true); toast("You will get a notification when a session asks you something.");
}
function notifyAsk(e) {
  if (!notifyOn() || (!document.hidden && S.dest === "inbox")) return;
  try { const n = new Notification(`${e.from} asks you`, { body: (e.msg || "").slice(0, 200), tag: `huddle-${S.ch}-${e.seq}` }); const ch = S.ch; n.onclick = () => { window.focus(); location.hash = `#/c/${ch}/inbox`; n.close(); }; } catch {}
}

// ── toast tints: core.js builds each toast with a c-green/c-red kind carrier; the
// matching hr-toast variant paints its border and surface ──────────────────────
const TINT = { "c-green": "hr-toast-good", "c-red": "hr-toast-bad" };
const tints = new MutationObserver(batch => { for (const a of batch) for (const el of a.addedNodes) if (el.nodeType === 1) { const k = TINT[[...el.classList].find(c => TINT[c])]; if (k) el.classList.add(k); } });
const tbox = $("#toasts"); if (tbox) tints.observe(tbox, { childList: true });
