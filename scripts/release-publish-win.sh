#!/bin/sh
# The Windows files of the published release at HEAD (v1.0.N): the unsigned
# installer, its blockmap, the zip and latest.yml, the feed file a Windows
# install reads, made by scripts/release-win.ts and added to the release.
# release-publish.sh runs it once the Mac's release is live, so nothing here
# can hold back or fail the Mac's; by hand it adds the files to a release
# that went out without them, from that release's own tag.
#
#   scripts/release-publish-win.sh [--built] [--dry-run]
#     --built    out/ is already HEAD's build (release-publish.sh's own)
#     --dry-run  build and check; nothing uploaded
#
# Its lines are release-publish.sh's (src/shared/releasePhases.ts):
#   phase › windows
#   phase ✓ windows 4m12s
#   phase ✗ windows 3m02s
#   proof ✗ windows <why, in one line>, log <path>
# The proof line makes a failure the app's notice beside a live release
# ("The proofs after v1.0.N are red: …"), never a failed release. Exits 0
# when the files are on the release (or built, on --dry-run), else 1.
#
# Adding files to a release does not make it Latest, and this script never
# publishes one; it still reads Latest before and after and puts it back if
# it moved (an older release published again took Latest on 2026-11-23).
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

BUILT=0
DRY=0
while [ $# -gt 0 ]; do
  case $1 in
    --built) BUILT=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "usage: $0 [--built] [--dry-run]" >&2; exit 2 ;;
  esac
  shift
done

REPO="LandonDev/temp-code"
VERSION=$(sed -n 's/^  "version": "\(1\.0\.[0-9]*\)",$/\1/p' package.json)
SHA=$(git rev-parse HEAD)
LOG="$(git rev-parse --absolute-git-dir)/temp-code-gate/windows.log"
mkdir -p "$(dirname "$LOG")"
: >"$LOG"
WHY=$(mktemp "${TMPDIR:-/tmp}/tc-win-why.XXXXXX")
trap 'rm -f "$WHY"' EXIT

now() { date +%s; }
fmt() { if [ "$1" -ge 60 ]; then echo "$(($1 / 60))m$(($1 % 60))s"; else echo "$1s"; fi; }
T0=$(now)
echo "phase › windows"
fail() {
  echo "phase ✗ windows $(fmt $(( $(now) - T0 )))"
  echo "proof ✗ windows $1, log $LOG"
  exit 1
}

[ -n "$VERSION" ] || fail "package.json version is not 1.0.N"
if [ "$DRY" = 0 ]; then
  gh auth token >/dev/null 2>&1 || fail "gh is not signed in"
  [ "$(gh release view "v$VERSION" --repo "$REPO" --json isDraft --jq .isDraft 2>/dev/null)" = false ] ||
    fail "v$VERSION is not a published release"
  # The release's own build: its files come from the commit its tag names.
  [ "$(git rev-parse -q --verify "v$VERSION^{commit}")" = "$SHA" ] ||
    fail "HEAD is not v$VERSION: check out the release's tag first"
fi

if [ "$BUILT" = 0 ]; then
  bun install --frozen-lockfile >>"$LOG" 2>&1 || fail "bun install failed"
  bunx electron-vite build >>"$LOG" 2>&1 || fail "electron-vite build failed"
fi
mkdir -p dist
bun scripts/release-win.ts --dist dist --sha "$SHA" --log "$LOG" >/dev/null 2>"$WHY" ||
  fail "not built: $(tail -1 "$WHY")"

if [ "$DRY" = 1 ]; then
  echo "phase ✓ windows $(fmt $(( $(now) - T0 )))"
  echo "windows: $VERSION's installer, zip and latest.yml built and checked in dist/; nothing uploaded"
  exit 0
fi

# latest.yml last, so a Windows install never reads a feed whose installer
# is not there yet.
LATEST=$(gh api "repos/$REPO/releases/latest" --jq .tag_name 2>/dev/null || true)
gh release upload "v$VERSION" --repo "$REPO" --clobber \
  "dist/temp-code-$VERSION-setup.exe" "dist/temp-code-$VERSION-setup.exe.blockmap" \
  "dist/TempCode-$VERSION-win-x64.zip" >>"$LOG" 2>&1 || fail "the upload failed"
gh release upload "v$VERSION" --repo "$REPO" --clobber dist/latest.yml >>"$LOG" 2>&1 || fail "the upload of latest.yml failed"

# What a Windows install will fetch, read back once a second for a minute.
served() { curl -sL "$1" | sed -n 's/^version: //p'; }
FEED="https://github.com/$REPO/releases/download/v$VERSION/latest.yml"
[ "$LATEST" = "v$VERSION" ] && FEED="https://github.com/$REPO/releases/latest/download/latest.yml"
tries=0
until [ "$(served "$FEED")" = "$VERSION" ]; do
  tries=$((tries + 1))
  [ "$tries" -lt 60 ] || fail "$FEED serves '$(served "$FEED")', not $VERSION"
  sleep 1
done

AFTER=$(gh api "repos/$REPO/releases/latest" --jq .tag_name 2>/dev/null || true)
if [ -n "$LATEST" ] && [ "$AFTER" != "$LATEST" ]; then
  gh release edit "$LATEST" --repo "$REPO" --latest >>"$LOG" 2>&1 || fail "Latest moved to $AFTER and could not be put back on $LATEST"
  echo "windows: Latest moved to $AFTER; put back on $LATEST"
fi

echo "phase ✓ windows $(fmt $(( $(now) - T0 )))"
echo "windows: https://github.com/$REPO/releases/download/v$VERSION/temp-code-$VERSION-setup.exe"
