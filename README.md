# Codex Switch

[English](./README_EN.md) | [简体中文](./README.md)

一个 Chrome 扩展，用于管理多个 OpenAI 兼容 API 供应商，支持一键切换、测试连接、AI 聊天，并可同步配置到系统 Codex CLI。

## 功能特性

### 供应商管理
- **供应商管理** - 添加、编辑、删除多个 OpenAI 兼容 API 供应商
- **一键切换** - 快速切换当前使用的 API 供应商
- **连接测试** - 测试 API 连接是否正常，支持批量测试
- **AI 聊天** - 内置聊天界面，快速测试 API 响应
- **配置同步** - 通过 Native Messaging 同步配置到 `~/.codex/config.toml` 和 `~/.codex/auth.json`
- **本机 API Router** - 将 Codex / Claude Code 请求经本机回环地址转发到当前 Provider，切换 Provider 时保持客户端使用 Router 地址、令牌及模型别名
- **导入导出** - 支持供应商配置的导入导出

### 站点管理
- **站点管理** - 添加、编辑、删除多个 New API 站点
- **一键导入** - 从浏览器自动导入站点名称、URL、Cookie，并自动获取 Access Token
- **统一认证** - 支持 Access Token 和 Cookie 双重认证，Access Token 优先，失败时自动使用 Cookie
- **余额查询** - 查询站点余额，支持 USD、CNY 及自定义单位
- **模型列表** - 自动获取站点可用模型列表

### 自动签到
- **定时签到** - 设置签到时间范围，自动随机时间签到
- **签到状态** - 显示签到状态、日期和错误信息
- **Cookie 刷新** - 支持 Cookie 过期时自动刷新
- **Turnstile 支持** - 自动处理需要 Turnstile 验证的签到

### Webhook 通知
- **多平台支持** - 支持企业微信、钉钉、飞书、通用 Webhook
- **自动检测** - 根据 URL 自动识别 Webhook 平台
- **签到通知** - 签到完成后自动发送通知
- **测试功能** - 内置 Webhook 测试功能

### 分组管理
- **站点分组** - 支持站点分组管理，默认分组不可重命名
- **快速筛选** - 按分组快速筛选站点
- **分组编辑** - 双击下拉菜单项可编辑分组名称

## 安装

### 1. 构建扩展

```bash
# 克隆仓库
git clone https://github.com/H1d3rOne/CodexSwitch.git
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

运行 PowerShell：

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

### 本机 API Router

DeepSeek 是独立客户端类型，不与其他分组生成派生卡片；自身启用路由即可使用 API 协议转换。模型能力支持 `both`（Chat + Responses）及 `all`（再加 Messages），卡片下拉展开成模型与具体协议组合。`selectedApiType` 独立保存具体协议，同模型切换协议也同步 Harness；Harness 配置不写 `both/all`。切换选项卡不写配置，顶部按当前客户端显示有效 Provider、模型、具体协议及直连/路由状态。Harness 配置写入 `~/.dsh/profiles/desktop/cordis.patch.yml`（可用 `DSH_HOME` / `profile` 覆盖）与 `~/.dsh/.credentials.yaml`：只维护 `llm-pi-ai` 插件下的**第一个** provider，切换启用 Provider 时原地改写它的 `displayName` / `api` / `baseURL` / `apiKeyEnv` / `models`，并同步 `agent-default-model`；开启 DeepSeek 路由时该项改名为 `router`、指向 `http://127.0.0.1:<端口>/deepseek`、密钥指向本机令牌 `CODEXSWITCH_ROUTER_KEY`、模型为 `router`，关闭后写回启用 Provider 的直连参数。旧版本生成的多协议条目会被清理。

Provider 新增/编辑表单的模型 **Test** 区域提供独立的 **Test via router** 开关，默认关闭。关闭时仍由浏览器直连测试；开启时使用表单当前模型及 URL、API Key，通过临时本机 Router 测试所选接口。原生接口返回 200 时直通；Responses 或 Messages 返回非 200 时，转换请求为 Chat Completions 重试，再将成功响应转换回原格式。Chat 接口自身失败不反向尝试其他接口；Both 会分别测试 Chat 和 Responses。结果会标明 Chat 转换及原生状态码，可展开查看两次响应。该开关仅用于本次表单模型测试，不保存为 Provider 配置、不影响批量测试或插件聊天，也不启停全局 Router、切换当前 Provider 或修改 Codex/Claude Code 配置。需安装 Native Host，并使用已保存的 Router 上游代理设置；无需先开启全局 Router。

Provider 首页右下角的 **路由设置** 提供服务开关、监听端口及上游代理。服务启动无需选择 Provider，且不会修改客户端配置。各 OpenAI/Codex、Anthropic、DeepSeek 选项卡的 **使用路由** 独立控制对应客户端；必须先启动服务并选择 Provider。启用仅备份和按字段修改该客户端，关闭则写回该类型已选原生 Provider 的直连配置，未选择原生 Provider 时明确报错。关闭服务前会提示受影响客户端，逐类切回直连，全部成功才停服；部分失败时服务继续运行，已完成及未完成客户端状态分别保留。异常不会静默直连。

每个原生 Provider 卡片及新增/编辑表单提供独立的 **格式转换** 开关，默认关闭，旧配置未提供该字段时也保持关闭。开启后，该 Provider 可经 Router 提供 Chat Completions、Responses、Messages 全部三种格式，并在另一种格式的水平选项卡中显示标有 **Router** 的入口：OpenAI Provider 出现在 Anthropic 中，Anthropic Provider 出现在 OpenAI 中。派生入口使用目标格式及对应模型类型：Anthropic 入口的 Format 为 `anthropic`，模型显示 `messages`；OpenAI 入口的 Format 为 `openai`，模型类型为 `both`（Chat Completions / Responses），包括所有模型分组。点击派生入口的编辑按钮会显示只读目标格式视图，通过 **编辑原生 Provider** 修改上游配置。入口绑定原始 Provider ID，不创建配置副本、不修改上游 `format` / `apiType`；模型切换和原生配置编辑同步反映到两个选项卡，复制与分享仍使用原生配置。删除 Router 派生入口只会关闭原 Provider 的格式转换，保留原配置、模型及分组；删除原生 Provider 才会同时移除其 Router 入口。批量删除同样按当前选项卡中的入口类型分别处理；操作失败会保留失败项，不会改为删除原配置。关闭格式转换后移除派生入口，Router 只透传该 Provider 声明的原生协议，不做跨格式转换或失败回退。开关会保存并参与导入、导出和复制，与模型测试专用的 **Test via router** 开关互不影响。

格式转换开关不会自动开启全局 Router。Router 关闭或服务不可用时，派生入口仍显示但不能激活；使用前需开启全局 Router 并确认服务运行。Codex 与 Claude Code 分别使用 OpenAI 与 Anthropic 路由，可独立选择上游。各格式的原生 Provider 选择互不影响；转换生成的 Router 入口拥有目标格式自己的选择状态，选中它不会选中或取消原 Provider，切换原 Provider 也不会改变另一格式已选中的 Router 入口。同一目标格式的实际路由以最后点击的原生或转换入口为准，并在关闭、重新开启 Router 后保留；原生与转换入口各自的历史选择仍独立保存。仅旧数据缺少有效路由标记时，才按已有转换选择、原生选择依次回退；无选择时显示空状态。正在使用的上游不能直接删除，应先切换对应路由；正在使用的转换入口也不能直接关闭。活跃 Provider 的格式转换开关会立即同步到运行中的 Router，无需重启服务。

**Router 入口模型测试**始终通过临时 Router 请求目标接口：Anthropic 入口测试 Messages，OpenAI 入口分别测试 Chat Completions 和 Responses，展示转换后的响应及实际上游协议；上游配置仍保留原生 `format` / `apiType`。卡片测试、只读面板中的模型测试以及当前选项卡的 **Test All** 都遵循该规则；Test All 仍对全部原生 Provider 各测试一次，当前选项卡有 Router 入口时使用该入口，否则使用原生入口。测试不要求开启全局 Router，也不修改客户端配置。若提示 Native Host 未测试请求的目标格式，请更新或重新安装 Native Host，不能把旧 Host 返回的原接口结果当作转换测试结果。

Router 对外提供三种入口：`/v1/chat/completions`、`/v1/responses` 和 `/v1/messages`，兼容 OpenAI/Anthropic 协议、Codex 和 Claude Code；插件内置聊天仍由浏览器直连。**开启该 Provider 的格式转换时**，请求会按上游能力转换：OpenAI Provider 使用 Chat Completions（`apiType=responses` 时使用 Responses），Anthropic Provider 使用 Messages；响应转换回客户端入口协议。`apiType=both` 优先使用客户端原生协议，验证失败后尝试另一种协议。只有 Chat Completions 的 Provider 选择 `chat` 时，Responses/Messages 都经 Chat 转换；选择 `both` 时，原生 Responses 验证失败后经 Chat 转换，成功回退的客户端正文不会混入原生错误。支持普通 JSON 和 SSE 流式响应，文本、图像、函数工具调用、常用参数、`tool_choice`、usage 和结束原因会尽量映射。关闭格式转换时，OpenAI `chat` 只允许 Chat Completions，`responses` 只允许 Responses，`both` 允许这两种原生接口，Anthropic 只允许 Messages；其他入口返回明确错误。协议之间不是无损兼容：Responses 的后台/持久化响应、`previous_response_id` 状态续接及各协议专属推理字段不保证可用；没有对应字段的参数会忽略或降级。内置 `web_search` 转为 Anthropic Messages 时会映射为带版本号的服务端工具，转为 Chat 时会移除；`custom` 等无法表达的 freeform 工具也会移除。Router 会将 JSON 请求体中的 `model` 替换为当前 Provider 模型。代理配置作用于 Router 到上游的连接，支持 HTTP/HTTPS 代理及代理 URL 中的 Basic 认证，不会使用浏览器扩展代理。需要安装并运行 Native Host，且监听端口不能被其他程序占用。端口在 Router 运行时修改会自动重启 Router。

升级后先运行构建并在扩展管理页重新加载扩展，再同步安装 Native Host 脚本并在空闲时重启 Router，以加载新代码；通常无需重启 Chrome。此后切换 Provider 的格式转换开关无需再次重启 Router。

### 测试连接

- **单个测试** - 点击供应商卡片右侧的测试按钮
- **批量测试** - 点击顶部的 **一键测试** 按钮

### AI 聊天

1. 点击左上角聊天图标进入聊天界面
2. 选择供应商和模型
3. 输入消息开始对话
4. 支持多会话管理

### 导入导出

- **导出** - 点击底部 **Export** 按钮导出所有供应商配置为格式化的 JSON 文件
- **导入** - 点击底部 **Import** 按钮从 JSON 文件导入供应商配置；如果文件格式或版本不正确，会显示具体校验错误

## 配置文件

### Codex CLI 配置（通过 Native Host 同步）

同步规则：

- 保持现有顶层 `model_provider` 不变
- 更新顶层 `model`
- 更新当前 `model_provider` 对应 section 的 `name` / `base_url`
- 如果 `config.toml` 不存在，则自动初始化

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

客户端启用路由时，Codex base URL 为 `http://127.0.0.1:<端口>/openai/v1`，Claude 为 `http://127.0.0.1:<端口>/anthropic`，DeepSeek Harness 的 OpenAI 协议为 `/deepseek/v1`，Messages 协议为 `/deepseek`（SDK 追加 `/v1/messages`）。三者独立上游，不会因协议相同而互相覆盖。客户端使用本机令牌及模型别名 `router`，实际模型在转发时替换。关闭客户端路由按字段恢复当前原生选择直连，保留无关配置；`~/.codexswitch/` 保存状态、备份和可复用本机令牌。

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
欢迎来[linux.do](https://linux.do/)社区交流、分享和反馈。
