---
description: Show whether the dashboard is running, its URL and uptime
allowed-tools: Bash
---

!`R=$(command -v bun || command -v node) || { echo "observatory: needs bun (or node) on PATH"; exit 0; }; "$R" "${CLAUDE_PLUGIN_ROOT}/dist/observatory.js" status 2>&1`

Show the output above to the user as it is, with no preamble or recap. Do nothing else.
