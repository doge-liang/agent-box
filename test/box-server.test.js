'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createServer } = require('../lib/server');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: options.headers }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject); if (options.body) req.write(JSON.stringify(options.body)); req.end();
  });
}

test('panel API requires a bearer token and only accepts sync', async () => {
  const core = { projects: async () => [{ id: 'p', path: '/work/p' }], sync: async () => 0 };
  const { server } = createServer({ core, token: 'a-very-long-test-token' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal((await request(port, '/api/projects')).status, 401);
    assert.equal((await request(port, '/api/projects', { headers: { Authorization: 'Bearer a-very-long-test-token' } })).status, 200);
    assert.equal((await request(port, '/api/sync', { method: 'POST', headers: { Authorization: 'Bearer a-very-long-test-token', 'Content-Type': 'application/json' }, body: { operation: 'shell', project: 'x' } })).status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('panel refuses non-loopback bindings', () => {
  assert.throws(() => createServer({ core: {}, token: 'a-very-long-test-token', host: '0.0.0.0' }), /回环/);
});
