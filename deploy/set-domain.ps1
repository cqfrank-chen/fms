# ============================================================
#  工厂管理系统 FMS · 本地域名绑定（fms.local）
#  作用：把 fms.local（别名 fms）指向服务器局域网 IP，写入 Windows hosts 并验证
#  用法：由 set-domain.bat 调用（自动提权）；也可直接：
#        powershell -ExecutionPolicy Bypass -File set-domain.ps1               # 本机（服务器）绑定
#        powershell -ExecutionPolicy Bypass -File set-domain.ps1 -Ip 192.168.1.2   # 其他电脑绑定到服务器
#        powershell -ExecutionPolicy Bypass -File set-domain.ps1 -PrintOnly    # 只预览不改
#        powershell -ExecutionPolicy Bypass -File set-domain.ps1 -Remove       # 解除绑定
#  全厂生效：路由器/内网 DNS 加 A 记录  fms.local -> 服务器 IP（免逐台改 hosts）
# ============================================================
param(
  [switch]$Remove,
  [switch]$PrintOnly,
  [string]$Domain = 'fms.local',
  [string]$Alias = 'fms',
  # 服务器之外的其他电脑：指向服务器的局域网 IP，例如 -Ip 192.168.1.2
  [string]$Ip
)
$ErrorActionPreference = 'Stop'
$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
# 匹配整词 fms.local / fms，避免误删含该子串的其它行
$pattern = '(^|\s)' + [regex]::Escape($Domain) + '(\s|$)|(^|\s)' + [regex]::Escape($Alias) + '(\s|$)'

function Get-LanIp {
  $lan = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1).IPv4Address.IPAddress
  if (-not $lan) {
    $lan = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' } | Select-Object -First 1).IPAddress
  }
  return $lan
}

if ($Remove) {
  $lines = @(Get-Content -LiteralPath $hostsPath -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch $pattern })
  Set-Content -LiteralPath $hostsPath -Value $lines -Encoding ASCII
  ipconfig /flushdns | Out-Null
  Write-Host ('已移除 ' + $Domain + ' / ' + $Alias + ' 的 hosts 绑定，并刷新 DNS。') -ForegroundColor Green
  exit 0
}

# 注意：PowerShell 变量名不区分大小写，参数 $Ip 与局部变量必须用不同名字
$targetIp = $Ip
if (-not $targetIp) { $targetIp = Get-LanIp }
if (-not $targetIp) {
  Write-Host '[错误] 未识别到局域网 IP，请确认已连接厂内网络（Wi-Fi/网线），或用 -Ip 指定服务器 IP。' -ForegroundColor Red
  exit 1
}
$entry = $targetIp + [char]9 + $Domain + ' ' + $Alias
Write-Host '============================================'
Write-Host '  工厂管理系统 FMS · 本地域名绑定'
Write-Host '============================================'
if ($Ip) { Write-Host ('  目标服务器 IP : ' + $targetIp + '  (其他电脑绑定)') } else { Write-Host ('  本机局域网 IP : ' + $targetIp) }
Write-Host ('  绑定域名      : http://' + $Domain + '   (别名 http://' + $Alias + ')')
Write-Host ''

if ($PrintOnly) {
  Write-Host ('[预览] 将写入 hosts : ' + $entry) -ForegroundColor Yellow
  Write-Host ('[预览] 随后刷新 DNS 缓存，并验证 http://' + $Domain + '/api/health') -ForegroundColor Yellow
  exit 0
}

$lines = @(Get-Content -LiteralPath $hostsPath -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch $pattern })
$lines += $entry
Set-Content -LiteralPath $hostsPath -Value $lines -Encoding ASCII
Write-Host ('[1/3] 已写入 hosts：' + $entry) -ForegroundColor Green

ipconfig /flushdns | Out-Null
Write-Host '[2/3] 已刷新 DNS 缓存' -ForegroundColor Green

try {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri ('http://' + $Domain + '/api/health') -TimeoutSec 8
  Write-Host ('[3/3] 验证通过：' + $resp.Content) -ForegroundColor Green
} catch {
  Write-Host ('[3/3] [警告] 暂时无法通过域名访问：' + $_.Exception.Message) -ForegroundColor Yellow
  Write-Host '       请确认 Docker 已启动（docker compose ps），且入站 80 端口已放行。'
}
Write-Host ''
Write-Host ('▸ 本机访问：  http://' + $Domain)
Write-Host ('▸ 他机访问：  放行入站 80 后，同网段电脑直接用 http://' + $Domain)
Write-Host ('▸ 全厂生效：  在路由器/内网 DNS 添加 A 记录  ' + $Domain + ' -> ' + $targetIp + '（免逐台改 hosts）')
Write-Host '▸ 解除绑定：  set-domain.bat /remove'
