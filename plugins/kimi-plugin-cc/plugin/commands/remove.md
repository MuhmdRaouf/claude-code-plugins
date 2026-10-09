---
description: Turn kimi off — agents back on their models before setup, its models out of /model, router retired (open sessions keep working, it exits when they close), stored key removed. Run it before /plugin uninstall
allowed-tools: Bash(sh:*)
---

!`sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js setup --remove`

Show the report above to the user as it is. If it has a FAILED line, say what failed in one line and that running
`/kimi:remove` again retries it. Otherwise add one line: to uninstall the plugin as well, run
`/plugin uninstall kimi-plugin-cc@muhmdraouf` now. Add nothing else.
