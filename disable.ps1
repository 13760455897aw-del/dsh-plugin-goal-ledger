# 目标日志插件 — 紧急停用脚本
#
# 如果重启 DSH 后又出现 "web boot: N entries did not activate" 之类的启动失败，
# 先跑这个脚本把插件从 profile 里摘掉，然后重启 DSH 即可恢复。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\disable.ps1

$profilePath = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\package.json'
if (-not (Test-Path -LiteralPath $profilePath)) {
    Write-Error "找不到 profile：$profilePath"
    exit 1
}

$raw = Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8
$json = $raw | ConvertFrom-Json
$before = @($json.dsh.profile.bundles)
$after = @($before | Where-Object { $_ -ne 'dsh-plugin-goal-ledger' })

if ($after.Count -eq $before.Count) {
    Write-Host '插件本来就没启用，无需改动。'
    exit 0
}

$json.dsh.profile.bundles = $after
($json | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $profilePath -Encoding UTF8

Write-Host '已把 dsh-plugin-goal-ledger 从 profile 的 bundles 中移除：'
$after | ForEach-Object { Write-Host "  - $_" }
Write-Host ''
Write-Host '现在重启 DSH，界面就会回到没有这个插件的样子。'
