---
description: Add omp (Oh My Pi) as a delegation engine for qwen jobs, run as you set it up, and choose who watches its runs
allowed-tools: Bash(sh:*)
---

Run with the Bash tool; it takes no arguments:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/dist/run" qwen.js setup --engine-check omp --json
```

The plugin does not set omp up and never changes it:

- omp runs exactly as the user set it up, on its own login, provider, default model and config.
- qwen jobs only hand it the task, watch it and verify the result.

This command does everything `/qwen:setup:claude` does (key, ping, router, `/model`, agents), then checks omp:

- the binary on `PATH`;
- its version;
- a one-word smoke run of omp on its own setup (no Alibaba Qwen request goes through it).

It changes nothing about the engine. Show the user the report: each setup line, then the `engine` object's `binary`,
`version` and `smoke` lines (the smoke line names the model omp says it ran on, when it names one, and omp's own
numbers). Write what you add yourself as a short title and bullet points, the action first.

If it exits 6 (`ready` is false), give the fix for each failing line and stop here. Do not ask anything and do not run
the second command:

- Alibaba Cloud key missing: setup opens a one-time page on 127.0.0.1 in the browser where the user pastes the key;
  setup checks it with one request and keeps it in the OS keystore. If it exits 6 asking to finish in the browser,
  show the printed URL and run this command again once the user is done. Never ask the user to paste the key into
  the chat, and never read or print a key file. Headless Linux without a keyring: set `QWEN_API_KEY` in the
  environment Claude Code starts from. The qwen key is for the watcher and the claude engine; omp never receives it.
- binary: install omp (Oh My Pi) so `omp` is on `PATH`.
- smoke failed: omp is not logged in or not configured. Tell the user to run `omp` once themselves and log in or
  configure it (provider, key, default model) the way they want it; the plugin uses it as it is, and this command
  then passes. Never configure omp for the user and never read its config files.

When it is ready, ask the user with AskUserQuestion — always, every time this command runs, even when a watcher was
chosen before; never skip the question as already answered. One question, "Who should watch omp runs?", header
"Watcher", single choice, these two options in this order:

1. `Qwen 3.8 Max (Alibaba Qwen)`: the `qwen:omp` agent that hands work to omp and watches it runs on Qwen 3.8 Max through the qwen
   router.
2. `Claude Sonnet`: the `qwen:omp` agent runs on Sonnet.

The watcher only writes the brief, waits for the job and reads the review; omp itself keeps running on its own model.
Mark the current choice by adding ` (current)` to its label: the first option when the report's `engine.watcher` is
`provider`, the second when it is `sonnet`, neither when it is null. Then run with the answer, `provider` for the
first option and `sonnet` for the second:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/dist/run" qwen.js setup --engine-enable omp --watcher provider
```

```bash
sh "${CLAUDE_PLUGIN_ROOT}/dist/run" qwen.js setup --engine-enable omp --watcher sonnet
```

Show its one line.

From then on, when the user asks to use omp for a task ("use omp for this"), or you want a second implementation by
another agent harness, hand the task to the `qwen:omp` agent. It:

1. turns the request into a brief;
2. runs it as a qwen job on omp (in the job's own worktree, as omp is set up);
3. waits for the verified result;
4. returns the review with the exact accept, return and discard commands.

You review and decide; the agent never accepts. Running this command again is how the user switches the watcher back
and forth; it never disables another engine.
