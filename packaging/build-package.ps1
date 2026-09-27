# ============================================================
#  工厂管理系统 FMS · 发布包构建脚本（本地与 CI 共用，单一来源）
#  用法：
#    pwsh packaging/build-package.ps1                        # 瘦包（不含 Docker 安装器）
#    pwsh packaging/build-package.ps1 -Fat                   # 胖包（含 Docker 安装器，需 -InstallerPath 或 Downloads 里有）
#    pwsh packaging/build-package.ps1 -Version v1.0.3 -OutDir .
#  产物：
#    <OutDir>/fms-system-<ver>.zip   仅 system/（自动更新用，体积小）
#    <OutDir>/fms-setup-<ver>.zip    完整安装包（system/ + setup.bat + 安装说明.txt + docker/）
#    <OutDir>/fms-发布包/            解压后的目录（本地直接可用；system\.env 会保留）
# ============================================================
param(
  [string]$Version = '',
  [string]$OutDir = 'D:\futures',
  [string]$PkgDirName = 'fms-发布包',
  [string]$InstallerPath = '',
  [switch]$Fat,
  [switch]$SkipDir
)
$ErrorActionPreference = 'Stop'
$packagingDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $packagingDir
$devDirs = @('.scratch', 'research', 'backups', 'updates', 'packaging', 'node_modules')

function New-Zip($srcDir, $zipPath) {
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Push-Location $srcDir
  try {
    # 通配符打包：条目名不带 ./ 前缀（否则 Windows 资源管理器会显示为空）
    # 跨平台：Linux/CI 用 Info-ZIP（GNU tar 不能生成 zip），Windows 用 bsdtar 的 -a
    if (Get-Command zip -ErrorAction SilentlyContinue) {
      zip -qr $zipPath *
    } else {
      tar -a -c -f $zipPath *
    }
    if ($LASTEXITCODE -ne 0) { throw ('打包失败：' + $zipPath) }
  } finally { Pop-Location }
}

Push-Location $repo
try {
  $sha = (git rev-parse HEAD).Trim()
  if (-not $Version) { $Version = (git describe --tags --abbrev=0 2>$null | Select-Object -First 1) }
  if (-not $Version) { $Version = 'v0.0.0-' + $sha.Substring(0, 7) }
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  Write-Host ('构建提交 : ' + $sha)
  Write-Host ('版本号   : ' + $Version)
  Write-Host ('输出目录 : ' + $OutDir + '   模式：' + $(if ($Fat) { '胖包(含安装器)' } else { '瘦包' }))

  # 跨平台临时目录：Linux/CI 上 $env:TEMP 为空，用 GetTempPath()
  $work = Join-Path ([IO.Path]::GetTempPath()) ('fms-pkg-' + (Get-Date -Format 'yyyyMMddHHmmss'))
  $sysDir = Join-Path $work 'system'
  New-Item -ItemType Directory -Path $sysDir -Force | Out-Null

  # 1) 从 git HEAD 导出 system/（先写成 zip 再解压，避免二进制管道损坏）
  $arch = Join-Path $work 'head.zip'
  git archive --format=zip -o $arch HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git archive 失败' }
  Expand-Archive -LiteralPath $arch -DestinationPath $sysDir -Force
  foreach ($d in $devDirs) {
    $p = Join-Path $sysDir $d
    if (Test-Path $p) { Remove-Item -Recurse -Force $p }
  }

  # 2) 生成 REVISION.txt
  $revLines = @(
    '工厂管理系统 FMS · 发布包版本信息',
    '==================================================================',
    ('构建提交   : ' + $sha),
    ('提交标签   : ' + $Version),
    ('打包时间   : ' + $stamp),
    ('打包方式   : packaging/build-package.ps1（本地与 CI 共用）  模式：' + $(if ($Fat) { 'Fat' } else { 'Thin' })),
    '数据库迁移 : apps/api/drizzle（服务启动时自动执行）',
    '包含内容   : system/ 应用源码 · setup.bat · 安装说明.txt · docker/ 离线安装器放置位',
    '说明       : 本包不含 .env（密钥不入库；本地打包会保留已有 system\.env）；',
    '             自动更新使用包内 system/ 覆盖应用目录。',
    ''
  )
  $revText = ($revLines -join "`r`n")
  [IO.File]::WriteAllText((Join-Path $work 'REVISION.txt'), $revText, [Text.UTF8Encoding]::new($true))

  # 3) 汇总完整安装包目录
  $pkg = Join-Path $work $PkgDirName
  New-Item -ItemType Directory -Path $pkg -Force | Out-Null
  Copy-Item $sysDir (Join-Path $pkg 'system') -Recurse -Force
  Copy-Item (Join-Path $work 'REVISION.txt') (Join-Path $pkg 'REVISION.txt') -Force
  Copy-Item (Join-Path $packagingDir 'setup.bat') (Join-Path $pkg 'setup.bat') -Force
  Copy-Item (Join-Path $packagingDir '安装说明.txt') (Join-Path $pkg '安装说明.txt') -Force
  $dockerDir = Join-Path $pkg 'docker'
  New-Item -ItemType Directory -Path $dockerDir -Force | Out-Null
  Copy-Item (Join-Path $packagingDir 'docker-README.txt') (Join-Path $dockerDir 'README.txt') -Force
  Copy-Item (Join-Path $packagingDir 'docker-daemon.json') (Join-Path $dockerDir 'daemon.json') -Force

  # 4) 胖包：放入 Docker Desktop 安装器
  if ($Fat) {
    $ins = $InstallerPath
    if (-not $ins -or -not (Test-Path $ins)) {
      $ins = Join-Path $env:USERPROFILE 'Downloads\Docker Desktop Installer.exe'
    }
    if (Test-Path $ins) {
      Copy-Item $ins (Join-Path $dockerDir 'Docker Desktop Installer.exe') -Force
      Write-Host ('已包含安装器 : ' + [math]::Round((Get-Item $ins).Length / 1MB) + ' MB')
    } else {
      Write-Warning '未找到 Docker Desktop 安装器，退化为瘦包（新机需联网下载或手动放置）'
    }
  }

  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
  $setupZip = Join-Path $OutDir ('fms-setup-' + $Version + '.zip')
  $sysZip = Join-Path $OutDir ('fms-system-' + $Version + '.zip')
  New-Zip $pkg $setupZip
  New-Zip $sysDir $sysZip

  # 5) 本地解压目录（保留已有 system\.env，避免丢掉 AI Key 等配置）
  if (-not $SkipDir) {
    $localPkg = Join-Path $OutDir $PkgDirName
    $envBackup = $null
    $envFile = Join-Path $localPkg 'system\.env'
    if (Test-Path $envFile) { $envBackup = [IO.File]::ReadAllBytes($envFile) }
    if (Test-Path $localPkg) { Remove-Item -Recurse -Force $localPkg }
    Copy-Item $pkg $localPkg -Recurse -Force
    if ($envBackup) {
      [IO.File]::WriteAllBytes((Join-Path $localPkg 'system\.env'), $envBackup)
      Write-Host '已保留原有 system\.env'
    }
  }

  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  Write-Host ''
  foreach ($z in @($setupZip, $sysZip)) {
    $h = (Get-FileHash $z -Algorithm SHA256).Hash
    Write-Host ((Split-Path $z -Leaf) + '  ' + [math]::Round((Get-Item $z).Length / 1KB) + ' KB  SHA256=' + $h)
  }
  Write-Host '完成。'
} finally { Pop-Location }
