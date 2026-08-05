'use strict';
const token = location.hash.slice(1); history.replaceState(null, '', location.pathname);
const auth = { Authorization: `Bearer ${token}` };
const $ = (id) => document.getElementById(id);
async function api(url, options = {}) { const r = await fetch(url, { ...options, headers: { ...auth, ...(options.headers || {}) } }); const body = await r.json(); if (!r.ok) throw new Error(body.error || '请求失败'); return body; }
async function projects() { try { const data = await api('/api/projects'); $('projects').replaceChildren(...data.projects.map((p) => { const li = document.createElement('li'); li.textContent = `${p.id} — ${p.path}`; return li; })); $('notice').textContent = data.projects.length ? '仅显示本机已登记的项目。' : '尚未登记项目，请在命令行运行 sessions init。'; } catch (e) { $('notice').textContent = e.message; } }
$('sync').onclick = async () => { try { const data = await api('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'sync', project: $('project').value }) }); const id = data.task.id; const poll = async () => { const t = (await api(`/api/tasks/${id}`)).task; $('task').textContent = JSON.stringify(t, null, 2); if (['queued', 'running'].includes(t.state)) setTimeout(poll, 500); else projects(); }; poll(); } catch (e) { $('task').textContent = e.message; } };
projects();
