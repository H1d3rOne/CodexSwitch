# Native Host Windows Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Windows-native installation, registration, launcher, and documentation support for the CodexSwitch native host while keeping the existing Node-based host logic unchanged.

**Architecture:** Keep `native_host/codex_config_host.cjs` as the only host behavior implementation. Add Windows-specific PowerShell install/uninstall scripts plus a tiny Windows launcher source that resolves `node.exe` and starts the `.cjs` host. Add repository-local tests that verify generated Windows artifacts and launcher resolution behavior without requiring a live Windows machine.

**Tech Stack:** PowerShell, Node.js, Chrome Native Messaging, Vitest, C# launcher source, README docs

---

## File map

- Create: `native_host/install.ps1` — install the Windows host for the current user, write the manifest, and register the native messaging host in `HKCU`.
- Create: `native_host/uninstall.ps1` — remove the Windows registry entry and generated manifest.
- Create: `native_host/windows/CodexConfigHostLauncher.cs` — Windows launcher source that resolves `node.exe` and starts `codex_config_host.cjs`.
- Modify: `native_host/README.md` — document Windows install/uninstall/manual verification steps.
- Create: `tests/native_host.windows.test.ts` — verify Windows manifest generation content, install-script content, and launcher source expectations.

## Testing boundary

This plan does not attempt a real Windows runtime execution on this macOS machine. The tests focus on generated artifact correctness and launcher resolution strategy encoded in repository files.

### Task 1: Add failing tests for Windows artifacts and launcher expectations

**Files:**
- Create: `tests/native_host.windows.test.ts`
- Reference: `native_host/install.ps1`
- Reference: `native_host/uninstall.ps1`
- Reference: `native_host/windows/CodexConfigHostLauncher.cs`

- [ ] **Step 1: Write the failing Node-environment test file**

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '..')

function readRelative(file: string) {
  return readFileSync(path.join(projectRoot, file), 'utf8')
}

describe('Windows native host support', () => {
  it('defines the Windows install script with HKCU Chrome registration', () => {
    const installPs1 = readRelative('native_host/install.ps1')

    expect(installPs1).toContain('HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\codex_config_host')
    expect(installPs1).toContain('codex_config_host.json')
    expect(installPs1).toContain('chrome-extension://$ExtensionId/')
  })

  it('defines the Windows uninstall script with HKCU Chrome cleanup', () => {
    const uninstallPs1 = readRelative('native_host/uninstall.ps1')

    expect(uninstallPs1).toContain('HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\codex_config_host')
    expect(uninstallPs1).toContain('Remove-Item')
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
```

- [ ] **Step 2: Run the focused Windows test file to verify RED**

Run:
```bash
TMPDIR=/tmp npx vitest run tests/native_host.windows.test.ts
```

Expected:
- Fail with file-not-found errors because the Windows files do not exist yet

- [ ] **Step 3: Commit the red test file**

```bash
git add tests/native_host.windows.test.ts
git commit -m "test: cover windows native host artifacts"
```

### Task 2: Add Windows install and uninstall scripts

**Files:**
- Create: `native_host/install.ps1`
- Create: `native_host/uninstall.ps1`
- Test: `tests/native_host.windows.test.ts`

- [ ] **Step 1: Write `native_host/install.ps1` with current-user registry registration**

Create `native_host/install.ps1` with this content:

```powershell
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
$hostScript = Join-Path $scriptDir 'codex_config_host.cjs'
$launcherPath = Join-Path $scriptDir 'windows\codex_config_host_launcher.exe'
$manifestPath = Join-Path $scriptDir 'windows\codex_config_host.json'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\codex_config_host'

if (-not $NodePath) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $NodePath = $nodeCommand.Source
    }
}

if (-not $NodePath) {
    throw '未找到 node.exe，请先安装 Node.js 或显式传入 -NodePath'
}

if (-not (Test-Path $launcherPath)) {
    throw "未找到 Windows launcher: $launcherPath"
}

$manifest = @{
    name = 'codex_config_host'
    description = 'CodexSwitch Config Sync Host'
    path = $launcherPath
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4

Set-Content -Path $manifestPath -Value $manifest -Encoding UTF8
New-Item -Path $registryPath -Force | Out-Null
Set-ItemProperty -Path $registryPath -Name '(default)' -Value $manifestPath

Write-Host '安装完成'
Write-Host "Manifest: $manifestPath"
Write-Host "Registry: $registryPath"
Write-Host "Node: $NodePath"
Write-Host "Host Script: $hostScript"
```

- [ ] **Step 2: Write `native_host/uninstall.ps1` with registry cleanup**

Create `native_host/uninstall.ps1` with this content:

```powershell
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $scriptDir 'windows\codex_config_host.json'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\codex_config_host'

if (Test-Path $registryPath) {
    Remove-Item -Path $registryPath -Recurse -Force
    Write-Host "已删除注册表项: $registryPath"
} else {
    Write-Host "注册表项不存在: $registryPath"
}

if (Test-Path $manifestPath) {
    Remove-Item -Path $manifestPath -Force
    Write-Host "已删除 manifest: $manifestPath"
} else {
    Write-Host "manifest 不存在: $manifestPath"
}
```

- [ ] **Step 3: Run the focused Windows test file to see the remaining failure move to the launcher source**

Run:
```bash
TMPDIR=/tmp npx vitest run tests/native_host.windows.test.ts
```

Expected:
- Install/uninstall script assertions pass
- Launcher-source assertion still fails because the source file is not created yet

- [ ] **Step 4: Commit the PowerShell scripts**

```bash
git add native_host/install.ps1 native_host/uninstall.ps1 tests/native_host.windows.test.ts
git commit -m "feat: add windows native host install scripts"
```

### Task 3: Add the Windows launcher source

**Files:**
- Create: `native_host/windows/CodexConfigHostLauncher.cs`
- Test: `tests/native_host.windows.test.ts`

- [ ] **Step 1: Write the minimal C# launcher source**

Create `native_host/windows/CodexConfigHostLauncher.cs` with this content:

```csharp
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

internal static class CodexConfigHostLauncher
{
    private static int Main()
    {
        var launcherDir = AppContext.BaseDirectory;
        var hostScript = Path.GetFullPath(Path.Combine(launcherDir, "..", "codex_config_host.cjs"));
        var candidates = new List<string>
        {
            Environment.GetEnvironmentVariable("CODEX_NODE_PATH") ?? string.Empty,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe")
        };

        foreach (var candidate in candidates)
        {
            if (!string.IsNullOrWhiteSpace(candidate) && File.Exists(candidate))
            {
                return StartNode(candidate, hostScript);
            }
        }

        foreach (var discovered in DiscoverFromWhere())
        {
            if (File.Exists(discovered))
            {
                return StartNode(discovered, hostScript);
            }
        }

        Console.Error.WriteLine("[CodexSwitch] Node.js executable not found; please reinstall native_host/install.ps1");
        return 127;
    }

    private static int StartNode(string nodePath, string hostScript)
    {
        var process = new Process();
        process.StartInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = $"\"{hostScript}\"",
            UseShellExecute = false,
            RedirectStandardInput = false,
            RedirectStandardOutput = false,
            RedirectStandardError = false,
            WorkingDirectory = Path.GetDirectoryName(hostScript) ?? AppContext.BaseDirectory,
        };

        process.Start();
        process.WaitForExit();
        return process.ExitCode;
    }

    private static IEnumerable<string> DiscoverFromWhere()
    {
        var process = new Process();
        process.StartInfo = new ProcessStartInfo
        {
            FileName = "where.exe",
            Arguments = "node",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };

        process.Start();
        while (!process.StandardOutput.EndOfStream)
        {
            var line = process.StandardOutput.ReadLine();
            if (!string.IsNullOrWhiteSpace(line))
            {
                yield return line.Trim();
            }
        }
        process.WaitForExit();
    }
}
```

- [ ] **Step 2: Run the focused Windows test file to verify GREEN**

Run:
```bash
TMPDIR=/tmp npx vitest run tests/native_host.windows.test.ts
```

Expected:
- All tests in `tests/native_host.windows.test.ts` pass

- [ ] **Step 3: Commit the launcher source**

```bash
git add native_host/windows/CodexConfigHostLauncher.cs tests/native_host.windows.test.ts
git commit -m "feat: add windows native host launcher source"
```

### Task 4: Document Windows support in README

**Files:**
- Modify: `native_host/README.md`
- Test: `tests/native_host.windows.test.ts`

- [ ] **Step 1: Add a Windows install section under `## 安装`**

Add this block after the macOS/Linux section:

```md
### Windows

```powershell
cd native_host
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会：
- 生成 `native_host\windows\codex_config_host.json`
- 在 `HKCU\Software\Google\Chrome\NativeMessagingHosts\codex_config_host` 下注册 manifest 路径
- 使用 `native_host\windows\codex_config_host_launcher.exe` 作为 Chrome 启动入口
```
```

- [ ] **Step 2: Add a Windows uninstall section**

Add this block near the uninstall section:

```md
### Windows 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```
```

- [ ] **Step 3: Add a Windows troubleshooting note**

Add this block under troubleshooting:

```md
### Windows 原生主机排查

1. 确认注册表项存在：`HKCU\Software\Google\Chrome\NativeMessagingHosts\codex_config_host`
2. 确认默认值指向 `native_host\windows\codex_config_host.json`
3. 确认 manifest 中的 `path` 指向 `native_host\windows\codex_config_host_launcher.exe`
4. 确认机器上存在可用的 `node.exe`
```

- [ ] **Step 4: Re-run the focused Windows tests after README edits**

Run:
```bash
TMPDIR=/tmp npx vitest run tests/native_host.windows.test.ts
```

Expected:
- Windows test file still passes

- [ ] **Step 5: Commit the documentation update**

```bash
git add native_host/README.md
git commit -m "docs: add windows native host instructions"
```

## Final verification checklist

- [ ] Run the macOS/Linux launcher regression tests:

```bash
TMPDIR=/tmp npx vitest run tests/native_host.install.test.ts
```

Expected: existing launcher regression tests still pass.

- [ ] Run the Windows artifact tests:

```bash
TMPDIR=/tmp npx vitest run tests/native_host.windows.test.ts
```

Expected: Windows artifact tests pass.

- [ ] Inspect the final Windows file set:

```bash
find native_host -maxdepth 3 -type f | sort
```

Expected to include:
- `native_host/install.ps1`
- `native_host/uninstall.ps1`
- `native_host/windows/CodexConfigHostLauncher.cs`
- existing `native_host/codex_config_host.cjs`
