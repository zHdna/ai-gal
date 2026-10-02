@echo off
title AI RP Tool
echo ========================================
echo   AI Role-Play Tool
echo   http://127.0.0.1:3210
echo ========================================
echo.

cd /d %~dp0

rem --- Data dir guard (do not remove) ---
rem The desktop build (Electron shell) sets AI_GAL_DATA_DIR to %APPDATA%\AI-GAL.
rem If that variable leaks into this window, this source instance would write the
rem desktop database and the two would fight over one SQLite file, failing with
rem EPERM / "attempt to write a readonly database".
rem Source instances keep their data in the program directory, so clear it here.
rem See AI-GAL/AGENTS-ARCHIVE.local.md section 24.
set "AI_GAL_DATA_DIR="

rem Self-contained runtime is a hard requirement: never fall back to system node.
rem (A system node may have a different version/behavior -- exactly the kind of
rem  environment drift this launcher must prevent. If the runtime is missing the
rem  package is broken: tell the user and stop.)
set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" (
  echo [ERROR] Bundled runtime not found: %~dp0runtime\node.exe
  echo         The package is incomplete. Re-download / re-extract the full package.
  pause
  exit /b 1
)

rem Kill ONLY a process that is LISTENING on 3210.
rem Do NOT match every line containing ":3210": netstat prints BOTH ends of a
rem connection, so the client side (the user browser) also contains ":3210" and
rem its PID column would be killed too. TIME_WAIT lines carry PID 0 (the system
rem idle process) which is not a valid target either.
rem So: filter to LISTENING first, then match the port, then reject 0.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /c:":3210"') do (
  if not "%%a"=="0" taskkill /f /pid %%a >nul 2>&1
)

echo Starting server (keep this window open)...
echo.
start http://127.0.0.1:3210
"%NODE_EXE%" server\index.js
rem Only pause when the server died with an error, so the message stays visible.
rem Do NOT pause unconditionally: while cmd is blocked in "pause", closing the
rem window makes conhost wait for cmd, and Windows only force-kills the console
rem after ~30s -- the user sees a 30s "not responding" hang on every close.
if errorlevel 1 (
  echo.
  echo [Server exited with an error. Press any key to close this window.]
  pause >nul
)
