// conflicts.js — the Overview's Conflicts panel: every file two live sessions of the channel edited
// in the last 30 minutes (same repo), with who and when (GET /api/c/<ch>/conflicts, server/src/
// touches.ts). The sessions were each told once, in their own context; this is the owner's view.
// It repaints on the stream's "conflict" messages and when sessions come and go. Nothing to resolve
// here: no locks, a session's work never waits on it.
import { $, esc, S, cu, api, soon, I, av, tsEl, hrEmpty } from "./core.js";
import * as D from "./data.js";

let EL = null, CH = null;
const row = c => `<li class="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
  <div class="flex min-w-0 flex-1 items-center gap-2"><span class="c-peach ink inline-flex">${I("file", "size-4")}</span>
    <code class="truncate text-[13px] font-medium" title="${esc(c.path)}">${esc(c.path)}</code>
    <span class="tag shrink-0" title="${esc(c.repo)}">${I("folder", "size-3.5")}${esc(c.repo_name)}</span></div>
  <ul class="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Sessions that edited it">${c.sessions.map(s => `<li class="flex items-center gap-1.5 text-xs text-muted">${av(s.name, true)}<span class="font-medium text-fg">${esc(s.name)}</span>${tsEl(s.at)}</li>`).join("")}</ul></li>`;

function paint(d) {
  if (!EL?.isConnected) return;
  const list = d?.conflicts || [];
  EL.innerHTML = `<section class="hr-card" aria-labelledby="ovconf-h">
    <div class="hr-card-head flex-wrap"><div class="min-w-0"><h2 class="hr-label flex items-center gap-2" id="ovconf-h">Conflicts${list.length ? ` <span class="hr-pill hr-pill-waiting">${list.length}</span>` : ""}</h2>
      <p class="text-xs text-muted">Files two sessions edited in the last ${d?.window_min || 30} minutes. Each was told once; nothing is locked.</p></div></div>
    ${list.length ? `<ul class="flex flex-col divide-y divide-line" aria-label="Files edited by more than one session">${list.map(row).join("")}</ul>`
      : `<div class="p-2">${hrEmpty("No overlapping edits", "When two sessions edit the same file within 30 minutes, it shows here.", "checkc")}</div>`}</section>`;
}
const load = () => { const ch = S.ch; api(cu("/conflicts")).then(d => { if (S.ch === ch) paint(d); }).catch(() => {}); };

// fill el (the Overview's slot) now and keep it current while it is on the page
export function mount(el) {
  EL = el; CH = S.ch;
  load();
}
D.onChange(what => {
  if (!EL?.isConnected || S.ch !== CH) return;
  if (what === "conflict" || what === "sess") soon("conflicts", load, 400);
});
