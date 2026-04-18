# Windows Native Host 全链路适配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 CodexSwitch 在 Windows 上完成 native host 安装、启动、配置写入、错误回传与打包发布，并与 macOS 保持一致的配置替换语义。

**Architecture:** 扩展侧统一优先使用一次性 `sendNativeMessage` 与 native host 通信；三端共享 `native_host/codex_config_host.cjs` 作为唯一配置写入核心；Windows 继续使用 PowerShell 安装器 + C# launcher，但补强诊断信息与安装产物校验。

**Tech Stack:** TypeScript, React, Chrome Extension APIs, Node.js, PowerShell, C#, Vitest, Vite

---

## File Map

- Modify: `src/utils/systemConfig.ts`
  - 负责 native host 通信策略，优先 `sendNativeMessage`，必要时回退 `connectNative`。
- Modify: `native_host/codex_config_host.cjs`
  - 负责 `config.toml` / `auth.json` 更新、字段替换、初始化与 Windows 权限恢复。
- Modify: `native_host/install.ps1`
  - 负责 Windows 安装、launcher 编译、manifest 写入、注册表注册。
- Modify: `native_host/windows/CodexConfigHostLauncher.cs`
  - 负责在 Windows 上寻找 `node.exe` 并拉起 `codex_config_host.cjs`。
- Modify: `tests/native_host.update.test.ts`
  - 校验配置替换行为、不重复追加字段、初始化逻辑。
- Create: `tests/systemConfig.native-message.test.ts`
  - 校验扩展侧优先使用 `sendNativeMessage`。
- Modify: `tests/native_host.windows.test.ts`
  - 校验 Windows 安装器、launcher 诊断与权限恢复相关关键字符串。
- Verify only: `README.md`, `README_CN.md`, `native_host/README.md`
  - 只在代码路径或安装说明与实际行为不一致时补文档。

### Task 1: 扩展侧 native host 通信改为 one-shot 优先

**Files:**
- Modify: `src/utils/systemConfig.ts`
- Test: `tests/systemConfig.native-message.test.ts`

- [ ] **Step 1: 写失败测试，锁定 `sendNativeMessage` 优先级**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { updateCodexSystemForProvider } from '../src/utils/systemConfig'

const provider = {
  id: 'p1',
  name: 'Test Provider',
  baseUrl: 'https://example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4.1',
  models: ['gpt-4.1'],
  isActive: true,
  createdAt: 0,
  updatedAt: 0,
}

describe('updateCodexSystemForProvider', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => delete (globalThis as any).chrome)

  it('prefers sendNativeMessage for one-shot native host sync requests', async () => {
    const sendNativeMessage = vi.fn((hostName, message, callback) => callback({ success: true }))
    const connectNative = vi.fn(() => {
      throw new Error('connectNative should not be used when sendNativeMessage is available')
    })

    ;(globalThis as any).chrome = {
      runtime: {
        sendNativeMessage,
        connectNative,
        lastError: undefined,
      },
    }

    const result = await updateCodexSystemForProvider(provider as any)

    expect(result).toEqual({ success: true, error: undefined })
    expect(sendNativeMessage).toHaveBeenCalledTimes(1)
    expect(connectNative).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试并确认它先失败**

Run:

```bash
npm test -- --run tests/systemConfig.native-message.test.ts
```

Expected: FAIL，报错指出当前实现仍优先走 `connectNative`。

- [ ] **Step 3: 在 `src/utils/systemConfig.ts` 写最小实现**

将函数改成先构造一次性消息，再优先走 `sendNativeMessage`：

```ts
const config = {
  action: 'updateConfig',
  config: {
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
  },
}

if (typeof (chrome as any).runtime.sendNativeMessage === 'function') {
  return await new Promise((resolve) => {
    ;(chrome as any).runtime.sendNativeMessage('codex_config_host', config, (msg: any) => {
      const error = chrome.runtime.lastError
      if (error) {
        resolve({ success: false, error: error.message || 'Disconnected' })
        return
      }
      resolve({ success: !!msg?.success, error: msg?.error })
    })
  })
}
```

保留 `connectNative` 分支作为兜底，不改 storage fallback。

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
npm test -- --run tests/systemConfig.native-message.test.ts
```

Expected: PASS，且输出中不再要求调用 `connectNative`。

- [ ] **Step 5: 提交这一小步**

```bash
git add src/utils/systemConfig.ts tests/systemConfig.native-message.test.ts
git commit -m "fix: prefer sendNativeMessage for native host sync"
```

### Task 2: 修复共享配置写入逻辑，确保替换而不是追加重复字段

**Files:**
- Modify: `native_host/codex_config_host.cjs`
- Modify: `tests/native_host.update.test.ts`

- [ ] **Step 1: 先把失败测试写完整，锁定“只出现一次”的语义**

在现有断言后追加：

```ts
expect(configToml.match(/^model = /gm)).toHaveLength(1)
expect(configToml.match(/^\s*name = /gm)).toHaveLength(1)
expect(configToml.match(/^\s*base_url = /gm)).toHaveLength(1)
```

- [ ] **Step 2: 运行测试确认当前实现会失败**

Run:

```bash
npm test -- --run tests/native_host.update.test.ts
```

Expected: FAIL，提示 `model = ` 或 `name = ` / `base_url = ` 重复出现。

- [ ] **Step 3: 在 `native_host/codex_config_host.cjs` 修正正则与 upsert 逻辑**

确保已有字段能被命中并替换，而不是因为正则错误落入追加路径：

```js
if (new RegExp(`^\\s*${field}\\s*=`).test(lines[i])) {
  lines[i] = fieldLine;
  return;
}
```

以及 section 内字段匹配：

```js
const idx = existingBody.findIndex(
  line => new RegExp(`^\\s*${field}\\s*=`).test(line)
)
if (idx === -1) {
  existingBody.push(replacement)
} else {
  existingBody[idx] = replacement
}
```

保持以下行为不变：

```js
const currentModelProvider = readTopLevelField(lines, 'model_provider')
const targetProviderKey = currentModelProvider || config.name || 'default'

if (!hasExistingConfig && config.name) {
  upsertTopLevelField(lines, 'model_provider', config.name)
}
if (config.model) {
  upsertTopLevelField(lines, 'model', config.model)
}
if (config.name && config.baseUrl) {
  upsertProviderSection(lines, targetProviderKey, config.name, config.baseUrl)
}
```

- [ ] **Step 4: 运行测试确认替换逻辑与初始化逻辑都通过**

Run:

```bash
npm test -- --run tests/native_host.update.test.ts
```

Expected: PASS，三个测试全部通过，且没有重复字段。

- [ ] **Step 5: 提交这一小步**

```bash
git add native_host/codex_config_host.cjs tests/native_host.update.test.ts
git commit -m "fix: replace codex config fields without duplicates"
```

### Task 3: 补强 Windows 安装器与 launcher 诊断

**Files:**
- Modify: `native_host/install.ps1`
- Modify: `native_host/windows/CodexConfigHostLauncher.cs`
- Modify: `tests/native_host.windows.test.ts`

- [ ] **Step 1: 先写失败测试锁定 Windows 安装与诊断字符串**

在 `tests/native_host.windows.test.ts` 新增断言：

```ts
expect(installPs1).toContain('codex_config_host_node_path.txt')
expect(installPs1).toContain('Set-Content -Path $nodePathFile')
expect(launcherSource).toContain('hostScript')
expect(launcherSource).toContain('File.Exists(hostScript)')
expect(launcherSource).toContain('Host script not found')
```

- [ ] **Step 2: 运行测试确认它先失败**

Run:

```bash
npm test -- --run tests/native_host.windows.test.ts
```

Expected: FAIL，指出 launcher 尚未声明 host script 缺失诊断或安装脚本未覆盖新的关键字符串。

- [ ] **Step 3: 在 `native_host/windows/CodexConfigHostLauncher.cs` 添加 host script 缺失诊断**

在 `Main()` 里、遍历 node 候选之前加入：

```csharp
if (!File.Exists(hostScript))
{
    Console.Error.WriteLine("[CodexSwitch] Host script not found: " + hostScript);
    return 1;
}
```

保持 node 搜索顺序与 `where.exe` fallback 不变。

- [ ] **Step 4: 在 `native_host/install.ps1` 保持 node path / manifest / registry 流程清晰可测**

确认安装脚本包含如下关键路径：

```powershell
$nodePathFile = Join-Path $windowsDir 'codex_config_host_node_path.txt'
Set-Content -Path $nodePathFile -Value $NodePath -Encoding UTF8

$manifest = @{
    name = 'codex_config_host'
    description = 'CodexSwitch Config Sync Host'
    path = $launcherPath
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4
```

如当前 manifest 写入方式已满足要求，只在必要时将其改为无 BOM 写法，不做无关重构。

- [ ] **Step 5: 运行 Windows 相关测试确认通过**

Run:

```bash
npm test -- --run tests/native_host.windows.test.ts
```

Expected: PASS，保留 HKCU 注册、launcher 编译、node 搜索、权限恢复与 host script 缺失诊断断言。

- [ ] **Step 6: 提交这一小步**

```bash
git add native_host/install.ps1 native_host/windows/CodexConfigHostLauncher.cs tests/native_host.windows.test.ts
git commit -m "fix: harden windows native host installer and launcher"
```

### Task 4: 全量验证、文档对齐、构建与打包

**Files:**
- Verify: `README.md`
- Verify: `README_CN.md`
- Verify: `native_host/README.md`
- Build output: `dist/`
- Package output: `codex-switch-v1.0.4.zip` 或下一个实际版本号 zip

- [ ] **Step 1: 跑完整测试套件**

Run:

```bash
npm test -- --run
```

Expected: PASS，包含：
- `tests/systemConfig.native-message.test.ts`
- `tests/native_host.update.test.ts`
- `tests/native_host.windows.test.ts`
- 其余回归测试

- [ ] **Step 2: 跑 build**

Run:

```bash
npm run build
```

Expected: PASS，输出 `dist/background.js`、`dist/manifest.json`、`dist/popup.html` 等构建产物。

- [ ] **Step 3: 对照 spec 检查文档是否需要最小修订**

重点检查以下文档中的行为表述是否仍准确：

```bash
rg -n "connectNative|sendNativeMessage|Native host|config.toml|auth.json|install.ps1|Host script" README.md README_CN.md native_host/README.md
```

如果文档与实际实现不一致，只做最小文字修正。例如 `native_host/README.md` 中关于配置写入部分应表述为：

```md
- 保持现有 `model_provider` 不变
- 更新顶层 `model`
- 更新当前 `model_provider` 对应 section 的 `name` 与 `base_url`
```

- [ ] **Step 4: 若文档有修改，运行相关静态回归检查并提交**

Run:

```bash
git diff -- README.md README_CN.md native_host/README.md
```

Expected: 只有必要的说明更新，无无关改动。

Commit:

```bash
git add README.md README_CN.md native_host/README.md
git commit -m "docs: align native host behavior notes"
```

如果文档无需修改，跳过此 commit。

- [ ] **Step 5: 打包扩展 zip**

Run:

```bash
rm -f codex-switch-v1.0.4.zip
cd dist && zip -r ../codex-switch-v1.0.4.zip .
```

Expected: 生成新的安装包 zip。

- [ ] **Step 6: 总结验证结果并准备发布**

整理以下证据：

```txt
- npm test -- --run -> 全部通过
- npm run build -> 通过
- Windows 安装脚本/launcher 关键路径已覆盖测试
- macOS/native host one-shot 调用已覆盖测试
```

如需要发布，再执行：

```bash
git status --short
git log --oneline -5
```

确认只有预期代码与打包产物。

## Self-Review

### Spec coverage

- 扩展侧 one-shot 通信：Task 1
- 配置替换 / 不重复追加 / 初始化：Task 2
- Windows 安装与 launcher 补强：Task 3
- 全量验证 / 构建 / 打包 / 文档对齐：Task 4

无 spec gap。

### Placeholder scan

- 无 `TODO` / `TBD` / “later” 占位描述。
- 每个代码步骤都给了明确代码片段。
- 每个验证步骤都给了准确命令与预期结果。

### Type consistency

- 扩展侧消息统一为 `action: 'updateConfig'` + `config: { name, baseUrl, apiKey, model }`
- 测试文件名与代码文件名一致：
  - `tests/systemConfig.native-message.test.ts`
  - `tests/native_host.update.test.ts`
  - `tests/native_host.windows.test.ts`
- Windows 产物名统一：
  - `codex_config_host_launcher.exe`
  - `codex_config_host_node_path.txt`
  - `codex_config_host.json`
