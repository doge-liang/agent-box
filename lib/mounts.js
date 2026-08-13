'use strict';
const fs = require('fs');

const USR_SYMLINKS = ['bin', 'sbin', 'lib', 'lib64']; // Ubuntu merged-usr:根下是指向 usr/ 的符号链接
const BASE_PATH = '/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const NIX_PATH = '/nix/var/nix/profiles/default/bin:' + BASE_PATH;

function slugFor(projectPath) {
  return projectPath.replace(/[/.]/g, '-');
}

// 沙盒名合法性:仅字母数字/./_/-,且不含 `..`——防止路径穿越
// (rclone purge boxes/<name>、systemd unit 名 boxrun-<name>、盒目录路径都直接拼接 name)
function isValidBoxName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..');
}

// 生成 bwrap argv(纯函数,exists 可注入以便单测)。策略见 spec「沙盒运行时模型」。
function buildBwrapArgs(opts, exists = fs.existsSync) {
  const { name, projectPath, boxHome, runDir, nix } = opts;
  const args = [
    '--die-with-parent', '--unshare-pid', '--unshare-uts', '--hostname', `box-${name}`,
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
  ];
  for (const p of ['/usr', '/etc']) if (exists(p)) args.push('--ro-bind', p, p);
  for (const l of USR_SYMLINKS) if (exists(`/${l}`)) args.push('--symlink', `usr/${l}`, `/${l}`);
  args.push('--bind', boxHome, '/root');
  args.push('--bind', projectPath, projectPath);
  args.push('--bind', runDir, runDir);
  // 全局 agent 配置 RO;凭证与本盒状态 RW;codex/grok 状态池一期整挂 RW(见 spec 挂载策略)
  const roHome = [
    '/root/.claude/CLAUDE.md', '/root/.claude/settings.json', '/root/.claude/output-styles',
    '/root/.claude/skills', '/root/.claude/plugins',
    '/root/.gitconfig', '/root/.config/gh', '/root/.local',
    // 工具安装根:grok/agent 装在顶层 /.grok、bun 装在 /root/.bun,其 /usr/local/bin
    // 符号链接指向这些路径;不绑则盒内断链(command not found)。只读绑二进制目录。
    '/.grok', '/root/.bun',
  ];
  const rwHome = [
    '/root/.claude/.credentials.json', '/root/.claude.json',
    `/root/.claude/projects/${slugFor(projectPath)}`,
    '/root/.codex', '/root/.grok',
  ];
  for (const p of roHome) if (exists(p)) args.push('--ro-bind', p, p);
  for (const p of rwHome) if (exists(p)) args.push('--bind', p, p);
  if (nix && exists('/nix')) {
    args.push('--ro-bind', '/nix', '/nix');
    args.push('--bind', '/nix/var/nix/daemon-socket', '/nix/var/nix/daemon-socket');
  }
  args.push('--setenv', 'HOME', '/root', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'PATH', nix ? NIX_PATH : BASE_PATH, '--chdir', projectPath);
  return args;
}

// 盒内 PATH(bwrap --setenv 与 boxHome/.bash_profile 共用同一真相源)
function boxPath(nix) {
  return nix ? NIX_PATH : BASE_PATH;
}

// boxHome/.bash_profile 内容:强制盒内交互登录 shell 用正确 PATH。
// 根因:宿主侧 attach 客户端(面板 spawnTmux / ag-box attach)跑 tmux new-session 时,
// 首个会话 pane 会继承宿主客户端 PATH(缺 /root/.local/bin 等),而非盒 tmux 全局 env。
// 写死于登录 shell 必源的 .bash_profile,与进盒方式无关。
function bashProfileContent(nix) {
  return '# agent-box:强制盒内正确 PATH(startSandbox 每次覆写,勿手改)\n'
    + `export PATH="${boxPath(nix)}"\n`
    + '[ -f ~/.bashrc ] && . ~/.bashrc\n';
}

module.exports = { slugFor, buildBwrapArgs, isValidBoxName, boxPath, bashProfileContent };
