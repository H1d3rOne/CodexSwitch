# Codex Switch

一个 Chrome 扩展，用于管理多个 OpenAI 兼容 API 供应商，支持一键切换、测试连接、AI 聊天，并可同步配置到系统 Codex CLI。

## 功能特性

- **供应商管理** - 添加、编辑、删除多个 OpenAI 兼容 API 供应商
- **一键切换** - 快速切换当前使用的 API 供应商
- **连接测试** - 测试 API 连接是否正常，支持批量测试
- **AI 聊天** - 内置聊天界面，快速测试 API 响应
- **配置同步** - 通过 Native Messaging 同步配置到 `~/.codex/config.toml` 和 `~/.codex/auth.json`
- **导入导出** - 支持供应商配置的导入导出

## 安装

### 1. 构建扩展

```bash
# 克隆仓库
git clone https://github.com/your-repo/CodexSwitch.git
cd CodexSwitch

# 安装依赖
npm install

# 构建
npm run build
```

构建产物位于 `dist/` 目录。

### 2. 安装扩展到 Chrome

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择项目的 `dist` 目录
5. 记下扩展的 ID（后续 Native Host 安装需要）

### 3. 安装 Native Host（可选，用于同步到 Codex CLI）

Native Host 用于将供应商配置同步到系统 Codex CLI 配置文件。

#### macOS

```bash
cd native_host
chmod +x install.sh
./install.sh
```

按提示输入扩展 ID。

#### Linux

```bash
cd native_host
chmod +x install.sh
./install.sh
```

按提示输入扩展 ID。

#### Windows

以管理员身份运行 PowerShell：

```powershell
cd native_host
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

按提示输入扩展 ID。

**Windows 前置要求：**
- Node.js（需在 PATH 中）
- .NET Framework（用于编译 C# launcher）

### 4. 重启 Chrome

安装 Native Host 后，重启 Chrome 浏览器使更改生效。

## 使用说明

### 添加供应商

1. 点击扩展图标打开侧边栏
2. 点击 **添加 Provider** 按钮
3. 填写供应商信息：
   - **名称** - 供应商显示名称
   - **Base URL** - API 基础地址（如 `https://api.openai.com/v1`）
   - **API Key** - API 密钥
   - **模型名称** - 默认使用的模型
   - **可用模型列表** - 可选，添加多个可用模型
4. 点击 **保存并测试** 验证配置

### 切换供应商

点击供应商卡片即可设为当前使用的供应商。开启 **同步** 开关后，会自动同步到 Codex CLI 配置。

### 测试连接

- **单个测试** - 点击供应商卡片右侧的测试按钮
- **批量测试** - 点击顶部的 **一键测试** 按钮

### AI 聊天

1. 点击左上角聊天图标进入聊天界面
2. 选择供应商和模型
3. 输入消息开始对话
4. 支持多会话管理

### 导入导出

- **导出** - 点击底部 **Export** 按钮导出所有供应商配置为 JSON 文件
- **导入** - 点击底部 **Import** 按钮从 JSON 文件导入供应商配置

## 配置文件

### Codex CLI 配置（通过 Native Host 同步）

**~/.codex/config.toml**
```toml
model_provider = "OpenAI"
model = "gpt-4"

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://api.openai.com"
```

**~/.codex/auth.json**
```json
{
  "OPENAI_API_KEY": "sk-..."
}
```

## 卸载

### 卸载扩展

1. 访问 `chrome://extensions/`
2. 找到 Codex Switch 扩展
3. 点击 **移除**

### 卸载 Native Host

**macOS / Linux**
```bash
cd native_host
./uninstall.sh
```

**Windows**
```powershell
cd native_host
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

## 故障排除

### Native Host 连接失败

1. 确认扩展 ID 与安装时输入的一致
2. 确认 Node.js 已安装且在 PATH 中
3. 检查清单文件是否存在：
   - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/codex_config_host.json`
   - Linux: `~/.config/google-chrome/NativeMessagingHosts/codex_config_host.json`
   - Windows: 注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\codex_config_host`
4. 重启 Chrome 浏览器

### API 测试失败

- 确认 Base URL 格式正确（通常需要包含 `/v1`）
- 确认 API Key 有效
- 检查网络连接和代理设置

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 运行测试
npm test
```

## 技术栈

- React 18
- TypeScript
- Vite
- Tailwind CSS
- Chrome Extension Manifest V3
- Chrome Native Messaging

## License

MIT
