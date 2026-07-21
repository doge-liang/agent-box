'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeSlug, readProjectId, ensureProjectId } = require('../lib/sync-identity');

test('claudeSlug: 所有非字母数字 → -(与 claude 实际规则一致,非 mounts.slugFor)', () => {
  assert.strictEqual(claudeSlug('/root/mobile-terminal-web'), '-root-mobile-terminal-web');
  assert.strictEqual(claudeSlug('/root/.claude/jobs/b42329e0/tmp'), '-root--claude-jobs-b42329e0-tmp');
  assert.strictEqual(claudeSlug('/root/my_proj'), '-root-my-proj');          // 下划线也替换
  assert.strictEqual(claudeSlug('C:\\Users\\x\\proj'), 'C--Users-x-proj');   // Windows 推断规则,spike 待验
});

test('readProjectId: 缺文件返回 null;损坏抛错;合法返回 id', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'si-'));
  assert.strictEqual(readProjectId(tmp), null);
  fs.writeFileSync(path.join(tmp, '.agentsync'), 'not json');
  assert.throws(() => readProjectId(tmp), /损坏/);
  fs.writeFileSync(path.join(tmp, '.agentsync'), JSON.stringify({ id: 'zzz' }));
  assert.throws(() => readProjectId(tmp), /损坏/);
  const id = '11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(tmp, '.agentsync'), JSON.stringify({ id }));
  assert.strictEqual(readProjectId(tmp), id);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('ensureProjectId: 无则建 uuid,有则复用', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'si-'));
  const first = ensureProjectId(tmp);
  assert.strictEqual(first.created, true);
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const again = ensureProjectId(tmp);
  assert.deepStrictEqual(again, { id: first.id, created: false });
  fs.rmSync(tmp, { recursive: true, force: true });
});
