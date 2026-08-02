'use strict';
const test = require('node:test'); const assert = require('node:assert'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { adapterById, collectSessions } = require('../lib/adapters');
test('adapters only collect project-associated directories', () => { const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'box-a-')); const root = path.join(tmp, 'pi'); const hit = path.join(root, encodeURIComponent('/work/demo')); fs.mkdirSync(hit, { recursive: true }); const r = adapterById('pi').collect('/work/demo', { pi: root }); assert.deepStrictEqual(r.files, [hit]); fs.rmSync(tmp, { recursive: true, force: true }); });
test('all supported adapters expose display-only resume hints', () => { for (const id of ['claude','codex','grok','opencode','pi','oh-my-pi']) { const hint = adapterById(id).resumeHint({ id: 'abc' }); assert.match(hint, /abc/); assert.equal(hint.includes('token'), false); } });
test('adapter collection never returns credential paths', () => { const rows = collectSessions('/work/demo', undefined, {}); assert.equal(rows.flatMap((r) => r.files).some((p) => /credential|auth/i.test(p)), false); });
