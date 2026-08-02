'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ResticProvider, HostedProvider } = require('../lib/providers');

const cfg = { resticEnv: { SECRET: 'secret-value' } };
const meta = { name: 'demo', path: '/work/demo' };

test('restic provider retains legacy tag and redacts environment', () => {
  const calls = []; const logs = [];
  const p = new ResticProvider(cfg, (cmd, args, opts) => calls.push({ cmd, args, opts }), (x) => logs.push(x));
  p.backup(meta, ['/work/demo']);
  assert.deepStrictEqual(calls[0].args.slice(0, 3), ['backup', '--tag', 'box:demo']);
  assert.strictEqual(calls[0].opts.env, cfg.resticEnv);
  assert.strictEqual(logs.join('').includes('secret-value'), false);
});

test('hosted provider is intentionally disabled', () => {
  assert.throws(() => new HostedProvider().backup(meta), /尚未启用/);
});
