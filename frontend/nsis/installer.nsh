; Pure Milk POS - additions to electron-builder's NSIS installer (package.json build.nsis.include).

; Recreate the shortcuts on every install, updates included.
;
; On an update the old uninstaller moves each installed file into
; %TEMP%\nsXXXX.tmp\old-install before deleting it (un.atomicRMDir).
; Windows link tracking follows the moved exe and rewrites the desktop
; shortcut to that temp path, which is then deleted. electron-builder's
; own addDesktopLink leaves an existing shortcut alone on an update
; (KeepShortcuts), so without this the till's desktop icon points at a file
; that no longer exists and the app looks uninstalled - seen on 1.1.1 -> 1.1.2.
!macro customInstall
  ${ifNot} ${isNoDesktopShortcut}
    Delete "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}
  Delete "$newStartMenuLink"
  CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
!macroend
