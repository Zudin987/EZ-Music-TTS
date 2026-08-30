@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo Removing EZ Music Task Scheduler autostart...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$task=Get-ScheduledTask -TaskName 'EZ Music Bot' -ErrorAction SilentlyContinue; if($task){Unregister-ScheduledTask -TaskName 'EZ Music Bot' -Confirm:$false; Write-Host 'Autostart removed.'}else{Write-Host 'No EZ Music Bot scheduled task was found.'}"
if errorlevel 1 (
  echo [ERROR] Could not remove the scheduled task.
  echo If Windows reports Access Denied, right-click this file and choose Run as administrator once.
  pause
  exit /b 1
)
pause
exit /b 0
