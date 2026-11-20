; Direct360 agent installer (NSIS 3). Installs for the current user, without administrator rights, into
; %LOCALAPPDATA%\Programs\Direct360 Agent, adds a Start menu entry and starts the agent when it finishes (the agent
; then opens the connect page in the browser), and puts the folder on the user's PATH for direct360-helper-agent (and
; direct360-agent.cmd, the old name). Over a running agent it closes it without asking (asking first only when it is
; working on a job) and starts the new version again when done. The uninstaller stops the agent and removes its autostart entry and the PATH entry.
; makensis runs natively on Linux, Windows and macOS:
;
;   makensis -DSOURCEDIR=<unzipped package> -DVERSION=<version> -DOUTDIR=<folder> build/windows/installer.nsi

!ifndef SOURCEDIR
  !error "SOURCEDIR is required: the staged Windows package"
!endif
!ifndef VERSION
  !error "VERSION is required"
!endif
!ifndef OUTDIR
  !define OUTDIR "."
!endif

!define APP "Direct360 Helper Agent"
!define EXE "direct360-helper-agent.exe"
!define OLD_EXE "direct360-agent.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Direct360Agent"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
; The 64-bit PowerShell: the installer is a 32-bit program, and a 32-bit PowerShell cannot see where 64-bit
; processes run from (the job check below).
!define POWERSHELL "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
RequestExecutionLevel user
Name "${APP}"
OutFile "${OUTDIR}/Direct360AgentSetup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\Direct360 Agent"
BrandingText "${APP} ${VERSION}"

!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

!define MUI_ICON "../../assets/app.ico"
!define MUI_UNICON "../../assets/app.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APP}"
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishShow
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Direct360"
VIAddVersionKey "FileDescription" "${APP} setup"
VIAddVersionKey "LegalCopyright" "Direct360"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "${APP} needs 64-bit Windows."
    Abort
  ${EndIf}
FunctionEnd

; The user's PATH (HKCU\Environment, unexpanded, so %VARS% in it stay as they are) with the install folder added once,
; or removed: PowerShell does the string work, as NSIS strings stop at 1024 characters and a long PATH would be cut.
; The folder goes in through the environment, so no character in it can break the command.
!macro EditUserPath ACTION
  System::Call 'kernel32::SetEnvironmentVariable(t "D360_INSTDIR", t "$INSTDIR")'
  nsExec::ExecToLog `"${POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = 'Stop'; $$dir = $$env:D360_INSTDIR; if (-not $$dir) { exit 2 }; $$k = (Get-Item 'HKCU:\').OpenSubKey('Environment', $$true); $$old = [string]$$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $$kind = if ($$old) { $$k.GetValueKind('Path') } else { 'ExpandString' }; $$parts = @($$old -split ';' | Where-Object { $$_ -and $$_.TrimEnd('\') -ne $$dir.TrimEnd('\') }); if ('${ACTION}' -eq 'add') { $$parts += $$dir }; $$k.SetValue('Path', ($$parts -join ';'), $$kind)"`
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "${APP}: the PATH could not be updated (error $0)."
    Abort
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

; 1 when an agent was running before the install: it is started again at the end, and the finish page does not offer it.
Var WasRunning

; Whether the agent runs (under either name), and whether it is busy with a job: the job's processes (Node, ffmpeg,
; aria2c, gpmf2json) run from the install folder. Exit 0: not running, 10: running and idle, 11: running a job.
!macro AgentState
  System::Call 'kernel32::SetEnvironmentVariable(t "D360_INSTDIR", t "$INSTDIR")'
  nsExec::Exec `"${POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = 'Stop'; $$agent = @(Get-Process -Name 'direct360-helper-agent', 'direct360-agent' -ErrorAction SilentlyContinue); if (-not $$agent) { exit 0 }; $$dir = $$env:D360_INSTDIR.TrimEnd('\') + '\'; $$job = @(Get-Process | Where-Object { $$_.Path -and $$_.Path.StartsWith($$dir, [StringComparison]::OrdinalIgnoreCase) -and $$_.ProcessName -notlike 'direct360*' }); if ($$job) { exit 11 }; exit 10"`
  Pop $0
!macroend

Function FinishShow
  ; Started again by the install already: no second start from the finish page.
  ${If} $WasRunning == 1
    SendMessage $mui.FinishPage.Run ${BM_SETCHECK} 0 0
    ShowWindow $mui.FinishPage.Run ${SW_HIDE}
  ${EndIf}
FunctionEnd

Section
  StrCpy $WasRunning 0
  !insertmacro AgentState
  ${If} $0 == 11
    ${If} ${Cmd} `MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "${APP} is working on a job right now. Installing stops that job.$\r$\n$\r$\nInstall now anyway?" /SD IDOK IDCANCEL`
      Abort "Not installed: ${APP} is working on a job."
    ${EndIf}
    StrCpy $0 10
  ${ElseIf} $0 != 0
  ${AndIf} $0 != 10
    MessageBox MB_ICONSTOP "${APP}: could not check whether it is running (error $0)." /SD IDOK
    Abort
  ${EndIf}
  ${If} $0 != 0
    StrCpy $WasRunning 1
  ${EndIf}
  ; A running agent holds its files: stop it before they are replaced (also one from before the rename).
  nsExec::Exec '"$SYSDIR\taskkill.exe" /IM ${EXE} /T /F'
  nsExec::Exec '"$SYSDIR\taskkill.exe" /IM ${OLD_EXE} /T /F'
  Sleep 500
  ; Until 0.2.1 the program was direct360-agent.exe; that name is now direct360-agent.cmd, which runs this one.
  Delete "$INSTDIR\${OLD_EXE}"
  SetOutPath "$INSTDIR"
  File /r "${SOURCEDIR}/*"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}"
  ; An autostart entry the agent wrote (Start when the computer starts) points at the program as it is now named.
  ReadRegStr $0 HKCU "${RUN_KEY}" "Direct360 Agent"
  ${If} $0 != ""
    WriteRegStr HKCU "${RUN_KEY}" "Direct360 Agent" '"$INSTDIR\${EXE}"'
  ${EndIf}
  ; direct360-helper-agent (and the old direct360-agent) run from any terminal.
  !insertmacro EditUserPath add

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Direct360"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "https://direct360.app"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "HelpLink" "https://github.com/kneoio/direct360-agent"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  ; It was running before: it runs again, the new version (also after a silent install).
  ${If} $WasRunning == 1
    Exec '"$INSTDIR\${EXE}"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  nsExec::Exec '"$SYSDIR\taskkill.exe" /IM ${EXE} /T /F'
  Sleep 500
  !insertmacro EditUserPath remove
  ; The agent writes its own autostart entry (Start when the computer starts); it goes with it.
  DeleteRegValue HKCU "${RUN_KEY}" "Direct360 Agent"
  Delete "$SMPROGRAMS\${APP}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
