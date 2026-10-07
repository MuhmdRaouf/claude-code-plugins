#!/usr/bin/env bun
// Stop: a session in a channel must not go quiet while someone waits for its answer. If its
// inbox holds fresh asks (from the owner or another session), block the stop once with the list.
// Never twice for the same ask: the asks it blocked for are remembered (<Huddle home>/stop-raised.json),
// and an ask older than HUDDLE_STOP_MAX_AGE seconds (default an hour) never blocks — its asker may
// be long gone. stop_hook_active guards against a loop; an unreachable Huddle, a session that has
// not joined (401), a state file that cannot be written, or any failure never blocks (quiet.ts).
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { identity, hfetch } from "../bin/identity";
import { home } from "../bin/serve";
import { run } from "./quiet";
import { sleep, stdinText, stdoutWrite } from "../server/src/rt";

const KEEP = 500; // asks remembered per session identity
await run("stop", async () => {
  const input = await Promise.race([stdinText(), sleep(500).then(() => "")]).then(t => JSON.parse(t || "{}")).catch(() => ({})) as any;
  if (input.session_id) process.env.HUDDLE_SESSION = String(input.session_id); // the key of this session's credential (creds.ts)
  const { url: URL_, channel: CH, as: ME } = identity();
  if (!CH || !ME) return;
  if (input.stop_hook_active || input.agent_id) return; // subagents answer through their parent
  const r = await hfetch(`${URL_}/api/c/${CH}/op/inbox?as=${encodeURIComponent(ME)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) });
  const j = await r.json() as any;
  const maxAge = Number(process.env.HUDDLE_STOP_MAX_AGE || 3600) * 1000;
  const fresh = (m: any) => { const t = Date.parse(String(m?.ts ?? "")); return Number.isFinite(t) && Date.now() - t <= maxAge; };
  const file = `${home()}/stop-raised.json`, key = `${CH}/${ME}`;
  let raised: Record<string, number[]> = {};
  try { raised = JSON.parse(readFileSync(file, "utf8")); } catch {}
  const seen = new Set(Array.isArray(raised[key]) ? raised[key] : []);
  const open = (Array.isArray(j.result) ? j.result as any[] : []).filter(m => fresh(m) && !seen.has(m.seq));
  if (!open.length) return;
  // remember first: a stop that cannot record what it raised does not block at all
  raised[key] = [...seen, ...open.map(m => m.seq)].slice(-KEEP);
  mkdirSync(home(), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(raised)); renameSync(`${file}.tmp`, file);
  await stdoutWrite(JSON.stringify({ decision: "block", reason: `Huddle: ${open.length} message(s) wait for your reply before you stop:\n${open.map(m => `  #${m.seq} from ${m.from}: ${m.msg}`).join("\n")}\nAnswer each with reply (seq, msg). If the work continues after you, wait on the channel instead of stopping.` }) + "\n");
});
