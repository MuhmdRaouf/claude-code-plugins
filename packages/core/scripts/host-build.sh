#!/bin/sh
# Builds the host binaries the parity suite runs (`npm run test:go` in plugins/zai-plugin-cc)
# into dist/, which is gitignored: never commit them.
#   plugin-core-host   the plugin-core binary the e2e suites call as `<E2E_CLI> zai cli …`
#   fakeclaude-host    the Go fake claude the workers run (`E2E_FAKE_CLAUDE`)
set -e
dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$dir"
version=$(cat VERSION)
mkdir -p dist
CGO_ENABLED=0 go build \
  -ldflags "-X github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters.version=$version" \
  -o dist/plugin-core-host ./cmd/plugin-core
CGO_ENABLED=0 go build -o dist/fakeclaude-host ./internal/testkit/cmd/fakeclaude
echo "built dist/plugin-core-host and dist/fakeclaude-host"
