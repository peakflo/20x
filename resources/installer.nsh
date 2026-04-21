!macro customInstall
  ; Reserved for post-install agent setup
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
