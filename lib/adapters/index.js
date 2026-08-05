'use strict';

const adapters = [
  require('./claude'), require('./codex'), require('./grok'), require('./opencode'), require('./pi'), require('./oh-my-pi'),
];

function adapterById(id) {
  const adapter = adapters.find((item) => item.id === id);
  if (!adapter) throw new Error(`未知 agent: ${id}`);
  return adapter;
}

function collectSessions(projectPath, list = adapters, paths = {}) {
  return list.map((adapter) => ({ agent: adapter.id, ...adapter.collect(projectPath, paths) }));
}

module.exports = { adapters, adapterById, collectSessions };
