#!/usr/bin/env node
// Reject work-marker comments: the sources stay finished or the check fails. The pattern is assembled at
// runtime so this scanner never matches the marker words inside itself.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MARKERS = [
  ["TO", "DO"],
  ["FIX", "ME"],
].map((parts) => parts.join(""));
const PATTERN = new RegExp(`\\b(?:${MARKERS.join("|")})\\b`);
const SCANNED = ["src", "test", "scripts", "plugin/commands"];
const EXTENSIONS = new Set([".ts", ".mts", ".mjs", ".js", ".css", ".json", ".md", ".html"]);

const root = fileURLToPath(new URL("..", import.meta.url));

function filesUnder(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      found.push(...filesUnder(path));
      continue;
    }
    const dot = entry.name.lastIndexOf(".");
    if (dot > 0 && EXTENSIONS.has(entry.name.slice(dot))) found.push(path);
  }
  return found;
}

const offenders = [];
for (const dir of SCANNED) {
  for (const path of filesUnder(join(root, dir))) {
    if (PATTERN.test(readFileSync(path, "utf8"))) offenders.push(path.slice(root.length));
  }
}

if (offenders.length > 0) {
  console.error("work markers found (finish the work or drop the marker):");
  for (const path of offenders) console.error(`  ${path}`);
  process.exit(1);
}
console.log("no work markers");
