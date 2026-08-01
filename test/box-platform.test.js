'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { platformPaths } = require('../lib/platform');

test('platform paths use XDG, macOS and Windows app-data roots', () => {
  assert.equal(platformPaths('linux', '/home/a').configDir, '/home/a/.config/ag-box');
  assert.equal(platformPaths('darwin', '/Users/a').configDir, '/Users/a/Library/Application Support/ag-box');
  assert.equal(platformPaths('win32', 'C:\\Users\\a').configDir, 'C:\\Users\\a\\AppData\\Roaming\\ag-box');
});

test('platform paths honor injected XDG and APPDATA overrides', () => {
  assert.equal(
    platformPaths('linux', '/home/a', { XDG_CONFIG_HOME: '/var/config' }).configDir,
    '/var/config/ag-box',
  );
  assert.equal(
    platformPaths('win32', 'C:\\Users\\a', { APPDATA: 'D:\\Roaming' }).configDir,
    'D:\\Roaming\\ag-box',
  );
});
