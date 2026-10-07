# The job engine: architecture

This is the engine every provider plugin shares (`@muhmdraouf/core`, private, never published).

- The examples use the zai plugin (GLM on Z.ai).
- kimi, deepseek, minimax and qwen are the same engine with their own provider data, key and model ids.
- `<p>` below stands for the plugin's name (`zai`, `kimi`, …).

## What it is for

- A model does bulk mechanical work.
- Claude orchestrates, verifies the evidence, reviews, and either accepts the work or sends it back with feedback.
- The plugin is the machinery between them, and it is deliberately boring:
  - deterministic verification;
  - explicit state;
  - no trust in what a worker says about itself.

## Roles

| Role | Who | Nature |
|---|---|---|
| Orchestrator | Claude (main session) | decides what to delegate, writes/approves briefs, dispatches batches |
| Agent | `zai:glm-5.3` / `zai:glm-5.3-flash` subagents (GLM, via the router) | does the work itself in the current repository — edits and verification, or read-only sweeps |
| Worker | GLM via headless Claude Code (`claude -p` against Z.ai), or omp, opencode or pi as the user set them up | does the work in an isolated workspace, ends with a structured report |
| Verifier | this plugin, deterministic code | runs the brief's gates itself, checks the diff against scope/forbid, validates the report |
| Reviewer | Claude | reads the review packet (`/<p>:review` walks through it), then `accept`, `return` (with feedback) or `discard` |

- Verification is mechanical; review is judgment.
- The plugin never decides acceptance.
- Claude never has to take a worker's "done" on faith.

## The loop

```
 brief ──submit──▶ queued ──slot──▶ running ──worker exits──▶ verifying ──▶ awaiting_review ──accept──▶ accepted
                                     ▲                          │  verdict≠pass and                │
                                     │                          │  fix budget left                  ├─return(feedback)─┐
                                     └──── auto-fix attempt ◀───┘                                   │                  │
                                     └──── review-fix attempt (same GLM session, feedback) ◀────────┼──────────────────┘
                                                                                                    └─discard──▶ discarded
```

- A job always lands in `awaiting_review` with a **verdict**: pass, gate_fail, scope_violation, report_invalid,
  worker_error, quota, timeout, stopped.
- Failures are reviewed too, because only Claude decides whether to return or discard.
- `stop` moves a running job to `awaiting_review` with verdict `stopped`.
- `quota` is an attempt the provider refused because the account is out of balance or quota
  (`domain/provider-balance.ts` knows each provider's answer):
  - it goes straight to review, without an infra retry and without lowering the concurrency cap;
  - its next step names the provider's top-up page (`Provider.billingUrl`).

## Brief (unit of work)

Markdown with YAML front matter; the body is the task. Parsed with `yaml`, validated with `zod` into `Brief`.

| Field | Default | Meaning |
|---|---|---|
| `title` | required | short name |
| `model` | `glm` for edit, `flash` otherwise | `glm` = glm-5.3, `flash` = glm-5.3-flash (a provider names its tiers; kimi's are `kimi` and `flash`) |
| `engine` | `claude` | `claude`, `omp`, `opencode` or `pi`; chosen by `run --engine`, else this field, else `defaultEngine` in `<state>/engines.json`, else `claude`; a tool must have been enabled by its setup command |
| `effort` | unset | `low`/`high`/`max` → `claude --effort` |
| `mode` | `edit` | `edit`: git worktree + branch `zai/<id>`, worker may change files; `exec`: may run commands, must not change the repo (artifacts dir only); `readonly`: plan mode, read tools only |
| `cwd` | current git root | repository the job works on |
| `base` | `HEAD` | ref the worktree starts from |
| `scope` | `["**"]` for edit, `[]` otherwise | globs the change set may touch |
| `forbid` | `[]` | globs that must stay untouched even inside scope |
| `gates` | `[]` | shell commands the **plugin** runs in the workspace after the worker; string or `{run, timeout}` |
| `setup` | `[]` | commands run in order before the gates in every checkout the plugin verifies in — after each attempt and again at accept; a failure fails verification naming the command |
| `regenerate` | `[]` | generated files recreated instead of merged: `[{paths: [globs], run: command}]`; at accept each `run` executes in the job worktree and its changes are amended into the commit |
| `timeout` | `2h` | per attempt |
| `retries` | `{fix: 1, infra: 2}` | auto-fix rounds after a failed verdict; re-runs after infrastructure errors |
| `report` | `change` (edit), `sweep` (exec), `notes` (readonly) | built-in schema name or a JSON-schema file; enforced via `--json-schema` |
| `addDirs` | `[]` | extra readable paths → `--add-dir` |
| `env` | `[]` | names of orchestrator env vars passed to worker and gates, `CLAUDE_*` settings included (values never stored; denied `CLAUDE_*`, `ANTHROPIC_*`, `API_TIMEOUT_MS` and the provider's key variables are dropped) |
| `budgetUsd` | unset | → `--max-budget-usd` |
| `tags` | `[]` | free labels (batch grouping, board filter) |

- The plugin appends a fixed contract footer to every prompt: workspace rules, scope/forbid, the gates it will run, no
  commits, no secrets, end with the report.
- Prompts are pure functions of brief + attempt history (snapshot-tested).

## Job, attempts, verdict

A `Job` holds:

- the immutable brief;
- the workspace (repo root, base sha, worktree path, branch);
- state;
- `attempts[]`.

Each `Attempt` holds:

- number and kind (`initial`/`auto_fix`/`review_fix`/`infra_retry`);
- prompt and GLM session id;
- worker outcome (`completed`/`api_error`/`timeout`/`crashed`/`stopped`, with error text);
- usage (turns, tokens in/out/cache, cost, 429 retries) and the structured report;
- verification (`gates[]` with exit code/duration/output tail, `changes` with added/modified/deleted/untracked paths,
  out-of-scope and forbidden paths, report validity) and the derived verdict.

Fix attempts resume the same GLM session (`--resume <session>`) so context carries over. If the session cannot be
resumed, the prompt is rebuilt self-contained.

## Workspace

### `edit`

- Workspace: `git worktree add -b zai/<id> <state>/worktrees/<id> <baseSha>`.
- Change set: `git diff --name-status <baseSha>` plus untracked files (the worker never commits).
- `accept --no-commit` applies the change set to the working tree.

Commit mode holds the job's lock throughout and lands the change as one verified commit:

1. Commit the pending change on the job branch: message from title + report summary; trailer
   `Worked-by: <model> via <p>`, omitted when `git config <product>.trailer` is `none`.
2. If the branch tip moved past the job's base, rebase the job branch onto it inside the job worktree:
   - a conflict inside `regenerate` paths takes the tip's side and carries on;
   - any other conflict aborts the rebase, changes nothing, and fails with `land_conflict` (exit 5) listing the files.
3. Run every `regenerate` command in the job worktree, amending what changes into the job's last commit.
4. Verify the exact commit in a fresh detached checkout (`git worktree add --detach` under `<state>/checkouts/<id>`):
   `setup`, then every gate.
   - A failure lands nothing: verdict-shaped error `land_verify_failed` (exit 5) with the failing command and output
     tail.
   - The checkout is always removed.
5. `git merge --ff-only <sha>` in the user's checkout, only if the tip is unchanged and no uncommitted or staged user
   file overlaps the change set (otherwise `dirty`, exit 5). A tip that moved meanwhile restarts at step 2, at most
   three times.

Cleanup:

- On success the job worktree and branch are removed too.
- Every CLI start also cleans up leftover worktrees and branches of decided jobs, and temporary checkouts of
  interrupted accepts.
- It matches only the plugin's own directories and branch prefix, then runs `git worktree prune`.

### `exec`

- The worker runs in the repository with `bypassPermissions`.
- Verification requires the repository to be unchanged (`git status --porcelain` identical before/after).
- Outputs go to `<state>/jobs/<id>/artifacts/` (`$ZAI_ARTIFACTS`).

### `readonly`

- `--permission-mode plan`.
- The same unchanged-repository check.

## Worker runtime (Z.ai)

The command, with the prompt on stdin, in a detached process group:

`claude -p --output-format stream-json --verbose --include-partial-messages --model <model> --json-schema <schema>
--session-id|--resume <id> [--effort] [--add-dir…] [--max-budget-usd]`

The environment is layered, later layers winning:

1. An **allowlist**: PATH, HOME, LANG, TERM, SHELL, TMPDIR, USER.
2. The orchestrator's other `CLAUDE*` settings minus `CLAUDE_ENV_DENYLIST`, one exported list in claude-headless.ts:
   - zai's own `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`;
   - credential-shaped names, with a `TOKEN`/`KEY`/`SECRET` segment (so `CLAUDE_CODE_MAX_OUTPUT_TOKENS` passes);
   - Bedrock/Vertex routing;
   - plugin and project context;
   - session and IDE markers.
3. Brief `env` names: the same denylist, plus `ANTHROPIC_*`, `API_TIMEOUT_MS` and `ZAI_API_KEY` reserved.
4. zai's own values:
   - `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` and `ANTHROPIC_AUTH_TOKEN=<key>`;
   - alias mapping: `ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.3`, `…_OPUS_MODEL=glm-5.3`, `…_HAIKU_MODEL=glm-5.3-flash`.
     A main job runs on the alias `sonnet` because a raw id logs `unrecognized_model`; a flash job runs on its own id
     because plan mode resolves `haiku` to sonnet;
   - `API_TIMEOUT_MS=3000000` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`;
   - an isolated `CLAUDE_CONFIG_DIR=<state>/claude-home`.

What stays out:

- zai defaults no `CLAUDE_*` setting: what the orchestrator did not set stays unset.
- Nothing else from its environment leaks in (verified by test).
- The key comes from `ZAI_API_KEY`, the OS secret store, or `~/.config/zai-plugin-cc/env` (must be mode 0600). It
  exists only in the child's environment.

Stream facts the parser relies on (captured live, `packages/core/test/fixtures/stream/`):

- `system/init` carries `session_id`, `model`, `apiKeySource`.
- `system/api_retry` carries `attempt`, `max_retries`, `error_status` (429 = rate limit, Z.ai code 1302).
- `result` carries `is_error` **independently of `subtype`** (`subtype: "success"` with `is_error: true` happens).
- `result` also carries the `result` text, `structured_output`, `usage`, `total_cost_usd`, `num_turns`.

## Delegation engines (omp, opencode, pi)

The worker is behind a port (`ports/worker.ts`), so the tool that runs the model is swappable. Besides `claude`, a job
can run on omp, opencode or pi. Every provider plugin offers all three the same way.

- **They run as the user set them up.** Their own login, provider, default model, extensions and config decide what
  runs. The plugin names no model, provider, endpoint or key, never writes their configuration and never reads it. It
  adds only the job's access (for example edit and bash permissions, or plan mode for a read-only job).
- **Their environment is the user's own**, minus the plugin's key and `<PREFIX>_` variables and Claude Code's routing
  and session variables (which can point at a plugin router). A brief's `env` names are added except the names the
  tool owns.
- **Their numbers are their own.** The model a tool says it ran on and its token counts are reported back as the tool
  gives them. `/<p>:usage` shows them in the engines section with a MODEL column (`-` when the tool names none) and
  leaves them out of the estimated total, which prices only the claude engine.
- **Each is a bridge.**
  - omp and pi are driven over their RPC protocol; a 60 s first handshake before an attempt counts as an
    infrastructure failure.
  - opencode runs one `opencode run --format json` per attempt, and its exit is the turn boundary.
  - None has a native report schema, so the report rides in the final assistant text and is checked in the adapter
    and again in core.
  - Events from every engine become the same worker events, so drive, gates, review and decisions do not know which
    engine ran.
- **Reaping.** While an engine runs, its process-group leader's pid sits in `<job>/engine.pid`. `stop`, `discard` and
  the cleanup every command runs for dead drivers end that group, so an engine process never outlives its job
  (opencode leaves a server child behind, so the rest of its group is reaped after the run).

Setup, with `/<p>:setup:omp` (and `:opencode`, `:pi`):

1. It checks the binary, its version and a one-word smoke run on the tool's own setup.
2. It asks who watches its runs: the provider's main model through the router, or Claude Sonnet.
3. It keeps the answer and the enabled tools in `<state>/engines.json`, beside an optional `defaultEngine`.

The watcher is the `<p>:omp` (`:opencode`, `:pi`) agent: it writes the brief, waits for the job and returns the
review. It never accepts.

## Concurrency and rate limits

One Z.ai account budget is shared by every job (and anything else using the key).

- Jobs run as independent driver processes.
- A file-based semaphore caps concurrent workers: `<state>/slots/`, atomic `wx` create under one mutex, stale-pid
  reclaim.
- A job waiting for a slot leaves a ticket, so a freed slot goes to the oldest live ticket of the higher priority
  (`high` from `run`, `normal` from `batch`). A dead waiter's ticket is reclaimed like a dead holder's slot.
- The cap is AIMD-controlled from live `api_retry` 429 events:
  - three rate-limit events in 60 s (or one that ends an attempt) decrease it to 75% with a cooldown;
  - a quiet minute adds one back while a job waits;
  - bounds are `[1, ZAI_MAX_CONCURRENCY]` (default 16; `run` and `batch` persist the ceiling).

## Budgets and router health (with the Observatory)

Both light up only when the Observatory plugin is there; without it nothing changes.

Budgets (`domain/budget.ts`, `router/budget.ts`):

- The router reads `<observatory>/budget-status.json` (`$OBSERVATORY_HOME`, else `~/.local/state/observatory`) at
  most every 5 s.
- While it lists `provider:<p>` or `total` as stopped, the router answers the provider's models with the key refusal's
  non-retryable 400 ("<Display> budget reached for this <period>: …"). The period comes from `budgets.json`.
- A missing, unparsable, oversized, non-regular or stale (over 10 minutes) file stops nothing.
- `claude-*` is never read against it.

Router health:

- Routers append health lines to the spool: `{"kind":"router.event","plugin","event","reason","model","ts"}`, epoch
  ms.
- The events:
  - `fallback`: every request the front or the emergency passthrough served itself;
  - `refusal`: no key, a refused key, no balance, a stopped budget;
  - `rate_limited`: a provider 429;
  - `budget_stop`: a scope newly turning the models off;
  - `restart`: a worker the front replaced.
- Metadata only: never the key, a header or a body.
- `/<p>:usage` counts the last 24 hours of them.

The model advisor (`app/advisor.ts`) in `/<p>:usage`:

- It prices the main-model runs that looked light on the flash model too. Light means a job not in edit mode, or at
  most 10 turns and 4000 output tokens; for a subagent, at most 10 requests and 4000 output tokens.
- It shows only with 10 runs, 3 light ones and a saving of a cent or more.
- It suggests; it changes nothing.

## Execution model

No daemon. Every job is driven by a detached `zai drive <id>` process (own process group).

- `zai run --bg`, `zai batch` and `zai run --wait` all spawn one.
- It is started by a double fork: a `bun -e` or `node -e` launcher, on the runtime the CLI runs on, spawns it
  detached, prints its pid and exits.
- The driver is reparented to PID 1, so no tree-kill of the caller reaches it or its worker (Claude Code cleaning up a
  background shell: SIGTERM, then SIGKILL, to every descendant).
- Per-job lock files prevent two drivers on one job.

Following a job:

- `--wait` follows the job like `zai wait <id>`: it polls the store (1 s doubling to 5 s) until the job lands and
  prints the summary.
- A follower never drives or stops anything. Killing it (SIGKILL, or SIGINT/SIGTERM, which print how to re-attach)
  leaves the job running; `wait <id>` re-attaches.
- A running/verifying job without a live driver, or a queued one nobody claims for 30 s, is stale: the follower says
  so and exits 6.

The dispatcher subagent:

1. It runs `zai run --wait` with Bash `run_in_background` and ends its turn.
2. Claude Code resumes it on completion (the subagent emits an interim result, then a final notification), and it
   returns the packet.
3. If the command died, it runs `zai wait <id>`, never `run` again.

## Code structure (functional core, imperative shell)

esbuild bundles core into each plugin's `dist/<p>.js` (and the router, ensure and passthrough scripts), so the
installed plugin needs nothing else.

```
packages/core/src/
  domain/     pure: brief, lifecycle (state machine), verdict, scope, prompt, limiter, usage, worker events,
              report schemas, the Provider and its model catalog, engine ids; state-layout.ts (every file and
              directory under the state root, named once), report-capture.ts (the report protocol for the engines
              that cannot enforce a schema), provider-balance.ts (each provider's out-of-balance answers)
  ports/      interfaces: Worker (spec, run, caps), Git, GateRunner, JobStore, JobFiles (a job's sidecar files),
              EngineConfigStore (engines.json), RouteSpool (the routers' spool), Semaphore, LimiterStore, Clock, Ids,
              ProcessControl, Output; ports/keys.ts: ProviderKey, KeyStore, KeyVerdict, KeyEntry
  adapters/   thin I/O: the claude worker, the engines (omp, opencode, pi), the settings.json merge, the key store,
              env allowlists, git, shell gates, the file store, locks and slots; process/ (the one process runtime:
              streamed workers, tools run to completion, process groups, the double fork, detached starts, port
              probes), fs-files.ts (the one atomic write and the one JSON read), state-root.ts (the state-root rule)
  app/        use cases over ports: submit, drive (run → verify → auto-fix), review, accept, return, discard, stop,
              queries (board, usage), batch, engine selection
  auth-page/  the one-time local page where the key is entered; it saves a key the provider accepts, and one it
              knows but holds back (KeyVerdict `limited`: a 429 or 402) with a warning naming the top-up page
  router/     the model router: front, worker, emergency passthrough, ensure, supervision, uninstall
  render/     pure text renderers: board, job, review packet, usage, the price table
  cli/        parseArgs, commands/ (one module per command, setup-key and auth-serve included), exit codes, the
              composition root shared by all plugins
packages/core/test/support/   @muhmdraouf/core/testing: fakes, builders, the reference provider, a fake claude, the shared
                              plugin-surface, bundle-smoke and fresh-install suites
plugins/<p>-plugin-cc/src/
  provider.ts   the provider as data: names, endpoint, key variables, model ids, router port
  cli/main.ts, router/{main,ensure,passthrough}.ts   thin entry points that wire the provider into core
plugins/<p>-plugin-cc/plugin/   .claude-plugin/plugin.json, agents/, commands/, hooks/, dist/ (esbuild bundles and the `run`
                                launcher, committed)
```

Rules:

- No `any`; no default exports.
- Expected failures are values (`Result<T, E>` with discriminated error unions), never thrown across a port.
- Adapters contain no decisions. Every decision lives in `domain/` or `app/` and is unit-tested with fakes.
- Adapters get integration tests against real git, real processes (a fake `claude` script) and a temp filesystem.
- `test/architecture/layers.test.ts` enforces the import direction:
  - domain imports no other layer; ports only domain; app only domain and ports; adapters only domain and ports;
  - render adds app; auth-page and router add adapters;
  - only cli may import everything;
  - the ensure and emergency bundles load node built-ins alone.
- The provider plugins are hand-written copies of one another, kept in step by `npm run check:siblings`.

## Quality gates (`npm run check`)

In `packages/core` and in each plugin:

- `tsc --noEmit` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`);
- `biome ci`;
- `vitest run --coverage` (domain ≥95% lines/branches, overall ≥90%; core holds its own thresholds);
- no `it.todo` left;
- for a plugin, `dist/` fresh (the committed bundle matches its source);
- then the bun leg: core runs the router chaos suite with every router process on bun, a plugin runs its bundle tests
  with the bundles on bun.

From the repository root:

- `npm run check` also runs `check:siblings`.
- Mutation testing (Stryker, on `src/domain`, break threshold 90%) runs in `packages/core` and in the zai plugin only
  (`npm run mutate`); the other provider plugins have no logic of their own.
- CI adds a Node 22 leg, a macOS leg (with a real Keychain round trip) and a non-blocking ubuntu-26.04 job; see the CI
  section of `plugins.md`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | unexpected |
| 2 | usage |
| 3 | verdict not pass (`run --wait`, `wait`) |
| 4 | not found |
| 5 | landing refused, nothing applied (`land_conflict`, `land_verify_failed`, an overlapping dirty file; or a job busy with another driver) |
| 6 | not ready (setup; `run --wait`/`wait`: the job has no live driver and needs `stop` or `discard`) |
| 130 | follower interrupted (the job keeps running) |
