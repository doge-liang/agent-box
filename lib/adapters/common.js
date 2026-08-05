'use strict';

const fs = require('fs');
const path = require('path');
const { findCwd } = require('../sessions');

const CREDENTIAL_NAME = /(auth|credential|token|secret|keychain)/i;

function safeFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (CREDENTIAL_NAME.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  visit(root);
  return files;
}

function jsonlProjectFiles(root, projectPath) {
  const files = [];
  const skipped = [];
  for (const file of safeFiles(root)) {
    if (!file.endsWith('.jsonl')) continue;
    try {
      const first = fs.readFileSync(file, 'utf8').split(/\r?\n/, 1)[0];
      if (findCwd(first) === projectPath) files.push(file);
    } catch { skipped.push(file); }
  }
  return { files, skipped };
}

function encodedProjectDirectory(root, projectPath) {
  if (!root) return { files: [], skipped: [] };
  const candidates = [encodeURIComponent(projectPath), projectPath.replace(/[\\/]/g, '-')];
  for (const name of candidates) {
    const dir = path.join(root, name);
    // A project-scoped state directory is a restic backup target.  We do not
    // descend here: that would accidentally turn future credential files into
    // an allow-list.  Global credential names remain excluded by exclude.txt.
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return { files: [dir], skipped: [] };
  }
  return { files: [], skipped: [] };
}

function resume(command) {
  return (session = {}) => `${command}${session.id ? ` ${session.id}` : ''}`;
}

module.exports = { safeFiles, jsonlProjectFiles, encodedProjectDirectory, resume };
