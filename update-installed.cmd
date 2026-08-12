@echo off
setlocal
cd /d "%~dp0"
echo Close Document Ledger before continuing.
echo This will build a RELEASE package and upgrade the existing installation in place.
pause
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1" -Install
set "UPDATE_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%UPDATE_EXIT_CODE%"=="0" (
  echo Update failed with exit code %UPDATE_EXIT_CODE%.
) else (
  echo Installed application updated successfully. No uninstall was required.
)
pause
exit /b %UPDATE_EXIT_CODE%

