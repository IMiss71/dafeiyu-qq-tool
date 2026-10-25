@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  大肥鱼 QQ 部署工具 · 启动脚本
REM
REM  双击它就会在后台起服务并自动打开向导页面，不用装任何东西。
REM    · 服务由 VBS 以完全无窗口方式启动（不会弹出需要保持开启的黑窗口）
REM    · AstrBot / NapCat 的进程由 backend\deploy.js 自己管理
REM    · 想彻底停掉：双击 停止服务.bat
REM ============================================================

REM 本工具完全免费，无需任何授权配置。

title 大肥鱼 QQ 部署工具（本窗口可以关掉，服务在后台运行）

if not exist "tools\node.exe" (
  echo.
  echo [ERROR] 找不到 tools\node.exe，分发包不完整。
  echo         请确认 tools / backend / wizard 三个目录在同一个文件夹里；
  echo         或重新解压一次完整压缩包（杀软可能删掉了 node.exe，记得加白名单）。
  echo.
  pause
  exit /b 1
)
if not exist "backend\server.js" (
  echo.
  echo [ERROR] 找不到 backend\server.js，分发包不完整，请重新解压完整压缩包。
  echo.
  pause
  exit /b 1
)

set "NODE="
if exist "tools\node.exe" set "NODE=tools\node.exe"
if defined NODE goto have_node
where node >nul 2>nul && set "NODE=node"
if defined NODE goto have_node
if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if defined NODE goto have_node
if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE=C:\Program Files (x86)\nodejs\node.exe"
if defined NODE goto have_node
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODE goto have_node

echo.
echo [ERROR] 没找到 Node.js。请安装 LTS 版，或把 node.exe 放到 tools 目录下。
echo.
pause
exit /b 1

:have_node
echo 使用 Node: %NODE%

REM 本工具完全免费，无需任何授权配置。
if not exist "%~dp0wizard.port" goto start_svc
set "WPORT=18765"
for /f "usebackq delims=" %%p in ("%~dp0wizard.port") do set "WPORT=%%p"
if /i "%WPORT%"=="FAIL" goto start_svc
netstat -ano 2>nul | findstr ":%WPORT% " | findstr "LISTENING" >nul
if not errorlevel 1 goto already_running

:start_svc
REM 本工具完全免费，无需任何授权配置。
del /q "%~dp0wizard.port" 2>nul
echo 正在启动向导服务（首次约 3 秒，日志见 wizard.log）...

REM 用 wscript 调 VBS，Run 的 mode 0 = 完全隐藏窗口，
REM 比 Start-Process 稳：后者在部分机器上仍会闪一下窗口甚至启动失败。
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
echo [ERROR] 服务 30 秒内没起来。常见原因：
echo   1）杀软拦截了 tools\node.exe —— 把本目录加入白名单后重新解压
echo   2）wizard.err.log 里有报错 —— 把它发给客服
echo.
if exist "%~dp0wizard.err.log" type "%~dp0wizard.err.log"
pause
exit /b 1

:read_port
set "WPORT=18765"
for /f "usebackq delims=" %%p in ("%~dp0wizard.port") do set "WPORT=%%p"
if /i "%WPORT%"=="FAIL" (
  echo.
  echo [ERROR] 18765~18775 端口全被占用，无法启动。请关掉占用端口的软件后重试。
  echo.
  pause
  exit /b 1
)

:already_running
start "" http://127.0.0.1:%WPORT%/

echo.
echo ===== 向导已就绪 =====
echo   页面地址: http://127.0.0.1:%WPORT%/
echo.
echo   本窗口可以直接关掉，服务会在后台继续跑；
echo       它会一直维持 AstrBot / NapCat / QQ 的连接，
echo       想彻底停掉请双击 停止服务.bat。
echo.

REM 等 4 秒让用户看清提示再退出（用 ping 而非 timeout：某些环境 PATH 里会有 GNU timeout 把它劫持）
ping -n 5 127.0.0.1 >nul
exit /b 0