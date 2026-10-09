---
description: Sign your browser in to the Huddle dashboard (a link only you see)
allowed-tools: Bash
---

Give the user a link that signs their browser in to the Huddle dashboard. The CLI is `"${CLAUDE_PLUGIN_ROOT}/bin/huddle"` (Bun when it is on PATH, else Node).

1. Run `"${CLAUDE_PLUGIN_ROOT}/bin/huddle" open` and show its output. It prints the dashboard's plain address; the sign-in link itself (a one-time code, 5 min) reaches the user right after the command, from the plugin's hook, and never reaches you.
2. If it fails because this session is not in a huddle, say so: the user gets in with the join line `/huddle:invite` shows in a session that is in it (`/huddle:join …`).
3. Never ask the user for the link or its code. Never write either anywhere.

Report to the user as a short title and bullet points, with the action first. No preamble or recap.
