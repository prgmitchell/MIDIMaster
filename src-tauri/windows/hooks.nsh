!include "nsDialogs.nsh"

Var MIDIMASTER_VA_CHECKBOX
Var MIDIMASTER_VA_SELECTED
Var MIDIMASTER_VA_LICENSE_LINK
Var MIDIMASTER_VA_UNINSTALL_CHECKBOX
Var MIDIMASTER_VA_UNINSTALL_SELECTED

; Tauri includes installer hooks before declaring its standard pages. This
; makes the component chooser the first interactive page, while the function
; itself suppresses the page for passive and /UPDATE updater invocations.
Page custom MIDIMASTER_VA_PAGE MIDIMASTER_VA_PAGE_LEAVE
UninstPage custom un.MIDIMASTER_VA_PAGE un.MIDIMASTER_VA_PAGE_LEAVE

Function MIDIMASTER_VA_PAGE
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Virtual Audio" "Choose whether to add the MIDIMaster virtual microphone."

  ${NSD_CreateCheckbox} 0 0 100% 14u "Install Virtual Audio (recommended)"
  Pop $MIDIMASTER_VA_CHECKBOX
  ${If} $MIDIMASTER_VA_SELECTED == ""
    StrCpy $MIDIMASTER_VA_SELECTED 1
  ${EndIf}
  ${If} $MIDIMASTER_VA_SELECTED == 1
    ${NSD_Check} $MIDIMASTER_VA_CHECKBOX
  ${EndIf}

  ${NSD_CreateLabel} 0 25u 100% 35u "Adds a signed third-party USB system driver and the MIDIMaster Virtual Audio service. USB devices may briefly reconnect, administrator approval is required, and Windows may request a restart."
  Pop $0

  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=MIDIMaster-USBIP-License.txt "${__FILEDIR__}\virtual-audio\vendor\USBIP-WIN2-LICENSE.txt"
  ${NSD_CreateLink} 0 67u 100% 12u "View the usbip-win2 license"
  Pop $MIDIMASTER_VA_LICENSE_LINK
  ${NSD_OnClick} $MIDIMASTER_VA_LICENSE_LINK MIDIMASTER_VA_OPEN_LICENSE

  nsDialogs::Show
FunctionEnd

Function MIDIMASTER_VA_PAGE_LEAVE
  ${NSD_GetState} $MIDIMASTER_VA_CHECKBOX $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MIDIMASTER_VA_SELECTED 1
  ${Else}
    StrCpy $MIDIMASTER_VA_SELECTED 0
  ${EndIf}
FunctionEnd

Function MIDIMASTER_VA_OPEN_LICENSE
  ExecShell "open" "$PLUGINSDIR\MIDIMaster-USBIP-License.txt"
FunctionEnd

Function un.MIDIMASTER_VA_PAGE
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\MIDIMasterVirtualAudio" "ImagePath"
  ${If} $0 == ""
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Virtual Audio" "Choose whether to remove the MIDIMaster virtual microphone."
  ${NSD_CreateCheckbox} 0 0 100% 14u "Remove MIDIMaster Virtual Audio (recommended)"
  Pop $MIDIMASTER_VA_UNINSTALL_CHECKBOX
  ${If} $MIDIMASTER_VA_UNINSTALL_SELECTED == ""
    StrCpy $MIDIMASTER_VA_UNINSTALL_SELECTED 1
  ${EndIf}
  ${If} $MIDIMASTER_VA_UNINSTALL_SELECTED == 1
    ${NSD_Check} $MIDIMASTER_VA_UNINSTALL_CHECKBOX
  ${EndIf}
  ${NSD_CreateLabel} 0 25u 100% 32u "This removes only MIDIMaster's device and service. The shared USBIP driver remains installed so other software is not disrupted."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function un.MIDIMASTER_VA_PAGE_LEAVE
  ${NSD_GetState} $MIDIMASTER_VA_UNINSTALL_CHECKBOX $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MIDIMASTER_VA_UNINSTALL_SELECTED 1
  ${Else}
    StrCpy $MIDIMASTER_VA_UNINSTALL_SELECTED 0
  ${EndIf}
FunctionEnd

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
  ${If} $MIDIMASTER_VA_SELECTED == 1
    ${If} ${FileExists} "$INSTDIR\virtual-audio\midimaster-virtual-audio-setup.exe"
      DetailPrint "Requesting administrator approval for MIDIMaster Virtual Audio..."
      InitPluginsDir
      StrCpy $1 "$PLUGINSDIR\MIDIMaster-Virtual-Audio-install-result.txt"
      Delete "$1"
      ClearErrors
      ExecShellWait "runas" "$INSTDIR\virtual-audio\midimaster-virtual-audio-setup.exe" "install --result-file $\"$1$\"" SW_HIDE
      ${If} ${Errors}
        DetailPrint "Virtual Audio setup was cancelled; MIDIMaster installation will continue."
        MessageBox MB_OK|MB_ICONINFORMATION "MIDIMaster was installed without Virtual Audio because administrator approval was cancelled. You can install it later from Settings > Virtual Audio."
      ${Else}
        ${IfNot} ${FileExists} "$1"
          StrCpy $0 26
        ${Else}
          ClearErrors
          FileOpen $2 "$1" r
          ${If} ${Errors}
            StrCpy $0 26
          ${Else}
            FileRead $2 $0
            FileClose $2
          ${EndIf}
          Delete "$1"
        ${EndIf}
        ${If} $0 == 3010
          SetRebootFlag true
          DetailPrint "Virtual Audio installed; a Windows restart is required."
        ${ElseIf} $0 == 23
          DetailPrint "Virtual Audio blocked unsafe USBIP 0.9.7.8."
          MessageBox MB_OK|MB_ICONSTOP "MIDIMaster was installed, but Virtual Audio was skipped because USBIP 0.9.7.8 is installed and upstream warns that it may corrupt memory or cause a blue screen. Remove USBIP 0.9.7.8 from Windows Installed Apps, then retry from Settings > Virtual Audio."
        ${ElseIf} $0 == 24
          DetailPrint "Virtual Audio blocked an unsupported USBIP version."
          MessageBox MB_OK|MB_ICONEXCLAMATION "MIDIMaster was installed, but Virtual Audio was skipped because an unsupported USBIP version is installed. MIDIMaster will not replace or downgrade it automatically. Review it in Windows Installed Apps, then retry from Settings > Virtual Audio."
        ${ElseIf} $0 != 0
          DetailPrint "Virtual Audio setup returned $0; retry from Settings > Virtual Audio."
          MessageBox MB_OK|MB_ICONEXCLAMATION "MIDIMaster was installed, but Virtual Audio setup could not finish (code $0). You can retry from Settings > Virtual Audio."
        ${Else}
          DetailPrint "MIDIMaster Virtual Audio installed successfully."
        ${EndIf}
      ${EndIf}
    ${Else}
      DetailPrint "Virtual Audio payload is unavailable in this development bundle."
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MIDIMASTER_DELETE_LEGACY_RUN_VALUE
  !insertmacro MIDIMASTER_DELETE_STARTUP_SHORTCUT
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $0
  ${If} ${Errors}
    ${If} $MIDIMASTER_VA_UNINSTALL_SELECTED == 1
      ${If} ${FileExists} "$INSTDIR\virtual-audio\midimaster-virtual-audio-setup.exe"
        DetailPrint "Requesting administrator approval to remove MIDIMaster Virtual Audio..."
        InitPluginsDir
        StrCpy $1 "$PLUGINSDIR\MIDIMaster-Virtual-Audio-remove-result.txt"
        Delete "$1"
        ClearErrors
        ExecShellWait "runas" "$INSTDIR\virtual-audio\midimaster-virtual-audio-setup.exe" "remove --result-file $\"$1$\"" SW_HIDE
        ${If} ${Errors}
          DetailPrint "Virtual Audio removal was cancelled. The service may remain installed."
        ${Else}
          ${IfNot} ${FileExists} "$1"
            StrCpy $0 26
          ${Else}
            ClearErrors
            FileOpen $2 "$1" r
            ${If} ${Errors}
              StrCpy $0 26
            ${Else}
              FileRead $2 $0
              FileClose $2
            ${EndIf}
            Delete "$1"
          ${EndIf}
          ${If} $0 != 0
            DetailPrint "Virtual Audio removal returned $0."
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro MIDIMASTER_DELETE_LEGACY_RUN_VALUE
  !insertmacro MIDIMASTER_DELETE_STARTUP_SHORTCUT
!macroend
