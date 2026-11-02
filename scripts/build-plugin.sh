#!/bin/bash
# Assembles the installable plugin tree and packages it as a .txz + .md5,
# for attaching to a GitHub Release (see CLAUDE.md "Shipping model").
#
# Run by Gitea CI (release-readiness) and by .github/workflows/release.yml on a mirrored v* tag, and available locally for a test build (needs xz, which
# the claude-code container does not have). It only produces files; it neither
# tags nor publishes anything — see CLAUDE.md "Deploy and verify".
#
# Usage: scripts/build-plugin.sh [version]
#   version defaults to today's date (YYYY.MM.DD); the .plg's &version;
#   entity must be updated to match separately.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-$(date +%Y.%m.%d)}"
NAME="docker.netman"
# Slackware's upgradepkg/installpkg extracts a package relative to /, not
# relative to any "plugins" convention — the full absolute destination path
# has to be baked into the archive itself (see unraid-secretsman's
# scripts/build-plugin.sh header for the incident this convention avoids).
INSTALL_ROOT="usr/local/emhttp/plugins/$NAME"
BUILD_DIR="$(mktemp -d)"
PKG_DIR="$BUILD_DIR/$INSTALL_ROOT"
OUT_DIR="$REPO_ROOT/dist"

trap 'rm -rf "$BUILD_DIR"' EXIT

# Refuse to package anything if the .plg would not install, even when CI is bypassed.
php "$REPO_ROOT/scripts/check-plg.php" "$REPO_ROOT/$NAME.plg" || { echo "build aborted: broken .plg"; exit 1; }

echo "Building $NAME-$VERSION.txz ..."

mkdir -p "$PKG_DIR/include"

cp "$REPO_ROOT"/plugin/include/*.php "$PKG_DIR/include/"

# .page files must sit in the plugin's installed ROOT — Unraid's page loader
# globs plugins/*/*.page non-recursively.
cp "$REPO_ROOT"/plugin/*.page "$PKG_DIR/"
cp "$REPO_ROOT"/plugin/docker-netman-core.js "$PKG_DIR/"

# The Installed Plugins page renders README.md from the plugin's installed root
# (dynamix.plugin.manager/include/ShowPlugins.php: Markdown(plugins/{name}/README.md),
# falling back to a bare bold plugin name if absent). That is a one-line description
# slot in a shared table, NOT documentation: ship plugin/README.md, which follows the
# stock convention of a bold name plus one paragraph and no headings. Packaging the
# repo's own README.md put its `# Docker NetMan` H1 straight into that table, rendering
# the row several times the size of every stock plugin beside it — see issue #1.
cp "$REPO_ROOT"/plugin/README.md "$PKG_DIR/"

mkdir -p "$OUT_DIR"
TXZ_PATH="$OUT_DIR/$NAME-$VERSION.txz"
# Deterministic archive: sorted names, fixed mtime, numeric owner. The same source must give the same bytes on the
# Gitea runner and on the GitHub runner, because the .plg's &md5; is committed before the tag and the GitHub release
# workflow rebuilds and requires it to match (scripts/check-md5.sh).
( cd "$BUILD_DIR" && tar --sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 --numeric-owner -cJf "$TXZ_PATH" usr )

MD5=$(md5sum "$TXZ_PATH" | awk '{print $1}')
echo "$MD5" > "$OUT_DIR/$NAME.md5"

echo "Built: $TXZ_PATH"
echo "  md5: $MD5"
echo
echo "This is a local build. A release is: bump &version; in docker.netman.plg, write its ###<version>"
echo "  CHANGES entry, set &md5; to the md5 above (CI tells you the value), merge the PR on Gitea, then tag"
echo "  v<version> on Gitea. The tag is mirrored to GitHub and .github/workflows/release.yml publishes it."
echo "  Then run scripts/install-on-host.sh to put it on the Unraid host. See CLAUDE.md \"Deploy and verify\"."
