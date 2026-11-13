Runs your Direct360 heavy work (stitch, camera grid, preview copy, telemetry, renders) on your own computer.

**Windows:** download `Direct360AgentSetup.exe` and run it. Direct360 Helper Agent starts in the tray and opens Direct360 in your browser: confirm there and it is connected. Right-click the tray icon for its menu (status, Connect to Direct360…, Open Direct360, Start when the computer starts, Show log, Quit). The build is not code-signed yet, so Windows may warn about an unknown publisher ("More info" → "Run anyway").

**Linux (Ubuntu 20.04 or newer, 64-bit):** download `direct360-agent_amd64.deb` and install it: `sudo apt install ./direct360-agent_amd64.deb`. Start Direct360 Helper Agent from your applications; it appears in the top bar and opens Direct360 in your browser to connect. The same menu is on its icon. On a computer without a desktop, run `direct360-agent --headless` in a terminal.

Nothing else to install: Node, ffmpeg and the job pipeline are inside.

ffmpeg/ffprobe are GPL software (`ffmpeg/LICENSE.txt` in the install folder, source in `ffmpeg/SOURCE.txt`); see `THIRD-PARTY.txt` there for everything bundled.
