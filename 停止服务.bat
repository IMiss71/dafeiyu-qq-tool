@echo off
title DaFeiYu - Stop services (visible window)
cd /d "%~dp0"

REM ASCII-only build: safe on any codepage, even after re-saving
REM with Notepad.

echo.
echo   For daily shutdown, double-click the VBS stop launcher
echo   (fully silent, no window). This window is for watching
echo   what exactly gets stopped.
echo.

if not exist "tools\node.exe" (
  echo   [ERROR] tools\node.exe not found. Files may be incomplete,
  echo           please re-extract the zip.
  echo.
  pause
  exit /b 1
)
if not exist "scripts\stop.js" (
  echo   [ERROR] scripts\stop.js not found. Files may be incomplete,
  echo           please re-extract the zip.
  echo.
  pause
  exit /b 1
)

echo   Stopping (wizard + AstrBot + NapCat), please wait...
echo   ------------------------------------------------------------
echo.

"tools\node.exe" scripts\stop.js

echo.
echo   ------------------------------------------------------------
echo   Log: %LOCALAPPDATA%\DaFeiYuQQ\boot.log
echo.
echo   How to confirm it stopped: open http://127.0.0.1:16885/
echo   If the page will not open, everything is stopped.
echo.
echo   You can close this window now.
pause >nul
exit /b 0
