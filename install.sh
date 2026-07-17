#!/usr/bin/env bash
# ag-box 安装器:默认装本机;--to <ssh-host> 推送到远程节点并在远端执行
# 命令名为 ag-box;内部目录 /opt/box、/etc/box、/var/lib/box、/run/box 沿用 box 前缀(与已部署状态一致)
set -euo pipefail

if [ "${1:-}" = "--to" ]; then
  host="${2:?用法: install.sh --to <ssh-host>}"
  src="$(cd "$(dirname "$0")" && pwd)"
  tar czf - -C "$src" --exclude=.git --exclude=test . | ssh "$host" 'rm -rf /tmp/agent-box-dist && mkdir -p /tmp/agent-box-dist && tar xzf - -C /tmp/agent-box-dist'
  ssh "$host" 'bash /tmp/agent-box-dist/install.sh && rm -rf /tmp/agent-box-dist'
  exit 0
fi

src="$(cd "$(dirname "$0")" && pwd)"
mkdir -p /opt/box /etc/box /run/box /var/lib/box
cp -r "$src/bin" "$src/lib" "$src/exclude.txt" "$src/env.example" "$src/nodes.example" /opt/box/
chmod +x /opt/box/bin/ag-box
ln -sf /opt/box/bin/ag-box /usr/local/bin/ag-box
rm -f /usr/local/bin/box /opt/box/bin/box   # 清理旧命令名(已更名 ag-box)
cp "$src/tmux-inner.conf" /etc/box/tmux-inner.conf
[ -d "$src/base-flake" ] && mkdir -p /etc/box/base-flake && cp "$src"/base-flake/flake.* /etc/box/base-flake/
[ -d "$src/systemd" ] && cp "$src"/systemd/*.service "$src"/systemd/*.timer /etc/systemd/system/ && systemctl daemon-reload
printf 'dev.tty.legacy_tiocsti=0\n' > /etc/sysctl.d/90-box.conf
sysctl -p /etc/sysctl.d/90-box.conf >/dev/null

missing=""
for dep in bwrap restic rclone node tmux; do
  command -v "$dep" >/dev/null || missing="$missing $dep"
done
if [ -n "$missing" ]; then
  echo "缺依赖:$missing" >&2
  echo "  apt-get install -y bubblewrap restic; rclone: curl https://rclone.org/install.sh | bash" >&2
  exit 1
fi
echo "ag-box 安装完成: $(ag-box --help | head -1)"
[ -f /root/.config/box/env ] || echo "提醒: 还需创建 /root/.config/box/env(模板 /opt/box/env.example)"
