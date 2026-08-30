@echo off
setlocal
cd /d "%~dp0"
echo Stopping Lavalink...
docker compose down
