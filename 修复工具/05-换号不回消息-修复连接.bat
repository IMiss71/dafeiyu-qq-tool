@echo off
title Alt-Account Connection Repair (NapCat to AstrBot)
cd /d "%~dp0"
echo Checking and repairing the NapCat WebSocket config...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-onebot.ps1"
if errorlevel 1 (
  echo.
  echo Repair did not finish. Press any key to close.
  pause >nul
)
