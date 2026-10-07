// src/notify.ts — desktop notifications for what needs the owner: a question
// to the owner, a session someone paused, an approval request, a blocked task. The server sends
// them when the event happens (src/extras.ts), never a hook. macOS: osascript; Linux: notify-send
// when it is on PATH; anywhere else: nothing. Spawned detached with a timeout, never awaited by
// anything, never throws. The same kind and subject notify at most once per 10 minutes.
//
// On by default. The switch lives in the server's data dir (<HUDDLE_DATA>/settings.json,
// {"notify": false} turns them off): the dashboard's Settings and `huddle setup --no-notify` write it.
// The text is built from names and ids only, then cleaned: no message body, no command, no file
// content, and anything that looks like a secret is masked.
// Env: HUDDLE_NOTIFY=0 turns them off for this process; HUDDLE_NOTIFY_LOG=<file> appends each
// notification as a JSON line instead of showing it (tests, headless machines).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

const WINDOW_MS = () => Number(process.env.HUDDLE_NOTIFY_WINDOW_MS || 10 * 60_000);
const SPAWN_TIMEOUT_MS = 5000;

/** Masks anything that looks like a credential, strips control characters, caps the length. */
export function clean(s: string, max = 140): string {
  let t = String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ");
  t = t.replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|glpat|xox[abpr]|AKIA|ASIA)[-_A-Za-z0-9]{8,}/g, "…")
    .replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, "…")
    .replace(/((?:token|secret|password|passwd|api[-_]?key|key|credential|auth)\s*[=:]\s*)\S+/gi, "$1…");
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// the program that shows a notification here, or null
function onPath(name: string): string | null {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (!d) continue;
    const f = join(d, name);
    try { if (existsSync(f) && statSync(f).isFile()) return f; } catch {}
  }
  return null;
}
export function notifier(): "osascript" | "notify-send" | null {
  if (process.platform === "darwin") return existsSync("/usr/bin/osascript") || onPath("osascript") ? "osascript" : null;
  if (process.platform === "linux") return onPath("notify-send") ? "notify-send" : null;
  return null;
}

export class Notifier {
  private last = new Map<string, number>();
  private cache: { at: number; on: boolean } | null = null;
  constructor(private dir: string) {}
  private file() { return join(this.dir, "settings.json"); }
  private read(): Record<string, unknown> { try { return JSON.parse(readFileSync(this.file(), "utf8")); } catch { return {}; } }

  /** Whether notifications are on (the file is read at most every 2 s). */
  enabled(): boolean {
    if (process.env.HUDDLE_NOTIFY === "0") return false;
    if (this.cache && Date.now() - this.cache.at < 2000) return this.cache.on;
    const on = this.read().notify !== false;
    this.cache = { at: Date.now(), on };
    return on;
  }
  set(on: boolean) {
    const s = { ...this.read(), notify: !!on };
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, this.file());
    this.cache = { at: Date.now(), on: !!on };
    return this.state();
  }
  state() { return { notify: this.enabled(), notifier: process.env.HUDDLE_NOTIFY_LOG ? "log" : notifier(), forced_off: process.env.HUDDLE_NOTIFY === "0" }; }

  /** Show one notification, unless it is off or the same kind+subject showed in the last 10 min. Never throws. */
  send(kind: string, subject: string, title: string, body: string): boolean {
    try {
      if (!this.enabled()) return false;
      const key = `${kind}\u0000${subject}`, now = Date.now(), w = WINDOW_MS();
      const prev = this.last.get(key);
      if (prev !== undefined && now - prev < w) return false;
      this.last.set(key, now);
      if (this.last.size > 2000) for (const [k, t] of this.last) if (now - t >= w) this.last.delete(k);
      const t = clean(title, 80), b = clean(body, 160);
      const log = process.env.HUDDLE_NOTIFY_LOG;
      if (log) { appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), kind, subject, title: t, body: b }) + "\n"); return true; }
      const how = notifier();
      if (!how) return false;
      // the text goes in as arguments, never into the script: nothing in it can run
      const args = how === "osascript"
        ? ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", t, b]
        : ["-a", "Huddle", t, b];
      const p = spawn(how === "osascript" ? "osascript" : "notify-send", args, { detached: true, stdio: "ignore" });
      p.on("error", () => {});
      const kill = setTimeout(() => { try { p.kill(); } catch {} }, SPAWN_TIMEOUT_MS);
      kill.unref?.();
      p.on("exit", () => clearTimeout(kill));
      p.unref();
      return true;
    } catch { return false; }
  }
}
