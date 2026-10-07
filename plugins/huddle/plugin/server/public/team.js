// team.js — Team: a compact roster of sessions (subagents nested under their parent), the
// activity timeline in human verbs (bursts of task and knowledge updates grouped), and the
// session drawer: what it does now, its recent events, and the owner's actions (pause or resume,
// message, ask, hand the turn), with the composer inside it. One derived status per session.
import { $, $$, esc, enc, LS, S, act, md, tsEl, I, av, sStatus, sPill, sWhy, SSTM, STATM, tState, stIcon, verb, evText, famOf, who, whoL, preserve, skel, openDlg, closeDlg, hasOrch, soon, announce } from "./core.js";
import * as D from "./data.js";
import { taskHref, sessHref, routeTok, isOrch, path, go } from "./app.js";
import * as C from "./compose.js";
import { costChip } from "./extras.js";

const FAM = [["all", "Everything"], ["msg", "Messages"], ["task", "Tasks"], ["kb", "Knowledge"], ["control", "Pause and turn"], ["session", "Joins"]];
const OPENB = new Set(); // bursts the owner expanded (by first seq)
let NEWN = 0;

export async function view(sub, tok) {
  if (!S.tl) await D.loadTL();
  if (tok !== routeTok()) return;
  const f = LS.get("tlf", "all");
  $("#main").innerHTML = `<div class="mx-auto flex max-w-[1400px] flex-col gap-5 p-4 sm:p-6 lg:p-8">
   <header class="flex flex-wrap items-end gap-3"><div class="min-w-0 flex-1 max-sm:basis-full"><h1 class="h1" id="tm-h">Team</h1><p class="page-sub">The sessions in this channel and everything they publish, newest at the bottom.</p></div><button class="btn" id="tmmsg">${I("send", "size-4")}Send a message</button></header>
   <div class="grid items-start gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
    <section class="hr-card min-w-0 lg:sticky lg:top-4" aria-labelledby="ro-h"><div class="hr-card-head"><h2 id="ro-h" class="hr-label">Sessions</h2><span class="flex-1"></span><span id="ro-n" class="text-xs text-muted tabular-nums"></span></div><div id="roster"></div></section>
    <section class="hr-card flex min-w-0 flex-col" aria-labelledby="tl-h">
      <div class="hr-card-head flex-wrap"><h2 id="tl-h" class="hr-label">Activity</h2><span class="flex-1"></span><label class="sr-only" for="tls">Show the activity of</label><select id="tls" class="input hr-input w-auto max-w-48 text-xs font-normal"></select></div>
      <div class="border-b border-line px-3 py-2" role="group" aria-label="Show"><div class="hr-seg">${FAM.map(([k, v]) => `<button class="hr-seg-item ${f === k ? "hr-seg-on" : ""}" data-tlf="${k}" aria-pressed="${f === k}">${v}</button>`).join("")}</div></div>
      <div class="relative"><div class="max-h-[calc(100dvh-300px)] min-h-48 overflow-y-auto" id="tl" role="log" aria-label="Activity" tabindex="0"></div>
        <button id="tlnew" class="btn btn-pri btn-sm absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-overlay" hidden></button></div></section></div></div>`;
  $("#tmmsg").onclick = e => C.openCompose({ mode: "msg" }, e.currentTarget);
  $("#tls").onchange = e => { LS.set("tls", e.target.value); paintTL(true); };
  $$("[data-tlf]").forEach(b => b.onclick = () => { LS.set("tlf", b.dataset.tlf); $$("[data-tlf]").forEach(x => { x.setAttribute("aria-pressed", String(x === b)); x.classList.toggle("hr-seg-on", x === b); }); paintTL(true); });
  const tl = $("#tl");
  tl.onscroll = () => { if (nearBottom(tl)) { NEWN = 0; $("#tlnew").hidden = true; } };
  tl.onclick = e => { const r = e.target.closest("[data-reply]"); if (r) C.openCompose({ reply: +r.dataset.reply }, r); if (e.target.closest("#older")) older(); };
  tl.addEventListener("toggle", e => { const d = e.target; if (d.matches?.("details[data-first]")) { if (d.open) OPENB.add(+d.dataset.first); else OPENB.delete(+d.dataset.first); } }, true);
  $("#tlnew").onclick = () => tl.scrollTo({ top: tl.scrollHeight, behavior: "smooth" });
  S.repaint = (what, x) => {
    if (what === "sess" || what === "board" || what === "info") preserve(paintRoster);
    if (what === "event") { appendEvent(x); }
    if (what === "tl") paintTL(true);
  };
  paintRoster(); paintTL(true);
}

// ── roster ───────────────────────────────────────────────────────────────────
// one line about what it is doing: the task chip + title, never the same text twice
export function doing(s) {
  const t = s.step ? S.byId.get(s.step) : null;
  if (t) return `<span class="tid hr-mono">${esc(t.id)}</span><span class="truncate">${esc(t.title)}</span>`;
  const x = /^(joined|resumed|left)$/.test(String(s.task || "").trim()) ? "" : String(s.task || "").trim();
  return x ? `<span class="truncate">${esc(x)}</span>` : `<span class="truncate text-faint">${esc(s.role || "No task yet")}</span>`;
}
const orchMark = n => isOrch(n) ? `<span class="hr-chip c-lavender" title="Orchestrator: plans and assigns the work">${I("baton", "size-3")}orchestrator</span>` : "";
// unread and open asks as small stat values, hidden when zero
const cnt = (n, l, t) => n ? `<span class="flex items-baseline gap-1 text-xs text-muted" title="${t}"><span class="font-semibold text-fg tabular-nums">${n}</span>${l}</span>` : "";
function row(s, kid = false) {
  const cts = cnt(s.unread, "unread", s.unread + " events it has not read yet") + cnt(s.open, "asks", s.open + " open questions for it") + (kid ? "" : costChip(s.name));
  return `<li><a class="row rounded-lg ${kid ? "gap-2.5 p-2" : "gap-3 p-2.5"} ${S.sessName === s.name ? "bg-hover" : ""}" href="${sessHref(s.name)}" aria-label="${esc(s.name)}, ${SSTM[sStatus(s)].l}${isOrch(s.name) ? ", orchestrator" : ""}${s.holds_turn ? ", holds the turn" : ""}">
    ${av(s.name, kid)}<span class="min-w-0 flex-1"><span class="flex items-center gap-1.5"><b class="truncate text-[13px] font-semibold">${esc(kid ? s.name.split(".").slice(1).join(".") : s.name)}</b>${orchMark(s.name)}${s.holds_turn ? `<span class="text-faint" title="Holds the turn">${I("turn", "size-3.5")}</span>` : ""}</span>
    <span class="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted">${doing(s)}</span>
    ${cts ? `<span class="mt-1.5 flex items-center gap-4">${cts}</span>` : ""}</span>${sPill(s, kid)}</a></li>`;
}
function paintRoster() {
  const el = $("#roster"); if (!el || !S.sess) return;
  const ss = S.sess.sessions, names = new Set(ss.map(s => s.name));
  const tops = ss.filter(s => !s.parent || !names.has(s.parent)), kids = n => ss.filter(s => s.parent === n && s.state !== "left");
  const on = tops.filter(s => s.state !== "left"), off = tops.filter(s => s.state === "left");
  const t = S.sess.turn || {};
  $("#ro-n").textContent = `${ss.filter(s => s.state !== "left").length} online`;
  el.innerHTML = (t.holder || S.sess.config?.start ? `<p class="flex items-center gap-2 border-b border-line px-4 py-2 text-xs text-muted">${I("turn", "size-3.5 text-faint")}${t.holder ? `<span><b class="text-fg">${esc(t.holder)}</b> holds the turn: only it acts.</span>` : "Nobody holds the turn."}</p>` : "")
    + (on.length ? `<ul class="flex flex-col gap-0.5 p-2">${on.map(s => row(s) + (kids(s.name).length ? `<li><ul class="ml-6 flex flex-col gap-0.5 border-l border-line py-0.5 pl-2" aria-label="Subagents of ${esc(s.name)}">${kids(s.name).map(k => row(k, true)).join("")}</ul></li>` : "")).join("")}</ul>`
      : `<div class="empty hr-empty">${I("users", "size-6")}<b>Nobody has joined yet</b><span>Connect a session to this channel in Settings.</span><span class="hr-empty-hint">It shows up here the moment it joins.</span><a class="btn mt-1" href="${"#/c/" + esc(S.ch) + "/settings"}">${I("plug", "size-4")}Connect a session</a></div>`)
    + (off.length ? `<details class="group border-t border-line"><summary class="flex min-h-10 items-center gap-1 px-4 text-xs text-muted hover:text-fg">${I("right", "size-3.5 transition-transform group-open:rotate-90")}${off.length} left</summary><ul class="flex flex-col gap-0.5 p-2 opacity-80">${off.map(s => row(s)).join("")}</ul></details>` : "");
}

// ── timeline ─────────────────────────────────────────────────────────────────
const nearBottom = el => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
function pass(e) {
  const f = LS.get("tlf", "all"), s = LS.get("tls", "");
  if (f !== "all" && (f === "control" ? !["control", "turn"].includes(famOf(e.topic)) : famOf(e.topic) !== f)) return false;
  if (s && e.from !== s && e.to !== s && !e.from.startsWith(s + ".") && !(e.to || "").startsWith(s + ".")) return false;
  return true;
}
const bkey = e => /^task\.(status|ready|created|assigned)$|^kb\.added$/.test(e.topic) && !e.needs_reply ? `${e.from}|${famOf(e.topic)}` : "";
const canReply = e => e.from !== "owner" && e.topic !== "reply" && (e.to === "owner" || (e.to == null && e.needs_reply)) && !(D.REPL.get(e.seq) || []).includes("owner");
function askState(e) {
  const by = D.REPL.get(e.seq) || [];
  return by.length ? `<span class="pill c-green h-5 px-1.5 text-2xs">${I("check", "size-3")}Answered by ${esc(by.map(who).join(", "))}</span>` : `<span class="pill c-peach h-5 px-1.5 text-2xs">${I("hourglass", "size-3")}Waiting for ${esc(e.to === "owner" ? "you" : e.to || "anyone")}</span>`;
}
const taskOf = e => e.data?.task || (e.ref && (S.byId.has(e.ref) || famOf(e.topic) === "task") ? e.ref : null);
// the feed is coloured by topic family: task.* mint/amber/red by status, turn.* cyan, knowledge
// violet, messages blue, pause red — as an hr-feed-icon variant plus its c-* ink carrier
function feedTint(e) {
  const f = famOf(e.topic);
  if (f === "task") {
    const st = e.data?.status || tState(S.byId.get(taskOf(e)));
    return st === "done" || st === "skipped" ? ["hr-feed-task-done", "c-green"] : st === "blocked" ? ["hr-feed-task-blocked", "c-red"] : ["hr-feed-task-doing", "c-yellow"];
  }
  if (f === "control") return e.topic === "control.pause" ? ["hr-feed-pause", "c-red"] : ["hr-feed-turn", "c-mauve"];
  return { turn: ["hr-feed-turn", "c-mauve"], kb: ["hr-feed-knowledge", "c-lavender"], msg: ["hr-feed-message", "c-blue"] }[f] || ["hr-feed-message", "c-idle"];
}
export function evHTML(e, compact = false) {
  const v = verb(e), txt = evText(e), task = taskOf(e), kb = /^kb:(\d+)$/.exec(e.ref || "")?.[1];
  const [hue, ink] = feedTint(e);
  const foot = [];
  if (task && !/task\./.test(e.topic) && e.topic !== "msg") foot.push(`<a class="tag hover:underline" href="${taskHref(task)}">${stIcon(tState(S.byId.get(task)), "size-3")}${esc(task)}</a>`);
  if (e.needs_reply) foot.push(`<span class="askst">${askState(e)}</span>`);
  if (canReply(e) && !compact) foot.push(`<button class="btn btn-sm" data-reply="${e.seq}">${I("undo", "size-3.5")}Reply</button>`);
  const verbHTML = v.v.replace(/<b class="font-medium text-fg">([\w.-]+)<\/b>/, (m, id) => S.byId.has(id) ? `<a class="font-medium text-fg underline-offset-2 hover:underline" href="${taskHref(id)}">${esc(id)}</a>` : m);
  return `<div class="ev hr-feed-row ${e.from === "owner" ? "mine" : ""} ${e.needs_reply ? "is-ask" : ""}" data-seq="${e.seq}" data-bkey="${esc(bkey(e))}">
    <span class="hr-feed-icon ${hue}" aria-hidden="true">${I(v.i, "size-3.5")}</span><div class="min-w-0 flex-1"><div class="flex flex-wrap items-baseline gap-x-1.5 text-[13px]"><b class="font-semibold ${ink} ink">${esc(who(e.from))}</b><span class="text-muted" title="${esc(e.topic)} · #${e.seq}">${verbHTML}</span></div>
    ${txt ? `<div class="prose-h md mt-0.5 ${e.topic === "kb.added" && kb ? "" : "text-muted"}">${e.topic === "kb.added" && kb ? `<a class="hover:underline" href="#/c/${esc(S.ch)}/knowledge/${kb}">${md(txt)}</a>` : md(txt)}</div>` : ""}${foot.length ? `<div class="mt-1 flex flex-wrap items-center gap-1.5">${foot.join("")}</div>` : ""}</div><span class="hr-feed-time">${tsEl(e.ts)}</span></div>`;
}
function burstHTML(evs) {
  const a = evs[0], fam = famOf(a.topic), last = evs.at(-1);
  const what = fam === "kb" ? `remembered ${evs.length} things` : evs.every(e => e.topic === "task.created") ? `planned ${evs.length} tasks` : evs.every(e => e.topic === "task.status" && e.data?.status === "done") ? `finished ${evs.length} tasks` : `updated ${evs.length} tasks`;
  const prev = evs.slice(0, 4).map(e => esc(fam === "kb" ? evText(e).slice(0, 40) : `${taskOf(e) || ""}`)).filter(Boolean).join(", ") + (evs.length > 4 ? "…" : "");
  return `<details class="burst" data-first="${a.seq}" data-bkey="${esc(bkey(a))}" data-seqs="${evs.map(e => e.seq).join(",")}" ${OPENB.has(a.seq) ? "open" : ""}>
    <summary>${av(a.from, true)}<span class="shrink-0 text-[13px]"><b class="font-semibold text-fg">${esc(who(a.from))}</b> <span class="text-muted" title="${esc([...new Set(evs.map(e => e.topic))].join(", "))}">${what}</span></span><span class="min-w-0 flex-1 truncate text-faint">${prev}</span><span class="hr-feed-time">${tsEl(last.ts)}</span>${I("right", "chev size-3.5 transition-transform")}</summary>
    <div class="border-t border-line bg-sunken/40 pl-6">${evs.map(e => evHTML(e)).join("")}</div></details>`;
}
function groups(list) {
  const out = [];
  for (const e of list) { const k = bkey(e), g = out.at(-1); if (k && g && g.k === k) g.evs.push(e); else out.push({ k, evs: [e] }); }
  return out.map(g => g.evs.length > 1 ? burstHTML(g.evs) : evHTML(g.evs[0])).join("");
}
function paintTL(bottom) {
  const tl = $("#tl"); if (!tl) return;
  const tls = $("#tls"), v = LS.get("tls", "");
  const names = [...new Set([...(S.sess?.sessions || []).map(s => s.name), ...(S.tl || []).map(e => e.from)])].filter(n => n !== "owner").sort();
  tls.innerHTML = `<option value="">Everyone</option><option value="owner">You</option>${names.map(n => `<option>${esc(n)}</option>`).join("")}`; tls.value = v;
  if (!S.tl) { tl.innerHTML = `<div class="p-4">${skel(5)}</div>`; return; }
  const list = S.tl.filter(pass);
  tl.innerHTML = (S.tl.length && S.tl[0].seq > 1 ? `<div class="p-2 text-center"><button class="btn btn-ghost btn-sm" id="older">Show older activity</button></div>` : "")
    + (groups(list) || `<div class="empty hr-empty">${I("activity", "size-6")}${LS.get("tlf", "all") === "all" && !v ? `<b>No activity yet</b><span class="hr-empty-hint">Events show up here the moment a session publishes them.</span>` : `<b>Nothing matches</b><span class="hr-empty-hint">Pick another filter or Everyone.</span>`}</div>`);
  if (bottom) { tl.scrollTop = tl.scrollHeight; NEWN = 0; $("#tlnew").hidden = true; }
}
function appendEvent(e) {
  const tl = $("#tl"); if (!tl || !e) return;
  if (e.reply_to) { const b = tl.querySelector(`[data-seq="${e.reply_to}"]`), q = S.tl?.find(x => x.seq === e.reply_to); if (b && q) { const st = b.querySelector(".askst"); if (st) st.innerHTML = askState(q); if (!canReply(q)) b.querySelector("[data-reply]")?.remove(); } }
  if (!pass(e)) return;
  const near = nearBottom(tl), k = bkey(e);
  tl.querySelector(":scope > .empty")?.remove();
  const last = [...tl.children].reverse().find(x => x.dataset.seq || x.dataset.first);
  if (k && last && last.dataset.bkey === k) {
    const seqs = last.dataset.seqs ? last.dataset.seqs.split(",").map(Number) : [+last.dataset.seq];
    last.outerHTML = burstHTML(seqs.map(s => S.tl.find(x => x.seq === s)).filter(Boolean).concat(e));
  } else tl.insertAdjacentHTML("beforeend", evHTML(e));
  if (near) tl.scrollTop = tl.scrollHeight;
  else { NEWN++; const p = $("#tlnew"); p.hidden = false; p.innerHTML = `${I("arrowdown", "size-3.5")}${NEWN} new`; p.setAttribute("aria-label", `${NEWN} new events: jump to the latest`); }
}
async function older() {
  const tl = $("#tl"), h = tl.scrollHeight, top = tl.scrollTop;
  if (!(await D.olderTL())) { $("#older")?.parentElement.remove(); return; }
  paintTL(false); tl.scrollTop = tl.scrollHeight - h + top;
}

// ── session drawer ───────────────────────────────────────────────────────────
const DR = () => $("#sdrawer");
let OFF = null;
export function openDrawer(name) {
  const d = DR(), same = d.open && S.sessName === name;
  S.sessName = name;
  if (!same) {
    d.innerHTML = `<div class="drawer-h" id="sd-head"></div><div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4" id="sd-body">
      <div id="sd-now"></div><div id="sd-acts"></div>
      <section aria-labelledby="sd-ch"><h3 class="hr-label mb-2" id="sd-ch">Write to ${esc(name)}</h3><div id="sd-comp"></div></section>
      <div id="sd-orch"></div><div id="sd-kids"></div>
      <section aria-labelledby="sd-eh"><h3 class="hr-label mb-1" id="sd-eh">Recent activity</h3><div id="sd-ev" class="-mx-4"></div></section>
      <dl id="sd-meta" class="hr-kv"></dl></div>`;
    C.mount($("#sd-comp"), "s:" + name, { to: name });
    OFF?.(); OFF = D.onChange(w => { if (DR().open && ["sess", "event", "board", "att", "info"].includes(w)) soon("sdr", () => preserve(paintDrawer), 80); });
  }
  paintDrawer();
  if (!d.open) { $("#tdrawer").open && $("#tdrawer").close(); openDlg(d); $("#sd-close")?.focus(); }
  if ($("#roster")) preserve(paintRoster);
}
export function closeDrawer() { if (DR().open) DR().close(); }
DR().addEventListener("close", () => { S.sessName = null; OFF?.(); OFF = null; if (new URLSearchParams(location.hash.split("?")[1] || "").get("s")) go(path()); if ($("#roster")) paintRoster(); });
function paintDrawer() {
  const name = S.sessName; if (!name || !$("#sd-head")) return;
  const s = (S.sess?.sessions || []).find(x => x.name === name);
  $("#sd-head").innerHTML = `${av(name)}<div class="min-w-0 flex-1"><h2 class="truncate text-[15px] font-semibold" id="sd-title">${esc(name)}</h2><p class="truncate text-xs text-muted">${esc(s?.role || s?.label || (s ? "" : "Not in this channel"))}</p></div>${s ? sPill(s) : ""}<button class="btn btn-ghost btn-icon" id="sd-close" aria-label="Close">${I("x")}</button>`;
  $("#sd-close").onclick = () => closeDlg(DR());
  if (!s) { $("#sd-now").innerHTML = `<div class="empty hr-empty">${I("users", "size-6")}<b>${esc(name)} has not joined this channel</b></div>`; return; }
  const k = sStatus(s), t = s.step ? S.byId.get(s.step) : null, next = (S.att?.next || []).find(x => x.session === name)?.task;
  const why = sWhy(s);
  $("#sd-now").innerHTML = `${why ? `<p class="hr-card mb-3 flex items-start gap-2 p-3 text-[13px]"><span class="${SSTM[k].c} ink mt-0.5">${I(SSTM[k].i, "size-4")}</span><span>${esc(why)}</span></p>` : ""}
    ${isOrch(name) ? `<p class="mb-3 flex items-center gap-2 text-xs text-muted">${I("baton", "size-4 text-faint")}The orchestrator: it plans and assigns the work for the others.</p>` : ""}
    <h3 class="hr-label mb-2">Now</h3>${t ? `<a class="hr-card flex items-center gap-3 p-3 hover:border-line2" href="${taskHref(t.id)}">${stIcon(tState(t))}<span class="tid hr-mono">${esc(t.id)}</span><span class="min-w-0 flex-1 truncate text-[13px] font-medium">${esc(t.title)}</span>${I("right", "size-4 text-faint")}</a>`
      : `<p class="text-[13px] ${s.task ? "" : "text-faint"}">${s.task ? md(s.task) : "No task right now."}</p>`}
    ${next && next.id !== t?.id ? `<p class="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">Next: <a class="inline-flex items-center gap-1 hover:underline" href="${taskHref(next.id)}"><span class="tid">${esc(next.id)}</span>${esc(next.title)}</a>${next.ready ? "" : `<span class="pill c-peach h-5 px-1.5 text-2xs">${I("hourglass", "size-3")}Waits on ${esc((next.unmet || []).join(", "))}</span>`}</p>` : ""}`;
  const live = s.state !== "left";
  $("#sd-acts").innerHTML = live ? `<div class="flex flex-wrap gap-2">${s.control === "pause" ? `<button class="btn btn-pri" data-ctl="resume">${I("play", "size-4")}Resume ${esc(name)}</button>` : `<button class="btn" data-ctl="pause" aria-describedby="sd-ph">${I("pause", "size-4")}Pause ${esc(name)}</button>`}
    <button class="btn" data-cm="msg">${I("msg", "size-4")}Message</button><button class="btn" data-cm="ask">${I("ask", "size-4")}Ask</button>
    ${s.parent ? "" : `<button class="btn" data-pass ${s.holds_turn ? "disabled" : ""}>${I("turn", "size-4")}${s.holds_turn ? "Holds the turn" : "Hand turn"}</button>`}</div>
    ${s.control === "pause" ? "" : `<p class="help mt-2" id="sd-ph">Pause stops it at its next check; its changes are refused until you resume it. It can still message you.</p>`}` : `<p class="hint">${esc(name)} left the channel.</p>`;
  $$("[data-ctl]", $("#sd-acts")).forEach(b => b.onclick = async () => {
    const what = b.dataset.ctl, undo = what === "pause" ? "resume" : "pause"; b.disabled = true;
    if (await act(what, { target: name }, `${name} ${what}d`, { undo: () => act(undo, { target: name }, `${name} ${undo}d`).then(() => { D.loadSess(); D.attChanged(); }) })) { await D.loadSess(); D.attChanged(); announce(`${name} ${what}d`); $(`[data-ctl]`, $("#sd-acts"))?.focus(); }
    else b.disabled = false;
  });
  $$("[data-cm]", $("#sd-acts")).forEach(b => b.onclick = () => { const m = $(`#sd-comp [data-mode="${b.dataset.cm}"]`); if (m?.getAttribute("aria-pressed") !== "true") m?.click(); $("#sd-comp textarea")?.focus(); });
  $$("[data-pass]", $("#sd-acts")).forEach(b => b.onclick = async () => { b.disabled = true; if (await act("pass", { to: name }, `${name} holds the turn now`)) D.loadSess(); else b.disabled = false; });
  // orchestration (when the channel config has an orchestrator key): context on next start, and a brief
  const ctx = s.context ?? null;
  $("#sd-orch").innerHTML = hasOrch() && live && !s.parent ? `<section aria-labelledby="sd-oh" class="flex flex-col gap-3"><h3 class="hr-label" id="sd-oh">Next start</h3>
    <div class="flex flex-wrap items-center gap-2"><span class="text-[13px]" id="sd-cl">Context on next start</span><div class="hr-seg" role="group" aria-labelledby="sd-cl">${[["sync", "Sync"], ["fresh", "Fresh"], ["", "Default"]].map(([v, l]) => `<button class="hr-seg-item ${(ctx || "") === v ? "hr-seg-on" : ""}" data-ctx="${v}" aria-pressed="${(ctx || "") === v}">${l}</button>`).join("")}</div></div>
    <p class="help -mt-1">Sync catches up on everything it missed. Fresh skips the backlog and starts from the brief. Default: sync when it returns.</p>
    <label class="label">Brief <textarea class="input hr-input" id="sd-brief" data-keep rows="3" placeholder="What ${esc(name)} needs to know when it starts" aria-describedby="sd-bh"></textarea><span class="help" id="sd-bh">A fresh start reads it instead of the history. It is also sent to ${esc(name)} now.</span></label>
    ${s.brief_waiting ? `<p class="help" role="status">${I("note", "size-4 inline")} A brief is waiting for ${esc(name)}'s next fresh start.</p>` : ""}
    <div><button class="btn" id="sd-bsend">${I("note", "size-4")}Save brief</button></div></section>` : "";
  $$("[data-ctx]", $("#sd-orch")).forEach(b => b.onclick = async () => { const v = b.dataset.ctx || null; if (await act("assign", { session: name, context: v }, v ? `${name} starts ${v === "fresh" ? "fresh" : "in sync"} next time` : `${name} uses the default next time`)) { $$("[data-ctx]").forEach(x => { x.setAttribute("aria-pressed", String(x === b)); x.classList.toggle("hr-seg-on", x === b); }); D.loadSess(); } });
  if ($("#sd-bsend")) $("#sd-bsend").onclick = async () => { const msg = $("#sd-brief").value.trim(); if (!msg) return $("#sd-brief").focus(); if (await act("brief", { session: name, msg }, `Brief saved for ${name}`)) $("#sd-brief").value = ""; };
  const kids = (S.sess?.sessions || []).filter(x => x.parent === name && x.state !== "left");
  $("#sd-kids").innerHTML = kids.length ? `<section aria-labelledby="sd-kh"><h3 class="hr-label mb-1" id="sd-kh">Subagents</h3><ul class="flex flex-col gap-2">${kids.map(x => row(x, false)).join("")}</ul></section>` : "";
  const evs = (S.tl || []).filter(e => e.from === name || e.to === name || e.from.startsWith(name + ".")).slice(-12).reverse();
  $("#sd-ev").innerHTML = evs.length ? evs.map(e => evHTML(e, true)).join("") : `<div class="hr-empty"><span>Nothing yet.</span></div>`;
  $("#sd-meta").innerHTML = [["Last seen", tsEl(s.last_seen), ""], ["Unread", s.unread ?? 0, s.unread ? "c-mauve" : ""], ["Open questions for it", s.open ?? 0, s.open ? "c-peach" : ""], ["Paused by", s.control === "pause" ? esc(whoL(s.control_by || "")) : "—", s.control === "pause" ? "c-red" : ""]].map(([a, b, c]) => `<div class="hr-kv-row ${c}"><dt>${a}</dt><dd>${b}</dd></div>`).join("");
}
