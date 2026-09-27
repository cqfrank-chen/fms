# ============================================================
#  工厂管理系统 FMS · 宿主更新代理（方案①）
#  作用：读取 updates\apply.request → 备份数据库 → 更新代码 →
#        重建并重启容器 → 健康校验 → 写回 agent.status
#  由来：auto-update.bat 调用（可注册为每 5 分钟的计划任务）
#  安全：容器不持有 Docker 权限，所有重建动作都在宿主执行
# ============================================================
param(
  [string]$AppDir,
  [int]$HealthTimeoutSec = 240,
  [switch]$Force           # 无请求文件也强制走一次更新（用于手动升级）
)
$ErrorActionPreference = 'Continue'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $AppDir) { $AppDir = Split-Path -Parent $scriptDir }   # deploy\ 的上级 = 应用根目录
$updatesDir = Join-Path $AppDir 'updates'
$statusFile = Join-Path $updatesDir 'agent.status'
$reqFile = Join-Path $updatesDir 'apply.request'
$logFile = Join-Path $updatesDir 'agent.log'
if (-not (Test-Path $updatesDir)) { New-Item -ItemType Directory -Path $updatesDir -Force | Out-Null }

function Log($m) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m
  Write-Host $line
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}
function WriteStatus($result, $detail, $sha) {
  $o = [ordered]@{ lastRunAt = (Get-Date).ToUniversalTime().ToString('o'); lastResult = $result; detail = $detail; version = $sha; host = $env:COMPUTERNAME }
  $o | ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
}
function Get-EnvValue($key, $default) {
  $f = Join-Path $AppDir '.env'
  if (Test-Path $f) {
    $m = Select-String -Path $f -Pattern ('^' + [regex]::Escape($key) + '=(.*)$') | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value.Trim() }
  }
  return $default
}
function Set-EnvValue($key, $value) {
  $f = Join-Path $AppDir '.env'
  $lines = @(Get-Content -LiteralPath $f -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch ('^' + [regex]::Escape($key) + '=') })
  $lines += ($key + '=' + $value)
  Set-Content -LiteralPath $f -Value $lines -Encoding UTF8
}

# ---- 是否有更新请求 ----
$req = $null
if (Test-Path $reqFile) { try { $req = Get-Content -LiteralPath $reqFile -Raw | ConvertFrom-Json } catch { Log ('[警告] apply.request 解析失败：' + $_.Exception.Message) } }
if (-not $req -and -not $Force) { WriteStatus 'idle' '无待处理更新请求' (Get-EnvValue 'FMS_BUILD_SHA' 'unknown'); exit 0 }

Push-Location $AppDir
try {
  Log '================ 开始更新 ================'
  if ($req) { Log ('目标提交：' + $req.targetShort + '  包：' + $req.file) }

  # ---- 1. 备份数据库 ----
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  $backupDir = Join-Path $AppDir 'backups'
  if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
  $dump = Join-Path $backupDir ('auto_' + $stamp + '.dump')
  docker exec fms-postgres pg_dump -U fms -d fms -F c -f /tmp/fms_auto.dump 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    docker cp fms-postgres:/tmp/fms_auto.dump $dump 2>&1 | Out-Null
    docker exec fms-postgres rm -f /tmp/fms_auto.dump 2>&1 | Out-Null
    Log ('[1/5] 已备份数据库：' + $dump)
  } else { Log '[1/5] [警告] 数据库备份失败（继续，但请检查 postgres 容器）' }

  # ---- 2. 更新代码 ----
  $newSha = $null
  if (Test-Path (Join-Path $AppDir '.git')) {
    Log '[2/5] git 模式：从 origin 拉取最新代码'
    $branch = Get-EnvValue 'FMS_UPDATE_BRANCH' 'main'
    git fetch origin 2>&1 | Out-Null
    git reset --hard ('origin/' + $branch) 2>&1 | Out-Null
    $newSha = (git rev-parse HEAD).Trim()
    Log ('      代码已更新到 ' + $newSha.Substring(0,7))
  } elseif ($req -and $req.file -and (Test-Path $req.file)) {
    Log '[2/5] 压缩包模式：解压并覆盖应用目录（保留 .env / backups / updates / docker）'
    $tmp = Join-Path $env:TEMP ('fms-upd-' + $stamp)
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    tar -xzf $req.file -C $tmp
    if ($LASTEXITCODE -ne 0) { throw '解压失败（tar 不可用？）' }
    $src = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
    robocopy $src $AppDir /E /XD .git backups updates docker node_modules /XF .env /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw ('robocopy 失败，退出码 ' + $LASTEXITCODE) }
    $newSha = $req.targetSha
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Log ('      代码已覆盖到 ' + $newSha.Substring(0,7))
  } else {
    Log '[2/5] 无更新包且非 git 仓库：仅重建当前代码'
    $newSha = Get-EnvValue 'FMS_BUILD_SHA' 'unknown'
  }
  if ($newSha) { Set-EnvValue 'FMS_BUILD_SHA' $newSha; Log ('      已写入 FMS_BUILD_SHA=' + $newSha.Substring(0,7)) }

  # ---- 3. 重建镜像 ----
  Log '[3/5] docker compose build ...'
  docker compose build 2>&1 | Select-Object -Last 3 | ForEach-Object { Log ('      ' + $_) }
  if ($LASTEXITCODE -ne 0) { throw '镜像构建失败' }

  # ---- 4. 重启服务 ----
  Log '[4/5] docker compose up -d ...'
  docker compose up -d 2>&1 | Select-Object -Last 3 | ForEach-Object { Log ('      ' + $_) }
  if ($LASTEXITCODE -ne 0) { throw '服务启动失败' }

  # ---- 5. 健康校验 ----
  $port = Get-EnvValue 'HTTP_PORT' '80'
  $url = if ($port -eq '80') { 'http://localhost/api/health' } else { 'http://localhost:' + $port + '/api/health' }
  Log ('[5/5] 健康校验 ' + $url)
  $ok = $false
  for ($i = 0; $i -lt [int]($HealthTimeoutSec / 5); $i++) {
    Start-Sleep -Seconds 5
    try { $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch { }
  }
  if ($ok) {
    Log '健康校验通过，更新完成'
    WriteStatus 'ok' ('更新到 ' + $newSha.Substring(0,7) + '，健康校验通过') $newSha
    if (Test-Path $reqFile) { Remove-Item -LiteralPath $reqFile -Force }
  } else {
    Log '[错误] 应用未在预期时间内就绪'
    WriteStatus 'failed' ('更新后健康校验超时；备份见 ' + $dump) $newSha
  }
} catch {
  Log ('[错误] ' + $_.Exception.Message)
  WriteStatus 'failed' $_.Exception.Message (Get-EnvValue 'FMS_BUILD_SHA' 'unknown')
} finally {
  Pop-Location
  Log '================ 结束 ================'
}
