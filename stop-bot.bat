@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "QUIET=0"
set "LAVALINK_ONLY=0"
for %%A in (%*) do (
  if /I "%%~A"=="/quiet" set "QUIET=1"
  if /I "%%~A"=="/lavalink-only" set "LAVALINK_ONLY=1"
)

set "EZ_MUSIC_ROOT=%CD%"
set "BOT_PID_FILE=%CD%\data\ez-music.pid"
set "STOP_REQUEST=%CD%\data\stop.requested"
set "LAVALINK_PID=%CD%\lavalink\lavalink.pid"

if "%LAVALINK_ONLY%"=="0" call :stop_discord_bot
call :stop_lavalink

if "%QUIET%"=="0" pause
exit /b 0

:stop_discord_bot
if not exist "data" mkdir "data" >nul 2>nul
> "%STOP_REQUEST%" echo intentional-stop

powershell -NoProfile -ExecutionPolicy Bypass -Command "$expected=Join-Path $env:EZ_MUSIC_ROOT 'src\index.js'; $pidFile=$env:BOT_PID_FILE; $isEzBot={param($p) $p -and ([string]$p.Name).Equals('node.exe',[StringComparison]::OrdinalIgnoreCase) -and ([string]$p.CommandLine).IndexOf($expected,[StringComparison]::OrdinalIgnoreCase) -ge 0}; $p=$null; if(Test-Path -LiteralPath $pidFile){$raw=(Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue).Trim(); if($raw -match '^\d+$'){$candidate=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$raw) -ErrorAction SilentlyContinue; if(& $isEzBot $candidate){$p=$candidate}}}; if(-not $p){$p=Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' -ErrorAction SilentlyContinue | Where-Object {& $isEzBot $_} | Select-Object -First 1}; if(-not $p){exit 2}; $pidValue=$p.ProcessId; for($i=0;$i -lt 100;$i++){Start-Sleep -Milliseconds 250; if(-not (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)){exit 0}}; $still=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pidValue) -ErrorAction SilentlyContinue; if(& $isEzBot $still){Write-Host '[WARN] Graceful stop timed out; forcing the EZ Music Node process.'; Stop-Process -Id $pidValue -Force -ErrorAction Stop; exit 4}; exit 0"
set "BOT_STOP_RC=%ERRORLEVEL%"

if "%BOT_STOP_RC%"=="0" echo EZ Music Discord bot stopped.
if "%BOT_STOP_RC%"=="2" (
  echo EZ Music Discord bot was already stopped.
  del /q "%STOP_REQUEST%" >nul 2>nul
)
if "%BOT_STOP_RC%"=="4" echo EZ Music Discord bot was force-stopped after the graceful timeout.
if not "%BOT_STOP_RC%"=="0" if not "%BOT_STOP_RC%"=="2" if not "%BOT_STOP_RC%"=="4" echo [WARN] Could not stop the Discord bot cleanly.
del /q "%BOT_PID_FILE%" >nul 2>nul
exit /b 0

:stop_lavalink
if not exist "%LAVALINK_PID%" (
  if "%QUIET%"=="0" echo No EZ Music Lavalink PID file was found. It may already be stopped.
  exit /b 0
)

set "TARGET_PID="
set /p TARGET_PID=<"%LAVALINK_PID%"
for /f "delims=0123456789" %%A in ("%TARGET_PID%") do set "TARGET_PID="
if not defined TARGET_PID (
  echo [WARN] Invalid Lavalink PID file. Removing it without killing anything.
  del /q "%LAVALINK_PID%" >nul 2>nul
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$targetPid=[int]$env:TARGET_PID; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$targetPid) -ErrorAction SilentlyContinue; if(-not $p){exit 2}; $sha=[System.Security.Cryptography.SHA256]::Create(); try{$hash=$sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($env:EZ_MUSIC_ROOT.ToLowerInvariant()))}finally{$sha.Dispose()}; $instance=([BitConverter]::ToString($hash)).Replace('-','').ToLowerInvariant().Substring(0,16); $marker='-Dezmusic.instance='+$instance; $cmd=[string]$p.CommandLine; if($cmd -notmatch 'Lavalink\.jar' -or $cmd.IndexOf($marker,[StringComparison]::OrdinalIgnoreCase) -lt 0){Write-Host '[WARN] PID does not match this EZ Music Lavalink instance; refusing to kill it.'; exit 3}; Stop-Process -Id $targetPid -Force -ErrorAction Stop; exit 0"
set "STOP_RC=%ERRORLEVEL%"

if "%STOP_RC%"=="0" echo Lavalink stopped.
if "%STOP_RC%"=="2" echo Lavalink was already stopped.
if "%STOP_RC%"=="3" echo Lavalink PID was stale or belonged to another instance; no unrelated process was killed.
if not "%STOP_RC%"=="0" if not "%STOP_RC%"=="2" if not "%STOP_RC%"=="3" echo [WARN] Could not stop Lavalink cleanly.

del /q "%LAVALINK_PID%" >nul 2>nul
exit /b 0
