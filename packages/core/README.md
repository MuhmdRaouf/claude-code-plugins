# core

The engine behind the five provider plugins: one static binary, `plugin-core`, that their committed `dist/run`
launcher downloads and executes. The plugins call it as `plugin-core <provider> <cli|router|passthrough|ensure>
[args...]`. It runs on no runtime; CI builds it for 4 platforms and releases it on GitHub. `ARCHITECTURE.md` holds
the design and the layout.

## Build

Run from `packages/core`:

```sh
go run ./scripts/build                      # 4 assets + SHA256SUMS in dist/
go run ./scripts/build -target linux/amd64  # one target, for a quick local run
go run ./scripts/build -manifest            # also write release/v<VERSION>.json
go run ./scripts/build -check               # rebuild and compare with the manifest
```

- Targets: darwin/amd64, darwin/arm64, linux/amd64, linux/arm64. Asset name `plugin-core-<os>-<arch>`.
- Every build pins `CGO_ENABLED=0` and an empty `GOFLAGS`, and passes `-trimpath`, `-buildvcs=false` and a
  cleared build id, so the bytes depend only on the source and `VERSION`.
- `-check` exits 0 when every rebuilt asset matches `release/v<VERSION>.json`, 1 on any mismatch, and 4 when
  there is no manifest for the version in `VERSION`.

## Release flow

1. Bump `VERSION` and add the version's section to `CHANGELOG.md`.
2. `go run ./scripts/build -manifest` and commit `VERSION` + `release/v<VERSION>.json`.
3. Push the tag `v<VERSION>` by hand (no workflow creates tags); `.github/workflows/release.yml` runs on it. It
   refuses a tag that does not name the committed VERSION and its manifest, rebuilds, refuses to publish if any
   sha256 differs from the manifest, then creates the GitHub release with the 4 assets and SHA256SUMS. The notes
   are the version's `CHANGELOG.md` section, the checksums and the commit (`go run ./scripts/releasenotes` builds
   them); a `VERSION` with no section there fails CI.
4. The plugins' `dist/run` pins that version and those sha256 values.
