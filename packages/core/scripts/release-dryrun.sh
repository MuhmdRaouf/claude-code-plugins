#!/bin/sh
# Dry run of the shell steps in .github/workflows/release-core.yml. There is no act for the Actions layer,
# so this runs the release logic against a scratch copy of packages/core with a fake gh on PATH that
# prints its argv: the exact "gh release create" command runs without touching GitHub. The scratch copies
# are git repos, so the tag check is real; git fetch --tags is the one step left out (no network here).

set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../../.." && pwd)
workflow="$root/.github/workflows/release-core.yml"

fail() {
  printf 'release-dryrun: %s\n' "$1" >&2
  exit 1
}

# The workflow must exist and run the steps mirrored below.
[ -f "$workflow" ] || fail '.github/workflows/release-core.yml does not exist'
for pin in \
  'contents: write' \
  'id-token: write' \
  'attestations: write' \
  'go run ./scripts/build -check' \
  'go run ./scripts/build -out dist' \
  'attest-build-provenance' \
  'go run ./scripts/releasenotes -version "$VERSION" -sums dist/SHA256SUMS -commit "$GITHUB_SHA"' \
  'gh release create "$TAG" dist/plugin-core-* dist/SHA256SUMS'
do
  grep -qF -- "$pin" "$workflow" || fail "release-core.yml does not contain: $pin"
done

VERSION=$(cat "$root/packages/core/VERSION")
TAG="core-v$VERSION"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/release-dryrun.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
log="$tmp/log"
bin="$tmp/bin"
mkdir "$log" "$bin"

# The fake gh: prints and logs its argv, passes the release notes (stdin) through, always succeeds.
cat > "$bin/gh" <<'FAKE'
#!/bin/sh
{
  printf 'gh'
  for arg in "$@"; do printf ' %s' "$arg"; done
  printf '\n'
} | tee -a "${GH_ARGV_LOG:?}"
cat
exit 0
FAKE
chmod +x "$bin/gh"
PATH="$bin:$PATH"
export PATH
GH_ARGV_LOG="$log/gh-argv"
export GH_ARGV_LOG
: > "$GH_ARGV_LOG"

# The workflow's shell steps, run from a checkout's root. The attestation is an action, not shell, and
# -manifest is the releaser's local work, so neither runs as part of a release.
release_steps() (
  cd "$1" || exit 1
  VERSION=$(cat packages/core/VERSION)
  TAG="core-v$VERSION"
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    printf '%s already released\n' "$TAG"
    exit 0
  fi
  if [ ! -f "packages/core/release/v$VERSION.json" ]; then
    printf 'run go run ./scripts/build -manifest and commit release/v%s.json\n' "$VERSION" >&2
    exit 1
  fi
  cd packages/core || exit 1
  go run ./scripts/build -check
  go run ./scripts/build -out dist
  sha=$(git rev-parse HEAD)
  go run ./scripts/releasenotes -version "$VERSION" -sums dist/SHA256SUMS -commit "$sha" |
    gh release create "$TAG" dist/plugin-core-* dist/SHA256SUMS --title "plugin-core $VERSION" --notes-file -
)

happy="$tmp/checkout"
tagged="$tmp/tagged"
mkdir -p "$happy/packages" "$tagged/packages/core"
cp -R "$root/packages/core" "$happy/packages/"
# The scratch checkout starts without a manifest: a committed release/v<VERSION>.json would skip the refusal
# the first case proves, and the -manifest step below pins a fresh one anyway.
rm -rf "$happy/packages/core/release"
cp "$root/packages/core/VERSION" "$tagged/packages/core/VERSION"
git -C "$happy" -c init.defaultBranch=main init -q
git -C "$happy" -c user.name=release-dryrun -c user.email=release-dryrun@invalid -c commit.gpgsign=false \
  commit -q --allow-empty -m "dry run"
git -C "$tagged" -c init.defaultBranch=main init -q
git -C "$tagged" -c user.name=release-dryrun -c user.email=release-dryrun@invalid -c commit.gpgsign=false \
  commit -q --allow-empty -m "dry run"
# A lightweight tag: a global tag.gpgsign would make plain "git tag" annotated and ask for a message.
git -C "$tagged" -c tag.gpgsign=false tag "$TAG"

printf '# no manifest yet: the release must refuse\n'
set +e
release_steps "$happy" >"$log/guard.out" 2>"$log/guard.err"
guard_rc=$?
set -e
cat "$log/guard.err" >&2
[ "$guard_rc" -eq 1 ] || fail "without a manifest the release must exit 1, got $guard_rc"
[ "$(cat "$log/guard.out")" = "" ] || fail "without a manifest nothing may go to stdout"
[ "$(cat "$log/guard.err")" = "run go run ./scripts/build -manifest and commit release/v$VERSION.json" ] ||
  fail "wrong missing-manifest message"

printf '# pinning the manifest: go run ./scripts/build -manifest\n'
(cd "$happy/packages/core" && go run ./scripts/build -manifest)

printf '# the release\n'
if release_steps "$happy" >"$log/release.out" 2>"$log/release.err"; then release_rc=0; else release_rc=$?; fi
cat "$log/release.out"
cat "$log/release.err" >&2
[ "$release_rc" -eq 0 ] || fail "the release steps exited $release_rc"

assets='dist/plugin-core-darwin-amd64 dist/plugin-core-darwin-arm64 dist/plugin-core-linux-amd64 dist/plugin-core-linux-arm64'
expected="gh release create $TAG $assets dist/SHA256SUMS --title plugin-core $VERSION --notes-file -"
[ "$(cat "$GH_ARGV_LOG")" = "$expected" ] || fail "wrong gh argv:
got:  $(cat "$GH_ARGV_LOG")
want: $expected"

sha=$(git -C "$happy" rev-parse HEAD)
# The wanted notes come from the same builder over the same inputs, so the cmp proves the pipeline carried the
# builder's output, the real commit sha and the built sums into gh's stdin.
(cd "$happy/packages/core" &&
  go run ./scripts/releasenotes -version "$VERSION" -sums dist/SHA256SUMS -commit "$sha") >"$log/notes.want"
sums=$(grep -c . "$happy/packages/core/dist/SHA256SUMS")
tail -n "$(wc -l <"$log/notes.want" | tr -d '[:space:]')" "$log/release.out" >"$log/notes.got"
cmp -s "$log/notes.want" "$log/notes.got" || fail "wrong release notes:
$(diff "$log/notes.want" "$log/notes.got")"
[ "$(grep -c '^ok plugin-core-' "$log/release.out")" -eq "$sums" ] ||
  fail "go run ./scripts/build -check did not verify every asset"

mv "$GH_ARGV_LOG" "$log/gh-argv-release"
: > "$GH_ARGV_LOG"
printf '# %s already tagged: the release must stop\n' "$TAG"
if release_steps "$tagged" >"$log/tagged.out" 2>"$log/tagged.err"; then tagged_rc=0; else tagged_rc=$?; fi
cat "$log/tagged.out"
[ "$tagged_rc" -eq 0 ] || fail "an existing tag must stop the release with success, got $tagged_rc"
[ "$(cat "$log/tagged.out")" = "$TAG already released" ] || fail "wrong already-released message"
if [ -s "$GH_ARGV_LOG" ]; then fail "gh must not run when $TAG exists"; fi

printf 'release-dryrun: ok\n'
