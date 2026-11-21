Runs your Direct360 heavy work (stitch, preview copy, telemetry, renders) on your own computer.

**Windows:** download `Direct360AgentSetup.exe` and run it. Direct360 Helper Agent starts in the tray and opens Direct360 in your browser: confirm there and it is connected. Right-click the tray icon for its menu (status, Connect to Direct360… and Enter connection code… or, once connected, Disconnect, Open Direct360, Start when the computer starts, Show log, Quit). The build is not code-signed yet, so Windows may warn about an unknown publisher ("More info" → "Run anyway"). In a terminal the program is `direct360-helper-agent` (for example `direct360-helper-agent pair <CODE>`); the old name `direct360-agent` still works.

**Linux (Ubuntu 20.04 or newer, 64-bit):** download `direct360-agent_amd64.deb` and install it: `sudo apt install ./direct360-agent_amd64.deb`. Start Direct360 Helper Agent from your applications; it appears in the top bar and opens Direct360 in your browser to connect. The same menu is on its icon. On a computer without a desktop, run `direct360-helper-agent --headless` in a terminal.

Nothing else to install: Node, ffmpeg and the job pipeline (github.com/kneoio/direct360-pipeline) are inside. Built by GitHub Actions from public source.

ffmpeg/ffprobe are GPL software (`ffmpeg/LICENSE.txt` in the install folder, source in `ffmpeg/SOURCE.txt`); see `THIRD-PARTY.txt` there for everything bundled.
