'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfgMod = require('../lib/sync-config');

function withTmpDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
  const prev = process.env.AGENTSYNC_DIR;
  process.env.AGENTSYNC_DIR = tmp;
  try { fn(tmp); } finally {
    if (prev === undefined) delete process.env.AGENTSYNC_DIR; else process.env.AGENTSYNC_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('loadSessionsConfig: 缺文件/缺键报错;s3 与 local 两种后端', () => {
  withTmpDir((tmp) => {
    assert.throws(() => cfgMod.loadSessionsConfig(), /缺少配置/);
    fs.writeFileSync(path.join(tmp, 'env'), 'SYNC_S3_ENDPOINT=https://x.r2.dev\n');
    assert.throws(() => cfgMod.loadSessionsConfig(), /配置缺少 SYNC_BUCKET/);
    fs.writeFileSync(path.join(tmp, 'env'), [
      'SYNC_S3_ENDPOINT=https://x.r2.dev', 'SYNC_BUCKET=agent-sessions',
      'AWS_ACCESS_KEY_ID=k', 'AWS_SECRET_ACCESS_KEY=s', 'SESSIONS_CRYPT_PASSWORD=pw',
    ].join('\n'));
    const cfg = cfgMod.loadSessionsConfig();
    assert.strictEqual(cfg.backend, 's3');
    assert.strictEqual(cfg.bucket, 'agent-sessions');
    assert.strictEqual(cfg.cryptPassword, 'pw');
    fs.writeFileSync(path.join(tmp, 'env'),
      'SYNC_BACKEND=local\nSYNC_LOCAL_ROOT=/tmp/store\nSESSIONS_CRYPT_PASSWORD=pw\n');
    assert.strictEqual(cfgMod.loadSessionsConfig().backend, 'local');
  });
});

test('machineId: 首次生成并持久化,再次读取同值', () => {
  withTmpDir(() => {
    const a = cfgMod.machineId();
    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.strictEqual(cfgMod.machineId(), a);
  });
});

test('projects/state: 读写往返;缺失时给空默认', () => {
  withTmpDir(() => {
    assert.deepStrictEqual(cfgMod.readProjects(), {});
    cfgMod.writeProjects({ u1: '/a/b' });
    assert.deepStrictEqual(cfgMod.readProjects(), { u1: '/a/b' });
    const empty = cfgMod.readState('u1');
    assert.deepStrictEqual(empty, { version: 1, machines: {}, landed: {}, memory: {} });
    empty.machines.m1 = { 'x.jsonl': { size: 1, mtimeMs: 2 } };
    cfgMod.writeState('u1', empty);
    assert.deepStrictEqual(cfgMod.readState('u1').machines.m1['x.jsonl'], { size: 1, mtimeMs: 2 });
  });
});
