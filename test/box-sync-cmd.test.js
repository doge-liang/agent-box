'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withEnv(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-'));
  const saved = { AGENTSYNC_DIR: process.env.AGENTSYNC_DIR, AGENTSYNC_CLAUDE_DIR: process.env.AGENTSYNC_CLAUDE_DIR };
  process.env.AGENTSYNC_DIR = path.join(tmp, 'cfg');
  process.env.AGENTSYNC_CLAUDE_DIR = path.join(tmp, 'claude');
  fs.mkdirSync(process.env.AGENTSYNC_DIR, { recursive: true });
  try { fn(tmp); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('init: 建 .agentsync + 登记映射;重复 init 复用;git 带来的 .agentsync 直接采纳', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const cfgMod = require('../lib/sync-config');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    const logs = [];
    assert.strictEqual(cmd.init(proj, { log: (m) => logs.push(m) }), 0);
    const marker = JSON.parse(fs.readFileSync(path.join(proj, '.agentsync'), 'utf8'));
    assert.deepStrictEqual(cfgMod.readProjects(), { [marker.id]: proj });
    cmd.init(proj, { log: (m) => logs.push(m) });                       // 幂等
    assert.deepStrictEqual(Object.keys(cfgMod.readProjects()), [marker.id]);
    const proj2 = path.join(tmp, 'proj2');
    fs.mkdirSync(proj2);
    fs.writeFileSync(path.join(proj2, '.agentsync'),
      JSON.stringify({ id: '99999999-8888-7777-6666-555555555555' }));  // 模拟随 git 到位
    cmd.init(proj2, { log: (m) => logs.push(m) });
    assert.strictEqual(cfgMod.readProjects()['99999999-8888-7777-6666-555555555555'], proj2);
  });
});

test('init: 目录不存在报错;slug 碰撞警告', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    assert.throws(() => cmd.init(path.join(tmp, 'nope'), { log: () => {} }), /目录不存在/);
    const a = path.join(tmp, 'x.y');
    const b = path.join(tmp, 'x-y');   // claudeSlug 相同(有损碰撞)
    fs.mkdirSync(a); fs.mkdirSync(b);
    const logs = [];
    cmd.init(a, { log: (m) => logs.push(m) });
    cmd.init(b, { log: (m) => logs.push(m) });
    assert.ok(logs.some((m) => m.includes('slug 相同')));
  });
});

test('list: 空提示;有项目则列出 uuid+路径+冲突数', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const { claudeSlug } = require('../lib/sync-identity');
    let logs = [];
    cmd.list({ log: (m) => logs.push(m) });
    assert.ok(logs[0].includes('尚无同步项目'));
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    cmd.init(proj, { log: () => {} });
    const memDir = path.join(process.env.AGENTSYNC_CLAUDE_DIR, claudeSlug(proj), 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'a.mB.conflict.md'), 'x');
    logs = [];
    cmd.list({ log: (m) => logs.push(m) });
    assert.ok(logs.some((m) => m.includes(proj) && m.includes('1 个 memory 冲突')));
  });
});
