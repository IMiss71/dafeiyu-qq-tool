' stop-hidden.vbs - stop the wizard and the AstrBot/NapCat services, no console.
Option Explicit

Dim fso, sh, here, root, nodeExe, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
nodeExe = fso.BuildPath(root, "tools\node.exe")
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"

cmd = "cmd /c cd /d """ & root & """ && """ & nodeExe & """ scripts\stop.js >nul 2>nul"
sh.Run cmd, 0, True

cmd = "cmd /c cd /d """ & root & """ && """ & nodeExe & """ scripts\stop-wizard.js >nul 2>nul"
sh.Run cmd, 0, True

WScript.Quit 0
