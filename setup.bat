@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "LAVALINK_VERSION=4.2.2"
set "LAVALINK_JAR=%CD%\lavalink\Lavalink.jar"
set "LAVALINK_DOWNLOAD_URL=https://github.com/lavalink-devs/Lavalink/releases/download/%LAVALINK_VERSION%/Lavalink.jar"
set "LAVALINK_SHA256=8cb801e591072c3689fafd71ccf571a95a4ead3cc35dfc045e157d763d89119a"

echo Checking Node.js...
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

echo Checking Java...
where java >nul 2>nul || (
  echo [ERROR] Java 17 or newer is required for Lavalink.
  echo Install a Java 17+ JRE, such as Eclipse Temurin 17, then run setup.bat again.
  echo https://adoptium.net/temurin/releases/?version=17
  pause
  exit /b 1
)
set "JAVA_VERSION="
set "JAVA_MAJOR="
for /f "tokens=3" %%V in ('java -version 2^>^&1 ^| findstr /i "version"') do if not defined JAVA_VERSION set "JAVA_VERSION=%%~V"
for /f "tokens=1 delims=." %%M in ("%JAVA_VERSION%") do set "JAVA_MAJOR=%%M"
if not defined JAVA_MAJOR (
  echo [ERROR] Could not determine the installed Java version.
  java -version
  pause
  exit /b 1
)
for /f "delims=0123456789" %%X in ("%JAVA_MAJOR%") do if not "%%~X"=="" (
  echo [ERROR] Could not parse Java version: %JAVA_VERSION%
  pause
  exit /b 1
)
if %JAVA_MAJOR% LSS 17 (
  echo [ERROR] Java %JAVA_VERSION% is installed, but Java 17 or newer is required.
  echo Install/update to a Java 17+ JRE, then run setup.bat again.
  echo https://adoptium.net/temurin/releases/?version=17
  pause
  exit /b 1
)
echo Java %JAVA_VERSION% detected.

if not exist "lavalink" mkdir "lavalink"

if exist "%LAVALINK_JAR%" (
  call :verify_lavalink
  if errorlevel 1 (
    echo Existing Lavalink.jar failed the SHA-256 check. Re-downloading it...
    del /q "%LAVALINK_JAR%" >nul 2>nul
  ) else (
    echo Lavalink %LAVALINK_VERSION% is already installed and verified.
  )
)

if not exist "%LAVALINK_JAR%" (
  echo Downloading Lavalink %LAVALINK_VERSION%... this is about 100 MB and only happens once.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri $env:LAVALINK_DOWNLOAD_URL -OutFile $env:LAVALINK_JAR" || (
    echo [ERROR] Could not download Lavalink.jar.
    pause
    exit /b 1
  )
  call :verify_lavalink
  if errorlevel 1 (
    echo [ERROR] Downloaded Lavalink.jar failed its SHA-256 integrity check.
    del /q "%LAVALINK_JAR%" >nul 2>nul
    pause
    exit /b 1
  )
  echo Lavalink download verified.
)

if not exist .env (
  copy /Y .env.example .env >nul
  echo Created .env from .env.example.
)

echo Installing Node dependencies...
call npm install || (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)

echo.
echo Setup complete. Docker is NOT required.
echo Edit .env with your Discord token, client ID, guild ID, optional Gemini API key, and optional Spotify app credentials.
echo Then run start-bot.bat.
pause
exit /b 0

:verify_lavalink
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h=(Get-FileHash -LiteralPath $env:LAVALINK_JAR -Algorithm SHA256).Hash.ToLowerInvariant(); if($h -eq $env:LAVALINK_SHA256){ exit 0 } else { Write-Host ('Expected: '+$env:LAVALINK_SHA256); Write-Host ('Actual:   '+$h); exit 1 }"
exit /b %ERRORLEVEL%
