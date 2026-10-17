---
description: Turn minimax on with the built-in setup only, no questions (key check, router, MiniMax in /model, agents on MiniMax)
allowed-tools: Bash(sh:*)
---

Run with the Bash tool, with `timeout` 600000 (setup may wait up to 9 minutes for the key page):

```bash
sh "${CLAUDE_PLUGIN_ROOT}/dist/run" minimax.js setup
```

Exit 6 means not ready; the report still names every check. Show the report to the user. If something is not ready,
give the fix for each failing line. Write what you add yourself as a short title and bullet points, the action first:

- MiniMax key missing: setup prints a URL and opens a one-time key page on 127.0.0.1 in the browser. The user
  saves the key there; setup checks it, keeps it in the OS keystore and continues by itself in the same run.
  If setup exits 6 asking to finish in the browser (no key within 9 minutes, or the page ended), show the printed
  URL and run setup again once the user is done. Never ask for the key in the chat, and never read or print a key
  file. Headless Linux without a keyring: set `MINIMAX_API_KEY` in the environment
  Claude Code starts from.
- `claude` binary missing or too old: install or update Claude Code so `claude` is on `PATH`.
- ping failed: the line says why (an API error such as 401 means the key is wrong or revoked).
- exit 127 with "needs Bun 1.3 or newer (or Node 22 or newer)": install Bun (the default) or Node so it is on `PATH`.

The `runtime` line names what the plugin runs on: Bun ≥1.3 (the default, used whenever `bun` is on `PATH` or in
`~/.bun/bin`) or Node ≥22 (the fallback). The minimax router and its jobs run on the same one.

Plain `setup` needs no flags. What it does:

- Without a key it opens the key page described above and waits for it; otherwise it asks nothing.
- It checks the key with one minimal request to MiniMax.
- It starts the minimax router: a small background process the plugin starts and repairs itself. Its hooks bring it back
  before the next prompt if it ever stops.
- It adds MiniMax M3 and MiniMax M2.7 Highspeed to `/model` next to Sonnet and Opus, and points Claude Code at the router.
- Picking one of them in `/model` sends those requests through the router to MiniMax. Every `claude-*` model still goes
  to Anthropic untouched, also while the router restarts or updates itself.

The report leads with the outcome:

- `ready`: when this run changed something it ends with the restart line. Show it, because the current session keeps
  talking to Anthropic until Claude Code restarts, and MiniMax M3 in `/model` and the minimax agents work from the next
  session.
- `not routed`: Claude Code's base URL is the user's own proxy, so nothing reaches the minimax router. Give the fix the
  line names.

If Claude ever can't connect: when part of the router fails, it passes Claude's requests straight to Anthropic, and
the session hooks take the base URL off a router that cannot come back. Removing `env.ANTHROPIC_BASE_URL` from
`~/.claude/settings.json` (or restoring `~/.claude/settings.json.minimax-backup`) always restores direct Anthropic access.

Uninstalling the plugin: run `/minimax:remove`, then `/plugin uninstall minimax-plugin-cc@muhmdraouf`. Uninstalled first, the
router cleans up after itself: it takes its entries out of `settings.json`, puts the agents' models back, retires
while the sessions that still use it are open, and removes its own files once they close.

`/minimax:remove` (`setup --remove`) undoes all of it: the agents go back to the models they had before setup (as the ledger
recorded them), the `/model` entries and the base URL go away, and the router retires: sessions already open keep
working through it until they close. A session-start hook re-applies the setup after a
plugin update overwrote it, falling back to Sonnet when the router is down or the key is gone.

This is the built-in setup alone: it asks nothing and sets up no other tool. `/minimax:setup` asks what to set up (the
built-in setup only, or also omp, opencode or pi as engines for minimax jobs) and runs that; `/minimax:setup:omp`,
`/minimax:setup:opencode` and `/minimax:setup:pi` each add one tool.
