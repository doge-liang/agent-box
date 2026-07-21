'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { rewriteCwd, mapPath } = require('../lib/session-rewrite');

test('mapPath: 前缀命中才替换;子目录保留;非命中/非字符串返回 null', () => {
  assert.strictEqual(mapPath('/a/p', '/a/p', '/b/q', '/', '/'), '/b/q');
  assert.strictEqual(mapPath('/a/p/sub', '/a/p', '/b/q', '/', '/'), '/b/q/sub');
  assert.strictEqual(mapPath('/a/pp', '/a/p', '/b/q', '/', '/'), null);   // /a/pp 不是 /a/p 的子路径
  assert.strictEqual(mapPath('/other', '/a/p', '/b/q', '/', '/'), null);
  assert.strictEqual(mapPath(undefined, '/a/p', '/b/q', '/', '/'), null);
});

test('mapPath: 跨平台分隔符转换(win → linux 与反向)', () => {
  assert.strictEqual(mapPath('C:\\U\\p\\sub\\d', 'C:\\U\\p', '/root/p', '\\', '/'), '/root/p/sub/d');
  assert.strictEqual(mapPath('/root/p/sub', '/root/p', 'C:\\U\\p', '/', '\\'), 'C:\\U\\p\\sub');
});

test('rewriteCwd: 只重写含 cwd 且命中的行;控制行/非 JSON 行/未命中行字节原样', () => {
  const lines = [
    JSON.stringify({ type: 'user', cwd: '/a/p', sessionId: 's1', gitBranch: 'main' }),
    JSON.stringify({ type: 'assistant', cwd: '/a/p/sub', sessionId: 's1' }),
    '{"type":"mode","mode":"default"}',                       // 无 cwd 控制行
    'not json at all',                                        // 非 JSON 行容错
    JSON.stringify({ type: 'system', cwd: '/elsewhere' }),    // cwd 未命中
    '',                                                       // 空行
  ];
  const out = rewriteCwd(lines.join('\n'), '/a/p', '/b/q').split('\n');
  assert.strictEqual(JSON.parse(out[0]).cwd, '/b/q');
  assert.strictEqual(JSON.parse(out[0]).gitBranch, 'main');   // 其余字段不动
  assert.strictEqual(JSON.parse(out[1]).cwd, '/b/q/sub');
  assert.strictEqual(out[2], lines[2]);                       // 字节原样
  assert.strictEqual(out[3], lines[3]);
  assert.strictEqual(out[4], lines[4]);
  assert.strictEqual(out[5], '');
});

test('rewriteCwd: cwd 出现在字符串值里但记录无顶层 cwd 字段 → 原样', () => {
  const line = JSON.stringify({ type: 'user', message: 'set "cwd" please' });
  assert.strictEqual(rewriteCwd(line, '/a', '/b'), line);
});
