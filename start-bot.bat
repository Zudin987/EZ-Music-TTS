@echo off
setlocal
cd /d "%~dp0"

if not exist .env (
  echo [ERROR] .env is missing. Run setup.bat first.
  pause
  exit /b 1
)

where node >nul 2>nul || (
  echo [ERROR] Node.js is not available. Run setup.bat first.
  pause
  exit /b 1
)

node -e "const [M,m]=process.versions.node.split('.').map(Number);process.exit(M>22||(M===22&&m>=9)?0:1)" || (
  for /f "delims=" %%V in ('node -p "process.versions.node"') do echo [ERROR] Node.js %%V is too old. Version 22.9.0 or newer is required.
  pause
  exit /b 1
)

where docker >nul 2>nul || (
  echo [ERROR] Docker is not available. Start/install Docker Desktop first.
  pause
  exit /b 1
)

docker compose version >nul 2>nul || (
  echo [ERROR] Docker Compose v2 is not available. Update Docker Desktop.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Node dependencies are missing. Running npm install...
  call npm install || exit /b 1
)

echo Starting Lavalink...
docker compose up -d || (
  echo [ERROR] Lavalink failed to start. Is Docker Desktop running?
  pause
  exit /b 1
)

echo Waiting for Lavalink to become ready...
set /a LAVALINK_ATTEMPT=0
:wait_lavalink
set /a LAVALINK_ATTEMPT+=1
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1',2333); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul && goto lavalink_ready
if %LAVALINK_ATTEMPT% GEQ 45 goto lavalink_failed
timeout /t 1 /nobreak >nul
goto wait_lavalink

:lavalink_failed
echo [ERROR] Lavalink did not become ready within 45 seconds.
echo Recent Lavalink logs:
docker compose logs --tail 80 lavalink
pause
exit /b 1

:lavalink_ready
echo Lavalink is ready.
echo Starting EZ Music...
echo Press Ctrl+C to stop the Discord bot. Lavalink can be stopped later with stop-bot.bat.
call npm start
