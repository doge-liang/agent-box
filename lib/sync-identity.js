'use strict';
// 项目/机器身份。claudeSlug 是 claude 的真实目录编码规则(所有非字母数字 → '-',有损);
// 与 mounts.slugFor(仅替换 / 和 .,盒挂载专用)不同,勿混用。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MARKER = '.agentsync';
const claudeSlug = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readProjectId(projectPath) {
  const p = path.join(projectPath, MARKER);
  if (!fs.existsSync(p)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { throw new Error(`${p} 损坏:非合法 JSON`); }
  if (!data || typeof data.id !== 'string' || !UUID_RE.test(data.id)) throw new Error(`${p} 损坏:缺少合法 id`);
  return data.id;
}

function ensureProjectId(projectPath) {
  const existing = readProjectId(projectPath);
  if (existing) return { id: existing, created: false };
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(projectPath, MARKER), JSON.stringify({ id }, null, 2) + '\n');
  return { id, created: true };
}

module.exports = { MARKER, claudeSlug, readProjectId, ensureProjectId };
