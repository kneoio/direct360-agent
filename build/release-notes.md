Runs your Direct360 heavy work (stitch, camera grid, preview copy, telemetry, renders) on your own computer.

**Windows:** download `Direct360AgentSetup-<version>.exe` and run it. Direct360 Agent starts in the tray and opens Direct360 in your browser: confirm there and it is connected. Right-click the tray icon for its menu (status, Connect to Direct360…, Open Direct360, Start when the computer starts, Show log, Quit).

Nothing else to install: Node, ffmpeg and the job pipeline (direct360-helper 2.0.4) are inside. The build is not code-signed yet, so Windows may warn about an unknown publisher ("More info" → "Run anyway").

ffmpeg/ffprobe are GPL software (`ffmpeg\LICENSE.txt` in the install folder, source in `ffmpeg\SOURCE.txt`); see `THIRD-PARTY.txt` there for everything bundled.
