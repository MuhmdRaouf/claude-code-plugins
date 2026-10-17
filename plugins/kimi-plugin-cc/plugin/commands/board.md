---
description: What is running on Moonshot Kimi right now
allowed-tools: Bash(sh:*)
---

!`sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js board`

Show the table above to the user as it is, without reformatting. The `subagent` and `session` rows are Claude
Code's own sessions and subagents on the Moonshot Kimi models — they are view-only: never try to stop or manage them. If
a `job` row is still queued, running or verifying, you may ask once, with a single AskUserQuestion (choices `Stop`
and `Leave it`), whether to stop it; run `sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js stop <id>` for that job only
when the answer is `Stop`. Add nothing else.
