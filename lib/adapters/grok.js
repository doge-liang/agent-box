'use strict';
const { encodedProjectDirectory, resume } = require('./common');
module.exports = { id: 'grok', platforms: ['linux', 'darwin', 'win32'], collect: (project, paths = {}) => encodedProjectDirectory(paths.grok, project), resumeHint: resume('grok resume') };
