@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo Installing EZ Music Task Scheduler autostart...
echo This creates a LIMITED, current-user task that runs at Windows sign-in.
echo No password is stored.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
if errorlevel 1 (
  echo.
  echo [ERROR] Could not create the scheduled task.
  echo If Windows reports Access Denied, right-click this file and choose Run as administrator once.
  pause
  exit /b 1
)

echo.
pause
exit /b 0
