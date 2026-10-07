// Bundle every entry of the plugin into plugin/dist/ (one ES module each, committed so installs need
// no build): the CLI, the MCP bridge, the server and each hook. Bun and Node both run these files
// (every launch line points at them); the TypeScript sources under plugin/ stay the source of truth.
// Runs on Bun or Node: `bun run build`. `--check` rebuilds in memory and fails when a committed bundle is stale.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [file, text] of await bundles()) {
    const path = join(ROOT, file);
    if (check) {
      const committed = await readFile(path, "utf8").catch(() => "");
      if (committed !== text) { console.error(`${file} is stale: run bun run build`); stale++; }
    } else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); console.log(file); }
  }
  if (stale) process.exit(1);
  if (check) console.log("plugin/dist is fresh");
}
