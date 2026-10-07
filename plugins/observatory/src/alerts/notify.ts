/**
 * Desktop notifications: macOS `osascript -e 'display notification …'`, Linux `notify-send`
 * when it is on PATH, otherwise nothing at all. Each one is spawned detached with stdio ignored and killed after a
 * few seconds if it hangs; nothing ever waits on it and nothing here throws. Each alert notifies once (its id is
 * remembered in <state>/notified.json for a week), and one kind + subject at most once per 10 minutes. The text is
 * the alert's kind, project folder name and one-line detail: never a prompt, a token, a key or file contents.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { writeJsonAtomic } from "../budget/budgets.ts";
import { stateDir } from "../shared/paths.ts";
import type { Alert } from "./engine.ts";

export type Runner = (command: string, args: string[]) => void;

export const NOTIFY_KINDS = new Set<Alert["kind"]>(["budget", "stuck", "loop"]);
const RATE_MS = 10 * 60_000;
const REMEMBER_MS = 7 * 86_400_000;
const KILL_AFTER_MS = 5000;

export function notifiedPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "notified.json");
}

/** Spawn and forget: detached, no stdio, a kill timer that does not hold the process open. */
export function spawnDetached(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined); // a missing binary is not our problem to report
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, KILL_AFTER_MS);
    timer.unref();
    child.on("exit", () => clearTimeout(timer));
    child.unref();
  } catch {
    // no notification is better than any failure
  }
}

function onPath(env: NodeJS.ProcessEnv, name: string): boolean {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

/** AppleScript string literal body: backslashes and quotes escaped, control characters gone. */
export function appleScriptText(text: string): string {
  const printable = [...text].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch));
  return printable.join("").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The command line that shows one notification on this platform, or null where there is none. */
export function notifyCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  title: string,
  body: string,
): { command: string; args: string[] } | null {
  if (platform === "darwin") {
    const script = `display notification "${appleScriptText(body)}" with title "${appleScriptText(title)}"`;
    return { command: "osascript", args: ["-e", script] };
  }
  if (platform === "linux" && onPath(env, "notify-send")) {
    return { command: "notify-send", args: ["--app-name=Observatory", title, body] };
  }
  return null;
}

const TITLES: Record<Alert["kind"], string> = {
  budget: "Observatory: budget",
  stuck: "Observatory: session looks stuck",
  loop: "Observatory: agent is looping",
  retry_storm: "Observatory: retry storm",
  context: "Observatory: context nearly full",
};

export type Notifier = {
  /** Notify about the alerts worth a notification that have not been notified before. Returns how many went out. */
  consider(alerts: Alert[]): number;
};

export type NotifierOptions = {
  env: NodeJS.ProcessEnv;
  /** Read on every call: the dashboard toggle can flip it at any time. */
  enabled: () => boolean;
  runner?: Runner;
  platform?: NodeJS.Platform;
  now?: () => number;
};

function readNotified(env: NodeJS.ProcessEnv): Map<string, number> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(notifiedPath(env), "utf8"));
    const ids = typeof parsed === "object" && parsed !== null ? (parsed as { ids?: unknown }).ids : null;
    if (typeof ids !== "object" || ids === null) return new Map();
    return new Map(
      Object.entries(ids as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  } catch {
    return new Map();
  }
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function createNotifier(options: NotifierOptions): Notifier {
  const runner = options.runner ?? spawnDetached;
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const notified = readNotified(options.env);
  const lastBySubject = new Map<string, number>();

  function save(): void {
    const cutoff = now() - REMEMBER_MS;
    for (const [id, at] of notified) if (at < cutoff) notified.delete(id);
    try {
      writeJsonAtomic(notifiedPath(options.env), { version: 1, ids: Object.fromEntries(notified) });
    } catch {
      // forgetting means at most one repeat after a restart
    }
  }

  function send(alert: Alert): boolean {
    const subject = `${alert.kind}:${alert.kind === "budget" ? alert.id.split(":")[1] : alert.sessionId}`;
    const last = lastBySubject.get(subject);
    if (last !== undefined && now() - last < RATE_MS) return false;
    const body = clip(alert.project === "" ? alert.detail : `${alert.project}: ${alert.detail}`, 220);
    const line = notifyCommand(platform, options.env, TITLES[alert.kind], body);
    lastBySubject.set(subject, now());
    if (line === null) return false;
    runner(line.command, line.args);
    return true;
  }

  return {
    consider(alerts) {
      if (!options.enabled() || options.env.OBSERVATORY_NOTIFY === "0") return 0;
      const fresh = alerts.filter((alert) => NOTIFY_KINDS.has(alert.kind) && !notified.has(alert.id));
      if (fresh.length === 0) return 0;
      for (const alert of fresh) notified.set(alert.id, now());
      const sent = fresh.filter(send).length;
      save();
      return sent;
    },
  };
}
