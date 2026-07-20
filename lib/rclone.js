'use strict';
// sessions 专用 rclone 封装:crypt(SESSCRYPT)套 s3/local 双层 remote,
// 全部经 RCLONE_CONFIG_* 环境变量注入,不读写 rclone.conf。
// crypt 的 PASSWORD 必须是 obscure 形式:明文注入报 base64 decode 错,
// 明文恰为合法 base64 时更会静默用错密钥 —— 故运行时经 stdin 现场 obscure,
// 绝不经 argv 传口令(/proc/*/cmdline 可见)。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./sh');

function obscure(plain, runner = run) {
  return runner('rclone', ['obscure', '-'], { input: plain }).stdout.trim();
}

function sessionEnv(cfg, runner = run) {
  const env = {
    RCLONE_CONFIG_SESSCRYPT_TYPE: 'crypt',
    RCLONE_CONFIG_SESSCRYPT_PASSWORD: obscure(cfg.cryptPassword, runner),
  };
  if (cfg.cryptPassword2) env.RCLONE_CONFIG_SESSCRYPT_PASSWORD2 = obscure(cfg.cryptPassword2, runner);
  if (cfg.backend === 'local') {
    env.RCLONE_CONFIG_SESSCRYPT_REMOTE = path.join(cfg.localRoot, 'sessions');
  } else {
    env.RCLONE_CONFIG_SESSR2_TYPE = 's3';
    env.RCLONE_CONFIG_SESSR2_PROVIDER = 'Cloudflare';
    env.RCLONE_CONFIG_SESSR2_ENDPOINT = cfg.endpoint;
    env.RCLONE_CONFIG_SESSR2_ACCESS_KEY_ID = cfg.accessKey;
    env.RCLONE_CONFIG_SESSR2_SECRET_ACCESS_KEY = cfg.secretKey;
    env.RCLONE_CONFIG_SESSR2_NO_CHECK_BUCKET = 'true';
    env.RCLONE_CONFIG_SESSCRYPT_REMOTE = `SESSR2:${cfg.bucket}/sessions`;
  }
  return env;
}

const remote = (rel) => `SESSCRYPT:${rel}`;

function rcloneError(op, r) {
  const tail = (r.stderr || '').trim().split('\n').pop() || `退出码 ${r.status}`;
  const e = new Error(`rclone ${op} 失败: ${tail}`);
  e.status = r.status;
  return e;
}

function lsDirs(cfg, relDir, runner = run) {
  const r = runner('rclone', ['lsf', '--dirs-only', remote(relDir)], { env: sessionEnv(cfg, runner), check: false });
  if (r.status !== 0) {
    if (/directory not found/i.test(r.stderr)) return [];
    throw rcloneError('lsf', r);
  }
  return r.stdout.split('\n').filter(Boolean).map((l) => l.replace(/\/$/, ''));
}

function lsFiles(cfg, relDir, runner = run) {
  const r = runner('rclone', ['lsjson', '-R', '--files-only', remote(relDir)], { env: sessionEnv(cfg, runner), check: false });
  if (r.status !== 0) {
    if (/directory not found/i.test(r.stderr)) return [];
    throw rcloneError('lsjson', r);
  }
  return JSON.parse(r.stdout || '[]').map((o) => ({ rel: o.Path, size: o.Size, mtimeMs: Date.parse(o.ModTime) }));
}

function copyFiles(cfg, src, dst, rels, runner = run) {
  if (!rels.length) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsync-'));
  const list = path.join(dir, 'files.txt');
  fs.writeFileSync(list, rels.join('\n') + '\n');
  try {
    runner('rclone', ['copy', src, dst, '--files-from', list], { env: sessionEnv(cfg, runner) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function catFile(cfg, relPath, runner = run) {
  const r = runner('rclone', ['cat', remote(relPath)], { env: sessionEnv(cfg, runner), check: false });
  return r.status === 0 && r.stdout ? r.stdout : null;
}

function rcatFile(cfg, relPath, content, runner = run) {
  runner('rclone', ['rcat', remote(relPath)], { env: sessionEnv(cfg, runner), input: content });
}

module.exports = { obscure, sessionEnv, remote, lsDirs, lsFiles, copyFiles, catFile, rcatFile };
