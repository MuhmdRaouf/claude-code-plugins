# The muhmdraouf plugins: code, layout, usage, architecture

- Covers every plugin in `MuhmdRaouf/claude-code-plugins` (marketplace `muhmdraouf`).
- For each one: what it is for, how it is built, how to use it and how it fails.
- Status marker: **[main]** means on `main` today.

---

## 1. What is in the marketplace

| Plugin | One line | Runtime | Status |
|---|---|---|---|
| `zai-plugin-cc` | Run Z.ai GLM models inside Claude Code as normal models, plus verified background jobs | Bun ≥ 1.3 (default) or Node ≥ 22 | [main] |
| `kimi-plugin-cc` | The same for Moonshot Kimi | Bun ≥ 1.3 (default) or Node ≥ 22 | [main] |
| `deepseek-plugin-cc` | The same for DeepSeek | Bun ≥ 1.3 (default) or Node ≥ 22 | [main] |
| `minimax-plugin-cc` | The same for MiniMax | Bun ≥ 1.3 (default) or Node ≥ 22 | [main] |
| `qwen-plugin-cc` | The same for Alibaba Qwen | Bun ≥ 1.3 (default) or Node ≥ 22 | [main] |
| `huddle` | Channels where Claude sessions, their subagents and shell agents work as one team | Bun ≥ 1.3 (default) or Node ≥ 22.5 | [main] |
| `radar` | Zero-token local dashboard of sessions, agents, requests, tokens, estimated cost, budgets and routing | Bun ≥ 1.3 (default) or Node ≥ 22.3 | [main] |

Plus one thing that is not a plugin: `packages/core`, the shared engine.

**The five provider plugins**

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

**Delegation tools** (omp, opencode and pi, section 3.4) are not provider data:

- Every provider plugin offers all three.
- Each tool runs as the user set it up, with its own login, provider and model.
- The plugin never names a provider to a tool and never passes it a key.

**Overrides.** Model ids, base URL and router port can change per provider without a release:

- `<PREFIX>_MODEL_MAIN` and `<PREFIX>_MODEL_FLASH` replace the model ids;
- `<PREFIX>_BASE_URL` replaces the endpoint;
- `<PREFIX>_ROUTER_PORT` moves the router; `<PREFIX>_ROUTER_URL` points the router alone at another endpoint;
- `<PREFIX>_OMP_BIN`, `<PREFIX>_OPENCODE_BIN` and `<PREFIX>_PI_BIN` name an engine binary that is not on `PATH`.

---

## 2. Repository layout

```
claude-code-plugins/
├── .claude-plugin/marketplace.json     the catalogue: one entry per plugin, source ./plugins/<project>/plugin
├── .github/workflows/ci.yml            path-filtered check jobs, the siblings drift guard, Node 22 / macOS / ubuntu-26.04 legs,
│                                       marketplace validation, gitleaks, the attribution check, and the final gate
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
├── packages/core/                      @muhmdraouf/core: private, never published; bundled into each plugin's dist
│   ├── ARCHITECTURE.md                 the job engine's detailed design
│   ├── src/
│   │   ├── domain/     pure logic: brief schema/defaults/duration, job + lifecycle state machine, verdicts, prompt
│   │   │               building (footer, failures, summary, fences), limiter (AIMD), usage, worker events,
│   │   │               stream parsing, report schemas, report-capture (the report protocol for engines that cannot
│   │   │               enforce a schema), state-layout (every state file's name), provider-balance (each
│   │   │               provider's out-of-balance answers), budget (the Radar budget stop), route-events
│   │   │               (the spool's line shapes), Provider + model catalog, engine ids
│   │   ├── ports/      interfaces: Worker (spec, run, capabilities), Git, GateRunner, JobStore, JobFiles, Semaphore,
│   │   │               LimiterStore, EngineConfigStore, RouteSpool, Clock, Ids, ProcessControl, Output; keys.ts
│   │   │               (ProviderKey, KeyStore, KeyVerdict, KeyEntry)
│   │   ├── adapters/   thin I/O: claude-headless worker, claude-settings (the settings.json merge),
│   │   │               engines/{omp-rpc, opencode, pi-rpc, shared}, keystore/{macos, linux, windows, file, port, index},
│   │   │               key.ts (key lookup), env allowlist, state-root.ts (the state-root rule), fs-files.ts (the one
│   │   │               atomic write and JSON read), fs-store/job-files/engine-config/lock/semaphore/limiter,
│   │   │               git-{cli,land,apply,run,snapshot,…}, shell gates, process/{stream, lines, group, orphan,
│   │   │               detached, port, tool}
│   │   ├── app/        use cases: submit, drive (run → verify → auto-fix), attempts, decide/decide-land
│   │   │               (accept/return/discard), batch, queries (board/show/usage), activity (board rows and
│   │   │               router health from the spool), advisor (the flash-model advisor), follow (wait), cleanup,
│   │   │               ping, engine-select/-reap
│   │   ├── auth-page/  the one-time local key page: server, html, check (the real ping), entry
│   │   ├── render/     pure text: board, job, review packet, summary, usage, wait, next steps, the price table
│   │   ├── router/     front.ts (the process that owns the port), worker.ts + router.ts (the provider logic),
│   │   │               emergency.ts + passthrough.ts (never-fail Anthropic pipe), ensure.ts (hook check),
│   │   │               process.ts (start, update, hand over), service.ts (the bundle's entry), upstream.ts (HTTP
│   │   │               plumbing, proxy), refusal.ts (key, balance and budget refusals), budget.ts (reads
│   │   │               Radar's budget status), registry.ts (peers), spool.ts + spool-write.ts (route and
│   │   │               health events), ledger.ts + uninstall.ts (undo on uninstall/disable), legacy.ts (retires an
│   │   │               OS service left on disk), pidfile.ts, crashlog.ts
│   │   └── cli/        argument parsing, commands/ (one module per command: setup, setup-key, auth-serve,
│   │                   engine-setup, run, batch, decide, queries, wait, brief, mode), exit codes, route.ts (setup
│   │                   wiring), engine-wire.ts, wire.ts (composition root shared by all plugins)
│   └── test/           test/support = fakes, builders, reference provider, fake claude, and the suites every
│                       provider plugin shares (plugin surface, bundle smoke, fresh install);
│                       test/router/chaos.test.ts = the router fault suite (section 3.2);
│                       test/architecture/layers.test.ts = the allowed import direction between the layers above
│
├── plugins/<p>-plugin-cc/              one per provider (zai, kimi, deepseek, minimax, qwen), identical shape
│   ├── src/provider.ts                 the provider as data (the only provider-specific code)
│   ├── src/cli/main.ts                 CLI entry: wires core with the provider
│   ├── src/router/main.ts              router entry: `<p>-router run|start|stop|status`
│   ├── src/router/ensure.ts            entry of the small hook script that checks the router is alive
│   ├── src/router/passthrough.ts       entry of the emergency passthrough bundle
│   ├── scripts/build.mjs               esbuild bundles (+ --check for freshness), scripts/no-todos.mjs
│   ├── test/                           provider test, plugin-surface test, bundle smoke and fresh-install tests
│   │                                   (Node and Bun); zai also: the full CLI end to end (golden transcript, CLI,
│   │                                   epipe, follow, orphan)
│   ├── README.md                       the five READMEs are the same text apart from the provider's names
│   └── plugin/                         THE INSTALLED PLUGIN (the only folder Claude Code copies)
│       ├── .claude-plugin/plugin.json  name (zai, kimi, …), version, author, license
│       ├── commands/                   setup.md, board.md, usage.md, review.md, remove.md and
│       │                               setup/{claude,omp,opencode,pi}.md
│       ├── agents/                     two model agents (zai: glm-5.3.md, glm-5.3-flash.md) and three engine wrappers
│       │                               (omp.md, opencode.md, pi.md)
│       ├── hooks/hooks.json            SessionStart: `setup --hook`, `board --hook`;
│       │                               UserPromptSubmit and SubagentStart: `<p>-ensure.js`;
│       │                               SubagentStop: `usage --hook`
│       └── dist/                       committed esbuild bundles, so installs need no build:
│                                       <p>.js (CLI), <p>-router.js, <p>-ensure.js, <p>-passthrough.js,
│                                       and `run`, the sh launcher every hook, command and agent uses
│                                       (bun when on PATH or in ~/.bun/bin, else node)
│
├── plugins/huddle/                     Bun project (runs on Bun or Node), outside the npm workspace, own bun.lock
│   ├── plugin/
│   │   ├── .claude-plugin/plugin.json, .mcp.json (huddle-mcp bridge)
│   │   ├── bin/                        huddle.ts (CLI), huddle-mcp.ts (MCP stdio bridge), serve.ts (up/down/server),
│   │   │                               setup.ts, identity.ts (settings, port), creds.ts (this session's
│   │   │                               credential), feed.ts, touch.ts (reports file edits)
│   │   ├── dist/                       committed bundles of the CLI, the bridge, the server and each hook
│   │   ├── hooks/                      hooks.json, session-start.ts, listen.ts, approve.ts, stop.ts, quiet.ts
│   │   │                               (never fail)
│   │   ├── server/                     server.ts, src/{hub,channel,store,ops,mcp,auth,lifecycle,port,rt,links}.ts,
│   │   │                               src/{rules,notify,radar,digest,touches,knowledge,extras}.ts,
│   │   │                               src/ext/{repo,views}.ts, public/ (index.html, *.js, src/app.css →
│   │   │                               compiled app.css), CONNECT.md
│   │   ├── commands/{setup,join,invite,open}.md, agents/huddle-worker.md, skills/huddle/SKILL.md
│   ├── bin/rehearse                    end-to-end rehearsal script
│   └── tests/                          bun tests (auth, channel, hooks, http, identity, lifecycle, port, …) and
│                                       tests/node/ (the Node leg and the fresh-install check)
│
└── plugins/radar/                runs on Bun or Node; its own Bun project (bun.lock), not an npm workspace
    ├── src/{cli,hook,ingest,lifecycle,server,shared,store,ui}/   the CLI, the hook recorder, spool + transcript
    │                                   ingest, the removal watcher, the HTTP server, the in-memory store, the
    │                                   page (Preact, built by Vite)
    ├── src/{alerts,budget,cost,router}/   the alerts engine and its notifications, budgets, prices + usage ledger
    │                                   + attribution + model advisor, router health from the spool
    ├── scripts/                        build.mjs, no-todos.mjs, smoke.mjs (end to end against the built CLI)
    ├── test/                           unit, server and hook-process tests; scripts/runtime-leg.mjs runs the bundle
    │                                   under Bun and under Node
    └── plugin/                         commands/{start,open,status,stop}.md, hooks/hooks.json,
                                        dist/{radar,hook}.js, public/ (compiled page)
```

---

## 3. Architecture

### 3.1 The big picture

```
             ┌───────────────────────── your machine ───────────────────────────┐
  you ──▶ Claude Code session(s) ──ANTHROPIC_BASE_URL──▶ provider router(s)      │
             │  /model: Opus, Sonnet,      (127.0.0.1:18787 zai, :18788 kimi …)  │
             │  GLM 5.3, GLM 5.3 Flash      │                                    │
             │  subagents zai:glm-5.3 …         ├─ claude-*  ──▶ api.anthropic.com (untouched)
             │                              ├─ glm-*     ──▶ api.z.ai (zai key)  │
             │                              ├─ kimi-* …  ──▶ peer router :18788 (one hop)
             │                              └─ route event ──▶ radar spool │
             │                                                                   │
             │  jobs: `zai drive <id>` (detached) ── claude -p ─────▶ api.z.ai   │
             │          or omp / opencode / pi, on their own setup ──▶ their model│
             │            └── git worktree, gates, verdict ──▶ review/accept     │
             │                                                                   │
             │  huddle server (Bun or Node, random 5-digit port per project,     │
             │                 SQLite file per channel) ◀── MCP/CLI/hooks        │
             │  radar server (Bun or Node, random 5-digit port, kept)      │
             │                                          ◀── hooks/spool          │
             └───────────────────────────────────────────────────────────────────┘
```

Three independent mechanisms. Each one works without the others:

1. **Native routing** (the router): provider models become ordinary Claude Code models.
2. **Background jobs** (the engine): detached, gated, worktree-isolated work with a verdict.
3. **Coordination and observation**: huddle (talking) and radar (watching).

### 3.2 The router

- One router per provider plugin, in `packages/core/src/router/`.
- One background process that the plugin itself starts and keeps alive.
- No launchd, systemd or other service to install.
- Works the same on macOS, Linux and Windows.

**Parts.**

- **The front** (`front.ts`) is the process the plugin starts.
  - It owns `127.0.0.1:<port>` for as long as it runs and never lets go.
  - It holds no provider logic and no key.
  - It hands each request to a worker over loopback.
- **The worker** (`worker.ts` + `router.ts`) is the provider logic.
  - The front forks it with `node:cluster`; it listens on its own loopback port.
  - It is disposable. It reports a heartbeat and its memory size to the front every second.
- **The runtime** is whichever started the router: Bun by default (≥ 1.3), Node (≥ 22) as the fallback.
  - The front's `node:cluster` forks its workers on the same one.
  - Every server listens on its own port. A handover's temporary port is a second server, not a socket handed over.
  - Every server tracks and closes its own sockets. Why: Bun 1.3 serves no socket handed to a server that does not
    listen, and Bun's `closeIdleConnections()`/`closeAllConnections()` leave idle keep-alive sockets and streaming
    responses open.
  - The chaos suite runs once per runtime.
- **The emergency passthrough** (`emergency.ts`, bundle `<p>-passthrough.js`) is a pure Anthropic pipe.
  - Built from Node built-ins only.
  - It takes the port when the main router cannot start at all (a broken bundle, a syntax error).
- **The ensure script** (`ensure.ts`, bundle `<p>-ensure.js`) is what the hooks run to check the router is alive.

**Subcommands** of the bundle's entry (`service.ts`): `run | start | stop | status`.

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
- **Errors.** Failures come back in Anthropic's error shape, so Claude Code shows a readable message.
- **Refusals Claude Code can act on** (provider routes only).
  - Why: Claude Code reads a 401 as its own Anthropic login failing, and retries 429s and 5xx errors for minutes.
  - So the router rewrites two cases into a 400 with `x-should-retry: false`:
    1. The provider answers 401 or 403, or there is no key: `<Display> key refused or missing: run /<p>:setup`.
    2. The provider says the account is out of balance (Z.ai 1113, 1316, 1317; Moonshot
       `exceeded_current_quota_error`; DeepSeek 402; MiniMax 1008; DashScope `Arrearage` and `isv.OUT_OF_SERVICE`): a
       message naming the provider's top-up page (`billingUrl` in its `provider.ts`). Answered at once, not retried.
  - The top-up pages:
    - zai: `https://z.ai/manage-apikey/billing`
    - kimi: `https://platform.kimi.ai/console`
    - deepseek: `https://platform.deepseek.com/top_up`
    - minimax: `https://platform.minimax.io/user-center/payment/balance`
    - qwen: `https://usercenter2-intl.aliyun.com/billing`
  - No upstream text is copied into either answer.
  - Any other provider error that quotes the key has it blanked out.
  - `claude-*` and peer answers are never touched.
- **Budgets.** When the radar plugin runs, it writes `budget-status.json` in its state root
  (`$RADAR_HOME`, else `~/.agents/radar`; section 4.6).
  - The worker reads it at most every 5 seconds.
  - While it lists `provider:<p>` or `total` as stopped, the provider's models get the same non-retryable 400:
    `<Display> budget reached for this <period>: raise or lift it in the Radar dashboard (/radar:open)`.
    The period comes from `budgets.json`.
  - The check comes before the key lookup.
  - A missing, unparsable, oversized, non-regular or stale (over 10 minutes old) file stops nothing.
  - `claude-*` is never checked against it (`domain/budget.ts`, `router/budget.ts`).
- **The key** is read only for a provider request, only by the worker, under a 2 second budget.
  - A missing key answers the provider's models with the 400 above; a hung lookup answers 503.
  - Neither touches `claude-*`.
  - The key is never in a log, the crash log, the spool, the ledger, the health answer or an error body. The chaos
    suite sweeps all of them for a sentinel key.
- **Peers.** Each router registers itself in `~/.agents/provider-routers/<name>.json`.
  - A router that receives another provider's model id forwards it once to that provider's router.
  - The forward carries the header `x-provider-router-hop: 1`. A second hop is refused with 508.
  - A dead peer returns 502 naming `/<p>:setup`, and fails only that peer's models.
  - Result: all five plugins can be set up together while Claude Code points at only one base URL.
- **Route events.** One JSON line per routed request goes to `~/.agents/radar/spool/<date>.jsonl`.
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

**Limits and upstream plumbing** (`upstream.ts`, shared by every router process).

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
- **Starting.** `startRouter` (`process.ts`) is used by setup, the SessionStart hook and the ensure hooks. In order:
  1. retire an OS service for the router, if one is on disk (below);
  2. probe the port, and never touch a server someone else owns;
  3. take an atomic lock, so two hooks starting at once start exactly one router;
  4. copy the bundles into `<state>/router` (mode `0700`), so a plugin update or uninstall never deletes the code that
     is running;
  5. spawn the front detached and wait for its health;
  6. fall back to the emergency passthrough when it will not start.

  `<state>/router.pid` (mode `0600`) records the pid, port, bundle version, front protocol, main or emergency mode and
  the token its control endpoints require.
- **Hooks.** `UserPromptSubmit` and `SubagentStart` run `<p>-ensure.js`.
  - It tries a TCP connect to the port for 100 ms.
  - Only when that is refused, it starts `<p>-router.js start` detached and returns at once.
  - It prints nothing and always exits 0. A router that died mid-session is back before the next prompt or subagent.
  - It does nothing for a plugin that was never set up.
- **A port that someone else holds.**
  - The router never kills or takes over a foreign server.
  - The base-URL guard removes this plugin's base URL from `settings.json` when no live router of the plugin's can
    hold the port. The next session talks to Anthropic directly.
- **Retiring on removal.** A Claude Code session reads `ANTHROPIC_BASE_URL` once, when it starts, so every session
  already open keeps sending to the router after a removal. The router therefore retires instead of stopping:
  - `/<p>:remove` sends the front a `POST <health>/retire` control call (loopback and the pid file's token), and
    moves `router.pid` to `router.retired`; the uninstall watch retires the front the same way (below).
  - A retired front drains its worker, passes every other request to Anthropic exactly as it came, and answers this
    provider's models, peers' models and peer hops with a 400 that is not retried: "<Display> was removed: restart
    Claude Code to stop using its router".
  - It writes one `router.event` line (`restart`) to the spool and nothing after it, and takes its registry entry out.
  - Every 30 s it reads `ps -axo pid=,lstart=,args=`. A Claude Code session is a command line whose program is
    named `claude`, or one that runs `@anthropic-ai/claude-code/cli.js` under node or bun (command lines, because
    Linux names a Node process's main thread `MainThread`).
  - It exits once no Claude Code session that started before the retirement is left, after 7 days in any case, or on
    SIGTERM.
  - A later setup hands the port over to a fresh front (the handover, no gap); a second remove leaves it as it is.
  - On Windows, for the emergency passthrough, or when the retire call fails, remove stops the router instead.
- **Records,** under the state root:
  - `router.log` (rotating);
  - `router-crash.log`: one JSON line per crash or supervision event, the last 1 MiB kept.
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
`legacy.ts` is the only file that names those tools. It:

1. stops the service;
2. starts the router on the same port;
3. removes the unit only once the router answers health.

- If the router does not come up, the service is started again and left alone, and the report says so.
- Nothing in the repo installs or depends on an OS service.

**The chaos suite** (`packages/core/test/router/chaos.test.ts`) checks that Claude traffic never fails.

- It runs the real router processes with a fake Anthropic and a fake provider, and injects one fault per case.
- It runs once per runtime: node, then bun in `npm run test:bun`.
- It runs as its own Vitest project, after every other test file.
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
- `env.ANTHROPIC_BASE_URL`:
  - set to the router when it is unset, or already points at one of the five plugin routers;
  - moved to this one when it points at another plugin's router that is not running;
  - any other value is your own proxy: it is reported and never overwritten.

How the merge behaves (`adapters/claude-settings.ts`):

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
- `not routed`: `ANTHROPIC_BASE_URL` is the user's own proxy, so nothing reaches the router and the agents run on
  Sonnet. The line names the fix.
- `not ready`: a `FAILED` line says which check failed.

When the run changed `settings.json` or an agent, the report ends with the restart line.

**Subagents, hooks and removal:**

- **Subagents.** Claude Code sends each subagent's frontmatter `model:` id.
  - `setup` rewrites the plugin's agents to the provider's model ids when the router is up.
  - It sets them back to `sonnet` when the router is down or the key is gone.
  - Agents set to `glm-5.3` run on GLM; every other subagent stays on Claude.
- **The SessionStart hook** (`setup --hook`, 15 s budget):
  - re-applies all of it after a plugin update and brings the router up;
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
  - takes the plugin's `/model` entries and base URL out of `settings.json`;
  - retires the router (section 3.2): open sessions keep working through it until they close;
  - deletes the stored key.
  - Uninstalling is then `/plugin uninstall <p>-plugin-cc@muhmdraouf`.
- **Identifying traffic.** This is how the router, board and radar attribute traffic to a session or a subagent:
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

**The brief.** A brief is Markdown with YAML front matter, validated by zod. Its fields:

| Field | Meaning |
|---|---|
| `title`, `tags` | names |
| `mode` | `edit` (worktree + branch `zai/<id>`), `exec` (may run commands, must not change the repo; outputs to `$ZAI_ARTIFACTS`), `readonly` (plan mode) |
| `model` | `glm` or `flash` (or a model id) |
| `engine` | `claude`, `omp`, `opencode` or `pi` (see Engines) |
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

```
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

**State** lives in `~/.agents/zai/`, or `$ZAI_STATE_DIR`, or the plugin's own data directory when Claude Code
provides one (an older `~/.local/state/zai/` moves over on the first start):

- `jobs/<id>/`, `worktrees/<id>`, `checkouts/<id>`;
- `slots/`, `router/`;
- `ledger.json`, `engines.json`.

**Engines.** The worker is behind a port (`ports/worker.ts`), so the tool that runs the model is swappable. All four
engines are [main]:

| Engine | How it is driven |
|---|---|
| `claude` (headless) | `claude -p --output-format stream-json`, session id/resume, native JSON-schema report. Always enabled; points at the provider's Anthropic-compatible endpoint. |
| `omp` | `omp --mode rpc`, JSON frames over stdio |
| `opencode` | `opencode run --format json` (one process per attempt, its exit is the turn boundary). opencode leaves a server child behind, so the rest of its process group is reaped after the run. |
| `pi` | `pi --mode rpc`. pi has no native report schema, so the report rides in the final assistant text and is checked twice, in the adapter and in core. |

All engines share these rules:

- Each runs in its own process group, apart from the driver's.
- Every engine's events are translated to the same `WorkerEvent`s, so drive, gates, review and the decisions stay
  engine-agnostic.
- **omp, opencode and pi run as the user set them up.**
  - Their own login, provider, default model, extensions and config decide what runs.
  - The plugin names no model, provider, endpoint or key. It never writes their configuration and never reads it.
  - It starts the tool with the user's own environment, minus the plugin's key, the `<PREFIX>_` variables, and Claude
    Code's routing and session variables (which can point at a plugin router).
  - It adds only the job's access. opencode: its edit and bash permissions through `OPENCODE_CONFIG_CONTENT`, merged
    over the user's config. omp and pi: their tools narrowed where the job's access requires it.
  - All five provider plugins, qwen included, offer all three tools.
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

**The watcher.** Each engine has a wrapper agent (`zai:omp`, `zai:opencode`, `zai:pi`).

- The watcher setting decides which model runs that wrapper: the provider's main model (through the router) or Claude
  Sonnet.
- The wrapper turns a request into a brief, submits the job on its engine, waits for the verified result, and returns
  the review with the exact accept, return and discard commands.
- It never accepts, never edits files and never commits.
- The tool itself keeps running on its own model. The watcher only writes the brief, waits and reads the review.

### 3.5 Code rules (all npm packages)

**Language and style.**

- TypeScript strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- ESM with `.ts` specifiers; no `any`; no default exports; no enums.
- Expected failures are values (`Result<T,E>` with discriminated unions), never thrown across a port.

**Structure.** A functional core and an imperative shell:

- every decision lives in `domain/` or `app/` and is unit-tested with fakes;
- adapters only do I/O and are integration-tested against real git, real processes and temp filesystems.

**Quality gate (`npm run check`).**

- `tsc --noEmit`, `biome ci`, and `vitest --coverage` (domain ≥ 95%, overall ≥ 90%);
- no `it.todo`;
- for a plugin, `dist/` must be fresh (the esbuild output matches the committed bundle);
- the bun leg: `npm run test:bun` runs core's router chaos suite with every router process on bun, and a plugin's
  bundle tests with the bundles on bun;
- from the root, `check:siblings` first: every file of kimi, deepseek, minimax and qwen must match zai's after the
  provider's names are replaced, except for differences `scripts/check-siblings.mjs` lists with a reason.

**Shared test suites.** The checks every provider plugin must pass live in core and are called from each plugin:

- `describePluginSurface`: commands, agents, hooks;
- a bundle smoke suite;
- a fresh-install suite: the committed bundle in a clean plugin cache, on Node and on Bun;
- a cross-plugin provider test that holds the naming scheme, unique ports, env prefixes, agents and model prefixes.

Each plugin pins only its own data. The full CLI end-to-end suite (golden transcript, epipe, follow, orphan) runs
once, on zai.

**Mutation testing** (`npm run mutate`):

- Stryker runs on `src/domain`, with break threshold 90%.
- Only in `packages/core` and `zai-plugin-cc`. The other provider plugins have no logic of their own to mutate.

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

```
/plugin marketplace add MuhmdRaouf/claude-code-plugins
/plugin install zai-plugin-cc@muhmdraouf          # and/or kimi-, deepseek-, minimax-, qwen-plugin-cc, huddle, radar
```

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
| `/zai:setup:omp`, `:setup:opencode`, `:setup:pi` | The built-in setup, then a check of that tool and the watcher question. Details below. |
| `/zai:remove` | Turns the plugin off. Run it, then `/plugin uninstall zai-plugin-cc@muhmdraouf`. |
| `/zai:board` | Only GLM activity: sessions, subagents and background jobs. Details below. |
| `/zai:usage` | Estimated cost, tokens per model, the job ledger, router health and a model advisor. Details below. |
| `/zai:review [id]` | Reviews a job awaiting a decision and carries it out: accept, return with feedback or discard. With no id it picks from the jobs awaiting review. |

**`/zai:setup`** asks, every time, what to set up:

1. **Built-in only (Claude Code agents and /model)** or **Built-in plus other tools (omp, opencode, pi)**.
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

**`/zai:setup:omp`, `:setup:opencode`, `:setup:pi`** do everything `/zai:setup:claude` does, then:

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

- They come from one table in core (`render/prices.ts`).
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
| `zai:omp`, `zai:opencode`, `zai:pi` | Wrappers that hand a task to that engine as a verified job and watch it; they run on Sonnet or on the provider's model, as the watcher choice says. Until the engine is enabled they say so and run nothing. |

Agents are named by the real model id. The other providers follow the same rule:

- kimi: `kimi:kimi-k3` and `kimi:kimi-k2.6`;
- deepseek: `deepseek:deepseek-v4-pro` and `deepseek:deepseek-flash`;
- minimax: `minimax:MiniMax-M3` and `minimax:MiniMax-M2.7-highspeed`;
- qwen: `qwen:qwen3.8-max` and `qwen:qwen3.8-flash`;
- each with the three engine wrappers `<p>:omp`, `<p>:opencode`, `<p>:pi`.

Everyday use after setup:

- "use GLM for this" makes Claude start `zai:glm-5.3`;
- "use omp for this" makes Claude start `zai:omp`;
- `/model` → GLM 5.3 switches the whole conversation to GLM;
- everything else stays on Claude.

Hooks (`hooks/hooks.json`):

- SessionStart runs `setup --hook` (re-applies the setup, 15 s budget) and `board --hook` (one line when jobs await
  review, 5 s).
- UserPromptSubmit and SubagentStart run the ensure script (3 s).
- SubagentStop runs `usage --hook` (2 s), which tells the user which model the agent ran on.

The job system stays as the CLI for long, unattended, gated work. Of its commands, only `board` and `review` have
slash commands.

### 4.3 The job CLI

```
zai run <brief.md|-> [--engine claude|omp|opencode|pi] [--flash] [--mode edit|exec|readonly] [--wait|--bg] [--json]
zai wait <id>…            zai batch <dir|glob|manifest> [--wait]     zai board [--all] [--watch]
zai show <id> [--follow]  zai review <id> [--diff|--summary]  zai accept <id> [--no-commit] [--force] [--no-verify]
zai return <id> <feedback…>   zai discard <id> [--reason <text>]   zai stop <id|--all>   zai usage
zai brief new <title> | lint <path>      zai setup [--remove] [--json]
```

- `zai` here is shorthand: no such command is on `PATH`.
- It is `sh "<plugin>/dist/run" zai.js <command>`, where `<plugin>` is the plugin's install directory
  (`${CLAUDE_PLUGIN_ROOT}` inside Claude Code).
- The launcher uses bun when it is on PATH, else node.

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
2. the OS store (macOS Keychain, Linux Secret Service, Windows DPAPI);
3. the key file `~/.config/<p>-plugin-cc/env` (mode `0600`).

About the key file:

- The key is kept there only on a platform with no secret store (a headless Linux without a keyring).
- On a platform with a store, setup moves a key it finds there into the store.
- A key file other users can read is refused.

How the key travels:

- Only on stdin to `security -i`, `secret-tool` or PowerShell.
- Never in argv, logs, the spool or chat.
- A store write is accepted only after a read-back shows the same key.

**The one-time key page** (`packages/core/src/auth-page/`):

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

### 4.5 huddle

**Runtime.**

- Bun ≥ 1.3 (the default) or Node ≥ 22.5 on Claude Code's PATH.
- The hooks and the bridge use `bun` when it is there and `node` otherwise. `HUDDLE_RUNTIME=node|bun` forces one.

**Setup.** Run `/huddle:setup` once per project. It asks nothing:

1. It names the channel and the session after the project folder (arguments change that) and turns autostart on.
2. It writes `.agents/huddle/huddle.json` (kept out of git).
3. It starts the server and joins.

A session then joins its channel from that file (or `HUDDLE_CHANNEL` and `HUDDLE_AS`).

**Commands:**

- `/huddle:setup`: set up and start;
- `/huddle:invite`: make a join line for another session;
- `/huddle:join`: join with such a line;
- `/huddle:open`: a dashboard link that signs your browser in.

**A second project joins the Huddle that already runs.**

- `/huddle:setup` in a project with no settings, while this user already runs a Huddle, joins that one instead of
  starting another.
- `--new` starts a separate one on purpose.
- `--restart` restarts this project's own.

**The server and its port.**

- One server per project, started by `huddle up` (or by the SessionStart hook when autostart is on).
- It listens on `127.0.0.1` only.
- State lives in the project's `.agents/huddle/`: `huddle.json`, `data/channels/<name>.db` (one SQLite file per
  channel, WAL), `huddle.pid`, `huddle.log`.
- Repos can share one server by giving each `huddle.json` the same `"home"`.
- **The port is a random five-digit one per project.**
  - The first `huddle up` picks a free port (10000–65535) and saves it as `"port"` in the home's `huddle.json`.
  - It is reused on every start, so join commands and dashboard links keep working.
  - If another program later takes that port, the next `huddle up` picks a new one, saves it and says so.
  - A port of your own (`huddle setup --port <n>`, `huddle up --port <n>` or `HUDDLE_PORT`) is saved and never moved.
  - `huddle up`, `huddle server` and `huddle setup show` print the port.
- The UI is the server's own address, `http://127.0.0.1:<port>`, plain HTTP on loopback.

**How sessions get in (kubeadm style).**

- The session that starts the server is its **creator**. `huddle up` makes a root credential, hands it to the server
  on stdin, and keeps it as that session's own.
- The creator sees, once, a join line and a dashboard link.
- Every other session joins once with an invite: `/huddle:join <host:port> --token <id.secret>` (or
  `huddle join <host:port> --token <id.secret>` from a shell).
  - The invite is traded for that session's own credential, bound to its name.
  - So it acts only as itself and its subagents.
  - The invite itself is never kept.
- **Making invites:**
  - `/huddle:invite`, or the **Invite** button on the dashboard;
  - from a shell, `huddle token create [--ttl 2h] [--single-use] [--print-join-command]` (24 h by default);
  - `huddle token list` and `huddle token delete <id>` manage them;
  - inside Claude Code an invite reaches the user through a hook's `systemMessage`, never Claude's context.
- The creator also has `huddle members` and `huddle kick <name>` (revokes a session's credential and its browser).
- **Members are remembered across restarts.**
  - The server keeps its members, roots, browsers and unused invites in `data/auth.json` (mode `0600`).
  - It stores sha256 digests with public metadata, never the secrets.
  - A restart or a reboot keeps everyone in. A kick still revokes at once; an unused invite still expires on its TTL.
- **Session credentials.** A session keeps its credential in its own file under
  `${XDG_STATE_HOME:-~/.local/state}/huddle/sessions/` (mode `0600`), and also one for the project.
  - The project's next Claude session is in without a new invite.
  - `huddle up` hands a restarted server the creator's root credential again.
  - A session without a credential stays out: its hooks say nothing, and SessionStart prints one line telling it how
    to get in.
- **Every joined session gets a dashboard link** at each start. `huddle open` (or `/huddle:open`) makes a new one for
  any member.
  - The link carries a one-use code valid for 5 minutes.
  - It reaches the user through a hook's `systemMessage`, never Claude's context. Inside Claude Code the CLI prints
    only the plain address and leaves a request file that the next hook turns into the link.
  - A member's browser can read and act as `owner` in channels, but cannot manage invites, members or kicks.

**What sessions share:**

- **Events:** pub/sub with a cursor per session, so nothing is missed or read twice.
- **Tasks:** dependencies across sessions; `task.ready` wakes the waiting session.
- **Control:** pause and resume. A paused session cannot write.
- **Asks and replies.**
- **An optional turn**, for ping-pong work.
- **A knowledge store:** fact, lesson, decision, context, result, howto, searched with FTS5 (below).
- **Subagents as members:** they join as `<parent>.<role>`.
- **The map and the orchestrator:** a plan of phases and tasks, loaded with `import_plan`; fresh or sync join
  contexts.
- **File-conflict warnings:**
  - The PostToolUse hook reports each Edit, Write, MultiEdit or NotebookEdit as a path relative to its repo
    (`touches`, never the contents).
  - Two live sessions edit the same file in the same repo within 30 minutes: the editing session hears it once per
    file in its context, and the dashboard's Conflicts panel lists the file.
  - Nothing is locked or blocked.

**Knowledge is kept honest** (`server/src/knowledge.ts`):

- `verify` vouches for an entry (any session, or you in the dashboard); verified entries come first in `recall`.
- Every entry shows its age. It is marked "may be stale" when:
  - it was not written or verified for 30 days (`HUDDLE_KB_STALE_DAYS`);
  - or its `refs` name a file a session edited, or that changed on disk, since.
- `remember` adds nothing when an entry already says the same. It names that entry, to supersede or verify (`force`
  adds it anyway).
- `scope: "server"` on `remember`, or `share <id>` later, puts an entry in `shared.db` beside the channels (ids from
  100000). Every channel on this server recalls it: tool quirks, facts about the machine.
- `huddle knowledge export [--verified]`, or Export on the Knowledge page, gives the store as Markdown grouped by
  kind, to paste into a project's `CLAUDE.md`.

**What needs you:**

- **Desktop notifications.** A question to you, a paused session, an approval request or a task turning blocked
  notifies this computer as it happens.
  - `osascript` on macOS, `notify-send` on Linux when it is installed, nothing elsewhere.
  - The same kind about the same session or task notifies at most once every 10 minutes.
  - The text names sessions, tasks and rules only. Never a message body, a command or a file.
  - On by default. The dashboard's Settings or `huddle setup --no-notify` turn them off (`--notify` back on);
    `HUDDLE_NOTIFY=0` silences one server.
- **Approval rules,** per channel, in Settings.
  - On by default: force push, deleting files or branches.
  - Off by default: git push, git tag, publishing a package (npm, cargo, twine, gem, docker push, gh release, …).
  - Before a session runs a Bash command a rule that is on names, the PreToolUse hook answers Claude Code's own
    `permissionDecision: "ask"`. Claude Code shows its permission prompt in that session and you decide there. The
    request also lands in the Inbox and notifies you.
  - It never refuses and never waits. A command no rule names costs no network. A session outside a huddle, or a
    Huddle that does not answer within 0.6 s, gets the normal permission flow.
  - The command is never stored or logged.
- **Today.** The dashboard's Today view, `huddle digest [--since 24h]` and the MCP tool `digest` summarise, per
  session:
  - what got done (tasks finished, notes, knowledge added, permission requests);
  - what is blocked now;
  - the questions still open.
  - Built from the channel's history, with no model calls.
- **Radar.** When the radar plugin runs on the same machine:
  - the Inbox shows its stuck, loop, retry and budget alerts for the channel's sessions, with a button to pause the
    session;
  - Overview, Team and Today show the estimated cost per session;
  - Huddle finds it through `$RADAR_HOME/port` (default `~/.agents/radar`) and reads only its
    loopback `/api/alerts` and `/api/attribution`;
  - without it, those parts are not shown.

**Ways in:**

- the MCP tools (`mcp__plugin_huddle_huddle__*`), through the stdio bridge `huddle-mcp`:
  - only `status` and `join` are listed until the session is in a huddle, then the full set (`tools/list_changed`);
  - so an unconfigured plugin costs a few hundred tokens;
  - every call has a 10 s client deadline, or a blocking tool's own timeout;
- the CLI (`huddle join|wait|send|start|finish|remember|recall|pause|…`), with exit codes 0, 2, 3 (ask waiting),
  4 (paused), 5 (unreachable) and 124 (timeout);
- the hooks, all of which exit 0 whatever happens and log failures to `hooks.log` in the Huddle home:
  - SessionStart joins and puts the picture into context, on a 3 s budget;
  - the listen hook (PostToolUse and UserPromptSubmit) brings new messages into context, skips a subagent's own tool
    calls, folds task and knowledge events into one count line, and reports file edits for conflict warnings;
  - the approval hook (PreToolUse on Bash) asks for the commands the channel's approval rules name (above);
  - the Stop hook blocks a stop once per unanswered ask addressed to the session, never twice for the same ask and
    never for an ask older than an hour.

**The UI** is the owner's control room, in Catppuccin Latte and Mocha. Each channel has:

- Overview: the channel at a glance, with the Conflicts panel;
- Today;
- Inbox: open asks, approval requests, paused sessions, blocked tasks, radar alerts;
- Team: sessions, activity, pause/resume;
- Work: the tasks as a list, board, graph or map, and the repo views;
- Knowledge;
- Settings: notifications, approval rules.

Home lists every channel, and `⌘K` opens a command palette. Messages you send from it come from `owner`.

**Storage:** one SQLite file per channel (WAL); the server is the only writer.

**Security:** local and single-user, and it trusts credentials, not accounts.

- It binds 127.0.0.1 only and guards the Host header (421): `127.0.0.1:PORT` and `localhost:PORT` only, plus any
  listed in `HUDDLE_HOSTS`.
- Every `/api` and `/mcp` request needs a credential (`x-huddle-token`), or gets 401 with a recovery step.
- `/health` and the page itself stay open.
- A browser whose sign-in no longer works gets a "Signed out" page pointing to `/huddle:open`.
- A browser signs in through a one-time login link (5 minutes) that leaves an HttpOnly, SameSite=Strict cookie.
- Writes need JSON content-type (415) and a same Origin (403).
- The server redacts credentials, invites and login codes from what sessions write, and logs ids only.
- Events and knowledge are plain text in the database: do not put secrets in a channel.

**Uninstalling.** A server started by `huddle up` watches the plugin registry (every 10 s, two agreeing checks). When
the plugin is uninstalled or disabled, it stops itself:

1. finishes in-flight requests (up to 30 s);
2. checkpoints and closes every channel database;
3. removes `huddle.pid`, `huddle.log` and `data/auth.json` (who was in);
4. keeps `data/channels/*.db` and writes `LEFT-BEHIND.md` beside them.

It never touches a project's `huddle.json`.

### 4.6 radar

[main]. A mechanical dashboard that never calls a model or spends a token.

- Commands: `/radar:start`, `/radar:open`, `/radar:status`, `/radar:stop`.
- The same from a terminal (or with `node`):
  `bun plugin/dist/radar.js start|stop|status|url|open [--port N] [--since 24h] [--foreground]`.
- Once started, it comes back with the next Claude Code session after a reboot, until stopped.
- A SessionStart autostart tells the user in one message where the dashboard is (`RADAR_AUTOSTART=1|0`
  overrides).

**What it shows:**

- every session, as a tree of main agent and subagents, with zai jobs listed as external agents;
- each request: model, provider, upstream, latency, input/output/cache tokens, stop reason;
- each tool call, prompt, stop, compaction and notification;
- per-model totals;
- an **estimated cost** next to tokens everywhere (today's summary card, each session, agent, model and request):
  - from the price table in core at list price, cache reads and writes at their own rates;
  - a model the table does not know (every `claude-*` model) shows its tokens only, never a guessed figure.

**Tabs beyond the live views:**

- **Costs:** attribution by project, session, agent or model for today, the last 7 or 30 days.
  - Requests, tokens by kind and estimated cost, sortable, with CSV export.
  - The same is `GET /api/attribution?by=<project|session|agent|model>&range=<day|week|month>`.
  - It reads the usage ledger (`<state>/ledger/<day>.json`, 35 days): request ids, models, session and agent ids and
    token counts, never content.
- **Alerts** (also a strip on the overview, and `GET /api/alerts`):
  - each is dismissable until the same thing happens again;
  - an idle session waiting for you never raises one.

  The alerts:
  - `stuck`: a live session mid-turn with no request, tool result or agent event for 10 minutes (30 while a tool
    runs); after 6 hours of silence it counts as abandoned, not stuck;
  - `loop`: one agent calling the same tool with the same input 5 times in a row;
  - `retry_storm`: 5 or more 429 or 5xx answers within 2 minutes for one session or one provider router;
  - `context`: an agent's last request used 85% of its context window, with no compaction since;
  - `budget`: a budget at 80% of its limit, and again at 100%.
- **Router:**
  - each provider router's fallbacks, refusals, rate limits, budget stops and restarts over 24 hours, from the spool's
    `router.event` lines (section 3.2);
  - the recent events;
  - a model advisor that points at subagent runs on a main model that look flash-sized (at most 12 requests, under
    8000 output tokens, read-only tools only, no failures), with the estimated saving on the flash sibling. A hint,
    never a verdict.
- **Settings:** budgets and desktop notifications.

**Budgets.** Each budget has:

- a scope: `total`, or `provider:<plugin>` for a provider plugin seen in the data;
- a period: day, week from Monday, month;
- a limit in USD;
- an action at 100%: `warn` (an alert) or `stop`.

How they work:

- They live in `<state>/budgets.json`.
- Every 10 seconds radar measures the estimated spend against them and rewrites `<state>/budget-status.json`.
- A `stop` budget at or over its limit puts its scope in `stopped`. That provider's router refuses its models until
  the period ends (section 3.2).
- Claude requests are never stopped. With no budgets, nothing changes.

**Desktop notifications.**

- On by default for budgets at 80% and 100%, and for new stuck sessions and loops.
- `osascript` on macOS, `notify-send` on Linux when installed, nothing elsewhere.
- Each alert notifies once, one kind per session at most every 10 minutes.
- The text is only the project folder's name and what happened.
- Settings turns them off; `RADAR_NOTIFY=0` silences one server.

**Prometheus.** `GET /metrics` serves the text format, labelled by model, provider and project:

- requests, tokens by kind, estimated cost (from the ledger, so they survive restarts);
- API errors, a latency histogram, tool calls;
- router events, active alerts and budgets.

**Data sources:**

- **Command hooks.** Eight events (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`,
  `Stop`, `PreCompact`, `Notification`) each append one redacted, truncated line to `<state>/spool/<date>.jsonl`.
  - There is no hook per tool call: tool calls come from the transcripts.
  - Each hook exits 0 and prints nothing, except the one "dashboard at" line when SessionStart autostarts the server.
  - Each hook never touches the network and works whether or not the server runs.
  - Each logs its own failures to `<state>/hook-errors.log` (capped near 1 MB).
  - Without `bun` or `node` on Claude Code's PATH, every hook exits 0 at once.
  - The spool is capped at 64 MB; the oldest day goes first.
- **Transcript tailing.** The server tails the transcripts the spool names, plus every `*.jsonl` under
  `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/**` changed within the lookback (default 24 h), subagent sidechains
  included.
- **Router `route` and `router.event` lines**, which the provider routers write into the same spool (section 3.2).
- **zai job files** under `~/.agents/zai/jobs/`, when present.

**Server and UI:**

- **Address.** 127.0.0.1 only, on a random 5-digit port (10000–65535, drawn on the first start and retried), with a
  Host guard (403).
  - The port is saved in `<state>/port` and reused on every start, so a bookmark keeps working.
  - A new one is drawn only when another program holds it, and `start` says so.
  - `--port N` pins a port, never the bind address.
  - Server-sent events (`/api/stream`) carry live updates.
- **Methods.** GET and HEAD for everything, plus the dashboard's own three writes: `PUT /api/budgets`,
  `PUT /api/settings` and `POST /api/alerts/dismiss`. A write must:
  - be `application/json`;
  - come from the dashboard's own origin when the browser names one (`Origin` of `127.0.0.1:<port>` or
    `localhost:<port>`, `Sec-Fetch-Site` same-origin or none);
  - stay under 64 KiB.
  - Otherwise 403 (or 405, 413). There are no CORS headers.
- **Page.** Compiled Tailwind and vanilla TS, no CDN; Catppuccin Mocha or Latte following the system, with a switch.
- **Secrets are dropped** before anything is stored or served:
  - values of keys that look like key, token, secret, password, authorization or cookie;
  - `Bearer …` and `sk-…` strings;
  - the contents of `*.env` paths.
  - Prompts and tool inputs and outputs are truncated to 2 KB per field.
- **State** lives in `${RADAR_HOME:-~/.agents/radar}` (directory `0700`, files `0600`). The in-memory
  store is bounded (200 sessions, 200 000 events) and rebuilt from disk at start.

**Uninstalling.** Like huddle, the server watches the plugin registry and stops itself.

- On uninstall it deletes the state directory, but only when it carries radar's `.radar-state` marker. So
  a custom `RADAR_HOME` pointing somewhere else is safe.
- On disable it only stops, and keeps the history.

---

## 5. Development

```sh
npm ci
npm run check                              # check:siblings, then every npm workspace
npm run check -w zai-plugin-cc             # one plugin
npm run build -w zai-plugin-cc             # rebuild plugin/dist/*.js (commit it)
npm run check:siblings                     # the five provider plugins still match (git and node only, no install)
claude --plugin-dir ./plugins/zai-plugin-cc/plugin
(cd plugins/huddle && bun install && bun test && bun run css && bin/rehearse)
```

**CI** (`.github/workflows/ci.yml`), in five stages:

1. **Plan:** `Plan: what changed` reads a path filter and decides which projects to test. A manual run tests
   everything. A core change re-tests all five provider plugins.
2. **Repository rules**, on every push:
   - `Repo: provider plugins in sync`: the sibling drift guard;
   - `Repo: marketplace and plugins valid`: `claude plugin validate` on the marketplace and every listed plugin;
   - `Repo: no secrets in history`: gitleaks over every commit;
   - `Repo: no AI attribution in history`: `scripts/check-attribution.mjs` over every commit.
3. **Tests**, one job per changed project:
   - `Test: core`: `npm run check`, including the router chaos suite again on Bun;
   - `Test: <provider>-plugin-cc`: the shared surface suite, bundle smoke, fresh install, fresh bundle, then the
     bundle tests on Bun;
   - `Test: radar`: `check`, then the committed bundle started under Bun and under Node;
   - `Test: huddle (Bun)`: `bun test`, `bin/rehearse` and the fresh-install check;
   - `Test: huddle (Node 22.5)` and `(Node 24)`: the committed bundle with no Bun.
4. **Compatibility**, for core and zai, only after `Test: core` passes:
   - `Compat: Node 22`: the oldest Node the packages promise;
   - `Compat: macOS`: core and zai on macOS, the Bun leg and a real Keychain round trip (a throwaway item);
   - `Compat: Ubuntu 26.04 (preview, non-blocking)`: the next runner image; it never fails the build.
5. **Gate:** `All checks passed`, the one check branch protection requires. It fails when any job before it failed
   or was cancelled; a job the plan skipped counts as passed.

- Runners and actions are pinned: ubuntu-24.04, macos-15 and action commit SHAs. Dependabot proposes bumps weekly.

## 6. Operations and failure modes

### 6.1 Why the router supervises itself

- `ANTHROPIC_BASE_URL` in the global settings points every Claude Code session at the router.
- So a dead router would refuse every Claude call.

Each risk and what answers it:

| Risk | Answer |
|---|---|
| The router process dies | the front restarts a dead worker at once; the hooks restart a dead front before the next prompt or subagent |
| Sessions stay pointed at a dead router | the base-URL guard removes the base URL when no router of the plugin can hold the port; the emergency passthrough takes the port when the main router cannot start |
| One router is a single point of failure for all Claude traffic | the router degrades to a pure Anthropic passthrough rather than fail, and `claude-*` traffic is never altered (chaos cases a–s) |
| A runtime path disappears under a running router | there is no OS service; each start uses the runtime (bun, else node) that runs the hook, and the bundles are copied into the state root so a plugin update never deletes running code |
| Removing the plugin cuts off the sessions that are still open | the router retires instead of stopping: Claude traffic passes through until the `claude` processes from before the removal exit (7 days at most) |
| **Open:** a front that is killed outright is back only at the next prompt or subagent start | requests made between the kill and that hook can still be refused; a long turn with no new prompt has no hook in between |

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
| a GLM request fails with "key refused or missing: run /zai:setup" (a 400, not retried) | Z.ai refused the key, or there is none | rerun `/zai:setup` (opens the key page); Claude models are not affected |
| a GLM request fails naming a top-up page (a 400, not retried) | the Z.ai account is out of balance or quota | top up at the page named (`https://z.ai/manage-apikey/billing`), then retry |
| a GLM request fails with "budget reached for this <period>" (a 400, not retried) | a radar budget with action `stop` covers zai (or `total`) and is spent | raise or remove it in the dashboard's Settings (`/radar:open`), or wait for the period to end |
| a GLM request fails with "was removed: restart Claude Code" (a 400, not retried) | zai was removed or uninstalled while this session was open; its retired router still serves Claude models | restart Claude Code, or run `/zai:setup` to turn zai on again |
| GLM requests answer 503 naming `/zai:setup` | the router is degraded or in emergency mode; Claude traffic is unaffected | wait a minute for the next worker, or run `/zai:setup`; check `status` and `router-crash.log` |
| 429s, slow jobs | provider rate limit | AIMD lowers concurrency automatically; lower `ZAI_MAX_CONCURRENCY` |
| job `stale` | its driver died | `zai stop <id>` then `return` or `discard` |
| `land_verify_failed` at accept | gates fail in a fresh checkout (often a base older than main) | return with the failing output, or cherry-pick and fix by hand |
| GLM model missing in `/model`, or agents still on Sonnet right after setup | settings not merged, or Claude Code not restarted (the session that ran setup keeps using Anthropic until it restarts) | rerun setup, restart Claude Code |
| agents run on Sonnet | the router is down or the key is gone, so the fallback holds | rerun `/zai:setup`; its report names the failing check |
| `setup:omp`, `:opencode` or `:pi` fails on the smoke line | the tool is not logged in or configured (the plugin uses it as it is) | run the tool once yourself and set up its provider and model, then rerun the command |
| setup says `not routed`, or "kept ANTHROPIC_BASE_URL" | it points at your own proxy, which setup never overwrites, so the agents run on Sonnet | point your proxy at the router, or remove the entry yourself and rerun setup |
| huddle: SessionStart says how to get in | this session has no credential (it never joined, or it was kicked) | a member runs `/huddle:invite`; paste the `/huddle:join …` line it shows |
| huddle tools fail | server down, or neither `bun` nor `node` on PATH | `huddle up`; `huddle server` shows whether it runs and its port; check `which bun` in the launching shell |
| huddle's port changed | another program took the saved port | rejoin with the new join line; `huddle open` gives the new dashboard link |
