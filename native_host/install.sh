#!/bin/bash
# CodexSwitch Native Host 安装脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_HOST_SCRIPT="$SCRIPT_DIR/codex_config_host.cjs"

echo "=========================================="
echo "CodexSwitch Native Host 安装程序"
echo "=========================================="
echo ""
echo "请按以下步骤操作:"
echo ""
echo "1. 在 Chrome 中打开 chrome://extensions/"
echo "2. 开启右上角 '开发者模式'"
echo "3. 找到 CodexSwitch 扩展，复制其 ID"
echo ""
read -p "请输入扩展 ID: " EXTENSION_ID

if [ -z "$EXTENSION_ID" ]; then
    echo "错误: 扩展 ID 不能为空"
    exit 1
fi

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "错误: 未找到 Node.js，请先安装 Node.js"
    exit 1
fi

NODE_PATH=$(which node)

# 检测操作系统
if [[ "$OSTYPE" == "darwin"* ]]; then
    MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    HOST_INSTALL_DIR="$HOME/Library/Application Support/CodexSwitchNativeHost"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    HOST_INSTALL_DIR="$HOME/.local/share/codexswitch-native-host"
else
    echo "错误: 不支持的操作系统 $OSTYPE"
    exit 1
fi

# 创建目录
mkdir -p "$MANIFEST_DIR"
mkdir -p "$HOST_INSTALL_DIR"

# 将 native host 脚本安装到用户 Library/Application Support 等非 Documents 位置。
# macOS 下 Chrome 启动的 native host 读取 ~/Documents 内脚本时可能被 TCC 权限拦截，
# 造成 Chrome 只看到 "Native host has exited"。
HOST_SCRIPT="$HOST_INSTALL_DIR/codex_config_host.cjs"
cp "$SOURCE_HOST_SCRIPT" "$HOST_SCRIPT"
chmod +x "$HOST_SCRIPT"

# 创建 launcher，避免 Chrome GUI 环境下 PATH 不包含 node
LAUNCHER_FILE="$MANIFEST_DIR/codex_config_host_launcher.sh"
cat > "$LAUNCHER_FILE" << EOF_LAUNCHER
#!/bin/bash
HOST_SCRIPT="$HOST_SCRIPT"
LOG_FILE="\$HOME/.codex/codexswitch-native-host.log"

mkdir -p "\$(dirname "\$LOG_FILE")" 2>/dev/null || true
log() {
  printf '[%s] %s\\n' "\$(date '+%Y-%m-%d %H:%M:%S')" "\$*" >> "\$LOG_FILE" 2>/dev/null || true
}

NODE_CANDIDATES=(
  "$NODE_PATH"
  "/opt/homebrew/bin/node"
  "/usr/local/bin/node"
  "/usr/bin/node"
)

log "launcher start: HOST_SCRIPT=\$HOST_SCRIPT"

if [ ! -r "\$HOST_SCRIPT" ]; then
  log "host script is not readable or does not exist"
  exit 126
fi

for node_bin in "\${NODE_CANDIDATES[@]}"; do
  if [ -x "\$node_bin" ]; then
    log "using node: \$node_bin"
    "\$node_bin" "\$HOST_SCRIPT" 2>> "\$LOG_FILE"
    status=\$?
    log "node exited with status \$status"
    exit "\$status"
  fi
done

if command -v node >/dev/null 2>&1; then
  node_bin="\$(command -v node)"
  log "using node from PATH: \$node_bin"
  "\$node_bin" "\$HOST_SCRIPT" 2>> "\$LOG_FILE"
  status=\$?
  log "node exited with status \$status"
  exit "\$status"
fi

log "Node.js executable not found; please reinstall native_host/install.sh"
exit 127
EOF_LAUNCHER
chmod +x "$LAUNCHER_FILE"

# 创建清单文件
MANIFEST_FILE="$MANIFEST_DIR/codex_config_host.json"
cat > "$MANIFEST_FILE" << EOF_MANIFEST
{
  "name": "codex_config_host",
  "description": "CodexSwitch Config Sync Host",
  "path": "$LAUNCHER_FILE",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF_MANIFEST

echo ""
echo "=========================================="
echo "安装完成!"
echo "=========================================="
echo ""
echo "清单文件位置: $MANIFEST_FILE"
echo "Launcher 位置: $LAUNCHER_FILE"
echo "主机脚本位置: $HOST_SCRIPT"
echo "Node.js 路径: $NODE_PATH"
echo "日志文件: ~/.codex/codexswitch-native-host.log"
echo ""
echo "配置将写入:"
echo "  - ~/.codex/config.toml (name, base_url, model)"
echo "  - ~/.codex/auth.json (OPENAI_API_KEY)"
echo ""
echo "请重启 Chrome 浏览器使更改生效。"
