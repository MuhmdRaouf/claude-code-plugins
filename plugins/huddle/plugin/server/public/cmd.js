// cmd.js — the command palette (⌘K / Ctrl-K) and the keyboard. The palette jumps to the five
// destinations, tasks (the cached plan plus the server's full-text search), sessions and channels,
// and runs the owner's actions with the names the owner thinks in: "Pause web", "Ask docs",
// "Approve api-2", "New task". "?" lists every shortcut.
import { $, $$, esc, enc, S, cu, api, act, I, fuzzy, stIcon, tState, STAT, STATM, LS, openDlg, closeDlg } from "./core.js";
import * as D from "./data.js";
import { go, toggleTheme, setTheme, openModal, taskHref, sessHref, DESTS } from "./app.js";
import * as C from "./compose.js";
import * as W from "./work.js";

let ITEMS = [], K = 0, SRCH = null, Q = "";
const WORKV = [["list", "List"], ["board", "Board"], ["graph", "Graph"], ["map", "Map"]];

function base() {
  const out = [], ch = !!S.ch;
  if (ch) {
    for (const [k, l, ic, key] of DESTS) out.push({ g: "Go to", t: l, i: ic, kb: "g " + key, run: () => go(`#/c/${S.ch}/${k}`) });
    out.push({ g: "Go to", t: "Today", s: "what got done, per session", i: "clock", run: () => go(`#/c/${S.ch}/today`) });
    for (const [k, l] of WORKV) out.push({ g: "Go to", t: `Work: ${l}`, i: "list", run: () => go(`#/c/${S.ch}/work/${k}`) });
    for (const a of S.att?.asks || []) out.push({ g: "Needs you", t: `Answer ${a.from}`, s: (a.msg || "").slice(0, 80), i: "ask", run: () => go(`#/c/${S.ch}/inbox`) });
    for (const g of S.att?.gates || []) out.push({ g: "Needs you", t: `Approve ${g.id}`, s: g.title, i: "key", run: async () => { if (await act("approve", { id: g.id }, `Approved ${g.id}`)) D.loadAtt(); } });
    for (const s of (S.sess?.sessions || []).filter(x => x.state !== "left")) {
      out.push(s.control === "pause" ? { g: "Sessions", t: `Resume ${s.name}`, i: "play", run: async () => { if (await act("resume", { target: s.name }, `${s.name} resumed`)) { D.loadSess(); D.loadAtt(); } } }
        : { g: "Sessions", t: `Pause ${s.name}`, s: "it stops at its next check", i: "pause", run: async () => { if (await act("pause", { target: s.name }, `${s.name} paused`, { undo: () => act("resume", { target: s.name }, `${s.name} resumed`).then(() => { D.loadSess(); D.loadAtt(); }) })) { D.loadSess(); D.loadAtt(); } } });
      out.push({ g: "Sessions", t: `Message ${s.name}`, i: "msg", run: () => C.openCompose({ to: s.name, mode: "msg" }) });
      out.push({ g: "Sessions", t: `Ask ${s.name}`, s: "a question it must answer", i: "ask", run: () => C.openCompose({ to: s.name, mode: "ask" }) });
      out.push({ g: "Sessions", t: `Give ${s.name} a task`, i: "plus", run: () => C.openCompose({ to: s.name, mode: "task" }) });
      if (!s.holds_turn && !s.parent) out.push({ g: "Sessions", t: `Hand the turn to ${s.name}`, i: "turn", run: async () => { if (await act("pass", { to: s.name }, `${s.name} holds the turn now`)) D.loadSess(); } });
      out.push({ g: "Sessions", t: `Open ${s.name}`, s: "its task, activity and actions", i: "users", run: () => go(sessHref(s.name)) });
    }
    out.push({ g: "Actions", t: "Send a message", i: "send", kb: "c", run: () => C.openCompose({ mode: "msg" }) });
    out.push({ g: "Actions", t: "New task", i: "plus", run: () => C.openCompose({ mode: "task", to: "" }) });
    out.push({ g: "Actions", t: "Remember something", i: "brain", run: () => go(`#/c/${S.ch}/knowledge`) });
    if ((S.att?.paused || []).length > 1) out.push({ g: "Actions", t: "Resume every paused session", i: "play", run: async () => { for (const p of S.att.paused) await act("resume", { target: p.name }); toast2(`Resumed ${S.att.paused.length} sessions`); D.loadSess(); D.loadAtt(); } });
    out.push({ g: "Actions", t: "Download the plan (export.md)", i: "download", run: () => window.open(cu("/export.md"), "_blank") });
    if (S.cur && S.task) for (const st of STAT) if (st !== S.cur.status) out.push({ g: "This task", t: `Mark ${S.cur.id} ${STATM[st].l.toLowerCase()}`, i: STATM[st].i, run: () => W.setTaskStatus(S.cur.id, st) });
  }
  for (const c of S.channels || []) if (c.name !== S.ch) out.push({ g: "Channels", t: c.title || c.name, s: c.name, i: "hash", run: () => go(`#/c/${c.name}`) });
  out.push({ g: "Channels", t: "All channels", i: "layers", run: () => go("#/") });
  out.push({ g: "Settings", t: "Theme: follow the system", i: "monitor", run: () => setTheme("system") });
  out.push({ g: "Settings", t: "Theme: light (Latte)", i: "sun", run: () => setTheme("light") });
  out.push({ g: "Settings", t: "Theme: dark (Mocha)", i: "moon", run: () => setTheme("dark") });
  out.push({ g: "Settings", t: D.notifyOn() ? "Stop notifying me of questions" : "Notify me of questions", i: "bell", run: () => D.toggleNotify() });
  out.push({ g: "Settings", t: "Keyboard shortcuts", i: "keyboard", kb: "?", run: help });
  return out;
}
const toast2 = t => import("./core.js").then(c => c.toast(t));
function compute() {
  const q = Q.trim(); let list = base();
  if (q) {
    list = list.map(x => [fuzzy(q, `${x.t} ${x.s || ""} ${x.g}`), x]).filter(x => x[0] >= 0).sort((a, b) => b[0] - a[0]).map(x => x[1]);
    const tasks = (S.board?.steps || []).map(s => [fuzzy(q, `${s.id} ${s.title} ${s.owner || ""}`), s]).filter(x => x[0] >= 0).sort((a, b) => b[0] - a[0]).slice(0, 12)
      .map(([, s]) => ({ g: "Tasks", t: s.title, id: s.id, st: tState(s), s: s.owner || "", run: () => go(taskHref(s.id)) }));
    const seen = new Set(tasks.map(t => t.id));
    const text = (SRCH?.q === q ? SRCH.r : []).filter(r => !seen.has(r.id)).slice(0, 8).map(r => ({ g: "Found in the task text", t: r.title, id: r.id, st: tState(S.byId.get(r.id)), s: (r.hit || "").replace(/[«»]/g, ""), run: () => go(taskHref(r.id)) }));
    const top = list.slice(0, 1), rest = list.slice(1, 14);
    list = (tasks.length && (!top.length || fuzzy(q, top[0].t) < fuzzy(q, tasks[0].id + " " + tasks[0].t))) ? [...tasks, ...top, ...rest, ...text] : [...top, ...tasks, ...rest, ...text];
  } else {
    const order = ["Needs you", "Go to", "Actions", "This task", "Sessions", "Channels", "Settings"];
    list = list.sort((a, b) => order.indexOf(a.g) - order.indexOf(b.g)).slice(0, 60);
  }
  return list;
}
function paintList() {
  ITEMS = compute(); K = Math.min(K, Math.max(0, ITEMS.length - 1));
  let g = null, gi = 0;
  $("#palres").innerHTML = ITEMS.map((x, i) => {
    const head = x.g !== g ? `${g === null ? "" : "</div>"}<div role="group" aria-labelledby="pg-${++gi}"><div class="hr-label px-3 pt-3 pb-1" id="pg-${gi}">${esc((g = x.g))}</div>` : "";
    return `${head}<div role="option" id="po-${i}" data-i="${i}" aria-selected="${i === K}" class="mx-1.5 flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors aria-selected:bg-hover aria-selected:text-fg">
      ${x.id ? `${stIcon(x.st || "todo")}<span class="tid">${esc(x.id)}</span>` : `<span class="text-faint">${I(x.i || "arrow")}</span>`}<span class="truncate">${esc(x.t)}</span><span class="min-w-0 flex-1 truncate text-xs text-faint">${esc(x.s || "")}</span>${x.kb ? `<span class="flex gap-0.5">${x.kb.split(" ").map(k => `<kbd class="hr-kbd">${esc(k)}</kbd>`).join("")}</span>` : ""}</div>`;
  }).join("") + (ITEMS.length ? "</div>" : "") || `<div class="hr-empty"><p>Nothing matches “${esc(Q)}”.</p><span class="hr-empty-hint">esc to close</span></div>`;
  $("#palq").setAttribute("aria-activedescendant", ITEMS.length ? "po-" + K : "");
  $$("[data-i]", $("#palres")).forEach(el => { el.onclick = () => run(+el.dataset.i); el.onmousemove = () => { if (K !== +el.dataset.i) { K = +el.dataset.i; hl(); } }; });
}
const hl = () => { $$("#palres [data-i]").forEach(el => el.setAttribute("aria-selected", String(+el.dataset.i === K))); $(`#po-${K}`)?.scrollIntoView({ block: "nearest" }); $("#palq").setAttribute("aria-activedescendant", "po-" + K); };
function run(i) { const x = ITEMS[i]; if (!x) return; closeDlg($("#pal")); setTimeout(() => x.run(), 0); }
export function openPalette(q = "") {
  const d = $("#pal");
  d.innerHTML = `<div class="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4"><span class="text-faint">${I("search")}</span><input id="palq" class="h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint" placeholder="${S.ch ? "Jump to a task, session or place, or run an action" : "Jump to a channel"}" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="palres" aria-autocomplete="list" aria-label="Search or run a command"><kbd class="hr-kbd">esc</kbd></div>
    <div id="palres" class="min-h-0 overflow-y-auto pb-1.5" role="listbox" aria-label="Results"></div>
    <div class="hidden shrink-0 items-center gap-3 border-t border-line px-4 py-2 text-2xs text-faint sm:flex"><span class="flex items-center gap-1"><kbd class="hr-kbd">↑</kbd><kbd class="hr-kbd">↓</kbd> move</span><span class="flex items-center gap-1"><kbd class="hr-kbd">↵</kbd> run</span><span class="flex-1"></span><span>Three letters or more also search the task text.</span></div>`;
  Q = q; K = 0;
  for (const x of $$("dialog[open]")) if (x !== d) x.close();
  openDlg(d);
  const inp = $("#palq"); inp.value = q; inp.focus();
  paintList();
  inp.oninput = () => {
    Q = inp.value; K = 0; paintList();
    const qq = Q.trim(); clearTimeout(openPalette.t);
    if (S.ch && qq.length >= 3) openPalette.t = setTimeout(async () => { const r = await api(cu(`/search?q=${enc(qq)}`)).catch(() => []); SRCH = { q: qq, r }; if (Q.trim() === qq && d.open) paintList(); }, 200);
  };
  inp.onkeydown = e => {
    if (e.key === "ArrowDown") { e.preventDefault(); K = Math.min(K + 1, ITEMS.length - 1); hl(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); K = Math.max(K - 1, 0); hl(); }
    else if (e.key === "Enter") { e.preventDefault(); run(K); }
  };
}
export function help() {
  const row = (k, d) => `<dt>${k.split(" ").map(x => `<kbd class="hr-kbd">${esc(x)}</kbd>`).join("")}</dt><dd>${d}</dd>`;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  openModal("Keyboard shortcuts", `<div class="grid gap-x-10 gap-y-6 p-5 sm:grid-cols-2">
    <section><h3 class="hr-label mb-2">Anywhere</h3><dl class="keys">${row(mac ? "⌘ K" : "Ctrl K", "Search or run a command")}${row("/", "Filter this view")}${row("c", "Send a message")}${row("?", "These shortcuts")}${row("esc", "Close a drawer or dialog")}</dl>
      <h3 class="hr-label mt-6 mb-2">Go to</h3><dl class="keys">${row("g i", "Inbox")}${row("g t", "Team")}${row("g w", "Work")}${row("g k", "Knowledge")}${row("g s", "Settings")}${row("g h", "All channels")}</dl></section>
    <section><h3 class="hr-label mb-2">Tasks</h3><dl class="keys">${row("j", "Next task")}${row("k", "Previous task")}${row("1", "To do")}${row("2", "Doing")}${row("3", "Done")}${row("4", "Blocked")}${row("5", "Skipped")}${row("n", "Write a note on the open task")}${row("⌘ ↵", "Save or send")}</dl>
      <h3 class="hr-label mt-6 mb-2">Inbox</h3><dl class="keys">${row("↵", "Send the reply you typed")}${row("⇧ ↵", "New line in a reply")}</dl></section></div>`, document.activeElement);
}

export function init() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  $("#palkbd").textContent = mac ? "⌘K" : "Ctrl K";
  $("#palbtn").onclick = () => openPalette();
  $("#help").onclick = help;
  let gKey = 0;
  document.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); const d = $("#pal"); if (d.open) closeDlg(d); else openPalette(); return; }
    if (e.target.matches("input,textarea,select,[contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
    const dlg = $$("dialog[open]"), inTask = dlg.length === 1 && dlg[0].id === "tdrawer";
    if (dlg.length && !inTask) return; // dialogs and the session drawer keep their keys
    if (gKey && Date.now() - gKey < 1200) {
      gKey = 0; const v = { i: "inbox", t: "team", w: "work", k: "knowledge", s: "settings" }[e.key];
      if (e.key === "h") { e.preventDefault(); go("#/"); } else if (v && S.ch) { e.preventDefault(); go(`#/c/${S.ch}/${v}`); } return;
    }
    if (e.key === "g") { gKey = Date.now(); return; }
    if (e.key === "?") { e.preventDefault(); help(); return; }
    if (e.key === "/" && !inTask) { e.preventDefault(); const el = $("#wq") || $("#kbq"); if (el) el.focus(); else openPalette(); return; }
    if (!S.ch) return;
    if (e.key === "c" && !inTask) { e.preventDefault(); C.openCompose({ mode: "msg" }); }
    else if ((e.key === "j" || e.key === "k") && (S.dest === "work" || inTask) && S.board) {
      const list = W.visible(); if (!list.length) return;
      const i = list.findIndex(s => s.id === S.task), n = e.key === "j" ? (i < 0 ? 0 : Math.min(i + 1, list.length - 1)) : Math.max(i - 1, 0);
      e.preventDefault(); go(taskHref(list[n].id));
    }
    else if (/^[1-5]$/.test(e.key) && inTask && S.cur) { e.preventDefault(); W.setStatus(STAT[+e.key - 1]); }
    else if (e.key === "n" && inTask) { e.preventDefault(); W.focusNote(); }
  });
}
