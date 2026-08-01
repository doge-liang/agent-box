'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { configPaths, parseEnvFile, parseNodesFile } = require('../lib/env');

test('configPaths uses platform defaults and explicit file overrides', () => {
  assert.deepStrictEqual(configPaths({ platform: 'linux', home: '/home/a', env: {} }), {
    configDir: '/home/a/.config/ag-box', envPath: '/home/a/.config/ag-box/env', nodesPath: '/home/a/.config/ag-box/nodes',
  });
  assert.deepStrictEqual(configPaths({ platform: 'darwin', home: '/Users/a', env: {} }), {
    configDir: '/Users/a/Library/Application Support/ag-box', envPath: '/Users/a/Library/Application Support/ag-box/env', nodesPath: '/Users/a/Library/Application Support/ag-box/nodes',
  });
  assert.deepStrictEqual(configPaths({ platform: 'win32', home: 'C:\\Users\\a', env: { APPDATA: 'D:\\Roaming' } }), {
    configDir: 'D:\\Roaming\\ag-box', envPath: 'D:\\Roaming\\ag-box\\env', nodesPath: 'D:\\Roaming\\ag-box\\nodes',
  });
  assert.deepStrictEqual(configPaths({ platform: 'linux', home: '/home/a', env: { BOX_ENV: '/tmp/env', BOX_NODES: '/tmp/nodes' } }), {
    configDir: '/home/a/.config/ag-box', envPath: '/tmp/env', nodesPath: '/tmp/nodes',
  });
});

test('parseEnvFile 解析 KEY=VALUE,忽略注释与空行,值可含 =', () => {
  const out = parseEnvFile('# c\nA=1\n\nB=x=y\n BAD_LINE \n');
  assert.deepStrictEqual(out, { A: '1', B: 'x=y' });
});

test('parseNodesFile 解析 名字+主机 两列', () => {
  const out = parseNodesFile('# 注释\nterm1 local\nterm2 my-second-node\n');
  assert.deepStrictEqual(out, [
    { name: 'term1', host: 'local' },
    { name: 'term2', host: 'my-second-node' },
  ]);
});
