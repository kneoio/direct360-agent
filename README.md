# Direct360 agent

Runs a [Direct360](https://direct360.app) user's heavy video jobs (`.360` stitch, camera grid, preview copy, telemetry,
preview and final renders) on their own computer instead of the cloud. It is the native successor of the
[Direct360 Helper](https://github.com/kneoio/direct360-helper), written in Zig: one small program per system, no runtime
to install for the agent itself.

It speaks the same protocol as the helper: it pairs with a one-time code from Profile → Processing, takes jobs from the
Direct360 server by long poll, reports progress and live usage (CPU load, busy cores, memory), stops a job's whole
process tree when the server cancels it, and reports the result. ffmpeg does the video work, unchanged.

## Status

Pairing, jobs, progress, cancel, live stats, machine info and a log file work, checked end to end against the Direct360
server. Jobs still run the job pipeline of `kneoio/direct360-helper` 2.0.4 (`worker/render.js`) on Node; porting it is
the next stage. Not yet: tray icon, pairing from the browser, self-update, installers.

## Windows package

Each [release](https://github.com/kneoio/direct360-agent/releases) has `direct360-agent-<version>-windows-x64.zip` with
everything inside: the agent, Node, ffmpeg (GPL) and the job pipeline. Unzip it anywhere, then:

```
direct360-agent.exe pair ABCD-EFGH     # once, code from Profile → Processing
direct360-agent.exe                    # keep it running
direct360-agent.exe log                # the last lines of its log
```

The package is built by `build/stage.mjs` and smoke-tested on Windows (`test/smoke.test.mjs`: pair, a preview render, the
outdated refusal) before each release (`.github/workflows/release.yml`).

## Run from source

Needs ffmpeg/ffprobe, Node 20+ and a checkout of `kneoio/direct360-helper` (for `worker/render.js`).

```
direct360-agent pair ABCD-EFGH --worker ../direct360-helper/worker/render.js   # once, code from Profile → Processing
direct360-agent --worker ../direct360-helper/worker/render.js                  # keep it running
direct360-agent info --worker ../direct360-helper/worker/render.js             # what this computer reports
direct360-agent log                                                            # the last lines of the log
```

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
