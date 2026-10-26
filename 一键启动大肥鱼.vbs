Option Explicit
' ============================================================
'  一键启动大肥鱼（全程无窗口、无提示）
'
'  双击后：后台拉起 AstrBot（面板 16885）+ NapCat（机器人 QQ）+ 一个后台守护。
'  成功：什么都不弹 —— 安静就是最好的反馈。
'  失败：才会弹一个窗口，告诉你去哪看日志、怎么修。
'  关闭：双击「一键停止大肥鱼.vbs」。
' ============================================================

Dim sh, fso, here, nodeExe, bootJs, stateDir, statusPath, consoleLog, cmd
Dim i, state, line, ts

' 宿主如果被调用行版本（cscript）打开，会拉出一个黑窗。
' 交给窗口版（wscript）重新跑一遍自己：这样双击时永远不会有窗口闪一下。
If InStr(1, LCase(WScript.FullName), "cscript.exe", 1) > 0 Then
  Set sh = CreateObject("WScript.Shell")
  sh.Run "wscript.exe """ & WScript.ScriptFullName & """", 0, False
  WScript.Quit 0
End If

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = fso.BuildPath(fso.BuildPath(here, "tools"), "node.exe")
bootJs = fso.BuildPath(fso.BuildPath(here, "scripts"), "boot.js")

If Not fso.FileExists(nodeExe) Then
  MsgBox "找不到 tools\node.exe，分发包不完整。" & vbCrLf & vbCrLf & _
         "常见原因：杀毒软件把 node.exe 删了。" & vbCrLf & _
         "请把整个文件夹加入杀软白名单，再重新解压一次。", 16, "大肥鱼 - 启动失败"
  WScript.Quit 2
End If

If Not fso.FileExists(bootJs) Then
  MsgBox "找不到 scripts\boot.js，分发包不完整，请重新解压完整压缩包。", 16, "大肥鱼 - 启动失败"
  WScript.Quit 2
End If

stateDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\DaFeiYuQQ"
consoleLog = stateDir & "\boot-console.log"
statusPath = stateDir & "\boot.status"

' 清掉上一次的状态文件，避免读到旧结果把失败误判成成功
If fso.FileExists(statusPath) Then fso.DeleteFile statusPath, True

cmd = "cmd /c cd /d """ & here & """ && """ & nodeExe & """ scripts\boot.js >> """ & consoleLog & """ 2>&1"

' 0 = 隐藏窗口；False = 不等待（服务要常驻后台）
sh.Run cmd, 0, False

' 等结果：冷启动一般 10~40 秒，老机器或首次启动可能 60 秒以上
state = ""
For i = 1 To 90
  WScript.Sleep 1000
  If fso.FileExists(statusPath) Then
    On Error Resume Next
    Set ts = fso.OpenTextFile(statusPath, 1, False)
    If Err.Number = 0 Then
      line = ts.ReadLine
      ts.Close
      If Err.Number = 0 Then state = Trim(line)
    End If
    Err.Clear
    On Error GoTo 0
    If state = "OK" Or state = "FAIL" Then Exit For
  End If
Next

If state = "FAIL" Then
  MsgBox "大肥鱼没能完全启动，日志在这里：" & vbCrLf & _
         stateDir & "\boot.log" & vbCrLf & _
         stateDir & "\astrbot.log" & vbCrLf & vbCrLf & _
         "按顺序排查：" & vbCrLf & _
         "(1) 还没装 AstrBot / NapCat：双击「启动向导.bat」走第 2 步" & vbCrLf & _
         "(2) AstrBot 装坏了：双击「修复工具\02-AstrBot启动失败-修复.bat」" & vbCrLf & _
         "(3) 端口被别的程序占了：双击「修复工具\03-启动诊断.bat」看看是谁", 48, "大肥鱼 - 启动未完成"
  WScript.Quit 2
End If

' 成功、或还在启动中：都不打扰。安静 = 没问题。
WScript.Quit 0
