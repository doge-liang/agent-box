'use strict';
// 同步计划(纯函数,不碰 fs/rclone):回声抑制 + union 增量 + memory 三态判定。
// 不变量:push 只上传本机原创或本机续写过的文件;pull 只处理相对 state 有变化的
// 他机文件 —— 否则 pull→改写→push 会把他机会话回传成回声,且 crypt 无 checksum
// (rclone 只比 size+modtime、改写必变大小)会恶化为每轮全量重传。
const MTIME_TOLERANCE_MS = 2500;        // FAT/exFAT 2s mtime 精度 + rclone 往返容差
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // 本地文件五分钟内有写入 → 视为正被 claude 续写

const isConflictFile = (rel) => /\.conflict\.md$/.test(rel);
const isMemoryRel = (rel) => rel.startsWith('memory/') && rel.endsWith('.md');
const isManifest = (rel) => rel === '_manifest.json';
const excluded = (rel) => isConflictFile(rel) || isManifest(rel);

function planPush({ localFiles, landed }) {
  const toUpload = [];
  for (const f of localFiles) {
    if (excluded(f.rel)) continue;
    const l = landed[f.rel];
    if (!l) { toUpload.push(f.rel); continue; }
    if (f.size !== l.landedSize || f.mtimeMs > l.landedMtimeMs + MTIME_TOLERANCE_MS) toUpload.push(f.rel);
  }
  return toUpload;
}

function planPull({ remoteFiles, seen, landed }) {
  const toDownload = [];
  const toLand = [];
  for (const f of remoteFiles) {
    if (excluded(f.rel)) continue;
    const s = seen[f.rel];
    if (!s || s.size !== f.size || Math.abs(s.mtimeMs - f.mtimeMs) > MTIME_TOLERANCE_MS) toDownload.push(f.rel);
    const l = landed[f.rel];
    if (!l || f.mtimeMs > l.remoteMtimeMs + MTIME_TOLERANCE_MS) toLand.push(f.rel);
  }
  return { toDownload, toLand };
}

function planSessionLanding({ remote, local, nowMs, activeWindowMs = ACTIVE_WINDOW_MS }) {
  if (!local) return { action: 'write' };
  if (nowMs - local.mtimeMs < activeWindowMs) return { action: 'skip', reason: 'active' };
  if (remote.mtimeMs > local.mtimeMs + MTIME_TOLERANCE_MS) return { action: 'write' };
  return { action: 'skip', reason: 'older' };
}

function planMemoryLanding({ localHash, remoteHash, baselineHash, lastRemoteHash }) {
  if (localHash === remoteHash) return { action: 'baseline' };
  if (localHash === null) return { action: 'write' };
  if (baselineHash && localHash === baselineHash) return { action: 'write' };
  if (baselineHash && remoteHash === baselineHash) return { action: 'skip', reason: 'stale-remote' };
  if (remoteHash === lastRemoteHash) return { action: 'skip', reason: 'stale-remote' };
  return { action: 'conflict' };
}

module.exports = {
  planPush, planPull, planSessionLanding, planMemoryLanding,
  isMemoryRel, isConflictFile, MTIME_TOLERANCE_MS, ACTIVE_WINDOW_MS,
};
