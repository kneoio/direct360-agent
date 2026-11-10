; Direct360 agent installer (Inno Setup 6). Installs for the current user, without administrator rights, into
; %LOCALAPPDATA%\Programs\Direct360 Agent, adds a Start menu entry and starts the agent when it finishes (the agent
; then opens the connect page in the browser). The uninstaller stops the agent and removes its autostart entry.
;
;   iscc /DSourceDir=<unzipped package> /DAppVersion=<version> /DOutputDir=<folder> build\windows\installer.iss

#ifndef SourceDir
  #error SourceDir is required: the unzipped Windows package
#endif
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif

[Setup]
AppId={{3F6C2B8E-5D1A-4C7E-9B2F-8A4D6E1C0B37}
AppName=Direct360 Agent
AppVersion={#AppVersion}
AppVerName=Direct360 Agent {#AppVersion}
AppPublisher=Direct360
AppPublisherURL=https://direct360.app
AppSupportURL=https://github.com/kneoio/direct360-agent
DefaultDirName={localappdata}\Programs\Direct360 Agent
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=Direct360AgentSetup-{#AppVersion}
SetupIconFile=..\..\assets\app.ico
UninstallDisplayIcon={app}\direct360-agent.exe
UninstallDisplayName=Direct360 Agent
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=force
RestartApplications=no

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Direct360 Agent"; Filename: "{app}\direct360-agent.exe"

[Registry]
; Only removed on uninstall; the agent's menu adds it ("Start when the computer starts").
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "Direct360 Agent"; ValueType: none; Flags: uninsdeletevalue

[Run]
Filename: "{app}\direct360-agent.exe"; Description: "Start Direct360 Agent"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/IM direct360-agent.exe /T /F"; Flags: runhidden; RunOnceId: "StopAgent"
