// The launcher every plugin ships as plugin/dist/run: Claude Code's hooks, commands and agents start it with
// `sh "${CLAUDE_PLUGIN_ROOT}/dist/run" <entry> [args...]`. It maps the entry to its subcommand and runs it on
// the installed binary, which the launcher itself downloads and checksum-verifies during setup. There is
// no JS fallback: with no binary available and none downloadable the launcher says why and exits 127, and a
// hook exits 0 silently (starting one detached download of the binary, locked so all hooks share it), since a
// hook never blocks or fails Claude Code.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The GitHub repository every release downloads from. */
const REPO = "MuhmdRaouf/claude-code-plugins";

/** The release pinned by the manifests in `releaseDir` (`v*.json`, newest by semver): its version, the
 *  repository its assets download from, and every target's sha256. Null while no manifest exists: the launcher
 *  then has nothing to pin, and generating one throws — a broken release must stop the build, not ship quietly. */
export function releaseInfo(releaseDir) {
  let names = [];
  try {
    names = readdirSync(releaseDir);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    return null;
  }
  const manifests = [];
  for (const name of names) {
    const match = /^v(\d+)\.(\d+)\.(\d+)\.json$/.exec(name);
    if (match !== null) manifests.push({ name, parts: match.slice(1).map(Number) });
  }
  if (manifests.length === 0) return null;
  manifests.sort((a, b) => a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2]);
  const manifest = JSON.parse(readFileSync(join(releaseDir, manifests.at(-1).name), "utf8"));
  const sha256 = {};
  for (const [target, asset] of Object.entries(manifest.assets ?? {})) sha256[target] = asset.sha256;
  return { version: manifest.version, repo: REPO, sha256 };
}

/** The launcher spec for a provider plugin `name` (zai, kimi, ...): the four bundles on the plugin-core
 *  binary. Setup owns the download — only the cli entry's setup command fetches in the foreground (12 s
 *  under --hook), every other entry points at setup — and any --hook argument marks a hook. `core` is the
 *  release to run (releaseInfo's result); without one there is no launcher to generate and this throws. */
export function providerSpec(name, core) {
  if (core === null)
    throw new Error(
      "no plugin-core release to pin: run go run ./scripts/build -manifest in packages/core and commit release/v<VERSION>.json",
    );
  return {
    header: `# ${name}: starts one of this plugin's bundles on the installed plugin-core binary, downloading and verifying
#   it during setup.
#   sh "\${CLAUDE_PLUGIN_ROOT}/dist/run" <bundle>.js [args...]
# plugin-core lives under \${AGENTS_CORE_HOME:-$HOME/.agents/core}/${core.version}; setup downloads it from
# ${core.repo}'s GitHub releases and verifies its sha256 there (CORE_DOWNLOAD_BASE overrides the release
# URL for tests). With no binary available and none downloadable this says why and exits 127; a hook (any
# --hook argument) never blocks or fails Claude Code: it exits 0 at once, starting one detached download —
# guarded by a lock in the version dir so every hook shares it — that installs the binary for the next hook.`,
    name,
    binary: "plugin-core",
    downloadFn: "download_core",
    tagPrefix: "core-v",
    version: core.version,
    repo: core.repo,
    sha256: core.sha256,
    argName: "bundle",
    entries: [
      [`${name}.js`, "cli"],
      [`${name}-router.js`, "router"],
      [`${name}-passthrough.js`, "passthrough"],
      [`${name}-ensure.js`, "ensure"],
    ],
    hookFlag: true,
    hookEntries: [],
    binaryArg: `${name} `,
    homeEnv: "AGENTS_CORE_HOME",
    homeDir: "$HOME/.agents/core",
    baseEnv: "CORE_DOWNLOAD_BASE",
    setupEntry: "cli",
    hookFetchTimeout: 12,
    timeout: 120,
    failStatus: 127,
    missing: `${name}: plugin-core ${core.version} is not installed; run /${name}:setup`,
  };
}

/** The case mapping of the first argument: one line per entry, the bundle's file naming its entry. */
function caseMapping(spec) {
  return spec.entries.map(([arg, entry]) => `  ${arg}) entry=${entry} ;;`).join("\n");
}

/** The exec line every dispatch point shares: the binary, the provider's name before the entry, the entry
 *  and the caller's arguments. */
const execLine = (spec) => `exec "$bin" ${spec.binaryArg}"$entry" "$@"`;

/** status=$? and the exec when a foreground download landed its binary. */
function downloadRun(spec, pad) {
  return `${pad}status=$?
${pad}if [ "$status" = 0 ]; then
${pad}  ${execLine(spec)}
${pad}fi`;
}

/** The exit a failed foreground download returns. */
function failExit(spec, pad) {
  return `${pad}exit ${spec.failStatus}`;
}

/** The two one-line failures and the exit when it did not. */
function downloadReport(spec, pad) {
  return `${pad}if [ "$status" = 2 ]; then
${pad}  echo "${spec.name}: ${spec.binary} download failed its checksum" >&2
${pad}else
${pad}  echo "${spec.name}: could not download ${spec.binary} ${spec.version} ($url)" >&2
${pad}fi
${failExit(spec, pad)}`;
}

/** The setup entry's foreground download: the only place a provider plugin downloads,
 *  short-timeout under --hook and silent for a hook. */
function setupFetch(spec) {
  return `  if [ "$entry" = ${spec.setupEntry} ] && [ "$1" = setup ]; then
    timeout=${spec.timeout}
    [ -n "$hook" ] && timeout=${spec.hookFetchTimeout}
    ${spec.downloadFn} "$timeout"
${downloadRun(spec, "    ")}
    if [ -n "$hook" ]; then exit 0; fi
${downloadReport(spec, "    ")}
  fi`;
}

/** The launcher script for a spec (providerSpec's result): the entry's
 *  subcommand on the installed binary, which the launcher itself downloads and checksum-verifies; a hook
 *  whose binary is missing starts one detached, lock-guarded download so the next hook finds it
 *  installed. */
export function launcherScript(spec) {
  const hookInit = spec.hookEntries.map((entry) => `[ "$entry" = ${entry} ] && hook=1`);
  const hookLines = ["hook=", ...hookInit, "detached="].join("\n");
  const scanBody = [
    ...(spec.hookFlag ? [`  [ "$arg" = "--hook" ] && hook=1`] : []),
    `  [ "$arg" = "--detached-fetch" ] && detached=1`,
  ].join("\n");
  const dispatch = [
    `if [ "$os" != unsupported ] && [ "$arch" != unsupported ]; then
  if [ -x "$bin" ]; then
    ${execLine(spec)}
  fi`,
    setupFetch(spec),
    `  if [ -n "$detached" ]; then
    fetch_under_lock
    exit 0
  fi`,
    `  if [ -n "$hook" ]; then
    # One detached download for every hook: it re-runs this script on $0 with --detached-fetch, so the fetch
    # reuses the same URL and checksum table; it ignores HUP and outlives the hook that started it.
    (
      trap '' HUP
      sh_cmd=$(command -v sh 2>/dev/null) || sh_cmd=/bin/sh
      exec "$sh_cmd" "$0" "$${spec.argName}" --detached-fetch
    ) >/dev/null 2>&1 </dev/null &
  fi`,
    "fi",
  ]
    .filter(Boolean)
    .join("\n");
  return `#!/bin/sh
${spec.header}
# Generated by the plugin's scripts/build.mjs; do not edit.
dir=$(dirname -- "$0")
${spec.argName}=$1
shift
case "$${spec.argName}" in
${caseMapping(spec)}
  *)
    echo "${spec.name}: unknown ${spec.argName} $${spec.argName}" >&2
    exit 2
    ;;
esac
${hookLines}
for arg in "$@"; do
${scanBody}
done
os=$(uname -s)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) os=unsupported ;;
esac
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) arch=unsupported ;;
esac
home=\${${spec.homeEnv}:-${spec.homeDir}}
bin=$home/${spec.version}/${spec.binary}
base=\${${spec.baseEnv}:-https://github.com/${spec.repo}/releases/download}
url=$base/${spec.tagPrefix}${spec.version}/${spec.binary}-$os-$arch
want=
case "$os-$arch" in
${Object.entries(spec.sha256)
  .map(([target, hex]) => `  ${target}) want=${hex} ;;`)
  .join("\n")}
esac

# ${spec.downloadFn} <timeout>: fetch the release asset, verify its sha256 and install it as $bin. Returns 0 when
# the binary is installed, 1 when the asset could not be fetched, 2 when it failed its checksum.
${spec.downloadFn}() {
  timeout=$1
  mkdir -p "$home/${spec.version}"
  tmp=$home/${spec.version}/.${spec.binary}.$$.download
  got=
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time "$timeout" -o "$tmp" "$url" && got=1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T "$timeout" -O "$tmp" "$url" && got=1
  fi
  if [ -z "$got" ]; then
    rm -f "$tmp"
    return 1
  fi
  sum=
  if command -v sha256sum >/dev/null 2>&1; then sum=$(sha256sum "$tmp")
  elif command -v shasum >/dev/null 2>&1; then sum=$(shasum -a 256 "$tmp")
  elif command -v openssl >/dev/null 2>&1; then sum=$(openssl dgst -sha256 -r "$tmp")
  fi
  if [ -n "$want" ] && [ "\${sum%% *}" = "$want" ]; then
    chmod 755 "$tmp"
    mv -f "$tmp" "$bin"
    return 0
  fi
  rm -f "$tmp"
  return 2
}

# fetch_under_lock: the download a detached fetch runs. The version dir's lock holds the fetcher's pid and
# start time ("<pid> <epoch seconds>"); another fetch exits while that pid lives and the lock is under 120 s
# old, and takes over a lock whose holder died or stalled, so one download serves every hook.
fetch_under_lock() {
  trap '' HUP
  mkdir -p "$home/${spec.version}"
  lock=$home/${spec.version}/.${spec.binary}.fetch.lock
  now=$(date +%s)
  if (set -C; echo "$$ $now" >"$lock") 2>/dev/null; then
    :
  else
    read pid when <"$lock" || :
    if [ -z "$pid" ]; then
      sleep 1
      read pid when <"$lock" || :
    fi
    case "$pid" in *[!0-9]*|"") pid=0 ;; esac
    case "$when" in *[!0-9]*|"") when=0 ;; esac
    if [ "$pid" -ne 0 ] && kill -0 "$pid" 2>/dev/null && [ $(( $(date +%s) - when )) -lt 120 ]; then
      return 0
    fi
    rm -f "$lock"
    (set -C; echo "$$ $now" >"$lock") 2>/dev/null || return 0
  fi
  if [ -x "$bin" ]; then
    rm -f "$lock"
    return 0
  fi
  ${spec.downloadFn} ${spec.timeout}
  rm -f "$lock"
  return 0
}

${dispatch}
[ -n "$hook" ] && exit 0
[ -n "$detached" ] && exit 0
echo "${spec.missing}" >&2
exit ${spec.failStatus}
`;
}
