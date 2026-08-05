'use strict';

const crypto = require('crypto');

class TaskManager {
  constructor() { this.tasks = new Map(); this.listeners = new Set(); }
  emit(task) { for (const listener of this.listeners) listener(task); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get(id) { return this.tasks.get(id) || null; }
  start(operation, fn) {
    const task = { id: crypto.randomUUID(), operation, state: 'queued', createdAt: new Date().toISOString(), logs: [] };
    this.tasks.set(task.id, task); this.emit(task);
    queueMicrotask(async () => {
      if (task.state === 'cancelled') return;
      task.state = 'running'; this.emit(task);
      try { task.result = await fn((line) => task.logs.push(String(line))); task.state = 'succeeded'; }
      catch (error) { task.error = error && error.message ? error.message : '操作失败'; task.state = 'failed'; }
      task.finishedAt = new Date().toISOString(); this.emit(task);
    });
    return task;
  }
  cancel(id) {
    const task = this.get(id);
    if (!task || !['queued', 'running'].includes(task.state)) return false;
    task.state = 'cancelled'; task.finishedAt = new Date().toISOString(); this.emit(task); return true;
  }
}

module.exports = { TaskManager };
