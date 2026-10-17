// Write and check plugin/dist/run, the launcher every hook, command and agent starts a bundle through: it maps the
// bundle to its entry and runs it on the installed plugin-core binary, which setup downloads and checksum-verifies.
// scripts/launcher.mjs generates it against the newest packages/core/release/v*.json, so the committed launcher
// pins that release; with no manifest the build fails. `--check` fails when the committed launcher is stale. The
// plugin ships no other dist file: installs need no build step.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launcherScript, providerSpec, releaseInfo } from "../../../scripts/launcher.mjs";

const core = releaseInfo(join(import.meta.dirname, "../../../packages/core/release"));
const launcher = launcherScript(providerSpec("kimi", core));
if (process.argv.includes("--check")) {
  if ((await readFile("plugin/dist/run", "utf8").catch(() => "")) !== launcher) {
    console.error("plugin/dist/run is stale: run npm run build");
    process.exit(1);
  }
  console.log("plugin/dist/run is fresh");
} else await writeFile("plugin/dist/run", launcher, { mode: 0o755 });
