# qwen

[![ci](https://github.com/MuhmdRaouf/claude-code-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/MuhmdRaouf/claude-code-plugins/actions/workflows/ci.yml)
[![License: GPL v3+](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](../../LICENSE)

A [Claude Code](https://claude.com/claude-code) plugin that runs **Qwen** models on [Alibaba Cloud](https://www.alibabacloud.com/). It gives you:

- **Two native agents** for the work you would otherwise give a Sonnet subagent:
  - `qwen:qwen3.8-max` (Qwen 3.8 Max) implements, refactors, backfills tests and does bulk edits in the current repository.
  - `qwen:qwen3.8-flash` (Qwen 3.8 Flash) is the faster tier for the same work, read-only sweeps included.
  - They run on Qwen themselves, inside Claude Code, and show in the agents panel like any subagent.
- **Commands** to turn it on, watch it, account for it and turn it off:
  - `/qwen:setup` asks what to set up and turns the plugin on.
  - `/qwen:board` shows what is running on Alibaba Qwen right now.
  - `/qwen:usage` shows its tokens and estimated cost.
  - `/qwen:review` decides a finished job; `/qwen:remove` turns the plugin off again before you uninstall it.
- **A verified job loop on the CLI.** For changes that must pass gates, with automatic fix rounds and a verified
  landing, the plugin's CLI runs headless jobs in their own git worktrees and leaves the decision to Claude.

> Not affiliated with Alibaba Cloud or Anthropic. You need your own Alibaba Cloud API key, and Qwen usage is billed to it.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Setup](#setup)
- [Quick start](#quick-start)
- [The agents](#the-agents)
- [The qwen router](#the-qwen-router)
- [Commands](#commands)
- [The job loop (CLI)](#the-job-loop-cli)
- [Writing briefs](#writing-briefs)
- [Reviewing and deciding](#reviewing-and-deciding)
- [Running many jobs](#running-many-jobs)
- [Security and privacy](#security-and-privacy)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Requirements

- Claude Code, with the `claude` CLI on `PATH`. The plugin's setup ping and job workers run through `claude -p`.
- Bun ≥1.3 (default) or Node ≥22.
  - The plugin ships as bundled scripts (`plugin/dist/qwen.js` and its router) with no install step.
  - Every hook, command and agent starts them through `plugin/dist/run`. It uses `bun` when it is on `PATH` (or in
    `~/.bun/bin`) and falls back to `node`.
  - The router and the jobs run on whichever started them; `/qwen:setup` reports it on its `runtime` line.
- git, for edit jobs, which run in git worktrees.
- An API key for Alibaba Cloud with access to `qwen3.8-max` and `qwen3.8-flash`.

## Install

1. Install from the `muhmdraouf` marketplace
   ([MuhmdRaouf/claude-code-plugins](https://github.com/MuhmdRaouf/claude-code-plugins)), at user scope (available in
   every project):

   ```
   /plugin marketplace add MuhmdRaouf/claude-code-plugins
   /plugin install qwen-plugin-cc@muhmdraouf
   ```

2. Restart Claude Code after installing, so it loads the plugin's commands.
3. Run `/qwen:setup`.

Other ways to install:

- User scope is the default. From a terminal the same is
  `claude plugin marketplace add MuhmdRaouf/claude-code-plugins && claude plugin install qwen-plugin-cc@muhmdraouf --scope user`
  (`--scope project` or `local` enables it for one repository only).
- From a clone of the monorepo (for development), load the plugin directly:

  ```
  npm ci && npm run build -w plugins/qwen-plugin-cc
  claude --plugin-dir ./plugins/qwen-plugin-cc/plugin
  ```

## Setup

Turn the plugin on:

```
/qwen:setup
```

### API key

Setup takes the first key it finds, in this order:

1. `QWEN_API_KEY` in the environment (`DASHSCOPE_API_KEY` also works): used as it is.
2. A key already in the OS keystore.
3. Otherwise, a one-time key page in your browser.

#### The environment variable

- Set `QWEN_API_KEY` in the environment Claude Code starts from, such as your shell profile.
- Setup never copies it into the keystore.
- Use it on a headless Linux without a keyring.

#### The key page

- Setup prints a URL on `127.0.0.1` and opens it. The page links Alibaba Cloud's API-key page; paste the key and save.
- Setup checks the key with one request, stores it and goes on in the same run. It waits up to 9 minutes; if no key
  arrives, run `/qwen:setup` again.
- The page works once, only on this machine, and closes after a save, 10 minutes or 5 failed tries. The key never
  goes through the chat.
- A key the provider knows but holds back (a rate limit, or no balance left) is still saved, with a warning naming
  the top-up page. Setup keeps a stored key in that state and warns instead of asking for a new one.

#### Where the key is stored

- macOS: the Keychain.
- Linux: the Secret Service.
- Windows: DPAPI.
- A key in an older `~/.config/qwen-plugin-cc/env` file moves into the store the next time setup runs.

#### Changing or removing it

- A key Alibaba Cloud refuses: run `/qwen:setup` again. It opens the page for a new key.
- Another key: run `/qwen:remove`, then `/qwen:setup`.
- `/qwen:remove` takes the key out of the store, with the rest of the setup.

### What setup asks and does

`/qwen:setup` takes no arguments and always asks what to set up, every time:

1. **Built-in only (Claude Code agents and /model)** or **Built-in plus other tools (omp, opencode, pi)**.
2. With the second answer, which of those tools (each marked installed or not found).

`/qwen:setup:claude` is the built-in setup alone, with no questions. The built-in setup:

1. Checks the `claude` binary and version, the key (never its value), the state directory and the concurrency cap.
2. Sends one tiny request to `qwen3.8-flash` to prove the key works.
3. When everything answers, starts the qwen router (a small background process the plugin starts and repairs itself).
4. Adds Qwen 3.8 Max and Qwen 3.8 Flash to `/model` next to Sonnet and Opus.
5. Points Claude Code at the router, and moves the qwen agents onto the Qwen models.

### The report

The report starts with the outcome, one line:

- `ready`: the models are in `/model` and the agents run on them. When the run changed something, the last line says
  to restart Claude Code. Do that: the session you ran setup in keeps talking to Anthropic until it restarts, and
  Qwen 3.8 Max in `/model` and the qwen agents work from the next session.
- `not routed`: `ANTHROPIC_BASE_URL` in `settings.json` is your own proxy, so nothing reaches the qwen router and the
  agents run on Sonnet. Point that proxy at the router, or remove the entry and run setup again. Setup never
  overwrites a base URL that is yours.
- `not ready`: a `FAILED` line says which check failed and what to do.

Once routed:

- Picking a Qwen model sends its requests through the router to Alibaba Cloud.
- Every `claude-*` model still goes to Anthropic untouched.
- A session-start hook re-applies all of it after a plugin update, falling back to Sonnet when the router is down or
  the key is gone.

### Turning it off and uninstalling

1. Run `/qwen:remove`. It undoes the setup:
   - the agents go back to the models they had before setup;
   - the Qwen models leave `/model`;
   - the base URL is taken out of `settings.json`;
   - the router retires: sessions already open keep working through it, and it exits once they close (after 7 days
     at most);
   - the stored key is deleted.
2. Restart Claude Code.
3. Run `/plugin uninstall qwen-plugin-cc@muhmdraouf`.

Nothing is put on your `PATH`: the plugin's commands are the slash commands, and its CLI runs through the plugin's
launcher (see [Commands](#commands)).

## Quick start

1. Ask Claude in plain words:

   > Use qwen to migrate every `getUserById` call in `src/` to `findUser`, and keep the tests green.

2. Claude picks the agent for the job:
   - `qwen:qwen3.8-max` for the rename: it edits, runs the tests itself, and reports what changed;
   - `qwen:qwen3.8-flash` when you only asked which calls exist.
3. Watch both on `/qwen:board`; see what they cost on `/qwen:usage`.
4. When an agent finishes, a hook tells you which model it really ran on and what it cost.

For changes that must pass gates with automatic fix rounds and a verified landing, submit a job on the CLI instead
(`qwen run <brief.md> --bg`, see [The job loop (CLI)](#the-job-loop-cli)).

## The agents

| Agent | Model | Does |
|---|---|---|
| `qwen:qwen3.8-max` | Qwen 3.8 Max | implementation to a spec or pattern, refactors, renames, migrations, test backfills, bulk edits — the work you would give a Sonnet subagent, on Qwen instead |
| `qwen:qwen3.8-flash` | Qwen 3.8 Flash | the same work as `qwen:qwen3.8-max`, faster for simpler tasks, read-only sweeps included |

- Both ship on Sonnet and run there until `/qwen:setup` has pointed Claude Code at the qwen router (and whenever the
  router is down).
- Give each a self-contained task: what to change or examine, where (exact paths), the pattern to copy, and the
  commands that prove the result.
- `qwen:qwen3.8-max` works in the current repository, verifies with the project's own commands, and reports what changed;
  it never commits.
- `qwen:qwen3.8-flash` works in the current repository the same way, on simpler tasks. Neither invokes the plugin's CLI.
- When a change should stay out of your working tree until you review it, run `qwen:qwen3.8-max` with
  `isolation: "worktree"`.

When an agent stops, a `SubagentStop` hook reads the agent's own transcript and shows you one line: the model that
answered, its tokens and its estimated cost. If it ran on a Claude model, because the router was down or setup never
ran, the line says how to fix that.

## The qwen router

Claude Code sends every model request to one address, so the agents can only run on Qwen through a router.

### What it does

- `/qwen:setup` starts it as one small background process (the same on macOS, Linux and Windows, no service to install)
  and points Claude Code at it.
- `sh <plugin>/dist/run qwen-router.js status` checks it.
- A request whose model is served by this plugin goes to Alibaba Cloud with your qwen key, in place of your Anthropic
  credentials.
- Every other request goes to Anthropic unchanged, so the session and every Claude subagent behave as before.
- A model is this plugin's when it is one of the two catalog ids (an id set with `QWEN_MODEL_MAIN` or `QWEN_MODEL_FLASH`
  included) or starts with the provider's prefix. Every part of the router asks the same question.
- It listens on 127.0.0.1 only and refuses any other `Host`.
- It appends one line of metadata per request (model, route, status, latency, usage — never headers or bodies) to the
  radar spool under `~/.agents/radar/spool/`, which `board` and `usage` read back.
- A model another installed provider plugin serves is forwarded to its router unchanged, so several provider plugins
  can share the one base URL.

### It never cuts Claude off

- A front process owns the port and hands each request to a worker.
- A worker that crashes, hangs or grows too large is replaced at once.
- While workers keep failing, the front passes Claude's requests straight to Anthropic itself (only the qwen models
  answer 503, saying what to run).
- If the router cannot start at all, an emergency passthrough takes the port instead.
- Updates swap the worker without closing the port.
- Hooks before every prompt and every subagent bring a router that died back before the next request. When no router
  of this plugin can hold the port, they take the base URL out of `settings.json`.

### Key and balance errors

When Alibaba Cloud refuses the key, or the account is out of balance, the router answers in a way Claude Code can act on
instead of the raw error. Claude Code reads a 401 as its own Anthropic login failing and retries 429s and 5xx errors
for minutes, so on the qwen models only:

- a refused or missing key becomes a 400, not retried, saying `Alibaba Qwen key refused or missing: run /qwen:setup`;
- an account with no balance or quota becomes a 400, not retried, naming the page where you top up
  (https://usercenter2-intl.aliyun.com/billing).

Claude models are never touched. The key is never written to a log, a spool line or an error body: an upstream error
that quotes it is blanked out first.

### Recovery and uninstall

- **If Claude ever can't connect:** remove `env.ANTHROPIC_BASE_URL` from `~/.claude/settings.json` (or put back
  `~/.claude/settings.json.qwen-backup`, saved before the first change). That always restores direct Anthropic access.
- **Uninstalling the plugin:** run `/qwen:remove`, then `/plugin uninstall qwen-plugin-cc@muhmdraouf`.
- If you uninstall without removing first, the router still cleans up on its own: it notices the plugin is gone, takes
  its entries out of `settings.json`, puts the agents' models back and retires the same way, then removes its files
  and exits once the sessions from before have closed.
- Disabling the plugin does the same, and enabling it again re-applies the setup at the next session start.
- When jobs are waiting for review, a session-start hook prints one line about them.

## Commands

The slash commands run the plugin's bundled CLI and show its output as it is.

| Command | Does |
|---|---|
| `/qwen:setup` | always asks what to set up (built-in only, or also omp, opencode and pi), then runs it; the built-in part turns the plugin on: checks, router, the Qwen models in `/model`, agents on them |
| `/qwen:setup:claude` | the built-in setup alone, no questions |
| `/qwen:setup:omp`, `/qwen:setup:opencode`, `/qwen:setup:pi` | the built-in setup, then check that tool as you have set it up and enable it as a delegation engine; asks who watches its runs (Qwen 3.8 Max or Sonnet). The `qwen:omp`, `qwen:opencode` or `qwen:pi` agent then hands it tasks |
| `/qwen:remove` | turns the plugin off: agents back on their models before setup, Qwen out of `/model`, router retired (open sessions keep working, it exits when they close), stored key removed. Run it before `/plugin uninstall` |
| `/qwen:board` | what is running on Alibaba Qwen right now: one table of sessions, subagents and jobs, active first |
| `/qwen:usage` | Alibaba Qwen tokens and estimated cost (see below) |
| `/qwen:review [id]` | review a job that awaits a decision, then accept, return with feedback or discard it; with no id it picks from the jobs awaiting review |

### board

- Lists every session and subagent that answered on a Qwen model in the last two days (active means a request in the
  last minute), beside this repository's jobs.
- A running job can be stopped right from the board.
- Session and subagent rows are view-only.

### usage

- Leads with one estimated cost for today, the last 7 days and the last 30 days.
- Then shows how the 30 days split between agents and `/model` and jobs.
- Below that: a token table per model for each window (requests, input, output, cache read, cache write, estimated
  cost), the job ledger of this repository, and one row per delegation engine that ran jobs.
- Costs come from one price table. Each entry names the Alibaba Cloud pricing page it was read from and the day it was read,
  and the report prints that day. A model with no list price counts as $0 and is listed as such.
- The tokens are exact; the cost is an estimate, and your bill is Alibaba Cloud's.

omp, opencode and pi run as you have set them up, with their own login, provider and model:

- The plugin never configures them and never passes them a key.
- Their rows in `usage` show the numbers the tool itself reports, with the model it named in the MODEL column (`-`
  when it names none).
- They are left out of the estimated total.

### The CLI

The CLI behind the commands has more subcommands, the job loop of the next section.

- In this README `qwen <command>` stands for running the plugin's launcher on the bundled CLI:
  `sh "<plugin>/dist/run" qwen.js <command>`.
- `<plugin>` is the plugin's install directory (inside Claude Code, `${CLAUDE_PLUGIN_ROOT}`).
- The launcher uses `bun` when it is on `PATH` and `node` otherwise.

| Exit code | Meaning |
|---|---|
| 0 | ok |
| 1 | unexpected error |
| 2 | usage error |
| 3 | the job did not pass (`run --wait`, `wait`) |
| 4 | job not found |
| 5 | landing refused, nothing applied: a rebase conflict in code, the fresh-checkout verification of the exact commit failing, an uncommitted file the change set touches, or a job busy with another driver |
| 6 | not ready: `setup` failed, or the job has no live driver and needs `stop` or `discard` |
| 130 | a follower was interrupted; the job keeps running |

## The job loop (CLI)

Claude Code's own agents cover the common case, so the job loop has no slash commands of its own except `/qwen:board`
and `/qwen:review`. The CLI runs it end to end:

1. `qwen run <brief.md> --bg` submits a brief and starts a detached driver.
2. `qwen wait`, `qwen show`, `qwen board` follow it.
3. `qwen review`, `qwen accept`, `qwen return`, `qwen discard` decide it (`/qwen:review` does the same with questions).

```
brief ──▶ Qwen worker ──▶ plugin verifies ──▶ awaiting review ──▶ Claude: accept │ return(feedback) │ discard
              ▲            gates · scope ·                                              │
              │            report contract                                              │
              └─────────── auto-fix (same session) ◀── failed verdict    return ────────┘
```

### Roles

| Role | Who | Does |
|---|---|---|
| Orchestrator | Claude (your session) | decides what to delegate, writes or approves briefs |
| Worker | Qwen via headless Claude Code on Alibaba Cloud, or omp, opencode or pi (see [Engines](#engines)) | does the work inside the job's workspace |
| Verifier | the plugin (deterministic code) | runs the gates, checks scope and the report, derives a verdict |
| Reviewer | Claude | accepts, returns with feedback, or discards |

### Job lifecycle

```
queued ─▶ running ─▶ verifying ─▶ awaiting_review ─▶ accepted
   ▲                    │                │
   │                    └─ auto-fix ─────┤ (same Qwen session, while the fix budget lasts)
   └──────────── return(feedback) ◀──────┤
                                         └─▶ discarded
```

Every attempt ends in a **verdict**. The first matching row wins:

| Verdict | Meaning | What happens next |
|---|---|---|
| `stopped` | you stopped the job | review |
| `timeout` | the attempt hit its time limit | infra retry while budget lasts, then review |
| `quota` | the provider says the account has no balance or quota left | review at once, not retried; the next step names the top-up page |
| `worker_error` | Alibaba Cloud API error or the worker crashed | infra retry while budget lasts, then review |
| `scope_violation` | a changed path is outside `scope`, inside `forbid`, or an exec/readonly job changed the repository | auto-fix while budget lasts, then review |
| `report_invalid` | the structured report is missing or breaks its schema | auto-fix while budget lasts, then review |
| `gate_fail` | a gate exited non-zero or timed out | auto-fix while budget lasts, then review |
| `pass` | gates passed, in scope, valid report | review |

- Every job ends in `awaiting_review`, including failed ones, because only Claude decides.
- Auto-fix and return both resume the worker's own Qwen session, so it keeps its context.
- A reviewer's return gives the job a fresh fix budget.

### Modes

| Mode | Workspace | Worker may | Verification adds |
|---|---|---|---|
| `edit` | `git worktree` on branch `qwen/<id>` from `base` | change files inside `scope` | the change set against `scope`/`forbid` |
| `exec` | the repository itself | run commands; write only to `$QWEN_ARTIFACTS` | the repository must be byte-for-byte unchanged |
| `readonly` | the repository, plan mode | read only | the repository must be unchanged |

### Accepting a change

Workers never commit. `accept` lands the change as one commit on your current branch, verified exactly as it lands:

1. It commits the pending change on the job branch: title, report summary, and a `Worked-by: qwen3.8-max via qwen`
   trailer (`git config qwen.trailer none` omits it).
2. It rebases onto the branch tip if that moved since the job started.
3. It runs the brief's `regenerate` commands and amends their output into the commit.
4. It re-runs `setup` and every gate in a fresh detached checkout of that exact commit.
5. It fast-forwards your branch onto it, retrying up to three times if the tip moves again mid-verification.

- Your repository's commit hooks run (`--no-verify` skips them).
- `accept --no-commit` applies the change to the working tree instead.
- Nothing half-lands. Each of these leaves your repository untouched and exits 5: a conflict in code
  (`conflict in <paths>`), a gate failing in the fresh checkout, or a dirty file the change set touches. Return the
  job (or commit your edit first) and accept again.
- A successful accept leaves nothing behind: the job worktree, its branch and the temporary checkout are removed.

### Engines

A job runs on the `claude` engine (headless Claude Code on Alibaba Cloud) unless it asks for another:

- `qwen run --engine omp|opencode|pi`;
- an `engine:` line in the brief;
- a `defaultEngine` in `engines.json` in the state directory.

omp, opencode and pi must first be enabled with `/qwen:setup`, `/qwen:setup:omp`, `/qwen:setup:opencode` or
`/qwen:setup:pi`.

Those tools run as you have set them up, with their own login, provider, default model and configuration:

- The plugin never configures them, never reads their config files and never gives them a key.
- It starts the tool in the job's workspace with your own environment (minus the plugin's key and Claude Code's
  routing variables).
- It narrows what the job may touch, translates the tool's events, enforces the timeout and stops the whole process
  group when the job ends.
- Verification, review and landing are the same as for any other job.

Qwen 3.8 Max (or Sonnet, your choice at setup) only watches:

- The `qwen:omp`, `qwen:opencode` and `qwen:pi` agents write the brief, wait for the job and return the review.
- They never accept anything themselves.
- All five provider plugins offer all three tools. `usage` shows each tool's own numbers (see [Commands](#commands)).

### No daemon

- Each job is driven by its own process, double-forked so it is an orphan. Nothing that kills its caller's process
  tree, such as Claude Code cleaning up a background shell, can reach it.
- `run --wait` starts that driver and only follows the job. Killing the follower never stops the job, and
  `qwen wait <id>` re-attaches.
- A per-job lock makes sure only one driver ever owns a job.
- All state is plain files: jobs, attempts, stream logs, artifacts and worktrees live under the state directory.
- Every CLI start cleans up after interrupted runs: worktrees and branches of decided jobs that outlived their
  decision, and temporary accept checkouts nobody is holding, are removed. Only qwen's own directories and branch
  prefix are ever touched.

## Writing briefs

A brief is Markdown with YAML front matter.

- The body is the whole task, because Qwen sees only the brief plus a fixed contract footer.
- The footer covers the workspace rules, scope, the gates the plugin will run, and how to finish with the report.

```markdown
---
title: "slugify: real slugs"
mode: edit
model: qwen
scope: ["src/strings.js", "test/strings.test.js"]
forbid: ["package.json"]
gates: [npm test]
timeout: 15m
retries: { fix: 1, infra: 1 }
report: change
---
`slugify` in `src/strings.js` only lowercases. Make it produce URL slugs:
1. lowercase; 2. trim; 3. strip diacritics; 4. replace each run of characters other than `a-z0-9` with one `-`;
5. strip leading and trailing `-`.
Add node:test cases for `"  Hello, World!  "` -> `"hello-world"` and `"Crème Brûlée"` -> `"creme-brulee"`.
Done when `npm test` passes.
```

| Field | Default | Meaning |
|---|---|---|
| `title` | required | short name shown on the board and in commit messages |
| `mode` | `edit` | `edit`, `exec` or `readonly` (see [Modes](#modes)) |
| `engine` | `claude` | `claude`, `omp`, `opencode` or `pi`; a tool must be enabled first (see [Engines](#engines)) |
| `model` | `qwen` for edit, else `flash` | `qwen` = qwen3.8-max, `flash` = qwen3.8-flash |
| `effort` | unset | `low` / `high` / `max`, passed to `claude --effort` |
| `cwd` | current git root | repository the job works on |
| `base` | `HEAD` | ref the worktree starts from |
| `scope` | `["**"]` for edit, `[]` otherwise | globs the change set may touch (picomatch, dotfiles included) |
| `forbid` | `[]` | globs that must stay untouched even inside scope |
| `gates` | `[]` | commands the plugin runs after the worker: a string, or `{ run, timeout }` (default 10m) |
| `setup` | `[]` | commands run in order before the gates in every checkout qwen verifies in, again at accept; a failing setup fails verification naming the command |
| `regenerate` | `[]` | generated files qwen recreates instead of merging as text: `[{ paths: [globs], run: command }]` |
| `timeout` | `2h` | per attempt: `90s`, `15m`, `1h30m`, or milliseconds |
| `retries` | `{ fix: 1, infra: 2 }` | auto-fix rounds after a failed verdict; re-runs after infrastructure errors |
| `report` | `change` / `sweep` / `notes` by mode | a built-in report schema, or a path to a JSON Schema file (draft-07) |
| `addDirs` | `[]` | extra readable paths, passed as `--add-dir` |
| `env` | `[]` | names of your environment variables to pass to the worker and gates, `CLAUDE_*` settings included (values are never stored; denied names are dropped, see [Security and privacy](#security-and-privacy)) |
| `budgetUsd` | unset | spending cap per attempt, passed as `--max-budget-usd` |
| `priority` | `high` from `run`, `normal` from `batch` | `high` or `normal`: which queued job takes the next free slot |
| `tags` | `[]` | free labels for batches and board filters |

Built-in reports:

- `change`: `{ summary, files: [{path, why}], root_cause?, tests_added[], open_items[] }`
- `sweep`: `{ summary, items: [{id, status: ok|fail|gap, detail}], open_items[] }`
- `notes`: `{ summary, findings: [{title, detail, refs[]}], open_items[] }`

What makes a brief work:

- **Gates prove the behaviour.** A gate that passes without the change proves nothing. Write or name the test first,
  then delegate the bulk.
- **Narrow scope.** Use the narrowest globs that cover the change, tests included. Forbid lockfiles, CI config and
  generated files.
- **Generated files go in `regenerate`.** Lockfiles, snapshots and codegen output are recreated by their command at
  accept instead of merged as text, so a conflict in them never blocks landing.
- **Self-contained body.** Give exact paths, a `file:line` example of the pattern to follow, numbered steps, and
  "done when" criteria.
- **Keep the judgment calls.** Design, unclear requirements, unknown root causes, security-sensitive code and anything
  that needs secrets stay with Claude.

Tools:

- `qwen brief new <title> --mode edit` prints the path of a fully commented template.
- `qwen brief lint <path>` checks a brief exactly the way `run` will.

## Reviewing and deciding

`qwen review <id>` shows:

- the verdict and every attempt;
- each gate's exit code and output tail;
- the scope check;
- the report;
- with `--diff`, the full diff.

The review checklist:

1. Read the diff itself, not just the report or the gate results.
2. Check that the tests assert the behaviour. Watch for snapshots of whatever came out, and for weakened or skipped
   assertions.
3. Re-run a gate yourself for risky changes.
4. Reject scope creep: unrelated edits, reformatting, new dependencies.
5. Look for secrets and debug leftovers in the diff and in the artifacts.

Returning feedback:

- Write one numbered item per problem: `file:line`, what is wrong, and what correct looks like.
- If the same problem survives two returns, fix the brief or do the work directly.

## Running many jobs

All jobs, and anything else using your key, share one Alibaba Cloud rate limit. The plugin caps how many workers run at once
with a file-based semaphore, and adapts the cap from live 429 responses:

- Three rate-limit events in 60 s (or one that ends an attempt) lower the cap to 75%, at most once a minute.
- A quiet minute adds one back while a job waits for a slot.
- Bounds are `[1, QWEN_MAX_CONCURRENCY]` (default 16). `run` and `batch` persist the ceiling, and the cap itself
  persists in `limiter.json` between runs.

How to run many jobs:

- Submit a batch once: `qwen batch 'briefs/*.md'`. Don't resubmit queued jobs.
- Follow many jobs with one waiter, not one per job: `qwen batch <dir> --wait` or `qwen wait <id> <id>…` prints one
  line per job as it lands, then a totals line.
- Read `qwen review <id> --summary` first; open the `--diff` only for jobs that need it.
- Use `qwen:qwen3.8-flash` for sweeps (`--flash` for a job); it is cheaper and faster.
- Watch `qwen usage`. Frequent 429 retries mean fewer jobs at once would finish sooner.
- Review jobs as they land; don't let `awaiting_review` pile up.

## Security and privacy

- **Your key stays out of everything else.**
  - It is read from `QWEN_API_KEY`, the OS secret store, or a 0600 key file.
  - It is never printed or logged, never passed on a command line, and never written to job state.
  - It is set only in the worker process's environment.
- **Workers get an allowlisted environment.**
  - That is `PATH`, `HOME`, locale and terminal variables, the `CLAUDE_*` settings your session started with (so
    `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40` reaches every worker), and the variable names a brief lists in `env`.
  - A short documented denylist never passes through, from your session or from a brief: `CLAUDE_*` credentials (a
    `TOKEN`, `KEY` or `SECRET` name segment — `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is a size, not a credential, and
    passes), variables that would route the worker away from Alibaba Cloud (`CLAUDE_CODE_USE_BEDROCK`,
    `CLAUDE_CODE_USE_VERTEX`, …), the orchestrator's plugin and project context, and its session and IDE markers.
  - What qwen owns (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) is also denied, and qwen's values
    always win.
  - Nothing else from your session leaks in, including your Anthropic credentials. Tests enforce this.
- **Engines get your environment, not the plugin's key.**
  - omp, opencode and pi start with the environment you would give them yourself, minus the plugin's own key and
    settings and Claude Code's routing and session variables, so they find their own login.
  - A brief's `env` names are added, except names the tool owns.
- **Your Claude Code login is untouched.** Workers run with their own `CLAUDE_CONFIG_DIR` under the state directory,
  so their settings, sessions and memory never mix with yours.
- **Edit jobs run in separate worktrees, and workers never commit.** Exec and readonly jobs must leave the repository
  unchanged, or they fail verification.
- **Workers can run commands.** They do so inside their workspace with `bypassPermissions` (edit and exec modes),
  like any autonomous coding agent. Only delegate repositories and tasks you would let an agent run unattended.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `QWEN_API_KEY` | from the OS secret store | Alibaba Cloud API key |
| `QWEN_MAX_CONCURRENCY` | `16` | upper bound for concurrent workers |
| `QWEN_STATE_DIR` | see below | where jobs, worktrees and logs live |
| `QWEN_CLAUDE_BIN` | `claude` | the Claude Code binary workers run |
| `QWEN_OMP_BIN`, `QWEN_OPENCODE_BIN`, `QWEN_PI_BIN` | the tool on `PATH` | the binary of a delegation tool that is not on `PATH` |
| `QWEN_MODEL_MAIN`, `QWEN_MODEL_FLASH` | the catalog ids | use another model id for the main or the flash model |
| `QWEN_BASE_URL` | the provider's endpoint | use another Anthropic-compatible endpoint |
| `QWEN_ROUTER_PORT` | the plugin's port | move the router to another port |

The state directory is the first of these that applies, created with mode 0700:

1. `QWEN_STATE_DIR`, when set;
2. the plugin's own Claude Code data directory;
3. `~/.agents/qwen` — an older `~/.local/state/qwen` moves over on the first start.

## Troubleshooting

- **`setup` says no key.** Run `/qwen:setup` again and paste the key on the page it opens, or export `QWEN_API_KEY`
  in the shell Claude Code starts from.
- **The agents run on Sonnet.** The router is down or the key is gone, so setup's fallback holds. Run `/qwen:setup`
  again; its report says which check failed. If the report says `not routed`, `ANTHROPIC_BASE_URL` is your own proxy.
- **Qwen 3.8 Max is not in `/model`, or the agents still run on Sonnet right after setup.** Restart Claude Code. The session
  that ran setup keeps using Anthropic until it restarts.
- **A Qwen request fails with "key refused or missing: run /qwen:setup".** Alibaba Cloud refused the key, or there is none. Run
  `/qwen:setup` and paste a working key. Claude models are not affected.
- **A Qwen request fails naming a top-up page.** The Alibaba Cloud account is out of balance or quota.
  - Top up at https://usercenter2-intl.aliyun.com/billing, then retry; the router does not retry it for you.
  - A job that ran into it ends with verdict `quota` and is not retried either: top up, then return it from
    `/qwen:review`.
- **`setup:omp`, `setup:opencode` or `setup:pi` fails on the smoke line.** The tool is not logged in or configured.
  Run it once yourself and set up its provider and model the way you want; the plugin uses it as it is, and the
  command then passes.
- **Lots of 429s, or jobs stay queued.** The shared rate limit is saturated. Lower `QWEN_MAX_CONCURRENCY` or submit
  fewer jobs at once; the limiter adapts on its own.
- **A job shows `running (stale)`.** Its driver process is gone, after a reboot or a killed process. Run
  `qwen stop <id>` to move it to review, or `qwen discard <id>`; `/qwen:board` offers the stop for you.
- **`accept` exits 5.** Nothing was applied.
  - On a conflict with your current branch, discard the job and run the brief again on that branch (the worker never
    commits or switches branches, so it cannot rebase), or merge the job's branch by hand.
  - When uncommitted files overlap the change, commit or stash them and accept again.
- **A commit hook rejects `accept`.** The job stays in review with the hook's output. Fix the issue (or return the
  job), or use `--no-verify`.

## Development

1. From the repository root, `npm ci` installs every workspace.
2. Then, in `plugins/qwen-plugin-cc` (and likewise in `packages/core`, which has no bundle):

   ```sh
   npm run check    # typecheck, biome, tests with coverage gates, no it.todo left, bundle is fresh
   npm run build    # rebuild plugin/dist/qwen.js and the launcher plugin/dist/run (committed, so installs need no build step)
   npm run test:bun # the bundle end-to-end tests again with the CLI and the bundles on bun (TEST_RUNTIME=bun; part of check)
   ```

From the repository root:

- `npm run check` runs every workspace's checks, and first `npm run check:siblings`, which fails when one of the five
  provider plugins drifts from the others (see [Development](../../README.md#development) in the repository README).
- `npm run mutate -w packages/core` runs Stryker mutation testing on the engine's `src/domain` (break threshold 90%).

Development needs Node ≥22 (npm, Vitest, esbuild) and Bun ≥1.3 on `PATH` for the bun leg. In `packages/core`,
`npm run test:bun` runs the router chaos suite with every router process on bun, and `check` runs it after the node
leg.

### Code layout

The code is TypeScript in strict mode, built as a functional core with an imperative shell. The engine lives in
`packages/core` (`@muhmdraouf/core`), which the bundle includes. Its main parts:

- `src/domain/`: pure logic, with no I/O. Briefs, the lifecycle state machine, verification, prompts, worker events,
  the AIMD limiter and the report schemas.
- `src/ports/`: interfaces for the worker, git, gates, store, clock and process control.
- `src/adapters/`: git CLI, shell gates, process streaming, the file store with locks and slots, and the engines.
- `src/app/`: use cases (submit, drive, accept, return, discard, stop, queries, batch, activity).
- `src/router/`: the router and its supervision.
- `src/render/` and `src/cli/`: output and the command line.

qwen itself is only its data and assets: the `Provider` value (`src/provider.ts`), thin composition roots for the CLI
and the router, and the plugin's commands, agents and hooks.

### Tests

- Tests run with Vitest and need no network and no key.
- The engine's own suites live in `packages/core`, including real git repositories, the router chaos suite and a fake
  `claude` binary.
- Each plugin's tests check its provider data, the plugin surface every provider plugin shares (commands, agents,
  hooks) and its built bundle, with a bundle smoke test and a fresh-install test on Node and on Bun.
- See [ARCHITECTURE.md](../../packages/core/ARCHITECTURE.md) for the design in depth.

## License

[GPL-3.0-or-later](../../LICENSE). Copyright (C) 2026 Raouf.
