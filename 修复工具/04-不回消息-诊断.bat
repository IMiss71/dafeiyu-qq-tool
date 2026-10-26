@echo off
title Message Reply Diagnostics
cd /d "%~dp0"
echo Checking the message pipeline, please wait...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0msg-diag.ps1"
if errorlevel 1 (
  echo.
  echo Diagnostics did not finish. Press any key to close.
  pause >nul
)
