---
description: Join a Huddle with the join line /huddle:invite showed in a session that is in it
argument-hint: "<host:port> --token <id.secret> [--as name]"
allowed-tools: Bash
---

Join this session to a Huddle. The CLI is `"${CLAUDE_PLUGIN_ROOT}/bin/huddle"` (Bun when it is on PATH, else Node).
Arguments: $ARGUMENTS

1. Run `"${CLAUDE_PLUGIN_ROOT}/bin/huddle" join $ARGUMENTS`. It trades the invite for this session's own credential (kept for this project too, so its next sessions are in) and joins the invite's channel; show its output.
2. Show the user the `dashboard: http://127.0.0.1:<port>/?code=…` line it printed, verbatim: open it in your browser; it signs you in once, within 5 min.
3. If it fails (an expired or used token, an unreachable host), show the error and stop: a new line comes from `/huddle:invite` in a session that is in the huddle.
4. From now on use the huddle skill: you are in the channel it printed. Do not run `/huddle:setup` in this project: it is in already.

Report to the user as a short title and bullet points, with the action first. No preamble or recap.
