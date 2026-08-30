@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "HIDDEN=0"
if /I "%~1"=="/hidden" set "HIDDEN=1"

set "EZ_MUSIC_ROOT=%CD%"
set "LAVALINK_WORK=%CD%\lavalink"
set "LAVALINK_JAR=%LAVALINK_WORK%\Lavalink.jar"
set "LAVALINK_PID=%LAVALINK_WORK%\lavalink.pid"
set "LAVALINK_LOG=%LAVALINK_WORK%\lavalink.log"
set "LAVALINK_ERROR_LOG=%LAVALINK_WORK%\lavalink-error.log"
set "BOT_PID_FILE=%CD%\data\ez-music.pid"
set "STOP_REQUEST=%CD%\data\stop.requested"

if not exist "data" mkdir "data" >nul 2>nul
if exist "%STOP_REQUEST%" del /q "%STOP_REQUEST%" >nul 2>nul

call :bot_running
if not errorlevel 1 (
  echo EZ Music is already running. Not starting a duplicate Discord session.
  exit /b 0
)
if exist "%BOT_PID_FILE%" del /q "%BOT_PID_FILE%" >nul 2>nul

if not exist .env (
  echo [ERROR] .env is missing. Run setup.bat first.
  call :maybe_pause
  exit /b 1
)

where node >nul 2>nul || (
  echo [ERROR] Node.js is not available. Run setup.bat first.
  call :maybe_pause
  exit /b 1
)
node -e "const [M,m]=process.versions.node.split('.').map(Number);process.exit(M>22||(M===22&&m>=14)?0:1)" || (
  for /f "delims=" %%V in ('node -p "process.versions.node"') do echo [ERROR] Node.js %%V is too old. Version 22.14.0 or newer is required.
  call :maybe_pause
  exit /b 1
)

where java >nul 2>nul || (
  echo [ERROR] Java 17 or newer is not available. Run setup.bat after installing Java.
  call :maybe_pause
  exit /b 1
)
set "JAVA_VERSION="
set "JAVA_MAJOR="
for /f "tokens=3" %%V in ('java -version 2^>^&1 ^| findstr /i "version"') do if not defined JAVA_VERSION set "JAVA_VERSION=%%~V"
for /f "tokens=1 delims=." %%M in ("%JAVA_VERSION%") do set "JAVA_MAJOR=%%M"
if not defined JAVA_MAJOR (
  echo [ERROR] Could not determine the installed Java version.
  java -version
  call :maybe_pause
  exit /b 1
)
for /f "delims=0123456789" %%X in ("%JAVA_MAJOR%") do if not "%%~X"=="" (
  echo [ERROR] Could not parse Java version: %JAVA_VERSION%
  call :maybe_pause
  exit /b 1
)
if %JAVA_MAJOR% LSS 17 (
  echo [ERROR] Java %JAVA_VERSION% is installed, but Java 17 or newer is required.
  call :maybe_pause
  exit /b 1
)

if not exist "%LAVALINK_JAR%" (
  echo [ERROR] lavalink\Lavalink.jar is missing. Run setup.bat first.
  call :maybe_pause
  exit /b 1
)

if not exist node_modules (
  echo Node dependencies are missing. Running npm install...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    call :maybe_pause
    exit /b 1
  )
)

call :lavalink_ready
if not errorlevel 1 (
  echo Lavalink is already running and ready on 127.0.0.1:2333.
  goto start_bot
)

call :port_open
if not errorlevel 1 (
  echo [ERROR] Port 2333 is already in use, but it is not the expected EZ Music Lavalink server.
  echo Close the program using port 2333, then try again.
  call :maybe_pause
  exit /b 1
)

if exist "%LAVALINK_PID%" del /q "%LAVALINK_PID%" >nul 2>nul
if exist "%LAVALINK_LOG%" move /Y "%LAVALINK_LOG%" "%LAVALINK_WORK%\lavalink-old.log" >nul 2>nul
if exist "%LAVALINK_ERROR_LOG%" move /Y "%LAVALINK_ERROR_LOG%" "%LAVALINK_WORK%\lavalink-error-old.log" >nul 2>nul

echo Starting native Lavalink (no Docker)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$work=$env:LAVALINK_WORK; if([string]::IsNullOrWhiteSpace($work)){throw 'LAVALINK_WORK is not set'}; $out=$env:LAVALINK_LOG; $err=$env:LAVALINK_ERROR_LOG; $pidFile=$env:LAVALINK_PID; $p=Start-Process -FilePath 'java' -ArgumentList '-Xms128M','-Xmx512M','-jar','Lavalink.jar' -WorkingDirectory $work -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru; Set-Content -LiteralPath $pidFile -Value $p.Id -Encoding ascii; Write-Host ('Lavalink PID: '+$p.Id)"
if errorlevel 1 (
  echo [ERROR] Could not start Lavalink.
  call :maybe_pause
  exit /b 1
)

echo Waiting for Lavalink to become ready...
for /L %%A in (1,1,60) do (
  call :lavalink_ready
  if not errorlevel 1 goto lavalink_ready_label
  timeout /t 1 /nobreak >nul
)

echo [ERROR] Lavalink did not become ready within 60 seconds.
echo.
echo Recent Lavalink output:
powershell -NoProfile -ExecutionPolicy Bypass -Command "if(Test-Path -LiteralPath $env:LAVALINK_LOG){Get-Content -LiteralPath $env:LAVALINK_LOG -Tail 50}; if(Test-Path -LiteralPath $env:LAVALINK_ERROR_LOG){Get-Content -LiteralPath $env:LAVALINK_ERROR_LOG -Tail 50}"
call stop-bot.bat /quiet /lavalink-only >nul 2>nul
call :maybe_pause
exit /b 1

:lavalink_ready_label
echo Lavalink is ready.

:start_bot
echo Starting EZ Music...
if "%HIDDEN%"=="0" echo Press Ctrl+C to stop the Discord bot.
echo.
node "%CD%\src\index.js"
set "BOT_EXIT=%ERRORLEVEL%"

if exist "%STOP_REQUEST%" (
  del /q "%STOP_REQUEST%" >nul 2>nul
  set "BOT_EXIT=0"
)

echo.
echo EZ Music exited with code %BOT_EXIT%.
echo Stopping the Lavalink process started by this folder...
call stop-bot.bat /quiet /lavalink-only
exit /b %BOT_EXIT%

:bot_running
powershell -NoProfile -ExecutionPolicy Bypass -Command "$expected=Join-Path $env:EZ_MUSIC_ROOT 'src\index.js'; $pidFile=$env:BOT_PID_FILE; $isEzBot={param($p) $p -and ([string]$p.Name).Equals('node.exe',[StringComparison]::OrdinalIgnoreCase) -and ([string]$p.CommandLine).IndexOf($expected,[StringComparison]::OrdinalIgnoreCase) -ge 0}; if(Test-Path -LiteralPath $pidFile){$raw=(Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue).Trim(); if($raw -match '^\d+$'){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$raw) -ErrorAction SilentlyContinue; if(& $isEzBot $p){exit 0}}}; $p=Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' -ErrorAction SilentlyContinue | Where-Object {& $isEzBot $_} | Select-Object -First 1; if($p){Set-Content -LiteralPath $pidFile -Value $p.ProcessId -Encoding ascii; exit 0}; exit 1" >nul 2>nul
exit /b %ERRORLEVEL%

:lavalink_ready
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:2333/version' -Headers @{Authorization='ezmusic-local-only'} -TimeoutSec 2; if($r.StatusCode -eq 200){exit 0} } catch {}; exit 1" >nul 2>nul
exit /b %ERRORLEVEL%

:port_open
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $c=New-Object Net.Sockets.TcpClient('127.0.0.1',2333); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
exit /b %ERRORLEVEL%

:maybe_pause
if "%HIDDEN%"=="0" pause
exit /b 0
