@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-dev-windows.ps1"
set "DEV_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%DEV_EXIT_CODE%"=="0" echo Development run failed with exit code %DEV_EXIT_CODE%.
pause
exit /b %DEV_EXIT_CODE%

