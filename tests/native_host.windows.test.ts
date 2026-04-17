// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '..')

function readRelative(file: string) {
  return readFileSync(path.join(projectRoot, file), 'utf8')
}

describe('Windows native host support', () => {
  it('defines the Windows install script with HKCU Chrome registration and launcher compilation', () => {
    const installPs1 = readRelative('native_host/install.ps1')

    expect(installPs1).toContain('HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\codex_config_host')
    expect(installPs1).toContain('codex_config_host.json')
    expect(installPs1).toContain('chrome-extension://$ExtensionId/')
    expect(installPs1).toContain('Add-Type')
    expect(installPs1).toContain('OutputType')
    expect(installPs1).toContain('ConsoleApplication')
    expect(installPs1).toContain('CodexConfigHostLauncher.cs')
  })

  it('defines the Windows uninstall script with HKCU Chrome cleanup', () => {
    const uninstallPs1 = readRelative('native_host/uninstall.ps1')

    expect(uninstallPs1).toContain('HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\codex_config_host')
    expect(uninstallPs1).toContain('Remove-Item')
    expect(uninstallPs1).toContain('codex_config_host.json')
  })

  it('defines a Windows launcher source that searches for node.exe and starts the host script', () => {
    const launcherSource = readRelative('native_host/windows/CodexConfigHostLauncher.cs')

    expect(launcherSource).toContain('where.exe')
    expect(launcherSource).toContain('node.exe')
    expect(launcherSource).toContain('codex_config_host.cjs')
    expect(launcherSource).toContain('UseShellExecute = false')
    expect(launcherSource).toContain('RedirectStandardInput = false')
    expect(launcherSource).toContain('RedirectStandardOutput = false')
  })
})
