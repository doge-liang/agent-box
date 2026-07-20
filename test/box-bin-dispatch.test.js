'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'ag-box');

function runBin(cliArgs, envExtra) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...cliArgs],
      { encoding: 'utf8', env: { ...process.env, ...envExtra } });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

test('sessions 不要求盒配置;盒命令仍要求', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-'));
  const env = {
    BOX_ENV: path.join(tmp, 'no-such-box-env'),          // 盒配置缺失
    AGENTSYNC_DIR: path.join(tmp, 'agentsync'),
    AGENTSYNC_CLAUDE_DIR: path.join(tmp, 'claude'),
  };
  fs.mkdirSync(env.AGENTSYNC_DIR, { recursive: true });
  const s = runBin(['sessions', 'list'], env);
  assert.strictEqual(s.status, 0);                        // sessions 可用
  assert.ok(s.stdout.includes('尚无同步项目'));
  const box = runBin(['ls'], env);
  assert.notStrictEqual(box.status, 0);                   // 盒命令行为不变:仍报缺配置
  const usage = runBin(['sessions', 'bogus'], env);
  assert.notStrictEqual(usage.status, 0);
  assert.ok(usage.stderr.includes('用法: ag-box sessions'));
  fs.rmSync(tmp, { recursive: true, force: true });
});
