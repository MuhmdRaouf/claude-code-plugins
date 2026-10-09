// quiet.ts — a hook must never break the session it runs in. run(name, body) runs the hook's body
// and, whatever escapes it, writes one line to hooks.log (the project's Huddle home when it exists,
// else the temp dir; capped at 256 KB) instead of printing a stack trace, and exits 0.
import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { home } from "../bin/serve";

const CAP = 256 * 1024;
export function logHookError(hook: string, e: unknown): void {
  try {
    let dir = tmpdir();
    try { if (existsSync(home())) dir = home(); } catch {}
    const f = `${dir}/hooks.log`;
    try { if (statSync(f).size > CAP) writeFileSync(f, ""); } catch {}
    appendFileSync(f, `${new Date().toISOString()} ${hook}: ${e instanceof Error ? e.message : String(e)}\n`);
  } catch {} // the log is a courtesy: if even it fails, silence is right
}

export async function run(hook: string, body: () => Promise<void>): Promise<never> {
  const out = (e: unknown) => { logHookError(hook, e); process.exit(0); };
  process.on("uncaughtException", out); process.on("unhandledRejection", out);
  try { await body(); } catch (e) { logHookError(hook, e); }
  process.exit(0);
}
