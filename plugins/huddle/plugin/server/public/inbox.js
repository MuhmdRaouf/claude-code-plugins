// inbox.js — Inbox: only what needs the owner, from one read of GET /api/c/<ch>/attention:
// asks to you (quick replies and a text reply), tasks gated on your approval, paused sessions and
// blocked tasks. Each item carries its one or two actions and leaves the list once handled; the
// list ends on "All clear". New items are announced politely (data.js).
import { $, $$, esc, S, act, md, tsEl, I, av, preserve, skel, whoL, announce } from "./core.js";
import * as D from "./data.js";
import { taskHref, sessHref, routeTok } from "./app.js";
import * as C from "./compose.js";
import { setTaskStatus } from "./work.js";
import * as X from "./extras.js";

const QUICK = ["Yes, go ahead", "No, stop", "Wait for me"];
const NOTE = new Set(); // approvals with the note field open
let FOCUS = null;       // after an item leaves, focus moves to the item now in its place

export async function view(sub, tok) {
  if (!S.att) $("#main").innerHTML = `<div class="mx-auto max-w-3xl p-4 sm:p-6">${skel(4, "h-28")}</div>`;
  await D.loadAtt();
  if (tok !== routeTok()) return;
  S.repaint = what => (what === "att" || what === "board") && preserve(paint);
  paint();
}
const section = (id, title, n, body) => n ? `<section class="flex flex-col gap-2" aria-labelledby="ih-${id}"><h2 class="h2 flex items-center gap-2 px-1" id="ih-${id}">${title}<span class="text-xs font-medium text-muted tabular-nums">${n}</span></h2><ul class="flex flex-col gap-2">${body}</ul></section>` : "";
function paint() {
  const A = S.att; if (!A || S.dest !== "inbox") return;
  const asks = A.asks || [], gates = A.gates || [], paused = A.paused || [], blocked = A.blocked || [], n = D.inboxCount();
  const sum = [asks.length && `${asks.length} question${asks.length > 1 ? "s" : ""}`, gates.length && `${gates.length} approval${gates.length > 1 ? "s" : ""}`, paused.length && `${paused.length} paused`, blocked.length && `${blocked.length} blocked`, X.needsText()].filter(Boolean).join(" · ");
  $("#main").innerHTML = `<div class="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
   <div><h1 class="h1" tabindex="-1" id="ib-h">Inbox</h1><p class="page-sub">${n ? `${n} thing${n > 1 ? "s" : ""} need${n === 1 ? "s" : ""} you: ${sum}.` : "Nothing needs you."}</p></div>
   ${n ? "" : `<div class="hr-card flex flex-col items-center gap-2 px-6 py-14 text-center text-[13px] text-muted"><span class="hr-stat-icon hr-tint-good mb-1 size-12 rounded-full">${I("check", "size-6")}</span><b class="text-[16px] font-semibold text-fg" tabindex="-1" id="ib-clear">All clear</b><span>No questions, approvals, paused sessions or blocked tasks.</span><span class="hr-empty-hint">The sessions are working on their own.</span><div class="mt-2 flex flex-wrap justify-center gap-2"><a class="btn" href="#/c/${esc(S.ch)}/team">${I("users", "size-4")}See the team</a><a class="btn" href="#/c/${esc(S.ch)}/work">${I("list", "size-4")}Plan work</a></div></div>`}
   ${X.inboxHTML()}
   ${section("asks", "Questions for you", asks.length, asks.map(askItem).join(""))}
   ${section("gates", "Waiting for your approval", gates.length, gates.map(gateItem).join(""))}
   ${section("paused", "Paused", paused.length, paused.map(pausedItem).join(""))}
   ${section("blocked", "Blocked", blocked.length, blocked.map(blockedItem).join(""))}
  </div>`;
  wire();
  if (FOCUS != null) { const items = $$("#main [data-item]"); const el = items[Math.min(FOCUS, items.length - 1)]; (el ? el.querySelector("button,textarea,a") : $("#ib-clear"))?.focus(); FOCUS = null; }
}
const tlink = (id, title) => `<a class="inline-flex max-w-full items-center gap-1.5 hover:underline" href="${taskHref(id)}"><span class="tid">${esc(id)}</span><span class="truncate">${esc(title || S.byId.get(id)?.title || "")}</span></a>`;
const item = (key, body) => `<li class="hr-card p-4" data-item="${esc(key)}">${body}</li>`;
function askItem(a) {
  return item("a" + a.seq, `<div class="flex items-start gap-3">${av(a.from)}<div class="min-w-0 flex-1">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint"><b class="text-[13px] text-fg">${esc(a.from)}</b><span>asks you · ${tsEl(a.ts)}</span>${a.task ? `<span class="text-xs">about ${tlink(a.task)}</span>` : ""}</div>
    <div class="prose-h md mt-1">${md(a.msg || "")}</div>
    <div class="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Quick replies">${QUICK.map(q => `<button class="chip" data-quick="${a.seq}">${esc(q)}</button>`).join("")}</div>
    <div class="mt-2 flex items-end gap-2"><label class="sr-only" for="ar-${a.seq}">Your reply to ${esc(a.from)}</label><textarea id="ar-${a.seq}" data-keep rows="1" class="input hr-input min-h-8 flex-1 resize-none py-1.5" placeholder="Write a reply (Enter sends, Shift+Enter adds a line)"></textarea><button class="btn btn-pri" data-send="${a.seq}">${I("send", "size-4")}Reply</button></div>
  </div></div>`);
}
function gateItem(g) {
  const open = NOTE.has(g.id);
  return item("g" + g.id, `<div class="flex flex-col gap-3 sm:flex-row sm:items-center"><div class="flex min-w-0 flex-1 items-start gap-3"><span class="hr-stat-icon hr-tint-accent">${I("key")}</span>
    <div class="min-w-0"><div class="text-[13px] font-medium">${tlink(g.id, g.title)}</div><div class="mt-0.5 text-xs text-muted">${g.owner && g.owner !== "owner" ? `${esc(g.owner)} waits` : "It waits"} for your go-ahead before it starts${g.gate === "ask-first" ? " (ask first)" : ""}.</div></div></div>
    <div class="flex flex-wrap gap-1.5 sm:justify-end"><button class="btn btn-pri" data-approve="${esc(g.id)}">${I("check", "size-4")}Approve</button>${open ? "" : `<button class="btn" data-approve-note="${esc(g.id)}">Approve with a note</button>`}</div></div>
    ${open ? `<div class="mt-3 flex gap-2 sm:pl-9"><label class="sr-only" for="gn-${esc(g.id)}">Note for ${esc(g.owner || "the session")}</label><input class="input hr-input" id="gn-${esc(g.id)}" data-keep placeholder="Note for ${esc(g.owner || "the session")}"><button class="btn btn-pri" data-approve="${esc(g.id)}">Approve</button><button class="btn btn-ghost" data-close="${esc(g.id)}">Cancel</button></div>` : ""}`);
}
function pausedItem(p) {
  return item("p" + p.name, `<div class="flex flex-wrap items-center gap-3"><span class="hr-stat-icon c-mauve">${I("pause")}</span><div class="min-w-0 flex-1 basis-56"><a class="text-[13px] font-medium hover:underline" href="${sessHref(p.name)}">${esc(p.name)} is paused</a><div class="text-xs text-muted">Paused by ${esc(whoL(p.by || "someone"))} ${tsEl(p.at)}. Its changes are refused until you resume it.</div></div>
    <div class="flex gap-1.5"><button class="btn" data-msg="${esc(p.name)}">${I("msg", "size-4")}Message</button><button class="btn btn-pri" data-resume="${esc(p.name)}">${I("play", "size-4")}Resume ${esc(p.name)}</button></div></div>`);
}
function blockedItem(b) {
  const owners = [...new Set((S.sess?.sessions || []).filter(s => s.state !== "left" && !s.parent).map(s => s.name))].filter(n => n !== b.owner);
  return item("b" + b.id, `<div class="flex items-start gap-3"><span class="hr-stat-icon hr-tint-bad">${I("ban")}</span><div class="min-w-0 flex-1">
    <div class="text-[13px] font-medium">${tlink(b.id, b.title)}</div>
    <div class="mt-0.5 text-xs text-muted">${b.owner ? (b.owner === "owner" ? "Yours" : `Owned by ${esc(b.owner)}`) : "Nobody owns it"}${b.note ? `. “${esc(b.note)}”` : ""}</div>
    ${b.waits_on?.length ? `<div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs"><span class="text-faint">Waits on</span>${b.waits_on.map(id => tlink(id)).join("")}</div>` : ""}
    <div class="mt-3 flex flex-wrap items-center gap-1.5"><button class="btn" data-unblock="${esc(b.id)}">${I("undo", "size-4")}Unblock</button>
      <label class="sr-only" for="ro-${esc(b.id)}">Give ${esc(b.id)} to</label><select class="input hr-input w-auto" id="ro-${esc(b.id)}" data-reassign="${esc(b.id)}"><option value="" selected>Give it to…</option><option value="owner">Me</option>${owners.map(n => `<option>${esc(n)}</option>`).join("")}</select>
      <a class="btn btn-ghost" href="${taskHref(b.id)}">Open task</a></div></div></div>`);
}
// an item was handled: it leaves the list, focus goes to the item in its place
const handled = async (el, msg) => { FOCUS = $$("#main [data-item]").indexOf(el.closest("[data-item]")); el.closest("[data-item]")?.setAttribute("hidden", ""); if (msg) announce(msg); await D.loadAtt(); };
async function reply(seq, msg, btn) {
  if (!msg.trim()) { $(`#ar-${seq}`)?.focus(); return; }
  const li = btn.closest("[data-item]"); $$("button", li).forEach(b => b.disabled = true);
  if (await act("reply", { seq, msg: msg.trim() }, "Reply sent")) handled(btn);
  else $$("button", li).forEach(b => b.disabled = false);
}
function wire() {
  const m = $("#main");
  $$("[data-quick]", m).forEach(b => b.onclick = () => reply(+b.dataset.quick, b.textContent, b));
  $$("[data-send]", m).forEach(b => b.onclick = () => reply(+b.dataset.send, $(`#ar-${b.dataset.send}`).value, b));
  $$("textarea[id^=ar-]", m).forEach(t => {
    t.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); reply(+t.id.slice(3), t.value, t); } };
    t.oninput = () => { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight + 2, 200) + "px"; };
  });
  $$("[data-approve]", m).forEach(b => b.onclick = async () => { const id = b.dataset.approve, msg = $(`#gn-${CSS.escape(id)}`)?.value.trim() || ""; b.disabled = true; if (await act("approve", { id, msg }, `Approved ${id}`)) { NOTE.delete(id); D.boardChanged(); handled(b); } else b.disabled = false; });
  $$("[data-approve-note]", m).forEach(b => b.onclick = () => { NOTE.add(b.dataset.approveNote); preserve(paint); $(`#gn-${CSS.escape(b.dataset.approveNote)}`)?.focus(); });
  $$("input[id^=gn-]", m).forEach(i => i.onkeydown = e => { if (e.key === "Enter") i.parentElement.querySelector("[data-approve]")?.click(); if (e.key === "Escape") { e.preventDefault(); NOTE.delete(i.id.slice(3)); preserve(paint); } });
  $$("[data-close]", m).forEach(b => b.onclick = () => { NOTE.delete(b.dataset.close); paint(); $(`[data-approve-note="${CSS.escape(b.dataset.close)}"]`)?.focus(); });
  $$("[data-unblock]", m).forEach(b => b.onclick = async () => { if (await setTaskStatus(b.dataset.unblock, "todo", "unblocked by the owner")) handled(b); });
  $$("[data-reassign]", m).forEach(s => s.onchange = async () => { const id = s.dataset.reassign, to = s.value; if (!to) return; const was = S.byId.get(id)?.owner || null;
    if (await act("task_update", { id, owner: to }, `${id} now belongs to ${to === "owner" ? "you" : to}`, { undo: () => act("task_update", { id, owner: was }, `${id} is back with ${was || "nobody"}`).then(() => { D.boardChanged(); D.attChanged(); }) })) { D.boardChanged(); D.attChanged(); } });
  $$("[data-resume]", m).forEach(b => b.onclick = async () => { const n = b.dataset.resume; b.disabled = true; if (await act("resume", { target: n }, `${n} resumed`, { undo: () => act("pause", { target: n }, `${n} paused again`).then(() => { D.loadSess(); D.loadAtt(); }) })) { D.loadSess(); handled(b); } else b.disabled = false; });
  $$("[data-msg]", m).forEach(b => b.onclick = () => C.openCompose({ to: b.dataset.msg, mode: "msg" }, b));
  X.wireInbox(m);
}
