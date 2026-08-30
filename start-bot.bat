@echo off
setlocal
cd /d "%~dp0"

if not exist .env (
  echo [ERROR] .env is missing. Run setup.bat first.
  pause
  exit /b 1
)

where docker >nul 2>nul || (
  echo [ERROR] Docker is not available. Start/install Docker Desktop first.
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

echo Starting EZ Music...
echo Press Ctrl+C to stop the Discord bot. Lavalink can be stopped later with stop-bot.bat.
call npm start
