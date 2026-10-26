Option Explicit
' ============================================================
'  一键停止大肥鱼（全程无窗口、无提示）
'
'  停掉：AstrBot（面板 16885 / 反向 WS 16199）、NapCat（注入器 + 它拉起的 QQ）、后台守护
'  不停：向导本身（你还可以继续在向导里改配置）
'  聊天记录、插件数据、配置都不会丢，下次双击「一键启动大肥鱼.vbs」接着用
' ============================================================

Dim sh, fso, here, nodeExe, stopJs, consoleLog, cmd, rc

If InStr(1, LCase(WScript.FullName), "cscript.exe", 1) > 0 Then
  Set sh = CreateObject("WScript.Shell")
  sh.Run "wscript.exe """ & WScript.ScriptFullName & """", 0, False
  WScript.Quit 0
End If

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = fso.BuildPath(fso.BuildPath(here, "tools"), "node.exe")
stopJs = fso.BuildPath(fso.BuildPath(here, "scripts"), "stop.js")

If Not fso.FileExists(nodeExe) Or Not fso.FileExists(stopJs) Then
  MsgBox "分发包不完整（缺 tools\node.exe 或 scripts\stop.js），请重新解压完整压缩包。", 16, "大肥鱼 - 停止失败"
  WScript.Quit 2
End If

consoleLog = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\DaFeiYuQQ\boot-console.log"
cmd = "cmd /c cd /d """ & here & """ && """ & nodeExe & """ scripts\stop.js >> """ & consoleLog & """ 2>&1"

' True = 等它跑完（要拿退出码判断到底关干净没有）
rc = sh.Run(cmd, 0, True)

If rc = 0 Then
  WScript.Quit 0
End If

MsgBox "有大肥鱼的进程没能关掉（退出码 " & rc & "）。" & vbCrLf & vbCrLf & _
       "机器人已经不会再回消息了（AstrBot 已停）。" & vbCrLf & _
       "如果那个 QQ 还挂在桌面上：右键任务栏托盘里的 QQ -> 退出。" & vbCrLf & vbCrLf & _
       "日志：" & sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\DaFeiYuQQ\boot.log", 48, "大肥鱼 - 关闭未完成"
WScript.Quit rc
