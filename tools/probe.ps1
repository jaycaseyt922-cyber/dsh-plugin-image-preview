# 探针实例：起一个**独立的** DeepSeek Harness 桌面实例（独立 user-data 与独立 DSH_HOME），
# 打开 CDP 端口，让 agent 能连上去自己点、自己截图。
#
# 目的：验证客户端插件（尤其 dsh-app:// 转发那一层），不碰你正在用的那个窗口，
# 也不需要你为每次改动重启主实例。
#
# 硬约束：**探针窗口一个像素都不许出现在你的屏幕上，也不许出现在任务栏。**
#   实现方式：探针进程跑在一个用 CreateDesktop 新建的**独立 Windows 桌面**上。
#   它不是你的桌面，所以窗口创建、显示、重绘全程都不可能在屏幕上出现（不存在“闪一下”），
#   任务栏也不会多出按钮。Windows 只合成你正在用的桌面，但 Chromium 自己照常出帧，
#   所以 CDP 截图无需把窗口“摆出来”，实测截图与真实界面一致。
#
# 使用约定（**一次只许有一个探针**，脚本自己会保证）：
#   -Start      起探针（隐藏桌面）；已有活的探针就**复用**它，绝不新开第二个
#   -Start -Supervise [-ExitAfter 90] [-MaxMinutes 20]
#               起探针并**守到收工**：连续 -ExitAfter 秒没有 CDP 客户端连接，
#               或者到了 -MaxMinutes 上限，就杀掉整棵树并删掉探针 home，然后自己退出。
#               这是推荐的用法（配受管后台任务）：没有窗口、没人用就自己消失。
#   -Status     看 pid / 端口 / CDP 目标 / 窗口在哪个桌面
#   -Visible    在当前桌面上起一个**看得见**的探针（仅人排查用，会真的出现在屏幕上）
#   -Stop       立刻杀掉探针、清掉 pid/端口/桌面记录，并（默认）删掉探针 home
#
# 典型一轮（自动收工，不会留下进程）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/probe.ps1 -Start -Supervise -ExitAfter 90
#   node tools/cdp.mjs eval "document.baseURI"     # 求值
#   node tools/cdp.mjs shot C:\path\probe.png      # 截图（屏幕上什么都不会出现）
#   # 90 秒没人连 CDP，它自己停掉；急停用 -Stop
#
# 用 Windows PowerShell 跑（本机没有 pwsh 7）。
param(
  [switch]$Start,
  [switch]$Status,
  [switch]$Stop,
  [switch]$Visible,
  [switch]$Arm,
  [switch]$Idle,
  [switch]$Supervise,
  [int]$ExitAfter = 90,
  [int]$MaxMinutes = 20,
  [switch]$KeepHome,
  [int]$Port = 9333,
  [string]$SessionId = ""
)

$ErrorActionPreference = "Stop"
$root = "C:\Users\18373\AppData\Local\Programs\DeepSeek Harness"
$exe = Join-Path $root "DeepSeek Harness.exe"
$realHome = "C:\Users\18373\.dsh"
$realProfile = Join-Path $realHome "profiles\desktop"
$probeHome = Join-Path $env:TEMP "dsh-probe-imgprev"
$probeProfile = Join-Path $probeHome "profiles\desktop"
$userData = Join-Path $probeHome "user-data"
$pidFile = Join-Path $probeHome "probe.pid"
$portFile = Join-Path $probeHome "probe.port"
$deskFile = Join-Path $probeHome "probe.desktop"
$logFile = Join-Path $probeHome "probe.log"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DeskProbe {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateDesktop(string name, string device, IntPtr devmode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr OpenDesktop(string name, int flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr desk);
  [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr desk, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint attrs, IntPtr template);
  [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

  public static int LaunchHidden(string exe, string args, string desktop, string logFile, out IntPtr desk, out IntPtr proc) {
    proc = IntPtr.Zero;
    desk = CreateDesktop(desktop, null, IntPtr.Zero, 0, 0x10000000u, IntPtr.Zero);
    if (desk == IntPtr.Zero) return -Marshal.GetLastWin32Error();

    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.lpDesktop = desktop;

    IntPtr hLog = CreateFile(logFile, 0x40000000u, 1u | 2u, IntPtr.Zero, 2u, 0x80u, IntPtr.Zero);
    if (hLog != IntPtr.Zero && hLog.ToInt64() != -1) {
      si.dwFlags = 0x100;                   // STARTF_USESTDHANDLES
      si.hStdInput = IntPtr.Zero;
      si.hStdOutput = hLog;
      si.hStdError = hLog;
    }

    PROCESS_INFORMATION pi;
    string cmd = "\"" + exe + "\" " + args;
    bool ok = CreateProcess(exe, cmd, IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref si, out pi);
    if (hLog != IntPtr.Zero && hLog.ToInt64() != -1) CloseHandle(hLog);
    if (!ok) {
      int e = Marshal.GetLastWin32Error();
      CloseDesktop(desk); desk = IntPtr.Zero;
      return -e;
    }
    proc = pi.hProcess;
    CloseHandle(pi.hThread);
    return pi.dwProcessId;
  }

  public static string WindowsOnDesktop(string desktop) {
    IntPtr desk = OpenDesktop(desktop, 0, false, 0x0040u | 0x0001u);  // DESKTOP_READOBJECTS|DESKTOP_ENUMERATE
    if (desk == IntPtr.Zero) return "desktop-not-found";
    var sb = new StringBuilder();
    EnumDesktopWindows(desk, (h, l) => {
      if (!IsWindowVisible(h)) return true;
      if (GetWindowTextLength(h) <= 0) return true;
      RECT r; GetWindowRect(h, out r);
      var t = new StringBuilder(256);
      GetWindowText(h, t, 256);
      sb.AppendFormat("rect={0},{1} iconic={2} title=\"{3}\"; ", r.L, r.T, IsIconic(h), t.ToString());
      return true;
    }, IntPtr.Zero);
    CloseDesktop(desk);
    return sb.ToString() == "" ? "no-window" : sb.ToString();
  }

  // 在隐藏桌面上把窗口最小化/还原：最小化后 Chromium 停止按帧绘制（空闲不再占 CPU），
  // 还原只在截图瞬间做，而且发生在看不见的桌面上，屏幕上不会有任何变化。
  public static int SetMinimized(string desktop, bool minimized) {
    IntPtr desk = OpenDesktop(desktop, 0, false, 0x10000000u);  // GENERIC_ALL，我们自己是创建者
    if (desk == IntPtr.Zero) return -1;
    int n = 0;
    EnumDesktopWindows(desk, (h, l) => {
      if (!IsWindowVisible(h)) return true;
      if (GetWindowTextLength(h) <= 0) return true;
      int cmd = minimized ? 6 : 9;  // SW_MINIMIZE / SW_RESTORE
      if (ShowWindow(h, cmd)) n++;
      return true;
    }, IntPtr.Zero);
    CloseDesktop(desk);
    return n;
  }
}
'@

# 活的探针 pid；pid 文件过期、进程已死、或这个 pid 已经不是 Harness（pid 复用）都返回 0
function Get-ProbePid {
  if (-not (Test-Path $pidFile)) { return 0 }
  $raw = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $raw) { return 0 }
  $n = 0
  if (-not [int]::TryParse($raw.Trim(), [ref]$n)) { return 0 }
  $proc = Get-Process -Id $n -ErrorAction SilentlyContinue
  if (-not $proc) { return 0 }
  if ($proc.ProcessName -notlike "DeepSeek Harness*") { return 0 }
  return $n
}

function Get-ProbePort {
  if (Test-Path $portFile) {
    $raw = Get-Content $portFile -ErrorAction SilentlyContinue | Select-Object -First 1
    $n = 0
    if ($raw -and [int]::TryParse($raw.Trim(), [ref]$n)) { return $n }
  }
  return 9333
}

function Get-ProbeDesktop {
  if (Test-Path $deskFile) {
    $raw = Get-Content $deskFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($raw) { return $raw.Trim() }
  }
  return ""
}

function Test-Cdp {
  param([int]$CdpPort)
  try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$CdpPort/json/version" -UseBasicParsing -TimeoutSec 3
    return $true
  } catch { return $false }
}

function Clear-ProbeFiles {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Remove-Item $portFile -Force -ErrorAction SilentlyContinue
  Remove-Item $deskFile -Force -ErrorAction SilentlyContinue
}

# 杀掉这次探针留下的一切：整棵进程树、pid/端口/桌面记录，默认连 home 一起删。
# home 里放着一份 .credentials.yaml 与会话副本，留着既占盘也不干净，下次 -Start 两秒就能重建。
function Remove-Probe {
  param([int]$TargetPid, [switch]$Purge)
  if ($TargetPid -gt 0) {
    & taskkill /PID $TargetPid /T /F 2>&1 | Out-Null
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
      Start-Sleep -Milliseconds 200
    }
  }
  Clear-ProbeFiles
  if ($Purge) {
    Remove-Item $probeHome -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# --- 监守模式（-Supervise）：起探针，然后**在这个进程里**盯着它，没人用就收摊 ------
# 不做外挂看门狗：探针是这条进程树里的子进程，父进程一退出，树就被回收（今天踩过：
# 外挂的 watchdog 会去清掉下一轮刚起的探针，还会继承管道句柄把调用者挂住）。
# 所以生命周期交给"同一条树里的监守循环"：CDP 端口上连续 ExitAfter 秒没有连接就关掉，
# MaxMinutes 是兜底上限。配合受管后台任务使用，任务结束时整棵树一起消失。
function Wait-ProbeIdle {
  param([int]$ProbeId, [int]$IdleSeconds, [int]$CapMinutes)
  $startedAt = Get-Date
  $deadline = if ($CapMinutes -gt 0) { $startedAt.AddMinutes($CapMinutes) } else { [datetime]::MaxValue }
  $lastSeen = $startedAt
  while ($true) {
    Start-Sleep -Seconds 3
    if (-not (Get-Process -Id $ProbeId -ErrorAction SilentlyContinue)) { return "probe exited" }
    # 代际校验：pid 文件已指向别人（或已被清空）就安静退出，别动别人的探针。
    if ((Get-ProbePid) -ne $ProbeId) { return "superseded" }
    $busy = $false
    try {
      $busy = [bool](Get-NetTCPConnection -LocalPort $Port -State Established -ErrorAction SilentlyContinue)
    } catch {
      $busy = $false
    }
    if ($busy) { $lastSeen = Get-Date }
    if ((Get-Date) -gt $deadline) { return "max lifetime $CapMinutes min reached" }
    if ($IdleSeconds -gt 0 -and -not $busy -and ((Get-Date) - $lastSeen).TotalSeconds -ge $IdleSeconds) {
      return "no CDP client for $IdleSeconds s"
    }
  }
}

if ($Stop) {
  $targetId = Get-ProbePid
  if (-not $targetId) {
    Remove-Probe -Purge:(-not $KeepHome)
    "no probe running (stale pid/desktop files cleaned)"
    return
  }
  Remove-Probe -TargetPid $targetId -Purge:(-not $KeepHome)
  "stopped probe pid $targetId"
  if (-not $KeepHome) { "purged $probeHome" }
  return
}

if ($Arm) {
  $targetId = Get-ProbePid
  if (-not $targetId) { "no probe running"; return }
  $desktop = Get-ProbeDesktop
  if (-not $desktop) { "probe is in -Visible mode; window is already live"; return }
  $n = [DeskProbe]::SetMinimized($desktop, $false)
  "armed probe for capture (pid $targetId, window restored on hidden desktop, windows=$n)"
  return
}

if ($Idle) {
  $targetId = Get-ProbePid
  if (-not $targetId) { "no probe running"; return }
  $desktop = Get-ProbeDesktop
  if (-not $desktop) { "probe is in -Visible mode; not minimizing"; return }
  $n = [DeskProbe]::SetMinimized($desktop, $true)
  "probe pid $targetId now idle (minimized on hidden desktop, windows=$n) — no rendering while idle"
  return
}

if ($Status) {
  $targetId = Get-ProbePid
  if (-not $targetId) { "probe: not running"; return }
  $cdpPort = Get-ProbePort
  $desktop = Get-ProbeDesktop
  "probe: pid $targetId, cdp port $cdpPort"
  "desktop: $(if ($desktop) { $desktop } else { '(current desktop, -Visible mode)' })"
  if ($desktop) { "window: $([DeskProbe]::WindowsOnDesktop($desktop))" }
  if (Test-Cdp -CdpPort $cdpPort) {
    "cdp ok, targets:"
    try {
      $list = (Invoke-WebRequest -Uri "http://127.0.0.1:$cdpPort/json/list" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
      $list | ForEach-Object { "  " + $_.type + " " + $_.url }
    } catch { }
  } else {
    "cdp: not reachable (run -Stop then -Start)"
  }
  return
}

if (-not ($Start -or $Visible)) {
  "usage: probe.ps1 -Start | -Start -Supervise [-ExitAfter 90] [-MaxMinutes 20] | -Status | -Stop | -Arm | -Idle | -Visible [-Port 9333] [-SessionId session-xxx]"
  "  -Supervise  runs until nothing has talked to CDP for -ExitAfter seconds (or -MaxMinutes), then stops itself and purges the probe home"
  return
}

# --- 同一时刻只允许一个起探针的流程，两个会话并发 -Start 也不会起出两个实例 --------------
$mutex = New-Object System.Threading.Mutex($false, "Local\dsh-probe-imgprev-launch")
$owned = $false
try {
  try { $owned = $mutex.WaitOne(15000) } catch { $owned = $false }
  if (-not $owned) {
    "another probe launch is in progress, retry in a few seconds"
    return
  }

  # 已有活的探针：复用它。这是「别的对话又开出一个窗口」的根治点。
  $existing = Get-ProbePid
  if ($existing -ne 0) {
    $cdpPort = Get-ProbePort
    "probe already running: pid $existing, cdp http://127.0.0.1:$cdpPort — reused, no new window"
    if (-not (Test-Cdp -CdpPort $cdpPort)) {
      "  warning: pid is alive but CDP is unreachable; run -Stop then -Start"
    }
    return
  }

  # 没有活的探针，清掉可能残留的 pid/端口/桌面文件（用户直接关窗口的情况）
  Clear-ProbeFiles

  # --- 独立 home：配置照抄真 profile，node_modules 用 junction 共享 ---------------
  New-Item -ItemType Directory -Force $probeHome, $probeProfile, $userData, (Join-Path $probeHome "sessions") | Out-Null
  Copy-Item (Join-Path $realProfile "package.json") (Join-Path $probeProfile "package.json") -Force
  Copy-Item (Join-Path $realProfile "cordis.patch.yml") (Join-Path $probeProfile "cordis.patch.yml") -Force
  if (Test-Path (Join-Path $realHome ".credentials.yaml")) {
    Copy-Item (Join-Path $realHome ".credentials.yaml") (Join-Path $probeHome ".credentials.yaml") -Force
  }
  $nodeModules = Join-Path $probeProfile "node_modules"
  if (-not (Test-Path $nodeModules)) {
    cmd /c mklink /J "$nodeModules" "$realProfile\node_modules" | Out-Null
    "linked node_modules"
  }
  # 带一份会话历史过去，这样界面里直接有对话可看
  $sessions = Get-ChildItem (Join-Path $realHome "sessions") -Directory -Recurse -Depth 1 -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "session-*" } | Sort-Object LastWriteTime -Descending
  $copySession = if ($SessionId -ne "") { $sessions | Where-Object { $_.Name -eq $SessionId } | Select-Object -First 1 } else { $sessions | Select-Object -First 1 }
  if ($copySession) {
    $parentName = $copySession.Parent.Name
    $target = Join-Path $probeHome ("sessions\" + $parentName)
    New-Item -ItemType Directory -Force $target | Out-Null
    Copy-Item $copySession.FullName (Join-Path $target $copySession.Name) -Recurse -Force
    "copied session $($copySession.Name)"
  }

  # --- 起应用（不带脚本参数，走正常 Electron 主进程；Chromium 开关才生效） -----------
  # 关键：DSH 的子进程环境里 ELECTRON_RUN_AS_NODE=1，带着它启动会把 exe 当 node 跑，
  # 所有 Chromium 开关都会被 Node 当成非法参数。这里先摘掉它。
  $env:ELECTRON_RUN_AS_NODE = $null
  $env:DSH_HOME = $probeHome
  Remove-Item $logFile -Force -ErrorAction SilentlyContinue
  $arguments = "--user-data-dir=`"$userData`" --remote-debugging-port=$Port"
  if ($env:PROBE_EXTRA_ARGS) { $arguments = $arguments + " " + $env:PROBE_EXTRA_ARGS }

  if ($Visible) {
    $proc = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru
    $proc.Id | Set-Content $pidFile
    $Port | Set-Content $portFile
    "started VISIBLE probe pid $($proc.Id) on your desktop, cdp http://127.0.0.1:$Port"
  } else {
    $desktopName = "dsh-probe-" + [guid]::NewGuid().ToString("N").Substring(0, 12)
    $desk = [IntPtr]::Zero
    $procHandle = [IntPtr]::Zero
    $newPid = [DeskProbe]::LaunchHidden($exe, $arguments, $desktopName, $logFile, [ref]$desk, [ref]$procHandle)
    if ($newPid -le 0) {
      "failed to launch probe on hidden desktop (win32 error $([Math]::Abs($newPid)))"
      return
    }
    [void][DeskProbe]::CloseHandle($procHandle)
    $newPid | Set-Content $pidFile
    $Port | Set-Content $portFile
    $desktopName | Set-Content $deskFile
    "started probe pid $newPid on hidden desktop '$desktopName', cdp http://127.0.0.1:$Port"
    "  (it has no window on your screen and no taskbar button at all)"
  }

  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 800
    try {
      $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2
      "cdp ready after $([Math]::Round(($i + 1) * 0.8, 1))s"
      break
    } catch {
      if (-not (Get-Process -Id (Get-ProbePid) -ErrorAction SilentlyContinue)) {
        "probe exited early:"
        Get-Content $logFile -Tail 20 -ErrorAction SilentlyContinue
        Clear-ProbeFiles
        break
      }
    }
  }

  # 窗口约 5 秒后才创建，所以等它出现再最小化：Chromium 停止按帧绘制，
  # 就不会为了一个没人看的桌面显示而花 CPU/GPU。
  if (-not $Visible) {
    $desktopName = Get-ProbeDesktop
    $waitUntil = (Get-Date).AddSeconds(25)
    while (((Get-Date) -lt $waitUntil) -and ([DeskProbe]::WindowsOnDesktop($desktopName) -eq "no-window")) {
      Start-Sleep -Milliseconds 300
    }
    $minimized = [DeskProbe]::SetMinimized($desktopName, $true)
    Start-Sleep -Milliseconds 300
    $state = [DeskProbe]::WindowsOnDesktop($desktopName)
    if ($state -match 'iconic=True') { "idle: window minimized on hidden desktop — no rendering while idle" }
    else { "warning: could not confirm minimized state (windows=$minimized): $state" }
  }

  # --- 监守：同一条树里等收工，绝不外挂进程 -----------------------------------
  # 判据是 CDP 端口上还有没有 ESTABLISHED 连接：cdp.mjs 每次 eval/shot 都会连上，
  # 连续 ExitAfter 秒一个连接都没有，说明这一轮验证做完了。
  if ($Supervise) {
    $probeId = Get-ProbePid
    if ($probeId -ne 0) {
      "supervising pid $probeId — auto-stops after $ExitAfter s with no CDP client (hard cap $MaxMinutes min)"
      $why = Wait-ProbeIdle -ProbeId $probeId -IdleSeconds $ExitAfter -CapMinutes $MaxMinutes
      "supervisor: $why"
      if ((Get-ProbePid) -eq $probeId) {
        Remove-Probe -TargetPid $probeId -Purge:(-not $KeepHome)
        "probe stopped and home $(if ($KeepHome) { 'kept' } else { 'purged' })"
      }
    }
  }
} finally {
  if ($owned) { try { $mutex.ReleaseMutex() } catch {} }
  try { $mutex.Dispose() } catch {}
}
