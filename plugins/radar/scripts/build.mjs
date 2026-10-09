#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Bundle the node entries with esbuild and the dashboard with Vite. Plain mode writes the committed artifacts;
// --check rebuilds in memory and byte-compares against what is committed, so a stale bundle never ships.
import { build } from "esbuild";
import { build as viteBuild } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");

// No banner: the node entries open with their own shebang, which esbuild hoists to line 1 — adding one
// here would push a second "#!" onto line 2, where it is a syntax error, not a hashbang.
const ENTRIES = [
  {
    name: "radar cli",
    entry: "src/cli/main.ts",
    outfile: "plugin/dist/radar.js",
    platform: "node",
  },
  {
    name: "hook",
    entry: "src/hook/main.ts",
    outfile: "plugin/dist/hook.js",
    platform: "node",
  },
];

/**
 * The dashboard: vite.config.ts names the entry; one build yields app.js, app.css and the bundled fonts under
 * plugin/public/. Nothing is written here — the caller writes or compares each file.
 * @returns {Promise<{fileName: string, contents: Buffer}[]>}
 */
async function bundleApp() {
  const result = await viteBuild({
    configFile: resolve(root, "vite.config.ts"),
    root,
    logLevel: "silent",
    build: { write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
  const files = outputs.map((o) => ({
    fileName: o.fileName,
    contents: Buffer.from(o.type === "chunk" ? o.code : o.source),
  }));
  if (!files.some((f) => f.fileName === "app.js")) throw new Error("vite produced no app.js");
  if (!files.some((f) => f.fileName === "app.css")) throw new Error("vite produced no app.css");
  return files;
}

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

/** Write, or byte-compare in check mode, one artifact at `outfile` relative to the plugin root. */
async function ship(outfile, contents) {
  const path = resolve(root, outfile);
  if (check) {
    let committed = null;
    try {
      committed = readFileSync(path);
    } catch {
      // reported below like any other mismatch
    }
    if (committed === null || !committed.equals(contents)) {
      failures += 1;
      console.error(`stale bundle: ${outfile} — run: bun run build`);
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  console.log(`built ${outfile} (${contents.length} bytes)`);
}

for (const entry of [...ENTRIES, MARKER]) {
  const contents = entry.text === undefined ? await bundleOne(entry) : Buffer.from(entry.text);
  await ship(entry.outfile, contents);
}

// The dashboard: one vite build covers app.js, app.css and every font next to index.html.
for (const { fileName, contents } of await bundleApp()) {
  await ship(join("plugin/public", fileName), contents);
}

if (check && failures > 0) process.exit(1);
