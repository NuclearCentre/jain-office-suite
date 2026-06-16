; JainDocument — Custom NSIS include
; Adds Desktop Shortcut and Start Menu checkboxes to the installer

!macro customInstall
  ; Create Desktop shortcut
  CreateShortCut "$DESKTOP\JainDocument.lnk" "$INSTDIR\JainDocument.exe" "" "$INSTDIR\JainDocument.exe" 0

  ; Create Start Menu shortcut
  CreateDirectory "$SMPROGRAMS\JainDocument"
  CreateShortCut "$SMPROGRAMS\JainDocument\JainDocument.lnk" "$INSTDIR\JainDocument.exe" "" "$INSTDIR\JainDocument.exe" 0
  CreateShortCut "$SMPROGRAMS\JainDocument\Uninstall JainDocument.lnk" "$INSTDIR\Uninstall JainDocument.exe"
!macroend

!macro customUnInstall
  ; Remove Desktop shortcut
  Delete "$DESKTOP\JainDocument.lnk"

  ; Remove Start Menu shortcuts
  Delete "$SMPROGRAMS\JainDocument\JainDocument.lnk"
  Delete "$SMPROGRAMS\JainDocument\Uninstall JainDocument.lnk"
  RMDir "$SMPROGRAMS\JainDocument"
!macroend
