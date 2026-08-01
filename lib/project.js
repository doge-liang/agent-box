'use strict';
const crypto = require('crypto');

function projectId() {
  return crypto.randomUUID();
}

function upgradeMeta(meta) {
  return {
    ...meta,
    schema_version: 2,
    project_id: meta.project_id || projectId(),
    local_paths: meta.local_paths || {},
  };
}

module.exports = { projectId, upgradeMeta };
