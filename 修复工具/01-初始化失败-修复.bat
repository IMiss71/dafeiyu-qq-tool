@echo off
title AstrBot Init Repair
cd /d "%~dp0"
echo Repairing, please do NOT close this window...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-init.ps1"
if errorlevel 1 (
  echo.
  echo Repair did not finish. Press any key to close.
  pause >nul
)
