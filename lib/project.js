'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

function localProjectPath(configDir, id) {
  return path.join(configDir, 'projects', `${encodeURIComponent(id)}.json`);
}

function writeLocalPaths(configDir, id, localPaths, fsImpl = fs) {
  const filePath = localProjectPath(configDir, id);
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(filePath, JSON.stringify({ local_paths: localPaths }, null, 2));
}

function readLocalPaths(configDir, id, fsImpl = fs) {
  const filePath = localProjectPath(configDir, id);
  if (!fsImpl.existsSync(filePath)) return {};
  const stored = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  return stored.local_paths || {};
}

function remoteMeta(meta) {
  const { local_paths, ...remote } = upgradeMeta(meta);
  return remote;
}

module.exports = {
  projectId, upgradeMeta, localProjectPath, writeLocalPaths, readLocalPaths, remoteMeta,
};
