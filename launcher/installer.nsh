; ── Jain Office Suite — Post-install NSIS script ─────────────────────────────

!macro customInstall
  DetailPrint "Setting up JainDocument..."
  nsExec::ExecToLog '"$INSTDIR\resources\app\node_modules\electron\dist\electron.exe" --require module -e "var e=require(''child_process'');e.execSync(''npm install --ignore-scripts'',{cwd:''$INSTDIR\\resources\\jaindocument'',stdio:''inherit''})"'
  DetailPrint "Setting up JainSheet..."
  nsExec::ExecToLog '"$INSTDIR\resources\app\node_modules\electron\dist\electron.exe" --require module -e "var e=require(''child_process'');e.execSync(''npm install --ignore-scripts'',{cwd:''$INSTDIR\\resources\\jainsheet'',stdio:''inherit''})"'
  DetailPrint "Jain Office Suite is ready!"
!macroend

!macro customUnInstall
!macroend
