#!/usr/bin/env bun
// SessionStart: when this project names a channel (HUDDLE_CHANNEL + HUDDLE_AS), join it and put
// the picture (who is here, the turn, the pause, the inbox, unread events or a brief, the next
// task, the latest shared knowledge) into the session's context. Silent when no channel is
// configured. The hook input's source picks the join context (identity.ts contextFor): resume →
// sync, clear or compact → fresh, startup → the server's default; HUDDLE_CONTEXT overrides it.
// When nothing answers and autostart is on (HUDDLE_AUTOSTART, or "autostart": true in the file),
// it starts the bundled server (`huddle up`) and joins; otherwise it says how to start it.
// Being in a channel takes a credential (server/src/auth.ts), kept per session and per project
// (bin/creds.ts), so the next session in a project that joined is in too. A session that holds no
// credential gets one line with the way back in, and stays out. Every start also puts the plugin's
// bin/ on the PATH of the session's Bash commands (CLAUDE_ENV_FILE), so `huddle …` works there and
// in subagents. The whole hook runs on a 3 s budget (each network wait takes what is left of it),
// so a slow or mute Huddle costs the session start at most that; anything that fails ends in
// silence (quiet.ts).
import { identity, contextFor, hfetch } from "../bin/identity";
import { up, home } from "../bin/serve";
import { feed } from "../bin/feed";
import { run } from "./quiet";
import { PLUGIN, sleep, stdinText, stdoutWrite } from "../server/src/rt";
import { appendFileSync, readFileSync } from "node:fs";

const BUDGET = 3000, T0 = Date.now();
const left = () => Math.max(1, BUDGET - (Date.now() - T0));
const stdin = (): Promise<string> => Promise.race([stdinText(), sleep(500).then(() => "")]);

await run("session-start", async () => {
  const input = (process.stdin.isTTY ? {} : await stdin().then(t => JSON.parse(t || "{}")).catch(() => ({}))) as { source?: string; session_id?: string };
  if (input.session_id) process.env.HUDDLE_SESSION = String(input.session_id); // the key of this session's credential (creds.ts)
  onPath();
  let { url: URL_, channel: CH, as: ME, role: ROLE, context: SETTING, autostart, listen } = identity();
  if (!CH || !ME) return;
  const context = contextFor(input.source, SETTING);
  const CLI = "huddle";
  const out = (s: string) => stdoutWrite(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: s } }) + "\n");
  const join = async (ms: number) => {
    if (!URL_) throw new Error("no port yet"); // this project's server has never started
    const r = await hfetch(`${URL_}/api/c/${CH}/op/join?as=${encodeURIComponent(ME)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: ROLE, task: "session started", ...(context ? { context } : {}), ...(input.session_id ? { claude_session: input.session_id } : {}) }), signal: AbortSignal.timeout(ms) });
    return { status: r.status, ...(await r.json() as any) };
  };
  // with autostart, the first try leaves room to start the server and join it
  let j: any = await join(Math.min(autostart ? 1000 : 2500, left())).catch(() => null), started = "";
  if (!j && autostart && left() > 300) {
    const u = await up(URL_, left()); started = u.ok ? `Huddle started (port ${new URL(u.url).port})` : u.msg; URL_ = u.url; // a first start picks the port
    if (u.ok && left() > 50) j = await join(left()).catch(() => null);
  }
  if (!j) {
    await out(`Huddle channel "${CH}" is configured but the service at ${URL_ || "its address (none yet: huddle up picks a port)"} does not answer${started ? ` (${started})` : ""}. Treat yourself as paused for shared work: tell the user to start it (/huddle:setup, or \`${CLI} up\`), then call status.`);
  } else if (j.status === 401) {
    await out(`Huddle "${CH}" runs at ${URL_}, but this session holds no credential for it (it was never invited here, or it was kicked). To get in: in a session that is in it, the user runs /huddle:invite and pastes its join line here (/huddle:join …); if no such session is left, /huddle:setup --restart in the project that started it. Until then, leave Huddle alone.`);
  } else if (j.error) {
    await out(`Huddle: joining channel ${CH} as ${ME} failed: ${j.error}. Tell the owner; do not work around it.`);
  } else {
    // from here on, hooks/listen.ts brings each new message into this session (the join shows the rest)
    await feed(identity(), home(), String(input.session_id ?? ""), { cli: CLI, start: true, ms: left() });
    await out(`You are in Huddle channel "${CH}" as "${ME}" (already joined: call status to refresh, join only to change your role).${started ? ` ${started}.` : ""} Use the huddle skill: tools mcp__plugin_huddle_huddle__*, or \`${CLI}\` from Bash (on PATH; subagents use it with HUDDLE_AS=${ME}.<role>). New messages in the channel${listen.length ? ` and in ${listen.join(", ")}` : ""} arrive in your context after each tool call, also those between other sessions (overheard: knowledge, not yours to answer). Joined just now:\n${j.text}`);
  }
});

// the plugin's bin/ on the PATH of this session's Bash commands (and its subagents'), once per session
function onPath() {
  const f = process.env.CLAUDE_ENV_FILE;
  if (!f) return;
  const bin = `${PLUGIN}/bin`, line = `export PATH="${bin}:$PATH"`;
  try { if (readFileSync(f, "utf8").includes(line)) return; } catch {}
  try { appendFileSync(f, `${line}\n`); } catch {}
}
