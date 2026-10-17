# The muhmdraouf plugins: code, layout, usage, architecture

- Covers every plugin in this repository (marketplace `muhmdraouf`): the five provider plugins.
- For each one: what it is for, how it is built, how to use it and how it fails.
- Status marker: **[main]** means on `main` today.

---

## 1. What is in the marketplace

| Plugin | One line | Runtime | Status |
|---|---|---|---|
| `zai-plugin-cc` | Run Z.ai GLM models inside Claude Code as normal models, plus verified background jobs | plugin-core, downloaded at setup | [main] |
| `kimi-plugin-cc` | The same for Moonshot Kimi | plugin-core, downloaded at setup | [main] |
| `deepseek-plugin-cc` | The same for DeepSeek | plugin-core, downloaded at setup | [main] |
| `minimax-plugin-cc` | The same for MiniMax | plugin-core, downloaded at setup | [main] |
| `qwen-plugin-cc` | The same for Alibaba Qwen | plugin-core, downloaded at setup | [main] |

The dashboards that read what the routers write live in another repository: radar, the observability
dashboard, is part of [huddle](https://github.com/MuhmdRaouf/huddle) (channels, tasks, a live dashboard).
The routers write the spool and read the budget file; huddle drains the one and writes the other.

Plus one thing that is not a plugin: `packages/core`, the engine the five provider plugins share (one Go
binary, `plugin-core`).

### The five provider plugins

- The same plugin, written five times over one core, by hand. No template, no generation step.
- Each has its own provider data, router port, key, model ids and slash prefix.
- None mentions another provider. The one exception: the routers know each other's ports, so they can pass requests
  along (section 3.2).

| Provider | Display | Main model | Flash model | Router port | Key env | Endpoint (Anthropic-compatible) |
|---|---|---|---|---|---|---|
| zai | Z.ai GLM | `glm-5.3` | `glm-5.3-flash` | 18787 | `ZAI_API_KEY` | `api.z.ai/api/anthropic` |
| kimi | Moonshot Kimi | `kimi-k3` | `kimi-k2.6` | 18788 | `KIMI_API_KEY` | `api.moonshot.ai/anthropic` |
| deepseek | DeepSeek | `deepseek-v4-pro` | `deepseek-flash` | 18789 | `DEEPSEEK_API_KEY` | `api.deepseek.com/anthropic` |
| minimax | MiniMax | `MiniMax-M3` | `MiniMax-M2.7-highspeed` | 18790 | `MINIMAX_API_KEY` | `api.minimax.io/anthropic` |
| qwen | Alibaba Qwen | `qwen3.8-max` | `qwen3.8-flash` | 18791 | `QWEN_API_KEY` or `DASHSCOPE_API_KEY` | `dashscope-intl.aliyuncs.com/apps/anthropic` |

**Request quirks.** The router removes fields the provider rejects before it forwards a request:

- deepseek: `cache_control`;
- minimax and qwen: `context_management`.

**Delegation tools** (omp, opencode, pi and zcode, section 3.4) are not provider data:

- Every provider plugin offers all four.
- Each tool runs as the user set it up, with its own login, provider and model.
- The plugin never names a provider to a tool and never passes it a key.

**Overrides.** Model ids, base URL and router port can change per provider without a release:

- `<PREFIX>_MODEL_MAIN` and `<PREFIX>_MODEL_FLASH` replace the model ids;
- `<PREFIX>_BASE_URL` replaces the endpoint;
- `<PREFIX>_ROUTER_PORT` moves the router; `<PREFIX>_ROUTER_URL` points the router alone at another endpoint;
- `<PREFIX>_OMP_BIN`, `<PREFIX>_OPENCODE_BIN` and `<PREFIX>_PI_BIN` and `<PREFIX>_ZCODE_BIN` name an engine binary that is not on `PATH`.

---

## 2. Repository layout

```text
cc-plugins/
├── .claude-plugin/marketplace.json     the catalogue: one entry per provider plugin (source
│                                       ./plugins/<project>/plugin, dependencies ["huddle"]) plus the huddle
│                                       entry, fetched from MuhmdRaouf/huddle (`git-subdir`, path `plugin`)
├── .github/workflows/release.yml       runs on a tag v<VERSION> pushed by hand (no workflow creates tags) and
│                                       publishes that GitHub release: the four cross-built binaries, SHA256SUMS,
│                                       the attestation, the changelog section as the notes
├── .github/actions/setup, dependabot.yml   the shared setup action; weekly updates for actions and npm
├── .github/FUNDING.yml                 the sponsor links; .gitleaks.toml: the secret scan's allowlist
├── .claude/settings.json                turns off Claude Code's commit and PR attribution in this repository
├── scripts/check-siblings.mjs          fails when the five provider plugins drift apart
├── scripts/check-attribution.mjs       fails when any commit credits an AI tool (author, committer or trailer)
├── package.json                        npm workspaces: packages/* and the five provider plugins
│                                       (`npm run check` starts with `check:attribution` and `check:siblings`)
├── package-lock.json                   one lockfile for every npm workspace
├── README.md                           install + layout + development
├── plugins.md                          this document
├── AGENTS.md                           the rules for commits and coding agents; CLAUDE.md imports it
├── assets/                             logo.svg and banner.svg, used by the README
├── LICENSE                             GPL-3.0-or-later
│
├── packages/core/                  the engine behind the five provider plugins: one static Go binary, plugin-core
│   ├── ARCHITECTURE.md                the job engine's detailed design
│   ├── cmd/plugin-core/               the only main: `plugin-core <provider> <cli|router|passthrough|ensure>` and
│   │                                  the `--orphan-launch` plumbing that detaches drivers
│   ├── internal/domain/               pure logic: brief schema/defaults/duration, job + lifecycle state machine,
│   │                                  verdicts, prompt building (footer, failures, summary, fences), limiter
│   │                                  (AIMD), usage, worker events, stream parsing, report schemas,
│   │                                  report-capture (the report protocol for engines that cannot enforce a
│   │                                  schema), state-layout (every state file's name), provider-balance (each
│   │                                  provider's out-of-balance answers), budget (the Radar budget stop),
│   │                                  route-events (the spool's line shapes), Provider + model catalog, engine ids
│   ├── internal/ports/                interfaces: Worker (spec, run, capabilities), Git, GateRunner, JobStore,
│   │                                  JobFiles, Semaphore, LimiterStore, EngineConfigStore, RouteSpool, Clock,
│   │                                  Ids, ProcessControl, Output; keys (ProviderKey, KeyStore, KeyVerdict)
│   ├── internal/adapters/             thin I/O: the claude worker, engines/{omprpc, opencode, pirpc, zcode,
│   │                                  shared}, keystore/{macos, linux, file}, key lookup, env allowlist,
│   │                                  state-root, fsutil (the one atomic write and JSON read), the file store
│   │                                  with lock/job-files/engine-config/semaphore/limiter, git
│   │                                  (cli, land, apply, run, snapshot), shell gates, process/ (streaming,
│   │                                  process groups, the orphan launcher, detached starts, port probes),
│   │                                  spool/ (route and health events)
│   ├── internal/app/                  use cases: submit, drive (run → verify → auto-fix), attempts,
│   │                                  decide/decide-land (accept/return/discard), batch, queries
│   │                                  (board/show/usage), activity (board rows and router health from the
│   │                                  spool), advisor (the flash-model advisor), follow (wait), cleanup, ping,
│   │                                  engine-select/-reap
│   ├── internal/authpage/             the one-time local key page: server, html, check (the real ping)
│   ├── internal/render/               pure text: board, job, review packet, summary, usage, wait, next steps,
│   │                                  the price table
│   ├── internal/router/               front.go (the process that owns the port), worker.go + router.go (the
│   │                                  provider logic), emergency.go + passthrough.go (never-fail Anthropic
│   │                                  pipe), ensure.go (hook check), process.go (start, update, hand over),
│   │                                  service.go (the entry),
│   │                                  upstream (HTTP plumbing, proxy), refusal.go (key, balance and budget
│   │                                  refusals), budget.go (reads Radar's budget status), registry.go (peers),
│   │                                  spool writing (in adapters/spool), ledger.go + uninstall.go (undo on
│   │                                  uninstall/disable), legacy.go (retires an OS service left on disk),
│   │                                  pidfile.go, crashlog.go
│   ├── internal/cli/                  argument parsing, one file per command (setup, setup-key, auth-serve,
│   │                                  engine-setup, run, batch, decide, queries, wait, brief, mode), exit
│   │                                  codes, route.go (setup wiring), engine_wire.go, wire.go (composition
│   │                                  root shared by all plugins)
│   ├── internal/providers/            the five providers as data (one file each; the cross-plugin provider test)
│   ├── internal/archtest/             the allowed import direction between the layers above
│   ├── internal/testkit/              fakes, builders, the reference provider, a fake claude, fakedeps (the
│   │                                  wired deps the CLI tests drive)
│   ├── testdata/                      fixtures: captured stream events, goldens, a fake claude
│   └── scripts/                       build (4 targets, release manifest), covergate, releasenotes (release notes
│                                      from the changelog), host-build, release dry-run
│
├── plugins/<p>-plugin-cc/              one per provider (zai, kimi, deepseek, minimax, qwen), identical shape
│   ├── test/provider.ts                the provider as data (the only provider-specific file)
│   ├── scripts/build.mjs               writes plugin/dist/run (+ --check for freshness), scripts/no-todos.mjs
│   ├── test/                           plugin-surface test, bundle smoke and fresh-install tests (from
│   │                                   packages/plugin-test, against the plugin-core binary); zai also: the full
│   │                                   CLI end to end (golden transcript, CLI, epipe, follow, orphan)
│   ├── README.md                       the five READMEs are the same text apart from the provider's names
│   └── plugin/                         THE INSTALLED PLUGIN (the only folder Claude Code copies)
│       ├── .claude-plugin/plugin.json  name (zai, kimi, …), version, author, license
│       ├── commands/                   setup.md, board.md, usage.md, review.md, remove.md and
│       │                               setup/{claude,omp,opencode,pi,zcode}.md
│       ├── agents/                     two model agents (zai: glm-5.3.md, glm-5.3-flash.md) and four engine wrappers
│       │                               (omp.md, opencode.md, pi.md, zcode.md)
│       ├── hooks/hooks.json            SessionStart: `setup --hook`, `board --hook`;
│       │                               UserPromptSubmit, PreToolUse and SubagentStart: `<p>-ensure.js`;
│       │                               SubagentStop: `usage --hook`
│       └── dist/run                    the committed sh launcher every hook, command and agent uses: it maps the
│                                       bundle name to its entry and runs the pinned plugin-core binary (setup
│                                       downloads and verifies it; a hook finding no binary starts one locked
│                                       background download; no other runtime)
```

---

## 3. Architecture

### 3.1 The big picture

```text
             ┌───────────────────────── your machine ───────────────────────────┐
  you ──▶ Claude Code session(s) ──ANTHROPIC_BASE_URL──▶ provider router(s)      │
             │  /model: Opus, Sonnet,      (127.0.0.1:18787 zai, :18788 kimi …)  │
             │  GLM 5.3, GLM 5.3 Flash      │                                    │
             │  subagents zai:glm-5.3 …         ├─ claude-*  ──▶ api.anthropic.com (untouched)
             │                              ├─ glm-*     ──▶ api.z.ai (zai key)  │
             │                              ├─ kimi-* …  ──▶ peer router :18788 (one hop)
             │                              └─ route event ──▶ the spool      │
             │                                                                   │
             │  jobs: `zai drive <id>` (detached) ── claude -p ─────▶ api.z.ai   │
             │          or omp / opencode / pi / zcode, on their own setup ──▶ their model│
             │            └── git worktree, gates, verdict ──▶ review/accept     │
             │                                                                   │
             │  the spool (`$RADAR_HOME`, else `~/.agents/radar`) and            │
             │  `budget-status.json` ◀── read and written by radar,              │
             │                            part of huddle (its own repository)    │
             └───────────────────────────────────────────────────────────────────┘
```

Three independent mechanisms. Each one works without the others:

1. **Native routing** (the router): provider models become ordinary Claude Code models.
2. **Background jobs** (the engine): detached, gated, worktree-isolated work with a verdict.
3. **Coordination and observation**: the spool each router writes and the budget file each router reads;
   radar — part of [huddle](https://github.com/MuhmdRaouf/huddle) — drains the one and writes the other.

### 3.2 The router

- One router per provider plugin, in `packages/core/internal/router/`.
- One background process that the plugin itself starts and keeps alive.
- No launchd, systemd or other service to install.
- Works the same on macOS and Linux.

**Parts.**

- **The front** (`front.go`) is the process the plugin starts.
  - It owns `127.0.0.1:<port>` for as long as it runs and never lets go.
  - It holds no provider logic and no key.
  - It hands each request to a worker over loopback.
- **The worker** (`worker.go` + `router.go`) is the provider logic.
  - The front forks it by re-executing the plugin-core binary; it listens on its own loopback port.
  - It is disposable. It reports a heartbeat and its memory size to the front every second.
- **The router is the plugin-core binary**: one static executable, no runtime to choose.
  - Every server listens on its own port. A handover's temporary port is a second server, not a socket handed over.
  - Every server tracks and closes its own sockets.
- **The emergency passthrough** (`emergency.go`, the `passthrough` entry) is a pure Anthropic pipe.
  - It takes the port when the main router cannot start at all.
- **The ensure entry** (`ensure.go`, what the hooks run) checks that the router is alive.

**Subcommands** of the router entry (`service.go`): `run | start | stop | status`.

- `run`: the front.
- `start`: what setup and the hooks use to bring the router up.
- `stop` and `status`: for people.

**How each request is handled.**

- **Choosing the route.** The router reads the request's `model` field.
  - A provider request matches a catalog id (an id set with `<PREFIX>_MODEL_MAIN` or `_MODEL_FLASH` included) or one
    of the plugin's model prefixes (zai: `glm-`).
  - One function answers that question: `claims(modelClaim(resolved), model)`.
  - The worker, the front, the emergency passthrough and the peer registry all use it. So an overridden id outside the
    usual prefix is the provider's everywhere.
- **Anthropic route.** Every other request (`claude-*`, unknown, or no body) goes to `https://api.anthropic.com`.
  - Byte-for-byte, with the caller's own Anthropic credentials.
  - A body that does not parse, or names no model, is Anthropic's too. The router never blocks on it.
- **Provider route.**
  - The caller's Anthropic credentials are removed and replaced by the provider key (Bearer).
  - Fields the provider rejects (`provider.strip`) are removed from the body.
  - Hop-by-hop headers are dropped.
  - Streaming responses (SSE) are piped through without buffering.
- **Proxy mode (Remote Control).** The front is also a localhost HTTPS proxy, on when it has a CA directory
  (`<state>/../ca`, in practice `~/.agents/ca`). Setup's default writes `HTTPS_PROXY` into Claude Code's
  `settings.json` instead of `ANTHROPIC_BASE_URL`, so `claude rc` keeps working with routing on.
  - A `CONNECT` to `api.anthropic.com:443` is decrypted with the per-user local CA and routed exactly as a base-URL
    request, model claim included. The CA signs only that one name (`internal/adapters/localca`), is handed to Claude
    Code through `NODE_EXTRA_CA_CERTS`, and never enters a system trust store.
  - Every other `CONNECT` is tunnelled blind: the TLS stays between the client and the target, nothing is read, and a
    tunnel that names this machine is refused.
  - The loopback entries are appended to `NO_PROXY`; a base URL that is one of the five plugin routers is taken out.
  - A proxy or CA of the user's own keeps base-URL mode, and so does an unusable CA: the fallback is said in one
    line, and `CONNECT api.anthropic.com` then passes through as a blind tunnel (one line in `router.log`), so Claude
    is never cut off.
- **Errors.** Failures come back in Anthropic's error shape, so Claude Code shows a readable message.
- **Refusals Claude Code can act on** (provider routes only).
  - Why: Claude Code reads a 401 as its own Anthropic login failing, and retries 429s and 5xx errors for minutes.
  - So the router rewrites two cases into a 400 with `x-should-retry: false`:
    1. The provider answers 401 or 403, or there is no key: `<Display> key refused or missing: run /<p>:setup`.
    2. The provider says the account is out of balance (Z.ai 1113, 1316, 1317; Moonshot
       `exceeded_current_quota_error`; DeepSeek 402; MiniMax 1008; DashScope `Arrearage` and `isv.OUT_OF_SERVICE`): a
       message naming the provider's top-up page (`billingUrl` in its provider data). Answered at once, not retried.
  - The top-up pages:
    - zai: `https://z.ai/manage-apikey/billing`
    - kimi: `https://platform.kimi.ai/console`
    - deepseek: `https://platform.deepseek.com/top_up`
    - minimax: `https://platform.minimax.io/user-center/payment/balance`
    - qwen: `https://usercenter2-intl.aliyun.com/billing`
  - No upstream text is copied into either answer.
  - Any other provider error that quotes the key has it blanked out.
  - `claude-*` and peer answers are never touched.
- **Budgets.** Radar — part of [huddle](https://github.com/MuhmdRaouf/huddle) — writes
  `budget-status.json` in its state root (`$RADAR_HOME`, else `~/.agents/radar`).
  - The worker reads it at most every 5 seconds.
  - While it lists `provider:<p>` or `total` as stopped, the provider's models get the same non-retryable 400:
    `<Display> budget reached for this <period>: raise or lift it in the Radar dashboard (/huddle:open)`.
    The period comes from `budgets.json`.
  - The check comes before the key lookup.
  - A missing, unparsable, oversized, non-regular or stale (over 10 minutes old) file stops nothing.
  - `claude-*` is never checked against it (`internal/domain/budget.go`, `internal/router/budget.go`).
- **The key** is read only for a provider request, only by the worker, under a 2 second budget.
  - A missing key answers the provider's models with the 400 above; a hung lookup answers 503.
  - Neither touches `claude-*`.
  - The key is never in a log, the crash log, the spool, the ledger, the health answer or an error body. The chaos
    suite sweeps all of them for a sentinel key.
- **Peers.** Each router registers itself in `~/.agents/provider-routers/<name>.json`.
  - A router that receives another provider's model id forwards it once to that provider's router.
  - The forward carries the header `x-provider-router-hop: 1`. A second hop is refused with 508.
  - A dead peer returns 502 naming `/<p>:setup`, and fails only that peer's models.
  - Result: all five plugins can be set up together while Claude Code points at only one router.
- **Route events.** One JSON line per routed request goes to `~/.agents/radar/spool/<date>.jsonl` — the spool
  radar, part of [huddle](https://github.com/MuhmdRaouf/huddle), drains.
  - Fields: `plugin, model, upstream, route, status, latency_ms, usage, session_id, agent_id, parent_agent_id`.
  - The router also writes a `router` start or stop line.
  - When something goes other than plainly, it writes a health line, `{"kind":"router.event", plugin, event, reason,
    model, ts}`. The events:
    - `fallback`: a request the front or the emergency passthrough served itself;
    - `refusal`: no key, a refused key, no balance, a stopped budget;
    - `rate_limited`: a provider 429;
    - `budget_stop`: a budget scope newly turning the models off;
    - `restart`: a worker the front replaced.
  - It never records keys, headers, prompts or responses.
  - A failing spool write costs one line on stderr and nothing else.
- **Health.** `GET /<name>-router/health` answers `{"ok":true,…}`.
  The emergency passthrough answers `"mode":"emergency"`.

**Limits and upstream plumbing** (`upstream.go`, shared by every router process).

- Request bodies up to 64 MiB; a larger one gets an Anthropic-shaped 413.
- An upstream that sends nothing for 10 minutes is given up on. It is an idle timeout, not a total one: a stream that
  keeps talking is never cut, however long it runs.
- Keep-alive connections upstream, with one retry when the upstream had already closed a reused socket. So a stale
  socket never reaches Claude Code as `ECONNRESET`.
- The caller's `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` are honoured, through a CONNECT tunnel.
- A request path must have exactly one leading slash (`//host/x` is refused), so a request cannot redirect the
  upstream host.
- The router listens on 127.0.0.1 only and refuses any other `Host`; the router, the front and the emergency
  passthrough share that check and the same request preamble (bad path, 413).

**Staying up: the router never cuts Claude off.**

- **Workers.**
  - A worker that exits is replaced at once.
  - A worker with no heartbeat for 5 seconds is killed and replaced.
  - A worker over 512 MB, or a hot update, is recycled: the new worker starts first, and the old one drains its
    streams (up to 10 minutes).
  - A request the worker never sent upstream is retried on the next worker. A crash costs only the requests that were
    already talking to the upstream.
- **Degraded mode.** Entered when workers will not stay up (3 exits in a minute, or one that never starts).
  - The front serves requests itself through the passthrough for a minute, then tries one worker again.
  - `claude-*` and every other non-provider request still reach Anthropic untouched.
  - Only the provider's own models answer 503, saying what to run.
- **Emergency mode.** Entered when the main router will not start at all.
  - `start` runs the emergency passthrough on the port. Its health says `"mode":"emergency"`.
  - The next hook retries the main router and takes the port back through a handover.
- **Updates.**
  - A running router of an older bundle gets a hot update: its worker is re-pointed and the port never closes.
  - A front with a different front protocol is replaced through a handover, with a gap under 300 ms.
  - Bundle versions are the first 12 hex digits of the bundle's SHA-256.
- **Updating from the released 0.0.1 plugin.** Its front runs the bundled runtime (front protocol 2) and its pid
  record names that runtime in `node`.
  - The first SessionStart after the update takes the port from that front through the handover: the new front
    proves itself on a temporary port, the old one is told with its own record's token to let go, and the swap
    costs no refused connect at all in practice (a client asking every 50 ms sees none).
  - The old front leaves its one `handover` line in `router.log` and exits once its answers drained; the pid
    record is rewritten with the new front's pid and protocol 3.
  - The ensure hooks leave the old front alone while it answers health, so no session is interrupted mid-run; the
    replacement happens on the next setup or SessionStart.
  - An old front that accepts but never answers health is replaced, not waited on: the start path recognises its
    command line (`bun <state>/router/<p>-router.js run` or `worker`) as ours through the bundle path, kills it and
    starts the Go front — a window of refused connects under half a second, inside the hook's budget.
- **Starting.** `StartRouter` (`process.go`) is used by setup, the SessionStart hook and the ensure hooks. In order:
  1. retire an OS service for the router, if one is on disk (below);
  2. probe the port, and never touch a server someone else owns;
  3. take an atomic lock, so two hooks starting at once start exactly one router;
  4. copy the binary into `<state>/router` (mode `0700`), so a plugin update or uninstall never deletes the code
     that is running;
  5. spawn the front detached and wait for its health;
  6. fall back to the emergency passthrough when it will not start.

  `<state>/router.pid` (mode `0600`) records the pid, port, bundle version, front protocol, main or emergency mode and
  the token its control endpoints require.
- **Hooks.** `UserPromptSubmit`, `PreToolUse` and `SubagentStart` run `<p>-ensure.js`.
  - It GETs the health path (1 s): "up" means our own router answered, not a bare connect.
  - Port closed: it starts `<p>-router.js start` detached and returns at once.
  - Port open but no health answer: when the pid record names our front, the first silent probe marks the episode
    in `<state>/router.silent` (the unix ms of that probe) and says one line; only a probe that finds the episode
    at least 5 s old SIGKILLs the front — one line in `router.log` naming the pid — and starts a fresh router.
    An answer of ours, a closed port or a fresh start clears the mark; a mark older than 60 s starts a new episode
    instead of killing. The hooks' probes and the watchdog's ticks fill the same episode. Any other holder of the
    port is left alone, also named in one line.
  - Every start appends the child's stdout and stderr to `router.log` and adds one `ensure: started router
    (reason: …)` line, so a start that fails leaves its trace.
  - It prints nothing to the session, always exits 0, and stays inside its 3 s budget in every case.
  - It does nothing for a plugin that was never set up.
- **The session watchdog** (`plugin-core <p> router watch --session-pid <pid>`, `watch.go`), started detached by the
  SessionStart hook after the router is up.
  - The session pid is the Claude Code process: the nearest ancestor of the hook that is neither a shell nor the
    launcher (`dist/run`), found by walking `ps -p … -o ppid=,command=` up from the hook's parent. When no such
    ancestor can be identified, no watchdog starts and the hooks remain the recovery.
  - Every 2 s it runs the same check as ensure and restarts the router when it is down or hung (a front that
    accepts but never answers is replaced once its silence has lasted 5 s, so about three ticks).
  - It exits within 2 s once the session pid is gone, and when the router is retired for a remove or the plugin is
    no longer set up; every exit leaves one line in `router.log`.
  - One watchdog per session: each claims `<state>/watch.<session pid>`, and a later one for the same session (a
    resume, a compact) bows out at once when the holder is still alive. Several sessions each run their own, and
    the router start lock keeps them from starting two routers.
- **A port that someone else holds.**
  - The router never kills or takes over a foreign server.
  - The settings guard (`GuardSettings`, run after every `StartRouter`) removes this plugin's proxy keys, or its base
    URL in base-URL mode, from `settings.json` when no live router of the plugin's can hold the port. The next session
    talks to Anthropic directly.
- **Retiring on removal.** A Claude Code session reads `ANTHROPIC_BASE_URL` once, when it starts, so every session
  already open keeps sending to the router after a removal. The router therefore retires instead of stopping:
  - `/<p>:remove` sends the front a `POST <health>/retire` control call (loopback and the pid file's token), and
    moves `router.pid` to `router.retired`; the uninstall watch retires the front the same way (below).
  - A retired front drains its worker, passes every other request to Anthropic exactly as it came, and answers this
    provider's models, peers' models and peer hops with a 400 that is not retried: "`<Display>` was removed: restart
    Claude Code to stop using its router".
  - It writes one `router.event` line (`restart`) to the spool and nothing after it, and takes its registry entry out.
  - Every 30 s it reads `ps -axo pid=,lstart=,args=`. A Claude Code session is a command line whose program is
    named `claude`, or one that runs `@anthropic-ai/claude-code/cli.js` under node or bun (command lines, because
    Linux names a Node process's main thread `MainThread`).
  - It exits once no Claude Code session that started before the retirement is left, after 7 days in any case, or on
    SIGTERM.
  - A later setup hands the port over to a fresh front (the handover, no gap); a second remove leaves it as it is.
- **Records,** under the state root:
  - `router.log` (rotating);
  - `router-crash.log`: one JSON line per crash or supervision event, the last 1 MiB kept.
  - `router.exit`: the logged-exit marker, the pid of the router process whose exit left its line
    in `router.log`; the next start names a holder of the pid record that is gone with no marker.
  - Never a header or a body. A full disk or a read-only file costs the log line, never the request.

**Giving it back: uninstall and disable.**

- Claude Code has no uninstall or disable hook.
- The router outlives the plugin, so it watches for it.

- `setup` writes a **ledger** (`<state>/ledger.json`, `0600`): every change it made outside the plugin, with what was
  there before:
  - the router URL it put in settings;
  - each agent's `model:` value before setup first changed it;
  - whether it created the keystore item;
  - the files it put outside the plugin and the OS service it retired;
  - the `installed` marker in the plugin's data directory.
- Every 10 seconds the router reads Claude Code's own plugin bookkeeping.
  - After two "gone" answers in a row, it undoes exactly what the ledger records. One is not enough: an update
    rewrites those files.
  - Settings come back byte-identical, even in the user's own formatting.
  - An unreadable bookkeeping file counts as "unknown", and unknown never acts.
- It puts the agents' `model:` lines back where their files still exist (a disable keeps them).
- It then retires (see "Retiring on removal" above): it keeps passing Claude requests through for the sessions that
  still hold its URL. When it exits, it first removes its own files, its registry entry, the keystore item setup
  created and the decided jobs' worktrees.
- Disabling the plugin cleans up the same way, but keeps the ledger as `ledger.disabled.json`. When the plugin is
  enabled again, the next SessionStart hook finds it and re-applies setup.

**An OS service left on disk.** Applies to a LaunchAgent (macOS) or `systemd --user` unit (Linux) for the router.
`legacy.go` is the only file that names those tools. It:

1. stops the service;
2. starts the router on the same port;
3. removes the unit only once the router answers health.

- If the router does not come up, the service is started again and left alone, and the report says so.
- Nothing in the repo installs or depends on an OS service.

**The chaos suite** (`packages/core/internal/router/chaos_test.go`) checks that Claude traffic never fails.

- It runs the real router processes with a fake Anthropic and a fake provider, and injects one fault per case.
- It runs as part of the Go suite, on Linux and macOS.
- Handover gaps are counted in refused connects and client retries, not in wall-clock milliseconds.

| Case | Fault |
|---|---|
| a | SIGKILL the worker mid-stream: that stream may fail, the next requests succeed |
| b | SIGKILL the worker 10 times in a row under 20 parallel clients |
| c | block the worker's event loop: the front kills it and a fresh worker serves |
| d | a worker crash loop puts the front in degraded mode, then it recovers |
| e | SIGKILL the front: `ensure` brings the router back within one prompt |
| f | a corrupt worker bundle means degraded; a corrupt router bundle means emergency; repair hands back |
| g | a hot update under load fails zero requests and never closes the port (g': a front with another protocol is handed over in under 300 ms) |
| h | a port held by a foreign server: nothing is killed and the base URL is taken out of settings |
| i | a missing key (400) or a hung key lookup (503) never touches `claude-*` |
| j | a provider upstream that is down or hangs never touches `claude-*` |
| k | a dead peer router fails only that peer's models |
| l | keep-alive reuse across the upstream's timeout never reaches the client as `ECONNRESET` |
| m | a 30 MiB request body goes through byte for byte |
| n | a long stream is never cut: 12 s of events against a 2 s idle timeout |
| o | upstream requests go through the caller's proxy (CONNECT, or forwarding on Bun 1.3); loopback never does |
| p | a full disk for the crash log, the router log and the spool: requests are still served |
| q | two hooks starting the router at once start exactly one |
| r | `budget-status.json` churning, a FIFO, garbage or stale: a stop refuses only the provider |
| s | `setup --remove` under 20 claude clients: the router retires, zero clients fail, the provider gets the 400, setup takes the port back |

Two more cases follow the lettered ones:

- the provider key never appears in any file the router writes, any error body, health, the key check or a command
  line;
- an uninstall under 20 claude clients (the plugin's directory deleted too): the router restores the settings and
  retires with zero client failures, then removes its files and exits at the cap.

### 3.3 Native routing: how the models get into `/model`

`/<p>:setup` merges into `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`):

- `modelPicker.options`: one `{model, label}` row per catalog model (zai: `glm-5.3` "GLM 5.3", `glm-5.3-flash`
  "GLM 5.3 Flash"). They appear in `/model` next to Opus and Sonnet.
- `availableModels`: the same ids are appended only if you already restrict models with that list.
- Proxy mode, the default (`internal/domain.PlanProxy`, `internal/adapters/claude_settings.go`):
  - `env.HTTPS_PROXY` is pointed at the router when unset, or kept when it names this router or another live plugin
    router's, and moved to this one when it names another plugin's router that is not running;
  - `env.NODE_EXTRA_CA_CERTS` is pointed at the local CA (`~/.agents/ca`, section 3.2);
  - the loopback entries are appended to `env.NO_PROXY` (entries already there stay first, and a removal leaves
    `NO_PROXY` in place: it may hold the user's own);
  - `env.ANTHROPIC_BASE_URL` that is one of the five plugin routers is taken out: the proxy replaces it.
- Base-URL mode, the fallback (`internal/domain.PlanBaseUrl`): a proxy or CA of the user's own (in `settings.json` or
  the environment, lowercase `https_proxy` read before `HTTPS_PROXY`), a `settings.json` base URL that is none of the
  five routers, or a CA that cannot be created keeps `env.ANTHROPIC_BASE_URL` planning instead:
  - set to the router when it is unset, or already points at one of the five plugin routers;
  - moved to this one when it points at another plugin's router that is not running;
  - any other value is your own proxy: it is reported and never overwritten.

How the merge behaves (`internal/adapters/claude_settings.go`):

- It is idempotent: a second run produces byte-identical output.
- It keeps every other key and entry.
- Only a missing file counts as empty. Any other read error writes nothing, and an unparsable file is left alone.
- The first write ever keeps a backup, `settings.json.<name>-backup` (for zai, `settings.json.zai-backup`).
- The result must survive a JSON round trip before it is written, and the write is atomic.
- The file's mode and a symlink are kept: a symlinked settings file is edited through the link.
- Writers on this machine take turns through a lock. A file that changed on disk while it was being edited is re-read
  and the edit redone once; if it changed again, it is left alone.
- It owns only entries whose `model` is in that plugin's catalog. `setup --remove` takes out exactly those entries.

**After setup:**

- Restart Claude Code. Choosing GLM 5.3 then sends that conversation's requests through the router to Z.ai.
- The session that ran setup keeps talking to Anthropic until it restarts. The report's last line says so.

**The setup report** starts with one outcome line:

- `ready`;
- `not routed`: a proxy or base URL in `settings.json` is the user's own, so nothing reaches the router and the agents
  run on Sonnet. The line names the fix.
- `not ready`: a `FAILED` line says which check failed.

When the run changed `settings.json` or an agent, the report ends with the restart line.

**Subagents, hooks and removal:**

- **Subagents.** Claude Code sends each subagent's frontmatter `model:` id.
  - `setup` rewrites the plugin's agents to the provider's model ids when the router is up.
  - It sets them back to `sonnet` when the router is down or the key is gone.
  - Agents set to `glm-5.3` run on GLM; every other subagent stays on Claude.
- **The SessionStart hook** (`setup --hook`, 15 s budget):
  - re-applies all of it after a plugin update and brings the router up;
  - starts the session watchdog once the router is up (the hooks cover the gaps between them);
  - never pings the provider;
  - falls back to Sonnet for the agents when the router cannot come back.
- **The SubagentStop hook** (`usage --hook`, 2 s budget) reads the finished agent's own transcript and shows the user
  one line:
  - the model that answered, its tokens and estimated cost;
  - or, when the agent ran on a Claude model, how to fix that.
  - Any problem means silence.
- **Removing it.** `/<p>:remove` (`setup --remove`):
  - puts the agents back on the models the ledger recorded before setup (the shipped `sonnet` only without a
    ledger);
  - takes the plugin's `/model` entries and proxy keys out of `settings.json` (or its base URL, in base-URL mode);
  - retires the router (section 3.2): open sessions keep working through it until they close;
  - deletes the stored key.
  - Uninstalling is then `/plugin uninstall <p>-plugin-cc@muhmdraouf`.
- **Identifying traffic.** This is how the router, the board and the dashboards that read the spool attribute
  traffic to a session or a subagent:
  - Claude Code puts `x-claude-code-session-id` on every request;
  - `x-claude-code-agent-id` on subagent requests, plus `x-claude-code-parent-agent-id` when nested.

### 3.4 Background jobs (the engine)

- The engine all five provider plugins share.
- `packages/core/ARCHITECTURE.md` holds the full specification. This is the summary.

**Roles.**

- Claude orchestrates and reviews.
- A worker does the work: headless Claude Code (`claude -p` pointed at the provider endpoint), or a delegation engine
  (below).
- The plugin verifies deterministically.

The plugin never decides acceptance. Claude never takes a worker's "done" on trust.

**The brief.** A brief is Markdown with YAML front matter, validated by the engine. Its fields:

| Field | Meaning |
|---|---|
| `title`, `tags` | names |
| `mode` | `edit` (worktree + branch `zai/<id>`), `exec` (may run commands, must not change the repo; outputs to `$ZAI_ARTIFACTS`), `readonly` (plan mode) |
| `model` | `glm` or `flash` (or a model id) |
| `engine` | `claude`, `omp`, `opencode`, `pi` or `zcode` (see Engines) |
| `effort` | `low`, `high` or `max` |
| `base` | the starting ref |
| `scope`, `forbid` | globs the change may and may not touch |
| `setup`, `gates` | commands the **plugin** runs after every attempt and again at accept |
| `regenerate` | generated files rebuilt instead of merged |
| `timeout` | per attempt |
| `retries` | `{fix, infra}` |
| `report` | `change`, `sweep`, `notes` or a JSON schema |
| `env` | names of variables passed through, never values |
| `addDirs`, `budgetUsd` | extra readable paths; spend cap |

**The lifecycle.**

```text
brief ─submit─▶ queued ─slot─▶ running ─exit─▶ verifying ─▶ awaiting_review ─accept─▶ accepted
                                 ▲                  │ fail + fix budget      ├─return(feedback)─▶ review_fix attempt
                                 └── auto_fix ◀─────┘                        └─discard─▶ discarded
```

**Verdicts:** `pass`, `gate_fail`, `scope_violation`, `report_invalid`, `worker_error`, `quota`, `timeout` and
`stopped`.

- Failures land in review too.
- `quota` is an attempt the provider refused because the account is out of balance or quota.
  - It goes straight to review: no infra retry, no cut to the concurrency cap.
  - Its next step names the provider's top-up page.

**Fix attempts** resume the same model session, so the worker keeps its context.

**Accept** lands exactly the verified commit. Its steps:

1. Commit on the job branch.
2. Rebase onto the tip; a conflict inside `regenerate` paths takes the tip's side.
3. Run the regenerate commands.
4. Verify the exact commit in a fresh detached checkout (setup, then every gate).
5. `git merge --ff-only` into your checkout, refusing to overlap your dirty files. If the tip moved, retry, up to 3
   times.

**Execution model.**

- There is no daemon.
- Each job has its own detached `drive` process, started by a double fork, so killing the caller cannot kill it.
- Followers (`wait`, `run --wait`) only poll.
- Per-job locks and a file semaphore under `<state>/slots/` cap concurrency.
- The cap is adaptive (AIMD):
  - three 429s in 60 s cut it to 75%; a quiet minute adds one back;
  - the range is `[1, ZAI_MAX_CONCURRENCY=16]`;
  - `run` jobs get priority over `batch` jobs.

**Worker environment.**

- An allowlist (PATH, HOME, LANG, …) plus the caller's non-secret `CLAUDE_*` settings.
- The provider's base URL and key, with the aliases sonnet/opus mapped to main and haiku mapped to flash.
- An isolated `CLAUDE_CONFIG_DIR`.
- The key exists only in the child's environment.

**State** lives in `~/.agents/zai/`, or `$ZAI_STATE_DIR` — one root for hooks, commands and the router, so
the ensure hook always finds the setup-done and pid files the rest wrote. `CLAUDE_PLUGIN_DATA` never picks
the root (Claude Code sets it only for hooks); state an older build left in `~/.local/state/zai/` or in the
plugin's own data dir moves over on the first start:

- `jobs/<id>/`, `worktrees/<id>`, `checkouts/<id>`;
- `slots/`, `router/`;
- `ledger.json`, `engines.json`.

**Engines.** The worker is behind a port (`internal/ports`), so the tool that runs the model is swappable. All four
engines are [main]:

| Engine | How it is driven |
|---|---|
| `claude` (headless) | `claude -p --output-format stream-json`, session id/resume, native JSON-schema report. Always enabled; points at the provider's Anthropic-compatible endpoint. |
| `omp` | `omp --mode rpc`, JSON frames over stdio |
| `opencode` | `opencode run --format json` (one process per attempt, its exit is the turn boundary). opencode leaves a server child behind, so the rest of its process group is reaped after the run. |
| `zcode` | The ZCode app CLI: `--json --attach <brief> --prompt <instruction>`, one final JSON response per attempt. `--resume` reuses its session. Every job uses yolo; readonly adds a read-tool allowlist. Invalid JSON fails even on exit 0. |
| `pi` | `pi --mode rpc`. pi has no native report schema, so the report rides in the final assistant text and is checked twice, in the adapter and in the engine. |

All engines share these rules:

- Each runs in its own process group, apart from the driver's.
- Every engine's events are translated to the same `WorkerEvent`s, so drive, gates, review and the decisions stay
  engine-agnostic.
- **omp, opencode, pi and zcode run as the user set them up.**
  - Their own login, provider, default model, extensions and config decide what runs.
  - The plugin names no model, provider, endpoint or key. It never writes their configuration and never reads it.
  - It starts the tool with the user's own environment, minus the plugin's key, the `<PREFIX>_` variables, and Claude
    Code's routing and session variables (which can point at a plugin router).
  - It adds only the job's access. opencode: its edit and bash permissions through `OPENCODE_CONFIG_CONTENT`, merged
    over the user's config. omp and pi: their tools narrowed where the job's access requires it.
  - All five provider plugins, qwen included, offer all four tools.
- **The numbers are the tool's own.**
  - The model a tool says it ran on and its token counts are reported back as the tool gives them.
  - In `usage` they have their own rows with a MODEL column (`-` when the tool names none).
  - They are not in the estimated total, which prices only jobs on the claude engine.
- omp and pi get 60 seconds for their first RPC handshake before an attempt counts as an infrastructure failure.
- **Reaping.** An engine process never outlives its job.
  - While an engine runs, its process-group leader's pid sits in `<job>/engine.pid`.
  - `stop`, `discard` and the cleanup every command runs for dead drivers terminate that group.

**Choosing the engine for a job,** first match wins:

1. `run --engine <x>`;
2. the brief's `engine:`;
3. the config's `defaultEngine`;
4. claude.

**Enabling an engine:**

- A delegation engine must have been enabled by its setup command (section 4.2).
- The enabled engines, each one's watcher and the optional `defaultEngine` are kept in `<state>/engines.json`, beside
  the setup mark, so plugin updates cannot lose them.
- Setup never disables an engine.
- `/<p>:setup:<tool>` checks the tool as the user set it up: the binary, its version and a one-word smoke run on the
  tool's own setup.
- If the smoke run fails, the user is told to run the tool once and log in or configure it. The plugin does not do
  that for them.

**The watcher.** Each engine has a wrapper agent (`zai:omp`, `zai:opencode`, `zai:pi`, `zai:zcode`).

- The watcher setting decides which model runs that wrapper: the provider's main model (through the router) or Claude
  Sonnet.
- The wrapper turns a request into a brief, submits the job on its engine, waits for the verified result, and returns
  the review with the exact accept, return and discard commands.
- It never accepts, never edits files and never commits.
- The tool itself keeps running on its own model. The watcher only writes the brief, waits and reads the review.

### 3.5 Code rules

**Language and style.**

- The engine (`packages/core`) is Go: expected failures are values (concrete error types, matched with
  `errors.As`), never thrown across a port; no package-level mutable state; `context.Context` first parameter.
- The npm workspaces (`packages/plugin-test`, the provider plugins' tests) are TypeScript strict, with
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- ESM with `.ts` specifiers; no `any`; no default exports; no enums.

**Structure.** A functional core and an imperative shell:

- every decision lives in `internal/domain/` or `internal/app/` and is unit-tested with fakes;
- adapters only do I/O and are integration-tested against real git, real processes and temp filesystems.

**Quality gates.**

- the engine: gofmt clean, `go build`/`go vet` on Linux and on macOS, `go test -race` with the coverage gate
  (domain ≥ 95% statements, everything else ≥ 90%), the four-target build (`packages/core/scripts/build`);
- a provider plugin: `vp check` (Oxfmt formatting, Oxlint rules, type checks), `vp test` (plain), no `it.todo`,
  and `dist/run` fresh (the committed launcher matches a fresh build);
- from the root, `check:siblings` first: every file of kimi, deepseek, minimax and qwen must match zai's after the
  provider's names are replaced, except for differences `scripts/check-siblings.mjs` lists with a reason.

**Shared test suites.** The checks every provider plugin must pass live in `packages/plugin-test`
(`@muhmdraouf/plugin-test`) and are called from each plugin; every one of them drives the plugin-core binary
(host-built by `packages/core/scripts/host-build.sh` when missing):

- `describePluginSurface`: commands, agents, hooks;
- a bundle smoke suite: the plugin's `dist/run` launcher starts the installed binary;
- a fresh-install suite: the plugin in a clean plugin cache, its launcher on the installed binary.

A cross-plugin provider test in core (`internal/providers`) holds the naming scheme, unique ports, env
prefixes, agents and model prefixes. The full CLI end-to-end suite (golden transcript, epipe, follow, orphan) runs
once, on zai, against the binary.

**Exit codes.**

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | unexpected error |
| 2 | usage |
| 3 | verdict not pass |
| 4 | not found |
| 5 | landing refused, nothing applied |
| 6 | not ready (setup) or no live driver |
| 130 | follower interrupted (the job keeps running) |

---

## 4. Usage

### 4.1 Install

```text
/plugin marketplace add MuhmdRaouf/claude-code-plugins
/plugin install zai-plugin-cc@muhmdraouf          # and/or kimi-, deepseek-, minimax-, qwen-plugin-cc
```

Every provider plugin declares `huddle` as a dependency, so installing one installs
[huddle](https://github.com/MuhmdRaouf/huddle) with it — no extra command. `claude plugin uninstall
zai-plugin-cc@muhmdraouf --prune` removes huddle again once no installed plugin needs it.

### 4.2 Provider plugins

- Every provider plugin has the same surface, under its own prefix (`/zai:`, `/kimi:`, `/deepseek:`, `/minimax:`,
  `/qwen:`). The examples use zai.
- There is no `zai` (or `kimi`, …) command on your `PATH`. The commands are slash commands; the job CLI is reached
  through the plugin's launcher (section 4.3).
- Only `/zai:review` takes an argument (a job id). The shared surface test holds every command's front matter to that.

To start:

1. Install the plugin.
2. Restart Claude Code.
3. Run `/zai:setup`.

| Command | What it does |
|---|---|
| `/zai:setup` | Asks what to set up (built-in only, or built-in plus other tools), then runs it. Details below. |
| `/zai:setup:claude` | The built-in setup alone, with no questions. |
| `/zai:setup:omp`, `:setup:opencode`, `:setup:pi`, `:setup:zcode` | The built-in setup, then a check of that tool and the watcher question. Details below. |
| `/zai:remove` | Turns the plugin off. Run it, then `/plugin uninstall zai-plugin-cc@muhmdraouf`. |
| `/zai:board` | Only GLM activity: sessions, subagents and background jobs. Details below. |
| `/zai:usage` | Estimated cost, tokens per model, the job ledger, router health and a model advisor. Details below. |
| `/zai:review [id]` | Reviews a job awaiting a decision and carries it out: accept, return with feedback or discard. With no id it picks from the jobs awaiting review. |

**`/zai:setup`** asks, every time, what to set up:

1. **Built-in only (Claude Code agents and /model)** or **Built-in plus other tools (omp, opencode, pi, zcode)**.
2. Which of those tools. Each is labelled installed or not found, from the read-only `setup --engines`.
3. It runs the built-in setup, then each chosen tool's check and watcher question, as `/zai:setup:omp` does.

- A tool enabled before but not chosen stays enabled.
- The report leads with an outcome line (`ready`, `not routed` or `not ready`). When something changed, it ends with a
  restart line.

**The built-in setup,** in order:

1. Find the key. If there is none, or Z.ai refuses it, open a one-time local page to enter it.
2. Ping the provider once.
3. Start the router: a background process the plugin starts and repairs itself.
4. Add GLM 5.3 and GLM 5.3 Flash to `/model`.
5. Point Claude Code at the router and switch the agents to GLM.

**`/zai:setup:omp`, `:setup:opencode`, `:setup:pi`, `:setup:zcode`** do everything `/zai:setup:claude` does, then:

1. Check that tool as the user set it up: the binary on `PATH`, its version, and a one-word smoke run on the tool's
   own login, provider and model. No request goes through the zai router.
2. If all is ready, always ask one question, "Who should watch omp runs?": the provider's main model (GLM 5.3) or
   Claude Sonnet.
3. Record the answer in `engines.json` and point the tool's wrapper agent at that model.

- Running the command again switches the watcher. It never disables another engine.
- The plugin does not set the tool up. If the smoke run fails, the user logs in or configures it themselves and runs
  the command again.

**`/zai:remove`** turns the plugin off:

- agents back on their models before setup;
- GLM out of `/model`;
- the base URL taken out of settings;
- router retired: it keeps serving the sessions already open and exits once they close;
- stored key removed.

**`/zai:board`** shows only GLM activity:

- Every session and subagent that answered on a GLM model in the last two days, with requests, tokens and last seen.
  Active means a request in the last minute.
- Background jobs, including jobs running on an engine. KIND is the engine, with its pid while it runs.
- A running job can be stopped from here. Session and subagent rows are view-only.

**`/zai:usage`**, top to bottom:

- One estimated cost for today, 7 days and 30 days, and how the 30 days split between agents and `/model` and jobs.
- GLM tokens and estimated cost per model for each window, from the router's records.
- The job ledger of the repository.
- One row per engine that ran jobs, as that tool reports it (MODEL column; `-` when the tool names none; not in the
  total).
- A router-health line: the last 24 hours of the router's health events (fallbacks, refusals, rate limits, restarts,
  budget stops).

Prices:

- They come from one table in the engine (`packages/core/internal/render/prices.go`).
- Every entry names the provider's pricing page and the day it was read. The report prints that day.
- A model with no list price counts as $0 and is listed as such, rather than priced wrong.

The model advisor:

- It follows when it has enough to go on: 10 main-model runs in 30 days, 3 of them light, a saving of at least a cent.
- A light run is a job not in edit mode, or at most 10 turns or requests and 4000 output tokens.
- It prices the light runs on the flash model too, and suggests `model: flash` or the flash agent.
- It is worded as an estimate and changes nothing.

| Agent | What it is |
|---|---|
| `zai:glm-5.3` | An ordinary Claude Code subagent on `glm-5.3`: implementation, refactors, tests, bulk edits |
| `zai:glm-5.3-flash` | The same on `glm-5.3-flash`, read-only: sweeps, inventories, lookups |
| `zai:omp`, `zai:opencode`, `zai:pi`, `zai:zcode` | Wrappers that hand a task to that engine as a verified job and watch it; they run on Sonnet or on the provider's model, as the watcher choice says. Until the engine is enabled they say so and run nothing. |

Agents are named by the real model id. The other providers follow the same rule:

- kimi: `kimi:kimi-k3` and `kimi:kimi-k2.6`;
- deepseek: `deepseek:deepseek-v4-pro` and `deepseek:deepseek-flash`;
- minimax: `minimax:MiniMax-M3` and `minimax:MiniMax-M2.7-highspeed`;
- qwen: `qwen:qwen3.8-max` and `qwen:qwen3.8-flash`;
- each with the four engine wrappers `<p>:omp`, `<p>:opencode`, `<p>:pi`, `<p>:zcode`.

Everyday use after setup:

- "use GLM for this" makes Claude start `zai:glm-5.3`;
- "use omp for this" makes Claude start `zai:omp`;
- `/model` → GLM 5.3 switches the whole conversation to GLM;
- everything else stays on Claude.

Hooks (`hooks/hooks.json`):

- SessionStart runs `setup --hook` (re-applies the setup, starts the session watchdog, 15 s budget) and
  `board --hook` (one line when jobs await review, 5 s).
- UserPromptSubmit, PreToolUse and SubagentStart run the ensure script (3 s).
- SubagentStop runs `usage --hook` (2 s), which tells the user which model the agent ran on.

The job system stays as the CLI for long, unattended, gated work. Of its commands, only `board` and `review` have
slash commands.

### 4.3 The job CLI

```text
zai run <brief.md|-> [--engine claude|omp|opencode|pi|zcode] [--flash] [--mode edit|exec|readonly] [--wait|--bg] [--json]
zai wait <id>…            zai batch <dir|glob|manifest> [--wait]     zai board [--all] [--watch]
zai show <id> [--follow]  zai review <id> [--diff|--summary]  zai accept <id> [--no-commit] [--force] [--no-verify]
zai return <id> <feedback…>   zai discard <id> [--reason <text>]   zai stop <id|--all>   zai usage
zai brief new <title> | lint <path>      zai setup [--remove] [--json]
```

- `zai` here is shorthand: no such command is on `PATH`.
- It is `sh "<plugin>/dist/run" zai.js <command>`, where `<plugin>` is the plugin's install directory
  (`${CLAUDE_PLUGIN_ROOT}` inside Claude Code).
- The launcher maps `zai.js` to the CLI entry of the pinned plugin-core binary and runs it: `/zai:setup` downloads
  and verifies the binary under `~/.agents/core/<version>/` (`AGENTS_CORE_HOME` moves it). Without it the launcher
  says why and exits 127. A hook that finds no binary exits 0 at once and starts one detached download — a lock in
  the version dir makes every hook share it, and a lock whose holder died or stalled 120 s ago is taken over — so
  the next hook in the session runs the installed binary.

A typical loop:

1. Write a brief.
2. Run `zai run brief.md --bg`.
3. Run `zai wait <id>` in the background.
4. Run `zai review <id>`.
5. Run `accept`, or `return <id> "<exact fix>"`.

For high-stakes landings, run a separate flash review job on the result first.

### 4.4 Keys

The lookup order is:

1. the environment variable (`ZAI_API_KEY`);
2. the OS store (macOS Keychain, Linux Secret Service);
3. the key file `~/.config/<p>-plugin-cc/env` (mode `0600`).

About the key file:

- The key is kept there only on a platform with no secret store (a headless Linux without a keyring).
- On a platform with a store, setup moves a key it finds there into the store.
- A key file other users can read is refused.

How the key travels:

- Only on stdin to `security -i` or `secret-tool`.
- Never in argv, logs, the spool or chat.
- A store write is accepted only after a read-back shows the same key.

**The one-time key page** (`packages/core/internal/authpage/`):

- It opens during `/<p>:setup` when there is no working key.
- Setup prints the URL, opens it in the browser and waits up to 9 minutes for the key, then goes on in the same run.
  The wait stays under the 600000 ms a Claude Code Bash call allows, so the rest of setup still fits in it.
- Setup exits 6 when no key arrives in time or the page ends without one (5 failed tries, or closed). Run it again.
- It links the provider's API-key page (`keysUrl` in the provider data).

Its protections:

- it binds 127.0.0.1 on an OS-chosen port, behind a single-use random path token;
- it checks the Host and Origin headers, a CSRF field and a 4 KiB body limit;
- it sends a strict CSP (one nonce'd style and one nonce'd script, the show/hide toggle) and loads no external
  resources; the form works without the script;
- its referrer policy is `same-origin`: under `no-referrer` Chrome sends `Origin: null` on the form's own POST, which
  the Origin check refuses;
- it allows 5 tries and lives at most 10 minutes;
- it stores the key only after a real ping: a key the provider accepts, or one it knows but holds back (a 429 or 402:
  rate limited, or out of balance);
  - that `limited` key is saved with a warning naming the top-up page;
  - setup treats a stored `limited` key the same way: it keeps it and warns, instead of asking for a new one.

Claude never asks for the key in chat and never reads or prints a key file.

---

## 5. Development

```sh
npm ci
npm run check                              # attribution, siblings, CI contracts, then npm workspaces
npm run check -w zai-plugin-cc             # one plugin
npm run build -w zai-plugin-cc             # rewrite plugin/dist/run (commit it)
npm run check:siblings                     # the five provider plugins still match (git and node only, no install)
claude --plugin-dir ./plugins/zai-plugin-cc/plugin
```

- Runners and actions are pinned: ubuntu-26.04, macos-26 and action commit SHAs. Dependabot proposes
  bumps weekly.
- Every job stops at 10 minutes; Go test runs carry a shorter `-timeout`, so a hang prints its stacks instead of
  using up the job's minutes.

**Releases** (`.github/workflows/release.yml`), on a tag `v<VERSION>` pushed by hand; no workflow creates tags:

- `Release: plugin-core` fails when the tag does not name the committed `packages/core/VERSION` or when
  `release/v<VERSION>.json` is missing: the releaser runs `go run ./scripts/build -manifest` and commits the
  manifest first;
- it rebuilds all four targets and compares every sha256 with the manifest (`go run ./scripts/build -check`), so
  only the pinned bytes are published;
- it builds `dist/` with `SHA256SUMS`, attests the binaries' build provenance, then runs `gh release create v<VERSION>`;
  the notes are the version's `CHANGELOG.md` section, the checksums and `Built reproducibly from <commit sha>.`,
  printed by `go run ./scripts/releasenotes`. A release needs its `CHANGELOG.md` section: CI fails a `VERSION`
  without one before the release runs.

## 6. Operations and failure modes

### 6.1 Why the router supervises itself

- `ANTHROPIC_BASE_URL` in the global settings points every Claude Code session at the router.
- So a dead router would refuse every Claude call.

Each risk and what answers it:

| Risk | Answer |
|---|---|
| The router process dies | the front restarts a dead worker at once; the hooks restart a dead front before the next prompt, tool call or subagent |
| The ensure hook resolves another state root than setup and the router | every caller resolves one root: `$<p>_STATE_DIR`, else `~/.agents/<p>`. `CLAUDE_PLUGIN_DATA` (set only for hooks) never picks it, and state an older build left in the data dir moves over once |
| Sessions stay pointed at a dead router | the base-URL guard removes the base URL when no router of the plugin can hold the port; the emergency passthrough takes the port when the main router cannot start |
| One router is a single point of failure for all Claude traffic | the router degrades to a pure Anthropic passthrough rather than fail, and `claude-*` traffic is never altered (chaos cases a–s) |
| A runtime path disappears under a running router | there is no OS service and no interpreter: each start runs the plugin-core binary from the state root, where it is copied so a plugin update or a deleted download never removes running code |
| Removing the plugin cuts off the sessions that are still open | the router retires instead of stopping: Claude traffic passes through until the `claude` processes from before the removal exit (7 days at most) |
| Power loss: the exit hook never ran, and the pid, lock, retired and handover records survive with no router running | the next session's SessionStart hook (or the next prompt's ensure hook) restarts the router inside its 3 s budget: a start lock whose holder is gone is taken over at once and any other leftover lock at 10 s, a stale pid record is overwritten, and a pid another program has reused is never trusted or signalled |
| A front hangs with its socket open: the port accepts, health never answers | ensure checks health, not a connect (a 1 s GET): a front of ours that stays silent for 5 s (marked in `<state>/router.silent`, one line per episode in router.log) is SIGKILLed and replaced; one slow second never kills, and a holder that is not ours is left alone, also named |
| A router dies mid-turn, between two hooks | PreToolUse runs ensure before every tool call, and the session watchdog (started at SessionStart, one per session) re-runs the check every 2 s and restarts the router within seconds until the session ends |
| A router dies with no trace in `router.log` | every exit the process can see writes one line (SIGTERM, SIGINT, SIGHUP, a panic, retire, uninstall, handover) and marks itself logged in `<state>/router.exit`; the next start reads the pid record and names a holder that is gone with no line and no marker (SIGKILL, the OS, a power loss) |

### 6.2 Quick checks

```sh
curl -s http://127.0.0.1:18787/zai-router/health            # {"ok":true,…}
sh plugins/zai-plugin-cc/plugin/dist/run zai-router.js status # one line: running (and its mode), not running, or port held by another program
grep ANTHROPIC_BASE_URL ~/.claude/settings.json
sh plugins/zai-plugin-cc/plugin/dist/run zai.js board --all
```

The router's own records are in the state root: `router/router.log` and `router-crash.log` (`~/.agents/zai/`).

**Take routing out entirely:** run `/zai:remove`.

**If Claude cannot connect and `/zai:remove` is not possible:**

1. Delete `env.ANTHROPIC_BASE_URL` from `~/.claude/settings.json` (or put back `~/.claude/settings.json.zai-backup`).
2. Restart Claude Code. Claude traffic then goes straight to Anthropic again.

**Before uninstalling a plugin:**

- Run `/zai:remove`, so Claude Code is back on Anthropic at once.
- If you skip it, the router undoes its settings on its own after the uninstall and retires (section 3.2).

### 6.3 Other failure modes

| Symptom | Cause | Fix |
|---|---|---|
| after a plugin update the router stays down and a command says "plugin-core `<version>` is not installed; run /zai:setup" (127) | the new release's binary is missing: the session-start download failed or was cut short | nothing to do: any hook starts one detached download (locked in the version dir, so one download serves every hook), and a later hook in the session runs the installed binary; `/zai:setup` forces it at once |
| a GLM request fails with "key refused or missing: run /zai:setup" (a 400, not retried) | Z.ai refused the key, or there is none | rerun `/zai:setup` (opens the key page); Claude models are not affected |
| a GLM request fails naming a top-up page (a 400, not retried) | the Z.ai account is out of balance or quota | top up at the page named (`https://z.ai/manage-apikey/billing`), then retry |
| a GLM request fails with "budget reached for this `<period>`" (a 400, not retried) | a radar budget with action `stop` covers zai (or `total`) and is spent | raise or remove it in radar's dashboard (radar is part of [huddle](https://github.com/MuhmdRaouf/huddle)), or wait for the period to end |
| a GLM request fails with "was removed: restart Claude Code" (a 400, not retried) | zai was removed or uninstalled while this session was open; its retired router still serves Claude models | restart Claude Code, or run `/zai:setup` to turn zai on again |
| GLM requests answer 503 naming `/zai:setup` | the router is degraded or in emergency mode; Claude traffic is unaffected | wait a minute for the next worker, or run `/zai:setup`; check `status` and `router-crash.log` |
| 429s, slow jobs | provider rate limit | AIMD lowers concurrency automatically; lower `ZAI_MAX_CONCURRENCY` |
| job `stale` | its driver died | `zai stop <id>` then `return` or `discard` |
| `land_verify_failed` at accept | gates fail in a fresh checkout (often a base older than main) | return with the failing output, or cherry-pick and fix by hand |
| GLM model missing in `/model`, or agents still on Sonnet right after setup | settings not merged, or Claude Code not restarted (the session that ran setup keeps using Anthropic until it restarts) | rerun setup, restart Claude Code |
| agents run on Sonnet | the router is down or the key is gone, so the fallback holds | rerun `/zai:setup`; its report names the failing check |
| `setup:omp`, `:opencode` or `:pi` fails on the smoke line | the tool is not logged in or configured (the plugin uses it as it is) | run the tool once yourself and set up its provider and model, then rerun the command |
| setup says `not routed`, or "kept ANTHROPIC_BASE_URL" | it points at your own proxy, which setup never overwrites, so the agents run on Sonnet | point your proxy at the router, or remove the entry yourself and rerun setup |
