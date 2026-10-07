// serve.ts — run the Huddle server that ships inside this plugin (../server):
//   huddle up       start it in the background, on loopback; does nothing when it already answers
//   huddle down     stop the server `huddle up` started
//   huddle server   is it up, which process, where its data and log are
// Its files live in the project's .agents/huddle/ (identity.ts homeOf; HUDDLE_HOME moves them):
// data/ (unless HUDDLE_DATA is set), huddle.pid, huddle.log. That directory is kept out of git.
// The server it starts watches for the plugin's removal (server/src/lifecycle.ts) and stops
// itself, taking huddle.pid and huddle.log with it and leaving LEFT-BEHIND.md by the channels.
// The port comes from the url (identity.ts: HUDDLE_URL, huddle.json's url, HUDDLE_PORT, or the port
// saved in the home's huddle.json); with none yet, `huddle up` picks a random free five-digit one
// and saves it, and a saved port it picked that another program has since taken moves to a new
// one (a port someone chose is never rewritten). Other server settings pass through from the
// environment. Whoever starts it is its creator: `huddle up` makes the root credential,
// hands it to the server on stdin (never a file or the environment) and keeps it as this
// session's credential (creds.ts); everyone else joins with an invite the creator mints.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homeOf, mainCheckout, identity, hfetch, runningPid, savedPort, savePort, local } from "./identity";
import { loadCred, saveCred, forgetCred, requestLink, requestInvite, sessionsDir, type InviteAsk } from "./creds";
import { credential } from "../server/src/auth";
import { portFree, randomPort } from "../server/src/port";
import { entry, runtimeArgs, sleep } from "../server/src/rt";

// computed on first use: the hooks import this file but rarely start a server
let home_: string | undefined;
export const home = () => (home_ ??= homeOf());
export const dataDir = () => process.env.HUDDLE_DATA || `${home()}/data`;
const PID = () => `${home()}/huddle.pid`, LOG = () => `${home()}/huddle.log`;
const SERVER = entry("server"); // dist/server.js when we run bundled, the source under Bun from source
const dataDesc = () => `${dataDir()}/channels`;

// <repo>/.agents/huddle holds databases and logs: list it in the repo's .git/info/exclude
export function keepOutOfGit(dir = home()): string | null {
  if (!dir.endsWith("/.agents/huddle")) return null;
  const main = mainCheckout(dirname(dirname(dir)));
  if (!main) return null;
  const ex = `${main}/.git/info/exclude`, line = ".agents/huddle/";
  if (existsSync(ex) && readFileSync(ex, "utf8").split("\n").includes(line)) return null;
  mkdirSync(dirname(ex), { recursive: true }); appendFileSync(ex, `\n${line}\n`);
  return ex;
}
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);
export type Result = { ok: boolean; msg: string };

export async function healthy(url: string, ms = 1500) {
  if (!url) return false;
  try { return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(ms) })).ok; } catch { return false; }
}

// the pid in huddle.pid, if that process is still a Huddle server (a stale pid may belong to anything)
export const pidOf = (): number | null => runningPid(home());

// free now, or within a second (a port a server just let go of can linger briefly)
async function settled(port: number) {
  for (let i = 0; i < 5; i++) { if (await portFree(port)) return true; await sleep(200); }
  return false;
}
// where up starts the server: url's port when it is free or names a Huddle; no url yet → a random
// free port, saved; a saved port huddle picked that another program now holds → a new one, saved,
// with a line that says so; a port someone chose (HUDDLE_URL, huddle.json's url, HUDDLE_PORT,
// --port) is never moved, only saved when it came from HUDDLE_PORT
async function place(url: string, sid?: string): Promise<{ url: string; note?: string } | { error: string }> {
  if (!url) {
    const pid = pidOf();
    if (pid) return { error: `a Huddle server (pid ${pid}) runs from ${home()} but its port is unknown: save it with huddle setup --port <its port>` };
    const p = await randomPort(), f = savePort(p, true, home());
    return { url: local(p), note: `Huddle picked port ${p} for this project (saved in ${f})` };
  }
  const u = new URL(url);
  if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname)) return { error: `${url} is not a local http address: huddle up only starts a server on this machine` };
  const port = Number(u.port || 80), me = identity(sid), s = savedPort(home());
  if (await settled(port)) {
    if (me.url === url && me.source === "port" && (s?.port !== port || s.auto)) savePort(port, false, home());
    return { url };
  }
  const pid = pidOf(); // this home's own server, busy or still starting: never move away from it
  if (pid) return { error: `Huddle (pid ${pid}) runs from ${home()} but does not answer at ${url} yet; try again, or see ${LOG()}` };
  if (me.url === url && me.source === "saved" && s?.auto && s.port === port) {
    const p = await randomPort(), f = savePort(p, true, home());
    return { url: local(p), note: `port ${port} is taken by another program: Huddle moved to port ${p} (saved in ${f})` };
  }
  return { error: `port ${port} is taken by another program, not Huddle: free it, or choose another port with huddle setup --port <n>` };
}

// budgetMs bounds the whole call (the SessionStart hook passes what is left of its own budget);
// a server still starting when it runs out keeps starting, detached, for the next session
// returns the url the server answers at (a new port when it had to move)
// created: this call started it; first: this home's Huddle never ran before (no members yet)
export async function up(url: string, budgetMs = 35_000, sid?: string): Promise<Result & { created?: boolean; first?: boolean; url: string }> {
  const deadline = Date.now() + budgetMs, rest = () => deadline - Date.now();
  url = url.replace(/\/$/, "");
  if (await healthy(url, Math.max(1, Math.min(1500, rest())))) return { ok: true, url, msg: `Huddle is up at ${url}` };
  const at = await place(url, sid);
  if ("error" in at) return { ok: false, url, msg: at.error };
  url = at.url;
  const said = at.note ? `${at.note}\n` : "";
  const u = new URL(url);
  mkdirSync(home(), { recursive: true });
  keepOutOfGit();
  const log = openSync(LOG(), "a");
  // HUDDLE_HOME so the server cleans up the same home on self-removal (src/lifecycle.ts), and
  // HUDDLE_REMOVAL_WATCH because only a server the plugin started watches for the plugin's end.
  // the root credential: HUDDLE_TOKEN when set (scripts, tests), else the one this session (or its
  // project) already holds for this address, so the creator keeps working across restarts, else a new one
  const held = loadCred(url, sid), first = !existsSync(`${dataDir()}/auth.json`);
  const root = process.env.HUDDLE_TOKEN || (held?.root ? held.credential : "") || credential();
  const { HUDDLE_TOKEN: _t, ...rest_ } = process.env;
  const child = spawn(process.execPath, [...runtimeArgs(), SERVER], { detached: true, stdio: ["pipe", log, log],
    env: { ...(process.env.HUDDLE_TOKEN ? process.env : rest_), PORT: u.port || "80", HOST: "127.0.0.1", HUDDLE_DATA: dataDir(), HUDDLE_HOME: home(), HUDDLE_REMOVAL_WATCH: "1", HUDDLE_ROOT_STDIN: "1" } });
  child.stdin?.on("error", () => {}); // a server that exits at once (port taken) closes it first
  child.stdin?.end(`${root}\n`);
  child.unref();
  writeFileSync(PID(), String(child.pid));
  // this session is the creator: it keeps the root credential as its own
  const me = identity(sid);
  if (!process.env.HUDDLE_TOKEN) try { saveCred({ url: url.replace(/\/$/, ""), channel: me.channel || undefined, as: me.as || undefined, credential: root, root: true }, sid); } catch {}
  while (child.exitCode === null && rest() > 0) {
    if (await healthy(url, Math.max(1, Math.min(500, rest())))) {
      noteServer(home(), { url, channel: me.channel || undefined, project: mainCheckout() ?? process.env.CLAUDE_PROJECT_DIR ?? undefined, pid: child.pid });
      return { ok: true, created: true, first, url, msg: `${said}Huddle started at ${url}, UI ${url} (pid ${child.pid}; data: ${dataDesc()}; log: ${LOG()}); this session started it and holds its root credential` };
    }
    await sleep(Math.max(0, Math.min(200, rest())));
  }
  if (child.exitCode !== null && !held?.root && loadCred(url.replace(/\/$/, ""), sid)?.credential === root) forgetCred(sid); // it never ran
  return { ok: false, url, msg: `${said}Huddle did not come up at ${url}${child.exitCode === null ? ` within ${Math.round(budgetMs / 100) / 10} s (still starting)` : ""}; see ${LOG()}` };
}

export async function down(url: string): Promise<Result> {
  if (!url && !pidOf()) return { ok: true, msg: "Huddle is not running" };
  const pid = pidOf();
  if (!pid) {
    rmSync(PID(), { force: true });
    return await healthy(url) ? { ok: false, msg: `Huddle at ${url} was not started by huddle up: stop it where it runs` } : { ok: true, msg: "Huddle is not running" };
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch { rmSync(PID(), { force: true }); return { ok: true, msg: `Huddle stopped (pid ${pid})` }; }
    await sleep(100);
  }
  return { ok: false, msg: `pid ${pid} did not stop; see ${LOG()}` };
}

export async function info(url: string, sid?: string): Promise<Result> {
  if (!url) return { ok: false, msg: `Huddle has no port here yet: huddle up picks a random five-digit one and saves it in ${home()}/huddle.json\ndata: ${dataDesc()}\nlog:  ${LOG()}` };
  const pid = pidOf(), ok = await healthy(url);
  const who = pid ? `pid ${pid}, started by huddle up` : ok ? "not started by huddle up" : "";
  const link = ok && !inClaude() ? await dashboard(url, sid) : null; // inside Claude, a code would land in its context
  const hint = link ? "  (signs you in once, for 5 minutes)" : ok && inClaude() ? "  (to sign your browser in: /huddle:open)" : "";
  return { ok, msg: `Huddle is ${ok ? "up" : "down"} at ${url}${who ? ` (${who})` : ""}\nUI:   ${link ?? url}${hint}\ndata: ${dataDesc()}\nlog:  ${LOG()}` };
}

// the dashboard link that signs a browser in: a one-time login code, which any session holding a
// credential gets for itself (the creator's browser has its rights; a member's has no admin
// rights, server/src/auth.ts); null for a session that has not joined. The code is a secret: it
// goes to the user (a terminal, or a hook's systemMessage), never into Claude's context
export const inClaude = () => process.env.CLAUDECODE === "1" && !process.stdout.isTTY; // Claude Code's Bash tool: its output is Claude's context
export async function dashboard(url: string, sid?: string, ms = 1500): Promise<string | null> {
  try {
    const r = await hfetch(`${url}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(ms) }, sid);
    const j = r.ok ? await r.json() as any : null;
    return j?.code ? `${url}/?code=${encodeURIComponent(j.code)}` : null;
  } catch { return null; }
}

// the dashboard for the user: on a terminal, the link itself; inside Claude Code, the plain address,
// and a request that the next hook show the link to the user (creds.ts requestLink); null when
// this session may not sign a browser in (it has not joined)
export async function dashboardFor(url: string, sid?: string): Promise<string | null> {
  if (!inClaude()) { const d = await dashboard(url, sid); return d && `${d}   (signs your browser in once, within 5 min)`; }
  try { if (!(await hfetch(`${url}/api/whoami`, { signal: AbortSignal.timeout(1500) }, sid)).ok) return null; } catch { return null; }
  requestLink(sid);
  return `${url}   (your sign-in link shows to you, not to Claude, right after this command; /huddle:open makes another)`;
}

// The join line for another session, as this caller may see it. On a terminal: the line itself.
// Inside Claude Code: an invite is a secret, so a request the next hook answers (creds.ts
// requestInvite) and a note that says so; the line reaches the user, never Claude.
export async function joinLine(url: string, o: InviteAsk, sid?: string): Promise<{ ok: true; line: string; claude: boolean } | { ok: false; error: string }> {
  if (!inClaude()) {
    const inv = await invite(url, o, sid);
    return inv.ok ? { ok: true, claude: false, line: `/huddle:join ${inv.join.slice("huddle join ".length)}` } : inv;
  }
  try {
    const r = await hfetch(`${url}/api/whoami`, { signal: AbortSignal.timeout(1500) }, sid);
    const w = r.ok ? await r.json() as any : null;
    if (!w) return { ok: false, error: "this session is not in this huddle" };
    if (!w.invite) return { ok: false, error: "this session may not invite: only the session that started Huddle (or one invited with --can-invite) can" };
  } catch { return { ok: false, error: `Huddle unreachable at ${url}` }; }
  requestInvite(o, sid);
  return { ok: true, claude: true, line: "shows to the user (not to you) right after this command, from the plugin's hook; /huddle:invite makes another" };
}

// the servers this user runs (`huddle up` notes each): setup looks here before it starts a second one
//   ${XDG_STATE_HOME:-~/.local/state}/huddle/servers.json   {"<home>": {url, channel, project, pid, at}}   (no secret)
export const registryFile = () => `${dirname(sessionsDir())}/servers.json`;
export function servers(): Record<string, { url: string; channel?: string; project?: string; pid?: number; at?: string }> {
  try { const j = JSON.parse(readFileSync(registryFile(), "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}
function noteServer(home_: string, e: { url: string; channel?: string; project?: string; pid?: number }) {
  try {
    const all = servers(); all[home_] = { ...e, at: new Date().toISOString() };
    mkdirSync(dirname(registryFile()), { recursive: true, mode: 0o700 });
    const f = registryFile(); writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(all, null, 2)); renameSync(`${f}.${process.pid}.tmp`, f);
  } catch {}
}

// a new invite and the line that joins with it (`huddle join <host:port> --token <id>.<secret>`)
export async function invite(url: string, o: { ttl?: number; single_use?: boolean; can_invite?: boolean; channel?: string; description?: string } = {}, sid?: string, ms = 5000):
  Promise<{ ok: true; token: string; id: string; expires: string | null; join: string } | { ok: false; error: string }> {
  try {
    const r = await hfetch(`${url}/api/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o), signal: AbortSignal.timeout(ms) }, sid);
    const j = await r.json().catch(() => ({})) as any;
    if (!r.ok || !j.token) return { ok: false, error: j.error ?? `HTTP ${r.status}` };
    return { ok: true, token: j.token, id: j.id, expires: j.expires, join: `huddle join ${new URL(url).host} --token ${j.token}` };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
