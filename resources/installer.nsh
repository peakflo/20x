!include "WinMessages.nsh"

!define PYTHON_VERSION "3.11.9"
!define PYTHON_INSTALLER_URL "https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-amd64.exe"

Function BroadcastEnvironmentChange
  System::Call 'user32::SendMessageTimeoutW(p ${HWND_BROADCAST}, i ${WM_SETTINGCHANGE}, p 0, w "Environment", i 0, i 5000, *p .r0)'
FunctionEnd

Function InstallPythonIfMissing
  DetailPrint "Checking for an existing Python installation..."

  nsExec::ExecToStack '"$SYSDIR\where.exe" python.exe'
  Pop $0
  Pop $1
  StrCmp $0 0 pythonAlreadyInstalled

  nsExec::ExecToStack '"$SYSDIR\where.exe" py.exe'
  Pop $0
  Pop $1
  StrCmp $0 0 pythonAlreadyInstalled

  StrCpy $0 "$TEMP\python-installer.exe"
  DetailPrint "Downloading Python ${PYTHON_VERSION}..."
  inetc::get /SILENT "${PYTHON_INSTALLER_URL}" "$0"
  Pop $1
  StrCmp $1 "OK" downloadSucceeded

  MessageBox MB_ICONEXCLAMATION|MB_OK "20x could not download Python automatically ($1). Installation will continue, but Python may need to be installed later from python.org."
  Delete "$0"
  Return

  downloadSucceeded:
  DetailPrint "Installing Python ${PYTHON_VERSION}..."
  ExecWait '"$0" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_pip=1 Include_test=0 Shortcuts=0 SimpleInstall=1' $1
  Delete "$0"
  StrCmp $1 0 pythonInstallSucceeded

  MessageBox MB_ICONEXCLAMATION|MB_OK "Python installer exited with code $1. 20x will finish installing, but Python may not be available until you install it manually."
  Return

  pythonInstallSucceeded:
  Call BroadcastEnvironmentChange
  DetailPrint "Python installed successfully."
  Return

  pythonAlreadyInstalled:
  DetailPrint "Python already detected. Skipping Python installation."
FunctionEnd

!macro customInstall
  Call InstallPythonIfMissing
!macroend

!macro customUnInstall
  ; Upgrades run the old uninstaller with --updated. Keep app data and do not
  ; show the destructive data-removal prompt during that path.
  ${if} ${isUpdated}
    goto doneRemoveData
  ${endif}

  ; Ask user whether to remove app data (database, settings, attachments)
  MessageBox MB_YESNO "Do you want to remove your 20x data (tasks, settings, attachments)?$\n$\nClick Yes to delete everything, or No to keep your data." IDYES removeData IDNO skipRemoveData

  removeData:
    ; Remove userData directory (%APPDATA%/20x)
    RMDir /r "$APPDATA\20x"
    goto doneRemoveData

  skipRemoveData:
    ; User chose to keep data

  doneRemoveData:
!macroend
