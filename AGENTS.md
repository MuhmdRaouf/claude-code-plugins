# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Cursor and others) working in this repository. `CLAUDE.md` imports
this file.

The `muhmdraouf` marketplace of Claude Code plugins, developed and published from one repository. `plugins.md` is the
deep reference (layout, router, job engine, huddle, observatory, failure modes); `packages/core/ARCHITECTURE.md`
describes the job engine. Read the relevant section before changing a subsystem.

## Commands

```sh
npm ci
npm run check                              # check:siblings, then every npm workspace's `check`
npm run check -w plugins/zai-plugin-cc     # one workspace (also packages/core, plugins/observatory, …)
npm run check:siblings                     # provider-plugin drift guard (git + node only, no install)
npm run build -w plugins/zai-plugin-cc     # rebuild plugin/dist/*.js; the bundle is committed
claude --plugin-dir ./plugins/zai-plugin-cc/plugin   # load a plugin from the working tree

# one test (npm workspaces use vitest)
cd packages/core && npx vitest run test/router/chaos.test.ts
cd packages/core && npx vitest run -t "test name"

# huddle is a separate Bun project (own bun.lock, not an npm workspace)
cd plugins/huddle && bun install && bun test && bin/rehearse
cd plugins/huddle && bun test tests/<file>
cd plugins/huddle && bun run build && bun run css       # after changing its sources: dist/ and app.css are committed
```

A workspace's `check` is `tsc --noEmit`, `biome ci`, `vitest --coverage` (domain ≥95%, overall ≥90%), no `it.todo`
left, `dist:fresh` (the committed bundle matches a fresh build) for plugins, and a Bun leg (`test:bun`). Observatory
adds `leg:bun` and `leg:node`, which start the committed bundle under each runtime. Format with
`npm run format -w <workspace>`. `npm run mutate` runs Stryker on `src/domain` (core and zai, break at 90%).

## Layout

- `.claude-plugin/marketplace.json`: the catalogue; each entry's `source` is `./plugins/<project>/plugin`.
- `plugins/<project>/`: a plugin's project (src, tests, build scripts, README). Only `plugins/<project>/plugin/`
  (plugin.json, agents, commands, skills, hooks, committed `dist/`) is installed by Claude Code.
- `packages/core`: the engine bundled by all five provider plugins: router, job engine, CLI, adapters.
- `scripts/check-siblings.mjs`: the provider-plugin drift guard.
- `assets/`: logo and banner.
- Runtime: Bun ≥1.3 by default, Node ≥22.3 otherwise (huddle: Node ≥22.5).

## Architecture

Three independent mechanisms:

1. **Native routing** (`packages/core/src/router/`): each provider plugin runs its own localhost router (zai :18787,
   kimi :18788, deepseek :18789, minimax :18790, qwen :18791). `ANTHROPIC_BASE_URL` points at it; `claude-*` traffic
   passes through to Anthropic untouched, provider model ids go to the provider, other providers' ids hop once to the
   peer router. The router is a plugin-started, self-supervising process (no OS service) that degrades to
   passthrough; it must never cut Claude off.
2. **Background jobs** (core `app/`, `domain/`): a brief (Markdown + YAML front matter, zod-validated) → detached
   `drive` → worker (headless `claude -p` against the provider, or omp/opencode/pi run as the user set them up) in a
   git worktree → the plugin runs the gates and checks the diff against `scope`/`forbid` → `awaiting_review` with a
   verdict → Claude accepts, returns with feedback, or discards. Verification is mechanical; acceptance is never
   automatic.
3. **Coordination and observation**: `huddle` (a channels server, SQLite per channel, MCP/CLI/hooks, a live
   dashboard) and `observatory` (a zero-token dashboard fed by hooks, transcripts and the routers' spool).

The plugins meet only through files and local HTTP, and each works alone:

- Routers append request lines and `router.event` health lines to Observatory's spool
  (`packages/core/src/router/spool-write.ts`), under `$OBSERVATORY_HOME` or `~/.local/state/observatory`.
- Observatory writes `budget-status.json` there; a router refuses a provider whose budget is stopped
  (`packages/core/src/router/budget.ts`). A missing, stale or unreadable file stops nothing, and `claude-*`
  requests are never affected.
- Huddle reads Observatory's port file and its `/api/alerts` and `/api/attribution` when it runs; otherwise those
  parts stay hidden.

### The five provider plugins are hand-written copies

zai, kimi, deepseek, minimax and qwen are deliberately duplicated (no generator), differing only in
`src/provider.ts` (the provider as data) and names. `scripts/check-siblings.mjs` compares every sibling file with
zai's after normalising provider names and fails on any difference not listed in its `ALLOWED` table with a reason.

- A change to one provider plugin goes into all five, or into `ALLOWED` with a reason.
- zai is the reference: the full CLI e2e suite (golden transcript, epipe, follow, orphan), Stryker and the drive
  tests run there only. Shared suites (`describePluginSurface`, bundle smoke, fresh install, the cross-plugin provider
  test) live in core and are called from each plugin.
- READMEs may differ in vendor prose and are otherwise word-for-word the same.
- After changing core or a plugin's `src/`, rebuild and commit each affected plugin's `plugin/dist/`.

## Code rules (npm packages)

- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; ESM with `.ts` import
  specifiers; no `any`, no default exports, no enums.
- Expected failures are values (`Result<T,E>` discriminated unions), never thrown across a port.
- Functional core, imperative shell: decisions live in `domain/` or `app/` and are unit-tested with fakes; `adapters/`
  only do I/O and are integration-tested against real git, processes and temp filesystems.
- CLI exit codes are fixed: 0 ok, 1 unexpected, 2 usage, 3 verdict not pass, 4 not found, 5 landing refused,
  6 not ready / no live driver, 130 follower interrupted.
- Provider commands take no arguments except `/<p>:review [job id]` (tests enforce it); the surface is
  setup/board/usage/review/remove plus one setup per engine.
- Keys live in the OS keystore and are never typed into chat; anything a plugin changes outside itself is recorded
  in a ledger and restored on uninstall or disable.
- A plugin never blocks Claude Code: hooks exit 0 on any failure and stay silent when they have nothing to say.
- Tests run against temporary homes and state directories; they never touch the real `~/.claude`, the user's state
  or processes they did not start.

## Comments and docs

- Describe what the code does now, in the present tense. No history, no "used to", no past designs.
- Comment only the non-obvious why (a constraint, a protocol rule, a security reason); never restate the code.
- Keep READMEs and `plugins.md` in step with behaviour in the same change.

## Writing

Applies to docs, command and skill text, CLI output, commit messages and replies to the user.

- Titles and bullet points. Lead with the action or the answer; number steps that happen in order.
- Short sentences, plain words. Specific numbers over vague ones (minutes, ports, counts).
- No AI jargon: no "seamless", "robust", "leverage", "comprehensive", "powerful", "delve", "unlock", "empower",
  "elevate", "streamline", "cutting-edge" or "game-changer".
- No emojis. No preamble, recap or sign-off ("Great question", "Hope this helps").
- One idea per bullet; five bullets or fewer in a list where possible.

## Commits and pull requests

**Hard rule: no AI attribution, ever.** GitHub lists every commit author, committer and `Co-authored-by` identity as
a contributor, so one trailer puts an AI tool on the repository page for good. In commits, pull requests, tags and
release notes:

- no `Co-authored-by` trailer of any kind, and no other AI trailer (`Assisted-by`, `Generated-by`, session links);
- no "Generated with …" line and no robot-emoji footer;
- the author and committer are the human who commits, never a tool's identity.

`npm run check:attribution` (part of `npm run check`, and run by CI on every push) fails on any of these.
`.claude/settings.json` turns off Claude Code's own commit and PR attribution; other tools must be configured the
same way, or their trailers removed before committing. A commit that slips through is rewritten before it is pushed.

Format:

- One line, Conventional Commits: `<type>(<scope>): <message>`. Types: `feat`, `fix`, `perf`, `refactor`, `docs`,
  `test`, `build`, `ci`, `chore`. The scope is the plugin or package (`zai`, `huddle`, `observatory`, `core`, `repo`,
  …). Imperative, starting lowercase, no trailing period, no body.
- Sign commits (`git commit -S`).
- Never commit secrets or API keys; CI runs gitleaks over the whole history (`.gitleaks.toml` allows the test fakes).

## CI

`.github/workflows/ci.yml` path-filters which workspace jobs run (a core change re-checks all five providers); the
only required check is the aggregate `ci-ok`. Every push also runs `siblings`, `catalogue` (`claude plugin validate`
on the marketplace and every listed plugin), gitleaks and the attribution check over the full history.
