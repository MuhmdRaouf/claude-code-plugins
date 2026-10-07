#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Bundle the three entries with esbuild. Plain mode writes the committed artifacts; --check rebuilds in
// memory and byte-compares against what is committed, so a stale bundle never ships.
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");

// No banner: the node entries open with their own shebang, which esbuild hoists to line 1 — adding one
// here would push a second "#!" onto line 2, where it is a syntax error, not a hashbang.
const ENTRIES = [
  {
    name: "observatory cli",
    entry: "src/cli/main.ts",
    outfile: "plugin/dist/observatory.js",
    platform: "node",
  },
  {
    name: "hook",
    entry: "src/hook/main.ts",
    outfile: "plugin/dist/hook.js",
    platform: "node",
  },
  {
    name: "browser app",
    entry: "src/ui/main.ts",
    outfile: "plugin/public/app.js",
    platform: "browser",
  },
];

async function bundleOne(entry) {
  const result = await build({
    entryPoints: [resolve(root, entry.entry)],
    outfile: resolve(root, entry.outfile),
    absWorkingDir: root,
    bundle: true,
    write: false,
    minify: true,
    format: "esm",
    target: entry.platform === "node" ? "node22" : "es2022",
    platform: entry.platform,
    legalComments: "none",
    sourcemap: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].contents;
}

// The node bundles are ES modules wherever the plugin is installed: Claude Code copies only plugin/, so
// no package.json with "type": "module" sits above dist/ there unless dist/ carries its own (Node before
// 22.7 does not detect ESM syntax by itself).
const MARKER = {
  outfile: "plugin/dist/package.json",
  text: `${JSON.stringify({ type: "module" }, null, 2)}\n`,
};

let failures = 0;
for (const entry of [...ENTRIES, MARKER]) {
  const contents = entry.text === undefined ? await bundleOne(entry) : Buffer.from(entry.text);
  const path = resolve(root, entry.outfile);
  if (check) {
    let committed = null;
    try {
      committed = readFileSync(path);
    } catch {
      // reported below like any other mismatch
    }
    if (committed === null || !committed.equals(contents)) {
      failures += 1;
      console.error(`stale bundle: ${entry.outfile} — run: npm run build -w observatory`);
    }
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  console.log(`built ${entry.outfile} (${contents.length} bytes)`);
}

if (check && failures > 0) process.exit(1);
