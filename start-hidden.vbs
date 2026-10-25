' start-hidden.vbs —— 以完全无窗口的方式启动向导后端（由 start-wizard.bat 调用）
'
' 为什么用 VBS：Start-Process 在部分机器上仍会闪一下黑窗口甚至启动失败，
' 而 WScript.Shell.Run 的 mode 0 = 完全隐藏窗口，兼容性最好，用户完全无感。
'
' 参数 %1 = node 可执行文件路径（一般是 tools\node.exe）
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

Dim here
here = fso.GetParentFolderName(WScript.ScriptFullName)

Dim nodeExe
nodeExe = WScript.Arguments(0)
' 路径兜底：VBS 的工作目录不一定是工具目录（比如直接双击 vbs 时）
If Not fso.FileExists(nodeExe) Then
  nodeExe = fso.BuildPath(here, nodeExe)
End If

' 先把 cwd 切到工具目录：否则 backend\server.js 这种相对路径会找不到。
' 日志分成两份：正常输出 wizard.log，报错单独 wizard.err.log（启动失败时一眼能看）。
Dim cmd
cmd = "cmd /c cd /d """ & here & """ && """ & nodeExe & """ backend\server.js > """ & here & "\wizard.log"" 2> """ & here & "\wizard.err.log"""

sh.Run cmd, 0, False
