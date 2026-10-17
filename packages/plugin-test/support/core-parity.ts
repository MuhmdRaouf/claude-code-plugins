/**
 * The host-built plugin-core binary the shared plugin suites run: `packages/core/dist/plugin-core-host`, built by
 * packages/core/scripts/host-build.sh when missing or older than the Go sources (with the Go fake claude beside it,
 * `dist/fakeclaude-host`). A suite's copy of the plugin installs the binary under
 * AGENTS_CORE_HOME/<version>/plugin-core, and its `dist/run` — the launcher a release build ships, previewed on the
 * host build — execs it. PLUGIN_CORE_STARTED_FILE, a plugin-core test pin, records every start of the binary, so a
 * suite can tell the binary ran from a silent fallback to anything else.
 */
import { spawn, spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { expect } from "vite-plus/test";
import { tempDir } from "./tmp.ts";

const REPO_ROOT = join(import.meta.dirname, "../../..");
const CORE_GO = join(REPO_ROOT, "packages/core");
const HOST_BUILD = join(CORE_GO, "scripts", "host-build.sh");
const HOST_CLI = join(CORE_GO, "dist", "plugin-core-host");
const HOST_FAKE_CLAUDE_BIN = join(CORE_GO, "dist", "fakeclaude-host");
const HOST_LOCK = join(CORE_GO, "dist", ".host-build.lock");
/** Files a host build reads besides the .go sources: the module pins and the stamped version. */
const HOST_MODULE_FILES = ["go.mod", "go.sum", "VERSION"] as const;
/** Subtrees whose .go files a host build compiles. */
const HOST_SOURCE_ROOTS = ["cmd", "internal"] as const;

/** The version the launcher installs under and the runtime line answers: packages/core/VERSION, the value
 *  scripts/host-build.sh stamps into the binary at link time. */
function coreGoVersion(): string {
  const version = readFileSync(join(CORE_GO, "VERSION"), "utf8").trim();
  if (version === "") throw new Error("packages/core/VERSION is empty; the suites need a version");
  return version;
}

/** Undefined when the path is missing or unreadable, so a vanished file cannot crash a freshness check. */
function mtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Classifies one walk entry: a subdirectory to queue (testdata holds fixtures no build compiles) or a .go source
 *  (a *_test.go compiles into no binary). */
function collectEntry(pending: string[], sources: string[], dir: string, entry: Dirent): void {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) {
    if (entry.name !== "testdata") pending.push(path);
    return;
  }
  if (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")) sources.push(path);
}

/**
 * Every file a host build compiles or reads: the non-test .go files under cmd/ and internal/ (testdata holds
 * fixtures no build compiles, and *_test.go compiles into no binary) plus go.mod, go.sum and VERSION.
 */
function coreGoSources(): string[] {
  const sources = HOST_MODULE_FILES.map((name) => join(CORE_GO, name));
  const pending = HOST_SOURCE_ROOTS.map((root) => join(CORE_GO, root));
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) collectEntry(pending, sources, dir, entry);
  }
  return sources;
}

/** True when the binary is missing or any of `sources` is newer than it: the binary predates that change. */
export function hostBinaryStale(binary: string, sources: readonly string[]): boolean {
  const built = mtimeMs(binary);
  if (built === undefined) return true;
  return sources.some((source) => {
    const changed = mtimeMs(source);
    return changed !== undefined && changed > built;
  });
}

/** True when a host binary is missing or predates any Go input: what ensureHostBinaries rebuilds. */
function hostBinariesStale(): boolean {
  const sources = coreGoSources();
  return hostBinaryStale(HOST_CLI, sources) || hostBinaryStale(HOST_FAKE_CLAUDE_BIN, sources);
}

/**
 * Builds the host binaries when either is missing or predates a Go source, go.mod, go.sum or VERSION: a binary built
 * before a Go change fails tests the new code passes. Several suite files reach here at once: the first owns a lock
 * directory and runs the build; the rest wait for fresh binaries, so two builds never write the same output file.
 */
function ensureHostBinaries(): void {
  if (!hostBinariesStale()) return;
  mkdirSync(dirname(HOST_LOCK), { recursive: true });
  let owner = false;
  try {
    mkdirSync(HOST_LOCK, { recursive: false });
    owner = true;
  } catch {
    // someone else is building
  }
  if (owner) buildHostBinaries();
  else waitForHostBinaries();
}

/** Builds once, re-checking under the lock: another suite may have finished a build between the two checks. */
function buildHostBinaries(): void {
  try {
    if (!hostBinariesStale()) return;
    const built = spawnSync("sh", [HOST_BUILD], {
      cwd: CORE_GO,
      encoding: "utf8",
      env: { ...process.env, CGO_ENABLED: "0" },
    });
    if (built.status !== 0)
      throw new Error(`host-build.sh failed: ${built.stderr}${built.error?.message ?? ""}`);
  } finally {
    rmSync(HOST_LOCK, { recursive: true, force: true });
  }
}

/** Waits for another suite's build to land: fresh binaries, not merely existing ones. */
function waitForHostBinaries(): void {
  const deadline = Date.now() + 300_000;
  while (hostBinariesStale()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the host binaries to be built");
    spawnSync("sh", ["-c", "sleep 0.2"], { timeout: 5_000 });
  }
}

/** The host-built plugin-core binary the suites call as `<binary> <provider> cli <args…>`. */
export function hostCli(): string {
  ensureHostBinaries();
  return HOST_CLI;
}

/** The Go fake claude binary the workers run: self-contained, no runtime needed. */
export function hostFakeClaude(): string {
  ensureHostBinaries();
  return HOST_FAKE_CLAUDE_BIN;
}

/** One suite's sandbox: the binary installed where dist/run's plugin-core step looks for it. */
export interface CoreParity {
  /** AGENTS_CORE_HOME: holds <version>/plugin-core, a copy of the host-built binary. */
  readonly home: string;
  /** The core version the launcher installs under (packages/core/VERSION). */
  readonly version: string;
  /** The installed binary itself: what the launcher execs. */
  readonly binary: string;
  /** The env every run carries: the core home and the started-file pin. */
  readonly env: Readonly<Record<string, string>>;
}

/** Installs the host-built binary under <version>/plugin-core in a fresh temp home, removed with the test together
 *  with every process still running from inside it (a suite's router lives there). */
export function coreParity(prefix: string): CoreParity {
  const version = coreGoVersion();
  const home = tempDir(`${prefix}core-`);
  const binary = join(home, version, "plugin-core");
  mkdirSync(dirname(binary), { recursive: true });
  copyFileSync(hostCli(), binary);
  chmodSync(binary, 0o755);
  return {
    home,
    version,
    binary,
    env: { AGENTS_CORE_HOME: home, PLUGIN_CORE_STARTED_FILE: join(home, "started.log") },
  };
}

/**
 * The launcher a release build embeds, written into a copy's dist/run: the same bundle→entry mapping and
 * installed-binary step the shipped launcher carries (the plugin's scripts/build.mjs generates it), so the copy's
 * launcher execs the installed binary. A hook (any `--hook` argument) never blocks or fails Claude Code: with no
 * binary to run it exits 0 silently.
 */
export function writeCoreLauncher(copyDir: string, name: string, parity: CoreParity): void {
  const script = `#!/bin/sh
# ${name}: starts one of this plugin's bundles on the installed plugin-core binary.
#   sh "\${CLAUDE_PLUGIN_ROOT}/dist/run" <bundle>.js [args...]
# plugin-core lives under \${AGENTS_CORE_HOME:-$HOME/.agents/core}/${parity.version}.
bundle=$1
shift
case "$bundle" in
  ${name}.js) entry=cli ;;
  ${name}-router.js) entry=router ;;
  ${name}-passthrough.js) entry=passthrough ;;
  ${name}-ensure.js) entry=ensure ;;
  *)
    echo "${name}: unknown bundle $bundle" >&2
    exit 2
    ;;
esac
hook=
for arg in "$@"; do
  [ "$arg" = "--hook" ] && hook=1
done
home=\${AGENTS_CORE_HOME:-$HOME/.agents/core}
bin=$home/${parity.version}/plugin-core
if [ -x "$bin" ]; then
  exec "$bin" ${name} "$entry" "$@"
fi
[ -n "$hook" ] && exit 0
echo "${name}: plugin-core ${parity.version} is not installed; run /${name}:setup" >&2
exit 127
`;
  writeFileSync(join(copyDir, "dist", "run"), script, { mode: 0o755 });
}

/** One run of a copy's launcher, spawned (never sync: a sync spawn blocks the event loop). */
export function runLauncher(
  copyDir: string,
  bundle: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn("sh", [join(copyDir, "dist", "run"), bundle, ...args], {
    cwd: env.HOME,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

/** Asserts the started-file names plugin-core: the binary the launcher exec'd, never a silent fallback. */
export function expectCoreStarted(parity: CoreParity): void {
  const file = parity.env.PLUGIN_CORE_STARTED_FILE ?? "";
  const started = existsSync(file) ? readFileSync(file, "utf8") : "";
  expect(started, "plugin-core was started").toMatch(/^plugin-core \d+$/m);
}
