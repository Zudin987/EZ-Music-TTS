@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (
  echo [ERROR] Node.js 22 or newer is not installed or not in PATH.
  echo Install Node.js, then run setup.bat again.
  pause
  exit /b 1
)

where docker >nul 2>nul || (
  echo [ERROR] Docker Desktop is not installed or not in PATH.
  echo Install/start Docker Desktop, then run setup.bat again.
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
