'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { projectId, upgradeMeta } = require('../lib/project');
const { newMeta, interpretMetaCat } = require('../lib/meta');

test('projectId creates UUID project identities', () => {
  assert.match(projectId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('upgradeMeta retains legacy name, path and restic fields', () => {
  const meta = upgradeMeta({ name: 'a', path: '/root/a', last_snapshot: 'x' });
  assert.equal(meta.name, 'a');
  assert.equal(meta.path, '/root/a');
  assert.equal(meta.last_snapshot, 'x');
  assert.equal(meta.schema_version, 2);
  assert.deepEqual(meta.local_paths, {});
  assert.match(meta.project_id, /^[0-9a-f-]{36}$/);
});

test('upgradeMeta preserves an existing project identity and local mappings', () => {
  const meta = upgradeMeta({ project_id: '8b728a5d-cc09-4937-936c-a2d339d88e14', local_paths: { laptop: '/work/a' } });
  assert.equal(meta.project_id, '8b728a5d-cc09-4937-936c-a2d339d88e14');
  assert.deepEqual(meta.local_paths, { laptop: '/work/a' });
});

test('new and legacy remote metadata are upgraded to logical project identities', () => {
  const created = newMeta({ name: 'a', path: '/root/a', node: 'node-a' });
  assert.equal(created.schema_version, 2);
  assert.match(created.project_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(created.local_paths, {});

  const legacy = interpretMetaCat({
    status: 0,
    stdout: JSON.stringify({ name: 'a', path: '/root/a', last_snapshot: 'x' }),
    stderr: '',
  });
  assert.equal(legacy.schema_version, 2);
  assert.match(legacy.project_id, /^[0-9a-f-]{36}$/);
});
