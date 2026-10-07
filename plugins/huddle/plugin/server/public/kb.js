// kb.js — what makes knowledge last, on the Knowledge page (app.js kbView): the marks an entry
// carries (verified, for every channel, its age, "may be stale" and why), the Verify and "Share with
// every channel" actions, the duplicate an entry would repeat (with Replace it / Add anyway), and the
// export to Markdown for a project's CLAUDE.md. The server side is server/src/knowledge.ts.
import { $, $$, esc, S, cu, op, I, toast, copy, popMenu, tsEl } from "./core.js";

const age = d => !d ? "" : d === 1 ? "1 day old" : `${d} days old`; // under a day, the time it was written says it
// the small marks beside an entry's title (list) or kind (reader)
export const marks = k => [
  k.verified_at ? `<span class="hr-pill hr-pill-done" title="Verified by ${esc(k.verified_by)}">Verified</span>` : "",
  k.scope === "server" ? `<span class="hr-chip hr-tint-info" title="${esc(k.origin ? `From channel ${k.origin}; ` : "")}every channel on this server recalls it">${I("layers", "size-3.5")}Every channel</span>` : "",
  k.stale ? `<span class="hr-pill hr-pill-waiting" title="${esc(k.stale)}">May be stale</span>` : ""].join("");
export const ageText = k => age(k.age_days);

// the reader's extra rows: why it may be stale, who verified it, and the actions
export const entryExtras = k => {
  if (k.moved_to) return `<div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 text-[13px] sm:px-5">${I("layers", "size-4 text-faint")}<span class="text-muted">This entry is now for every channel:</span><a class="link" href="#/c/${esc(S.ch)}/knowledge/${k.moved_to}">#${k.moved_to}</a></div>`;
  return `<div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 sm:px-5">
    ${k.stale ? `<p class="flex min-w-0 flex-1 basis-full items-center gap-2 text-[13px] text-peach-ink sm:basis-auto">${I("clock", "size-4")}May be stale: ${esc(k.stale)}. Check it, then verify it or replace it.</p>`
      : k.verified_at ? `<p class="flex min-w-0 flex-1 basis-full items-center gap-2 text-[13px] text-muted sm:basis-auto">${I("checkc", "size-4 text-green-ink")}Verified by ${esc(k.verified_by)} ${tsEl(k.verified_at)}</p>`
      : `<p class="min-w-0 flex-1 basis-full text-[13px] text-muted sm:basis-auto">${esc(ageText(k) ? `${ageText(k)[0].toUpperCase()}${ageText(k).slice(1)}, not verified yet.` : "Not verified yet.")}</p>`}
    <div class="flex flex-wrap gap-2"><button class="btn btn-sm" data-kbv="${k.verified_at && !k.stale ? "undo" : "do"}">${I(k.verified_at && !k.stale ? "undo" : "checkc", "size-3.5")}${k.verified_at && !k.stale ? "Unverify" : "Verify"}</button>
    ${k.scope === "server" ? "" : `<button class="btn btn-sm" data-kbs>${I("layers", "size-3.5")}Share with every channel</button>`}</div></div>`;
};
// wire the reader's buttons; then(id) reopens the entry (a shared one has a new id)
export function wireEntry(k, then) {
  const v = $("[data-kbv]"), s = $("[data-kbs]");
  if (v) v.onclick = async () => {
    v.disabled = true;
    try { await op("verify", { id: k.id, undo: v.dataset.kbv === "undo" }); toast(v.dataset.kbv === "undo" ? "No longer verified" : "Verified"); then(k.id); }
    catch (e) { toast(e.message, { bad: true }); v.disabled = false; }
  };
  if (s) s.onclick = async () => {
    s.disabled = true;
    try { const r = await op("share", { id: k.id }); toast(`Every channel on this server now recalls it (#${r.result.id})`); then(r.result.id); }
    catch (e) { toast(e.message, { bad: true }); s.disabled = false; }
  };
}

// ── export: Markdown grouped by kind, for a project's CLAUDE.md ──────────────
export const exportBtn = () => `<button class="btn" id="kbexp" aria-haspopup="menu">${I("download", "size-4")}Export</button>`;
export function wireExport() {
  const b = $("#kbexp"); if (!b) return;
  const md = verified => fetch(cu(`/knowledge.md${verified ? "?verified=1" : ""}`), { cache: "no-store" }).then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)));
  const save = async verified => {
    const t = await md(verified), a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([t], { type: "text/markdown" })); a.download = `${S.ch}-knowledge${verified ? "-verified" : ""}.md`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  b.onclick = () => popMenu(b, [
    { label: "Copy as Markdown for CLAUDE.md", icon: "copy", run: () => md(false).then(t => copy(t, "Copied. Paste it into the project's CLAUDE.md."), e => toast(e.message, { bad: true })) },
    { label: "Copy verified entries only", icon: "checkc", run: () => md(true).then(t => copy(t, "Copied the verified entries."), e => toast(e.message, { bad: true })) },
    { label: "Download .md", icon: "download", run: () => save(false).catch(e => toast(e.message, { bad: true })) },
  ]);
}

// ── the "Remember something" form: scope, and the duplicate an entry would repeat ──
export const scopeField = () => `<label class="flex items-start gap-2 text-[13px]"><input type="checkbox" id="kb-scope" class="mt-0.5"><span>For every channel on this server <span class="help">(tool quirks, facts about this machine)</span></span></label>`;
// remember with the form's args; a duplicate shows in #kb-dup with Replace it / Add anyway.
// Resolves with the new entry's id, or null while the owner decides.
export async function remember(args, done) {
  if ($("#kb-scope")?.checked) args.scope = "server";
  const r = (await op("remember", args)).result;
  if (!r.duplicate) return done(r.id);
  const box = $("#kb-dup"), x = r.existing;
  box.hidden = false;
  box.innerHTML = `<p class="flex items-start gap-2">${I("alert", "size-4 shrink-0 text-peach-ink")}<span><b>Already remembered:</b> <a class="link" href="#/c/${esc(S.ch)}/knowledge/${x.id}" data-kbgo>#${x.id} ${esc(x.title)}</a> by ${esc(x.by)} says the same.</span></p>
    <div class="mt-2 flex flex-wrap justify-end gap-2"><button type="button" class="btn btn-sm" data-dup="force">Add anyway</button><button type="button" class="btn btn-sm btn-pri" data-dup="supersede">Replace #${x.id} with this</button></div>`;
  $("#kbf button[type=submit]")?.classList.remove("btn-pri"); // the choice is in the box now
  const go = $("[data-kbgo]", box); if (go) go.onclick = () => $("#modal")?.close();
  $$("[data-dup]", box).forEach(b => b.onclick = async () => {
    const more = b.dataset.dup === "force" ? { force: true } : { supersedes: x.id, scope: x.scope === "server" ? "server" : undefined };
    try { const n = (await op("remember", { ...args, ...more })).result; done(n.id); }
    catch (e) { $("#kb-err").textContent = e.message; }
  });
  return null;
}
