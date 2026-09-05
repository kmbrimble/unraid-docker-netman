#!/bin/bash
# Assembles the installable plugin tree and packages it as a .txz + .md5,
# for attaching to a GitHub Release (see CLAUDE.md "Shipping model").
#
# NOT run automatically by anything — a deliberate, manual release step.
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
( cd "$BUILD_DIR" && tar -cJf "$TXZ_PATH" usr )

MD5=$(md5sum "$TXZ_PATH" | awk '{print $1}')
echo "$MD5" > "$OUT_DIR/$NAME.md5"

echo "Built: $TXZ_PATH"
echo "  md5: $MD5"
echo
echo "Next (manual, not run by this script):"
echo "  1. Update docker.netman.plg: &version; to $VERSION, &md5; to $MD5"
echo "  2. git commit the updated .plg"
echo "  3. gh release create v$VERSION $TXZ_PATH $OUT_DIR/$NAME.md5"
