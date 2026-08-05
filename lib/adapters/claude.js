'use strict';
const { encodedProjectDirectory, resume } = require('./common');
module.exports = { id: 'claude', platforms: ['linux', 'darwin', 'win32'], collect: (project, paths = {}) => encodedProjectDirectory(paths.claude, project), resumeHint: resume('claude --resume') };
