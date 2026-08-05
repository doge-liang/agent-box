'use strict';
const { jsonlProjectFiles, resume } = require('./common');
module.exports = { id: 'oh-my-pi', platforms: ['linux', 'darwin', 'win32'], collect: (project, paths = {}) => jsonlProjectFiles(paths.ohMyPi, project), resumeHint: resume('omp --resume') };
