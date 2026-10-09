// A PATH with the system's tools but no JavaScript runtime: CI images ship bun (and node) in /usr/bin, so
// "/usr/bin:/bin" alone would let a node-only run pick bun. Each tool is linked into one directory, minus the runtimes.
import { mkdirSync, readdirSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const RUNTIMES = new Set(["bun", "bunx", "node", "nodejs", "npm", "npx"]);

export function systemPath(dir) {
  mkdirSync(dir, { recursive: true });
  for (const sys of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    let names = [];
    try { names = readdirSync(sys); } catch { continue; }
    for (const n of names) {
      if (RUNTIMES.has(n) || existsSync(join(dir, n))) continue;
      try { symlinkSync(join(sys, n), join(dir, n)); } catch {}
    }
  }
  return dir;
}
