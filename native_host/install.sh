#!/bin/bash
# CodexSwitch Native Host 安装脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/codex_config_host.cjs"

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

# 确保原生主机脚本可直接执行（manifest 的 path 将直接指向它）
chmod +x "$HOST_SCRIPT"

# 检测操作系统
if [[ "$OSTYPE" == "darwin"* ]]; then
    MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
else
    echo "错误: 不支持的操作系统 $OSTYPE"
    exit 1
fi

# 创建目录
mkdir -p "$MANIFEST_DIR"

# 创建 launcher，避免 Chrome GUI 环境下 PATH 不包含 node
LAUNCHER_FILE="$MANIFEST_DIR/codex_config_host_launcher.sh"
cat > "$LAUNCHER_FILE" << EOF_LAUNCHER
#!/bin/bash
HOST_SCRIPT="$HOST_SCRIPT"

NODE_CANDIDATES=(
  "$NODE_PATH"
  "/opt/homebrew/bin/node"
  "/usr/local/bin/node"
  "/usr/bin/node"
)

for node_bin in "\${NODE_CANDIDATES[@]}"; do
  if [ -x "\$node_bin" ]; then
    exec "\$node_bin" "\$HOST_SCRIPT"
  fi
done

if command -v node >/dev/null 2>&1; then
  exec "\$(command -v node)" "\$HOST_SCRIPT"
fi

echo "[CodexSwitch] Node.js executable not found; please reinstall native_host/install.sh" >&2
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
echo ""
echo "配置将写入:"
echo "  - ~/.codex/config.toml (name, base_url, model)"
echo "  - ~/.codex/auth.json (OPENAI_API_KEY)"
echo ""
echo "请重启 Chrome 浏览器使更改生效。"
