# core

The engine behind the five provider plugins (zai, kimi, deepseek, minimax, qwen): one static binary, `plugin-core`,
that their committed `dist/run` launcher downloads and executes. The plugins call it as
`plugin-core <provider> <cli|router|passthrough|ensure> [args...]`; `--version` prints the release it was built
from. It runs on no runtime; it is built for 4 platforms (macOS and Linux, amd64 and arm64) and released on GitHub.
It needs Go 1.27 or later to build (`toolchain go1.27.2` is pinned in `go.mod`). `ARCHITECTURE.md` holds the design and the layout; `CHANGELOG.md` holds every release's section.

The launcher installs the pinned release under `${AGENTS_CORE_HOME:-$HOME/.agents/core}/<version>` and checks the
asset's sha256 before it runs. With no binary and none downloadable it says why and exits 127 — except a hook,
which exits 0 at once and starts one detached download. A missing binary never blocks Claude Code.

## What it holds

One Go module, one binary. `cmd/plugin-core` is the only `main`: it dispatches the provider and the entry, and
carries the `--orphan-launch` plumbing that detaches job drivers. Everything else lives under `internal/`, in
layers whose import direction `internal/archtest` enforces:

- `internal/domain`: the pure core — brief schema and defaults, the job state machine, verdicts, prompt building,
  the AIMD concurrency limiter, usage, budgets, stream parsing, the provider and model catalog.
- `internal/ports` and `internal/adapters`: the interfaces (Worker, Git, JobStore, Semaphore, keystore, spool) and
  the thin I/O behind them — the headless claude worker, the omp/opencode/pi/zcode engines, git, shell gates, the
  file store with locks and slots, the OS keystores, the router's spool.
- `internal/app`: the use cases over those ports — submit, drive, decide, batch, board, usage, follow, cleanup.
- `internal/router`: the model router — the front that owns the port, the worker with the provider logic, the
  emergency passthrough, ensure, supervision, uninstall.
- `internal/cli`, `internal/render`, `internal/authpage`: argument parsing with one file per command and the fixed
  exit codes, the text renderers (board, job, review packet, usage), the one-time local page the key is entered on.
- `internal/providers`: the five providers as data, one file each, mirroring the plugins' `test/provider.ts`.

`ARCHITECTURE.md` names every package, the import rules, the brief schema and the job loop.

## Build and check

Run from `packages/core`:

```sh
go run ./scripts/build                      # 4 assets + SHA256SUMS in dist/
go run ./scripts/build -target linux/amd64  # one target, for a quick local run
go run ./scripts/build -manifest            # also write release/v<VERSION>.json
go run ./scripts/build -check               # rebuild and compare with the manifest
```

- Targets: darwin/amd64, darwin/arm64, linux/amd64, linux/arm64. Asset name `plugin-core-<os>-<arch>`.
- Every build pins `CGO_ENABLED=0` and an empty `GOFLAGS`, and passes `-trimpath`, `-buildvcs=false`, `-s -w` and
  a cleared build id, so the bytes depend only on the source, the `VERSION` and the target.
- `-check` exits 0 when every rebuilt asset matches `release/v<VERSION>.json`, 1 on any mismatch, and 4 when there
  is no manifest for the version in `VERSION`.

The checks CI runs on every push to `main` and every pull request:

```sh
test -z "$(gofmt -l .)"                          # no file needs gofmt
go build ./...                                   # production code builds without its tests
go vet ./...
go mod tidy -diff
go run honnef.co/go/tools/cmd/staticcheck@v0.8.2 ./...
go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
go test -race -timeout 7m -coverprofile=coverage.out -covermode=atomic ./...
go run ./scripts/covergate -profile coverage.out
go run ./scripts/releasenotes -version "$(cat VERSION)" -sums /dev/null -commit x >/dev/null
go run ./scripts/build -check                    # only while the version is untagged
```

- covergate wants 95% statements in `internal/domain` and 90% elsewhere under `internal/` (`internal/testkit`,
  `internal/archtest`, `cmd` and `scripts` are exempt), and fails on a gated package missing from the profile.
- `sh scripts/host-build.sh` builds `dist/plugin-core-host` and `dist/fakeclaude-host` (gitignored) for the
  plugins' shared suites; the repository root's `npm run check` runs them.
- The `core-macos` job runs the suite again on macOS and rebuilds linux/amd64 there: the digest must match the
  ubuntu build byte for byte.

## Release flow

1. Bump `VERSION` and add the version's section to `CHANGELOG.md`.
2. `go run ./scripts/build -manifest` and commit `VERSION` + `release/v<VERSION>.json`.
3. Push the tag `v<VERSION>` by hand; no workflow creates tags. `.github/workflows/release.yml` runs on it: it
   refuses a tag that does not name the committed `VERSION` and its manifest, rebuilds, refuses to publish if any
   sha256 differs from the manifest, then creates the GitHub release with the 4 assets, `SHA256SUMS` and a
   build-provenance attestation. The notes are the version's `CHANGELOG.md` section, the checksums and the commit
   (`go run ./scripts/releasenotes` builds them); a `VERSION` with no section fails CI before anything is
   published.
4. The plugins' `dist/run` pins that version and those sha256 values: `npm run build -w plugins/<p>` regenerates
   every launcher, and the five plugins' versions and the marketplace catalogue bump, so Claude Code installs the
   new launcher instead of its cached copy.
5. Any Go change after a manifest is written changes the digests (Go binaries record line numbers): regenerate
   the manifest and the launchers in the same branch before it merges.

## Verify a download

```sh
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify plugin-core-<os>-<arch> --repo MuhmdRaouf/claude-code-plugins
```

The binaries are built reproducibly — the same sources and version give the same bytes on any host — and the
`core-macos` CI job proves it whenever core changes, by rebuilding linux/amd64 on macOS.

## License

[GPL-3.0-or-later](../../LICENSE), like the repository.
GLM, Kimi, DeepSeek, MiniMax, Qwen and the engines it drives belong to their respective owners; they are named
only to say what the plugins work with.
