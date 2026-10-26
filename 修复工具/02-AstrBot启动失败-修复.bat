@echo off
title Start AstrBot (bypass wizard)
cd /d "%~dp0"
echo Starting AstrBot, please do NOT close this window...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-astrbot.ps1"
if errorlevel 1 (
  echo.
  echo Start failed. Press any key to close.
  pause >nul
)
