'use strict';
const { matchesBox, collectSessionSlices } = require('../sessions');
const path = require('path');
function cwdAdapter(id, rootKey, hint) {
  return { id, platforms: ['linux', 'darwin', 'win32'],
    collect(projectPath, paths = {}) { return { files: collectSessionSlices(projectPath, paths[rootKey] ? [paths[rootKey]] : []), skipped: [] }; },
    resumeHint: (s) => `${hint} ${s.id || ''}`.trim() };
}
function directoryAdapter(id, rootKey, hint) {
  return { id, platforms: ['linux', 'darwin', 'win32'],
    collect(projectPath, paths = {}) { const root = paths[rootKey]; if (!root) return { files: [], skipped: [] }; const dir = path.join(root, encodeURIComponent(projectPath)); return { files: require('fs').existsSync(dir) ? [dir] : [], skipped: [] }; },
    resumeHint: (s) => `${hint} ${s.id || ''}`.trim() };
}
const adapters = [cwdAdapter('codex', 'codex', 'codex resume'), directoryAdapter('grok', 'grok', 'grok resume'), directoryAdapter('claude', 'claude', 'claude --resume'), directoryAdapter('opencode', 'opencode', 'opencode --session'), directoryAdapter('pi', 'pi', 'pi --resume'), directoryAdapter('oh-my-pi', 'ohMyPi', 'omp --resume')];
function adapterById(id) { const a = adapters.find((x) => x.id === id); if (!a) throw new Error(`未知 agent: ${id}`); return a; }
function collectSessions(projectPath, list = adapters, paths = {}) { return list.map((a) => ({ agent: a.id, ...a.collect(projectPath, paths) })); }
module.exports = { adapters, adapterById, collectSessions };
