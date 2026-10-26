@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  DaFeiYu QQ Bot Deploy Wizard - launcher (ASCII-only build)
REM  Free to use: no license key, no activation, no fee.
REM  This script contains NO non-ASCII characters on purpose:
REM  it keeps working even if re-saved as UTF-8 or opened under
REM  any codepage. All guidance text lives in the web wizard page.
REM ============================================================

title DaFeiYu QQ Wizard - you can close this window safely

if not exist "tools\node.exe" goto find_node_any

set "NODE=tools\node.exe"
goto have_node

:find_node_any
where node >nul 2>nul && set "NODE=node" && goto have_node
if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe" && goto have_node
if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE=C:\Program Files (x86)\nodejs\node.exe" && goto have_node
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe" && goto have_node

echo.
echo [ERROR] Node.js not found.
echo         Please keep the "tools" folder next to this file,
echo         or install Node.js LTS, or put node.exe into tools\.
echo.
pause
exit /b 1

:have_node
if not exist "backend\server.js" (
  echo.
  echo [ERROR] backend\server.js not found. Files may be incomplete,
  echo         or your antivirus quarantined node.exe / server.js.
  echo         Please re-extract the zip and add an antivirus exception.
  echo.
  pause
  exit /b 1
)
echo Using Node: %NODE%

REM Free edition: no license gate. ( DA FEI YU wizard is fully free. )

REM ---- If a previous run left a valid port record and the service
REM      is still listening, just open the browser (2nd+ run). ----
if not exist "%~dp0wizard.port" goto start_svc
set "WPORT=18765"
for /f "usebackq delims=" %%p in ("%~dp0wizard.port") do set "WPORT=%%p"
if /i "%WPORT%"=="FAIL" goto start_svc
netstat -ano 2>nul | findstr ":%WPORT% " | findstr "LISTENING" >nul
if not errorlevel 1 goto already_running

:start_svc
del /q "%~dp0wizard.port" 2>nul
echo Starting wizard service (first start takes ~3s), log: wizard.log ...

REM Launch via wscript VBS (Run mode 0 = fully hidden window).
REM Do NOT replace with Start-Process / detached spawn tricks:
REM on Win11 default-terminal machines those can flash a console
REM window or fail to start at all.
wscript.exe "%~dp0start-hidden.vbs" "%NODE%" //nologo

set /a TRIES=0
:wait_up
if exist "%~dp0wizard.port" goto read_port
set /a TRIES+=1
if %TRIES% lss 30 (
  ping -n 2 127.0.0.1 >nul
  goto wait_up
)
echo.
echo [ERROR] Service did not come up within 30 seconds. Usual causes:
echo   1. Antivirus blocked tools\node.exe or files are incomplete - re-extract.
echo   2. Look at the top of wizard.err.log for the real error.
echo.
if exist "%~dp0wizard.err.log" type "%~dp0wizard.err.log"
pause
exit /b 1

:read_port
set "WPORT=18765"
for /f "usebackq delims=" %%p in ("%~dp0wizard.port") do set "WPORT=%%p"
if /i "%WPORT%"=="FAIL" (
  echo.
  echo [ERROR] All ports 18765-18775 are occupied. Close the conflicting
  echo         software and try again.
  echo.
  pause
  exit /b 1
)

:already_running
start "" http://127.0.0.1:%WPORT%/

echo.
echo ===== Service is up =====
echo   Wizard page: http://127.0.0.1:%WPORT%/
echo.
echo   You can close this window now - the service keeps running
echo   in the background and maintains AstrBot / NapCat / QQ.
echo   To stop everything completely, run "stop" script instead.
echo.
ping -n 5 127.0.0.1 >nul
exit /b 0
