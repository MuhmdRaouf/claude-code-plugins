# plugin-core changelog

Each release of `plugin-core`, the engine binary the five provider plugins (zai, kimi, deepseek, minimax, qwen)
run. A provider plugin pins one release; `/<p>:setup` downloads that release's binary and checks its sha256 before
it runs. The release workflow publishes the section for the version it releases, and refuses a version with no
section here.

## 0.0.1 (2026-10-14)

The first release: one static binary that holds the whole engine. Nothing to install besides the plugin; no Bun,
Node or other runtime is needed. Every provider plugin declares huddle as a dependency, so installing one brings
the session hub, the radar dashboard and the kanban board with it. A release is published by a hand-pushed
`v<VERSION>` tag; no workflow creates tags.

### Native routing

- Each provider plugin runs its own router on localhost: zai :18787, kimi :18788, deepseek :18789,
  minimax :18790, qwen :18791.
- Proxy mode is the default: `HTTPS_PROXY` names the router and `NODE_EXTRA_CA_CERTS` a per-user local CA, so
  `ANTHROPIC_BASE_URL` stays unset and Remote Control (`claude rc`) keeps working. Base-URL mode points
  `ANTHROPIC_BASE_URL` at the router instead, beside a proxy or a CA of your own.
- As a proxy, the router terminates TLS only for `api.anthropic.com` and tunnels every other host untouched. A
  CONNECT naming this machine is refused, and a proxy naming a plugin router is never handed to the router's own
  upstream calls, so nothing loops back into itself.
- The local CA carries a critical name constraint for `api.anthropic.com` and reaches Claude Code only through
  `NODE_EXTRA_CA_CERTS`: it never enters a system trust store, and a leaked key cannot sign a certificate any
  client accepts for another host.
- `claude-*` requests pass through to Anthropic byte for byte. Provider model ids go to the provider. Another
  provider's model id hops once to that provider's router.
- The router supervises itself: a front process keeps the port and runs a worker. A worker that crashes, hangs
  or grows past its memory limit is replaced without dropping the port. A request the worker never sent upstream
  is retried; one it did send is never sent twice.
- When the router cannot serve, it degrades to passthrough. It never cuts Claude Code off.
- Every request and every health change is written to Radar's spool, and a provider whose Radar budget is stopped
  is refused with a message naming `/huddle:open`. `claude-*` requests are never affected by a budget.
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
- Setup plans, applies and undoes the proxy-mode keys (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`) through the same
  ledger: the SessionStart hook re-applies them after plugin updates, `setup --remove` puts back what was there,
  and the agents fall back to Sonnet when the router cannot come back.
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
