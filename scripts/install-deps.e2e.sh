#!/bin/sh
# The hermetic proof that installing a provider plugin installs huddle with it: a throwaway HOME and
# CLAUDE_CONFIG_DIR under .agents/scratch (removed on exit), the marketplace added from this checkout,
# `claude plugin install zai-plugin-cc@muhmdraouf`, then `claude plugin list --json` must name huddle enabled.
# Needs network: the catalogue fetches huddle with a git-subdir source from MuhmdRaouf/huddle. Documented, not
# part of CI; skipped unless `claude` is on PATH and CC_INSTALL_E2E=1.
set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SCRATCH="$REPO/.agents/scratch"

if [ "${CC_INSTALL_E2E:-}" != "1" ]; then
  echo "skip: set CC_INSTALL_E2E=1 to run the install e2e (needs network)"
  exit 0
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "skip: no claude on PATH"
  exit 0
fi

TMP=$(mktemp -d "$SCRATCH/install-deps.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM
export HOME="$TMP/home"
export CLAUDE_CONFIG_DIR="$TMP/home/.claude"
mkdir -p "$CLAUDE_CONFIG_DIR"

claude plugin marketplace add "$REPO"
claude plugin install zai-plugin-cc@muhmdraouf -y
claude plugin list --json >"$TMP/plugins.json"

node -e '
  const plugins = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const huddle = plugins.find((plugin) => typeof plugin.id === "string" && plugin.id.startsWith("huddle@"));
  if (!huddle) throw new Error("huddle is not installed");
  if (huddle.enabled !== true) throw new Error(`huddle is installed but not enabled (${huddle.enabled})`);
  console.log(`ok: ${huddle.id} installed and enabled`);
' "$TMP/plugins.json"
