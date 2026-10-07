// identity.ts — who this session is, which channel it is in, and where the project's Huddle files
// live, for the plugin's CLI, bridge and hooks. Everything Huddle keeps for a project is in its
// .agents/huddle/ (kept out of git):
//   huddle.json          {"channel": "shop", "as": "api", "role": "builds the API", "autostart": true, "port": 41873}
//   data/channels/*.db   the channels (SQLite), when this project's `huddle up` runs the server
//   huddle.pid, huddle.log
// Environment first (HUDDLE_URL, HUDDLE_CHANNEL, HUDDLE_AS, …), then the nearest
// .agents/huddle/huddle.json walking up from the project dir (CLAUDE_PROJECT_DIR) or the cwd
// (a .agents/.huddle.json is read too; huddle.json wins). Worktrees share the main checkout's
// files: one nested under the repo finds them walking up; one elsewhere finds them through git
// (the main checkout of its common .git dir). A worktree's own file, if any, wins. Last, what this
// session joined with `huddle join <host:port> --token …` (creds.ts) fills in what is still unset.
// The port: there is no fixed one. The home's huddle.json keeps it ("port"; "port_auto": true when
// huddle up picked it at random, so it may move when another program takes it); a server that
// runs from the home without a saved port has its port read from the process once and saved. No saved port and nothing running: no url yet, and the
// first `huddle up` picks one (serve.ts).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { loadCred, setProjectDir } from "./creds";
export { hfetch, tokenFor } from "./creds";

// every setting has an env var (wins) and a key in huddle.json (used when the var is unset)
//   HUDDLE_URL url · HUDDLE_PORT (the url http://127.0.0.1:<port>; huddle up saves it) · HUDDLE_CHANNEL channel · HUDDLE_AS as · HUDDLE_ROLE role
//   HUDDLE_PUSH push (topic globs pushed to an idle session, list or "off") · HUDDLE_WAIT wait (s)
//   HUDDLE_CONTEXT context (how the SessionStart hook joins: sync, fresh, or auto = by how the session started)
//   HUDDLE_LISTEN_DETAIL listen_detail (digest: messages in full, other events counted; all: everything)
//   HUDDLE_AUTOSTART autostart (1/true: the SessionStart hook runs `huddle up` when nothing answers)
//   HUDDLE_HOME home: the data/pid/log directory, instead of <project>/.agents/huddle; one server
//     serves every channel on the machine, so repos that share it point home at one place
// source: where url came from (env, config, port = HUDDLE_PORT, credential, saved, running, or none: no url yet)
export type Identity = { url: string; source: "env" | "config" | "port" | "credential" | "saved" | "running" | "none"; channel: string; as: string; role?: string; push: string[]; listen: string[]; wait: number; context: string; autostart: boolean; detail: "digest" | "all"; file?: string };

export const FILE = join(".agents", "huddle", "huddle.json"), LEGACY = join(".agents", ".huddle.json");
const load = (f: string) => { try { return { file: f, cfg: JSON.parse(readFileSync(f, "utf8")) }; } catch { return null; } };
// an empty variable (HUDDLE_URL=) counts as unset
const env = (k: string) => process.env[k] || undefined;
const start = () => process.env.CLAUDE_PROJECT_DIR || process.cwd();

// the main checkout of the git repo around dir, read from the files (spawning git costs seconds on
// a machine whose antivirus scans every process): a .git directory marks the main checkout; a .git
// file ("gitdir: <main>/.git/worktrees/<name>") marks a worktree and names its main checkout
const mains = new Map<string, string | null>();
export function mainCheckout(dir = start()): string | null {
  if (mains.has(dir)) return mains.get(dir)!;
  let main: string | null = null;
  for (let d = dir; ; d = dirname(d)) {
    const g = join(d, ".git");
    if (existsSync(g)) {
      if (statSync(g).isDirectory()) main = d;
      else {
        const gd = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, "utf8"))?.[1]?.trim() ?? "";
        const i = gd.lastIndexOf("/.git/worktrees/");
        main = i >= 0 ? gd.slice(0, i) : d; // a submodule or another layout: the checkout itself
      }
      break;
    }
    if (dirname(d) === d) break;
  }
  mains.set(dir, main);
  return main;
}

// a project's credential is keyed by its main checkout (creds.ts), so every worktree shares it
setProjectDir(env => { const d = env.CLAUDE_PROJECT_DIR || process.cwd(); return mainCheckout(d) ?? env.CLAUDE_PROJECT_DIR ?? null; });

// the nearest settings file, and the project root it belongs to
export function findConfig(from = start()): { file: string; cfg: any; root: string } | null {
  const at = (d: string) => { for (const f of [FILE, LEGACY]) { const p = join(d, f); if (existsSync(p)) { const l = load(p); return l && { ...l, root: d }; } } return undefined; };
  for (let d = from; ; d = dirname(d)) {
    const r = at(d); if (r !== undefined) return r;
    if (dirname(d) === d) break;
  }
  const main = mainCheckout(from);
  return (main && at(main)) || null;
}

// where this project's Huddle files live: HUDDLE_HOME, else <project>/.agents/huddle, where the
// project is the one whose settings were found, else the main checkout of the repo, else the cwd
export function homeOf(found = findConfig()): string {
  const h = env("HUDDLE_HOME") ?? (typeof found?.cfg?.home === "string" ? found.cfg.home.replace(/^~(?=\/|$)/, homedir()) : undefined);
  return h ?? join(found?.root ?? mainCheckout() ?? start(), ".agents", "huddle");
}

// the port saved in a home's huddle.json, and whether huddle picked it (auto) or someone chose it
export const portFile = (home = homeOf()) => join(home, "huddle.json");
export function savedPort(home = homeOf()): { port: number; auto: boolean } | null {
  const c = load(portFile(home))?.cfg, p = Number(c?.port);
  return Number.isInteger(p) && p > 0 && p < 65536 ? { port: p, auto: c.port_auto === true } : null;
}
export function savePort(port: number, auto: boolean, home = homeOf()): string {
  const f = portFile(home), c = load(f)?.cfg ?? {};
  c.port = port;
  if (auto) c.port_auto = true; else delete c.port_auto;
  mkdirSync(home, { recursive: true });
  writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(c, null, 2) + "\n"); renameSync(`${f}.${process.pid}.tmp`, f);
  return f;
}
export const local = (port: number) => `http://127.0.0.1:${port}`;
// a name made from a folder's (a project's default channel and session name): lowercase, a letter
// first, at most 32 characters of letters, digits and - (valid for a channel and a session)
export const slug = (dir: string, or = "session") =>
  (dir.split("/").filter(Boolean).pop() ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 32).replace(/-+$/, "") || or;

// the pid in <home>/huddle.pid, if that process is still a Huddle server (a stale pid may belong to anything)
export function runningPid(home = homeOf()): number | null {
  let pid: number;
  try { pid = Number(readFileSync(join(home, "huddle.pid"), "utf8").trim()); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return ps.status === 0 && /server\.ts|dist\/server\.js/.test(ps.stdout) ? pid : null; // run from source or bundled
}
// the loopback port a running Huddle server listens on, read from the process (lsof)
export function listeningPort(pid: number): number | null {
  const r = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" });
  const m = /^n(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)$/m.exec(r.stdout ?? "");
  return m ? Number(m[1]) : null;
}

// this home's server: its saved port, else (once, then saved) the port its running server listens on
function homeUrl(home: string): { url: string; source: "saved" | "running" } | null {
  const s = savedPort(home);
  if (s) return { url: local(s.port), source: "saved" };
  const pid = runningPid(home), port = pid ? listeningPort(pid) : null;
  if (!port) return null;
  try { savePort(port, false, home); } catch {}
  return { url: local(port), source: "running" };
}

export function identity(sid?: string): Identity {
  const found = findConfig();
  const c = found?.cfg ?? {};
  const given = String(env("HUDDLE_URL") ?? c.url ?? "").replace(/\/$/, "");
  const port = Number(env("HUDDLE_PORT"));
  const url = given || (Number.isInteger(port) && port > 0 && port < 65536 ? local(port) : "");
  const j = loadCred(url || undefined, sid); // what this session joined, if anything
  const h = url || j?.url ? null : homeUrl(homeOf(found));
  return {
    url: url || j?.url || h?.url || "",
    source: given ? (env("HUDDLE_URL") ? "env" : "config") : url ? "port" : j?.url ? "credential" : h?.source ?? "none",
    // a member's credential is bound to the channel its invite named, too: that one wins over the file's
    channel: String(env("HUDDLE_CHANNEL") ?? (j && !j.root ? j.channel : undefined) ?? c.channel ?? j?.channel ?? ""),
    // a member's credential is bound to the name it joined as (huddle join may have made the
    // project's name unique for it): that name wins over the project's; a root one acts as anyone
    as: String(env("HUDDLE_AS") ?? (j && !j.root ? j.as : undefined) ?? c.as ?? j?.as ?? ""),
    role: env("HUDDLE_ROLE") ?? c.role,
    push: (env("HUDDLE_PUSH") ?? (Array.isArray(c.push) ? c.push.join(",") : c.push) ?? "task.ready,turn.pass,ask,msg,control.*").split(",").map((x: string) => x.trim()).filter(Boolean),
    // more channels whose messages the hooks bring into the session (it need not have joined them)
    listen: (env("HUDDLE_LISTEN") ?? (Array.isArray(c.listen) ? c.listen.join(",") : c.listen) ?? "").split(",").map((x: string) => x.trim()).filter(Boolean),
    wait: Number(env("HUDDLE_WAIT") ?? c.wait ?? 1500),
    context: String(env("HUDDLE_CONTEXT") ?? c.context ?? "auto"),
    // what the hooks bring in after each tool call: messages in full and the rest as one count line
    // (digest), or every event in full (all; HUDDLE_LISTEN_DETAIL, "listen_detail" in the file)
    detail: String(env("HUDDLE_LISTEN_DETAIL") ?? c.listen_detail ?? "digest") === "all" ? "all" : "digest",
    autostart: ["1", "true"].includes(String(env("HUDDLE_AUTOSTART") ?? c.autostart ?? "").toLowerCase()),
    file: found?.file,
  };
}

// The join context for a SessionStart hook: a setting of sync or fresh wins; with auto, a resumed
// session syncs (it continues where it was), a cleared or compacted one starts fresh (its context
// window was just emptied or summarized), and a new one (startup) leaves it to the server.
export function contextFor(source: string | undefined, setting = "auto"): "sync" | "fresh" | undefined {
  if (setting === "sync" || setting === "fresh") return setting;
  if (source === "resume") return "sync";
  if (source === "clear" || source === "compact") return "fresh";
  return undefined;
}
