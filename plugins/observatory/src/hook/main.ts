#!/usr/bin/env node
/**
 * Hook entrypoint: read stdin, record one spool line, maybe autostart the server, exit 0 no matter what.
 * Kept thin (and out of coverage): every rule it applies lives in record.ts.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hookErrorLog, savedPort, serverInfoPath, wantsAutostart } from "../shared/paths.ts";
import { makeIo, runHook } from "./record.ts";

// Whatever escapes (a throw outside runHook, a rejected promise) goes to hook-errors.log, never to stderr or the
// session's context, and the hook still exits 0.
function quietExit(error: unknown): never {
  try {
    const text = error instanceof Error ? `uncaught: ${error.message}` : `uncaught: ${String(error)}`;
    makeIo(process.env, () => new Date(), process.pid, process.ppid).logError(
      hookErrorLog(process.env),
      text,
    );
  } catch {
    // nothing left to tell anyone
  }
  process.exit(0);
}
process.on("uncaughtException", quietExit);
process.on("unhandledRejection", quietExit);

// The internal deadline: stdin that never closes must not hold the session (UserPromptSubmit runs inline
// with the prompt flow), so the hook gives up and exits 0 well within a second.
const SAFETY_MS = 750;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function timer(ms: number): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve(""), ms));
}

/** A server recorded in server.json whose process is alive (no network: the hook stays fast). */
function running(): boolean {
  try {
    const info = JSON.parse(readFileSync(serverInfoPath(process.env), "utf8")) as { pid?: unknown };
    if (typeof info.pid !== "number") return false;
    process.kill(info.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Start the dashboard server detached; true when a start was launched. Any failure is silent. */
function autostart(): boolean {
  try {
    const server = fileURLToPath(new URL("./observatory.js", import.meta.url));
    if (!existsSync(server)) return false;
    const child = spawn(process.execPath, [server, "start"], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    // never let observability break the session it observes
    return false;
  }
}

const raw = await Promise.race([readStdin(), timer(SAFETY_MS)]);
const io = makeIo(process.env, () => new Date(), process.pid, process.ppid);
const event = runHook(raw, io);
// A start it launched (not one it found running) is told to the user in one line: a systemMessage,
// which the user sees and Claude's context never gets. The address is the saved port (the server
// keeps it, server/app.ts); a first-ever start has none yet.
if (event === "SessionStart" && wantsAutostart(process.env) && !running() && autostart()) {
  const port = savedPort(process.env);
  const line =
    port !== null
      ? `observatory: dashboard at http://127.0.0.1:${port}`
      : "observatory: starting the dashboard (/observatory:status shows its address)";
  await new Promise<void>((resolve) =>
    process.stdout.write(`${JSON.stringify({ systemMessage: line })}\n`, () => resolve()),
  );
}
process.exit(0);
