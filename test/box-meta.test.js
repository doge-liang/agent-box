'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { interpretMetaCat, interpretListResult, writeMeta } = require('../lib/meta');

test('status 0 + 空 stdout: 判定为不存在(R2 真机回归)', () => {
  assert.strictEqual(interpretMetaCat({ status: 0, stdout: '', stderr: '' }), null);
});

test('status 0 + 空白 stdout(仅换行): 判定为不存在', () => {
  assert.strictEqual(interpretMetaCat({ status: 0, stdout: '\n', stderr: '' }), null);
});

test('status 0 + 合法 JSON: 保留字段并升级元数据', () => {
  const meta = { name: 'box-smoke', pin: null, leased_by: 'term1' };
  const r = interpretMetaCat({ status: 0, stdout: JSON.stringify(meta), stderr: '' });
  assert.equal(r.name, meta.name);
  assert.equal(r.pin, meta.pin);
  assert.equal(r.leased_by, meta.leased_by);
  assert.equal(r.schema_version, 2);
  assert.match(r.project_id, /^[0-9a-f-]{36}$/);
  assert.deepStrictEqual(r.local_paths, {});
});

test('writeMeta keeps local paths out of the R2 payload', (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-box-meta-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  let payload;
  writeMeta(
    { bucket: 'test', rcloneEnv: {}, paths: { configDir } },
    'box-smoke',
    {
      name: 'box-smoke', path: '/legacy/compatible', project_id: '8b728a5d-cc09-4937-936c-a2d339d88e14',
      local_paths: { laptop: '/work/private-project' },
    },
    (_command, _args, options) => { payload = options.input; },
  );
  assert.equal(payload.includes('local_paths'), false);
  assert.equal(payload.includes('/work/private-project'), false);
  assert.match(payload, /8b728a5d-cc09-4937-936c-a2d339d88e14/);
  assert.equal(
    fs.existsSync(path.join(configDir, 'projects', '8b728a5d-cc09-4937-936c-a2d339d88e14.json')),
    true,
  );
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(configDir, 'projects', '8b728a5d-cc09-4937-936c-a2d339d88e14.json'), 'utf8')),
    { local_paths: { laptop: '/work/private-project' } },
  );
});

test('status 0 + 非法 JSON: 抛出"内容非法"错误', () => {
  assert.throws(
    () => interpretMetaCat({ status: 0, stdout: '{bad', stderr: '' }),
    /内容非法/,
  );
});

test('status 3: 判定为不存在;status 1 + stderr: 抛出"读取 meta 失败"', () => {
  assert.strictEqual(interpretMetaCat({ status: 3, stdout: '', stderr: 'directory not found' }), null);
  assert.throws(
    () => interpretMetaCat({ status: 1, stdout: '', stderr: 'boom' }),
    /读取 meta 失败/,
  );
});

test('interpretListResult: status0+空输出→[](真空,而非 R2 不可达)', () => {
  assert.deepStrictEqual(interpretListResult({ status: 0, stdout: '', stderr: '' }), []);
});

test('interpretListResult: status0+多行 dirs 输出→去掉尾斜杠的名字数组', () => {
  assert.deepStrictEqual(
    interpretListResult({ status: 0, stdout: 'a/\nb/\n', stderr: '' }),
    ['a', 'b'],
  );
});

test('interpretListResult: status1+stderr → 抛出"列出沙盒失败"(不可吞成空列表)', () => {
  assert.throws(
    () => interpretListResult({ status: 1, stdout: '', stderr: 'boom' }),
    /列出沙盒失败/,
  );
});
