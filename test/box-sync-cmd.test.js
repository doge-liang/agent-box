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

function fakePullRclone({ origin, manifest, files, fixtures }) {
  const calls = { copy: [] };
  return {
    calls,
    remote: (rel) => `SESSCRYPT:${rel}`,
    rcatFile: () => {},
    lsDirs: () => [origin],
    catFile: (cfg, relPath) => relPath.endsWith('_manifest.json') ? JSON.stringify(manifest) : null,
    lsFiles: () => files,
    copyFiles: (cfg, src, dstDir, rels) => {
      if (!rels.length) return;              // 与真实实现一致:空列表零调用(否则二次 pull 的零下载断言失效)
      calls.copy.push({ src, dstDir, rels });
      for (const rel of rels) {
        const p = path.join(dstDir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, fixtures[rel].content);
        fs.utimesSync(p, new Date(fixtures[rel].mtimeMs), new Date(fixtures[rel].mtimeMs));
      }
    },
  };
}

test('pull: 落地他机会话(cwd 改写 + mtime 回写)、memory 冲突落 .conflict、state 更新、退出码 3', () => {
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
    fs.writeFileSync(path.join(slugDir, 'memory', 'MEMORY.md'), '# local edit\n'); // 本地已有且与远端不同,无基线 → 冲突
    const macRoot = '/Users/x/proj';
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sessionLine = JSON.stringify({ type: 'user', cwd: macRoot + '/sub', sessionId: uuid });
    const T = Date.parse('2026-07-19T00:00:00Z');
    const rcl = fakePullRclone({
      origin: 'mac-1111',
      manifest: { version: 1, root: macRoot, slug: 'x', sep: '/', platform: 'darwin' },
      files: [
        { rel: `${uuid}.jsonl`, size: sessionLine.length + 1, mtimeMs: T },
        { rel: 'memory/MEMORY.md', size: 9, mtimeMs: T },
        { rel: '_manifest.json', size: 5, mtimeMs: T },
      ],
      fixtures: {
        [`${uuid}.jsonl`]: { content: sessionLine + '\n', mtimeMs: T },
        'memory/MEMORY.md': { content: '# remote\n', mtimeMs: T },
      },
    });
    const logs = [];
    const code = cmd.pull(proj, { log: (m) => logs.push(m), rclone: rcl, cfg: FAKE_CFG, nowMs: () => T + 60 * 60 * 1000 });
    assert.strictEqual(code, 3);                                             // 有冲突
    const landed = fs.readFileSync(path.join(slugDir, `${uuid}.jsonl`), 'utf8');
    assert.strictEqual(JSON.parse(landed.trim()).cwd, path.join(proj, 'sub')); // cwd 前缀改写 + 分隔符转换
    assert.strictEqual(fs.statSync(path.join(slugDir, `${uuid}.jsonl`)).mtimeMs, T); // mtime 回写
    assert.strictEqual(fs.readFileSync(path.join(slugDir, 'memory', 'MEMORY.md'), 'utf8'), '# local edit\n'); // 本地不被覆盖
    assert.ok(fs.existsSync(path.join(slugDir, 'memory', 'MEMORY.mac-1111.conflict.md')));
    const state = cfgMod.readState(id);
    assert.ok(state.machines['mac-1111'][`${uuid}.jsonl`]);
    assert.strictEqual(state.landed[`${uuid}.jsonl`].origin, 'mac-1111');
    // 再次 pull:远端无变化 → 零下载、不重复落冲突
    const before = rcl.calls.copy.length;
    assert.strictEqual(cmd.pull(proj, { log: () => {}, rclone: rcl, cfg: FAKE_CFG, nowMs: () => T + 2 * 60 * 60 * 1000 }), 0);
    assert.strictEqual(rcl.calls.copy.length, before);
    assert.strictEqual(fs.readdirSync(path.join(slugDir, 'memory')).filter((f) => f.includes('conflict')).length, 1);
  });
});

test('pull: 活跃窗口内的本地文件跳过覆盖', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const { claudeSlug } = require('../lib/sync-identity');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    cmd.init(proj, { log: () => {} });
    const slugDir = path.join(process.env.AGENTSYNC_CLAUDE_DIR, claudeSlug(proj));
    fs.mkdirSync(slugDir, { recursive: true });
    const T = Date.parse('2026-07-19T00:00:00Z');
    fs.writeFileSync(path.join(slugDir, 'active.jsonl'), 'local\n');
    fs.utimesSync(path.join(slugDir, 'active.jsonl'), new Date(T), new Date(T));  // 本地 mtime = T(nowMs 附近 → 活跃)
    const rcl = fakePullRclone({
      origin: 'mB',
      manifest: { version: 1, root: '/other', sep: '/' },
      files: [{ rel: 'active.jsonl', size: 7, mtimeMs: T + 100000 }],
      fixtures: { 'active.jsonl': { content: 'remote\n', mtimeMs: T + 100000 } },
    });
    const logs = [];
    cmd.pull(proj, { log: (m) => logs.push(m), rclone: rcl, cfg: FAKE_CFG, nowMs: () => T + 1000 });
    assert.strictEqual(fs.readFileSync(path.join(slugDir, 'active.jsonl'), 'utf8'), 'local\n'); // 未覆盖
    assert.ok(logs.some((m) => m.includes('跳过')));
  });
});

test('pull: 嵌套 memory 子目录冲突文件路径正确、无重复 sub', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const cfgMod = require('../lib/sync-config');
    const { claudeSlug } = require('../lib/sync-identity');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    cmd.init(proj, { log: () => {} });
    const id = JSON.parse(fs.readFileSync(path.join(proj, '.agentsync'), 'utf8')).id;
    const slugDir = path.join(process.env.AGENTSYNC_CLAUDE_DIR, claudeSlug(proj));
    fs.mkdirSync(path.join(slugDir, 'memory', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(slugDir, 'memory', 'sub', 'foo.md'), '# local\n'); // 本地已有且与远端不同,无基线 → 冲突
    const macRoot = '/Users/x/proj';
    const T = Date.parse('2026-07-20T00:00:00Z');
    const rcl = fakePullRclone({
      origin: 'mB',
      manifest: { version: 1, root: macRoot, slug: 'x', sep: '/' },
      files: [
        { rel: 'memory/sub/foo.md', size: 9, mtimeMs: T },
      ],
      fixtures: {
        'memory/sub/foo.md': { content: '# remote\n', mtimeMs: T },
      },
    });
    const logs = [];
    const code = cmd.pull(proj, { log: (m) => logs.push(m), rclone: rcl, cfg: FAKE_CFG, nowMs: () => T + 60 * 60 * 1000 });
    assert.strictEqual(code, 3);                                             // 有冲突
    assert.strictEqual(fs.readFileSync(path.join(slugDir, 'memory', 'sub', 'foo.md'), 'utf8'), '# local\n'); // 本地不被覆盖
    // 检查冲突文件路径正确:应在 memory/sub/foo.mB.conflict.md,不在 memory/sub/sub/foo.mB.conflict.md
    const conflictPath = path.join(slugDir, 'memory', 'sub', 'foo.mB.conflict.md');
    assert.ok(fs.existsSync(conflictPath), `冲突文件必须存在于 ${conflictPath}`);
    assert.strictEqual(fs.readFileSync(conflictPath, 'utf8'), '# remote\n');
    const wrongPath = path.join(slugDir, 'memory', 'sub', 'sub', 'foo.mB.conflict.md');
    assert.ok(!fs.existsSync(wrongPath), `错误路径不应存在: ${wrongPath}`);
  });
});

test('pull: 远端清单越界路径段被拒(路径穿越防护),合法条目正常落地', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const { claudeSlug } = require('../lib/sync-identity');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    cmd.init(proj, { log: () => {} });
    const slugDir = path.join(process.env.AGENTSYNC_CLAUDE_DIR, claudeSlug(proj));
    const T = Date.parse('2026-07-20T00:00:00Z');
    const evilRel = '../../evil.jsonl';
    const rcl = fakePullRclone({
      origin: 'mB',
      manifest: { version: 1, root: '/other', sep: '/' },
      files: [
        { rel: evilRel, size: 5, mtimeMs: T },
        { rel: 'ok.jsonl', size: 3, mtimeMs: T },
      ],
      fixtures: {
        [evilRel]: { content: 'evil\n', mtimeMs: T },
        'ok.jsonl': { content: 'ok\n', mtimeMs: T },
      },
    });
    const logs = [];
    const code = cmd.pull(proj, { log: (m) => logs.push(m), rclone: rcl, cfg: FAKE_CFG, nowMs: () => T + 60 * 60 * 1000 });
    assert.strictEqual(code, 0);
    assert.strictEqual(fs.readFileSync(path.join(slugDir, 'ok.jsonl'), 'utf8'), 'ok\n');
    const escapeTarget = path.resolve(path.join(slugDir, '..', '..', 'evil.jsonl'));
    assert.ok(!fs.existsSync(escapeTarget), `逃逸目标不应存在: ${escapeTarget}`);
    assert.ok(logs.some((m) => m.includes('非法远端路径')), '应记录非法远端路径警告');
    // 恶意条目在规划前即被过滤,不应进入下载(fixture 也就从未被写入 cache)
    const downloadedRels = rcl.calls.copy.flatMap((c) => c.rels);
    assert.ok(!downloadedRels.includes(evilRel), '恶意 rel 不应进入下载计划');
  });
});

test('init: 项目路径变更时重置同步 state;同路径重复 init 不重置', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const cfgMod = require('../lib/sync-config');
    const projA = path.join(tmp, 'projA');
    fs.mkdirSync(projA);
    cmd.init(projA, { log: () => {} });
    const id = JSON.parse(fs.readFileSync(path.join(projA, '.agentsync'), 'utf8')).id;
    const nonEmptyState = {
      version: 1,
      machines: { m1: { 'x.jsonl': { size: 1, mtimeMs: 1 } } },
      landed: { 'x.jsonl': { origin: 'm1', remoteMtimeMs: 1, landedSize: 1, landedMtimeMs: 1 } },
      memory: {},
    };
    cfgMod.writeState(id, nonEmptyState);
    // 同路径重复 init:不应重置
    cmd.init(projA, { log: () => {} });
    assert.deepStrictEqual(cfgMod.readState(id), nonEmptyState);
    // 路径变更(同 id,不同目录):应重置为空 state
    const projB = path.join(tmp, 'projB');
    fs.mkdirSync(projB);
    fs.writeFileSync(path.join(projB, '.agentsync'), JSON.stringify({ id }));
    const logs = [];
    cmd.init(projB, { log: (m) => logs.push(m) });
    assert.deepStrictEqual(cfgMod.readState(id), { version: 1, machines: {}, landed: {}, memory: {} });
    assert.ok(logs.some((m) => m.includes('已重置该项目的同步状态')));
  });
});

test('sync: push 后 pull;pull 冲突码透传', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    cmd.init(proj, { log: () => {} });
    const order = [];
    const deps = {
      log: () => {}, cfg: FAKE_CFG,
      rclone: {
        remote: (rel) => `SESSCRYPT:${rel}`,
        rcatFile: () => order.push('push-manifest'),
        copyFiles: () => order.push('copy'),
        lsDirs: () => { order.push('pull-ls'); return []; },
        lsFiles: () => [], catFile: () => null,
      },
    };
    assert.strictEqual(cmd.sync(proj, deps), 0);
    assert.deepStrictEqual(order, ['push-manifest', 'copy', 'pull-ls']);
  });
});
