# 隐藏 NapCat 注入 QQ 后弹出的控制台窗口（以及 QQ 的错误弹窗）。
# 为什么存在这个脚本：
#   NapCatWinBootMain.exe 启动 QQ 时会自己 AllocConsole，Node 的 windowsHide 拦不住，
#   桌面上会留一个标题为 QQ 路径的黑窗口。它就是 QQ 本体，绝不能关——
#   关了等于 QQ 掉线。这里用 ShowWindow(SW_HIDE) 把它藏起来，进程照常运行。
#   QQ 的 0xc06d007f 错误弹窗同理：点「确定」有把 QQ 一起结束的风险，
#   只藏不点，消息收发不受影响（实测）。
param(
  [string]$ConsoleTitle = '',
  [int]$Seconds = 120,
  [int]$IntervalMs = 2000
)
Add-Type -Namespace Win -Name Native -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder sb, int max);
public delegate bool EnumProc(IntPtr h, IntPtr lp);
'@

$hidden = 0
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  # ① 控制台窗口：类名 ConsoleWindowClass，标题 = QQ 路径
  if ($ConsoleTitle) {
    $h = [Win.Native]::FindWindow('ConsoleWindowClass', $ConsoleTitle)
    if ($h -ne [IntPtr]::Zero -and [Win.Native]::IsWindowVisible($h)) {
      [Win.Native]::ShowWindow($h, 0) | Out-Null
      $hidden++
    }
  }
  # ② QQ.exe 错误弹窗：标题以 "QQ.exe - " 开头的对话框（含中文系统文案，不写死全称）
  $cb = [Win.Native+EnumProc]{
    param($h, $lp)
    $sb = New-Object System.Text.StringBuilder 256
    [Win.Native]::GetWindowText($h, $sb, 256) | Out-Null
    if ($sb.ToString().StartsWith('QQ.exe - ') -and [Win.Native]::IsWindowVisible($h)) {
      [Win.Native]::ShowWindow($h, 0) | Out-Null
      $script:hidden++
    }
    return $true
  }
  [Win.Native]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  if ($hidden -gt 0) { break }   # 该藏的都藏到了，提前收工
  Start-Sleep -Milliseconds $IntervalMs
}
exit 0
