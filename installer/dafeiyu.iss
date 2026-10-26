; DaFeiYu deployer - Inno Setup 6 script
; Build: iscc /DMyAppVersion=2.4.0 /O..\dist installer\dafeiyu.iss
;
; Zero-cash build: unsigned. Windows will show SmartScreen once on first run.
; Per-user install (no UAC), one progress page, no welcome/finish pages.

#ifndef MyAppVersion
  #define MyAppVersion "2.4.0"
#endif

[Setup]
AppId={{E00B27F8-74AA-41BF-B2D6-61EC5E37C94A}
AppName=大肥鱼 QQ 部署向导
AppVersion={#MyAppVersion}
AppVerName=大肥鱼 QQ 部署向导 {#MyAppVersion}
AppPublisher=DaFeiYu
DefaultDirName={localappdata}\Programs\DaFeiYuQQ
DefaultGroupName=大肥鱼
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableFinishedPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=DaFeiYu-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
MinVersion=10.0.19042
CloseApplications=no
RestartApplications=no
SetupLogging=yes
UninstallDisplayName=大肥鱼 QQ 部署向导
UninstallDisplayIcon={sys}\wscript.exe
VersionInfoVersion={#MyAppVersion}.0
VersionInfoProductName=大肥鱼 QQ 部署向导
VersionInfoDescription=大肥鱼 QQ 部署向导安装程序

[Files]
Source: "..\build\stage\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\build\stage\tools\stop-all-wizards.ps1"; DestDir: "{tmp}"; Flags: dontcopy

[Icons]
Name: "{group}\大肥鱼部署向导"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher\start-hidden.vbs"""; WorkingDir: "{app}"; Comment: "打开大肥鱼部署向导"
Name: "{group}\停止大肥鱼"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher\stop-hidden.vbs"""; WorkingDir: "{app}"; Comment: "停止向导与后台服务"
Name: "{autodesktop}\大肥鱼部署向导"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher\start-hidden.vbs"""; WorkingDir: "{app}"; Comment: "打开大肥鱼部署向导"

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher\start-hidden.vbs"""; WorkingDir: "{app}"; Flags: nowait skipifsilent

[UninstallRun]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher\stop-hidden.vbs"""; Flags: runhidden waituntilterminated

[UninstallDelete]
Type: files; Name: "{app}\wizard.port"
Type: files; Name: "{app}\wizard.lock"
Type: files; Name: "{app}\wizard.log"
Type: files; Name: "{app}\wizard.err.log"

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  (* Stop ANY old DaFeiYu wizard (18765-18775), not just the one in the app dir.
     This prevents an old 2.1.x wizard from keeping port 18765 and fighting the new one. *)
  ExtractTemporaryFile('stop-all-wizards.ps1');
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ExpandConstant('{tmp}\stop-all-wizards.ps1') + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  (* Do NOT stop AstrBot/NapCat here: setup only replaces app files, and
     stopping them would take the bot offline for every upgrade. *)
  Result := '';
end;
