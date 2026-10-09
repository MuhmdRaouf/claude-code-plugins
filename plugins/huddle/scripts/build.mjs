// Bundle every entry of the plugin into plugin/dist/ (one ES module each, committed so installs need
// no build): the CLI, the MCP bridge, the server and each hook. Bun and Node both run these files
// (every launch line points at them); the TypeScript sources under plugin/ stay the source of truth.
// The dashboard goes through Vite: one build covers app.js, app.css and every font next to index.html.
// Runs on Bun or Node: `bun run build`. `--check` rebuilds in memory and fails when a committed bundle is stale.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { build as viteBuild } from "vite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ENTRIES = {
  huddle: "plugin/bin/huddle.ts",
  "huddle-mcp": "plugin/bin/huddle-mcp.ts",
  server: "plugin/server/server.ts",
  "session-start": "plugin/hooks/session-start.ts",
  listen: "plugin/hooks/listen.ts",
  stop: "plugin/hooks/stop.ts",
  approve: "plugin/hooks/approve.ts",
};
// the bundles are ES modules wherever the plugin is installed (no package.json above them there)
const MARKER = ["plugin/dist/package.json", `${JSON.stringify({ type: "module" }, null, 2)}\n`];

export async function bundles() {
  const out = [MARKER];
  for (const [name, src] of Object.entries(ENTRIES)) {
    const r = await build({
      absWorkingDir: ROOT,
      entryPoints: [src],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      write: false,
      outfile: `plugin/dist/${name}.js`,
      legalComments: "none",
      // the Bun driver loads only on Bun (src/rt.ts); node: builtins stay imports
      external: ["bun:sqlite"],
      banner: { js: `// generated from ${src} by scripts/build.mjs (bun run build): edit the source` },
      logLevel: "error",
    });
    out.push([`plugin/dist/${name}.js`, r.outputFiles[0].text]);
  }
  return out;
}

/**
 * The dashboard: ui/vite.config.ts names the entry; one build yields app.js, app.css and the bundled
 * fonts under plugin/server/public/. Nothing is written here — the caller writes or compares each file.
 * @returns {Promise<{fileName: string, contents: Buffer}[]>}
 */
export async function bundleApp() {
  // always the production build: a test run's NODE_ENV=test must not change the committed bytes
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  let result;
  try {
    result = await viteBuild({
      configFile: resolve(ROOT, "ui/vite.config.ts"),
      root: resolve(ROOT, "ui"),
      mode: "production",
      logLevel: "silent",
      build: { write: false },
    });
  } finally {
    if (was === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = was;
  }
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
  const files = outputs.map((o) => ({
    fileName: o.fileName,
    contents: Buffer.from(o.type === "chunk" ? o.code : o.source),
  }));
  if (!files.some((f) => f.fileName === "app.js")) throw new Error("vite produced no app.js");
  if (!files.some((f) => f.fileName === "app.css")) throw new Error("vite produced no app.css");
  return files;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes("--check");
  let stale = 0;
  const ship = async (file, raw) => {
    const contents = Buffer.from(raw);
    const path = join(ROOT, file);
    if (check) {
      const committed = await readFile(path).catch(() => null);
      if (committed === null || !committed.equals(contents)) { console.error(`${file} is stale: run bun run build`); stale++; }
    } else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); console.log(file); }
  };
  for (const [file, text] of await bundles()) await ship(file, text);
  // the dashboard: one vite build covers app.js, app.css and every font next to index.html
  for (const { fileName, contents } of await bundleApp()) await ship(join("plugin/server/public", fileName), contents);
  if (stale) process.exit(1);
  if (check) console.log("plugin/dist is fresh");
}
