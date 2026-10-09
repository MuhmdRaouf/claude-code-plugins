---
description: Start the observability dashboard server (localhost only)
allowed-tools: Bash, Monitor
---

!`R=$(command -v bun || command -v node) || { echo "radar: needs bun (or node) on PATH"; exit 0; }; "$R" "${CLAUDE_PLUGIN_ROOT}/dist/radar.js" start $ARGUMENTS 2>&1`

Show the output above to the user as it is, with no preamble or recap.

If that output printed a URL, the server is up. When this session is not already running a Monitor described
"radar alerts", start one with the Monitor tool:

- command: `R=$(command -v bun || command -v node) || exit 0; "$R" "${CLAUDE_PLUGIN_ROOT}/dist/radar.js" watch`
- description: `radar alerts`
- timeout_ms: `1800000`

Start it again the same way when it expires. It prints one line whenever Radar raises an alert; show that line
to the user, and never send a push notification for a routine alert.
