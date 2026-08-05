#!/usr/bin/env sh
set -eu
node -e "const [major]=process.versions.node.split('.'); if (+major < 20) { console.error('需要 Node.js 20 或更高版本'); process.exit(1) }"
command -v restic >/dev/null || { echo '请先按 https://restic.net 安装 restic'; exit 1; }
command -v rclone >/dev/null || { echo '请先按 https://rclone.org 安装 rclone'; exit 1; }
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/agentsync"
chmod 700 "${XDG_CONFIG_HOME:-$HOME/.config}/agentsync" 2>/dev/null || true
echo '依赖检查完成。运行 ag-box sessions init <项目路径> 开始。'
