---
description: Make a join line that brings another Claude session into this Huddle
argument-hint: "[--ttl 2h] [--single-use] [--can-invite]"
allowed-tools: Bash
---

Make an invite for another Claude session. The CLI is `"${CLAUDE_PLUGIN_ROOT}/bin/huddle"` (Bun when it is on PATH, else Node).
Arguments, if any: $ARGUMENTS

1. Run `"${CLAUDE_PLUGIN_ROOT}/bin/huddle" token create --print-join-command $ARGUMENTS` and show the user its `join:` line verbatim: the whole `/huddle:join 127.0.0.1:<port> --token <id.secret>` line, token included.
2. Tell the user: run that line in the other Claude session (any project); it joins this channel, and that project's next sessions are in too. It is valid 24 h unless `--ttl` said otherwise.
3. If it says this session may not invite, say so: only the session that started Huddle, its project's sessions, or one invited with `--can-invite` can. If it says this session is not in a huddle, say so and stop.

Report to the user as a short title and bullet points, with the action first. No preamble or recap.
