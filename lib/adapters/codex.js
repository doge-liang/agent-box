'use strict';
const { jsonlProjectFiles, resume } = require('./common');
module.exports = { id: 'codex', platforms: ['linux', 'darwin', 'win32'], collect: (project, paths = {}) => jsonlProjectFiles(paths.codex, project), resumeHint: resume('codex resume') };
