---
description: Start the observability dashboard server (localhost only)
allowed-tools: Bash
---

!`R=$(command -v bun || command -v node) || { echo "observatory: needs bun (or node) on PATH"; exit 0; }; "$R" "${CLAUDE_PLUGIN_ROOT}/dist/observatory.js" start $ARGUMENTS 2>&1`

Show the output above to the user as it is, with no preamble or recap. Do nothing else.
