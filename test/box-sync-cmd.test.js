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

function fakeRclone() {
  const calls = { rcat: [], copy: [] };
  return {
    calls,
    remote: (rel) => `SESSCRYPT:${rel}`,
    rcatFile: (cfg, relPath, content) => calls.rcat.push({ relPath, content }),
    copyFiles: (cfg, src, dst, rels) => calls.copy.push({ src, dst, rels }),
    lsDirs: () => [], lsFiles: () => [], catFile: () => null,
  };
}
const FAKE_CFG = { backend: 'local', localRoot: '/unused', cryptPassword: 'pw', cryptPassword2: '' };

test('push: 写 manifest + 增量上传;排除他机来源未续写与 conflict 文件', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const cfgMod = require('../lib/sync-config');
    const { claudeSlug } = require('../lib/sync-identity');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    cmd.init(proj, { log: () => {} });
    const id = JSON.parse(fs.readFileSync(path.join(proj, '.agentsync'), 'utf8')).id;
    const slugDir = path.join(process.env.AGENTSYNC_CLAUDE_DIR, claudeSlug(proj));
    fs.mkdirSync(path.join(slugDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(slugDir, 'mine.jsonl'), 'x'.repeat(10));
    fs.writeFileSync(path.join(slugDir, 'foreign.jsonl'), 'y'.repeat(50));
    fs.writeFileSync(path.join(slugDir, 'memory', 'a.mB.conflict.md'), 'z');
    // 预置 state:foreign.jsonl 为他机来源且与落地记录一致(回声必须被抑制)
    const st = fs.statSync(path.join(slugDir, 'foreign.jsonl'));
    const state = cfgMod.readState(id);
    state.landed['foreign.jsonl'] = { origin: 'mB', remoteMtimeMs: 1, landedSize: st.size, landedMtimeMs: st.mtimeMs };
    cfgMod.writeState(id, state);
    const rcl = fakeRclone();
    assert.strictEqual(cmd.push(proj, { log: () => {}, rclone: rcl, cfg: FAKE_CFG }), 0);
    const mid = cfgMod.machineId();
    assert.strictEqual(rcl.calls.rcat.length, 1);
    assert.strictEqual(rcl.calls.rcat[0].relPath, `${id}/claude/${mid}/_manifest.json`);
    const manifest = JSON.parse(rcl.calls.rcat[0].content);
    assert.strictEqual(manifest.root, proj);
    assert.strictEqual(manifest.sep, path.sep);
    assert.deepStrictEqual(rcl.calls.copy[0].rels, ['mine.jsonl']);   // 只传本机原创
    assert.strictEqual(rcl.calls.copy[0].dst, `SESSCRYPT:${id}/claude/${mid}`);
  });
});

test('push: 未 init 报错', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const proj = path.join(tmp, 'raw');
    fs.mkdirSync(proj);
    assert.throws(() => cmd.push(proj, { log: () => {}, rclone: fakeRclone(), cfg: FAKE_CFG }), /先执行 ag-box sessions init/);
  });
});
