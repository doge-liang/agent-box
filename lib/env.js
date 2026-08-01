'use strict';
const fs = require('fs');
const path = require('path');
const { platformPaths } = require('./platform');

const REQUIRED = ['BOX_NODE', 'BOX_S3_ENDPOINT', 'BOX_BUCKET',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'RESTIC_PASSWORD'];

function configPaths({ platform = process.platform, home, env = process.env } = {}) {
  const paths = platformPaths(platform, home, env);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return {
    ...paths,
    envPath: env.BOX_ENV || join(paths.configDir, 'env'),
    nodesPath: env.BOX_NODES || join(paths.configDir, 'nodes'),
  };
}

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

function parseNodesFile(text) {
  const nodes = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [name, host] = t.split(/\s+/);
    if (name && host) nodes.push({ name, host });
  }
  return nodes;
}

function loadConfig(options) {
  const fsImpl = options && options.fs || fs;
  const { envPath, nodesPath, ...paths } = configPaths(options);
  if (!fsImpl.existsSync(envPath)) {
    throw new Error(`缺少配置 ${envPath},参照 box/env.example 创建(chmod 600)`);
  }
  const raw = parseEnvFile(fsImpl.readFileSync(envPath, 'utf8'));
  for (const k of REQUIRED) if (!raw[k]) throw new Error(`${envPath} 缺少 ${k}`);
  const nodes = fsImpl.existsSync(nodesPath)
    ? parseNodesFile(fsImpl.readFileSync(nodesPath, 'utf8'))
    : [{ name: raw.BOX_NODE, host: 'local' }];
  return {
    node: raw.BOX_NODE,
    globalsRole: raw.BOX_GLOBALS_ROLE || 'pull',
    endpoint: raw.BOX_S3_ENDPOINT,
    bucket: raw.BOX_BUCKET,
    memoryMax: raw.BOX_MEMORY_MAX || '1500M',
    resticEnv: {
      RESTIC_REPOSITORY: `s3:${raw.BOX_S3_ENDPOINT}/${raw.BOX_BUCKET}/restic`,
      RESTIC_PASSWORD: raw.RESTIC_PASSWORD,
      AWS_ACCESS_KEY_ID: raw.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: raw.AWS_SECRET_ACCESS_KEY,
    },
    rcloneEnv: {
      RCLONE_CONFIG_BOXR2_TYPE: 's3',
      RCLONE_CONFIG_BOXR2_PROVIDER: 'Cloudflare',
      RCLONE_CONFIG_BOXR2_ENDPOINT: raw.BOX_S3_ENDPOINT,
      RCLONE_CONFIG_BOXR2_ACCESS_KEY_ID: raw.AWS_ACCESS_KEY_ID,
      RCLONE_CONFIG_BOXR2_SECRET_ACCESS_KEY: raw.AWS_SECRET_ACCESS_KEY,
      RCLONE_CONFIG_BOXR2_NO_CHECK_BUCKET: 'true',
    },
    nodes,
    paths,
    nodesPath,
  };
}

function hostFor(cfg, nodeName) {
  const n = cfg.nodes.find((x) => x.name === nodeName);
  if (!n) throw new Error(`节点 ${nodeName} 不在 ${cfg.nodesPath} 清单中`);
  return n.host;
}

module.exports = { parseEnvFile, parseNodesFile, configPaths, loadConfig, hostFor };
