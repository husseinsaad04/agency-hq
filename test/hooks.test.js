import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { sanitizeHook, validatePayload, sessionKey } from '../server/sanitize.js';
import { ActivityTracker } from '../server/activity.js';
import * as claude from '../server/adapters/claude.js';
import { openDb } from '../server/db.js';
import { createActions } from '../server/actions.js';
import { createApp } from '../server/app.js';
import { applyHooks, EVENTS } from '../scripts/install-hooks.mjs';
import { planAgents, MAP } from '../web/office-logic.js';

const SID = '1a2b3c4d-0000-1111-2222-333344445555';
const tool = (name, input) => ({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: name, tool_input: input });

test('sanitize: shell commands keep only the program name, never arguments or secrets', () => {
  const out = sanitizeHook(tool('Bash', { command: 'API_KEY=sk-SECRET123 /usr/bin/curl -H "Authorization: Bearer sk-SECRET123" https://x.example' }));
  assert.equal(out.kind, 'run');
  assert.equal(out.target, 'curl');
  assert.ok(!JSON.stringify(out).includes('SECRET'));
  assert.ok(!JSON.stringify(out).includes('example'));
});

test('sanitize: files keep only the basename, web keeps only the host, prompts and notification text are dropped', () => {
  assert.equal(sanitizeHook(tool('Edit', { file_path: '/Users/me/private/taxes/2026-return.ts', old_string: 'SECRET', new_string: 'x' })).target, '2026-return.ts');
  assert.ok(!JSON.stringify(sanitizeHook(tool('Edit', { file_path: '/a/b.ts', old_string: 'SECRET' }))).includes('SECRET'));
  assert.equal(sanitizeHook(tool('WebFetch', { url: 'https://docs.example.com/a/b?token=SECRET' })).target, 'docs.example.com');
  const prompt = sanitizeHook({ hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'my password is hunter2' });
  assert.deepEqual(prompt, { event: 'prompt', session: '1a2b3c4d' });
  const note = sanitizeHook({ hook_event_name: 'Notification', session_id: SID, message: 'Claude needs your permission to use Bash for rm -rf secret' });
  assert.deepEqual(note, { event: 'notify', session: '1a2b3c4d', note: 'permission' });
  assert.equal(sanitizeHook(tool('Grep', { pattern: 'password' })).target, undefined);
  assert.equal(sanitizeHook(tool('mcp__figma__get_design', { x: 1 })).target, 'figma');
});

test('sanitize: unknown events and bad session ids are ignored; ids are normalised', () => {
  assert.equal(sanitizeHook({ hook_event_name: 'PostCompact', session_id: SID }), null);
  assert.equal(sanitizeHook({ hook_event_name: 'Stop', session_id: 'zz' }), null);
  assert.equal(sanitizeHook(null), null);
  assert.equal(sessionKey(SID), '1a2b3c4d');
  assert.deepEqual(sanitizeHook({ hook_event_name: 'SubagentStart', session_id: SID, agent_id: 'agent_9', agent_type: 'Explore' }), { event: 'sub_start', session: '1a2b3c4d', agent: 'agent_9', atype: 'Explore' });
});

test('validatePayload: strict, drops unknown fields, rejects garbage', () => {
  assert.deepEqual(validatePayload({ event: 'tool', session: '1a2b3c4d', kind: 'edit', tool: 'Edit', target: 'a.ts', prompt: 'LEAK' }), { event: 'tool', session: '1a2b3c4d', kind: 'edit', tool: 'Edit', target: 'a.ts' });
  for (const bad of [null, {}, { event: 'tool', session: 'nothex!!', kind: 'edit' }, { event: 'tool', session: '1a2b3c4d', kind: 'rm -rf' }, { event: 'notify', session: '1a2b3c4d', note: 'x' }, { event: 'sub_start', session: '1a2b3c4d' }]) assert.equal(validatePayload(bad), null);
});

test('tracker: tool -> thinking after ttl -> idle on stop; waiting from notifications; subagents; prune', () => {
  const t = new ActivityTracker({ ttlMs: 8000 });
  const k = '1a2b3c4d';
  assert.equal(t.get(k), null);
  t.ingest({ event: 'tool', session: k, kind: 'edit', tool: 'Edit', target: 'app.js' }, 1000);
  assert.deepEqual([t.get(k, 2000).kind, t.get(k, 2000).target], ['edit', 'app.js']);
  assert.equal(t.get(k, 20000).kind, 'think'); // stale tool means the model is thinking between tools
  t.ingest({ event: 'notify', session: k, note: 'permission' }, 21000);
  assert.equal(t.get(k, 21500).waiting, true);
  t.ingest({ event: 'tool', session: k, kind: 'run', tool: 'Bash', target: 'npm' }, 22000);
  assert.equal(t.get(k, 22100).waiting, false);
  t.ingest({ event: 'sub_start', session: k, agent: 'a1', atype: 'Explore' }, 23000);
  assert.deepEqual(t.get(k, 23500).subs, [{ id: 'a1', type: 'Explore' }]);
  t.ingest({ event: 'sub_stop', session: k, agent: 'a1' }, 24000);
  assert.equal(t.get(k, 24100).subs.length, 0);
  t.ingest({ event: 'stop', session: k }, 25000);
  assert.equal(t.get(k, 25100).kind, null);
  t.prune(25000 + 31 * 60 * 1000);
  assert.equal(t.get(k, 25000 + 31 * 60 * 1000), null);
});

test('claude adapter: shows the real activity, waiting-for-you, and sub-agents', () => {
  const t = new ActivityTracker();
  const now = Date.now();
  t.ingest({ event: 'tool', session: 'aaaaaaaa', kind: 'edit', tool: 'Edit', target: 'app.js' }, now - 1000);
  t.ingest({ event: 'notify', session: 'bbbbbbbb', note: 'permission' }, now - 500);
  t.ingest({ event: 'sub_start', session: 'aaaaaaaa', agent: 'h1', atype: 'Explore' }, now - 500);
  const sessions = [
    { pid: 1, sessionId: 'aaaaaaaa-1', cwd: '/x/proj', name: 'Proj', status: 'busy', entrypoint: 'cli' },
    { pid: 2, sessionId: 'bbbbbbbb-2', cwd: '/x/other', name: 'Other', status: 'idle', entrypoint: 'cli' },
  ];
  const out = claude.buildAgents(sessions, now, (k) => t.get(k, now));
  const a = out.find((x) => x.id === 'claude:aaaaaaaa');
  assert.equal(a.state, 'working');
  assert.match(a.detail, /editing app\.js/);
  assert.deepEqual(a.meta.activity, { kind: 'edit', target: 'app.js' });
  const b = out.find((x) => x.id === 'claude:bbbbbbbb');
  assert.equal(b.state, 'waiting');
  assert.match(b.detail, /waiting for you/);
  const h = out.find((x) => x.kind === 'subagent');
  assert.equal(h.meta.parent, 'claude:aaaaaaaa');
  assert.match(out.find((x) => x.id === 'claude-code').detail, /editing app\.js/);
});

function boot() {
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahq-w-'));
  fs.writeFileSync(path.join(webDir, 'index.html'), 'x');
  const db = openDb(':memory:');
  const tracker = new ActivityTracker();
  const server = createApp({ db, actions: createActions({ run: async () => ({ code: 0 }), db }), webDir, hookToken: 'secret-token-123', tracker });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, tracker, port: server.address().port })));
}
function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/hook', method: 'POST', headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(data);
  });
}

test('hook endpoint: needs the token, refuses browsers, validates, limits size, then updates the tracker', async () => {
  const { server, tracker, port } = await boot();
  const good = { event: 'tool', session: '1a2b3c4d', kind: 'read', tool: 'Read', target: 'a.md' };
  assert.equal(await post(port, good), 401);
  assert.equal(await post(port, good, { Authorization: 'Bearer wrong-token-xxx' }), 401);
  assert.equal(await post(port, good, { Authorization: 'Bearer secret-token-123', Origin: 'http://evil.example' }), 403);
  assert.equal(await post(port, { event: 'nope' }, { Authorization: 'Bearer secret-token-123' }), 400);
  assert.equal(await post(port, 'x'.repeat(5000), { Authorization: 'Bearer secret-token-123' }), 413);
  assert.equal(tracker.get('1a2b3c4d'), null, 'nothing accepted yet');
  assert.equal(await post(port, good, { Authorization: 'Bearer secret-token-123' }), 204);
  assert.equal(tracker.get('1a2b3c4d').kind, 'read');
  server.close();
});

test('hook endpoint: with no token configured, everything is refused', async () => {
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahq-w-'));
  fs.writeFileSync(path.join(webDir, 'index.html'), 'x');
  const server = createApp({ db: openDb(':memory:'), actions: createActions({ run: async () => ({ code: 0 }) }), webDir, hookToken: '', tracker: new ActivityTracker() });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  assert.equal(await post(port, { event: 'stop', session: '1a2b3c4d' }, { Authorization: 'Bearer ' }), 401);
  server.close();
});

test('installer: adds our hook once, keeps everyone else’s hooks, and removing restores the original', () => {
  const original = { theme: 'dark', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'python3 theirs.py' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  const cmd = '/opt/homebrew/bin/node /x/agency-hq/hook/agency-hook.mjs';
  const once = applyHooks(original, cmd);
  const twice = applyHooks(once, cmd);
  assert.deepEqual(once, twice, 'idempotent');
  for (const ev of EVENTS) assert.equal(JSON.stringify(once.hooks[ev]).split('agency-hook.mjs').length - 1, 1, ev);
  assert.ok(JSON.stringify(once.hooks.Stop).includes('echo mine'));
  assert.equal(once.hooks.SessionStart[0].hooks[0].command, 'python3 theirs.py');
  assert.equal(once.hooks.PreToolUse[0].hooks[0].async, true);
  assert.deepEqual(applyHooks(once, cmd, { remove: true }), original);
  assert.deepEqual(original.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'python3 theirs.py' }] }], 'input not mutated');
});

test('office: activity shows as bubbles, edit has none, helpers stand beside their parent’s desk', () => {
  const sess = (id, activity) => ({ id, kind: 'session', state: 'working', name: id, meta: { activity } });
  const agents = [
    sess('claude:s1', { kind: 'read', target: 'a.md' }),
    sess('claude:s2', { kind: 'edit', target: 'b.ts' }),
    sess('claude:s3', { kind: 'think' }),
    { id: 'sub:s1:h1', kind: 'subagent', state: 'working', name: 'Helper', meta: { parent: 'claude:s1', activity: { kind: 'agent' } } },
    { id: 'sub:zz:orphan', kind: 'subagent', state: 'working', name: 'Helper', meta: { parent: 'claude:gone', activity: { kind: 'agent' } } },
  ];
  const { plans, sdesk } = planAgents(agents);
  assert.equal(plans.get('claude:s1').bubble, 'read');
  assert.equal(plans.get('claude:s1').act, 'read');
  assert.equal(plans.get('claude:s2').bubble, null);
  assert.equal(plans.get('claude:s3').bubble, 'think');
  const seat = MAP.desks[`B${sdesk.get('claude:s1') + 1}`].seat;
  const h = plans.get('sub:s1:h1');
  assert.deepEqual(h.tile, { x: seat.x + 2, y: seat.y });
  assert.equal(h.mode, 'type');
  assert.equal(plans.get('sub:zz:orphan').mode, 'wander');
});
