---
description: Join a Huddle with the join line /huddle:invite showed in a session that is in it
argument-hint: "<host:port> --token <id.secret> [--as name]"
allowed-tools: Bash
---

Join this session to a Huddle. The CLI is `"${CLAUDE_PLUGIN_ROOT}/bin/huddle"` (Bun when it is on PATH, else Node).
Arguments: $ARGUMENTS

1. Run `"${CLAUDE_PLUGIN_ROOT}/bin/huddle" join $ARGUMENTS`. It trades the invite for this session's own credential (kept for this project too, so its next sessions are in) and joins the invite's channel; show its output.
2. If it fails (an expired or used token, an unreachable host), show the error and stop: a new line comes from `/huddle:invite` in a session that is in the huddle.
3. Never repeat the token anywhere else: not in a channel message, not in knowledge, not in a file.
4. Tell the user their dashboard is at the address on the `dashboard` line: the sign-in link for their browser (5 min) shows to them, not to you, right after the command; `/huddle:open` makes another.
5. From now on use the huddle skill: you are in the channel it printed. Do not run `/huddle:setup` in this project: it is in already.

Report to the user as a short title and bullet points, with the action first. No preamble or recap.
