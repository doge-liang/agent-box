'use strict';
const PORTABLE = new Set(['track', 'push', 'pull', 'restore', 'sessions', 'status', 'ls', 'serve']);
const LINUX_ONLY = new Set(['up', 'attach', 'exec', 'park']);
const sessions = require('./sync-cmd');
const syncConfig = require('./sync-config');
function commandSupport(command, platform = process.platform) {
  if (PORTABLE.has(command)) return { ok: true };
  if (LINUX_ONLY.has(command) && platform !== 'linux') return { ok: false, reason: `${command} 需要 Linux 沙盒运行时` };
  return { ok: true };
}
function requireLinuxRuntime(command, platform = process.platform) {
  const result = commandSupport(command, platform); if (!result.ok) throw new Error(result.reason); return result;
}
function createSyncCore() {
  return {
    projects: async () => Object.entries(syncConfig.readProjects()).map(([id, projectPath]) => ({ id, path: projectPath })),
    sync: async (projectPath, { log = console.log } = {}) => sessions.sync(projectPath, { log }),
  };
}
module.exports = { commandSupport, requireLinuxRuntime, createSyncCore };
