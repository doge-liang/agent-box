'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { TaskManager } = require('./tasks');
const { webAssets } = require('./web-assets');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const isLoopback = (host) => ['127.0.0.1', '::1', 'localhost'].includes(host);
const isLoopbackAddress = (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

function safeTask(task) {
  if (!task) return null;
  const { id, operation, state, createdAt, finishedAt, error, logs } = task;
  return { id, operation, state, createdAt, finishedAt, error, logs };
}
function headers(res, type = 'application/json; charset=utf-8') {
  res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
}
function send(res, status, body) { headers(res); res.statusCode = status; res.end(JSON.stringify(body)); }
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''; req.on('data', (chunk) => { body += chunk; if (body.length > 65536) reject(new Error('请求过大')); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('JSON 无效')); } }); req.on('error', reject);
  });
}
function createServer({ core, token, host = '127.0.0.1', tasks = new TaskManager() }) {
  if (!isLoopback(host)) throw new Error('管理面板只能绑定回环地址');
  if (!token || token.length < 16) throw new Error('缺少安全令牌');
  const authorize = (req) => req.headers.authorization === `Bearer ${token}`;
  const server = http.createServer(async (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return send(res, 403, { error: '仅允许本机访问' });
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname.startsWith('/api/')) {
      if (!authorize(req)) return send(res, 401, { error: '未授权' });
      if (req.method === 'GET' && url.pathname === '/api/projects') return send(res, 200, { projects: await core.projects() });
      if (req.method === 'GET' && url.pathname.startsWith('/api/tasks/')) return send(res, 200, { task: safeTask(tasks.get(url.pathname.split('/').at(-1))) });
      if (req.method === 'POST' && url.pathname === '/api/sync') {
        try {
          const data = await readJson(req);
          if (data.operation !== 'sync' || typeof data.project !== 'string' || data.project.length > 4096) return send(res, 400, { error: '不支持的操作' });
          const task = tasks.start('sync', (log) => core.sync(data.project, { log })); return send(res, 202, { task: safeTask(task) });
        } catch (error) { return send(res, 400, { error: error.message === 'JSON 无效' ? error.message : '请求无效' }); }
      }
      if (req.method === 'POST' && /^\/api\/tasks\/[^/]+\/cancel$/.test(url.pathname)) {
        const ok = tasks.cancel(url.pathname.split('/')[3]);
        return send(res, ok ? 200 : 409, { ok });
      }
      return send(res, 404, { error: '不存在的接口' });
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/web\//, '');
    if (relative.includes('..') || !MIME[path.extname(relative)]) return send(res, 404, { error: '不存在' });
    const asset = webAssets[relative];
    if (asset === undefined) return send(res, 404, { error: '不存在' });
    headers(res, MIME[path.extname(relative)]); res.statusCode = 200; res.end(asset);
  });
  return { server, tasks };
}

module.exports = { createServer, isLoopback, isLoopbackAddress };
