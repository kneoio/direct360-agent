; Direct360 agent installer (NSIS 3). Installs for the current user, without administrator rights, into
; %LOCALAPPDATA%\Programs\Direct360 Agent, adds a Start menu entry and starts the agent when it finishes (the agent
; then opens the connect page in the browser). The uninstaller stops the agent and removes its autostart entry.
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
!define EXE "direct360-agent.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Direct360Agent"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

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

!define MUI_ICON "../../assets/app.ico"
!define MUI_UNICON "../../assets/app.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APP}"
!insertmacro MUI_PAGE_INSTFILES
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

Section
  ; A running agent holds its files: stop it before they are replaced.
  nsExec::Exec '"$SYSDIR\taskkill.exe" /IM ${EXE} /T /F'
  Sleep 500
  SetOutPath "$INSTDIR"
  File /r "${SOURCEDIR}/*"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}"

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
SectionEnd

Section "Uninstall"
  nsExec::Exec '"$SYSDIR\taskkill.exe" /IM ${EXE} /T /F'
  Sleep 500
  ; The agent writes its own autostart entry (Start when the computer starts); it goes with it.
  DeleteRegValue HKCU "${RUN_KEY}" "Direct360 Agent"
  Delete "$SMPROGRAMS\${APP}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
