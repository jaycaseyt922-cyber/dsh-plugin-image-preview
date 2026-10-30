# 探针实例：起一个**独立的** DeepSeek Harness 桌面实例（独立 user-data 与独立 DSH_HOME），
# 打开 CDP 端口，让 agent-browser 能连上去自己点、自己截图。
#
# 目的：验证客户端插件（尤其是 dsh-app:// 转发那一层），不碰你正在用的那个窗口，
# 也不需要你为每次改动重启主实例。
#
# 用法（用 Windows PowerShell 跑，本机没有 pwsh 7）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/probe.ps1 -Start
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/probe.ps1 -Status
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/probe.ps1 -Stop
param(
  [switch]$Start,
  [switch]$Status,
  [switch]$Stop,
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
$logFile = Join-Path $probeHome "probe.log"

function Get-ProbeProcess {
  if (-not (Test-Path $pidFile)) { return $null }
  $saved = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $saved) { return $null }
  return Get-Process -Id ([int]$saved) -ErrorAction SilentlyContinue
}

if ($Stop) {
  $proc = Get-ProbeProcess
  if ($proc) {
    try { $proc.Kill() } catch {}
    "stopped probe pid $($proc.Id)"
  } else {
    "no probe running"
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  return
}

if ($Status) {
  $proc = Get-ProbeProcess
  if (-not $proc) { "probe: not running"; return }
  "probe: pid $($proc.Id)"
  try {
    $targets = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/list" -UseBasicParsing -TimeoutSec 5
    $list = $targets.Content | ConvertFrom-Json
    "cdp ok, targets:"
    $list | ForEach-Object { "  " + $_.type + " " + $_.url }
  } catch {
    "cdp: not reachable ($($_.Exception.Message.Split([char]10)[0]))"
  }
  return
}

if (-not $Start) {
  "usage: probe.ps1 -Start | -Status | -Stop [-Port 9333]"
  return
}

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
$proc = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru -WindowStyle Minimized -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
$proc.Id | Set-Content $pidFile
"started probe pid $($proc.Id), cdp http://127.0.0.1:$Port, home $probeHome"

for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 800
  try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2
    "cdp ready after $([Math]::Round(($i + 1) * 0.8, 1))s"
    break
  } catch {
    if ($proc.HasExited) {
      "probe exited early:"
      Get-Content $logFile -Tail 20 -ErrorAction SilentlyContinue
      Get-Content "$logFile.err" -Tail 20 -ErrorAction SilentlyContinue
      break
    }
  }
}
