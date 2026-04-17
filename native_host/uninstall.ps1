$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$windowsDir = Join-Path $scriptDir 'windows'
$manifestPath = Join-Path $windowsDir 'codex_config_host.json'
$nodePathFile = Join-Path $windowsDir 'codex_config_host_node_path.txt'
$launcherPath = Join-Path $windowsDir 'codex_config_host_launcher.exe'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\codex_config_host'

if (Test-Path $registryPath) {
    Remove-Item -Path $registryPath -Recurse -Force
    Write-Host "已删除注册表项: $registryPath"
} else {
    Write-Host "注册表项不存在: $registryPath"
}

foreach ($file in @($manifestPath, $nodePathFile, $launcherPath)) {
    if (Test-Path $file) {
        Remove-Item -Path $file -Force
        Write-Host "已删除文件: $file"
    } else {
        Write-Host "文件不存在: $file"
    }
}
