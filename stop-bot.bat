@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "QUIET=0"
if /I "%~1"=="/quiet" set "QUIET=1"
set "LAVALINK_PID=%CD%\lavalink\lavalink.pid"

if not exist "%LAVALINK_PID%" (
  if "%QUIET%"=="0" (
    echo No EZ Music Lavalink PID file was found. It may already be stopped.
    pause
  )
  exit /b 0
)

set /p TARGET_PID=<"%LAVALINK_PID%"
for /f "delims=0123456789" %%A in ("%TARGET_PID%") do set "TARGET_PID="
if not defined TARGET_PID (
  echo [WARN] Invalid Lavalink PID file. Removing it without killing anything.
  del /q "%LAVALINK_PID%" >nul 2>nul
  if "%QUIET%"=="0" pause
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$targetPid=[int]$env:TARGET_PID; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$targetPid) -ErrorAction SilentlyContinue; if(-not $p){exit 2}; if([string]$p.CommandLine -notmatch 'Lavalink\.jar'){Write-Host '[WARN] PID now belongs to another process; refusing to kill it.'; exit 3}; Stop-Process -Id $targetPid -Force -ErrorAction Stop; exit 0"
set "STOP_RC=%ERRORLEVEL%"

if "%STOP_RC%"=="0" echo Lavalink stopped.
if "%STOP_RC%"=="2" echo Lavalink was already stopped.
if "%STOP_RC%"=="3" echo Lavalink PID was stale; no unrelated process was killed.
if not "%STOP_RC%"=="0" if not "%STOP_RC%"=="2" if not "%STOP_RC%"=="3" echo [WARN] Could not stop Lavalink cleanly.

del /q "%LAVALINK_PID%" >nul 2>nul
if "%QUIET%"=="0" pause
exit /b 0
