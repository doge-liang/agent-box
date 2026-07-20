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

function activeWindowMs() {
  // AGENTSYNC_ACTIVE_WINDOW_MS 仅供测试收窄/关闭活跃窗口
  const v = process.env.AGENTSYNC_ACTIVE_WINDOW_MS;
  return v === undefined ? plan.ACTIVE_WINDOW_MS : Number(v);
}

function recordLanded(state, rel, f, origin, dstPath) {
  const st = fs.statSync(dstPath);
  state.landed[rel] = { origin, remoteMtimeMs: f.mtimeMs, landedSize: st.size, landedMtimeMs: st.mtimeMs };
}

// 哨兵:远端此版本已评估但本地未落地(本地更新/本地已改)——planPush 视为需上传,
// planPull 在远端再变前不再重判。
function recordSentinel(state, rel, f, origin) {
  state.landed[rel] = { origin, remoteMtimeMs: f.mtimeMs, landedSize: -1, landedMtimeMs: -1 };
}

function landOne({ rel, f, cachePath, dstPath, origin, manifest, projectPath, state, nowMs, log }) {
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  if (plan.isMemoryRel(rel)) {
    const remoteBuf = fs.readFileSync(cachePath);
    const remoteHash = sha256(remoteBuf);
    const localHash = fs.existsSync(dstPath) ? sha256(fs.readFileSync(dstPath)) : null;
    const mem = state.memory[rel] || (state.memory[rel] = {});
    const d = plan.planMemoryLanding({ localHash, remoteHash, baselineHash: mem.baseline, lastRemoteHash: mem.lastRemote });
    if (d.action === 'conflict') {
      const baseName = path.basename(dstPath, '.md');
      const conflictPath = path.join(path.dirname(dstPath), `${baseName}.${origin.slice(0, 8)}.conflict.md`);
      fs.writeFileSync(conflictPath, remoteBuf);
      mem.lastRemote = remoteHash;
      recordSentinel(state, rel, f, origin);
      log(`memory 冲突: ${rel} → 远端版已存为 ${path.basename(conflictPath)},本地未覆盖,请人工合并`);
      return 1;
    }
    if (d.action === 'write') { fs.writeFileSync(dstPath, remoteBuf); mem.baseline = remoteHash; mem.lastRemote = remoteHash; recordLanded(state, rel, f, origin, dstPath); }
    else if (d.action === 'baseline') { mem.baseline = remoteHash; mem.lastRemote = remoteHash; recordLanded(state, rel, f, origin, dstPath); }
    else { mem.lastRemote = remoteHash; recordSentinel(state, rel, f, origin); } // skip: 无 fs 写,安全推进
    return 0;
  }
  const localSt = fs.existsSync(dstPath) ? fs.statSync(dstPath) : null;
  const d = plan.planSessionLanding({
    remote: { size: f.size, mtimeMs: f.mtimeMs },
    local: localSt && { size: localSt.size, mtimeMs: localSt.mtimeMs },
    nowMs: nowMs(), activeWindowMs: activeWindowMs(),
  });
  if (d.action === 'skip') {
    if (d.reason === 'active') log(`跳过 ${rel}: 本地五分钟内有写入(可能正被续写),下次 pull 重试`);
    else recordSentinel(state, rel, f, origin);  // 本地更新:远端此版本不再重判
    return 0;
  }
  if (rel.endsWith('.jsonl')) {
    const text = fs.readFileSync(cachePath, 'utf8');
    fs.writeFileSync(dstPath, rewriteCwd(text, manifest.root, projectPath, { fromSep: manifest.sep || '/', toSep: path.sep }));
  } else {
    fs.copyFileSync(cachePath, dstPath);
  }
  fs.utimesSync(dstPath, new Date(f.mtimeMs), new Date(f.mtimeMs));
  recordLanded(state, rel, f, origin, dstPath);
  return 0;
}

function pull(pathArg, deps = {}) {
  const log = deps.log || console.log;
  const rcl = deps.rclone || rcloneMod;
  const cfg = deps.cfg || cfgMod.loadSessionsConfig();
  const nowMs = deps.nowMs || Date.now;
  const { projectPath, id, slugDir } = resolveProject(pathArg);
  const mid = cfgMod.machineId();
  const state = cfgMod.readState(id);
  const origins = rcl.lsDirs(cfg, `${id}/claude`).filter((m) => m !== mid);
  if (!origins.length) { log('pull: 远端暂无他机数据'); return 0; }
  let conflicts = 0;
  try {
    for (const origin of origins) {
      const ns = `${id}/claude/${origin}`;
      const manifestText = rcl.catFile(cfg, `${ns}/_manifest.json`);
      if (!manifestText) { log(`跳过 ${origin}: 无 _manifest.json(对端未完成 push)`); continue; }
      let manifest;
      try { manifest = JSON.parse(manifestText); } catch { log(`跳过 ${origin}: _manifest.json 损坏`); continue; }
      const remoteFiles = rcl.lsFiles(cfg, ns);
      const seen = state.machines[origin] || (state.machines[origin] = {});
      const { toDownload, toLand } = plan.planPull({ remoteFiles, seen, landed: state.landed });
      const cacheDir = path.join(cfgMod.configDir(), 'cache', id, origin);
      fs.mkdirSync(cacheDir, { recursive: true });
      const missingFromCache = toLand.filter((rel) => !toDownload.includes(rel) && !fs.existsSync(toFsPath(cacheDir, rel)));
      const downloads = [...new Set([...toDownload, ...missingFromCache])];
      rcl.copyFiles(cfg, rcl.remote(ns), cacheDir, downloads);
      const byRel = new Map(remoteFiles.map((x) => [x.rel, x]));
      for (const rel of downloads) {
        const x = byRel.get(rel);
        if (x) seen[rel] = { size: x.size, mtimeMs: x.mtimeMs };
      }
      for (const rel of toLand) {
        const x = byRel.get(rel);
        const cachePath = toFsPath(cacheDir, rel);
        if (!x || !fs.existsSync(cachePath)) continue;
        conflicts += landOne({
          rel, f: x, cachePath, dstPath: toFsPath(slugDir, rel),
          origin, manifest, projectPath, state, nowMs, log,
        });
      }
    }
  } finally {
    cfgMod.writeState(id, state);   // 中断也持久化已完成部分;seen 滞后只会多下一次,不丢数据
  }
  if (conflicts) { log(`pull 完成,但有 ${conflicts} 个 memory 冲突待人工合并(*.conflict.md)`); return 3; }
  log('pull 完成');
  return 0;
}

module.exports = { init, list, push, pull, resolveProject, listLocalFiles, sha256, toFsPath };
