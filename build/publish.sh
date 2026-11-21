#!/bin/sh
# Puts a built release (build/release.sh, dist/release) on GitHub: the Release v<version> (the version in build.zig.zon),
# tagged on the commit being built, with Direct360AgentSetup.exe and direct360-agent_amd64.deb. The names carry no
# version, because Settings -> Processing links to releases/latest/download/<name>. Both are always there, so the
# Windows download never breaks. An existing Release of the same version gets the files replaced.
#
#   build/publish.sh
#
# Needs gh signed in (or GH_TOKEN) with write access to kneoio/direct360-agent, and the commit pushed.
set -eu
cd "$(dirname "$0")/.."

fail() { echo "publish: $*" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || fail "gh is needed to publish"
version=$(sed -n 's/.*\.version = "\(.*\)".*/\1/p' build.zig.zon)
[ -n "$version" ] || fail "no version in build.zig.zon"
files="dist/release/Direct360AgentSetup.exe dist/release/direct360-agent_amd64.deb"
for f in $files; do [ -f "$f" ] || fail "$f is missing: run build/release.sh first"; done

if gh release view "v$version" -R kneoio/direct360-agent >/dev/null 2>&1; then
  gh release upload "v$version" $files -R kneoio/direct360-agent --clobber
else
  gh release create "v$version" $files -R kneoio/direct360-agent \
    --target "$(git rev-parse HEAD)" --title "Direct360 Helper Agent $version" --notes-file build/release-notes.md
fi
echo "published v$version"
