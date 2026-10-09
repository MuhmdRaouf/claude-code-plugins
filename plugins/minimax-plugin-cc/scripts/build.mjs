// Bundle the CLI, the router, its emergency passthrough and the ensure hook into the plugin (plugin/dist/minimax.js,
// minimax-router.js, minimax-passthrough.js and minimax-ensure.js, committed so installs need no build). `--check` rebuilds to
// memory and fails when a committed bundle is stale. plugin/dist/run, the launcher every hook, command and agent starts
// a bundle through (Bun by default, Node as the fallback), and plugin/dist/package.json, which has Node load the bundles
// as ESM wherever the plugin is installed, are written and checked the same way.
import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { distPackageJson, launcherScript } from "../../../packages/core/scripts/launcher.mjs";

const check = process.argv.includes("--check");
let stale = false;
for (const [entry, outfile] of [
  ["src/cli/main.ts", "plugin/dist/minimax.js"],
  ["src/router/main.ts", "plugin/dist/minimax-router.js"],
  ["src/router/passthrough.ts", "plugin/dist/minimax-passthrough.js"],
  ["src/router/ensure.ts", "plugin/dist/minimax-ensure.js"],
]) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    write: !check,
    legalComments: "none",
    // Dependencies such as yaml are CommonJS and require() node builtins, which an ESM bundle has no require for.
    banner: {
      js: [
        "#!/usr/bin/env node",
        'import { createRequire as __minimaxCreateRequire } from "node:module";',
        "const require = __minimaxCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    // Module paths in the bundle's comments stay node_modules/..., whether node_modules is a directory or a symlink.
    preserveSymlinks: true,
  });
  if (check) {
    const fresh = result.outputFiles[0].text;
    const committed = await readFile(outfile, "utf8").catch(() => "");
    if (fresh !== committed) {
      console.error(`${outfile} is stale: run npm run build`);
      stale = true;
    } else console.log(`${outfile} is fresh`);
  }
}
const launcher = launcherScript("minimax");
if (check) {
  if ((await readFile("plugin/dist/run", "utf8").catch(() => "")) !== launcher) {
    console.error("plugin/dist/run is stale: run npm run build");
    stale = true;
  } else console.log("plugin/dist/run is fresh");
} else await writeFile("plugin/dist/run", launcher, { mode: 0o755 });
if (check) {
  if ((await readFile("plugin/dist/package.json", "utf8").catch(() => "")) !== distPackageJson) {
    console.error("plugin/dist/package.json is stale: run npm run build");
    stale = true;
  } else console.log("plugin/dist/package.json is fresh");
} else await writeFile("plugin/dist/package.json", distPackageJson);
if (stale) process.exit(1);
