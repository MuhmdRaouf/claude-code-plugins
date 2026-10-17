# plugin-core changelog

Each release of `plugin-core`, the engine binary the five provider plugins (zai, kimi, deepseek, minimax, qwen)
run. A provider plugin pins one release; `/<p>:setup` downloads that release's binary and checks its sha256 before
it runs. The release workflow publishes the section for the version it releases, and refuses a version with no
section here.

## 0.0.1 (2026-10-14)

The first release: one static binary that holds the whole engine. Nothing to install besides the plugin; no Bun,
Node or other runtime is needed.

### Native routing

- Each provider plugin runs its own router on localhost: zai :18787, kimi :18788, deepseek :18789,
  minimax :18790, qwen :18791. Claude Code's `ANTHROPIC_BASE_URL` points at it.
- `claude-*` requests pass through to Anthropic byte for byte. Provider model ids go to the provider. Another
  provider's model id hops once to that provider's router.
- The router supervises itself: a front process keeps the port and runs a worker. A worker that crashes, hangs
  or grows past its memory limit is replaced without dropping the port. A request the worker never sent upstream
  is retried; one it did send is never sent twice.
- When the router cannot serve, it degrades to passthrough. It never cuts Claude Code off.
- Every request and every health change is written to Radar's spool, and a provider whose Radar budget is stopped
  is refused with a clear message. `claude-*` requests are never affected by a budget.
- Loopback and upstream connections are pooled, so a busy session does not run the machine out of ports.

### Background jobs

- `run`, `wait`, `batch`, `board`, `review`, `accept`, `return`, `discard`, `stop` and `usage`: a brief
  (Markdown with YAML front matter) becomes a job that a detached driver runs in its own git worktree.
- Workers: headless `claude -p` against the provider, or omp, opencode, pi and zcode as you set them up.
- Every job is checked mechanically: the plugin runs your gates and checks the diff against the brief's `scope`
  and `forbid` before it reaches `awaiting_review`. Acceptance is never automatic.
- Landing an accepted job rebases it, regenerates what it must, verifies again and fast-forwards.

### Setup and keys

- `/<p>:setup` stores the provider key in the OS keystore (macOS Keychain, Secret Service on Linux)
  through a one-time local page, so the key is never typed into the chat.
- A key file (mode 0600) is the fallback where no keystore answers.
- Everything setup changes outside the plugin is recorded in a ledger and restored on uninstall.

### Platforms

- macOS and Linux, each on amd64 and arm64.

### Verify a download

```sh
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify plugin-core-<os>-<arch> --repo MuhmdRaouf/claude-code-plugins
```

The binaries are built reproducibly: the same sources and version give the same bytes on any host, and CI checks
that a macOS rebuild matches the Linux one.
