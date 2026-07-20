'use strict';
// sessions 子命令编排。纯逻辑在 sync-plan/session-rewrite;本文件做 fs/rclone 粘合,
// deps 可注入(rclone/cfg/nowMs/log)便于单测。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cfgMod = require('./sync-config');
const { claudeSlug, readProjectId, ensureProjectId } = require('./sync-identity');
const { rewriteCwd } = require('./session-rewrite');
const plan = require('./sync-plan');
const rcloneMod = require('./rclone');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const toFsPath = (base, rel) => path.join(base, ...rel.split('/'));

function* walkFiles(dir, base = dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkFiles(p, base);
    else if (ent.isFile()) yield path.relative(base, p).split(path.sep).join('/');
  }
}

function listLocalFiles(slugDir) {
  if (!fs.existsSync(slugDir)) return [];
  const out = [];
  for (const rel of walkFiles(slugDir)) {
    const st = fs.statSync(toFsPath(slugDir, rel));
    out.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

function resolveProject(pathArg) {
  const projectPath = path.resolve(pathArg || process.cwd());
  const id = readProjectId(projectPath);
  if (!id) throw new Error(`${projectPath} 未初始化:先执行 ag-box sessions init`);
  if (cfgMod.readProjects()[id] !== projectPath) {
    throw new Error(`项目 ${id} 未在本机登记(或路径已变):先执行 ag-box sessions init`);
  }
  const slug = claudeSlug(projectPath);
  return { projectPath, id, slug, slugDir: path.join(cfgMod.claudeProjectsDir(), slug) };
}

function init(pathArg, deps = {}) {
  const log = deps.log || console.log;
  const projectPath = path.resolve(pathArg || process.cwd());
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    throw new Error(`目录不存在: ${projectPath}`);
  }
  const { id, created } = ensureProjectId(projectPath);
  const map = cfgMod.readProjects();
  const slug = claudeSlug(projectPath);
  for (const [otherId, otherPath] of Object.entries(map)) {
    if (otherId !== id && claudeSlug(otherPath) === slug) {
      log(`警告: ${otherPath} 与本项目 slug 相同(claude 目录有损编码),两项目会话与 memory 会混居同一目录`);
    }
  }
  if (map[id] && map[id] !== projectPath) log(`提示: 项目路径由 ${map[id]} 更新为 ${projectPath}`);
  map[id] = projectPath;
  cfgMod.writeProjects(map);
  cfgMod.machineId();
  log(`${created ? '已创建' : '复用'} .agentsync,项目 ${id}`);
  log(`slug: ${slug}`);
  log('建议把 .agentsync 提交进项目 git,保证各机同一 UUID(各机各自 init 出不同 UUID 会被当作不同项目)');
  return 0;
}

function list(deps = {}) {
  const log = deps.log || console.log;
  const entries = Object.entries(cfgMod.readProjects());
  if (!entries.length) { log('尚无同步项目(用 ag-box sessions init 登记)'); return 0; }
  for (const [id, p] of entries) {
    const memDir = path.join(cfgMod.claudeProjectsDir(), claudeSlug(p), 'memory');
    const conflicts = fs.existsSync(memDir)
      ? fs.readdirSync(memDir).filter((f) => f.endsWith('.conflict.md')).length : 0;
    log(`${id}  ${p}${conflicts ? `  [${conflicts} 个 memory 冲突待合并]` : ''}`);
  }
  return 0;
}

function push(pathArg, deps = {}) {
  const log = deps.log || console.log;
  const rcl = deps.rclone || rcloneMod;
  const cfg = deps.cfg || cfgMod.loadSessionsConfig();
  const { projectPath, id, slug, slugDir } = resolveProject(pathArg);
  const mid = cfgMod.machineId();
  const state = cfgMod.readState(id);
  const localFiles = listLocalFiles(slugDir);
  const toUpload = plan.planPush({ localFiles, landed: state.landed });
  const ns = `${id}/claude/${mid}`;
  rcl.rcatFile(cfg, `${ns}/_manifest.json`, JSON.stringify({
    version: 1, root: projectPath, slug, sep: path.sep,
    platform: process.platform, hostname: os.hostname(), pushedAt: new Date().toISOString(),
  }) + '\n');
  rcl.copyFiles(cfg, slugDir, rcl.remote(ns), toUpload);
  log(`push 完成: 上传 ${toUpload.length} 个文件(本地共 ${localFiles.length} 个)`);
  return 0;
}

module.exports = { init, list, push, resolveProject, listLocalFiles, sha256, toFsPath };
