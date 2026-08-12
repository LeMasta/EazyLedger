@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1" -Fast -OpenOutput
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%BUILD_EXIT_CODE%"=="0" (
  echo Fast build failed with exit code %BUILD_EXIT_CODE%.
) else (
  echo Fast build completed successfully.
)
pause
exit /b %BUILD_EXIT_CODE%
