#!/usr/bin/env node
/**
 * Process shim: builds the real CliDeps (fetch with timeout, detached self-spawn, signals) and exits with
 * runCli's code. All behaviour lives in run.ts so tests never need this file.
 */
import { spawn } from "node:child_process";
import { type CliDeps, type FetchResult, runCli } from "./run.ts";

const DEFAULT_SINCE_MS = 24 * 3_600_000;

async function fetchJson(url: string): Promise<FetchResult> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return { ok: false, body: null };
    const body: unknown = await response.json();
    return {
      ok: true,
      body:
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : null,
    };
  } catch {
    return { ok: false, body: null };
  }
}

function whichOpener(): string | null {
  return process.platform === "darwin" ? "open" : "xdg-open";
}

const deps: CliDeps = {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  fetchJson,
  spawnDetached(args) {
    const self = process.argv[1];
    if (self === undefined) throw new Error("cannot locate the observatory CLI to spawn");
    const child = spawn(process.execPath, [self, ...args], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    return child.pid ?? -1;
  },
  signal(pid, signal) {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but belongs to someone else — still "alive"
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  openBrowser(url) {
    const opener = whichOpener();
    if (opener === null) return;
    try {
      spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // opening a browser is best-effort; the URL is already printed
    }
  },
  now: () => Date.now(),
  sinceMs: DEFAULT_SINCE_MS,
};

runCli(process.argv.slice(2), deps)
  .then((code) => process.exit(code))
  .catch(() => process.exit(1));
