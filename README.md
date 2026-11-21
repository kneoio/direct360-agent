# Direct360 Helper Agent

Runs a [Direct360](https://direct360.app) user's heavy video jobs (`.360` stitch, camera grid, preview copy, telemetry,
preview and final renders) on their own computer instead of the cloud. Written in Zig: one small program per system,
no runtime to install for the agent itself.

It pairs with a one-time code from Settings → Processing, takes jobs from the
Direct360 server by long poll, reports progress and live usage (CPU load, busy cores, memory), stops a job's whole
process tree when the server cancels it, and reports the result. ffmpeg does the video work, unchanged.

## Status

Windows and Linux (Ubuntu): a tray app with an installer (`.exe`, `.deb`), connecting in the browser like
direct360-helper 2.0.4. Jobs run the job pipeline from [kneoio/direct360-pipeline](https://github.com/kneoio/direct360-pipeline) (`worker/render.js`) on Node,
bundled; porting it to Zig is the next stage. Not yet: self-update, a macOS package.

## Windows

`Direct360AgentSetup.exe` installs it for the current user (no administrator rights) and starts it. The
agent lives in the tray (the Direct360 lens mark; it pulses while a job runs). When it is not connected yet it opens
Direct360 → Settings → Processing in the browser; confirm there and it connects by itself. Its menu: the status and the
running jobs, Connect to Direct360…, Enter connection code…, Open Direct360, Start when the computer starts, Show log, Quit. The install folder
goes on the user's PATH, so `direct360-helper-agent` runs from a new terminal (`direct360-helper-agent pair <CODE>`);
`direct360-agent`, the name until 0.2.1, still works (`direct360-agent.cmd` beside it runs the same program).

Download it from [Releases](https://github.com/kneoio/direct360-agent/releases/latest). Everything it needs is inside:
Node, ffmpeg (GPL) and the job pipeline. Quitting it also stops a running render. Each build is smoke-tested on Windows before release (`test/smoke.test.mjs`: pair, a
preview render, the outdated refusal, the tray app taking a job) and the installer is installed, run and uninstalled.

## Linux

`direct360-agent_amd64.deb` (Ubuntu 20.04 or newer, Debian 11 or newer):
`sudo apt install ./direct360-agent_amd64.deb`. It installs into `/opt/direct360-agent`, with
`direct360-helper-agent` on the PATH (`direct360-agent`, the name until 0.2.1, runs the same program) and Direct360 Helper Agent in the applications. Started from there it lives in the top bar
(an AppIndicator; apt installs `libayatana-appindicator3-1` with it), with the same menu and the same browser connect
as on Windows; "Start when the computer starts" adds `~/.config/autostart/direct360-agent.desktop`. Without a desktop,
or with `--headless`, it runs in the terminal. Quitting it (or Ctrl+C) also stops a running render. Each build is
installed on Ubuntu and smoke-tested there, the tray on a virtual display.

## Run from source

Needs ffmpeg/ffprobe, Node 20+ and the job pipeline: a checkout of
[kneoio/direct360-pipeline](https://github.com/kneoio/direct360-pipeline) (`worker/render.js` and what it imports).

```
direct360-helper-agent pair ABCD-EFGH --worker ../direct360-pipeline/worker/render.js   # once, code from Settings → Processing
direct360-helper-agent --worker ../direct360-pipeline/worker/render.js                  # keep it running
direct360-helper-agent info --worker ../direct360-pipeline/worker/render.js             # what this computer reports
direct360-helper-agent log                                                       # the last lines of the log
```

On Windows and on a Linux desktop, `--headless` runs it in the terminal instead of the tray; `direct360-helper-agent connect`
pairs in the browser from the terminal.

Options: `--server <url>` (default `https://direct360.app/api`), `--ffmpeg <folder with ffmpeg and ffprobe>`,
`--worker <path to render.js>`, `--node <path>`, `--verbose`, `--no-log`. Beside a packaged agent, `node/`, `ffmpeg/`
and `worker/` are used without options. The pairing is kept in `~/.direct360-agent.json`, the log in
`~/.direct360-agent.log` (on while testing; `--no-log` turns it off).

## Build

Zig 0.17.1.

```
zig build                     # zig-out/bin/direct360-helper-agent
zig build test                # unit tests
zig build -Dtarget=x86_64-windows -Doptimize=ReleaseSmall
zig build -Dtarget=x86_64-linux-gnu.2.31 -Doptimize=ReleaseSmall
```

Releases are built by GitHub Actions, on GitHub's own machines, from this repo and the public
[direct360-pipeline](https://github.com/kneoio/direct360-pipeline): Actions → Release → Run workflow (on master; tick
*publish* to create the GitHub Release `v<version>` with `Direct360AgentSetup.exe` and `direct360-agent_amd64.deb`, and
pick the pipeline's branch, tag or commit). Without *publish* it only builds; the two files are the run's artifact, and
the run's summary shows both commits and the files' SHA-256.

The workflow runs `build/release.sh` (tests, the Linux and Windows builds, both packages with the pipeline from a
direct360-pipeline checkout, the `.deb`, and the Windows installer with NSIS's `makensis`, native on Linux:
`sudo apt install nsis`), which also runs on any Linux computer to try a build; the files land in `dist/release`, and
`build/publish.sh` publishes them. Settings: `ZIG`, `PIPELINE` (see the script).

By hand: `node build/stage.mjs --target windows-x64|linux-x64 --agent <binary> --pipeline <direct360-pipeline checkout>`,
then `makensis -DSOURCEDIR=dist/windows-x64 -DVERSION=<version> -DOUTDIR=dist build/windows/installer.nsi` or `build/linux/deb.sh dist/linux-x64 <version> dist`.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

Only the Windows installer built by the Release workflow (`.github/workflows/release.yml`) on GitHub's own machines is
signed, from this repository and [direct360-pipeline](https://github.com/kneoio/direct360-pipeline). Nothing built
anywhere else is signed.

Roles:
- Committers and reviewers: members of the [kneoio](https://github.com/kneoio) GitHub organization.
- Approvers: owners of the kneoio organization. Every signing request is approved by hand.

All members use two-factor authentication on GitHub and SignPath.

### Privacy

This program does not send any information to other networked systems unless the user asks it to. Once the user
connects it to their Direct360 account (by entering a connection code or confirming in the browser), it talks only to
direct360.app: it sends this computer's name, operating system, processor, memory and the video encoders and tools it
has, so Direct360 can offer the right jobs, and it downloads and uploads the files of the jobs it runs. See the
[Direct360 privacy policy](https://direct360.app/privacy).

## Licence

MIT.
