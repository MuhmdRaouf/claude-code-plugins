// creds.ts — the credential this Claude session holds for a Huddle server (server/src/auth.ts),
// kept per session, never the invite it was made from:
//   ${HUDDLE_SESSIONS_DIR:-${XDG_STATE_HOME:-~/.local/state}/huddle/sessions}/<key>.json   (0600, dir 0700)
//   {"url": "http://127.0.0.1:<port>", "channel": "shop", "as": "api", "credential": "hcred_…", "root": false}
// The key is the session: the hook input's session_id, else HUDDLE_SESSION, else
// CLAUDE_CODE_SESSION_ID (what Claude Code gives its tools), with an alias by the Claude process
// (CLAUDE_PID) so a /clear, a subagent or the MCP bridge of the same session find it too, and a
// key for the project (project-<sha1 of its main checkout>), tried last: the next Claude session
// in the same project (a restart, a second terminal) finds the project's credential instead of
// needing a new invite. Same OS user, same 0600 directory: no new secret on disk.
// HUDDLE_TOKEN overrides it all (a root credential for scripts and tests). A credential is only
// ever sent to the url it was issued by. Reads never throw: no file means no credential.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HEADER } from "../server/src/auth";
import { fetchUntimed } from "../server/src/rt";

export type Cred = { url: string; channel?: string; as?: string; credential: string; root?: boolean };

export const sessionsDir = (env = process.env) =>
  env.HUDDLE_SESSIONS_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "huddle", "sessions");
const clean = (k: string) => k.replace(/[^\w.-]/g, "");
// the session's keys, most specific first
export function sessionKeys(sid?: string, env = process.env): string[] {
  const ks = [sid, env.HUDDLE_SESSION, env.CLAUDE_CODE_SESSION_ID].map(k => clean(String(k ?? ""))).filter(Boolean);
  if (env.CLAUDE_PID) ks.push(`pid-${clean(env.CLAUDE_PID)}`);
  if (!ks.length) ks.push("terminal"); // a shell outside Claude Code
  const p = projectKey(env);
  if (p) ks.push(p);
  return [...new Set(ks)];
}
// the project's key: its main checkout (identity.ts sets the resolver: no import cycle), else
// CLAUDE_PROJECT_DIR; none outside a project
let projectDir: (env: NodeJS.ProcessEnv) => string | null = env => env.CLAUDE_PROJECT_DIR || null;
export const setProjectDir = (f: typeof projectDir) => { projectDir = f; };
export function projectKey(env = process.env): string | null {
  if (env.HUDDLE_NO_PROJECT_CRED === "1") return null;
  let d: string | null = null;
  try { d = projectDir(env); } catch {}
  return d ? `project-${createHash("sha1").update(d).digest("hex").slice(0, 16)}` : null;
}

const read = (f: string): Cred | null => {
  try { const c = JSON.parse(readFileSync(f, "utf8")); return c && typeof c.credential === "string" && typeof c.url === "string" ? c : null; } catch { return null; }
};
const norm = (u: string) => u.replace(/\/$/, "");

// this session's credential (for url, when given)
export function loadCred(url?: string, sid?: string): Cred | null {
  for (const k of sessionKeys(sid)) {
    const c = read(join(sessionsDir(), `${k}.json`));
    if (c && (!url || norm(c.url) === norm(url))) return c;
  }
  return null;
}

// keep it under every key of this session; files idle for a week are forgotten
export function saveCred(c: Cred, sid?: string): void {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
  for (const k of sessionKeys(sid)) {
    const f = join(dir, `${k}.json`), tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...c, url: norm(c.url) }), { mode: 0o600 });
    renameSync(tmp, f);
  }
  // a session's files idle for a week are forgotten; a project's stays until it is replaced
  try { for (const f of readdirSync(dir)) if (!f.startsWith("project-") && Date.now() - statSync(join(dir, f)).mtimeMs > 7 * 86400_000) rmSync(join(dir, f), { force: true }); } catch {}
}

export function forgetCred(sid?: string): void {
  for (const k of sessionKeys(sid)) rmSync(join(sessionsDir(), `${k}.json`), { force: true });
}
// a credential kept under another project's key (setup joins a Huddle this user already runs)
export function projectCred(dir: string, url?: string): Cred | null {
  const c = read(join(sessionsDir(), `project-${createHash("sha1").update(dir).digest("hex").slice(0, 16)}.json`));
  return c && (!url || norm(c.url) === norm(url)) ? c : null;
}

// A dashboard link for the user, never for Claude: a login code is a secret, so a session that
// asks for one from inside Claude Code (`huddle open`, or `huddle join … --token` that just joined)
// leaves a request here (<key>.link, empty, 0600), and the next hook of the session
// (hooks/listen.ts, after that very tool call) mints the code and shows the link in its
// systemMessage, which the user sees and Claude does not
export function requestLink(sid?: string): void {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const k of sessionKeys(sid).filter(k => !k.startsWith("project-"))) writeFileSync(join(dir, `${k}.link`), "", { mode: 0o600 });
}
// was a link asked for? (and the request is gone)
export function takeLinkRequest(sid?: string): boolean {
  let asked = false;
  for (const k of sessionKeys(sid).filter(k => !k.startsWith("project-"))) {
    const f = join(sessionsDir(), `${k}.link`);
    try { statSync(f); asked = true; rmSync(f, { force: true }); } catch {}
  }
  return asked;
}

// An invite for the user, never for Claude, the same way: `huddle token create --print-join-command`
// inside Claude Code (/huddle:invite) leaves the invite's options here (<key>.invite, 0600, no
// secret in it), and the next hook mints the invite and shows its join line in systemMessage
export type InviteAsk = { ttl?: number; single_use?: boolean; can_invite?: boolean; channel?: string; description?: string };
export function requestInvite(o: InviteAsk, sid?: string): void {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const k of sessionKeys(sid).filter(k => !k.startsWith("project-"))) writeFileSync(join(dir, `${k}.invite`), JSON.stringify(o), { mode: 0o600 });
}
export function takeInviteRequest(sid?: string): InviteAsk | null {
  let asked: InviteAsk | null = null;
  for (const k of sessionKeys(sid).filter(k => !k.startsWith("project-"))) {
    const f = join(sessionsDir(), `${k}.invite`);
    try { asked ??= JSON.parse(readFileSync(f, "utf8")) ?? {}; rmSync(f, { force: true }); } catch {}
  }
  return asked;
}

// the credential to send to url: HUDDLE_TOKEN, else this session's for that url, else none
export const tokenFor = (url: string, sid?: string): string => process.env.HUDDLE_TOKEN || loadCred(url, sid)?.credential || "";

// fetch with this session's credential; a 401 reads the credential again and retries once (another
// process of this session may have just joined)
export async function hfetch(url: string, init: RequestInit & Record<string, any> = {}, sid?: string): Promise<Response> {
  const base = new URL(url).origin;
  // timeout: false (a long-poll or a live stream) — no client timeout on either runtime (server/src/rt.ts)
  const { timeout, ...rest } = init;
  const go = (t: string) => (timeout === false ? fetchUntimed : fetch)(url, { ...rest, headers: { ...(init.headers as Record<string, string> ?? {}), ...(t ? { [HEADER]: t } : {}) } });
  const t = tokenFor(base, sid);
  const r = await go(t);
  if (r.status !== 401) return r;
  const again = tokenFor(base, sid);
  return again && again !== t ? go(again) : r;
}
