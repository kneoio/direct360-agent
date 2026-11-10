# Direct360 agent

Runs a [Direct360](https://direct360.app) user's heavy video jobs (`.360` stitch, camera grid, preview copy, telemetry,
preview and final renders) on their own computer instead of the cloud. It is the native successor of the
[Direct360 Helper](https://github.com/kneoio/direct360-helper), written in Zig: one small program per system, no runtime
to install for the agent itself.

It speaks the same protocol as the helper: it pairs with a one-time code from Profile → Processing, takes jobs from the
Direct360 server by long poll, reports progress and live usage (CPU load, busy cores, memory), stops a job's whole
process tree when the server cancels it, and reports the result. ffmpeg does the video work, unchanged.

## Status

Windows: a tray app with an installer, connecting in the browser like direct360-helper 2.0.4. Jobs still run the job
pipeline of `kneoio/direct360-helper` 2.0.4 (`worker/render.js`) on Node, bundled; porting it is the next stage. Not
yet: self-update, macOS and Linux packages.

## Windows

`Direct360AgentSetup-<version>.exe` installs it for the current user (no administrator rights) and starts it. The
agent lives in the tray (the Direct360 lens mark; it pulses while a job runs). When it is not connected yet it opens
Direct360 → Profile → Processing in the browser; confirm there and it connects by itself. Its menu: the status and the
running jobs, Connect to Direct360…, Open Direct360, Start when the computer starts, Show log, Quit.

Everything it needs is inside: Node, ffmpeg (GPL) and the job pipeline. Quitting it also stops a running render. The
same files come as a zip too. Each build is smoke-tested on Windows before release (`test/smoke.test.mjs`: pair, a
preview render, the outdated refusal, the tray app taking a job) and the installer is installed, run and uninstalled.

## Run from source

Needs ffmpeg/ffprobe, Node 20+ and a checkout of `kneoio/direct360-helper` (for `worker/render.js`).

```
direct360-agent pair ABCD-EFGH --worker ../direct360-helper/worker/render.js   # once, code from Profile → Processing
direct360-agent --worker ../direct360-helper/worker/render.js                  # keep it running
direct360-agent info --worker ../direct360-helper/worker/render.js             # what this computer reports
direct360-agent log                                                            # the last lines of the log
```

On Windows, `--headless` runs it in the terminal instead of the tray; `direct360-agent connect` pairs in the browser
from the terminal.

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
```

## Licence

MIT.
