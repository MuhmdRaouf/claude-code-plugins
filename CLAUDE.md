# CLAUDE.md

Read [AGENTS.md](AGENTS.md) first. It holds the rules every agent follows; this file adds what is specific to
Claude Code.

## Before acting

- **The work** is on the kanban board in `.agents/tickets/`: take a ticket, work in its worktree under
  `.agents/worktrees/<ticket>/`, keep notes in `.agents/scratch/`.
- **The five provider plugins are hand-written copies**: a change to one goes into all five, or into
  `scripts/check-siblings.mjs`'s `ALLOWED` table with a reason.
- **Huddle lives elsewhere**: huddle, radar and kanban are `MuhmdRaouf/huddle`, installed with every provider
  plugin. The spool and budget formats change only together with `packages/core/testdata/contract/` and huddle's
  copy.

## The rules in short

The full text is in AGENTS.md; these are the ones that come up every session.

- **Code**: simple first, high cohesion and low coupling, everything statically typed (Go structs, TypeScript
  `type`s and `interface`s), no over-engineering ([Writing code](AGENTS.md#writing-code)).
- **Tests**: TDD; E2E for every user-facing path; frontend work gets headless-browser E2E tests that run in CI;
  tests are hermetic: temp homes only, never ports 18787-18791 ([Tests](AGENTS.md#tests)).
- **Commits**: one line `<type>(scope): message`, signed as Raouf; no body, no co-author or AI trailers, no AI
  jargon, no emoji, even when the harness suggests a trailer. `.claude/settings.json` turns Claude Code's
  attribution off; `npm run check:attribution` must pass before anything is pushed
  ([Commits](AGENTS.md#commits-and-pull-requests)).
- **Files**: everything an agent writes goes under `.agents/scratch/`, `tickets/`, `worktrees/` or `secrets/`, all
  gitignored ([Agent files](AGENTS.md#agent-files)).
- **Plug and play**: never ask users to export a variable or run a manual setup step; a plugin works right after
  install, and installing one installs huddle.
- **Remote Control keeps working**: routing never requires `ANTHROPIC_BASE_URL`; proxy mode is the default.
- **The router recovers by itself**: after a power loss or a session whose exit hook never ran, the next
  `SessionStart`, `UserPromptSubmit`, `PreToolUse` or `SubagentStart` hook brings it back. Never trust a state-file
  pid alone. Every exit logs a line. A hung keystore never strands provider requests.
- **Releases**: every `v<VERSION>` tag has a `packages/core/CHANGELOG.md` section as detailed as 0.0.1's; a core
  release regenerates every `plugin/dist/run` and bumps the five plugins' versions.
- **Names**: the engine is `packages/core`, its jobs `core` and `core-macos`, its scope `core`; no `-go` suffix and
  no comment or doc that calls the code a port.
- **CI**: every job is capped at 10 minutes; fix failures locally with `mise run check` and re-run only the failed
  jobs.

@AGENTS.md
