' start-hidden.vbs - start the wizard with no console window, then open the browser.
' ASCII only on purpose: VBS is read as ANSI by Windows Script Host.
Option Explicit

Dim fso, sh, here, root, nodeExe, portFile, port, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
portFile = fso.BuildPath(root, "wizard.port")
nodeExe = fso.BuildPath(root, "tools\node.exe")
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"

' Already running: just open the existing page, never start a second instance.
If fso.FileExists(portFile) Then
  port = ReadText(portFile)
  If IsNumeric(port) Then
    If Ping(port) Then
      sh.Run "http://127.0.0.1:" & port & "/", 1, False
      WScript.Quit 0
    End If
  End If
End If

Dim cmd
cmd = "cmd /c cd /d """ & root & """ && """ & nodeExe & """ backend\server.js > """ & root & "\wizard.log"" 2> """ & root & "\wizard.err.log"""
sh.Run cmd, 0, False

' Wait up to 60 seconds for the port file and /api/ping.
For i = 1 To 120
  WScript.Sleep 500
  If fso.FileExists(portFile) Then
    port = ReadText(portFile)
    If IsNumeric(port) Then
      If Ping(port) Then
        sh.Run "http://127.0.0.1:" & port & "/", 1, False
        WScript.Quit 0
      End If
    End If
  End If
Next

' No popup: open a local error page with the log path instead.
sh.Run """file:///" & Replace(fso.BuildPath(here, "error.html"), "\", "/") & """", 1, False
WScript.Quit 1

Function ReadText(p)
  Dim f, s
  s = ""
  On Error Resume Next
  Set f = fso.OpenTextFile(p, 1)
  If Err.Number = 0 Then s = f.ReadAll
  If IsObject(f) Then f.Close
  On Error GoTo 0
  ReadText = Trim(s)
End Function

Function Ping(p)
  Dim xhr
  Ping = False
  On Error Resume Next
  Set xhr = CreateObject("MSXML2.XMLHTTP")
  xhr.Open "GET", "http://127.0.0.1:" & p & "/api/ping", False
  xhr.Send
  If Err.Number = 0 Then
    If xhr.Status = 200 Then Ping = True
  End If
  On Error GoTo 0
End Function
