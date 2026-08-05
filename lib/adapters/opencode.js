'use strict';
const { jsonlProjectFiles, resume } = require('./common');
module.exports = { id: 'opencode', platforms: ['linux', 'darwin', 'win32'], collect: (project, paths = {}) => jsonlProjectFiles(paths.opencode, project), resumeHint: resume('opencode --session') };
