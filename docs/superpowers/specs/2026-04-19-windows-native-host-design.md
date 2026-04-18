# Windows Native Host 全链路适配设计

## 目标

让 CodexSwitch 在 Windows 上达到与 macOS 一致的可用性：

1. 能一键安装 native host。
2. 选中 provider 后，能正确写入 `%USERPROFILE%\\.codex\\config.toml` 与 `auth.json`。
3. 配置同步语义与 macOS 一致：替换已有值、不追加重复字段、不修改现有 `model_provider`。
4. 扩展侧不再出现误导性的 native host 断开报错。
5. 最终可以重新 build、打包并发布可安装版本。

## 非目标

1. 不重写为全新的 Windows 原生 host 实现。
2. 不引入与 macOS / Linux 分叉的独立配置写入逻辑。
3. 不修改 provider 数据模型或扩展 UI 交互。

## 推荐方案

采用“最小侵入补强现有 Windows 链路”的方案：

- 保留当前总体架构：扩展 -> Native Messaging -> `native_host/codex_config_host.cjs`。
- 扩展侧统一优先使用一次性 `sendNativeMessage`，仅在缺失时回退到 `connectNative`。
- Windows 安装链路继续使用 PowerShell + C# launcher，但补齐稳定性与错误提示。
- 将配置写入语义统一收敛到 `native_host/codex_config_host.cjs`，确保三端一致。

该方案改动面最小、可复用现有测试基础，并能同时覆盖 Windows 与 macOS 的当前问题。

## 架构与职责

### 1. 扩展侧：`src/utils/systemConfig.ts`

职责：

- 负责向 native host 发送 `updateConfig` 请求。
- 统一解析响应与运行时错误。
- 在 native host 不可用时继续保留本地 storage fallback。

设计：

- 构造统一消息：
  - `action: 'updateConfig'`
  - `config: { name, baseUrl, apiKey, model }`
- 若 `chrome.runtime.sendNativeMessage` 可用，则优先使用它完成一次性请求。
- 仅在 `sendNativeMessage` 不可用时回退到 `connectNative`。
- 若 `chrome.runtime.lastError` 存在，则向调用方返回失败结果，不吞错。

原因：

当前 native host 是一次性进程，处理完请求即退出。继续使用 `connectNative` 会让 Chrome 在正常退出后触发 disconnect，从而制造误导性的 `Native host has exited.` 日志。改为 `sendNativeMessage` 可以与 host 的一次性模型匹配。

### 2. 共享配置写入核心：`native_host/codex_config_host.cjs`

职责：

- 读取和更新 `config.toml`。
- 读取和更新 `auth.json`。
- 处理 Windows 的权限恢复与原子写入回退。

统一语义：

- 若 `config.toml` 已存在：
  - 保持顶层 `model_provider` 原值不变。
  - 替换顶层 `model`。
  - 使用当前 `model_provider` 对应 section，替换其中的 `name` 与 `base_url`。
  - 不追加重复字段。
- 若 `config.toml` 不存在：
  - 自动创建 `.codex` 目录。
  - 初始化 `model_provider`、`model` 与 provider section。
- `auth.json`：
  - 若不存在则创建。
  - 更新 `OPENAI_API_KEY`。

实现要求：

- 使用正确转义的正则匹配已有字段，确保命中并覆盖已有 `model` / `name` / `base_url`。
- 若 section 不存在则新增整个 section；若字段不存在则在该 section 内补齐字段。
- 继续保留 Windows 专用的：
  - `EPERM` / `EACCES` 重试
  - 清除只读属性
  - 原子写入回退

### 3. Windows 安装链路：`native_host/install.ps1`

职责：

- 检查安装前提。
- 记录可用 `node.exe` 路径。
- 编译 launcher。
- 生成 manifest。
- 写入 Chrome Native Messaging 注册表。

设计：

- 输入：扩展 ID、可选 `-NodePath`。
- 检查以下文件存在：
  - `codex_config_host.cjs`
  - `windows/CodexConfigHostLauncher.cs`
- 自动探测 `node.exe`，若未找到且未显式传入则报错。
- 写出：
  - `windows/codex_config_host_launcher.exe`
  - `windows/codex_config_host.json`
  - `windows/codex_config_host_node_path.txt`
- 注册表写入：
  - `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\codex_config_host`
- manifest 建议使用 UTF-8 无 BOM 输出，以减少 Windows 下潜在兼容性问题。

### 4. Windows 启动器：`native_host/windows/CodexConfigHostLauncher.cs`

职责：

- 在 Windows 环境中稳定找到可用 `node.exe`。
- 启动 `codex_config_host.cjs` 并透传其 stdio 生命周期。

设计：

候选 node 路径顺序：

1. 安装时记录的 `codex_config_host_node_path.txt`
2. `CODEX_NODE_PATH`
3. 常见安装路径
4. `where.exe node.exe`

补强项：

- 启动前检查 `hostScript` 是否存在，若不存在则输出明确 stderr。
- 找不到 node 时返回 `127` 并输出明确提示。
- 保持：
  - `UseShellExecute = false`
  - 不重定向标准输入输出

### 5. 测试

#### 自动化测试

新增或增强：

- `tests/systemConfig.native-message.test.ts`
  - 当 `sendNativeMessage` 可用时优先使用它。
  - 不应优先使用 `connectNative`。
- `tests/native_host.update.test.ts`
  - 校验替换后 `model` / `name` / `base_url` 各只出现一次。
  - 校验 `model_provider` 保持不变。
  - 校验缺失 `config.toml` 时可以初始化。
- `tests/native_host.windows.test.ts`
  - 校验 Windows 安装脚本仍注册 HKCU Native Messaging Hosts。
  - 校验 launcher 仍搜索 `node.exe`。
  - 校验权限恢复逻辑保留。
  - 视实现情况补充 host script 存在性检查与 node path 文件相关断言。

#### 手工测试

在 Windows 上验证：

1. 执行 `powershell -ExecutionPolicy Bypass -File .\\native_host\\install.ps1`。
2. 确认 launcher、manifest、node path 文件生成。
3. 确认注册表项存在。
4. 在 Chrome 中选中 provider，点击“设为当前”。
5. 检查 `%USERPROFILE%\\.codex\\config.toml` 和 `auth.json`。
6. 再切换到另一个 provider，确认字段被替换而非重复追加。

在 macOS 上回归验证：

1. 选中 provider。
2. 不再出现误导性的 `Native host has exited.`。
3. 配置替换逻辑保持正确。

## 验收标准

### 安装成功

- `install.ps1` 成功执行。
- 生成 launcher / manifest / node path 文件。
- 注册表写入成功。
- manifest 的 `path` 指向 launcher exe。

### 运行成功

- 扩展能收到 native host 成功响应。
- 不再出现误导性断开报错。
- 真失败时错误可透传到 UI / 控制台。

### 写入成功

- `model_provider` 不变。
- `model` 被替换。
- 对应 provider section 的 `name` / `base_url` 被替换。
- 不会新增重复字段。
- `OPENAI_API_KEY` 被更新。

### 初始化成功

- 缺失 `.codex` / `config.toml` / `auth.json` 时能自动创建。

### 权限恢复成功

- Windows 下只读或 `EPERM` / `EACCES` 场景可重试恢复，失败时给出明确错误。

## 实施顺序

1. 修复并锁定扩展侧 `sendNativeMessage` 优先级。
2. 修复 `codex_config_host.cjs` 的字段替换匹配与初始化逻辑。
3. 补强 Windows 安装 / launcher 可诊断性。
4. 跑全量测试与 build。
5. 打包并准备 release。
