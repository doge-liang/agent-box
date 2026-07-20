'use strict';
// 端到端:同一台机器上用 AGENTSYNC_DIR/AGENTSYNC_CLAUDE_DIR 模拟 A/B 两台机器,
// SYNC_BACKEND=local 用本地目录代替 R2(crypt 层照常加密)。需要 rclone 二进制。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { claudeSlug } = require('../lib/sync-identity');

let hasRclone = true;
try { execFileSync('rclone', ['version'], { stdio: 'ignore' }); } catch { hasRclone = false; }

const BIN = path.join(__dirname, '..', 'bin', 'ag-box');

function countStoreObjects(store) {
  let n = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(path.join(d, ent.name)); else n++;
    }
  };
  walk(store);
  return n;
}

test('sessions 双机端到端', { skip: !hasRclone && 'rclone 不可用' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-e2e-'));
  const store = path.join(tmp, 'store');
  const mkMachine = (name) => {
    const dir = path.join(tmp, name);
    const cfgDir = path.join(dir, 'agentsync');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'env'),
      `SYNC_BACKEND=local\nSYNC_LOCAL_ROOT=${store}\nSESSIONS_CRYPT_PASSWORD=e2e-secret\n`);
    return {
      proj: path.join(dir, 'proj'),
      claude: path.join(dir, 'claude-projects'),
      env: {
        ...process.env,
        AGENTSYNC_DIR: cfgDir,
        AGENTSYNC_CLAUDE_DIR: path.join(dir, 'claude-projects'),
        AGENTSYNC_ACTIVE_WINDOW_MS: '0',                 // e2e 文件都是刚写的,关闭活跃窗口
        BOX_ENV: path.join(dir, 'no-box-env'),           // 证明不需要盒配置
      },
    };
  };
  const ag = (m, ...cliArgs) => {
    try {
      return { status: 0, out: execFileSync(process.execPath, [BIN, 'sessions', ...cliArgs], { env: m.env, cwd: m.proj, encoding: 'utf8' }) };
    } catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
  };
  const A = mkMachine('A'), B = mkMachine('B');
  fs.mkdirSync(A.proj, { recursive: true }); fs.mkdirSync(B.proj, { recursive: true });

  // init 两机;.agentsync 随"git"到 B
  assert.strictEqual(ag(A, 'init').status, 0);
  fs.copyFileSync(path.join(A.proj, '.agentsync'), path.join(B.proj, '.agentsync'));
  assert.strictEqual(ag(B, 'init').status, 0);

  // A 机造会话 + memory
  const aSlug = path.join(A.claude, claudeSlug(A.proj));
  fs.mkdirSync(path.join(aSlug, 'memory'), { recursive: true });
  const uuid = '11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(aSlug, `${uuid}.jsonl`),
    JSON.stringify({ type: 'user', cwd: A.proj, sessionId: uuid }) + '\n' + '{"type":"mode","mode":"x"}\n');
  // 回拨 A 会话文件 mtime:后续"B 续写 → A pull 最后写胜"的判定带 2.5s 容差,
  // 测试全程在数秒内跑完,不回拨会导致远端不比本地"新",落地被误跳过。
  const OLD = Date.now() - 3600 * 1000;
  fs.utimesSync(path.join(aSlug, `${uuid}.jsonl`), new Date(OLD), new Date(OLD));
  fs.writeFileSync(path.join(aSlug, 'memory', 'MEMORY.md'), '# from A\n');
  assert.strictEqual(ag(A, 'push').status, 0);
  assert.ok(countStoreObjects(store) >= 3);              // manifest + 会话 + memory(密文对象)

  // B pull:落地 + cwd 改写 + 控制行原样
  assert.strictEqual(ag(B, 'pull').status, 0);
  const bSlug = path.join(B.claude, claudeSlug(B.proj));
  const landed = fs.readFileSync(path.join(bSlug, `${uuid}.jsonl`), 'utf8');
  assert.strictEqual(JSON.parse(landed.split('\n')[0]).cwd, B.proj);
  assert.strictEqual(landed.split('\n')[1], '{"type":"mode","mode":"x"}');
  assert.strictEqual(fs.readFileSync(path.join(bSlug, 'memory', 'MEMORY.md'), 'utf8'), '# from A\n');

  // 回声抑制:B push 不应把 A 的会话再传进 B 命名空间(对象数只多 B 的 manifest)
  const before = countStoreObjects(store);
  assert.strictEqual(ag(B, 'push').status, 0);
  assert.strictEqual(countStoreObjects(store), before + 1);

  // B 续写 → push;A pull 拿到续写(双向)
  fs.appendFileSync(path.join(bSlug, `${uuid}.jsonl`),
    JSON.stringify({ type: 'assistant', cwd: B.proj, sessionId: uuid }) + '\n');
  assert.strictEqual(ag(B, 'push').status, 0);
  assert.strictEqual(ag(A, 'pull').status, 0);
  const back = fs.readFileSync(path.join(aSlug, `${uuid}.jsonl`), 'utf8').trim().split('\n');
  assert.strictEqual(back.length, 3);
  assert.strictEqual(JSON.parse(back[2]).cwd, A.proj);   // B 的续写行 cwd 已改回 A 路径

  // memory 双改 → 冲突:退出码 3、本地不覆盖、.conflict 落盘
  fs.writeFileSync(path.join(aSlug, 'memory', 'MEMORY.md'), '# from A v2\n');
  fs.writeFileSync(path.join(bSlug, 'memory', 'MEMORY.md'), '# from B v2\n');
  assert.strictEqual(ag(A, 'push').status, 0);
  const r = ag(B, 'pull');
  assert.strictEqual(r.status, 3);
  assert.strictEqual(fs.readFileSync(path.join(bSlug, 'memory', 'MEMORY.md'), 'utf8'), '# from B v2\n');
  assert.strictEqual(fs.readdirSync(path.join(bSlug, 'memory')).filter((f) => f.endsWith('.conflict.md')).length, 1);

  // 加密可见性:store 里不应出现明文文件名
  const names = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); names.push(e.name); if (e.isDirectory()) walk(p); } };
  walk(store);
  assert.ok(!names.some((n) => n.includes(uuid) || n.includes('MEMORY') || n === '_manifest.json'));

  fs.rmSync(tmp, { recursive: true, force: true });
});
