'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { run } = require('../lib/sh');

test('run: 默认 maxBuffer 允许超过 1MB 的 stdout', () => {
  const r = run(process.execPath, ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.length, 2 * 1024 * 1024);
});

test('run: maxBuffer 可显式收紧', () => {
  assert.throws(() => run(process.execPath,
    ['-e', 'process.stdout.write("x".repeat(64 * 1024))'], { maxBuffer: 1024 }));
});
