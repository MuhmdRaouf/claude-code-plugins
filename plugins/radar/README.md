# radar

A live dashboard for Claude Code. One page that updates as you work and shows:

- every session, with its main agent and subagents as a tree;
- every model request: model, provider, latency, input, output and cache tokens;
- every tool call: name, duration, ok or error;
- prompts, stops, compactions and notifications.

It only reads what Claude Code already produces:

- It never calls a model and never spends a token.
- It adds no prompt hooks and no agent hooks.
- It takes the events Claude Code already emits and the transcript files it already writes, then renders them.
- The transcript stays the source of truth.

## Install

1. Add the marketplace and install the plugin:

   ```
   /plugin marketplace add MuhmdRaouf/claude-code-plugins
   /plugin install radar@muhmdraouf
   ```

2. Restart Claude Code.

Requirements:

- Bun ≥1.3 (default) or Node ≥22.13.
- Every hook and command uses `bun` when it is on PATH and falls back to `node`.

## Commands

Inside Claude Code:

| Command | What it does |
|---|---|
| `/radar:start` | Starts the dashboard server (or reuses a healthy one) and prints its URL |
| `/radar:open` | Starts it if needed and opens the dashboard in your browser |
| `/radar:status` | Reports whether it is running, the URL, uptime and sessions tracked |
| `/radar:stop` | Stops the server |

- `/radar:start` also watches alerts: a background Monitor in the session footer prints one line whenever Radar
  raises an alert, and starts again on its own when its 30 minutes run out.

The same commands from a terminal:
`bun plugin/dist/radar.js start|stop|status|url|open|watch [--port N] [--since 24h] [--foreground]`.

## Autostart and the port

Nothing else to set up.

- **Autostart.** Once you start the dashboard (`start` or `open`), it comes back by itself with your next Claude Code
  session after a reboot, until you `stop` it.
- **Override.** `RADAR_AUTOSTART=1` or `0` forces it on or off.
- **The startup line.** When a session start brings it back, you get one line as a message to you (Claude never sees
  it): `radar: dashboard at http://127.0.0.1:<port>`.
- **The port stays.** It is kept across stops and reboots (`<state>/port`), so a bookmark keeps working.
- **When the port moves.** Only when another program holds it does the dashboard take a new one, and `start` says so.

## What you see

### Overview

- **Summary cards.** Sessions (live and ended), agents, requests, tool calls (and how many failed), errors and p95
  latency. Each card has an icon and a one-line context.
- **Token flow.** The tokens in view, stacked by kind (input, output, cache read, cache write), over the last 5
  minutes, hour or day. Shows per-kind totals, the cache hit rate and a hover breakdown.
- **Sessions rail.** Every session, live first, with when it started or ended and its model. Picking one scopes the
  whole page to it.

### Tabs

- **Agents.** Every session's main agent and subagents as a collapsible tree. Z.ai worker jobs are listed alongside as
  external agents. Clicking an agent row opens its live transcript in a slide-over; the hash keeps it open
  (`agent=<id>`), so a reload or Back brings it back.
- **Requests.** A table of model requests: time, agent, model, upstream, latency, in/out/cache-read/cache-write
  tokens, stop reason. Filter by model, open a detail drawer; new rows flash as they stream in. The drawer is the
  request inspector, with Overview, Input, Output, Context and Raw tabs. Context rebuilds the conversation as the
  model saw it, one collapsed row per turn with earlier pages loaded on demand; above the turns sit the request's
  system prompt and tools, when the router captured them, with the few allow-listed response headers the answer
  carried.
- **Tools.** The most used tools with their failures, and the recent calls with an all/failed filter.
- **Timeline.** One feed of everything in plain words: prompts, subagents, stops, compactions, notifications.
- **Models.** Tokens by kind per model and provider, upstream hosts, and a request-rate chart, all scoped to the
  picked sessions and the time range.

### Where requests come from

- **Transcripts.** Claude Code writes each answer into its transcript: agent, tokens, stop reason.
- **Router spool lines.** A provider plugin's router writes one line per request: upstream host, route, latency and,
  for provider models, tokens. A line with no session counts under "Outside a session".
- **One call, one row.** A call in both is merged by session, model and time (and agent, when the router tagged it).
  A transcript call with no router line shows as "Claude Code direct (no router)" under Upstreams.
- **Not model calls.** Messages Claude Code writes itself (model `<synthetic>`: "No response requested.", usage
  limits, lost connections) never count as requests. The error ones show on their session and agent as a
  "Claude Code notice".

### Cost

- **Where it shows.** An estimated USD figure next to tokens everywhere: a summary card (today), each session, agent,
  model and request.
- **The price table.** Estimates use the price table every plugin in this repo shares, at list price. Cache reads
  and writes are priced at their own rates.
- **Unknown models.** A model the table does not know shows its tokens only, never a guessed figure. Claude models
  are priced at Anthropic's API list price, from the offering their upstream names; a Claude subscription may cover
  Claude usage — these are API list prices.
- **Costs tab.** Costs by repo, session, agent and model, as one drill-down for today, the last 7 or 30 days: requests, tokens by
  kind and estimated cost. Sortable, with CSV export.

### Alerts

A strip on the overview and a page of their own. Each one can be dismissed; it comes back only if the same thing
happens again. The defaults never raise an alert for an idle session waiting for you:

- **stuck**: a live session mid-turn (a prompt with no Stop, interruption or permission prompt after it) with no
  request, tool result or agent event for 10 minutes, or 30 while a tool is still running. After 6 hours of silence it
  counts as abandoned, not stuck.
- **loop**: one agent calls the same tool with the same input 5 times in a row (the last within 30 min).
- **retry storm**: 5 or more 429/5xx answers within 2 minutes for one session or one provider router.
- **context**: an agent's last request used 85% of its context window (200k, or 1M once the session shows it has
  one), with no compaction since.
- **budget**: a budget at 80% of its limit, and again at 100%.

### Router and Settings

- **Router.** For provider plugins' routers: fallbacks, refusals, rate limits, budget stops and restarts per provider
  over the last 24 hours, plus the recent events.
- **Model advisor.** Points at subagent runs on a main model that look flash-sized: at most 12 requests, under 8k
  output tokens, read-only tools only. Shows the estimated saving on the flash sibling. A hint, never a verdict.
- **Settings.** Budgets and desktop notifications.

### Budgets

Add, edit or remove budgets in Settings. Each budget has:

- a scope: everything, or one provider plugin seen in your data;
- a period: day, week from Monday, or month;
- a limit in USD;
- an action at 100%: *warn* (an alert) or *stop* (the provider plugin's router refuses that provider's requests until
  the period ends). Claude requests are never stopped.

How it works:

- Spend is the estimate above, counted from what radar has recorded. Its usage ledger keeps 35 days.
- Budgets live in `<state>/budgets.json`.
- Radar rewrites `<state>/budget-status.json` every 10 seconds for the routers to read.
- With no budgets, nothing changes.

### Desktop notifications

- **When.** On by default for budgets at 80% and 100%, and for new stuck sessions and loops.
- **How.** macOS Notification Center (`osascript`), or `notify-send` on Linux when it is installed. Elsewhere,
  nothing.
- **How often.** Each alert notifies once; one kind per session at most every 10 minutes.
- **What it says.** Only the project folder name and what happened.
- **Turn off.** In Settings; `RADAR_NOTIFY=0` also silences one server.

### Prometheus

`GET /metrics` serves the Prometheus text format. Nothing to configure.

- It covers requests, tokens by kind, estimated cost, API errors, a latency histogram, tool calls, router events,
  active alerts and budgets.
- Series are labelled by model, provider and project.

```sh
curl -s "http://127.0.0.1:$(cat ~/.agents/radar/port)/metrics"
```

### The page

- **Theme.** Catppuccin: Mocha when your system is dark, Latte when it is light. A system/light/dark switch in the top
  bar, remembered by the browser.
- **Addresses.** Each tab has its own (`#requests`, `#tools`, …).
- **Access.** Every control works from the keyboard. Motion stops when you ask for reduced motion.
- **Offline.** No network access needed: Tailwind compiled at build time, local fonts, inline icons, no CDN.
- **Small screens.** Usable down to phone width.

## How it captures

Three read-only inputs, no interference.

### 1. Command hooks

- **Events.** Eight Claude Code events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`,
  `SubagentStop`, `Stop`, `PreCompact`, `Notification`.
- **Output.** Each appends one JSON line to `<state>/spool/<date>.jsonl`.
- **No per-tool hook.** Tool calls come from the transcripts.
- **Behaviour.** The hook exits 0, never touches the network, and works whether or not the server runs. It prints
  nothing, except the one "dashboard at" line to you when SessionStart autostarts the server.
- **Failures.** It logs its own failures to `<state>/hook-errors.log` (capped at ~1 MB). Without `bun` or `node` on
  Claude Code's PATH, every hook exits 0 at once.
- **Spool cap.** 64 MB; the oldest day goes first.

### 2. Transcript tailing

- **What it reads.** The spool's transcript paths, plus every `*.jsonl` under
  `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/**` modified within the lookback window (default 24 h). Subagent
  sidechains included.
- **Requests.** Deduplicated by id.
- **Latency.** The gap between an assistant message and the preceding user or tool-result message.
- **Z.ai jobs.** Job dirs under `~/.agents/zai/jobs/` are picked up as external agents when present.

### 3. Router lines

A provider plugin's router appends its own lines to the same `<state>/spool/<date>.jsonl` files:

- **Route lines.** One per forwarded request: upstream host, route, status, latency, tokens and the ids Claude Code
  sent. Never a message body, and no header value except the allow-list below.
- **Prompt captures.** The system prompt and tool definitions a request carried, gzip-compressed and written once
  per distinct content (a sha256 of it); each route line names its hash instead of repeating the content.
- **Response headers.** The allow-list a route line may carry: request-id, x-request-id, retry-after, the
  `anthropic-ratelimit-*` and `x-ratelimit-*` counters, and content-type. Nothing else.

## Security and privacy

### Loopback only

- The server binds `127.0.0.1` on a random port (10000–65535), drawn with `crypto.randomInt` on the first start and
  retried up to 50 times.
- Later starts take the saved port, and draw again only when it is taken.
- Plain HTTP, no TLS, no system configuration of any kind.
- `--port N` pins a port but never the bind address.
- Requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` get 403 (DNS-rebinding guard).
- No CORS headers. Everything is GET/HEAD except the dashboard's own three writes (budgets, settings, dismissing an
  alert). Those take only `application/json` from the dashboard's own origin, up to 64 KiB.

### What is stored

- **Secrets never land in the store.** Before anything is stored or served, radar drops:
  - values of keys matching key/token/secret/password/authorization/cookie;
  - `Bearer …` and `sk-…` strings;
  - the contents of `*.env` paths.
- **Truncation.** The live view truncates tool inputs/outputs and prompts to 2 KB per field; history keeps up to
  1 MB of each request's input and output and marks the rest as truncated.
- **No content in the ledger.** The usage ledger (`<state>/ledger/<day>.json`, 35 days) holds request ids, models,
  session and agent ids and token counts. Never a prompt, a tool input or a body.
- **History keeps content.** Past sessions live in a SQLite store at `<state>/history.db`: each request's input and
  output text from the transcripts, gzipped, and the captured system prompt and tools beside them. Retention prunes
  it hourly to the setting chosen in Settings (7, 30 or 90 days, or forever; 30 by default), and "Clear history"
  there wipes the store.
- **State is private.** Everything lives under `${RADAR_HOME:-~/.agents/radar}`, created `0700` with
  files `0600`. An older `~/.local/state/radar` moves over on the first start (as does each provider's
  `~/.local/state/<name>`, whose jobs radar reads).
- **Safe uninstall.** An uninstall deletes that directory only when it carries radar's `.radar-state`
  marker, so `RADAR_HOME` pointing elsewhere is safe.
- **Bounded memory.** The in-memory store holds 200 sessions / 200 000 events, oldest evicted, and is rebuilt from
  disk on start.

### Live updates

- They arrive over server-sent events at `/api/stream`: a snapshot, then deltas, with a 15 s heartbeat.
- The dashboard reconnects on its own.

## Uninstalling

Run `/plugin uninstall radar@muhmdraouf`. That is all.

The dashboard server outlives its plugin (Claude Code has no uninstall hook), so it watches the plugin registry
itself:

1. It checks every 10 s (`RADAR_REMOVAL_MS` overrides, for tests).
2. It acts only after two consecutive checks agree.
3. It stops accepting connections and lets requests already in flight finish (up to 30 s).
4. It closes the dashboard's live streams and exits 0.

What happens to your data:

- **Uninstalled.** The running dashboard deletes the whole state dir (`${RADAR_HOME:-~/.agents/radar}`:
  spool, logs, server.json, port) within ~20 s of the uninstall. If it was not running then, delete
  `~/.agents/radar` yourself.
- **Disabled** (`enabledPlugins` in `~/.claude/settings.json`). Only the server stops. The state dir is kept, so
  enabling the plugin again picks the history back up.

Safety:

- A registry file that is missing or half-written is never mistaken for an uninstall.
- A project that enables the plugin in its own settings keeps it alive for that project, even when the user scope
  disables it.

## Development

- Bun >= 1.3 (default) or Node >= 22.13.
- TypeScript strict, ESM.
- Zero runtime dependencies: `node:http`, SSE by hand, `node:fs` watching.
- Tailwind CSS 4 compiled at build time; the browser bundle is esbuild.

```sh
npm ci                      # from the repository root
npm run check -w radar   # typecheck + lint + coverage (>= 90%) + work-marker scan + build freshness
npm run build -w radar   # bundle plugin/dist/{radar,hook}.js and plugin/public/{app.js,app.css}
node scripts/smoke.mjs         # from plugins/radar: end-to-end against the built CLI
npm run leg:bun -w radar  # the bundle under bun: page, assets, live stream, hooks (leg:node: same under node)
```

Licensed GPL-3.0-or-later.
