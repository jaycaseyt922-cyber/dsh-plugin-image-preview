# 采样器：证明探针**没有在你屏幕上弹窗**。
#
# 在**当前（交互）桌面**上每隔 250ms 枚举一次可见且有标题的顶层窗口，把新出现的
# 标题连同时间写进日志。用法（先起采样器，再起探针，两者重叠才算覆盖到）：
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\window-sampler.ps1 -Seconds 70
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\probe.ps1 -Start
#   # 采样器结束时日志里应有 "done: new windows=0"
#
# 反证：`probe.ps1 -Visible` 会真的开一个窗口，此时日志里必然出现 NEW —— 这说明
# 采样器本身有效（否则“没抓到”可能只是没抓到而已）。
param(
  [string]$Out = "$env:TEMP\window-sampler.log",
  [int]$Seconds = 45
)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WinSampler {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);

  public static List<string> Titles() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLength(h);
      if (n <= 0) return true;
      var sb = new StringBuilder(n + 2);
      GetWindowText(h, sb, sb.Capacity);
      list.Add(sb.ToString());
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

$baseline = @{}
foreach ($t in [WinSampler]::Titles()) { $baseline[$t] = $true }
Set-Content -Path $Out -Value ("baseline windows={0} at {1}" -f $baseline.Count, (Get-Date -Format o))

$deadline = (Get-Date).AddSeconds($Seconds)
$seen = @{}
while ((Get-Date) -lt $deadline) {
  foreach ($t in [WinSampler]::Titles()) {
    if ($baseline.ContainsKey($t)) { continue }
    if ($seen.ContainsKey($t)) { continue }
    $seen[$t] = $true
    Add-Content -Path $Out -Value ("NEW {0} title={1}" -f (Get-Date -Format HH:mm:ss.fff), $t)
  }
  Start-Sleep -Milliseconds 250
}
Add-Content -Path $Out -Value ("done: new windows={0} at {1}" -f $seen.Count, (Get-Date -Format o))
