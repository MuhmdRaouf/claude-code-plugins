---
description: Set kimi up on this machine — asks every time what to set up (the built-in agents and /model, or also omp, opencode and pi), then runs it
allowed-tools: Bash(sh:*)
---

This command is always interactive: ask the questions below with AskUserQuestion every time it runs, even when they
were answered before; never skip one as already answered. The CLI never asks anything itself. (`/kimi:setup:claude`
runs the built-in setup alone with no questions; `/kimi:setup:omp`, `/kimi:setup:opencode` and `/kimi:setup:pi` add
one tool.)

## 1. Read what is set up now

Run with the Bash tool; it changes nothing:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js setup --engines --json
```

`setup` says whether the built-in setup has run on this machine. `engines` lists omp, opencode and pi in that order,
each with `binary` (found, or why not) and `watcher` (null unless the tool is enabled as an engine for kimi jobs).

## 2. Ask what to set up

One question, "What should Moonshot Kimi set up?", header "Setup", single choice, these two options in this order:

1. `Built-in only (Claude Code agents and /model)`: the kimi router, Kimi K3 and Kimi K2.6 in `/model`, and
   the `kimi:kimi-k3` and `kimi:kimi-k2.6` agents on them.
2. `Built-in plus other tools (omp, opencode, pi)`: the same, then Moonshot Kimi jobs also run on the tools picked next.

Mark the current state by adding ` (current)` to one label: the second option when any tool's `watcher` is not null,
otherwise the first when `setup` is true, neither when `setup` is false.

Only when the answer is the second option, ask a second question, "Which tools should run Moonshot Kimi jobs?", header
"Tools", multiSelect, one option per tool in this order: `omp`, `opencode`, `pi`. Add ` (installed)` to a tool's label
when its `binary.ok` is true and ` (not found)` when it is false, and `, enabled` before the closing parenthesis when
its `watcher` is not null. Each option's description is its `binary` value or error. A tool that is not found may
still be chosen: its check then reports the failing line.

## 3. The built-in setup, for either answer

Run with the Bash tool, with `timeout` 600000 (setup may wait up to 9 minutes for the key page):

```bash
sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js setup
```

Exit 6 means not ready; the report still names every check. Show the report to the user. If something is not ready,
give the fix for each failing line. Write what you add yourself as a short title and bullet points, the action first:

- Moonshot AI key missing: setup prints a URL and opens a one-time key page on 127.0.0.1 in the browser. The user
  saves the key there; setup checks it, keeps it in the OS keystore and continues by itself in the same run.
  If setup exits 6 asking to finish in the browser (no key within 9 minutes, or the page ended), show the printed
  URL and run setup again once the user is done. Never ask for the key in the chat, and never read or print a key
  file. Headless Linux without a keyring: set `KIMI_API_KEY` in the environment
  Claude Code starts from.
- `claude` binary missing or too old: install or update Claude Code so `claude` is on `PATH`.
- ping failed: the line says why (an API error such as 401 means the key is wrong or revoked).
- exit 127 with "needs Bun 1.3 or newer (or Node 22 or newer)": install Bun (the default) or Node so it is on `PATH`.

The `runtime` line names what the plugin runs on: Bun ≥1.3 (the default, used whenever `bun` is on `PATH` or in
`~/.bun/bin`) or Node ≥22 (the fallback). The kimi router and its jobs run on the same one.

Plain `setup` needs no flags. What it does:

- Without a key it opens the key page described above and waits for it; otherwise it asks nothing.
- It checks the key with one minimal request to Moonshot AI.
- It starts the kimi router: a small background process the plugin starts and repairs itself. Its hooks bring it back
  before the next prompt if it ever stops.
- It adds Kimi K3 and Kimi K2.6 to `/model` next to Sonnet and Opus, and points Claude Code at the router.
- Picking one of them in `/model` sends those requests through the router to Moonshot AI. Every `claude-*` model still goes
  to Anthropic untouched, also while the router restarts or updates itself.

The report leads with the outcome:

- `ready`: when this run changed something it ends with the restart line. Show it, because the current session keeps
  talking to Anthropic until Claude Code restarts, and Kimi K3 in `/model` and the kimi agents work from the next
  session.
- `not routed`: Claude Code's base URL is the user's own proxy, so nothing reaches the kimi router. Give the fix the
  line names.

If Claude ever can't connect: when part of the router fails, it passes Claude's requests straight to Anthropic, and
the session hooks take the base URL off a router that cannot come back. Removing `env.ANTHROPIC_BASE_URL` from
`~/.claude/settings.json` (or restoring `~/.claude/settings.json.kimi-backup`) always restores direct Anthropic access.

Uninstalling the plugin: run `/kimi:remove`, then `/plugin uninstall kimi-plugin-cc@muhmdraouf`. Uninstalled first, the
router cleans up after itself: it takes its entries out of `settings.json`, puts the agents' models back, retires
while the sessions that still use it are open, and removes its own files once they close.

`/kimi:remove` (`setup --remove`) undoes all of it: the agents go back to the models they had before setup (as the ledger
recorded them), the `/model` entries and the base URL go away, and the router retires: sessions already open keep
working through it until they close. A session-start hook re-applies the setup after a
plugin update overwrote it, falling back to Sonnet when the router is down or the key is gone.

If it exits 6, give the fixes above and stop here: set up no tool and run nothing else.

## 4. Each chosen tool

For each chosen tool, in the order omp, opencode, pi, run its check (`<tool>` is omp, opencode or pi)
with `timeout` 600000 (setup may wait up to 9 minutes for the key page):

```bash
sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js setup --engine-check <tool> --json
```

It runs the built-in setup again (already done, so nothing changes), then checks the tool as the user set it up:

- the binary on `PATH`;
- its version;
- a one-word smoke run on the tool's own setup and model (no Moonshot Kimi request goes through it).

Each tool runs on the user's own setup; the Moonshot Kimi model only watches its runs. Show the `engine` object's `binary`,
`version` and `smoke` lines. If it exits 6 (`ready` is false), give the fix for each failing line
and go on with the next tool:

- binary: install the tool so it is on `PATH` (omp is Oh My Pi).
- smoke failed: run <tool> once and log in or configure it; the plugin uses it as it is.

When it is ready, ask — always, even when a watcher was chosen before — one question, "Who should watch <tool> runs?",
header "Watcher", single choice, these two options in this order:

1. `Kimi K3 (Moonshot Kimi)`: the `kimi:<tool>` agent that hands work to the tool runs on Kimi K3 through the kimi
   router.
2. `Claude Sonnet`: the `kimi:<tool>` agent runs on Sonnet.

Mark the current choice by adding ` (current)` to its label: the first option when the report's `engine.watcher` is
`provider`, the second when it is `sonnet`, neither when it is null. Then run with the answer, `provider` for the first
option and `sonnet` for the second, and show its one line:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js setup --engine-enable <tool> --watcher provider
```

```bash
sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js setup --engine-enable <tool> --watcher sonnet
```

A tool that was enabled before (its `watcher` was not null in step 1) and was not chosen now stays enabled: this
command never disables an engine, so a quick answer can never take away a tool the user set up before. Say so in one
line for each such tool.

End with a short report: a title, then one bullet per part, the action first:

- the built-in setup (ready or not);
- each chosen tool (enabled with its watcher, or the line that failed).

From then on, when the user asks to use an enabled tool for a task ("use omp for this"), hand the
task to its `kimi:<tool>` agent: it runs the task as a kimi job on that tool and returns the review with the exact accept,
return and discard commands. You review and decide; the agent never accepts.
