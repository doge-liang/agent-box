'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/sync-plan');

const f = (rel, size, mtimeMs) => ({ rel, size, mtimeMs });

test('planPush: 本机原创全上传;他机来源未续写排除(回声抑制);续写过上传;排除 conflict/manifest', () => {
  const landed = {
    'foreign.jsonl': { origin: 'mB', remoteMtimeMs: 1000, landedSize: 50, landedMtimeMs: 1000 },
    'grown.jsonl': { origin: 'mB', remoteMtimeMs: 1000, landedSize: 50, landedMtimeMs: 1000 },
    'sentinel.jsonl': { origin: 'mB', remoteMtimeMs: 1000, landedSize: -1, landedMtimeMs: -1 },
  };
  const out = P.planPush({ localFiles: [
    f('mine.jsonl', 10, 5000),               // 无 landed → 本机原创 → 上传
    f('foreign.jsonl', 50, 1000),            // 与落地记录一致 → 回声,排除
    f('grown.jsonl', 80, 9000),              // 本机续写 → 上传
    f('sentinel.jsonl', 42, 800),            // 哨兵(本地更新未落地)→ 上传
    f('memory/a.mB.conflict.md', 5, 1),      // 冲突副本 → 永不上传
    f('_manifest.json', 5, 1),               // manifest → 排除
  ], landed });
  assert.deepStrictEqual(out, ['mine.jsonl', 'grown.jsonl', 'sentinel.jsonl']);
});

test('planPull: 首次全下载;size/mtime 有变才重下;toLand 按 landed.remoteMtimeMs 判', () => {
  const remoteFiles = [f('a.jsonl', 10, 1000), f('b.jsonl', 20, 2000), f('_manifest.json', 5, 1)];
  const first = P.planPull({ remoteFiles, seen: {}, landed: {} });
  assert.deepStrictEqual(first.toDownload, ['a.jsonl', 'b.jsonl']);
  assert.deepStrictEqual(first.toLand, ['a.jsonl', 'b.jsonl']);
  const second = P.planPull({ remoteFiles,
    seen: { 'a.jsonl': { size: 10, mtimeMs: 1000 }, 'b.jsonl': { size: 15, mtimeMs: 1500 } },
    landed: { 'a.jsonl': { origin: 'mB', remoteMtimeMs: 1000, landedSize: 10, landedMtimeMs: 1000 } } });
  assert.deepStrictEqual(second.toDownload, ['b.jsonl']);   // a 未变不重下
  assert.deepStrictEqual(second.toLand, ['b.jsonl']);       // a 已落地且远端未更新
});

test('planSessionLanding: 本地无→写;活跃窗口→跳;远端新→写;本地新→跳', () => {
  const now = 10 * 60 * 1000;
  assert.deepStrictEqual(P.planSessionLanding({ remote: f('x', 1, 1000), local: null, nowMs: now }),
    { action: 'write' });
  assert.deepStrictEqual(P.planSessionLanding({ remote: f('x', 1, 999999), local: { size: 1, mtimeMs: now - 1000 }, nowMs: now }),
    { action: 'skip', reason: 'active' });
  assert.deepStrictEqual(P.planSessionLanding({ remote: { size: 9, mtimeMs: 8000 }, local: { size: 1, mtimeMs: 1000 }, nowMs: now }),
    { action: 'write' });
  assert.deepStrictEqual(P.planSessionLanding({ remote: { size: 9, mtimeMs: 1000 }, local: { size: 1, mtimeMs: 8000 }, nowMs: now }),
    { action: 'skip', reason: 'older' });
});

test('planMemoryLanding: 全状态矩阵', () => {
  const H = { a: 'ha', b: 'hb', base: 'hbase' };
  // 两侧一致 → 记基线
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: H.a, remoteHash: H.a }), { action: 'baseline' });
  // 本地不存在 → 落地
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: null, remoteHash: H.a }), { action: 'write' });
  // 只有远端改(本地==基线)→ 覆盖
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: H.base, remoteHash: H.a, baselineHash: H.base }), { action: 'write' });
  // 只有本地改(远端==lastRemote)→ 跳过,本地版留待 push
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: H.a, remoteHash: H.base, baselineHash: H.base, lastRemoteHash: H.base }),
    { action: 'skip', reason: 'stale-remote' });
  // 双方都改 → 冲突
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: H.a, remoteHash: H.b, baselineHash: H.base, lastRemoteHash: H.base }),
    { action: 'conflict' });
  // 无基线且两侧不同 → 保守按冲突
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: H.a, remoteHash: H.b }), { action: 'conflict' });
  // 冲突已见过同一远端版本(lastRemote 未变)→ 不重复落盘
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: H.a, remoteHash: H.b, lastRemoteHash: H.b }),
    { action: 'skip', reason: 'stale-remote' });
  // 仅本地改且 lastRemote 未播种(baseline 刚建立)→ 不误判冲突
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: H.a, remoteHash: H.base, baselineHash: H.base }),
    { action: 'skip', reason: 'stale-remote' });
  // 远端回退到基线值(lastRemote 停在他处)→ 亦跳过
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: H.a, remoteHash: H.base, baselineHash: H.base, lastRemoteHash: H.b }),
    { action: 'skip', reason: 'stale-remote' });
});
