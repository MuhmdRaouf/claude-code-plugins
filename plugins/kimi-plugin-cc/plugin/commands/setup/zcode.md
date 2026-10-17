---
description: Add zcode as a delegation engine for kimi jobs, run as you set it up, and choose who watches its runs
allowed-tools: Bash(sh:*)
---

Run with the Bash tool, with `timeout` 600000 (setup may wait up to 9 minutes for the key page); it takes no
arguments:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js setup --engine-check zcode --json
```

The plugin does not set zcode up and never changes it:

Install the ZCode app and configure its CLI login first. The CLI can require its own login even when the desktop app is signed in. JavaScript bundles need Node on PATH when the plugin runs under Bun.

- zcode runs exactly as the user set it up, on its own login, provider, default model and config.
- kimi jobs only hand it the task, watch it and verify the result.

This command does everything `/kimi:setup:claude` does (key, ping, router, `/model`, agents), then checks zcode:

- the CLI from the provider’s `<PREFIX>_ZCODE_BIN` override, `ZCODE_CLI`, `PATH`, or the installed ZCode app bundle;
- its version;
- a one-word smoke run of zcode on its own setup (no Moonshot Kimi request goes through it).

It changes nothing about the engine. Show the user the report: each setup line, then the `engine` object's `binary`,
`version` and `smoke` lines (the smoke line names the model zcode says it ran on, when it names one, and zcode's own
numbers). Write what you add yourself as a short title and bullet points, the action first.

If it exits 6 (`ready` is false), give the fix for each failing line and stop here. Do not ask anything and do not run
the second command:

- Moonshot AI key missing: setup prints a URL and opens a one-time key page on 127.0.0.1 in the browser. The user
  saves the key there; setup checks it, keeps it in the OS keystore and continues by itself in the same run.
  If it exits 6 asking to finish in the browser (no key within 9 minutes, or the page ended), show the printed URL
  and run this command again once the user is done. Never ask for the key in the chat, and never read or print a
  key file. Headless Linux without a keyring: set `KIMI_API_KEY` in the environment
  Claude Code starts from. The kimi key is for the watcher and the claude engine; zcode never receives it.
- binary: install zcode so `zcode` is on `PATH`.
- smoke failed: zcode is not logged in or not configured. Tell the user to run `zcode` once themselves and log in or
  configure it (provider, key, default model) the way they want it; the plugin uses it as it is, and this command
  then passes. Never configure zcode for the user and never read its config files.

When it is ready, ask the user with AskUserQuestion — always, every time this command runs, even when a watcher was
chosen before; never skip the question as already answered. One question, "Who should watch zcode runs?", header
"Watcher", single choice, these two options in this order:

1. `Kimi K3 (Moonshot Kimi)`: the `kimi:zcode` agent that hands work to zcode and watches it runs on Kimi K3 through the kimi
   router.
2. `Claude Sonnet`: the `kimi:zcode` agent runs on Sonnet.

The watcher only writes the brief, waits for the job and reads the review; zcode itself keeps running on its own model.
Mark the current choice by adding ` (current)` to its label: the first option when the report's `engine.watcher` is
`provider`, the second when it is `sonnet`, neither when it is null. Then run with the answer, `provider` for the
first option and `sonnet` for the second:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js setup --engine-enable zcode --watcher provider
```

```bash
sh "${CLAUDE_PLUGIN_ROOT}/dist/run" kimi.js setup --engine-enable zcode --watcher sonnet
```

Show its one line.

From then on, when the user asks to use zcode for a task ("use zcode for this"), or you want a second implementation by
another agent harness, hand the task to the `kimi:zcode` agent. It:

1. turns the request into a brief;
2. runs it as a kimi job on zcode (in the job's own worktree, as zcode is set up);
3. waits for the verified result;
4. returns the review with the exact accept, return and discard commands.

You review and decide; the agent never accepts. Running this command again is how the user switches the watcher back
and forth; it never disables another engine.
