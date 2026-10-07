// compose.js — the owner's composer: to (everyone or one session) × kind (message, question that
// needs a reply, task for them). Task mode creates a task owned by the chosen session that waits on
// the picked tasks: how the owner asks one session to finish something before another starts.
// It lives in the session drawer (to that session) and in a dialog (c, ⌘K, New task, Message
// buttons). Never below the fold. Drafts survive re-renders and reloads, per channel and place.
import { $, $$, esc, LS, S, soon, act, toast, I, tsEl, md, pickerHTML, wirePicker, pickSet, pickVal, openDlg, closeDlg, who } from "./core.js";
import * as D from "./data.js";

const DRAFTS = {};
const draft = key => (DRAFTS[S.ch + key] ||= { to: "", mode: "msg", msg: "", title: "", after: [], about: [], phase: null, reply: null, ...LS.get(`draft:${S.ch}:${key}`, {}) });
const save = key => soon("draft" + key, () => LS.set(`draft:${S.ch}:${key}`, draft(key)), 300);
const MODES = [["msg", "Message", "msg"], ["ask", "Question", "ask"], ["task", "Task", "plus"]];

// the dialog: {to, mode, reply, about, phase}
export function openCompose(o = {}, trigger) {
  if (!S.ch) return;
  const d = draft("dlg");
  if (o.reply != null) d.reply = o.reply; else { d.reply = null; if (o.to !== undefined) d.to = o.to; if (o.mode) d.mode = o.mode; }
  if (o.about) d.about = [o.about];
  if (o.after) d.after = o.after;
  if (o.phase != null) d.phase = o.phase;
  save("dlg");
  const dl = $("#cdlg");
  mount(dl, "dlg", { dialog: true });
  for (const x of document.querySelectorAll("dialog[open]")) if (x !== dl) x.close();
  openDlg(dl, trigger);
  (d.reply == null && d.mode === "task" ? $("#dlg-title") : $("#dlg-msg"))?.focus();
}
// mount a composer in host. o: {dialog, to (fixed recipient), title}
export function mount(host, key, o = {}) {
  const d = draft(key), P = key.replace(/[^\w-]/g, "_");
  if (o.to) d.to = o.to;
  const rep = d.reply != null ? S.tl?.find(x => x.seq === d.reply) : null;
  if (d.reply != null && !rep && S.tl) d.reply = null;
  pickSet(P + "-after", d.after); pickSet(P + "-about", d.about);
  const names = (S.sess?.sessions || []).filter(s => s.state !== "left").map(s => s.name);
  if (d.to && !names.includes(d.to)) names.push(d.to);
  const toLabel = d.to ? who(d.to) : "everyone";
  host.innerHTML = `${o.dialog ? `<div class="dlg-h"><h2 class="min-w-0 flex-1 truncate text-[13px] font-semibold" id="ctitle-h">${rep ? `Reply to ${esc(rep.from)}` : d.mode === "task" ? "New task" : d.mode === "ask" ? "Ask a question" : "Send a message"}</h2><button class="btn btn-ghost btn-icon" data-cclose aria-label="Close">${I("x")}</button></div>` : ""}
   <div class="flex flex-col gap-3 ${o.dialog ? "p-4" : ""}">
    ${rep ? `<div class="flex items-start gap-2 rounded-lg border border-line bg-sunken p-2.5 text-xs"><span class="text-faint">${I("undo", "size-3.5")}</span><div class="min-w-0 flex-1">Replying to <b>${esc(rep.from)}</b> · ${tsEl(rep.ts)}<div class="mt-0.5 line-clamp-2 text-muted">${md((rep.msg || "").slice(0, 300))}</div></div><button class="btn btn-ghost btn-sm" data-crx>Cancel reply</button></div>` : `
    <div class="flex flex-wrap items-center gap-2">${o.to ? "" : `<label class="flex min-w-40 flex-1 items-center gap-2 text-xs text-muted">To <select class="input hr-input min-w-0 flex-1" id="${P}-to"><option value="">Everyone</option>${names.map(n => `<option ${n === d.to ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>`}
      <div class="seg" role="group" aria-label="Kind">${MODES.map(([k, l, ic]) => `<button data-mode="${k}" aria-pressed="${d.mode === k}">${I(ic, "size-3.5")}${l}</button>`).join("")}</div></div>`}
    ${!rep && d.mode === "task" ? `<label class="label">Title <input class="input hr-input" id="${P}-title" placeholder="What should ${esc(toLabel)} finish?" autocomplete="off" aria-describedby="${P}-terr"></label>
      <p class="err flex items-center gap-1.5" id="${P}-terr" hidden>${I("alert", "size-3.5")}A task needs a title.</p>
      <div class="label"><span id="${P}-afl">Waits on <span class="help">(optional: it starts once these are done)</span></span>${pickerHTML(P + "-after", null, { placeholder: "Pick tasks that must finish first", label: "Tasks it waits on" })}</div>` : ""}
    <label class="${!rep && d.mode === "task" ? "label" : "sr-only"}" for="${P}-msg">${!rep && d.mode === "task" ? `Details <span class="help">(optional)</span>` : "Message"}</label>
    <textarea id="${P}-msg" class="input hr-input" rows="${o.dialog ? 4 : 3}" placeholder="${rep ? `Answer ${esc(rep.from)}` : d.mode === "task" ? "What done means, where to look" : d.mode === "ask" ? `Ask ${esc(toLabel)} something they must answer` : `Tell ${esc(toLabel)} what to do, decide or check`}"></textarea>
    ${!rep && d.mode !== "task" ? `<div class="label"><span>About a task <span class="help">(optional)</span></span>${pickerHTML(P + "-about", null, { max: 1, placeholder: "Link a task", label: "Task it is about" })}</div>` : ""}
    <p class="hint" id="${P}-fx">${rep ? `${esc(rep.from)} gets it as the answer, and the question closes.` : effect(d)}</p>
    <div class="flex items-center gap-2"><span class="hint hidden items-center sm:flex"><kbd class="hr-kbd">⌘</kbd><kbd class="hr-kbd">↵</kbd> sends</span><span class="flex-1"></span>${o.dialog ? `<button class="btn btn-ghost" data-cclose>Cancel</button>` : ""}<button class="btn btn-pri" id="${P}-send">${I(d.mode === "task" && !rep ? "plus" : "send", "size-4")}${rep ? "Send reply" : d.mode === "task" ? "Create task" : d.mode === "ask" ? `Ask ${esc(toLabel)}` : `Send to ${esc(toLabel)}`}</button></div>
   </div>`;
  const q = s => host.querySelector("#" + P + s);
  q("-msg").value = d.msg; if (q("-title")) q("-title").value = d.title;
  const fx = () => { const e = q("-fx"); if (e && !rep) e.innerHTML = effect(d); };
  if (q("-to")) q("-to").onchange = e => { d.to = e.target.value; save(key); mount(host, key, o); q("-to")?.focus(); };
  $$("[data-mode]", host).forEach(b => b.onclick = () => { d.mode = b.dataset.mode; save(key); mount(host, key, o); host.querySelector(`[data-mode="${d.mode}"]`)?.focus(); });
  q("-msg").oninput = e => { d.msg = e.target.value; save(key); };
  if (q("-title")) q("-title").oninput = e => { d.title = e.target.value; save(key); e.target.removeAttribute("aria-invalid"); const er = q("-terr"); if (er) er.hidden = true; };
  wirePicker(P + "-after", { placeholder: "Pick tasks that must finish first", label: "Tasks it waits on", onChange: ids => { d.after = ids; save(key); fx(); } });
  wirePicker(P + "-about", { max: 1, placeholder: "Link a task", label: "Task it is about", onChange: ids => { d.about = ids; save(key); } });
  host.onkeydown = e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } };
  q("-send").onclick = send;
  $$("[data-crx]", host).forEach(b => b.onclick = () => { d.reply = null; save(key); mount(host, key, o); });
  $$("[data-cclose]", host).forEach(b => b.onclick = () => closeDlg(host));
  async function send() {
    const msg = q("-msg").value.trim(), btn = q("-send"); let r;
    if (d.reply != null) { if (!msg) return q("-msg").focus(); btn.disabled = true; r = await act("reply", { seq: d.reply, msg }, "Reply sent"); }
    else if (d.mode === "task") {
      const title = q("-title").value.trim(); if (!title) { q("-title").focus(); q("-title").setAttribute("aria-invalid", "true"); const er = q("-terr"); if (er) er.hidden = false; return; }
      btn.disabled = true;
      r = await act("task_create", { title, owner: d.to || undefined, after: pickVal(P + "-after"), phase: d.phase ?? undefined, what: msg || undefined });
      if (r) { toast(`Created ${r.task?.id}${d.to ? ` for ${d.to}` : ""}${d.after.length ? `. It starts after ${d.after.join(", ")}` : ""}.`); D.boardChanged(); }
    } else {
      if (!msg) return q("-msg").focus();
      btn.disabled = true;
      r = await act("send", { to: d.to || undefined, msg, ask: d.mode === "ask" || undefined, task: d.about[0] || undefined }, d.mode === "ask" ? `Asked ${d.to || "everyone"}` : `Sent to ${d.to || "everyone"}`);
    }
    if (q("-send")) q("-send").disabled = false;
    if (!r) return;
    Object.assign(d, { msg: "", title: "", after: [], about: [], reply: null }); save(key); D.attChanged();
    if (o.dialog) closeDlg(host); else { mount(host, key, o); q("-msg")?.focus(); }
  }
}
function effect(d) {
  const t = d.to ? `<b>${esc(who(d.to))}</b>` : "every session";
  if (d.mode === "ask") return `${d.to ? t : "Every session"} must answer: it waits in their inbox and wakes them until they reply.`;
  if (d.mode === "task") return `Creates a task ${d.to ? `for ${t}` : "that nobody owns yet"}${d.after.length ? `. It waits on <b>${d.after.map(esc).join(", ")}</b>, and ${d.to ? t : "its owner"} is woken when they are done` : ""}.`;
  return `${d.to ? t : "Every session"} reads it at the next check of the inbox.`;
}
