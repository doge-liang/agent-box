'use strict';
const PORTABLE = new Set(['track', 'push', 'pull', 'restore', 'sessions', 'status', 'ls', 'serve']);
const LINUX_ONLY = new Set(['up', 'attach', 'exec', 'park']);
function commandSupport(command, platform = process.platform) {
  if (PORTABLE.has(command)) return { ok: true };
  if (LINUX_ONLY.has(command) && platform !== 'linux') return { ok: false, reason: `${command} 需要 Linux 沙盒运行时` };
  return { ok: true };
}
function requireLinuxRuntime(command, platform = process.platform) {
  const result = commandSupport(command, platform); if (!result.ok) throw new Error(result.reason); return result;
}
module.exports = { commandSupport, requireLinuxRuntime };
