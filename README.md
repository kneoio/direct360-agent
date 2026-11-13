# Direct360 Helper Agent

Runs a [Direct360](https://direct360.app) user's heavy video jobs (`.360` stitch, camera grid, preview copy, telemetry,
preview and final renders) on their own computer instead of the cloud. It is the native successor of the
Direct360 Helper (the old Node program), written in Zig: one small program per system, no runtime
to install for the agent itself.

It speaks the same protocol as the helper: it pairs with a one-time code from Profile → Processing, takes jobs from the
Direct360 server by long poll, reports progress and live usage (CPU load, busy cores, memory), stops a job's whole
process tree when the server cancels it, and reports the result. ffmpeg does the video work, unchanged.

## Status

Windows and Linux (Ubuntu): a tray app with an installer (`.exe`, `.deb`), connecting in the browser like
direct360-helper 2.0.4. Jobs run the job pipeline in `pipeline/` (`worker/render.js`) on Node,
bundled; porting it to Zig is the next stage. Not yet: self-update, a macOS package.

## Windows

`Direct360AgentSetup.exe` installs it for the current user (no administrator rights) and starts it. The
agent lives in the tray (the Direct360 lens mark; it pulses while a job runs). When it is not connected yet it opens
Direct360 → Profile → Processing in the browser; confirm there and it connects by itself. Its menu: the status and the
running jobs, Connect to Direct360…, Open Direct360, Start when the computer starts, Show log, Quit.

Download it from [Releases](https://github.com/kneoio/direct360-agent/releases/latest). Everything it needs is inside:
Node, ffmpeg (GPL) and the job pipeline. Quitting it also stops a running render. Each build is smoke-tested on Windows before release (`test/smoke.test.mjs`: pair, a
preview render, the outdated refusal, the tray app taking a job) and the installer is installed, run and uninstalled.

## Linux

`direct360-agent_amd64.deb` (Ubuntu 20.04 or newer, Debian 11 or newer):
`sudo apt install ./direct360-agent_amd64.deb`. It installs into `/opt/direct360-agent`, with
`direct360-agent` on the PATH and Direct360 Helper Agent in the applications. Started from there it lives in the top bar
(an AppIndicator; apt installs `libayatana-appindicator3-1` with it), with the same menu and the same browser connect
as on Windows; "Start when the computer starts" adds `~/.config/autostart/direct360-agent.desktop`. Without a desktop,
or with `--headless`, it runs in the terminal. Quitting it (or Ctrl+C) also stops a running render. Each build is
installed on Ubuntu and smoke-tested there, the tray on a virtual display.

## Run from source

Needs ffmpeg/ffprobe and Node 20+. The job pipeline (`worker/render.js` and what it imports) is in `pipeline/`.

```
direct360-agent pair ABCD-EFGH --worker pipeline/worker/render.js   # once, code from Profile → Processing
direct360-agent --worker pipeline/worker/render.js                  # keep it running
direct360-agent info --worker pipeline/worker/render.js             # what this computer reports
direct360-agent log                                                            # the last lines of the log
```

On Windows and on a Linux desktop, `--headless` runs it in the terminal instead of the tray; `direct360-agent connect`
pairs in the browser from the terminal.

Options: `--server <url>` (default `https://direct360.app/api`), `--ffmpeg <folder with ffmpeg and ffprobe>`,
`--worker <path to render.js>`, `--node <path>`, `--verbose`, `--no-log`. Beside a packaged agent, `node/`, `ffmpeg/`
and `worker/` are used without options. The pairing is kept in `~/.direct360-agent.json`, the log in
`~/.direct360-agent.log` (on while testing; `--no-log` turns it off).

## Build

Zig 0.17.1.

```
zig build                     # zig-out/bin/direct360-agent
zig build test                # unit tests
zig build -Dtarget=x86_64-windows -Doptimize=ReleaseSmall
zig build -Dtarget=x86_64-linux-gnu.2.31 -Doptimize=ReleaseSmall
```

Packages: `node build/stage.mjs --target windows-x64|linux-x64 --agent <binary>` (the pipeline comes from `pipeline/`),
then `build/windows/installer.iss` (Inno Setup) or `build/linux/deb.sh dist/linux-x64 <version> dist`.

## Licence

MIT.
