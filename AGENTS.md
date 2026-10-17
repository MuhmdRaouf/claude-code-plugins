# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Cursor and others) working in this repository. `CLAUDE.md` imports
this file.

The `muhmdraouf` marketplace: five provider plugins for Claude Code (zai, kimi, deepseek, minimax, qwen) and the
engine they share. Each one depends on [huddle](https://github.com/MuhmdRaouf/huddle) (sessions, radar, kanban),
which Claude Code installs with it. `plugins.md` is the deep reference (layout, router, job engine, failure modes);
`packages/core/ARCHITECTURE.md` describes the job engine. Read the relevant section before changing a subsystem.

## Commands

```sh
mise run setup                                 # pinned tools and the pre-commit hook, once per clone
mise run check                                 # every gate CI runs: lint, static checks, all tests
npm ci
npm run check                              # check:siblings, then every npm workspace's `check`
npm run check -w plugins/zai-plugin-cc     # one workspace (also packages/plugin-test, …)
npm run check:siblings                     # provider-plugin drift guard (git + node only, no install)
npm run build -w plugins/zai-plugin-cc     # rewrite plugin/dist/run; the launcher is committed
claude --plugin-dir ./plugins/zai-plugin-cc/plugin   # load a plugin from the working tree

# one test (the provider plugins use vp test; the engine uses go test)
cd plugins/zai-plugin-cc && npx vp test -t "test name"
cd packages/core && go test ./internal/router/ -run TestChaos
```

A workspace's `check` is `vp check` (Oxfmt formatting, Oxlint rules and the type checks in one command), the test
suite, no `it.todo` left, and `dist:fresh` for the
provider plugins (the committed `plugin/dist/run` matches a fresh build): `vp test` there, whose only
TypeScript is tests. The plugins' shared suites build the plugin-core binary with Go
(`packages/core/scripts/host-build.sh`). Format with `npm run format -w <workspace>`.

## Layout

- `.claude-plugin/marketplace.json`: the catalogue; each provider entry's `source` is `./plugins/<project>/plugin`,
  and the `huddle` entry fetches `plugin/` from `MuhmdRaouf/huddle` (`git-subdir`).
- `plugins/<project>/`: a plugin's project (build scripts, tests, README). Only `plugins/<project>/plugin/`
  (plugin.json, agents, commands, skills, hooks, committed `dist/`) is installed by Claude Code.
- `packages/core`: the engine the five provider plugins share: one Go binary (`plugin-core`) holding the router,
  the job engine, the CLI and the adapters. `packages/core/testdata/contract/` pins the spool and budget formats
  huddle reads; huddle keeps identical copies.
- `scripts/check-siblings.mjs`: the provider-plugin drift guard.
- `assets/`: logo and banner.
- Runtime: the provider plugins run the plugin-core binary, which their launcher downloads on first use and checks
  against the pinned SHA-256 digests.

## Architecture

Two mechanisms here, a third in huddle:

1. **Native routing** (`packages/core/internal/router/`): each provider plugin runs its own localhost router
   (zai :18787, kimi :18788, deepseek :18789, minimax :18790, qwen :18791). `ANTHROPIC_BASE_URL` points at it;
   `claude-*` traffic passes through to Anthropic untouched, provider model ids go to the provider, other
   providers' ids hop once to the peer router. The router is a plugin-started, self-supervising process (no OS
   service) that degrades to passthrough; it must never cut Claude off.
2. **Background jobs** (core `internal/app/`, `internal/domain/`): a brief (Markdown + YAML front matter,
   validated) → detached `drive` → worker (headless `claude -p` against the provider, or omp/opencode/pi run as
   the user set them up) in a git worktree → the plugin runs the gates and checks the diff against
   `scope`/`forbid` → `awaiting_review` with a verdict → Claude accepts, returns with feedback, or discards.
   Verification is mechanical; acceptance is never automatic.
3. **Coordination and observation** live in huddle (its own repository): channels, the hub, radar and kanban.
   Every provider plugin declares `"dependencies": ["huddle"]`, so installing one installs huddle.

Routing reaches Claude Code in one of two ways. Proxy mode (the default) sets `HTTPS_PROXY` to the router and
`NODE_EXTRA_CA_CERTS` to a per-user local CA: the router terminates TLS only for `api.anthropic.com` and tunnels
every other host untouched, so `ANTHROPIC_BASE_URL` stays unset and Remote Control (`claude rc`) keeps working.
Base-URL mode points `ANTHROPIC_BASE_URL` at the router.

The plugins and huddle meet only through files and local HTTP:

- Routers append request lines and `router.event` health lines to Radar's spool
  (`packages/core/internal/adapters/spool/`), under `$RADAR_HOME` or `~/.agents/radar`.
- Radar writes `budget-status.json` there; a router refuses a provider whose budget is stopped
  (`packages/core/internal/router/budget.go`). A missing, stale or unreadable file stops nothing, and
  `claude-*` requests are never affected.

### The five provider plugins are hand-written copies

zai, kimi, deepseek, minimax and qwen are deliberately duplicated (no generator), differing only in
`test/provider.ts` (the provider as data) and names. `scripts/check-siblings.mjs` compares every sibling file with
zai's after normalising provider names and fails on any difference not listed in its `ALLOWED` table with a reason.

- A change to one provider plugin goes into all five, or into `ALLOWED` with a reason.
- zai is the reference: the full CLI e2e suite (golden transcript, epipe, follow, orphan) runs there only, against
  the plugin-core binary. Shared suites (`describePluginSurface`, bundle smoke, fresh install) live in
  `packages/plugin-test` (`@muhmdraouf/plugin-test`) and are called from each plugin; the cross-plugin provider
  test lives in core (`internal/providers`).
- READMEs may differ in vendor prose and are otherwise word-for-word the same.
- After changing `scripts/launcher.mjs` or the release a launcher pins, rebuild and commit each provider
  plugin's `plugin/dist/run`.

## Code rules

- The npm workspaces (`packages/plugin-test`, the five provider plugins) are TypeScript strict with
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; ESM with `.ts` import specifiers; no `any`, no
  default exports, no enums.
- The Go engine (`packages/core`) keeps the same discipline: expected failures are values (concrete error
  types, matched with `errors.As`), never thrown across a port; no package-level mutable state;
  `context.Context` is the first parameter.
- Functional core, imperative shell: decisions live in `internal/domain/` or `internal/app/` and are unit-tested
  with fakes; `internal/adapters/` only do I/O and are integration-tested against real git, processes and temp
  filesystems.
- CLI exit codes are fixed: 0 ok, 1 unexpected, 2 usage, 3 verdict not pass, 4 not found, 5 landing refused,
  6 not ready / no live driver, 130 follower interrupted.
- Provider commands take no arguments except `/<p>:review [job id]` (tests enforce it); the surface is
  setup/board/usage/review/remove plus one setup per engine.
- Keys live in the OS keystore and are never typed into chat; anything a plugin changes outside itself is recorded
  in a ledger and restored on uninstall or disable.
- A plugin never blocks Claude Code: hooks exit 0 on any failure and stay silent when they have nothing to say.
- Tests run against temporary homes and state directories; they never touch the real `~/.claude`, the user's state
  or processes they did not start.

### The router recovers by itself

The router is Claude Code's only way to Anthropic once setup points `ANTHROPIC_BASE_URL` at it, so it must come
back without the user doing anything.

- A power loss, a crash or a session that ends without its exit hook leaves pid, lock, retired and handover files
  behind with no router running. The next `SessionStart`, `UserPromptSubmit`, `PreToolUse` or `SubagentStart`
  hook brings it back inside the hook's budget (3 s for ensure).
- "Up" means our health answered: ensure GETs the health path (1 s), never a bare connect. A front of ours that
  accepts but never answers is replaced only once its silence has lasted 5 s: the first silent probe marks the
  episode in `<state>/router.silent` (one line in `router.log`), a probe finding the mark 5 s old SIGKILLs the
  front and starts a fresh one, an answer or a closed port clears the mark, and a mark older than 60 s starts a
  new episode instead of killing. One slow second never costs every in-flight response. A holder that is not
  ours is left alone, also named. Every start appends the child's output to `router.log` plus one
  `ensure: started router (reason: …)` line, so a failed start leaves its trace.
- A router that dies mid-turn does not wait for the next prompt: `PreToolUse` runs ensure before every tool call,
  and the session watchdog (`<p> router watch --session-pid <pid>`, started detached by the SessionStart hook)
  re-runs the check every 2 s and restarts the router within seconds. The session pid is the Claude Code process:
  the nearest ancestor of the hook that is neither a shell nor the launcher. The watchdog exits within 2 s once
  the session pid is gone or the router is retired for a remove, and one watchdog serves one session (each claims
  `<state>/watch.<session pid>`; a later one bows out).
- Hooks and commands resolve one state root: `$<P>_STATE_DIR`, else `~/.agents/<p>`. `CLAUDE_PLUGIN_DATA`
  (which Claude Code sets only for hooks) never picks the root; state an older build left in the plugin's own
  data dir moves over once, and the data dir itself is never deleted.
- Never trust a pid from a state file alone: after a reboot it can name another process. Check the port and
  `IsOurProcess`, and never wait on, kill or refuse because of a process that is not ours.
- Every exit the router can see leaves one line in `router.log` (signal, panic, retire, uninstall, handover) and
  writes the logged-exit marker `<state>/router.exit` naming its pid. A front that died unlogged (SIGKILL, the OS) is
  named by the next start: a pid record whose holder is gone while no marker vouches for it.
- The provider key is cached in the router worker once read. A keystore that hangs (locked keychain, an unlock
  prompt nobody answers) never strands provider requests while a key file holds the key; `claude-*` requests
  never read the key at all.
- Every one of these has a test that builds the broken state in a temp state root and proves the recovery.

## Writing code

1. **Simple first.** Write the smallest design that solves today's problem. No abstraction, option or layer until a
   second real use needs it; three similar lines beat a premature helper.
2. **High cohesion, low coupling.** A package does one job and owns its data. Packages talk through small, explicit
   interfaces, never through each other's internals or shared globals.
3. **Everything statically typed.** Go uses structs for data and small interfaces declared by the consumer (no
   `map[string]any` or `interface{}` across a boundary). TypeScript runs in `strict` mode with `type`s and
   `interface`s and no `any`; JSON is decoded into those types at the edge and checked there.
4. **Good design, kept honest.** Clear boundaries, dependencies that point inward, names that say what a thing is.
   A pattern earns its place by removing code or a class of bugs, not by being a pattern.

## Tests

1. **TDD.** Write the failing test first, watch it fail, make it pass, then refactor. A bug fix starts with the
   test that shows the bug.
2. **E2E for every user-facing path.** Unit tests prove the parts; an end-to-end test against the real binary
   proves the path a user takes works as a whole.
3. **Frontend work ships with headless-browser E2E tests** (Playwright, Chromium) that run unchanged on a laptop
   and in CI.
4. **CI runs every test.** A test that runs on one machine only does not count. `mise run check` runs the gates
   locally; `.github/workflows/ci.yml` runs them on every push.

## Agent files

Everything an agent writes stays under `.agents/`, in the gitignored folders below, and nowhere else in the repo,
so none of it can reach git:

| Folder | What goes there |
|---|---|
| `.agents/scratch/` | notes, plans, drafts, logs, build caches, downloads |
| `.agents/secrets/` | keys and tokens a test run needs (mode 0600); docs name them, never print them |
| `.agents/tickets/` | the kanban board and the tickets agents work from |
| `.agents/worktrees/` | one git worktree per ticket |

Only `.agents/skills/` is committed. Never write working files into the source tree, `/tmp` or the home
directory, and never pass a secret on a command line.

## Comments and docs

- Describe what the code does now, in the present tense. No history, no "used to", no past designs.
- Comment only the non-obvious why (a constraint, a protocol rule, a security reason); never restate the code.
- Keep READMEs and `plugins.md` in step with behaviour in the same change.
- Names carry no language suffix: the engine is `packages/core` (Go module `.../packages/core`), its CI jobs are
  `core` and `core-macos`, and its commit scope is `core`. Never add `-go`, and never describe the
  code as a port or name an earlier implementation.

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

- One line, Conventional Commits: `<type>(<scope>): <message>`. No body, no co-author, no AI jargon, no emojis. Types:
  `init`, `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`. The scope is the plugin or package
  (`zai`, `kimi`, `deepseek`, `minimax`, `qwen`, `core`, `repo`). Imperative, starting lowercase, no trailing period,
  no body.
- Signed (`git commit -S`), as Raouf. Stage files by name; never `git commit -a` or `git add .`.
- Never commit secrets or API keys; CI runs gitleaks over the whole history (`.gitleaks.toml` allows the test fakes).

## CI

`.github/workflows/ci.yml` runs in five stages: plan (which projects changed), repository rules (gitleaks,
attribution, actionlint, siblings, plugin validation), tests (core: gofmt, tidy, vet, staticcheck, govulncheck,
race tests with a coverage gate, the release build; one job per changed provider plugin), compatibility (Node 22,
macOS, the Go reproducible-build leg) and the gate.
The only required check is `All checks passed`; a job the plan skipped counts as passed. `plugins.md` lists every
job.

CI minutes cost money, so every run stays short and bounded:

- Every job has `timeout-minutes: 10`; a long step gets its own smaller cap, and `go test -timeout` sits under the
  step's cap so a hang prints stacks instead of idling.
- Speed a slow job up (caching) rather than splitting it into more runners.
- Reproduce and fix failures locally first. Re-run only the failed jobs (`gh run rerun --failed`), and cancel a run
  a newer push replaces.
- Go and the GitHub Actions stay on their latest releases: `toolchain` in `packages/core/go.mod`, actions pinned
  by commit sha with the version in a comment.

## Releases

- A pushed tag `v<VERSION>` (from `packages/core/VERSION`) runs `release.yml`: four `plugin-core` binaries
  (macOS and Linux on amd64 and arm64), `SHA256SUMS` and a build-provenance attestation, digests checked against
  the committed manifest `packages/core/release/v<VERSION>.json`. No workflow creates tags.
- Every release has a section in `packages/core/CHANGELOG.md`, as detailed as 0.0.1's: what a user gets, grouped
  by area (routing, jobs, setup and keys, platforms), fixes with their symptom, and how to verify a download. The
  release notes are that section plus the checksums; a version without a section is never released.
- The provider plugins pin one release. A new core release regenerates the manifest and every `plugin/dist/run`
  (`npm run build -w plugins/<p>`), and bumps the five plugins' versions in `plugin.json` and the marketplace
  catalogue, so Claude Code installs the new launcher instead of keeping its cached copy.
- Any Go change after a manifest is written changes the digests (Go binaries record line numbers): regenerate the
  manifest and the launchers in the same branch before it merges.
