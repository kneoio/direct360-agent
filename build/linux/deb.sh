#!/bin/sh
# Builds the Ubuntu/Debian package from a staged Linux package (node build/stage.mjs --target linux-x64):
# /opt/direct360-agent (the agent with its node/, ffmpeg/ and job pipeline), /usr/bin/direct360-agent, an
# Applications entry and its icon. The tray needs libayatana-appindicator3 (and so GTK 3), which apt installs with it.
#
#   build/linux/deb.sh <staged folder> <version> <output folder>
set -eu
staged=$(cd "$1" && pwd)
version=$2
out=$(mkdir -p "$3" && cd "$3" && pwd)
here=$(cd "$(dirname "$0")/../.." && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

mkdir -p "$root/opt" "$root/usr/bin" "$root/usr/share/applications" "$root/usr/share/icons/hicolor/256x256/apps" "$root/DEBIAN"
cp -a "$staged" "$root/opt/direct360-agent"
ln -s /opt/direct360-agent/direct360-agent "$root/usr/bin/direct360-agent"
cp "$here/assets/icon-256.png" "$root/usr/share/icons/hicolor/256x256/apps/direct360-agent.png"
cat > "$root/usr/share/applications/direct360-agent.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Direct360 Agent
Comment=Runs your Direct360 heavy work on this computer
Exec=/opt/direct360-agent/direct360-agent
Icon=direct360-agent
Terminal=false
Categories=AudioVideo;Video;
DESKTOP

size=$(du -sk --exclude=DEBIAN "$root" | cut -f1)
cat > "$root/DEBIAN/control" <<CONTROL
Package: direct360-agent
Version: $version
Architecture: amd64
Maintainer: Direct360 <noreply@direct360.app>
Installed-Size: $size
Depends: libc6 (>= 2.31), libayatana-appindicator3-1
Section: video
Priority: optional
Homepage: https://github.com/kneoio/direct360-agent
Description: Runs Direct360's heavy video jobs on your own computer
 Direct360 Agent takes the stitch, camera grid, preview copy, telemetry and render
 jobs of a Direct360 account and runs them here instead of the cloud. It lives in
 the tray and connects in the browser. Node, ffmpeg (GPL) and the job pipeline
 are included.
CONTROL
# Removing the package stops the agent (the uninstaller does the same on Windows).
cat > "$root/DEBIAN/prerm" <<'PRERM'
#!/bin/sh
set -e
if [ "$1" = remove ]; then pkill -f '^/opt/direct360-agent/direct360-agent' || true; fi
PRERM
chmod 755 "$root/DEBIAN/prerm"

deb="$out/direct360-agent_${version}_amd64.deb"
dpkg-deb --root-owner-group -Zxz --build "$root" "$deb"
echo "$deb"
