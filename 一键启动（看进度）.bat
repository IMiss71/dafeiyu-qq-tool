@echo off
title DaFeiYu - Start (visible window)
cd /d "%~dp0"

REM ASCII-only build: safe on any codepage, even after re-saving
REM with Notepad. Use this when you want to WATCH the boot process.
REM For daily silent start, use the VBS launcher instead.

if not exist "tools\node.exe" goto no_node
if not exist "scripts\boot.js" goto no_boot

echo.
echo   Starting services (AstrBot + NapCat), please wait...
echo   ------------------------------------------------------------
echo.

"tools\node.exe" scripts\boot.js --once

echo.
echo   ------------------------------------------------------------
echo   Log: %LOCALAPPDATA%\DaFeiYuQQ\boot.log
echo   Panel: http://127.0.0.1:16885/
echo.
echo   You can close this window (it does NOT stop the services).
pause >nul
exit /b 0

:no_node
echo.
echo   [ERROR] tools\node.exe not found. Files may be incomplete,
echo           or your antivirus deleted/quarantined node.exe.
echo           Re-extract the zip and add an antivirus exception.
echo.
pause
exit /b 1

:no_boot
echo.
echo   [ERROR] scripts\boot.js not found. Files may be incomplete,
echo           please re-extract the zip.
echo.
pause
exit /b 1
