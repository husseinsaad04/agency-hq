import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { openDb } from '../server/db.js';
import { mk } from '../server/registry.js';
import { createActions, listProjects, resolveProject } from '../server/actions.js';
import { createApp } from '../server/app.js';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahq-proj-'));
  fs.mkdirSync(path.join(root, 'my-app'));
  fs.mkdirSync(path.join(root, '_compare'));
  fs.mkdirSync(path.join(root, '.hidden'));
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahq-web-'));
  fs.writeFileSync(path.join(webDir, 'index.html'), '<meta name="ahq-nonce" content="__NONCE__">');
  fs.writeFileSync(path.join(webDir, 'app.js'), '//js');
  fs.writeFileSync(path.join(webDir, 'style.css'), '/*css*/');
  const calls = [];
  const run = async (file, args) => { calls.push([file, ...args]); return { code: 0, stdout: '', stderr: '' }; };
  const spawned = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    spawned.push({ file, args, child });
    return child;
  };
  const db = openDb(':memory:');
  db.upsert(mk('ollama', 'running', 'v1'));
  const actions = createActions({ run, spawn, db, root, home: '/home/test', uid: 501 });
  const server = createApp({ db, actions, webDir, pollMs: 50 });
  return { root, db, actions, server, calls, spawned };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const post = (port, nonce, body, extra = {}) =>
  request(port, { method: 'POST', path: '/api/action', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, 'x-ahq-nonce': nonce, ...extra }, body });

test('serves the page with the nonce and strict security headers', async () => {
  const s = setup();
  const port = await listen(s.server);
  const r = await request(port, { path: '/' });
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(s.server.nonce));
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(r.headers['x-frame-options'], 'DENY');
  s.server.close();
});

test('rejects a wrong Host header (DNS-rebinding defence)', async () => {
  const s = setup();
  const port = await listen(s.server);
  const r = await request(port, { path: '/api/state', headers: { Host: 'evil.example:80' } });
  assert.equal(r.status, 403);
  s.server.close();
});

test('state endpoint returns agents and counts', async () => {
  const s = setup();
  const port = await listen(s.server);
  const j = (await request(port, { path: '/api/state' })).json();
  assert.equal(j.agents[0].id, 'ollama');
  assert.equal(j.counts.running, 1);
  s.server.close();
});

test('POST action is refused without a good Origin, without the nonce, and with non-JSON', async () => {
  const s = setup();
  const port = await listen(s.server);
  const n = s.server.nonce;
  assert.equal((await post(port, n, { id: 'ollama.start' }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await request(port, { method: 'POST', path: '/api/action', headers: { 'Content-Type': 'application/json' }, body: { id: 'ollama.start' } })).status, 403); // no Origin
  assert.equal((await post(port, 'wrong', { id: 'ollama.start' })).status, 403);
  assert.equal((await request(port, { method: 'POST', path: '/api/action', headers: { 'Content-Type': 'text/plain', Origin: `http://127.0.0.1:${port}`, 'x-ahq-nonce': n }, body: 'x' })).status, 415);
  assert.equal(s.calls.length, 0, 'nothing may have run');
  s.server.close();
});

test('unknown action 404; dangerous action needs confirmation; confirmed runs fixed argv', async () => {
  const s = setup();
  const port = await listen(s.server);
  const n = s.server.nonce;
  assert.equal((await post(port, n, { id: 'rm -rf /' })).status, 404);
  assert.equal((await post(port, n, { id: 'openclaw.stop' })).status, 400);
  assert.equal(s.calls.length, 0);
  const ok = await post(port, n, { id: 'openclaw.stop', confirmed: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(s.calls[0], ['docker', 'stop', 'openclaw-sandbox']);
  s.server.close();
});

test('terminal action: only real projects, path tricks are rejected, command is built from constants', async () => {
  const s = setup();
  const port = await listen(s.server);
  const n = s.server.nonce;
  for (const bad of ['../etc', '/etc', 'my-app/../..', '_compare', '.hidden', 'nope', "my-app'; rm -rf ~; '"]) {
    assert.equal((await post(port, n, { id: 'terminal.open.claude', params: { project: bad } })).status, 400, bad);
  }
  assert.equal(s.calls.length, 0);
  const ok = await post(port, n, { id: 'terminal.open.aider', params: { project: 'my-app' } });
  assert.equal(ok.status, 200);
  const script = s.calls[0].join(' ');
  assert.match(script, /osascript/);
  assert.match(script, /aider --model ollama_chat\/qwen3-coder:30b/);
  assert.ok(script.includes(path.join(s.root, 'my-app')));
  s.server.close();
});

test('hermes task: validated, spawned with fixed argv, prompt is passed as ONE argument, audit log has no prompt text', async () => {
  const s = setup();
  const port = await listen(s.server);
  const n = s.server.nonce;
  assert.equal((await post(port, n, { id: 'hermes.run', params: { project: 'my-app', prompt: '' } })).status, 400);
  assert.equal((await post(port, n, { id: 'hermes.run', params: { project: 'my-app', prompt: 'x'.repeat(2001) } })).status, 400);
  const prompt = 'make index.html; $(touch /tmp/pwned)';
  const r = await post(port, n, { id: 'hermes.run', params: { project: 'my-app', prompt } });
  assert.equal(r.status, 200);
  const runId = r.json().runId;
  const sp = s.spawned[0];
  assert.equal(sp.file, '/home/test/hermes-sandbox/hermes.sh');
  assert.deepEqual(sp.args.slice(0, 5), ['--project', path.join(s.root, 'my-app'), 'hermes', '--in', '/workspace']);
  assert.equal(sp.args[6], prompt, 'prompt is a single untouched argv element (no shell)');
  // second task while one runs is refused
  assert.equal((await post(port, n, { id: 'hermes.run', params: { project: 'my-app', prompt: 'again' } })).status, 500);
  sp.child.stdout.emit('data', 's6-rc: info: noise\nreal output line\n');
  sp.child.emit('close', 0);
  const run = (await request(port, { path: `/api/runs/${runId}` })).json();
  assert.equal(run.status, 'done');
  assert.ok(run.output.includes('real output line') && !run.output.includes('s6-rc'));
  const logged = JSON.stringify(s.db.actionLog(10));
  assert.ok(!logged.includes('pwned'), 'prompt text must not be stored');
  s.server.close();
});

test('listProjects hides underscore and dot folders; resolveProject validates', () => {
  const s = setup();
  assert.deepEqual(listProjects(s.root), ['my-app']);
  assert.throws(() => resolveProject('../x', s.root));
});

test('SSE stream sends the first state immediately', async () => {
  const s = setup();
  const port = await listen(s.server);
  const text = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      res.once('data', (c) => { resolve(String(c)); res.destroy(); });
    });
  });
  assert.match(text, /^event: state/);
  s.server.close();
});
