'use strict';
const { run } = require('./sh');

class ResticProvider {
  constructor(cfg, command = run, log = () => {}) { this.cfg = cfg; this.command = command; this.log = log; }
  backup(meta, targets, excludeFile) {
    this.log(`备份 ${meta.name}`);
    const args = ['backup', '--tag', `box:${meta.name}`];
    if (excludeFile) args.push('--exclude-file', excludeFile);
    args.push(...targets);
    return this.command('restic', args, { env: this.cfg.resticEnv, inherit: true });
  }
  restore(meta, target = '/') {
    this.log(`恢复 ${meta.name}`);
    return this.command('restic', ['restore', 'latest', '--tag', `box:${meta.name}`, '--target', target], { env: this.cfg.resticEnv, inherit: true });
  }
}
class HostedProvider {
  backup() { throw new Error('托管同步尚未启用'); }
  restore() { throw new Error('托管同步尚未启用'); }
}
module.exports = { ResticProvider, HostedProvider };
