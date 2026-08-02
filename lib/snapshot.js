'use strict';
const fs = require('fs');
const path = require('path');
const { ResticProvider } = require('./providers');
const { slugFor } = require('./mounts');
const { collectSessionSlices } = require('./sessions');

// 安装后固定在 /opt/box;开发期(从仓库直跑)回退到源码旁的 exclude.txt
// 注意:已安装的 /opt/box/exclude.txt 不随仓库自动更新——改 exclude 规则后必须重跑 install.sh,否则铁律排除会静默滞后
const EXCLUDE_FILE = fs.existsSync('/opt/box/exclude.txt')
  ? '/opt/box/exclude.txt'
  : path.join(__dirname, '..', 'exclude.txt');

function snapshotTargets(meta, adapters = []) {
  const targets = [meta.path];
  const claudeDir = `/root/.claude/projects/${slugFor(meta.path)}`;
  if (fs.existsSync(claudeDir)) targets.push(claudeDir);
  targets.push(...collectSessionSlices(meta.path));
  for (const adapter of adapters) {
    const result = adapter.collect(meta.path);
    targets.push(...(Array.isArray(result) ? result : result.files || []));
  }
  return targets;
}

function backupBox(cfg, meta) {
  return new ResticProvider(cfg).backup(meta, snapshotTargets(meta), EXCLUDE_FILE);
}

function restoreBox(cfg, meta) {
  return new ResticProvider(cfg).restore(meta);
}

module.exports = { EXCLUDE_FILE, snapshotTargets, backupBox, restoreBox };
