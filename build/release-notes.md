Runs your Direct360 heavy work (stitch, camera grid, preview copy, telemetry, renders) on your own computer.

**Windows (x64):** download `direct360-agent-<version>-windows-x64.zip`, unzip it anywhere, then in that folder:

```
direct360-agent.exe pair ABCD-EFGH     (the code from Direct360 → Profile → Processing)
direct360-agent.exe                    (keep it running)
direct360-agent.exe log                (the last lines of its log)
```

Nothing else to install: Node, ffmpeg and the job pipeline (direct360-helper 2.0.4) are inside. The build is not code-signed yet, so Windows may warn about an unknown publisher.

ffmpeg/ffprobe are GPL software (`ffmpeg/LICENSE.txt`, source in `ffmpeg/SOURCE.txt`); see `THIRD-PARTY.txt` for everything bundled.
