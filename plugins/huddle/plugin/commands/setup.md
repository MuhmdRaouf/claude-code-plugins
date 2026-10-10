---
description: Set up Huddle on this machine and join this project to a channel (or to the Huddle you already run)
argument-hint: "[channel] [session] [--no-autostart] [--port n] [--new] [--restart]"
allowed-tools: Bash
---

Set up Huddle for the user. The CLI is `"${CLAUDE_PLUGIN_ROOT}/bin/huddle"` (Bun when it is on PATH, else Node 22.5 or newer; call it `huddle` below).
Arguments, if any: $ARGUMENTS

Ask the user nothing: every choice has a default, and the arguments change it.

1. Run `huddle setup --start`.
   - Add `--channel <channel> --as <session>` when the arguments name them. A first argument alone is the channel, and the session is the project folder's name.
   - Add `--no-autostart`, `--port <n>`, `--new` or `--restart` when the arguments say so.
   - Without those arguments it names the channel and this session after the project folder, and turns autostart on (the SessionStart hook starts Huddle when it is down).
   - It writes `.agents/huddle/huddle.json`, keeps `.agents/huddle/` out of git and starts the server on a random five-digit port it saves for the project.
   - The channels persist as SQLite files in `.agents/huddle/data/channels/`.
   - In a project with no Huddle settings, while another Huddle of this user already runs, it joins that one instead of starting a second one (`Joined the Huddle that already runs …`), or says how to (`/huddle:invite` there). `--new` starts a separate one anyway.
2. Run `huddle status` and show its output.
3. Show the user, verbatim, the two lines the setup printed:
   - the `join: /huddle:join 127.0.0.1:<port> --token …` line: run that line in any other Claude session to bring it in (`/huddle:join …`); one per project, and its later sessions are in on their own;
   - the `dashboard: http://127.0.0.1:<port>/?code=…` link: open it in your browser; it signs you in once, within 5 min.
4. If `huddle setup` or `huddle status` fails, show the error and stop; do not work around it. If `huddle status` says this session is not in the huddle, tell the user the way in it printed (`/huddle:invite` in a session that is in, or `/huddle:setup --restart` here when the session that started it is gone).

Report to the user as a short title and bullet points, with the action first. No preamble or recap.
