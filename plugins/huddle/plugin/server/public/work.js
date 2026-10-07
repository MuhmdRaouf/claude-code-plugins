// work.js — Work: the plan's tasks as a List, a Board, a dependency Graph or a Map (phases,
// each session's current and next task, the critical path), with one set of filters (mine, ready,
// waiting, blocked, has notes), plus the repo views when the channel has a repo. Opening a task
// opens the task drawer over the current view: status, owner and dependencies first, then only
// the filled sections, one "Add section" menu, and the notes for the sessions.
import { $, $$, esc, enc, LS, S, cu, href, api, op, act, ago, tsEl, soon, copy, preserve, I, STAT, FIN, STATM, tState, stPill, stIcon, av, toast, fuzzy, md, paras, mdBlock, codeBlock, langOf,
  skel, pickerHTML, wirePicker, popMenu, openDlg, closeDlg, wireTabs, sStatus, SSTM, hasOrch, announce, who, whoL } from "./core.js";
import * as D from "./data.js";
import { taskHref, sessHref, routeTok, go, path, openModal, progressBar, isOrch } from "./app.js";
import * as C from "./compose.js";

const VIEWS = [["list", "List", "list"], ["board", "Board", "columns"], ["graph", "Graph", "graph"], ["map", "Map", "map"]];
const FILTERS = [["all", "All"], ["mine", "Mine"], ["ready", "Ready"], ["waiting", "Waiting"], ["blocked", "Blocked"], ["notes", "Has notes"]];
const fkey = k => `${k}:${S.ch}`;
export const filter = () => LS.get(fkey("wfilter"), "all");

// ── plan helpers ─────────────────────────────────────────────────────────────
export function phases() {
  const B = S.board; if (!B) return [];
  const m = new Map(B.phases.map(p => [p.n, p]));
  for (const s of B.steps) if (!m.has(s.phase_n)) m.set(s.phase_n, { n: s.phase_n, title: `Phase ${s.phase_n}`, implied: true });
  return [...m.values()].sort((a, b) => a.n - b.n);
}
function matches(s, f = filter()) {
  const ow = LS.get(fkey("wowner"), ""), ph = LS.get(fkey("wphase"), "all"), q = (LS.get(fkey("wq"), "") || "").trim();
  if (ow && (ow === "-" ? s.owner : s.owner !== ow)) return false;
  if (ph !== "all" && phases().length > 1 && s.phase_n !== Number(ph)) return false;
  if (q && fuzzy(q, `${s.id} ${s.title} ${s.owner || ""}`) < 0) return false;
  const k = tState(s);
  switch (f) {
    case "mine": return s.owner === "owner";
    case "ready": return !FIN.has(s.status) && k !== "waiting" && k !== "blocked";
    case "waiting": return k === "waiting";
    case "blocked": return k === "blocked";
    case "notes": return !!s.comments?.open;
  }
  return true;
}
export const visible = () => (S.board?.steps || []).filter(s => matches(s));
// the critical path: the longest chain of unfinished tasks through their dependencies
export function critical() {
  const steps = (S.board?.steps || []).filter(s => !FIN.has(s.status)), by = new Map(steps.map(s => [s.id, s])), memo = new Map(), on = new Set();
  const len = id => { if (memo.has(id)) return memo.get(id); if (on.has(id)) return [0, null]; on.add(id);
    let best = [0, null]; for (const d of by.get(id).depends || []) if (by.has(d)) { const l = len(d)[0]; if (l > best[0]) best = [l, d]; }
    on.delete(id); const r = [best[0] + 1, best[1]]; memo.set(id, r); return r; };
  let top = null, n = 0; for (const s of steps) { const l = len(s.id)[0]; if (l > n) { n = l; top = s.id; } }
  const chain = []; while (top) { chain.unshift(top); top = memo.get(top)[1]; }
  return chain.length > 1 ? chain : [];
}
const here = () => { const h = {}; for (const s of S.sess?.sessions || []) if (s.step && s.state !== "left") (h[s.step] ||= []).push(s.name); return h; };

// rows new or changed since the previous paint flash cyan for 1.5 s (off under reduced motion);
// the first paint after a load only primes the fingerprints, so nothing flashes on entry
let SEEN = null;
const fprint = s => `${s.status}|${s.owner || ""}|${s.title}|${s.depends?.length || 0}|${s.blocked_by?.length || 0}|${s.comments?.open || 0}`;
const changed = steps => { const hot = SEEN ? steps.filter(s => SEEN.get(s.id) !== fprint(s)) : []; SEEN = new Map(steps.map(s => [s.id, fprint(s)])); return new Set(hot.map(s => s.id)); };

// ── the view ─────────────────────────────────────────────────────────────────
export async function view(sub, tok) {
  if (!S.board) await D.loadBoard().catch(() => {});
  if (tok !== routeTok()) return;
  const repo = (S.info?.views || []).length > 0;
  let v = sub[0];
  if (!VIEWS.some(x => x[0] === v) && !(v === "repo" && repo)) { v = LS.get(fkey("wview"), "list"); if (v === "repo" && !repo) v = "list"; history.replaceState(null, "", `#/c/${S.ch}/work/${v}${location.hash.includes("?") ? "?" + location.hash.split("?")[1] : ""}`); S.key = `${S.ch}/work/${v}`; }
  LS.set(fkey("wview"), v);
  const tabs = [...VIEWS, ...(repo ? [["repo", "Repo", "code"]] : [])];
  const canPlan = true; // the owner may always plan; the orchestrator does it through its own session
  $("#main").innerHTML = `<div class="flex min-h-full flex-col">
    <div class="flex flex-col gap-3 border-b border-line px-4 pt-4 pb-3 sm:px-6">
      <div class="flex flex-wrap items-center gap-3"><h1 class="h1 mr-1">Work</h1>
        <div class="seg" role="tablist" aria-label="View">${tabs.map(([k, l, ic]) => `<button role="tab" id="wt-${k}" data-tab="${k}" aria-selected="${v === k}" aria-controls="wpanel">${I(ic, "size-3.5")}${l}</button>`).join("")}</div>
        <span class="flex-1"></span>
        ${canPlan ? `<label class="btn btn-ghost cursor-pointer" title="Load a plan file (JSON). Status, edits and notes are kept by task id.">${I("upload", "size-4")}Import a plan<input type="file" id="imp" accept=".json,application/json" class="sr-only"></label>` : ""}
        <button class="btn btn-pri" id="wnew">${I("plus", "size-4")}New task</button></div>
      ${v === "repo" ? "" : `<div id="wfilters"></div>`}</div>
    <div id="wpanel" role="tabpanel" aria-labelledby="wt-${v}" class="min-h-0 flex-1"></div></div>`;
  wireTabs($('[role="tablist"]', $("#main")), k => go(`#/c/${S.ch}/work/${k}`));
  $("#wnew").onclick = e => C.openCompose({ mode: "task", to: "", phase: LS.get(fkey("wphase"), "all") !== "all" ? Number(LS.get(fkey("wphase"))) : undefined }, e.currentTarget);
  $("#imp").onchange = importPlan;
  if (v === "repo") return repoView(sub.slice(1), tok);
  const paint = () => { if (S.dest !== "work") return; paintFilters(); const hot = S.board ? changed(S.board.steps) : new Set();
    ({ list: () => paintList(hot), board: () => paintBoard(hot), graph: paintGraph, map: paintMap })[v](); };
  S.repaint = what => { if (what === "board" || what === "sess" || what === "att") preserve(paint); };
  paint();
}
async function importPlan(e) {
  const f = e.target.files[0]; if (!f) return;
  try { const j = JSON.parse(await f.text()); const r = await op("import_plan", { plan: j.plan ?? j }); toast(`Imported ${r.result.tasks} tasks in ${r.result.phases} phases${r.result.errors?.length ? `, with ${r.result.errors.length} problems: ${r.result.errors.slice(0, 2).join("; ")}` : ""}.`, { bad: !!r.result.errors?.length }); await D.loadBoard(); }
  catch (err) { toast(`The plan was not imported: ${err.message}`, { bad: true }); }
  e.target.value = "";
}
function paintFilters() {
  const el = $("#wfilters"); if (!el || !S.board) return;
  const f = filter(), ow = LS.get(fkey("wowner"), ""), ph = LS.get(fkey("wphase"), "all"), ps = phases();
  const owners = [...new Set(S.board.steps.map(s => s.owner).filter(Boolean))].sort();
  const cnt = k => S.board.steps.filter(s => matches(s, k)).length;
  const scope = S.board.steps.filter(s => matches(s, "all"));
  el.innerHTML = `<div class="flex flex-col gap-2.5">
    <div class="flex flex-wrap items-center gap-2"><div class="hr-seg" role="group" aria-label="Filter">${FILTERS.map(([k, l]) => { const n = k === "all" ? null : cnt(k); return `<button class="hr-seg-item ${f === k ? "hr-seg-on" : ""}" data-f="${k}" aria-pressed="${f === k}">${l}${n ? `<span class="hr-mono text-2xs opacity-60">${n}</span>` : ""}</button>`; }).join("")}</div>
      <span class="flex-1"></span>
      <div class="relative w-full sm:w-56"><span class="pointer-events-none absolute top-2 left-2.5 text-faint">${I("search")}</span><input id="wq" type="search" class="hr-input pl-8" data-keep placeholder="Filter by id, title or owner" aria-label="Filter tasks" value="${esc(LS.get(fkey("wq"), ""))}"></div>
      <label class="sr-only" for="wown">Owner</label><select id="wown" class="input w-auto"><option value="">Any owner</option><option value="owner" ${ow === "owner" ? "selected" : ""}>Me</option><option value="-" ${ow === "-" ? "selected" : ""}>Nobody</option>${owners.filter(o => o !== "owner").map(o => `<option ${o === ow ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>
      ${ps.length > 1 ? `<label class="sr-only" for="wph">Phase</label><select id="wph" class="input w-auto max-w-56"><option value="all">Every phase</option>${ps.map(p => `<option value="${p.n}" ${String(ph) === String(p.n) ? "selected" : ""}>${p.n} · ${esc(p.title)}</option>`).join("")}</select>` : ""}</div>
    ${scope.length ? `<div class="flex items-center gap-3"><div class="max-w-md flex-1">${progressBar(scope)}</div><span class="hint tnum">${legend(scope)}</span></div>` : ""}</div>`;
  $$("[data-f]", el).forEach(b => b.onclick = () => { LS.set(fkey("wfilter"), b.dataset.f); S.repaint("board"); $(`[data-f="${b.dataset.f}"]`)?.focus(); });
  $("#wown").onchange = e => { LS.set(fkey("wowner"), e.target.value); S.repaint("board"); };
  if ($("#wph")) $("#wph").onchange = e => { LS.set(fkey("wphase"), e.target.value); S.repaint("board"); };
  $("#wq").oninput = e => { LS.set(fkey("wq"), e.target.value); soon("wq", () => S.repaint("board"), 150); };
}
// "3 of 4 done · 1 doing": zero values stay out
const legend = steps => { const c = k => steps.filter(s => k === "done" ? FIN.has(s.status) : tState(s) === k).length;
  return [`${c("done")} of ${steps.length} done`, ...["doing", "waiting", "blocked"].map(k => [k, c(k)]).filter(x => x[1]).map(([k, n]) => `${n} ${STATM[k].l.toLowerCase()}`)].join(" · "); };
const emptyMsg = () => `<div class="hr-empty py-14">${I("list", "size-6 mb-1")}${S.board?.steps.length ? `<p>No task matches.</p><span class="hr-empty-hint">Clear the filters to see every task.</span><button class="btn mt-1" data-clear>Clear filters</button>` : `<p>No tasks yet</p><span class="hr-empty-hint">Sessions add tasks as they plan. Add one with New task, or import a plan file.</span>`}</div>`;
const wireClear = () => $$("[data-clear]").forEach(b => b.onclick = () => { for (const k of ["wfilter", "wowner", "wphase", "wq"]) LS.set(fkey(k), k === "wfilter" ? "all" : k === "wphase" ? "all" : ""); S.repaint("board"); });

// ── List ─────────────────────────────────────────────────────────────────────
// one header for every task table; Owner and Notes wait for md — the row still reads
const THEAD = `<thead><tr><th class="w-7 rounded-tl-xl"><span class="sr-only">Open</span></th><th>Status</th><th>Task</th><th class="hidden md:table-cell">Owner</th><th class="hr-num hidden md:table-cell">Notes</th><th class="hr-num rounded-tr-xl">On it</th></tr></thead>`;
// the table's status pill: a 6px dot + the word, never colour alone
const PILLK = { done: "hr-pill-done", doing: "hr-pill-doing", waiting: "hr-pill-waiting", blocked: "hr-pill-blocked", todo: "hr-pill-idle", skipped: "hr-pill-idle" };
const stHPill = k => `<span class="hr-pill ${PILLK[k] || PILLK.todo}">${(STATM[k] || STATM.todo).l}</span>`;
function taskRow(s, h, hot) {
  const k = tState(s), cur = S.task === s.id;
  const extra = [s.gate && s.gate !== "none" && !FIN.has(s.status) ? `<span class="tag" title="Needs your approval">${I("key", "size-3.5")}<span class="max-sm:sr-only">Approval</span></span>` : "",
    k === "waiting" ? `<span class="hidden text-xs text-peach-ink lg:inline">waits on ${esc(s.blocked_by.slice(0, 2).join(", "))}${s.blocked_by.length > 2 ? "…" : ""}</span>` : ""].filter(Boolean).join("");
  return `<tr class="hr-row-open max-md:h-11 ${cur ? "open bg-primary/8" : ""}${hot.has(s.id) ? " hr-flash" : ""}" data-tid="${esc(s.id)}">
    <td class="w-7 text-faint">${I("right", "hr-chev size-3.5")}</td>
    <td class="whitespace-nowrap">${stHPill(k)}</td>
    <td class="w-full max-w-0"><a class="flex min-w-0 items-center gap-2" href="${taskHref(s.id)}"><span class="tid">${esc(s.id)}</span><span class="min-w-0 flex-1 truncate text-[13px] ${FIN.has(s.status) ? "text-muted" : ""}">${esc(s.title)}</span>${extra}</a></td>
    <td class="hidden w-24 truncate text-xs text-muted md:table-cell">${s.owner ? esc(who(s.owner)) : `<span class="text-faint">nobody</span>`}</td>
    <td class="hr-num hidden text-xs text-muted md:table-cell"${s.comments?.open ? ` title="${s.comments.open} open notes"` : ""}>${s.comments?.open || ""}</td>
    <td class="w-16"><span class="flex justify-end -space-x-1">${(h[s.id] || []).slice(0, 3).map(n => `<span title="${esc(n)} is on it">${av(n, true)}</span>`).join("")}</span></td></tr>`;
}
function paintList(hot) {
  const el = $("#wpanel"); if (!el || !S.board) return;
  const list = visible(), ps = phases(), h = here(), grouped = ps.length > 1 && LS.get(fkey("wphase"), "all") === "all";
  const ph = LS.get(fkey("wphase"), "all"), cur = ps.find(p => String(p.n) === String(ph));
  const table = rows => `<table class="hr-table">${THEAD}<tbody>${rows.map(s => taskRow(s, h, hot)).join("")}</tbody></table>`;
  const doneBar = (d, n) => `<div class="hr-bar" role="img" aria-label="Progress: ${d} of ${n} done"><i class="hr-bar-fill" style="width:${n ? (d / n * 100).toFixed(1) : 0}%"></i></div>`;
  el.innerHTML = `<div class="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6">
    ${cur && (cur.summary || cur.diagram) ? `<section class="hr-card p-4"><span class="hr-label">Phase ${cur.n}</span><h2 class="mt-1 text-[15px] font-semibold">${esc(cur.title)}</h2>${cur.summary ? `<div class="prose-h mt-1 text-muted">${md(cur.summary)}</div>` : ""}${cur.diagram ? `<div class="mt-3">${phaseDiagram(cur.diagram)}</div>` : ""}</section>` : ""}
    ${!list.length ? emptyMsg() : grouped
      ? ps.map(p => { const l = list.filter(s => s.phase_n === p.n); if (!l.length) return ""; const all = S.board.steps.filter(s => s.phase_n === p.n), d = all.filter(s => FIN.has(s.status)).length;
          return `<section class="hr-card" aria-labelledby="ph-${p.n}"><div class="hr-card-head"><h2 id="ph-${p.n}" class="flex min-w-0 flex-1 items-baseline gap-2 text-[14px] font-semibold"><span class="text-xs font-medium whitespace-nowrap text-faint tabular-nums">Phase ${p.n}</span><span class="truncate">${esc(p.title)}</span></h2><span class="flex items-center gap-3"><span class="block w-14 sm:w-28">${doneBar(d, all.length)}</span><span class="text-xs whitespace-nowrap text-muted tabular-nums">${d} of ${all.length} done</span></span></div>
            ${table(l)}</section>`; }).join("")
      : `<section class="hr-card" aria-label="Tasks">${table(list)}</section>`}
    <div id="wfound"></div></div>`;
  if (cur?.diagram) wireDiagram(cur.diagram);
  wireClear();
  $$("tr[data-tid]", el).forEach(tr => tr.onclick = e => { if (!e.target.closest("a")) go(taskHref(tr.dataset.tid)); });
  const q = (LS.get(fkey("wq"), "") || "").trim();
  if (q.length >= 3) api(cu(`/search?q=${enc(q)}`)).then(r => { const seen = new Set(list.map(s => s.id)), more = r.filter(x => !seen.has(x.id)); const f = $("#wfound"); if (!f || !more.length) return;
    f.innerHTML = `<section class="hr-card" aria-labelledby="wf-h"><div class="hr-card-head"><h2 id="wf-h" class="hr-label">Found in the task text</h2></div><ul class="divide-y divide-line">${more.slice(0, 12).map(x => `<li><a class="row" href="${taskHref(x.id)}">${stIcon(tState(S.byId.get(x.id)))}<span class="tid">${esc(x.id)}</span><span class="min-w-0 flex-1"><span class="block truncate text-[13px]">${esc(x.title)}</span><span class="hit block truncate text-xs text-muted">${esc(x.hit || "").replace(/«/g, "<mark>").replace(/»/g, "</mark>")}</span></span></a></li>`).join("")}</ul></section>`; }).catch(() => {});
}

// ── Board: columns share the width; empty Blocked and Skipped collapse to a rail ──
const COLS = ["todo", "doing", "blocked", "done", "skipped"];
function paintBoard(hot) {
  const el = $("#wpanel"); if (!el || !S.board) return;
  const steps = visible(), h = here(), by = {}; for (const k of COLS) by[k] = steps.filter(s => s.status === k);
  const slim = k => (k === "blocked" || k === "skipped") && !by[k].length;
  const cardK = s => { const k = tState(s); return `<li class="kc${hot.has(s.id) ? " hr-flash" : ""}" draggable="true" data-id="${esc(s.id)}">
     <div class="flex items-center gap-1.5"><span class="tid">${esc(s.id)}</span>${s.gate && s.gate !== "none" && !FIN.has(s.status) ? `<span class="text-faint" title="Needs your approval">${I("key", "size-3.5")}<span class="sr-only">Needs your approval</span></span>` : ""}${s.comments?.open ? `<span class="tag h-5" title="Open notes">${I("note", "size-3")}${s.comments.open}</span>` : ""}<span class="flex-1"></span>${(h[s.id] || []).slice(0, 2).map(n => `<span title="${esc(n)} is on it">${av(n, true)}</span>`).join("")}
       <button class="btn btn-ghost btn-icon -mr-1 size-7" data-mv="${esc(s.id)}" aria-label="Move ${esc(s.id)}" aria-haspopup="menu" aria-expanded="false">${I("more", "size-4")}</button></div>
     <a class="mt-1 line-clamp-3 block text-[13px] leading-snug hover:underline" href="${taskHref(s.id)}">${esc(s.title)}</a>
     <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">${s.owner ? esc(who(s.owner)) : `<span class="text-faint">nobody</span>`}${k === "waiting" ? `<span class="inline-flex items-center gap-1 text-peach-ink">${I("hourglass", "size-3")}waits on ${esc(s.blocked_by.slice(0, 2).join(", "))}${s.blocked_by.length > 2 ? "…" : ""}</span>` : ""}</div></li>`; };
  el.innerHTML = steps.length || S.board.steps.length ? `<div class="grid h-full items-start gap-3 overflow-x-auto p-4 sm:p-6 max-md:grid-flow-col max-md:auto-cols-[80vw] max-md:snap-x" style="grid-template-columns:${COLS.map(k => slim(k) ? "3rem" : "minmax(14rem,1fr)").join(" ")}">${COLS.map(k => slim(k)
      ? `<section class="kcol flex min-h-40 flex-col items-center gap-2 rounded-xl border border-dashed border-line py-3 max-md:hidden" data-col="${k}" aria-label="${STATM[k].l}: empty">${stIcon(k)}<span class="text-xs text-muted [writing-mode:vertical-rl]">${STATM[k].l} · 0</span></section>`
      : `<section class="kcol flex min-w-0 snap-start flex-col rounded-xl border border-line bg-sunken/50" data-col="${k}" aria-labelledby="kc-${k}">
      <h2 class="flex items-center gap-2 px-3 pt-3 pb-2 text-[13px] font-semibold" id="kc-${k}">${stIcon(k)}${STATM[k].l}<span class="tnum font-normal text-faint">${by[k].length}</span></h2>
      <ul class="flex flex-col gap-2 px-2 pb-2 md:max-h-[calc(100dvh-250px)] md:overflow-y-auto">${by[k].map(cardK).join("") || `<li class="hint px-2 py-6 text-center">No ${STATM[k].l.toLowerCase()} tasks</li>`}</ul></section>`).join("")}</div>`
    : `<div class="p-4 sm:p-6">${emptyMsg()}</div>`;
  wireClear();
  $$(".kc", el).forEach(c => { c.ondragstart = e => { e.dataTransfer.setData("text/plain", c.dataset.id); c.classList.add("drag"); }; c.ondragend = () => c.classList.remove("drag"); });
  $$(".kcol", el).forEach(col => {
    col.ondragover = e => { e.preventDefault(); col.classList.add("over"); }; col.ondragleave = () => col.classList.remove("over");
    col.ondrop = e => { e.preventDefault(); col.classList.remove("over"); setTaskStatus(e.dataTransfer.getData("text/plain"), col.dataset.col); };
  });
  $$("[data-mv]", el).forEach(b => b.onclick = e => { e.stopPropagation(); const s = S.byId.get(b.dataset.mv);
    popMenu(b, COLS.filter(k => k !== s.status).map(k => ({ html: `${stIcon(k)}Move to ${STATM[k].l}`, run: () => setTaskStatus(s.id, k) }))); });
}

// ── Graph: layered by longest path, the critical path in mauve ───────────────
const GSYM = { todo: "○", doing: "◐", done: "✓", blocked: "✕", skipped: "–", waiting: "⧗" };
function paintGraph() {
  const el = $("#wpanel"); if (!el || !S.board) return;
  const nodes = visible(), n = nodes.length, idx = new Map(nodes.map((s, i) => [s.id, i])), crit = new Set(critical());
  const depth = new Array(n).fill(-1), onStack = new Uint8Array(n);
  const dfs = i => { if (depth[i] >= 0) return depth[i]; if (onStack[i]) return 0; onStack[i] = 1; let d = 0;
    for (const x of nodes[i].depends) { const j = idx.get(x); if (j != null) d = Math.max(d, dfs(j) + 1); } onStack[i] = 0; return depth[i] = d; };
  for (let i = 0; i < n; i++) dfs(i);
  const cols = []; for (let i = 0; i < n; i++) (cols[depth[i]] ||= []).push(i);
  const row = new Array(n);
  cols.forEach((c, ci) => { if (!c) return;
    if (ci > 0) { const bc = i => { const ds = nodes[i].depends.map(x => idx.get(x)).filter(j => j != null && depth[j] < ci); return ds.length ? ds.reduce((a, j) => a + row[j], 0) / ds.length : 1e9; };
      const key = new Map(c.map(i => [i, bc(i)])); c.sort((a, b) => key.get(a) - key.get(b) || a - b); }
    c.forEach((i, k) => row[i] = k); });
  const NW = 210, NH = 52, GX = 64, GY = 12, M = 16, ncol = cols.length || 1, nrow = Math.max(1, ...cols.map(c => c?.length || 0));
  const W = M * 2 + ncol * NW + (ncol - 1) * GX, H = M * 2 + nrow * (NH + GY) - GY;
  const X = i => M + depth[i] * (NW + GX), Y = i => M + row[i] * (NH + GY);
  let ed = "";
  for (let i = 0; i < n; i++) for (const x of nodes[i].depends) { const j = idx.get(x); if (j == null) continue;
    const x1 = X(j) + NW, y1 = Y(j) + NH / 2, x2 = X(i), y2 = Y(i) + NH / 2, mx = (x1 + x2) / 2;
    ed += `<path class="ge ${FIN.has(nodes[j].status) ? "ok" : ""} ${crit.has(nodes[i].id) && crit.has(nodes[j].id) ? "crit" : ""}" data-a="${j}" data-b="${i}" d="M${x1} ${y1}C${mx} ${y1},${mx} ${y2},${x2} ${y2}"/>`; }
  const cut = (t, k) => t.length > k ? t.slice(0, k - 1) + "…" : t;
  const nd = nodes.map((s, i) => { const k = tState(s), ext = s.depends.filter(x => !idx.has(x)).length;
    return `<g class="gn ${STATM[k].c} ${crit.has(s.id) ? "crit" : ""}" data-i="${i}" transform="translate(${X(i)},${Y(i)})" tabindex="0" role="button" aria-label="${esc(s.id)} ${esc(s.title)}, ${STATM[k].l}${s.owner ? ", owner " + esc(s.owner) : ""}${crit.has(s.id) ? ", on the critical path" : ""}">
      <rect width="${NW}" height="${NH}" rx="8"/><rect class="bar" x="0" y="8" width="3" height="${NH - 16}" rx="1.5"/><text x="11" y="18" class="gid">${GSYM[k]} ${esc(s.id)}</text><text x="${NW - 8}" y="18" class="gow" text-anchor="end">${esc(s.owner ? cut(who(s.owner), 14) : "nobody")}</text>
      <text x="11" y="37">${esc(cut(s.title, 30))}</text>${ext ? `<text x="${NW - 8}" y="47" class="gx" text-anchor="end">+${ext} hidden</text>` : ""}</g>`; }).join("");
  el.innerHTML = `<div class="flex flex-col gap-3 p-4 sm:p-6">
    <div id="ginfo" class="card flex min-h-12 flex-wrap items-center gap-2 px-4 py-2.5 text-[13px] text-muted" aria-live="polite">${I("graph", "size-4 text-faint")}Left to right in the order tasks can run.${crit.size ? ` <span class="inline-flex items-center gap-1.5"><i class="inline-block h-0.5 w-5 rounded bg-primary"></i>Critical path: ${[...crit].map(esc).join(" → ")}</span>` : ""} Select a task to trace it; Enter opens it.</div>
    ${n ? `<div class="overflow-auto rounded-xl border border-line bg-sunken/50 md:max-h-[calc(100dvh-300px)]"><svg class="dgraph" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="group" aria-label="Task dependency graph">${ed}${nd}</svg></div>` : `<div class="card">${emptyMsg()}</div>`}</div>`;
  wireClear();
  if (!n) return;
  const succ = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) for (const x of nodes[i].depends) { const j = idx.get(x); if (j != null) succ[j].push(i); }
  const walk = (i, nx) => { const seen = new Set(), st = [i]; while (st.length) { const k = st.pop(); for (const m of nx(k)) if (!seen.has(m)) { seen.add(m); st.push(m); } } return seen; };
  const svg = $("svg.dgraph");
  const select = i => {
    const up = walk(i, k => nodes[k].depends.map(x => idx.get(x)).filter(j => j != null)), down = walk(i, k => succ[k]);
    svg.classList.add("focus");
    $$(".gn", svg).forEach(g => { const k = +g.dataset.i; g.classList.toggle("sel", k === i); g.classList.toggle("up", up.has(k)); g.classList.toggle("down", down.has(k)); });
    $$(".ge", svg).forEach(p => { const a = +p.dataset.a, b = +p.dataset.b; p.classList.toggle("hot", (up.has(a) || a === i) && (up.has(b) || b === i) || (down.has(b) || b === i) && (down.has(a) || a === i)); });
    const s = nodes[i];
    $("#ginfo").innerHTML = `<span class="tid">${esc(s.id)}</span><b class="font-medium text-fg">${esc(s.title)}</b>${stPill(tState(s))}<span class="text-xs">waits on ${up.size} · ${down.size} wait on it</span><span class="flex-1"></span><a class="btn btn-pri" href="${taskHref(s.id)}">Open ${esc(s.id)}</a>`;
  };
  $$(".gn", svg).forEach(g => { g.onclick = () => select(+g.dataset.i); g.ondblclick = () => go(taskHref(nodes[+g.dataset.i].id)); g.onkeydown = e => { if (e.key === "Enter") go(taskHref(nodes[+g.dataset.i].id)); else if (e.key === " ") { e.preventDefault(); select(+g.dataset.i); } }; });
}

// ── Map: phases, each session's current and next task, the critical path ────
function paintMap() {
  const el = $("#wpanel"); if (!el || !S.board) return;
  const ps = phases(), crit = critical(), tops = (S.sess?.sessions || []).filter(s => s.state !== "left" && !s.parent), next = S.att?.next || [];
  const tl = id => { const t = S.byId.get(id); return t ? `<a class="inline-flex min-w-0 max-w-full items-center gap-1.5 hover:underline" href="${taskHref(id)}">${stIcon(tState(t), "size-3.5")}<span class="tid">${esc(id)}</span><span class="truncate">${esc(t.title)}</span></a>` : `<span class="tid">${esc(id)}</span>`; };
  el.innerHTML = `<div class="mx-auto grid max-w-6xl items-start gap-4 p-4 sm:p-6 lg:grid-cols-2">
    <section class="flex min-w-0 flex-col gap-3" aria-labelledby="mp-ph"><h2 id="mp-ph" class="hr-label px-1">Phases</h2>
      ${ps.map(p => { const s = S.board.steps.filter(x => x.phase_n === p.n), d = s.filter(x => FIN.has(x.status)).length;
        return `<div class="hr-card flex flex-col gap-2 p-4"><div class="flex items-center gap-2 text-[13px]"><span class="hr-mono text-xs text-faint">${p.n}</span><b class="min-w-0 flex-1 truncate font-medium">${esc(p.title)}</b>${s.length && d === s.length ? `<span class="c-green ink">${I("checkc", "size-4")}<span class="sr-only">complete</span></span>` : ""}<span class="hr-mono text-xs whitespace-nowrap text-muted">${d} of ${s.length} done</span></div>
          <div class="hr-bar" role="img" aria-label="Progress: ${d} of ${s.length} done"><i class="hr-bar-fill" style="width:${s.length ? (d / s.length * 100).toFixed(1) : 0}%"></i></div></div>`; }).join("") || `<div class="hr-empty"><p>No phases yet.</p></div>`}</section>
    <section class="hr-card overflow-hidden" aria-labelledby="mp-se"><div class="hr-card-head"><h2 id="mp-se" class="hr-label">Sessions</h2><span class="hint">now · next</span></div><ul class="divide-y divide-line">${tops.map(s => { const m = SSTM[sStatus(s)], nx = next.find(x => x.session === s.name && x.task && x.task.id !== s.step)?.task || S.board.steps.find(t => t.owner === s.name && t.id !== s.step && !FIN.has(t.status) && t.status !== "doing");
      return `<li class="flex flex-col gap-1.5 px-4 py-3"><div class="flex items-center gap-2"><a class="flex min-w-0 flex-1 items-center gap-2 hover:underline" href="${sessHref(s.name)}">${av(s.name, true)}<b class="truncate text-[13px]">${esc(s.name)}</b>${isOrch(s.name) ? `<span class="text-faint" title="Orchestrator">${I("baton", "size-3.5")}</span>` : ""}</a><span class="pill ${m.c} h-5 px-1.5 text-2xs">${I(m.i, "size-3")}${m.l}</span></div>
        <div class="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs"><span class="text-faint">Now</span><span class="min-w-0">${s.step ? tl(s.step) : `<span class="text-faint">${esc(s.task || "nothing")}</span>`}</span><span class="text-faint">Next</span><span class="min-w-0">${nx && nx.id !== s.step ? tl(nx.id) : `<span class="text-faint">nothing queued</span>`}</span></div></li>`; }).join("") || `<li class="hr-empty"><p>No session online.</p></li>`}</ul></section>
    <section class="hr-card lg:col-span-2" aria-labelledby="mp-cp"><div class="hr-card-head"><h2 id="mp-cp" class="hr-label">Critical path</h2><a class="btn btn-ghost btn-sm" href="#/c/${esc(S.ch)}/work/graph">${I("graph", "size-3.5")}Show in Graph</a></div><div class="card-b">${crit.length ? `<p class="mb-3 text-[13px] text-muted">The longest chain of unfinished tasks. Any delay here delays the end.</p><ol class="flex flex-wrap items-center gap-2">${crit.map((id, i) => `<li class="flex min-w-0 items-center gap-2">${i ? I("arrow", "size-4 text-faint") : ""}<span class="tag h-8 max-w-64 px-2 text-[13px]">${tl(id)}</span></li>`).join("")}</ol>` : `<p class="hint">No chain of unfinished tasks: everything open can run in parallel.</p>`}</div></section></div>`;
}

// phase diagram (layered boxes from the plan's phase body)
const NODEK = { ext: ["external", "--sky"], net: ["network", "--blue"], host: ["host", "--peach"], svc: ["service", "--mauve"], store: ["storage", "--yellow"], lxc: ["container", "--green"], vm: ["vm", "--teal"] };
function phaseDiagram(g) {
  if (!g || !g.nodes?.length) return "";
  const ids = g.nodes.map(n => n[0]), idx = new Map(ids.map((k, i) => [k, i]));
  const E = (g.edges || []).map(e => [idx.get(e[0]), idx.get(e[1]), e[2] || ""]).filter(e => e[0] != null && e[1] != null);
  const Nn = ids.length, lvl = new Array(Nn).fill(0);
  for (let it = 0; it < Nn; it++) { let mv = false; for (const [a, b] of E) if (lvl[b] < lvl[a] + 1 && lvl[a] < Nn) { lvl[b] = lvl[a] + 1; mv = true; } if (!mv) break; }
  const touched = new Set(E.flatMap(e => [e[0], e[1]])), maxL = Math.max(0, ...lvl);
  const cols = new Map(); for (let i = 0; i < Nn; i++) { const c = touched.has(i) ? lvl[i] : maxL + 1; if (!cols.has(c)) cols.set(c, []); cols.get(c).push(i); }
  const NW = 168, NH = 48, GX = 92, GY = 22, M = 14, ncol = Math.max(...cols.keys()) + 1;
  const H = Math.max(...[...cols.values()].map(a => a.length)) * (NH + GY) - GY + M * 2, W = M * 2 + ncol * NW + (ncol - 1) * GX, pos = [];
  for (const [c, arr] of cols) { const x = M + c * (NW + GX), tot = arr.length * (NH + GY) - GY, y0 = (H - tot) / 2; arr.forEach((ni, k) => pos[ni] = { x, y: y0 + k * (NH + GY) }); }
  let ed = "";
  for (const [a, b, l] of E) { const A = pos[a], Bp = pos[b], r = Bp.x >= A.x, x = r ? A.x + NW : A.x, y = A.y + NH / 2, tx = r ? Bp.x : Bp.x + NW, ty = Bp.y + NH / 2, mx = (x + tx) / 2, lw = l.length * 5.2 + 12;
    ed += `<g class="edge"><path d="M ${x} ${y} C ${mx} ${y}, ${mx} ${ty}, ${tx} ${ty}" marker-end="url(#arr)"/>${l ? `<rect class="pillbg" x="${mx - lw / 2}" y="${(y + ty) / 2 - 8}" width="${lw}" height="16" rx="8"/><text x="${mx}" y="${(y + ty) / 2 + 4}" text-anchor="middle">${esc(l)}</text>` : ""}</g>`; }
  const nd = g.nodes.map((n, i) => { const k = NODEK[n[2]] || NODEK.svc, lab = n[1].length > 22 ? n[1].slice(0, 21) + "…" : n[1];
    return `<g class="node" data-i="${i}" tabindex="0" role="button" aria-label="${esc(n[1])}" transform="translate(${pos[i].x},${pos[i].y})"><rect width="${NW}" height="${NH}" rx="9" style="stroke:var(${k[1]});fill:color-mix(in srgb,var(${k[1]}) 12%,var(--panel))"/><text x="10" y="20">${esc(lab)}</text><text x="10" y="36" class="k">${k[0][0].toUpperCase() + k[0].slice(1)}</text></g>`; }).join("");
  return `<div class="overflow-x-auto rounded-lg border border-line bg-sunken/50"><svg class="pgraph" viewBox="0 0 ${W} ${H}" style="min-width:${Math.min(W, 900)}px;max-height:420px;width:100%" role="group" aria-label="How the phase fits together">
   <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--border-2)"/></marker></defs>${ed}${nd}</svg></div>
   <p class="mt-2 rounded-lg border-l-2 border-line2 bg-sunken/50 px-3 py-2 text-[13px] text-muted" id="nodedesc" aria-live="polite">Select a box to read what it is.</p>`;
}
function wireDiagram(g) {
  $$("svg.pgraph g.node").forEach(el => el.onclick = el.onkeydown = e => {
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return; e.preventDefault?.();
    $$("svg.pgraph g.node").forEach(x => x.classList.remove("sel")); el.classList.add("sel");
    const n = g.nodes[+el.dataset.i]; $("#nodedesc").innerHTML = `<b class="text-fg">${esc(n[1])}</b>: ${esc(n[3] || "")}`;
  });
}

// ── task status: every change goes through here, with Undo ──────────────────
export async function setTaskStatus(id, st, note = "") {
  const prev = S.cur?.id === id ? S.cur.status : S.byId.get(id)?.status;
  if (!prev || prev === st) return false;
  const r = await act("task_status", { id, status: st, note }, `${id} is ${STATM[st].l.toLowerCase()}`, { undo: () => setTaskStatus(id, prev, `undo: back to ${prev}`) });
  if (!r) return false;
  if (S.byId.get(id)) S.byId.get(id).status = st;
  if (S.cur?.id === id) refreshTask(true);
  await D.loadBoard().catch(() => {}); D.attChanged();
  return true;
}

// ── task drawer ──────────────────────────────────────────────────────────────
const SECS = [["value", "Done means", "checkc"], ["what", "What it is", "file"], ["why", "Why, and why now", "ask"], ["alternatives", "Why not another way", "turn"], ["how", "How", "list"],
  ["snippets", "Code", "code"], ["use", "How to use it", "terminal"], ["verify", "How to check it", "check"], ["rollback", "How to undo it", "undo"],
  ["files", "Files", "folder"], ["refs", "References", "hash"], ["notes", "Notes and gaps", "alert"]];
const LINE_FIELDS = new Set(["how", "files", "refs"]), JSONF = new Set(["alternatives", "snippets", "verify"]);
const NOTE_KINDS = { change: "Change", question: "Question", direction: "Direction", optimize: "Optimize", enhance: "Enhance", note: "Note" };
const DRW = () => $("#tdrawer");
let EDIT = null, GATE_NOTE = false, OFF = null, DRIFT = null;
const filled = (t, f) => { const v = t[f]; return Array.isArray(v) ? v.length > 0 : !!String(v ?? "").trim(); };
const isApproved = t => (t.comments || []).some(c => c.kind === "direction" && /^Approved by the owner/.test(c.body || ""));
const hasCode = () => (S.info?.views || []).includes("code");

export async function openDrawer(id) {
  const d = DRW();
  if (S.task !== id) { EDIT = null; GATE_NOTE = false; }
  S.task = id;
  if (!d.open || S.cur?.id !== id) {
    d.innerHTML = `<div class="drawer-h"><span class="min-w-0 flex-1"><span class="skel block h-5 w-40"></span></span><button class="btn btn-ghost btn-icon" data-tclose aria-label="Close">${I("x")}</button></div><div class="p-4">${skel(6)}</div>`;
    $("[data-tclose]", d).onclick = () => closeDlg(d);
    if (!d.open) { $("#sdrawer").open && $("#sdrawer").close(); openDlg(d); }
  }
  let t; try { t = await api(cu(`/task/${enc(id)}`)); } catch { if (S.task === id) d.innerHTML = `<div class="drawer-h"><h2 id="td-title" class="flex-1 font-semibold">No task ${esc(id)}</h2><button class="btn btn-ghost btn-icon" data-tclose aria-label="Close">${I("x")}</button></div><div class="hr-empty"><p>It may have been removed by a plan import.</p></div>`; $("[data-tclose]", d) && ($("[data-tclose]", d).onclick = () => closeDlg(d)); return; }
  if (S.task !== id) return;
  S.cur = t; renderTask(); $("#td-close")?.focus();
  OFF?.(); OFF = D.onChange((w, x) => { if (!DRW().open) return; if ((w === "task" && (!x || x === S.task)) || w === "board") soon("tref", () => refreshTask(), 300); if (w === "sess") soon("tref2", () => preserve(renderTask), 100); });
  if ($("#wpanel")) S.repaint?.("board");
  if ((S.info?.views || []).includes("drift") && !DRIFT) api(cu("/repo/drift")).then(r => { DRIFT = Object.fromEntries((r.rows || []).map(x => [x.step + ":" + x.i, x])); if (S.cur && !EDIT) preserve(renderTask); }).catch(() => {});
}
export function closeDrawer() { if (DRW().open) DRW().close(); }
DRW().addEventListener("close", () => { S.task = null; S.cur = null; EDIT = null; OFF?.(); OFF = null; if (new URLSearchParams(location.hash.split("?")[1] || "").get("t")) go(path()); if ($("#wpanel")) S.repaint?.("board"); });
async function refreshTask(now) {
  if (!S.task || EDIT) return;
  try { const t = await api(cu(`/task/${enc(S.task)}`)); if (t.id !== S.task) return; S.cur = t; } catch { return; }
  preserve(renderTask);
}
function ownerOptions(cur) {
  const names = (S.sess?.sessions || []).filter(s => s.state !== "left").map(s => s.name); if (cur && !names.includes(cur) && cur !== "owner") names.push(cur);
  return `<option value="">Nobody</option><option value="owner" ${cur === "owner" ? "selected" : ""}>Me</option>${names.map(n => `<option ${n === cur ? "selected" : ""}>${esc(n)}</option>`).join("")}`;
}
function edMark(f) { const e = S.cur.edited?.[f]; return e ? `<span class="tag h-6">Edited ${ago(e.at)}${e.by && e.by !== "owner" ? " by " + esc(e.by) : ""}<button class="ml-1 underline underline-offset-2 hover:text-fg" data-revert="${f}">Undo edit</button></span>` : ""; }
const fileLink = p => hasCode() ? `<button class="tag font-mono hover:underline" data-file="${esc(p)}">${I("file", "size-3")}${esc(p)}</button>` : `<span class="tag font-mono">${esc(p)}</span>`;
function secBody(f) {
  const t = S.cur, v = t[f];
  switch (f) {
    case "alternatives": return `<div class="flex flex-col divide-y divide-line">${v.map(a => `<div class="grid gap-1 py-2 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-4"><div class="font-medium">${md(a.option)}</div><div class="text-muted">${md(a.why_not)}</div></div>`).join("")}</div>`;
    case "how": return `<ol class="list-decimal pl-5">${v.map(h => `<li class="my-1">${md(h)}</li>`).join("")}</ol>`;
    case "snippets": return snipBody(v);
    case "verify": { const ck = LS.get("ck:" + S.ch + ":" + t.id, {}); return `<ul class="flex flex-col gap-2">${v.map((x, i) => `<li class="flex items-start gap-2.5 ${ck[i] ? "opacity-70" : ""}"><input type="checkbox" class="mt-2 size-4 accent-[var(--green)]" data-ck="${i}" ${ck[i] ? "checked" : ""} aria-label="Checked: ${esc(x.cmd)}"><div class="min-w-0 flex-1"><div class="flex items-start gap-1 rounded-md border border-line bg-sunken"><code class="min-w-0 flex-1 overflow-x-auto px-2 py-1.5 text-xs whitespace-pre">${esc(x.cmd)}</code><button class="btn btn-ghost btn-icon m-0.5" data-copy="${esc(x.cmd)}" aria-label="Copy the command">${I("copy", "size-3.5")}</button></div>${x.expect ? `<div class="mt-1 text-xs text-muted">Expect: ${md(x.expect)}</div>` : ""}</div></li>`).join("")}</ul>`; }
    case "files": return `<div class="flex flex-wrap gap-1.5">${v.map(fileLink).join("")}</div>`;
    case "refs": return `<div class="flex flex-wrap gap-1.5">${v.map(r => `<span class="tag">${md(r)}</span>`).join("")}</div>`;
    default: return paras(v);
  }
}
function snipBody(sn) {
  const i = Math.min(LS.get("tab:" + S.cur.id, 0), sn.length - 1), s = sn[i], d = DRIFT?.[S.cur.id + ":" + i];
  const dState = d ? ({ ok: ["c-green", "check", "Matches the repo"], partial: ["c-yellow", "alert", "Partly changed"], missing: ["c-red", "x", "File missing"] })[d.state] || ["c-red", "x", "Drifted from the repo"] : null;
  return `${sn.length > 1 ? `<div class="flex flex-wrap gap-1 border-b border-line px-3 py-2" role="tablist" aria-label="Snippets">${sn.map((x, k) => `<button role="tab" class="chip h-7" data-tab="${k}" aria-selected="${k === i}" aria-pressed="${k === i}">${esc(x.title || x.path || "Snippet " + (k + 1))}</button>`).join("")}</div>` : ""}
   <div class="flex flex-wrap items-center gap-2 px-4 py-2 text-xs">${sn.length === 1 && s.title ? `<b>${esc(s.title)}</b>` : ""}${s.path ? fileLink(s.path) : ""}
    ${s.proposed ? `<span class="pill c-yellow h-5 px-1.5 text-2xs">Proposed: not in the repo yet</span>` : ""}${dState ? `<span class="pill ${dState[0]} h-5 px-1.5 text-2xs" title="${d.score ?? ""}% of its lines are still in the file">${I(dState[1], "size-3")}${dState[2]}</span>` : ""}<span class="flex-1"></span><button class="btn btn-ghost btn-sm" data-copysnip="${i}">${I("copy", "size-3.5")}Copy</button></div>
   ${codeBlock(s.code || "", s.lang, 1, "border-t border-line rounded-b-xl")}`;
}
function editor(f) {
  const v = S.cur[f]; let t;
  if (LINE_FIELDS.has(f)) t = (v || []).join("\n"); else if (JSONF.has(f)) t = JSON.stringify(v?.length ? v : [], null, 2); else t = v ?? "";
  const help = LINE_FIELDS.has(f) ? "One item per line." : JSONF.has(f) ? "JSON: " + ({ alternatives: '[{"option": "…", "why_not": "…"}]', snippets: '[{"title", "lang", "path", "proposed", "code"}]', verify: '[{"cmd": "…", "expect": "…"}]' })[f] : "Plain text; `code` and **bold** work.";
  return `<label class="sr-only" for="edta">Edit ${esc((SECS.find(x => x[0] === f) || [, f])[1])}</label><textarea class="input ${JSONF.has(f) ? "font-mono text-xs" : ""}" id="edta" data-keep spellcheck="${!JSONF.has(f)}" aria-describedby="edh" style="min-height:${f === "title" ? "52px" : JSONF.has(f) ? "240px" : "120px"}">${esc(t)}</textarea>
   <div class="mt-2 flex flex-wrap items-center gap-2"><button class="btn btn-pri" id="edsave">Save</button><button class="btn btn-ghost" id="edcancel">Cancel</button><span class="help" id="edh">${help} <kbd class="kbd">⌘</kbd><kbd class="kbd">↵</kbd> saves.</span></div><p class="err mt-1" id="ederr" role="alert"></p>`;
}
export function renderTask() {
  const d = DRW(), s = S.cur; if (!d.open || !s) return;
  const list = visible(), i = list.findIndex(x => x.id === s.id), prev = list[i - 1], next = list[i + 1];
  const k = tState(s), gated = (s.gate === "owner" || s.gate === "ask-first") && !FIN.has(s.status), approved = gated && isApproved(s);
  const on = (S.sess?.sessions || []).filter(x => x.step === s.id && x.state !== "left");
  const missing = SECS.filter(([f]) => !filled(s, f) && EDIT !== f);
  const sec = ([f, t, ic]) => {
    if (EDIT === f) return `<section class="card" aria-labelledby="sh-${f}"><h3 class="card-h" id="sh-${f}">${I(ic, "size-4 text-faint")}${t}</h3><div class="card-b">${editor(f)}</div></section>`;
    if (!filled(s, f)) return "";
    return `<section class="card" aria-labelledby="sh-${f}"><div class="card-h"><h3 id="sh-${f}" class="flex flex-1 items-center gap-2">${I(ic, "size-4 text-faint")}${t}</h3>${edMark(f)}<button class="btn btn-ghost btn-sm" data-edit="${f}">${I("pencil", "size-3.5")}Edit<span class="sr-only"> ${t}</span></button></div><div class="${f === "snippets" ? "" : "card-b prose-h"}">${secBody(f)}</div></section>`;
  };
  const notes = s.comments || [], openN = notes.filter(c => !c.resolved);
  d.innerHTML = `<div class="drawer-h">${stIcon(k, "size-5")}<span class="tid">${esc(s.id)}</span><span class="min-w-0 flex-1 truncate text-xs text-muted">${i >= 0 ? `${i + 1} of ${list.length} in this view` : ""}</span>
      <button class="btn btn-ghost btn-icon" data-nav="${esc(prev?.id || "")}" ${prev ? "" : "disabled"} aria-label="Previous task${prev ? ": " + esc(prev.id) : ""}" aria-keyshortcuts="k">${I("up")}</button><button class="btn btn-ghost btn-icon" data-nav="${esc(next?.id || "")}" ${next ? "" : "disabled"} aria-label="Next task${next ? ": " + esc(next.id) : ""}" aria-keyshortcuts="j">${I("down")}</button>
      <button class="btn btn-ghost btn-icon" id="td-close" aria-label="Close">${I("x")}</button></div>
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4" id="td-body">
      ${EDIT === "title" ? `<div>${editor("title")}</div>` : `<div class="flex items-start gap-2"><h2 class="min-w-0 flex-1 text-lg leading-snug font-semibold" id="td-title">${esc(s.title)}</h2><button class="btn btn-ghost btn-icon" data-edit="title" aria-label="Edit the title">${I("pencil", "size-4")}</button></div>`}
      <section class="flex flex-col gap-3" aria-label="Status, owner and dependencies">
        <div class="flex flex-wrap items-center gap-2"><div class="seg" role="group" aria-label="Status">${STAT.map((x, n) => `<button data-st="${x}" aria-pressed="${s.status === x}" aria-keyshortcuts="${n + 1}" title="${STATM[x].l} (${n + 1})"><span class="${STATM[x].c} ink">${I(STATM[x].i, "size-3.5")}</span>${STATM[x].l}</button>`).join("")}</div>${k === "waiting" ? stPill("waiting") : ""}</div>
        <label class="sr-only" for="stnote">Evidence or reason for the next status change</label><input class="input" id="stnote" data-keep placeholder="Evidence or reason for the next change (optional)">
        ${s.status_by ? `<p class="hint">${STATM[s.status]?.l || s.status} by ${esc(whoL(s.status_by))} ${s.status_at ? tsEl(s.status_at) : ""}${s.status_note ? `: “${esc(s.status_note)}”` : ""}</p>` : ""}
        <div class="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center">
          <label class="text-xs font-medium text-muted" for="owner-sel">Owner</label><div class="flex flex-wrap items-center gap-2"><select class="input w-auto" id="owner-sel">${ownerOptions(s.owner)}</select>${on.map(x => { const m = SSTM[sStatus(x)]; return `<a class="pill ${m.c}" href="${sessHref(x.name)}" title="${esc(x.name)} has this task: ${m.l.toLowerCase()}">${I(m.i, "size-3.5")}${esc(x.name)}: ${m.l.toLowerCase()}</a>`; }).join("")}</div>
          <span class="text-xs font-medium text-muted" id="dep-l">Waits on</span><div>${pickerHTML("dep-" + s.id, s.depends || [], { exclude: s.id, placeholder: "Add a task it waits on", label: "Add a task it waits on" })}</div>
          ${s.needed_by?.length ? `<span class="text-xs font-medium text-muted">Needed by</span><div class="flex flex-wrap gap-1.5">${s.needed_by.map(id => `<a class="tag hover:underline" href="${taskHref(id)}">${stIcon(tState(S.byId.get(id)), "size-3.5")}${esc(id)}<span class="max-w-40 truncate">${esc(S.byId.get(id)?.title || "")}</span></a>`).join("")}</div>` : ""}
          ${s.kind || s.risk || s.gate && s.gate !== "none" ? `<span class="text-xs font-medium text-muted">Details</span><div class="flex flex-wrap gap-1.5">${s.kind ? `<span class="tag">${esc(s.kind)}</span>` : ""}${s.gate && s.gate !== "none" ? `<span class="tag">${I("key", "size-3.5")}${s.gate === "owner" ? "Needs your approval" : "Ask first"}</span>` : ""}${s.risk ? `<span class="tag">${esc(s.risk)} risk</span>` : ""}</div>` : ""}
        </div>
        ${s.unmet?.length && !FIN.has(s.status) ? `<p class="c-peach flex items-start gap-2 rounded-lg border border-peach/40 bg-peach/10 p-3 text-[13px]"><span class="ink mt-0.5">${I("hourglass", "size-4")}</span><span>It waits on ${s.unmet.map(u => `<a class="font-medium underline-offset-2 hover:underline" href="${taskHref(u.id)}">${esc(u.id)}</a> (${esc(u.owner ? whoL(u.owner) : "nobody")}, ${esc(STATM[u.status]?.l.toLowerCase() || u.status)})`).join(", ")}. “Doing” is refused until they are done or skipped; ${s.owner ? esc(whoL(s.owner)) : "its owner"} is woken then.</span></p>` : ""}
        ${gated ? `<div class="c-mauve flex flex-col gap-2 rounded-lg border border-mauve/40 bg-mauve/10 p-3 sm:flex-row sm:items-center"><span class="ink">${I(approved ? "checkc" : "key", "size-4")}</span><span class="min-w-0 flex-1 text-[13px]">${approved ? "You approved it." : `${s.owner && s.owner !== "owner" ? esc(s.owner) + " waits" : "It waits"} for your go-ahead before it starts.`}</span>
          ${approved ? "" : `<div class="flex flex-wrap items-center gap-1.5">${GATE_NOTE ? `<label class="sr-only" for="gnote">Note</label><input class="input w-52" id="gnote" data-keep placeholder="Note for ${esc(s.owner || "the session")}">` : `<button class="btn" data-approve-note>With a note</button>`}<button class="btn btn-pri" data-approve>${I("check", "size-4")}Approve</button></div>`}</div>` : ""}
      </section>
      ${SECS.map(sec).join("")}
      ${missing.length ? `<div><button class="btn" id="addsec" aria-haspopup="menu" aria-expanded="false">${I("plus", "size-4")}Add section</button></div>` : ""}
      <section class="flex flex-col gap-2" aria-labelledby="nt-h"><h3 class="flex items-center gap-2 text-[13px] font-semibold" id="nt-h">Notes for the sessions${openN.length ? `<span class="tnum font-normal text-faint">${openN.length} open</span>` : ""}</h3>
        <p class="help">Sessions read open notes before the task text, and the notes win.</p>
        <div class="flex flex-wrap gap-1.5" role="group" aria-label="Kind of note">${Object.entries(NOTE_KINDS).map(([kk, v]) => `<button class="chip h-7" data-kind="${kk}" aria-pressed="${LS.get("kind", "change") === kk}">${v}</button>`).join("")}</div>
        <label class="sr-only" for="cbody">Note</label><textarea class="input" id="cbody" data-keep rows="3" placeholder="What should change, be checked or done differently?" aria-keyshortcuts="n"></textarea>
        <div class="flex items-center gap-2"><button class="btn btn-pri" id="csave">Add note</button><span class="hint"><kbd class="kbd">⌘</kbd><kbd class="kbd">↵</kbd></span></div>
        ${notes.length ? `<ul class="mt-1 flex flex-col gap-2">${notes.slice().reverse().map(c => `<li class="rounded-lg border border-line bg-card p-3 ${c.resolved ? "opacity-75" : ""}"><div class="flex flex-wrap items-center gap-1.5 text-xs"><span class="tag h-5">${esc(NOTE_KINDS[c.kind] || c.kind)}</span><span class="text-faint">${esc(who(c.by || ""))} · ${tsEl(c.created_at)}</span>${c.resolved ? `<span class="pill c-green h-5 px-1.5 text-2xs">${I("check", "size-3")}Resolved</span>` : ""}<span class="flex-1"></span>
          <button class="btn btn-ghost btn-sm" data-res="${c.id}" data-v="${c.resolved ? 0 : 1}">${c.resolved ? "Reopen" : `${I("check", "size-3.5")}Resolve`}</button><button class="btn btn-ghost btn-icon" data-del="${c.id}" aria-label="Delete this note">${I("trash", "size-3.5")}</button></div><div class="mt-1.5 text-[13px] whitespace-pre-wrap">${esc(c.body)}</div></li>`).join("")}</ul>` : ""}
      </section></div>`;
  wireTask(missing);
}
async function taskUpdate(args, msg, o = {}) {
  try { const r = await op("task_update", { id: S.cur.id, ...args }); S.cur = r.result; EDIT = null; toast(msg, o); D.loadBoard().catch(() => {}); renderTask(); D.attChanged(); return r.result; }
  catch (e) { const er = $("#ederr"); if (er) er.textContent = e.message; else toast(e.message, { bad: true }); return null; }
}
async function saveEdit() {
  const f = EDIT, raw = $("#edta").value; let v;
  try { v = LINE_FIELDS.has(f) ? raw.split("\n").map(x => x.trim()).filter(Boolean) : JSONF.has(f) ? JSON.parse(raw) : raw; }
  catch (e) { $("#ederr").textContent = "That is not valid JSON: " + e.message; return; }
  await taskUpdate({ field: f, value: v }, "Saved"); $(`[data-edit="${f}"]`)?.focus();
}
export async function setStatus(st) {
  if (!S.cur || S.cur.status === st) return;
  const note = $("#stnote")?.value.trim() || "";
  if (await setTaskStatus(S.cur.id, st, note) && $("#stnote")) $("#stnote").value = "";
}
export const focusNote = () => $("#cbody")?.focus();
function wireTask(missing) {
  const d = DRW(), s = S.cur;
  $("#td-close").onclick = () => closeDlg(d);
  $$("[data-nav]", d).forEach(b => b.onclick = () => b.dataset.nav && go(taskHref(b.dataset.nav)));
  $$("[data-st]", d).forEach(b => b.onclick = () => setStatus(b.dataset.st));
  $$("[data-edit]", d).forEach(b => b.onclick = () => { EDIT = b.dataset.edit; renderTask(); $("#edta")?.focus(); });
  $$("[data-revert]", d).forEach(b => b.onclick = () => taskUpdate({ field: b.dataset.revert, value: null }, "Back to the plan's text"));
  if ($("#addsec")) $("#addsec").onclick = e => popMenu(e.currentTarget, missing.map(([f, t, ic]) => ({ label: t, icon: ic, run: () => { EDIT = f; renderTask(); $("#edta")?.focus(); } })));
  $("#owner-sel").onchange = e => { const was = s.owner || null, to = e.target.value || null; taskUpdate({ owner: to }, `${s.id} now belongs to ${to ? who(to).replace("You", "you") : "nobody"}`, { undo: () => S.cur?.id === s.id && taskUpdate({ owner: was }, `${s.id} is back with ${was || "nobody"}`) }); };
  if ($("#edta")) { $("#edsave").onclick = saveEdit; $("#edcancel").onclick = () => { const f = EDIT; EDIT = null; renderTask(); ($(`[data-edit="${f}"]`) || $("#addsec"))?.focus(); };
    $("#edta").onkeydown = e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit(); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); $("#edcancel").click(); } }; }
  const approve = async () => { const msg = $("#gnote")?.value.trim() || ""; if (await act("approve", { id: s.id, msg }, `Approved ${s.id}`)) { GATE_NOTE = false; refreshTask(); D.attChanged(); } };
  $$("[data-approve]", d).forEach(b => b.onclick = approve);
  $$("[data-approve-note]", d).forEach(b => b.onclick = () => { GATE_NOTE = true; preserve(renderTask); $("#gnote")?.focus(); });
  if ($("#gnote")) $("#gnote").onkeydown = e => { if (e.key === "Enter") approve(); if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); GATE_NOTE = false; renderTask(); } };
  wirePicker("dep-" + s.id, { exclude: s.id, placeholder: "Add a task it waits on", label: "Add a task it waits on",
    onChange: ids => { const was = s.depends || []; taskUpdate({ after: ids }, ids.length > was.length ? `${s.id} now waits on ${ids.filter(x => !was.includes(x)).join(", ")}` : `${s.id} no longer waits on ${was.filter(x => !ids.includes(x)).join(", ")}`,
      { undo: () => S.cur?.id === s.id && taskUpdate({ after: was }, "Dependencies restored") }).then(r => { if (!r) renderTask(); }); } });
  $$("[data-tab]", d).forEach(b => b.onclick = () => { LS.set("tab:" + S.cur.id, +b.dataset.tab); renderTask(); });
  $$("[data-copy]", d).forEach(b => b.onclick = () => copy(b.dataset.copy));
  $$("[data-copysnip]", d).forEach(b => b.onclick = () => copy(S.cur.snippets[+b.dataset.copysnip].code));
  $$("[data-ck]", d).forEach(c => c.onchange = () => { const k = "ck:" + S.ch + ":" + S.cur.id, ck = LS.get(k, {}); ck[c.dataset.ck] = c.checked; LS.set(k, ck); });
  $$("[data-kind]", d).forEach(b => b.onclick = () => { LS.set("kind", b.dataset.kind); $$("[data-kind]", d).forEach(x => x.setAttribute("aria-pressed", String(x === b))); });
  const add = async () => { const body = $("#cbody").value.trim(); if (!body) return $("#cbody").focus(); const r = await act("note", { id: S.cur.id, kind: LS.get("kind", "change"), body }, "Note added"); if (r) { S.cur = r; $("#cbody").value = ""; renderTask(); D.attChanged(); D.boardChanged(); $("#cbody")?.focus(); } };
  $("#csave").onclick = add; $("#cbody").onkeydown = e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } };
  $$("[data-res]", d).forEach(b => b.onclick = async () => { const res = b.dataset.v === "1", r = await act("note_edit", { id: +b.dataset.res, resolved: res }, res ? "Note resolved" : "Note reopened"); if (r) { S.cur = r; preserve(renderTask); D.attChanged(); D.boardChanged(); } });
  $$("[data-del]", d).forEach(b => b.onclick = async () => { const r = await act("note_edit", { id: +b.dataset.del, remove: true }, "Note deleted"); if (r) { S.cur = r; preserve(renderTask); D.boardChanged(); } });
  $$("[data-file]", d).forEach(a => a.onclick = () => openFile(a.dataset.file, a));
}
async function openFile(p, trigger) {
  const r = await api(cu(`/repo/code?path=${enc(p.replace(/:\d.*$/, ""))}`)).catch(e => ({ error: e.message }));
  if (r.dir) { go(`#/c/${S.ch}/work/repo/code/${p.replace(/\/$/, "").split("/").map(enc).join("/")}`); return; }
  openModal(p, r.missing ? `<div class="hr-empty"><p>Not in the repo yet: this task creates it.</p></div>` : r.error ? `<div class="hr-empty"><p>${esc(r.error)}</p></div>`
    : `<div class="flex items-center gap-2 border-b border-line px-4 py-2 text-xs text-muted"><span class="tnum">Lines ${r.from} to ${Math.min(r.from + 79, r.total)} of ${r.total}</span><span class="flex-1"></span><a class="link" href="#/c/${esc(S.ch)}/work/repo/code/${p.split("/").map(enc).join("/")}">Open in Repo</a></div>${codeBlock(r.excerpt, langOf(p), r.from)}`, trigger);
}

// ── Repo: code, drift, diagrams, and any view from a local extension ─────────
const RNAMES = { code: "Code", drift: "Drift", diagrams: "Diagrams" };
async function repoView(sub, tok) {
  const views = S.info?.views || [], v = views.includes(sub[0]) ? sub[0] : views[0], rest = sub[0] === v ? sub.slice(1).join("/") : "";
  $("#wpanel").innerHTML = `<div class="mx-auto flex max-w-7xl flex-col gap-4 p-4 sm:p-6"><nav class="flex flex-wrap items-center gap-2" aria-label="Repo views"><div class="flex flex-wrap gap-1.5">${views.map(k => `<a class="chip" href="#/c/${esc(S.ch)}/work/repo/${k}" aria-pressed="${k === v}" ${k === v ? `aria-current="page"` : ""}>${esc(RNAMES[k] || k[0].toUpperCase() + k.slice(1))}</a>`).join("")}</div><span class="flex-1"></span><code class="hint hidden truncate lg:block">${esc(S.info.config.repo || "")}</code></nav><div id="rbody">${skel(6)}</div></div>`;
  const body = h => { if (tok === routeTok() && $("#rbody")) { $("#rbody").innerHTML = h; $$("[data-file]", $("#rbody")).forEach(a => a.onclick = () => openFile(a.dataset.file, a)); } };
  try { await ({ code: repoCode, drift: repoDrift, diagrams: repoDiagrams })[v]?.(rest, body) ?? repoGeneric(v, body); }
  catch (e) { body(`<div class="hr-empty"><p>${esc(e.message)}</p></div>`); }
}
const codeHref = p => `#/c/${S.ch}/work/repo/code/${p.split("/").filter(Boolean).map(enc).join("/")}`;
const box = (title, icon, inner, right = "") => `<section class="hr-card"><div class="hr-card-head">${I(icon, "size-4 text-faint")}<h2 class="hr-label min-w-0 flex-1 truncate">${title}</h2>${right}</div>${inner}</section>`;
async function repoCode(p, body) {
  p = (p || "").replace(/^\/+|\/+$/g, ""); const parts = p ? p.split("/") : [];
  const t = await api(cu(`/repo/tree?path=${enc(p)}`)); if (t.error) return body(`<div class="hr-empty"><p>${esc(t.error)}</p></div>`);
  const dirPath = t.file ? parts.slice(0, -1).join("/") : p;
  const [dir, refs, f] = await Promise.all([t.file ? api(cu(`/repo/tree?path=${enc(dirPath)}`)) : t, p ? api(cu(`/repo/refs?path=${enc(p)}`)).catch(() => []) : [], t.file ? api(cu(`/repo/file?path=${enc(p)}`)) : null]);
  const crumbs = `<nav class="mb-3 flex flex-wrap items-center gap-1 font-mono text-xs text-muted" aria-label="Path"><a class="link" href="${codeHref("")}">repo</a>${parts.map((x, i) => ` / <a class="link" href="${codeHref(parts.slice(0, i + 1).join("/"))}">${esc(x)}</a>`).join("")}</nav>`;
  const listing = `<nav class="card flex max-h-[70dvh] flex-col overflow-y-auto p-1.5 text-[13px]" aria-label="Files">${dirPath ? `<a class="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted hover:bg-hover" href="${codeHref(dirPath.split("/").slice(0, -1).join("/"))}">${I("left", "size-3.5")}Up</a>` : ""}${(dir.entries || []).map(e => `<a class="flex items-center gap-2 truncate rounded-md px-2 py-1.5 hover:bg-hover aria-[current=page]:bg-hover" href="${codeHref(e.path)}" ${e.path === p ? `aria-current="page"` : ""}>${I(e.dir ? "folder" : "file", "size-3.5 text-faint")}<span class="truncate">${esc(e.name)}</span></a>`).join("")}</nav>`;
  const refBox = Array.isArray(refs) && refs.length ? box(`Tasks that touch this (${refs.length})`, "link", `<div class="card-b flex flex-wrap gap-1.5">${refs.slice(0, 80).map(s => `<a class="tag hover:underline" href="${taskHref(s.id)}">${stIcon(tState(S.byId.get(s.id) || s), "size-3.5")}${esc(s.id)}<span class="max-w-48 truncate">${esc(s.title)}</span></a>`).join("")}</div>`) : "";
  const main2 = f ? (f.error ? `<div class="hr-empty"><p>${esc(f.error)}</p></div>` : f.binary ? `<div class="hr-empty"><p>A binary file (${f.size} bytes).</p></div>` : /\.md$/i.test(p) ? `<section class="hr-card card-b">${mdBlock(f.text)}</section>` : box(esc(parts.at(-1)), "code", codeBlock(f.text, langOf(p), 1, "rounded-b-xl"), `<span class="hint tnum">${f.text.split("\n").length} lines</span>`))
    : t.readme ? box("README", "book", `<div class="card-b">${mdBlock(t.readme)}</div>`) : `<div class="hr-empty"><p>No README in this folder.</p></div>`;
  body(`${crumbs}<div class="grid items-start gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">${listing}<div class="flex min-w-0 flex-col gap-4">${refBox}${main2}</div></div>`);
}
async function repoDrift(_, body) {
  const d = await api(cu("/repo/drift")), R = d.rows || [], bad = R.filter(r => r.state !== "ok");
  body(`<div class="mb-4"><h2 class="text-lg font-semibold">Snippet drift</h2><p class="mt-1 text-[13px] text-muted">Every code snippet a task quotes from a file, checked against the file now. ${bad.length ? `${bad.length} of ${R.length} no longer match.` : R.length ? `All ${R.length} match.` : ""} Checked ${tsEl(d.at)}.</p></div>
    ${box("Snippets", "code", `<div class="overflow-x-auto"><table class="hr-table"><thead><tr><th>State</th><th>Task</th><th>File</th><th class="hr-num pr-4">Lines kept</th></tr></thead><tbody>
    ${bad.concat(R.filter(r => r.state === "ok")).map(r => `<tr><td class="whitespace-nowrap">${r.state === "ok" ? stPill("done", "Matches") : r.state === "partial" ? stPill("doing", "Partly changed") : stPill("blocked", r.state === "missing" ? "File missing" : "Changed")}</td><td><a class="tid hover:underline" href="${taskHref(r.step)}">${esc(r.step)}</a></td><td><a class="link font-mono text-xs" href="${codeHref(String(r.path).replace(/:\d.*$/, ""))}">${esc(r.path)}</a></td><td class="hr-num pr-4 text-xs">${r.score ?? ""}%</td></tr>`).join("") || `<tr><td colspan="4" class="hint px-4 py-4">No snippet quotes a file.</td></tr>`}</tbody></table></div>`)}`);
}
async function repoDiagrams(name, body) {
  const ds = await api(cu("/repo/diagrams")); if (!Array.isArray(ds) || !ds.length) return body(`<div class="hr-empty"><p>No PNG diagrams in <code>docs/architecture</code>.</p></div>`);
  const cur = ds.includes(name) ? name : ds[0];
  body(`<div class="mb-3 flex flex-wrap gap-1.5">${ds.map(x => `<a class="chip" href="#/c/${esc(S.ch)}/work/repo/diagrams/${enc(x)}" aria-pressed="${x === cur}">${esc(x.replace(/\.png$/, "").replace(/-/g, " "))}</a>`).join("")}</div>
    <div class="card overflow-auto bg-white p-3"><img class="mx-auto max-w-full" src="${cu(`/diagram?name=${enc(cur)}`)}" alt="Diagram: ${esc(cur.replace(/\.png$/, "").replace(/-/g, " "))}"></div><p class="hint mt-2">From <code>docs/architecture/${esc(cur)}</code>.</p>`);
}
// a view from a local extension: Markdown reports, tables of rows, or plain JSON
async function repoGeneric(v, body) {
  const r = await api(cu(`/repo/${enc(v)}`));
  if (r?.error) return body(`<div class="hr-empty"><p>${esc(r.error)}</p></div>`);
  const cell = x => x == null ? "" : Array.isArray(x) ? (x.every(y => typeof y !== "object") ? esc(x.join(", ")) : `${x.length}`) : typeof x === "object" ? esc(JSON.stringify(x).slice(0, 120)) : md(String(x));
  if (Array.isArray(r) && r.every(x => x && typeof x === "object" && typeof x.md === "string")) return body(`<div class="flex flex-col gap-4">${r.map(x => `<section class="hr-card card-b">${mdBlock(x.md)}</section>`).join("") || `<div class="hr-empty"><p>Nothing here.</p></div>`}</div>`);
  if (Array.isArray(r) && r.length && r.every(x => x && typeof x === "object")) { const keys = [...new Set(r.flatMap(Object.keys))].slice(0, 8);
    return body(`<div class="hr-card overflow-x-auto"><table class="hr-table"><thead><tr>${keys.map(k => `<th>${esc(k)}</th>`).join("")}</tr></thead><tbody>${r.map(x => `<tr class="align-top">${keys.map(k => `<td>${cell(x[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`); }
  body(`<pre class="code card rounded-xl px-4">${esc(JSON.stringify(r, null, 2))}</pre>`);
}
