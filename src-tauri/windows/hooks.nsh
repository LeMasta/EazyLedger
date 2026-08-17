; v0.4.7 renamed the product from “资料台账” to “EazyLedger”.
; NSIS treats the new product name as a different install directory, so the
; updater can relaunch the new binary while old shortcuts still point at v0.4.6.
!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Removing legacy 资料台账 shortcuts and installation"

  Delete "$DESKTOP\资料台账.lnk"
  Delete "$SMPROGRAMS\资料台账.lnk"
  RMDir /r "$SMPROGRAMS\资料台账"

  ; The updater runs NSIS with shortcut creation disabled, so create the
  ; canonical shortcuts explicitly after removing the v0.4.6 entries.
  CreateShortCut "$DESKTOP\EazyLedger.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  CreateShortCut "$SMPROGRAMS\EazyLedger.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Per-user builds before v0.4.7 used this product-name-based directory.
  ; Never remove it if a custom installer intentionally selected that directory.
  ${If} "$INSTDIR" != "$LOCALAPPDATA\资料台账"
    RMDir /r /REBOOTOK "$LOCALAPPDATA\资料台账"
  ${EndIf}

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\资料台账"
  DeleteRegKey HKCU "Software\local\资料台账"
!macroend
