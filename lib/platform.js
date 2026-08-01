'use strict';
const path = require('path');

function platformPaths(platform = process.platform, home, env = process.env) {
  const resolvedHome = home || env.HOME || env.USERPROFILE;
  if (!resolvedHome) throw new Error('无法确定本机主目录');

  if (platform === 'win32') {
    const root = env.APPDATA || path.win32.join(resolvedHome, 'AppData', 'Roaming');
    return { configDir: path.win32.join(root, 'ag-box') };
  }

  if (platform === 'darwin') {
    return { configDir: path.posix.join(resolvedHome, 'Library', 'Application Support', 'ag-box') };
  }

  return { configDir: path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(resolvedHome, '.config'), 'ag-box') };
}

module.exports = { platformPaths };
