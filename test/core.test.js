import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { mk } from '../server/registry.js';
import { collectAll } from '../server/collector.js';
import * as claude from '../server/adapters/claude.js';
import * as docker from '../server/adapters/docker.js';
import * as launchd from '../server/adapters/launchd.js';
import * as cli from '../server/adapters/cli.js';
import * as ollama from '../server/adapters/ollama.js';

test('db: records an event only when state changes', () => {
  const db = openDb(':memory:');
  assert.equal(db.upsert(mk('ollama', 'running', 'v1'), 1000), true);
  assert.equal(db.upsert(mk('ollama', 'running', 'v1'), 2000), false);
  assert.equal(db.upsert(mk('ollama', 'stopped'), 3000), true);
  const ev = db.events(10);
  assert.equal(ev.length, 2);
  assert.match(ev[0].summary, /running -> stopped/);
  const a = db.agents().find((x) => x.id === 'ollama');
  assert.equal(a.since, 3000); // since moves only on change
});

test('db: removeMissing deletes ended dynamic agents and logs it', () => {
  const db = openDb(':memory:');
  db.upsert(mk('claude:aaaa', 'idle', '', {}, { name: 'one' }), 1);
  db.upsert(mk('claude:bbbb', 'idle', '', {}, { name: 'two' }), 1);
  db.removeMissing('claude:', ['claude:aaaa'], 2);
  assert.deepEqual(db.agents().map((a) => a.id), ['claude:aaaa']);
  assert.match(db.events(1)[0].summary, /ended/);
});

test('db: prune drops old events', () => {
  const db = openDb(':memory:');
  db.upsert(mk('ollama', 'running'), 1000);
  db.prune(7, 1000 + 8 * 24 * 3600 * 1000);
  assert.equal(db.events(10).length, 0);
});

test('claude: counts busy, ignores dead pids, never copies secrets or socket paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahq-'));
  const base = { startedAt: 1, updatedAt: Date.now(), entrypoint: 'cli', messagingSocketPath: '/tmp/secret.sock' };
  fs.writeFileSync(path.join(dir, '111.json'), JSON.stringify({ ...base, pid: 111, sessionId: 'aaaaaaaa-1', cwd: '/x/proj', name: 'Proj', status: 'busy' }));
  fs.writeFileSync(path.join(dir, '222.json'), JSON.stringify({ ...base, pid: 222, sessionId: 'bbbbbbbb-2', cwd: '/x/other', status: 'idle' }));
  fs.writeFileSync(path.join(dir, '333.json'), JSON.stringify({ ...base, pid: 333, sessionId: 'cccccccc-3', cwd: '/x/dead', status: 'busy' }));
  fs.writeFileSync(path.join(dir, '111.deadbeef.key'), 'SUPERSECRET');
  const out = await claude.collect({ sessionsDir: dir, alive: (pid) => pid !== 333 });
  const head = out.find((a) => a.id === 'claude-code');
  assert.equal(head.state, 'working');
  assert.equal(head.meta.sessions, 2);
  assert.equal(out.filter((a) => a.id.startsWith('claude:')).length, 2);
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes('SUPERSECRET') && !blob.includes('secret.sock'));
});

test('claude: no sessions -> standby', () => {
  assert.equal(claude.buildAgents([])[0].state, 'standby');
});

test('docker: openclaw running, hermes only while a task container runs', () => {
  const list = docker.parsePs(
    [
      JSON.stringify({ Names: 'openclaw-sandbox', State: 'running', Status: 'Up 2 hours' }),
      JSON.stringify({ Names: 'hermes-4242', State: 'running', Status: 'Up 5 seconds' }),
      JSON.stringify({ Names: 'autoclip-app', State: 'running', Status: 'Up 2 days' }),
      'not json',
    ].join('\n')
  );
  const out = docker.buildAgents(list);
  assert.equal(out.find((a) => a.id === 'openclaw').state, 'running');
  assert.equal(out.find((a) => a.id === 'hermes').state, 'working');
  assert.equal(docker.buildAgents([]).find((a) => a.id === 'openclaw').state, 'stopped');
  assert.equal(docker.buildAgents([]).find((a) => a.id === 'hermes').state, 'standby');
});

test('launchd: parse list, job states, needs-you when last report is not OK', () => {
  const list = launchd.parseList('PID\tStatus\tLabel\n44945\t0\tlocal.jarvis.assistant\n-\t0\tlocal.automations.jarvis-health\n-\t2\tcom.clipflow.monitor\n');
  const out = launchd.buildAgents(list, { 'job-jarvis-health': { status: 'FAIL', date: '2026-10-06' }, 'job-clipflow-monitor': null }, [{ name: 'jarvis-conversation-runtime', state: 'running' }]);
  assert.equal(out.find((a) => a.id === 'jarvis').state, 'running');
  assert.match(out.find((a) => a.id === 'jarvis').detail, /runtime up/);
  assert.equal(out.find((a) => a.id === 'job-jarvis-health').state, 'waiting');
  assert.equal(out.find((a) => a.id === 'job-clipflow-monitor').state, 'stopped'); // label not loaded
  const cf = out.find((a) => a.id === 'clipflow-monitor');
  assert.equal(cf.state, 'scheduled');
  assert.match(cf.detail, /exit 2/);
});

test('launchd: lastReport reads the newest STATUS line only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahq-rep-'));
  fs.mkdirSync(path.join(root, 'j'));
  fs.writeFileSync(path.join(root, 'j', '2026-10-05.md'), 'STATUS: OK\n');
  fs.writeFileSync(path.join(root, 'j', '2026-10-06.md'), 'STATUS: WARN\nPROBLEMS: x\n');
  fs.writeFileSync(path.join(root, 'j', '2026-10-06.facts.txt'), 'STATUS: FAIL\n');
  assert.deepEqual(await launchd.lastReport('j', root), { date: '2026-10-06', status: 'WARN' });
  assert.equal(await launchd.lastReport('missing', root), null);
});

test('cli: finds opencode/aider/codex, separates the opencode server, ignores desktop-app codex', () => {
  const ps = [
    '  100 01:02 /opt/homebrew/Cellar/opencode/2.0.20/bin/opencode',
    '  101 05:00 /opt/homebrew/Cellar/opencode/2.0.20/bin/opencode serve --service',
    '  102 00:09 /opt/homebrew/Cellar/aider/0.86.2/libexec/bin/python /opt/homebrew/bin/aider --model x',
    '  103 10:00 /Applications/ChatGPT.app/Contents/Resources/codex app-server',
    '  104 00:30 /opt/homebrew/bin/codex exec hi',
    '  105 00:01 node /Users/me/Projects/agency-hq/server/index.js',
  ].join('\n');
  const f = cli.classify(ps);
  assert.equal(f.opencode.length, 1);
  assert.equal(f.opencodeServer.length, 1);
  assert.equal(f.aider.length, 1);
  assert.equal(f.codex.length, 1);
  const out = cli.buildAgents(cli.classify(''));
  assert.ok(out.every((a) => a.state === 'standby'));
});

test('ollama: running with loaded model, and stopped when unreachable', async () => {
  const ok = async (url) => ({ json: async () => (String(url).endsWith('/api/ps') ? { models: [{ name: 'qwen3-coder:30b' }] } : { version: '0.34.2' }) });
  const r = await ollama.collect({ fetchFn: ok });
  assert.equal(r[0].state, 'working');
  assert.match(r[0].detail, /qwen3-coder/);
  const down = await ollama.collect({ fetchFn: async () => { throw new Error('refused'); } });
  assert.equal(down[0].state, 'stopped');
});

test('collector: a broken adapter yields unknown cards and does not break the others', async () => {
  const db = openDb(':memory:');
  const good = { name: 'good', staticIds: ['ollama'], collect: async () => [mk('ollama', 'running')] };
  const bad = { name: 'bad', staticIds: ['aider'], collect: async () => { throw new Error('boom'); } };
  const agents = await collectAll(db, { adapters: [good, bad], now: 5 });
  assert.equal(agents.find((a) => a.id === 'ollama').state, 'running');
  assert.equal(agents.find((a) => a.id === 'aider').state, 'unknown');
});
