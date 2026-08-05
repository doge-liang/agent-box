'use strict';
const { encodedProjectDirectory, resume } = require('./common');
module.exports = { id: 'pi', platforms: ['linux', 'darwin', 'win32'], collect: (project, paths = {}) => encodedProjectDirectory(paths.pi, project), resumeHint: resume('pi --resume') };
