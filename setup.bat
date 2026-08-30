@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (
  echo [ERROR] Node.js 22.14.0 or newer is not installed or not in PATH.
  echo Install a current Node.js 22 LTS or newer release, then run setup.bat again.
  pause
  exit /b 1
)

node -e "const [M,m]=process.versions.node.split('.').map(Number);process.exit(M>22||(M===22&&m>=14)?0:1)" || (
  for /f "delims=" %%V in ('node -p "process.versions.node"') do echo [ERROR] Node.js %%V is too old. Version 22.14.0 or newer is required.
  pause
  exit /b 1
)

where npm >nul 2>nul || (
  echo [ERROR] npm is not available in PATH. Repair/reinstall Node.js.
  pause
  exit /b 1
)

where docker >nul 2>nul || (
  echo [ERROR] Docker Desktop is not installed or not in PATH.
  echo Install/start Docker Desktop, then run setup.bat again.
  pause
  exit /b 1
)

docker compose version >nul 2>nul || (
  echo [ERROR] Docker Compose v2 is not available. Update Docker Desktop.
  pause
  exit /b 1
)

if not exist .env (
  copy /Y .env.example .env >nul
  echo Created .env from .env.example.
)

echo Installing Node dependencies...
call npm install || exit /b 1

echo.
echo Setup complete.
echo Edit .env with your Discord token, client ID, guild ID, and optional Gemini API key.
echo Then run start-bot.bat.
pause
