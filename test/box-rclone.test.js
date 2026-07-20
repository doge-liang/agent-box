'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const rcl = require('../lib/rclone');

// mock runner:记录调用,按 cmd/args 返回预置结果
function mockRunner(replies) {
  const calls = [];
  const fn = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    for (const [match, result] of replies) if (args.includes(match)) return result;
    return { status: 0, stdout: '', stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

const S3CFG = { backend: 's3', endpoint: 'https://x.r2.dev', bucket: 'agent-sessions',
  cryptPassword: 'pw', cryptPassword2: '', accessKey: 'k', secretKey: 's', localRoot: '' };

test('obscure: 经 stdin 传口令,绝不经 argv', () => {
  const r = mockRunner([['obscure', { status: 0, stdout: 'OBS\n', stderr: '' }]]);
  assert.strictEqual(rcl.obscure('pw', r), 'OBS');
  assert.deepStrictEqual(r.calls[0].args, ['obscure', '-']);
  assert.strictEqual(r.calls[0].opts.input, 'pw');
  assert.ok(!r.calls[0].args.includes('pw'));
});

test('sessionEnv: s3 后端组装双层 remote;口令为 obscure 形式', () => {
  const r = mockRunner([['obscure', { status: 0, stdout: 'OBS\n', stderr: '' }]]);
  const env = rcl.sessionEnv(S3CFG, r);
  assert.strictEqual(env.RCLONE_CONFIG_SESSR2_TYPE, 's3');
  assert.strictEqual(env.RCLONE_CONFIG_SESSR2_PROVIDER, 'Cloudflare');
  assert.strictEqual(env.RCLONE_CONFIG_SESSCRYPT_TYPE, 'crypt');
  assert.strictEqual(env.RCLONE_CONFIG_SESSCRYPT_REMOTE, 'SESSR2:agent-sessions/sessions');
  assert.strictEqual(env.RCLONE_CONFIG_SESSCRYPT_PASSWORD, 'OBS');
  assert.strictEqual(env.RCLONE_CONFIG_SESSCRYPT_PASSWORD2, undefined);  // 未配盐则不注入
});

test('sessionEnv: local 后端 REMOTE 指向本地目录(无 s3 层)', () => {
  const r = mockRunner([['obscure', { status: 0, stdout: 'OBS\n', stderr: '' }]]);
  const env = rcl.sessionEnv({ ...S3CFG, backend: 'local', localRoot: '/tmp/store' }, r);
  assert.strictEqual(env.RCLONE_CONFIG_SESSR2_TYPE, undefined);
  assert.ok(env.RCLONE_CONFIG_SESSCRYPT_REMOTE.endsWith('sessions'));
});

test('lsFiles: 解析 lsjson;directory not found → [];其他错误抛出', () => {
  const ok = mockRunner([
    ['obscure', { status: 0, stdout: 'OBS\n', stderr: '' }],
    ['lsjson', { status: 0, stdout: JSON.stringify([
      { Path: 'a.jsonl', Size: 10, ModTime: '2026-07-19T00:00:00Z', IsDir: false }]), stderr: '' }],
  ]);
  assert.deepStrictEqual(rcl.lsFiles(S3CFG, 'u1/claude/m1', ok),
    [{ rel: 'a.jsonl', size: 10, mtimeMs: Date.parse('2026-07-19T00:00:00Z') }]);
  const missing = mockRunner([
    ['obscure', { status: 0, stdout: 'OBS\n', stderr: '' }],
    ['lsjson', { status: 3, stdout: '', stderr: 'error: directory not found' }],
  ]);
  assert.deepStrictEqual(rcl.lsFiles(S3CFG, 'u1/claude/m1', missing), []);
  const broken = mockRunner([
    ['obscure', { status: 0, stdout: 'OBS\n', stderr: '' }],
    ['lsjson', { status: 1, stdout: '', stderr: 'connection refused' }],
  ]);
  assert.throws(() => rcl.lsFiles(S3CFG, 'u1/claude/m1', broken), /connection refused/);
});

test('copyFiles: --files-from 列表文件包含全部 rel;空列表不调用 rclone', () => {
  const r = mockRunner([['obscure', { status: 0, stdout: 'OBS\n', stderr: '' }]]);
  let captured = null;
  const capturing = (cmd, args, opts) => {
    if (args[0] === 'copy') captured = fs.readFileSync(args[args.indexOf('--files-from') + 1], 'utf8');
    return r(cmd, args, opts);
  };
  capturing.calls = r.calls;
  rcl.copyFiles(S3CFG, '/src', 'SESSCRYPT:u1/claude/m1', ['a.jsonl', 'memory/x.md'], capturing);
  assert.strictEqual(captured, 'a.jsonl\nmemory/x.md\n');
  const before = r.calls.length;
  rcl.copyFiles(S3CFG, '/src', 'SESSCRYPT:u1/claude/m1', [], capturing);
  assert.strictEqual(r.calls.length, before);  // 空列表零调用
});
