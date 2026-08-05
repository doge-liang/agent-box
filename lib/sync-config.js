'use strict';
// sessions 独立配置(~/.config/agentsync):与盒配置(BOX_ENV)完全解耦——
// 个人机只需本目录,不需要也不应持有 RESTIC_PASSWORD。
// AGENTSYNC_DIR / AGENTSYNC_CLAUDE_DIR 仅作测试与特殊部署的种子,常规使用勿设。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { parseEnvFile } = require('./env');
const { platformPaths } = require('./platform');

function sessionPaths({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const paths = platformPaths(platform, home, env);
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  return {
    configDir: env.AGENTSYNC_DIR || pathImpl.join(pathImpl.dirname(paths.configDir), 'agentsync'),
    claudeProjectsDir: env.AGENTSYNC_CLAUDE_DIR || pathImpl.join(home, '.claude', 'projects'),
  };
}
const configDir = (options) => sessionPaths(options).configDir;
const claudeProjectsDir = (options) => sessionPaths(options).claudeProjectsDir;

const REQUIRED_S3 = ['SYNC_S3_ENDPOINT', 'SYNC_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SESSIONS_CRYPT_PASSWORD'];
const REQUIRED_LOCAL = ['SYNC_LOCAL_ROOT', 'SESSIONS_CRYPT_PASSWORD'];

function loadSessionsConfig() {
  const p = path.join(configDir(), 'env');
  if (!fs.existsSync(p)) throw new Error(`缺少配置 ${p}(参考仓库 env.sessions.example,chmod 600)`);
  const kv = parseEnvFile(fs.readFileSync(p, 'utf8'));
  const backend = kv.SYNC_BACKEND || 's3';
  for (const k of (backend === 'local' ? REQUIRED_LOCAL : REQUIRED_S3)) {
    if (!kv[k]) throw new Error(`配置缺少 ${k}(${p})`);
  }
  return {
    backend,
    endpoint: kv.SYNC_S3_ENDPOINT || '',
    bucket: kv.SYNC_BUCKET || '',
    localRoot: kv.SYNC_LOCAL_ROOT || '',
    cryptPassword: kv.SESSIONS_CRYPT_PASSWORD,
    cryptPassword2: kv.SESSIONS_CRYPT_PASSWORD2 || '',
    accessKey: kv.AWS_ACCESS_KEY_ID || '',
    secretKey: kv.AWS_SECRET_ACCESS_KEY || '',
  };
}

function machineId() {
  const p = path.join(configDir(), 'machine-id');
  if (fs.existsSync(p)) {
    const id = fs.readFileSync(p, 'utf8').trim();
    if (id) return id;
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(p, id + '\n');
  return id;
}

function readProjects() {
  const p = path.join(configDir(), 'projects.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeProjects(map) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(path.join(configDir(), 'projects.json'), JSON.stringify(map, null, 2) + '\n');
}

const emptyState = () => ({ version: 1, machines: {}, landed: {}, memory: {} });

function readState(uuid) {
  const p = path.join(configDir(), 'state', `${uuid}.json`);
  if (!fs.existsSync(p)) return emptyState();
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return emptyState(); }
}

function writeState(uuid, state) {
  const dir = path.join(configDir(), 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uuid}.json`), JSON.stringify(state, null, 2) + '\n');
}

module.exports = { sessionPaths, configDir, claudeProjectsDir, loadSessionsConfig, machineId, readProjects, writeProjects, readState, writeState };
