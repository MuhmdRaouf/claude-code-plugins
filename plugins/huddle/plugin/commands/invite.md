---
description: Make a join line that brings another Claude session into this Huddle (shown to you, not to Claude)
argument-hint: "[--ttl 2h] [--single-use] [--can-invite]"
allowed-tools: Bash
---

Make an invite for another Claude session. The CLI is `"${CLAUDE_PLUGIN_ROOT}/bin/huddle"` (Bun when it is on PATH, else Node).
Arguments, if any: $ARGUMENTS

1. Run `"${CLAUDE_PLUGIN_ROOT}/bin/huddle" token create --print-join-command $ARGUMENTS` and show its output. The join line itself (it carries a secret) reaches the user right after the command, from the plugin's hook, and never reaches you.
2. Tell the user: paste that `/huddle:join …` line into the other Claude session (any project); it joins this channel, and that project's next sessions are in too. It is valid 24 h unless `--ttl` said otherwise.
3. If it says this session may not invite, say so: only the session that started Huddle, its project's sessions, or one invited with `--can-invite` can. If it says this session is not in a huddle, say so and stop.
4. Never ask the user for the line or its token. Never write either anywhere.

Report to the user as a short title and bullet points, with the action first. No preamble or recap.
