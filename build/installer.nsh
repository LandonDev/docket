# electron-builder's NSIS include (electron-builder.yml `nsis.include`).
#
# A one-click per-user install lands in %LOCALAPPDATA%\Programs\<package name>, which would be
# `temp-code`. The product is TempCode, so a first install goes to Programs\TempCode. A folder
# an earlier install recorded (an update keeps its place) and a /D= on the command line still win.
!macro customInit
  ${if} $perUserInstallationFolder == ""
    !insertmacro GetDParameter $R0
    ${if} $R0 == ""
      ${GetParent} "$INSTDIR" $R1
      StrCpy $INSTDIR "$R1\${PRODUCT_FILENAME}"
    ${endif}
  ${endif}
!macroend
