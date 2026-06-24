!macro MIDIMASTER_DELETE_LEGACY_RUN_VALUE
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MIDIMaster"
!macroend

!macro MIDIMASTER_DELETE_STARTUP_SHORTCUT
  Delete "$SMSTARTUP\MIDIMaster.lnk"
!macroend

!macro MIDIMASTER_WRITE_INSTALL_MARKER
  ClearErrors
  FileOpen $0 "$INSTDIR\.midimaster-installed" w
  IfErrors +4
  FileWrite $0 "MIDIMaster installed by NSIS$\r$\n"
  FileClose $0
  SetFileAttributes "$INSTDIR\.midimaster-installed" HIDDEN
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro MIDIMASTER_DELETE_LEGACY_RUN_VALUE
  !insertmacro MIDIMASTER_WRITE_INSTALL_MARKER
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MIDIMASTER_DELETE_LEGACY_RUN_VALUE
  !insertmacro MIDIMASTER_DELETE_STARTUP_SHORTCUT
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro MIDIMASTER_DELETE_LEGACY_RUN_VALUE
  !insertmacro MIDIMASTER_DELETE_STARTUP_SHORTCUT
!macroend
