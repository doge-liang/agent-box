'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { slugFor, buildBwrapArgs, isValidBoxName, boxPath, bashProfileContent } = require('../lib/mounts');

test('slugFor 把 / 和 . 换成 -', () => {
  assert.strictEqual(slugFor('/root/mobile-terminal-web'), '-root-mobile-terminal-web');
  assert.strictEqual(slugFor('/root/a.b'), '-root-a-b');
});

test('isValidBoxName: 字母数字/./_/- 合法', () => {
  assert.ok(isValidBoxName('demo'));
  assert.ok(isValidBoxName('box-01'));
  assert.ok(isValidBoxName('a.b_c-D9'));
});

test('isValidBoxName: 含空格非法', () => {
  assert.ok(!isValidBoxName('a b'));
  assert.ok(!isValidBoxName(' demo'));
});

test('isValidBoxName: 含 .. 非法(路径穿越)', () => {
  assert.ok(!isValidBoxName('a..b'));
  assert.ok(!isValidBoxName('../etc'));
});

test('isValidBoxName: 纯 .. 非法', () => {
  assert.ok(!isValidBoxName('..'));
});

const OPTS = {
  name: 'demo', projectPath: '/root/demo',
  boxHome: '/var/lib/box/demo/home', runDir: '/run/box/demo', nix: false,
};
// exists 注入:模拟宿主上存在哪些路径
const existsIn = (set) => (p) => set.has(p);

test('基础挂载:私有 HOME、项目 RW、系统 RO、私有 /tmp、PID 隔离', () => {
  const args = buildBwrapArgs(OPTS, existsIn(new Set(['/usr', '/etc', '/bin'])));
  const s = args.join(' ');
  assert.match(s, /--unshare-pid/);
  assert.match(s, /--tmpfs \/tmp/);
  assert.match(s, /--ro-bind \/usr \/usr/);
  assert.match(s, /--symlink usr\/bin \/bin/);          // merged-usr 重建符号链接
  assert.match(s, /--bind \/var\/lib\/box\/demo\/home \/root/);
  assert.match(s, /--bind \/root\/demo \/root\/demo/);
  assert.ok(!s.includes('--unshare-net'), '一期共享网络');
});

test('agent 状态:claude 项目 slug 精确 RW,全局配置 RO,凭证 RW', () => {
  const host = new Set(['/usr', '/etc', '/root/.claude/CLAUDE.md',
    '/root/.claude/settings.json', '/root/.claude/.credentials.json',
    '/root/.claude.json', '/root/.claude/projects/-root-demo', '/root/.codex']);
  const s = buildBwrapArgs(OPTS, existsIn(host)).join(' ');
  assert.match(s, /--ro-bind \/root\/\.claude\/CLAUDE\.md/);
  assert.match(s, /--bind \/root\/\.claude\/\.credentials\.json/);
  assert.match(s, /--bind \/root\/\.claude\/projects\/-root-demo/);
  assert.match(s, /--bind \/root\/\.codex \/root\/\.codex/);
  assert.ok(!s.includes('/root/.ssh'), '.ssh 不可见');
});

test('宿主缺失的路径不产生 bind(新机器上凭证可能还没有)', () => {
  const s = buildBwrapArgs(OPTS, existsIn(new Set(['/usr', '/etc']))).join(' ');
  assert.ok(!s.includes('.credentials.json'));
});

test('nix 盒:store RO + daemon socket RW + PATH 带 nix profile', () => {
  const host = new Set(['/usr', '/etc', '/nix']);
  const s = buildBwrapArgs({ ...OPTS, nix: true }, existsIn(host)).join(' ');
  assert.match(s, /--ro-bind \/nix \/nix/);
  assert.match(s, /--bind \/nix\/var\/nix\/daemon-socket \/nix\/var\/nix\/daemon-socket/);
  assert.match(s, /\/nix\/var\/nix\/profiles\/default\/bin/);
});

test('工具安装根:/.grok 与 /root/.bun 存在时 RO 绑入(修断链 grok/agent/bun)', () => {
  const host = new Set(['/usr', '/etc', '/.grok', '/root/.bun']);
  const s = buildBwrapArgs(OPTS, existsIn(host)).join(' ');
  assert.match(s, /--ro-bind \/\.grok \/\.grok/);
  assert.match(s, /--ro-bind \/root\/\.bun \/root\/\.bun/);
});

test('工具安装根缺失时不产生 bind(未装 grok/bun 的机器)', () => {
  const s = buildBwrapArgs(OPTS, existsIn(new Set(['/usr', '/etc']))).join(' ');
  assert.ok(!s.includes('/.grok'));
  assert.ok(!s.includes('/root/.bun'));
});

test('boxPath:非 nix 含 /root/.local/bin,nix 前置 nix profile', () => {
  assert.ok(boxPath(false).split(':').includes('/root/.local/bin'));
  assert.ok(!boxPath(false).includes('/nix/'));
  assert.ok(boxPath(true).startsWith('/nix/var/nix/profiles/default/bin:'));
  assert.ok(boxPath(true).split(':').includes('/root/.local/bin'));
});

test('bashProfileContent:导出正确 PATH 并回源 .bashrc(堵 attach PATH 泄漏)', () => {
  const p = bashProfileContent(false);
  assert.match(p, /export PATH="\/root\/\.local\/bin:/);       // 强制正确 PATH
  assert.match(p, /\.bashrc/);                                  // 保留交互配置
  assert.ok(bashProfileContent(true).includes('/nix/var/nix/profiles/default/bin'));
});

test('挂载顺序:私有 HOME bind 先于其内部子路径 bind(安全不变量)', () => {
  const host = new Set(['/usr', '/etc', '/root/.claude/CLAUDE.md',
    '/root/.claude/.credentials.json']);
  const args = buildBwrapArgs(OPTS, existsIn(host));
  const homeIdx = args.findIndex((a, i) =>
    a === '--bind' && args[i + 1] === '/var/lib/box/demo/home' && args[i + 2] === '/root');
  const subIdxs = args
    .map((a, i) => (typeof a === 'string' && a.startsWith('/root/.') ? i : -1))
    .filter((i) => i !== -1);
  assert.ok(homeIdx !== -1, '必须存在私有 HOME bind');
  assert.ok(subIdxs.length >= 2, '子路径 bind 应存在');
  for (const i of subIdxs) assert.ok(homeIdx < i, `子路径 bind(argv[${i}])必须在私有 HOME bind 之后`);
});
