#!/bin/bash
# CodexSwitch Native Host 卸载脚本

set -e

echo "=========================================="
echo "CodexSwitch Native Host 卸载程序"
echo "=========================================="
echo ""

# 检测操作系统
if [[ "$OSTYPE" == "darwin"* ]]; then
    MANIFEST_FILE="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/codex_config_host.json"
    LAUNCHER_FILE="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/codex_config_host_launcher.sh"
    HOST_INSTALL_DIR="$HOME/Library/Application Support/CodexSwitchNativeHost"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    MANIFEST_FILE="$HOME/.config/google-chrome/NativeMessagingHosts/codex_config_host.json"
    LAUNCHER_FILE="$HOME/.config/google-chrome/NativeMessagingHosts/codex_config_host_launcher.sh"
    HOST_INSTALL_DIR="$HOME/.local/share/codexswitch-native-host"
else
    echo "错误: 不支持的操作系统 $OSTYPE"
    exit 1
fi

if [ -f "$MANIFEST_FILE" ]; then
    rm "$MANIFEST_FILE"
    echo "已删除清单文件: $MANIFEST_FILE"
else
    echo "清单文件不存在: $MANIFEST_FILE"
fi

if [ -f "$LAUNCHER_FILE" ]; then
    rm "$LAUNCHER_FILE"
    echo "已删除 launcher 文件: $LAUNCHER_FILE"
else
    echo "launcher 文件不存在: $LAUNCHER_FILE"
fi

if [ -d "$HOST_INSTALL_DIR" ]; then
    rm -rf "$HOST_INSTALL_DIR"
    echo "已删除 native host 安装目录: $HOST_INSTALL_DIR"
else
    echo "native host 安装目录不存在: $HOST_INSTALL_DIR"
fi

echo ""
echo "卸载完成!"
echo "请重启 Chrome 浏览器使更改生效。"
