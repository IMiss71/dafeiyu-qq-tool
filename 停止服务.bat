@echo off
rem 大肥鱼一键关闭：停掉 AstrBot / NapCat / 向导后端（聊天数据不会丢）
rem 注意：本文件必须保存为 GBK 编码，UTF-8 在中文 Windows 上会乱码
title 大肥鱼 - 一键关闭
echo.
echo   正在关闭大肥鱼相关服务，请稍候…
echo.

rem 1) 关 NapCat 注入器
taskkill /f /im NapCatWinBootMain.exe >nul 2>&1

rem 2) 按端口精确关进程（AstrBot 面板 16885 / 向导代理 18666 / OneBot 反向 WS 16199 / 向导后端 18765~18775）
for %%P in (16885 18666 16199 18765 18766 18767 18768 18769 18770 18771 18772 18773 18774 18775) do (
    for /f "tokens=5" %%Q in ('netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING"') do (
        taskkill /f /t /pid %%Q >nul 2>&1
    )
)

rem 3) NapCat 的 QQ 本体会自我拉起，连杀 3 轮占着 6099 的进程（带 /T 连子进程）
rem    只有 NapCat 那个 QQ 会监听 6099，你主号的 QQ 不受影响
for /l %%R in (1,1,3) do (
    for /f "tokens=5" %%Q in ('netstat -ano ^| findstr ":6099 " ^| findstr "LISTENING"') do (
        taskkill /f /t /pid %%Q >nul 2>&1
    )
    timeout /t 2 /nobreak >nul
)

rem 4) 收尾：可能有残留的 AstrBot python 进程（按命令行特征匹配，不误杀其他 python）
wmic process where "name='python.exe' and commandline like '%%astrbot%%'" call terminate >nul 2>&1

echo   完成！大肥鱼已全部关闭。
echo   聊天记录和配置都还在，下次双击「启动向导.bat」即可继续使用。
echo.
pause
