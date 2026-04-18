param(
    [string]$ExtensionId,
    [string]$NodePath
)

$ErrorActionPreference = 'Stop'

if (-not $ExtensionId) {
    $ExtensionId = Read-Host '请输入扩展 ID'
}

if (-not $ExtensionId) {
    throw '扩展 ID 不能为空'
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$windowsDir = Join-Path $scriptDir 'windows'
$hostScript = Join-Path $scriptDir 'codex_config_host.cjs'
$launcherSourcePath = Join-Path $windowsDir 'CodexConfigHostLauncher.cs'
$launcherPath = Join-Path $windowsDir 'codex_config_host_launcher.exe'
$manifestPath = Join-Path $windowsDir 'codex_config_host.json'
$nodePathFile = Join-Path $windowsDir 'codex_config_host_node_path.txt'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\codex_config_host'

if (-not (Test-Path $windowsDir)) {
    New-Item -Path $windowsDir -ItemType Directory -Force | Out-Null
}

if (-not $NodePath) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $NodePath = $nodeCommand.Source
    }
}

if (-not $NodePath) {
    throw '未找到 node.exe，请先安装 Node.js 或显式传入 -NodePath'
}

if (-not (Test-Path $launcherSourcePath)) {
    throw "未找到 Windows launcher 源码: $launcherSourcePath"
}

if (-not (Test-Path $hostScript)) {
    throw "未找到 host 脚本: $hostScript"
}

Set-Content -Path $nodePathFile -Value $NodePath -Encoding UTF8

if (Test-Path $launcherPath) {
    Remove-Item -Path $launcherPath -Force
}

Add-Type `
    -Path $launcherSourcePath `
    -OutputAssembly $launcherPath `
    -OutputType ConsoleApplication

$manifest = @{
    name = 'codex_config_host'
    description = 'CodexSwitch Config Sync Host'
    path = $launcherPath
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4

Set-Content -Path $manifestPath -Value $manifest -Encoding UTF8
New-Item -Path $registryPath -Force | Out-Null
New-ItemProperty -Path $registryPath -Name '(default)' -Value $manifestPath -PropertyType String -Force | Out-Null

Write-Host '安装完成'
Write-Host "Manifest: $manifestPath"
Write-Host "Registry: $registryPath"
Write-Host "Node: $NodePath"
Write-Host "Host Script: $hostScript"
Write-Host "Launcher: $launcherPath"
