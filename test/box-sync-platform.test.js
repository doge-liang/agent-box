'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { sessionPaths } = require('../lib/sync-config');

test('session config follows native platform application data roots', () => {
  assert.equal(sessionPaths({ platform: 'linux', home: '/home/a', env: {} }).configDir, '/home/a/.config/agentsync');
  assert.equal(sessionPaths({ platform: 'darwin', home: '/Users/a', env: {} }).configDir, '/Users/a/Library/Application Support/agentsync');
  assert.equal(sessionPaths({ platform: 'win32', home: 'C:\\Users\\a', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' } }).configDir, 'C:\\Users\\a\\AppData\\Roaming\\agentsync');
});
