// feed.ts — what a Claude session has not seen yet in its channels (its own, plus "listen" in
// huddle.json or HUDDLE_LISTEN), as text for its context. hooks/listen.ts calls it after every
// tool call and on every prompt; hooks/session-start.ts marks "now" so a new session starts clean.
// It shows the others' messages, asks and replies in full, also those between other sessions, and
// folds the rest (task updates, knowledge entries, custom topics such as build.ready) into one
// count line, so a busy channel costs a line per tool call, not thirty ("listen_detail": "all"
// shows every event in full). Joins and leaves (session.*) and this session's own subagents
// (<me>.<role>) stay out. It remembers, per Claude session, the last seq shown in each channel:
// <Huddle home>/seen/<session id>.json. Never blocks long: 1.5 s (or the caller's budget), silent when down.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hfetch, type Identity } from "./identity";

const LIMIT = 30;
const read = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; } };
const timeline = async (url: string, ch: string, after: number, limit: number, ms: number) => {
  try {
    const r = await hfetch(`${url}/api/c/${encodeURIComponent(ch)}/timeline?after=${after}&limit=${limit}`, { headers: {}, signal: AbortSignal.timeout(ms) });
    const j = r.ok ? await r.json() : null;
    return Array.isArray(j) ? j as any[] : null;
  } catch { return null; }
};

export async function feed(id: Identity, home: string, session: string, o: { cli: string; start?: boolean; ms?: number }): Promise<string> {
  const ms = Math.max(1, Math.min(1500, o.ms ?? 1500)); // the caller's budget, never more than 1.5 s
  const sid = session.replace(/[^\w.-]/g, "");
  if (!id.channel || !id.as || !sid) return "";
  const dir = `${home}/seen`, file = `${dir}/${sid}.json`;
  const seen: Record<string, number> = o.start ? {} : read(file);
  const chans = [id.channel, ...id.listen.filter(c => c !== id.channel)];
  const parts = await Promise.all(chans.map(async ch => {
    const from = seen[ch];
    if (from == null) { // first look: start from the newest event
      const last = await timeline(id.url, ch, 0, 1, ms);
      if (last) seen[ch] = last.at(-1)?.seq ?? 0;
      return "";
    }
    const evs = await timeline(id.url, ch, from, LIMIT, ms);
    if (!evs?.length) return "";
    seen[ch] = evs.at(-1).seq;
    const mine = (f: string) => f === id.as || String(f).startsWith(`${id.as}.`);
    const shown = evs.filter(e => !mine(e.from) && !e.topic.startsWith("session."));
    if (!shown.length) return "";
    const other = ch === id.channel ? "" : ` (channel ${ch})`;
    const talk = (e: any) => id.detail === "all" || ["msg", "ask", "reply"].includes(e.topic) || e.needs_reply || e.to === id.as;
    const full = shown.filter(talk), rest = shown.filter(e => !talk(e));
    const lines = full.map(e => {
      const to = e.to ?? "all", over = e.to && e.to !== id.as;
      const tail = over ? " [overheard: between other sessions]" : e.needs_reply ? ` [answer: reply seq=${e.seq}${other}]` : "";
      return `#${e.seq} ${e.from} → ${to} (${e.topic}): ${String(e.msg ?? "").slice(0, 600)}${tail}`;
    });
    if (rest.length) {
      const n = (p: string) => rest.filter(e => e.topic.startsWith(p)).length, t = n("task."), k = n("kb."), x = rest.length - t - k;
      const parts = [t && `${t} task update${t > 1 ? "s" : ""}`, k && `${k} knowledge entr${k > 1 ? "ies" : "y"}`, x && `${x} other event${x > 1 ? "s" : ""}`].filter(Boolean);
      lines.push(`+${parts.join(", +")} (events after=${rest[0].seq - 1} for them)`);
    }
    const older = evs.length === LIMIT ? `\n(older ones: events after=${from})` : "";
    return `Huddle, new in "${ch}" (you are ${id.as}):\n${lines.join("\n")}${older}`;
  }));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(seen)); renameSync(`${file}.tmp`, file);
    if (o.start) for (const f of readdirSync(dir)) // forget sessions idle for a week
      if (Date.now() - statSync(`${dir}/${f}`).mtimeMs > 7 * 86400_000) rmSync(`${dir}/${f}`, { force: true });
  } catch {}
  return parts.filter(Boolean).join("\n\n");
}
