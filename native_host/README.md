# CodexSwitch Native Host

用于同步 Codex 系统配置的原生消息主机。

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
