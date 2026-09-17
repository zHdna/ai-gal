@echo off
title AI RP Tool (LAN)
echo ========================================
echo   AI Role-Play Tool (LAN Mode)
echo   http://0.0.0.0:3210
echo ========================================
echo.

cd /d %~dp0

set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"

for /f "tokens=5" %%a in ('netstat -ano ^| findstr /c:":3210"') do taskkill /f /pid %%a >nul 2>&1

set HOST=0.0.0.0

echo Starting server (keep this window open)...
echo.
start http://127.0.0.1:3210
"%NODE_EXE%" server\index.js
pause >nul
