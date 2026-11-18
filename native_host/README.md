# CodexSwitch Native Host

用于同步 Codex 系统配置并管理可选本机 API Router 的原生消息主机。Router 脚本必须与 `codex_config_host.cjs` 位于同一目录，安装脚本会一并安装或检查该脚本。

## 工作原理

1. 用户在 CodexSwitch 扩展中选中一个 Provider
2. 扩展通过 Chrome Native Messaging 调用此主机
3. 主机将配置写入:
   - `~/.codex/config.toml` - 保持现有 `model_provider` 不变，更新顶层 `model`，并更新当前 `model_provider` 对应 section 的 `name` / `base_url`
   - `~/.codex/auth.json` - 更新 OPENAI_API_KEY

## 安装

### macOS / Linux

```bash
cd native_host
chmod +x install.sh
./install.sh
```

按提示输入扩展 ID（在 `chrome://extensions/` 中查看）。

### Windows

```powershell
cd native_host
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会：
- 从 `native_host\windows\CodexConfigHostLauncher.cs` 编译 `native_host\windows\codex_config_host_launcher.exe`
- 生成 `native_host\windows\codex_config_host.json`
- 在 `HKCU\Software\Google\Chrome\NativeMessagingHosts\codex_config_host` 下注册 manifest 路径
- 使用 `native_host\windows\codex_config_host_launcher.exe` 作为 Chrome 启动入口

### 前置要求

- Node.js (用于运行原生主机脚本)
- 该 launcher 会优先使用安装时探测到的 Node.js 路径，并在其失效时回退到常见 Node 路径；换到另一台电脑时仍建议重新运行 `./install.sh`。

### 手动安装

1. 创建清单文件目录：
   - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
   - Linux: `~/.config/google-chrome/NativeMessagingHosts/`

2. 创建清单文件 `codex_config_host.json`：
   ```json
   {
     "name": "codex_config_host",
     "description": "CodexSwitch Config Sync Host",
     "path": "/绝对路径/到/codex_config_host_launcher.sh",
     "type": "stdio",
     "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
   }
   ```

3. 创建 launcher 脚本 `codex_config_host_launcher.sh`：
   ```bash
   #!/bin/bash
   HOST_SCRIPT="/绝对路径/到/codex_config_host.cjs"

   for node_bin in \
     "/绝对路径/到/node" \
     "/opt/homebrew/bin/node" \
     "/usr/local/bin/node" \
     "/usr/bin/node"
   do
     if [ -x "$node_bin" ]; then
       exec "$node_bin" "$HOST_SCRIPT"
     fi
   done

   if command -v node >/dev/null 2>&1; then
     exec "$(command -v node)" "$HOST_SCRIPT"
   fi

   echo "[CodexSwitch] Node.js executable not found; please reinstall native_host/install.sh" >&2
   exit 127
   ```

4. 确保脚本可执行：
   ```bash
   chmod +x /绝对路径/到/codex_config_host_launcher.sh
   chmod +x /绝对路径/到/codex_config_host.cjs
   ```

5. 重启 Chrome

## 卸载

### macOS / Linux

```bash
./uninstall.sh
```

### Windows 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

## 配置文件格式

### config.toml

更新规则：

- 若已有 `model_provider`，保持其原值不变
- 更新顶层 `model`
- 更新当前 `model_provider` 对应 section 的 `name` / `base_url`
- 若 `config.toml` 不存在，则自动初始化

```toml
model_provider = "OpenAI"
model = "gpt-4"

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://api.openai.com"
```

### auth.json

```json
{
  "OPENAI_API_KEY": "sk-..."
}
```

## 故障排除

### 扩展无法连接原生主机

1. 确认清单文件位置正确
2. 确认扩展 ID 匹配
3. 确认 Node.js 路径正确
4. 查看 Chrome 控制台的错误信息

### 查看日志

原生主机的输出会发送到 Chrome，可以在扩展的 Service Worker 控制台中查看。

### Windows 原生主机排查

1. 确认注册表项存在：`HKCU\Software\Google\Chrome\NativeMessagingHosts\codex_config_host`
2. 确认默认值指向 `native_host\windows\codex_config_host.json`
3. 确认 manifest 中的 `path` 指向 `native_host\windows\codex_config_host_launcher.exe`
4. 确认 `native_host\windows\codex_config_host_node_path.txt` 中记录了有效的 `node.exe`
5. 如 launcher 不存在，重新运行 `powershell -ExecutionPolicy Bypass -File .\install.ps1`

## 安全说明

- 原生主机只能被指定的扩展 ID 调用
- API Key 存储在本地文件 `~/.codex/auth.json`
- 建议设置适当的文件权限：`chmod 600 ~/.codex/auth.json`

## 本机 API Router

DeepSeek 是独立客户端类型，不与其他分组生成派生卡片；自身启用路由即可使用 API 协议转换。模型能力支持 `both`（Chat + Responses）及 `all`（再加 Messages），卡片下拉展开成模型与具体协议组合。`selectedApiType` 独立保存具体协议，同模型切换协议也同步 Harness；Harness 配置不写 `both/all`。切换选项卡不写配置，顶部按当前客户端显示有效 Provider、模型、具体协议及直连/路由状态。Harness 配置写入 `~/.dsh/profiles/desktop/cordis.patch.yml`（可用 `DSH_HOME` / `profile` 覆盖）与 `~/.dsh/.credentials.yaml`：只维护 `llm-pi-ai` 插件下的**第一个** provider，切换启用 Provider 时原地改写它的 `displayName` / `api` / `baseURL` / `models`（每个 model 带与 `id` 同值的 `name`），直连时 `apiKeyEnv` 固定为 `DEFAULT_API_KEY`（密钥只写入 `~/.dsh/.credentials.yaml` 的 `DEFAULT_API_KEY`，不写入补丁文件），并把 `agent-default-model` 的 `provider` / `model` 同步为当前选择；开启 DeepSeek 路由时该项改名为 `router`、指向 `http://127.0.0.1:<端口>/deepseek`、密钥指向本机令牌 `CODEXSWITCH_ROUTER_KEY`、模型为 `router`，关闭后写回启用 Provider 的直连参数。旧版本生成的多协议条目会被清理。

模型测试的 **Test via router** 是独立开关。启用后，扩展发送 `testModelViaRouter` 原生消息，由主机在随机回环端口建立仅使用表单 Provider 的临时 Router，60 秒内测试所选模型接口，完成后关闭并清理连接。先验证原生接口，200 直通；非 200 的 Responses/Messages 转为 Chat Completions 重试并转换成功响应。Chat 失败不反向回退。测试使用已保存的上游代理，分别保留原生失败诊断和最终重试响应；界面优先显示最终响应，原生诊断默认折叠，**Copy final response** 仅复制最终响应正文。测试不写运行状态、本机令牌、PID、客户端配置或 Provider，不影响已运行的全局 Router。关闭开关时沿用浏览器直连模型测试。

在扩展 Provider 主页面右下角的路由设置中设置端口（默认 `15721`）和可选的 HTTP/HTTPS 上游代理（例如 `http://127.0.0.1:7890`），点击 Apply 保存后开启 Router。服务仅绑定 `127.0.0.1`，使用本机令牌校验客户端请求；令牌首次开启时生成并保存在权限受限的 `~/.codexswitch/router-token.json`，之后关闭或重新开启 Router 都会复用该令牌。上游 API Key 和代理配置存储在权限受限的 `~/.codexswitch/router-state.json`。代理 URL 可包含用户名和密码，Router 会使用 Basic 代理认证。

Provider 首页右下角的 **路由设置** 提供服务开关、监听端口及上游代理。服务启动无需选择 Provider，且不会修改客户端配置。各 OpenAI/Codex、Anthropic、DeepSeek 选项卡的 **使用路由** 独立控制对应客户端；必须先启动服务并选择 Provider。启用仅备份和按字段修改该客户端，关闭则写回该类型已选原生 Provider 的直连配置，未选择原生 Provider 时明确报错。关闭服务前会提示受影响客户端，逐类切回直连，全部成功才停服；部分失败时服务继续运行，已完成及未完成客户端状态分别保留。异常不会静默直连。

原生 Provider 卡片及新增/编辑表单提供独立的 **格式转换** 开关，保存为 `formatConversionEnabled`，仅严格为 `true` 时开启；默认及旧配置缺字段时关闭。开启后 Router 为该 Provider 提供全部三种协议，并在另一种格式的水平选项卡显示标有 **Router** 的入口。入口绑定原 Provider ID，保留上游 `format` / `apiType`，不保存配置副本；编辑、切换模型和删除同步反映到两个选项卡。关闭时移除派生入口，只透传声明的原生协议，不跨格式转换或失败回退。该字段参与保存、导入导出和复制；模型测试的独立开关不受它影响。

Provider 的格式转换开关不会启动全局 Router。Router 关闭或服务不可用时派生入口仍显示，但不能激活；使用前须开启全局 Router 并确认服务运行。OpenAI（Chat / Responses）与 Anthropic（Messages）入口分别选择上游，客户端入口决定返回格式；未配置的路由返回 503。正在使用的上游或转换入口须先切换对应路由才能删除或关闭。活跃 Provider 的开关修改先同步 Native Host，成功后再保存；运行中的 Router 下一次请求即生效，不需要重启。

Router 对外支持 `/v1/chat/completions`、`/v1/responses` 和 `/v1/messages`，兼容 OpenAI/Anthropic 协议、Codex 和 Claude Code；插件内置聊天保持浏览器直连。**开启该 Provider 的格式转换时**，OpenAI Provider 使用 Chat Completions（`apiType=responses` 时使用 Responses），Anthropic Provider 使用 Messages；上游 JSON 或 SSE 响应转换回客户端入口协议。`apiType=both` 验证首选协议并在失败后尝试另一种协议；原生支持时直通请求和响应。关闭格式转换时，OpenAI `chat` 只透传 Chat Completions，`responses` 只透传 Responses，`both` 透传这两种协议，Anthropic 只透传 Messages；其他入口返回 400，且不会向上游发送请求。需要转换时，文本、图像、函数工具调用、常用参数、`tool_choice`、usage 和结束原因会尽量映射。该转换不是无损兼容：Responses 的后台/持久化响应、`previous_response_id` 状态续接及协议专属推理字段不保证可用；无对应字段的参数会忽略或降级。`web_search` 转为 Messages 时映射为带版本号的服务端工具，转为 Chat 时移除；`custom` 等无法表达的 freeform 工具也会移除。JSON 请求体中的 `model` 会替换为当前 Provider 模型。上游代理只影响 Router 到 Provider 的出站连接，不会跟随浏览器代理或 SwitchyOmega。日志位于 `~/.codexswitch/router.log`。

开启格式转换时，Responses 上游返回非 2xx，即使 `apiType=responses` 也会尝试 Chat Completions，并按客户端入口返回 Chat、Responses 或 Messages 格式。`apiType=chat` 的 Chat 上游返回 502 等暂时错误时不会盲试 Responses；仅在确实缺少端点时尝试替代协议。429、502、503 不会被缓存为协议不支持，真正模型不存在的 404 也不会触发协议回退。关闭格式转换时，原生失败直接返回，不因验证缓存而改走其他协议。若可用上游均失败，Router 只返回最终尝试的实际状态码和错误正文，并通过 `x-codexswitch-error-source: upstream-http` 标识来源。

回退成功时，原生 404 等失败仅保留为日志或模型测试诊断，不会写入客户端的 HTTP 正文或 SSE；客户端只收到最终成功响应。需要转换的非 SSE 响应不依赖上游 Content-Type，而是在发送成功响应头前完成 JSON 解析、源协议结构校验和序列化。非法 JSON、拼接正文或错误对象返回单个 502 JSON 错误，并通过 `x-codexswitch-error-source: router-response-conversion` 标识来源，不透传原始正文，也不伪造空的成功流。上游忽略 `stream:true` 返回完整 JSON 时，Router 转换为目标协议的完整 SSE 文本、工具调用和结束事件。

更新 Router 代码后，将新脚本同步到安装目录并重启 Router 才会加载新代码；对应平台的安装脚本可用于同步脚本。仅重启 Chrome 不会更新已经运行的独立 Router 进程，通常无需重启 Chrome。插件界面更新后在扩展管理页重新加载扩展即可。重启 Router 会复用本机令牌，操作前请等待正在进行的请求结束。macOS / Linux 安装脚本会把两个脚本复制到用户应用程序支持目录；Windows 安装使用项目中的原生主机目录，移动或删除项目目录后需要重新安装。

Router 派生入口的模型测试通过 `targetFormat` 指定目标协议：`anthropic` 测试 Messages，`openai` 测试 Chat Completions 和 Responses。Native Host 保留原生上游配置并启动临时 Router，返回目标格式的响应及 `convertedFrom` 诊断；旧 Host 若忽略目标格式，扩展会拒绝其不匹配的测试结果并提示更新。此类测试每次重新启动 Native Host，两个脚本同步后即可使用，无需重启 Chrome 或全局 Router。
