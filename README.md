# Direct360 agent

Runs a [Direct360](https://direct360.app) user's heavy video jobs (`.360` stitch, camera grid, preview copy, telemetry,
preview and final renders) on their own computer instead of the cloud. It is the native successor of the
[Direct360 Helper](https://github.com/kneoio/direct360-helper), written in Zig: one small program per system, no runtime
to install for the agent itself.

It speaks the same protocol as the helper: it pairs with a one-time code from Profile → Processing, takes jobs from the
Direct360 server by long poll, reports progress and live usage (CPU load, busy cores, memory), stops a job's whole
process tree when the server cancels it, and reports the result. ffmpeg does the video work, unchanged.

## Status

Foundation. Pairing, jobs, progress, cancel, live stats and machine info work and are checked end to end against the
Direct360 server. The jobs themselves still run the helper's worker pipeline (`worker/render.js` from
`kneoio/direct360-helper`) on Node; porting it step by step is the next stage. Not yet: tray icon, pairing from the
browser, self-update, installers.

## Use

Needs ffmpeg/ffprobe, Node 20+ and a checkout of `kneoio/direct360-helper` (for `worker/render.js`).

```
direct360-agent pair ABCD-EFGH --worker ../direct360-helper/worker/render.js   # once, code from Profile → Processing
direct360-agent --worker ../direct360-helper/worker/render.js                  # keep it running
direct360-agent info --worker ../direct360-helper/worker/render.js             # what this computer reports
```

Options: `--server <url>` (default `https://direct360.app/api`), `--ffmpeg <folder with ffmpeg and ffprobe>`,
`--worker <path to render.js>` (default `worker/render.js` beside the agent, one folder up, or in the current folder),
`--node <path>`, `--verbose`. The pairing is kept in `~/.direct360-agent.json`.

## Build

Zig 0.17.1.

```
zig build                     # zig-out/bin/direct360-agent
zig build test                # unit tests
zig build -Dtarget=x86_64-windows -Doptimize=ReleaseSmall
```

## Licence

MIT.
