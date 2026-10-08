import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../server/db.js';
import { createProgress, levelFor, rankFor, need, creditId, LIMITS, XP } from '../server/progress.js';
import { ActivityTracker } from '../server/activity.js';
import { collectAll } from '../server/collector.js';
import { mk } from '../server/registry.js';
import { createActions } from '../server/actions.js';
import { createApp } from '../server/app.js';
import { sanitizeHook, validatePayload } from '../server/sanitize.js';
import { applyHooks } from '../scripts/install-hooks.mjs';

const T0 = new Date(2026, 9, 6, 12, 0, 0).getTime();
const mkp = () => { const db = openDb(':memory:'); return { db, p: createProgress(db) }; };

test('levels: early levels are quick, later ones are earned', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(need), [0, 100, 283, 520, 800]);
  assert.equal(levelFor(0).level, 1);
  assert.equal(levelFor(99).level, 1);
  assert.equal(levelFor(100).level, 2);
  assert.equal(levelFor(282).level, 2);
  assert.equal(levelFor(283).level, 3);
  assert.deepEqual([levelFor(150).floor, levelFor(150).next], [100, 283]);
});

test('rank comes from the rolling pass rate and can go down', () => {
  const v = (pass, fail) => [...Array(pass).fill('pass'), ...Array(fail).fill('fail')];
  assert.equal(rankFor(v(4, 0)), 'Intern'); // too few verdicts
  assert.equal(rankFor(v(6, 4)), 'Junior');
  assert.equal(rankFor(v(8, 2)), 'Engineer');
  assert.equal(rankFor(v(17, 3)), 'Senior');
  assert.equal(rankFor(v(38, 2)), 'Staff');
  assert.equal(rankFor(v(2, 8)), 'Intern'); // a bad streak drops the rank
  assert.equal(rankFor(v(8, 2)), 'Engineer');
});

test('you approve: +50 XP; you reject: 0 XP but it counts against the pass rate; sessions credit Claude Code', () => {
  const { p } = mkp();
  assert.equal(p.humanVerdict('hermes', 'approve', T0).xp, XP.human_approve);
  p.humanVerdict('hermes', 'reject', T0 + 1);
  p.humanVerdict('claude:abcd1234', 'approve', T0 + 2);
  p.humanVerdict('sub:abcd1234:x', 'approve', T0 + 3);
  const s = p.summary().progress;
  assert.equal(s.hermes.xp, 50);
  assert.equal(s.hermes.verdicts, 2);
  assert.equal(s.hermes.passRate, 0.5);
  assert.equal(s['claude-code'].xp, 100);
  assert.equal(creditId('claude:ab'), 'claude-code');
  assert.throws(() => p.humanVerdict('not-an-agent', 'approve'), /unknown agent/);
  assert.throws(() => p.humanVerdict('hermes', 'great'), /invalid verdict/);
});

test('undo takes back a recent human verdict only', () => {
  const { p } = mkp();
  const { id } = p.humanVerdict('aider', 'approve', T0);
  assert.equal(p.undo(id, T0 + LIMITS.undoWindowMs + 1), false, 'too late');
  assert.equal(p.undo(id, T0 + 1000), true);
  assert.equal(p.undo(id, T0 + 1000), false, 'already revoked');
  assert.equal(p.summary().progress.aider, undefined, 'no XP and no verdict left');
  const auto = p.recordTest('aaaaaaaa', true, T0).awarded;
  assert.equal(auto, XP.tests_pass);
  assert.equal(p.undo(p.recent('claude-code')[0].id, T0 + 10), false, 'auto-verified rows cannot be "undone" by button');
});

test('approving is rate limited so you cannot mash the button', () => {
  const { p } = mkp();
  for (let i = 0; i < LIMITS.approvalsPerAgentPerHour; i++) p.humanVerdict('codex', 'approve', T0 + i);
  assert.throws(() => p.humanVerdict('codex', 'approve', T0 + 100), /too many/);
  assert.doesNotThrow(() => p.humanVerdict('codex', 'approve', T0 + 3_700_000));
});

test('test runs: small XP, capped per session and per day, spaced out, and failures only hurt rank', () => {
  const { p } = mkp();
  const day = (n) => T0 + n * 30_000; // every 30 s, so the "too soon" gap is not what stops us
  const got = [0, 1, 2, 3, 4].map((i) => p.recordTest('aaaaaaaa', true, day(i)));
  assert.deepEqual(got.map((g) => g.awarded), [10, 10, 10, 0, 0], 'only 3 per session per day');
  assert.equal(p.recordTest('bbbbbbbb', true, day(0) + 5000).awarded, 10);
  assert.equal(p.recordTest('bbbbbbbb', true, day(0) + 6000).awarded, 0, 'too soon after the last award');
  const f = p.recordTest('cccccccc', false, day(9));
  assert.deepEqual([f.awarded, f.reason], [0, 'fail']);
  const s = p.summary().progress['claude-code'];
  assert.equal(s.xp, 40);
  assert.equal(s.verdicts, 4 + 1, '4 awarded passes + 1 failure; capped or too-soon runs leave no row at all');
  assert.ok(s.passRate < 1);
  // the next day the caps reset
  assert.equal(p.recordTest('aaaaaaaa', true, T0 + 86_400_000 + 1000).awarded, 10);
});

test('nightly jobs: only STATUS OK earns, once per job per day, and WARN/FAIL earn nothing', () => {
  const { p } = mkp();
  assert.equal(p.recordJob('job-jarvis-health', '2026-10-06', 'OK', T0).awarded, XP.job_ok);
  assert.equal(p.recordJob('job-jarvis-health', '2026-10-06', 'OK', T0 + 5).awarded, 0, 'same day twice');
  assert.equal(p.recordJob('job-jarvis-health', '2026-10-07', 'WARN', T0).awarded, 0);
  assert.equal(p.recordJob('job-jarvis-health', '2026-10-08', 'FAIL', T0).awarded, 0);
  assert.equal(p.recordJob('nonsense', '2026-10-06', 'OK', T0).awarded, 0);
  assert.equal(p.summary().progress['job-jarvis-health'].xp, 5);
});

test('ACTIVITY NEVER EARNS XP: a thousand tool events, state changes and busy sessions leave XP at zero', async () => {
  const { db, p } = mkp();
  const tracker = new ActivityTracker();
  for (let i = 0; i < 1000; i++) tracker.ingest({ event: 'tool', session: 'aaaaaaaa', kind: 'edit', tool: 'Edit', target: `f${i}.js` }, T0 + i);
  const a = { name: 'x', staticIds: ['claude-code'], collect: async () => [mk('claude-code', 'working', 'busy')] };
  for (let i = 0; i < 50; i++) await collectAll(db, { adapters: [a], now: T0 + i * 1000, progress: p });
  assert.deepEqual(p.summary(), { progress: {}, studio: { xp: 0, level: 1, floor: 0, next: 100 } });
});

test('ledger is append-only history: totals are derived, never stored', () => {
  const { db, p } = mkp();
  p.humanVerdict('hermes', 'approve', T0);
  p.humanVerdict('hermes', 'approve', T0 + 1);
  assert.equal(db.raw.prepare('SELECT COUNT(*) c FROM ledger').get().c, 2);
  assert.equal(p.summary().studio.xp, 100);
  assert.equal(p.summary().studio.level, 2);
});

test('sanitizer: only test runs produce result events, and never carry the command', () => {
  const base = { session_id: '1a2b3c4d-0000', tool_name: 'Bash' };
  assert.deepEqual(sanitizeHook({ ...base, hook_event_name: 'PostToolUse', tool_input: { command: 'TOKEN=sk-SECRET npm test -- --grep x' } }), { event: 'tool_ok', session: '1a2b3c4d', kind: 'test' });
  assert.deepEqual(sanitizeHook({ ...base, hook_event_name: 'PostToolUseFailure', tool_input: { command: 'pytest -x' } }), { event: 'tool_fail', session: '1a2b3c4d', kind: 'test' });
  assert.equal(sanitizeHook({ ...base, hook_event_name: 'PostToolUse', tool_input: { command: 'ls -la' } }), null);
  assert.equal(sanitizeHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { command: 'npm test' } }), null);
  assert.equal(validatePayload({ event: 'tool_ok', session: '1a2b3c4d', kind: 'rm' }), null);
});

test('installer: also listens for Bash test results, once, and removes cleanly', () => {
  const cmd = '/opt/homebrew/bin/node /x/agency-hq/hook/agency-hook.mjs';
  const once = applyHooks({}, cmd);
  assert.equal(once.hooks.PostToolUse[0].matcher, 'Bash');
  assert.equal(once.hooks.PostToolUseFailure[0].matcher, 'Bash');
  assert.deepEqual(applyHooks(once, cmd), once);
  assert.deepEqual(applyHooks(once, cmd, { remove: true }), {});
});

function boot() {
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahq-p-'));
  fs.writeFileSync(path.join(webDir, 'index.html'), '<meta content="__NONCE__">');
  const db = openDb(':memory:');
  const progress = createProgress(db);
  const server = createApp({ db, actions: createActions({ run: async () => ({ code: 0 }), db }), webDir, hookToken: 'tok-123456789', tracker: new ActivityTracker(), progress });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, progress, port: server.address().port })));
}
function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(t) }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('HTTP: only your browser (origin + nonce) can give XP; agents and websites cannot', async () => {
  const { server, progress, port } = await boot();
  const n = server.nonce;
  const mine = { Origin: `http://127.0.0.1:${port}`, 'x-ahq-nonce': n };
  const body = { agent: 'hermes', verdict: 'approve' };
  assert.equal((await req(port, 'POST', '/api/verdict', body)).status, 403, 'no origin (a script or another agent)');
  assert.equal((await req(port, 'POST', '/api/verdict', body, { Origin: 'http://evil.example', 'x-ahq-nonce': n })).status, 403, 'a website');
  assert.equal((await req(port, 'POST', '/api/verdict', body, { Origin: `http://127.0.0.1:${port}`, 'x-ahq-nonce': 'guess' })).status, 403, 'wrong nonce');
  assert.equal((await req(port, 'POST', '/api/verdict', body, { Authorization: 'Bearer tok-123456789' })).status, 403, 'the hook token is NOT enough');
  assert.equal(progress.summary().studio.xp, 0);
  const ok = await req(port, 'POST', '/api/verdict', body, mine);
  assert.equal(ok.status, 200);
  assert.equal(ok.json().xp, 50);
  assert.equal((await req(port, 'POST', '/api/verdict', { agent: 'nope', verdict: 'approve' }, mine)).status, 400);
  const state = (await req(port, 'GET', '/api/state')).json();
  assert.equal(state.progress.hermes.xp, 50);
  assert.equal(state.studio.xp, 50);
  const undo = await req(port, 'POST', '/api/verdict/undo', { id: ok.json().id }, mine);
  assert.equal(undo.json().ok, true);
  assert.equal((await req(port, 'GET', '/api/state')).json().studio.xp, 0);
  server.close();
});

test('HTTP: the hook can only report test results (capped small XP), never award bigger XP', async () => {
  const { server, port } = await boot();
  const hook = { Authorization: 'Bearer tok-123456789' };
  assert.equal((await req(port, 'POST', '/api/hook', { event: 'tool_ok', session: '1a2b3c4d', kind: 'test' }, hook)).status, 204);
  assert.equal((await req(port, 'POST', '/api/hook', { event: 'tool_ok', session: '1a2b3c4d', kind: 'test' }, hook)).status, 204);
  assert.equal((await req(port, 'POST', '/api/hook', { event: 'verdict', agent: 'hermes', xp: 9999 }, hook)).status, 400);
  const s = (await req(port, 'GET', '/api/state')).json();
  assert.equal(s.progress['claude-code'].xp, 10, 'second run was too soon');
  assert.equal(s.progress.hermes, undefined);
  const led = (await req(port, 'GET', '/api/ledger?agent=claude-code')).json();
  assert.match(led.entries[0].text, /tests passed \(auto\)/);
  server.close();
});
