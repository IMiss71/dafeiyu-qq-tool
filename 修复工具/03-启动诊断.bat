@echo off
title AstrBot Startup Diagnostics
cd /d "%~dp0"
echo Collecting diagnostics, please wait (up to 1 minute)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose.ps1"
if errorlevel 1 (
  echo.
  echo Diagnostics did not finish. Press any key to close.
  pause >nul
)
