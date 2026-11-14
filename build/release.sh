#!/bin/sh
# Builds a release of the agent on this computer, always the same way, and with --publish puts it on GitHub.
#
#   build/release.sh [--publish]
#
# Steps: unit tests; the agent for Linux and Windows (Zig cross-compiles both); each package staged with the job
# pipeline from direct360-server's pipeline/ (build/stage.mjs: the agent, Node, ffmpeg, the pipeline, gpmf2json); the
# Ubuntu .deb (build/linux/deb.sh); the Windows installer (build/windows/installer.nsi, NSIS, native on Linux).
# --publish then creates the GitHub Release v<version> (the version in build.zig.zon) with Direct360AgentSetup.exe and
# direct360-agent_amd64.deb, names without the version, because Profile -> Processing links to
# releases/latest/download/<name>. Both are always built, so the Windows download never breaks.
#
# Settings (environment):
#   ZIG       the zig to use; default: zig on PATH, else the newest in ~/.local/share/zig/
#   PIPELINE  direct360-server's pipeline/ folder; default: ~/WebstormProjects/direct360-server/pipeline
#
# Needs Node 20+, dpkg-deb, makensis (Ubuntu: apt install nsis), curl access to nodejs.org and the ffmpeg builds,
# and for --publish a gh signed in with write access to kneoio/direct360-agent. The commit being released should be pushed first (the release is tagged on it).
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"
publish=false
[ "${1:-}" = "--publish" ] && publish=true

fail() { echo "release: $*" >&2; exit 1; }

# Zig: ZIG, else on PATH, else the newest one unpacked in ~/.local/share/zig/<version>/zig.
if [ -z "${ZIG:-}" ]; then
  if command -v zig >/dev/null 2>&1; then ZIG=$(command -v zig)
  else ZIG=$(ls -d "$HOME"/.local/share/zig/*/zig 2>/dev/null | sort -V | tail -n 1)
  fi
fi
[ -x "${ZIG:-}" ] || fail "no zig found: set ZIG"
command -v makensis >/dev/null 2>&1 || fail "makensis is needed for the Windows installer (Ubuntu: sudo apt install nsis)"
PIPELINE=${PIPELINE:-$HOME/WebstormProjects/direct360-server/pipeline}
[ -f "$PIPELINE/worker/render.js" ] || fail "no pipeline at $PIPELINE: set PIPELINE to direct360-server's pipeline/"
version=$(sed -n 's/.*\.version = "\(.*\)".*/\1/p' build.zig.zon)
[ -n "$version" ] || fail "no version in build.zig.zon"
# The agent says its own version (src/machine.zig): it must be the release's.
grep -q "pub const version = \"$version\";" src/machine.zig || fail "src/machine.zig version is not $version (build.zig.zon)"
echo "release $version: zig $("$ZIG" version), pipeline $PIPELINE"

# stage.mjs compiles gpmf2json with `zig cc`: the same zig goes first on PATH.
PATH="$(dirname "$ZIG"):$PATH"
export PATH

"$ZIG" build test --summary failures
rm -rf dist zig-out-release
"$ZIG" build -Dtarget=x86_64-linux-gnu.2.31 -Doptimize=ReleaseSmall --prefix zig-out-release/linux
"$ZIG" build -Dtarget=x86_64-windows -Doptimize=ReleaseSmall --prefix zig-out-release/windows

node build/stage.mjs --target linux-x64 --pipeline "$PIPELINE" --agent zig-out-release/linux/bin/direct360-agent
sh build/linux/deb.sh dist/linux-x64 "$version" dist
# The packaged agent must start and find its ffmpeg, Node and pipeline.
dist/linux-x64/direct360-agent info --headless --no-log 2>&1 | grep -q '"ffmpeg"' || fail "the Linux package does not run"

node build/stage.mjs --target windows-x64 --pipeline "$PIPELINE" --agent zig-out-release/windows/bin/direct360-agent.exe

# The Windows installer.
makensis -V2 "-DSOURCEDIR=$here/dist/windows-x64" "-DVERSION=$version" "-DOUTDIR=$here/dist" build/windows/installer.nsi
setup=dist/Direct360AgentSetup-$version.exe
[ -f "$setup" ] || fail "makensis made no installer"

echo
echo "built:"
ls -la dist/*.deb dist/*.zip dist/*.tar.gz "$setup"

$publish || exit 0
command -v gh >/dev/null 2>&1 || fail "gh is needed to publish"
out=dist/release
mkdir -p "$out"
cp "$setup" "$out/Direct360AgentSetup.exe"
cp dist/direct360-agent_"$version"_amd64.deb "$out/direct360-agent_amd64.deb"
if gh release view "v$version" -R kneoio/direct360-agent >/dev/null 2>&1; then
  gh release upload "v$version" "$out/Direct360AgentSetup.exe" "$out/direct360-agent_amd64.deb" -R kneoio/direct360-agent --clobber
else
  gh release create "v$version" "$out/Direct360AgentSetup.exe" "$out/direct360-agent_amd64.deb" -R kneoio/direct360-agent \
    --target "$(git rev-parse HEAD)" --title "Direct360 Helper Agent $version" --notes-file build/release-notes.md
fi
echo "published v$version"
