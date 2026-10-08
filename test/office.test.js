import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP, DOOR, SOFA_SEATS, LOUNGE_SPOTS, PATROL, CAGE_INTERIOR, SESSION_DESKS, findPath, assign, planAgents, randomSpot } from '../web/office-logic.js';

const a = (id, state, kind = 'agent') => ({ id, state, kind, name: id, detail: '' });

test('every seat, sofa, lounge, station and patrol spot is reachable from the door', () => {
  const targets = [
    ...Object.values(MAP.desks).map((d) => d.seat),
    ...SOFA_SEATS, ...LOUNGE_SPOTS, ...PATROL,
    { x: 14, y: 15 }, { x: 26, y: 4 }, { x: 25, y: 16 }, { x: 27, y: 16 }, { x: 1, y: 8 },
  ];
  for (const t of targets) assert.ok(findPath(DOOR, t), `unreachable: ${t.x},${t.y}`);
});

test('desks, racks, walls and the cage bars block movement; the cage interior is sealed off from the office', () => {
  assert.equal(findPath(DOOR, { x: 3, y: 4 }), null); // desk tile
  assert.equal(findPath(DOOR, { x: 0, y: 5 }), null); // wall
  assert.equal(findPath(DOOR, { x: 26, y: 12 }), null); // inside the cage
  const inside = findPath({ x: 24, y: 11 }, { x: 28, y: 13 });
  assert.ok(inside && inside.length === 6, 'OpenClaw can walk around inside its cage');
  assert.equal(findPath({ x: 24, y: 11 }, DOOR), null, 'and cannot get out');
});

test('paths only use free orthogonal steps', () => {
  const p = findPath(DOOR, { x: 19, y: 3 });
  let prev = DOOR;
  for (const s of p) {
    assert.equal(Math.abs(s.x - prev.x) + Math.abs(s.y - prev.y), 1);
    assert.ok(!MAP.blocked.has(`${s.x},${s.y}`));
    prev = s;
  }
});

test('assign keeps earlier slots stable and never double-books', () => {
  const first = assign(['a', 'b', 'c'], 3);
  const again = assign(['c', 'b', 'a', 'd'], 3, first);
  assert.equal(again.get('a'), first.get('a'));
  assert.equal(again.get('b'), first.get('b'));
  assert.equal(again.has('d'), false, 'no free slot left for the 4th');
  assert.equal(new Set(again.values()).size, again.size);
});

test('plans: working agent types at its desk, standby agent sleeps on the sofa, stopped agent is absent', () => {
  const { plans } = planAgents([a('opencode', 'working'), a('aider', 'standby'), a('codex', 'stopped'), a('claude-code', 'waiting')]);
  assert.equal(plans.get('opencode').mode, 'type');
  assert.deepEqual(plans.get('opencode').tile, MAP.desks.A2.seat);
  assert.equal(plans.get('aider').mode, 'sleep');
  assert.equal(plans.get('aider').bubble, 'zzz');
  assert.equal(plans.get('codex').mode, 'absent');
  assert.equal(plans.get('claude-code').mode, 'sit');
  assert.equal(plans.get('claude-code').bubble, '!');
});

test('plans: Claude sessions take desks when busy or waiting and hang out in the lounge when idle; overflow wanders', () => {
  const sessions = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => a(`claude:${id}`, 'working', 'session'));
  sessions.push(a('claude:idle', 'idle', 'session'));
  const { plans } = planAgents(sessions);
  const seated = sessions.filter((s) => plans.get(s.id).mode === 'type');
  assert.equal(seated.length, SESSION_DESKS.length);
  assert.equal(plans.get('claude:s6').mode, 'wander');
  assert.equal(plans.get('claude:idle').mode, 'wander');
  assert.equal(new Set(seated.map((s) => plans.get(s.id).desk)).size, SESSION_DESKS.length);
});

test('plans: services have stations (Jarvis reception, Ollama rack, night watch board, cloud window, OpenClaw cage, field scout patrol)', () => {
  const { plans } = planAgents([a('jarvis', 'running'), a('ollama', 'running'), a('job-jarvis-health', 'waiting'), a('job-clipflow-monitor', 'scheduled'), a('routine-clipflow', 'scheduled'), a('openclaw', 'running'), a('clipflow-monitor', 'running')]);
  assert.equal(plans.get('jarvis').mode, 'sit');
  assert.deepEqual(plans.get('ollama').tile, { x: 26, y: 4 });
  assert.equal(plans.get('job-jarvis-health').bubble, '!');
  assert.equal(plans.get('job-clipflow-monitor').bubble, 'clock');
  assert.equal(plans.get('routine-clipflow').bubble, 'cloud');
  assert.equal(plans.get('openclaw').mode, 'pace');
  assert.deepEqual(plans.get('openclaw').box, CAGE_INTERIOR);
  assert.equal(plans.get('clipflow-monitor').mode, 'patrol');
});

test('sofa overflow: more resting agents than seats means the extra ones wander', () => {
  const ids = ['claude-code', 'opencode', 'aider', 'codex', 'hermes'];
  const { plans } = planAgents(ids.map((id) => a(id, 'standby')));
  assert.equal(ids.filter((id) => plans.get(id).mode === 'sleep').length, SOFA_SEATS.length);
  assert.equal(ids.filter((id) => plans.get(id).mode === 'wander').length, 1);
});

test('randomSpot stays inside the cage / on the patrol line / in the lounge', () => {
  for (let i = 0; i < 50; i++) {
    const p = randomSpot({ mode: 'pace', box: CAGE_INTERIOR }, { x: 24, y: 11 });
    assert.ok(p.x >= 24 && p.x <= 28 && p.y >= 11 && p.y <= 13);
  }
  const pt = randomSpot({ mode: 'patrol', points: PATROL }, PATROL[0]);
  assert.deepEqual(pt, PATROL[1]);
  for (let i = 0; i < 50; i++) {
    const w = randomSpot({ mode: 'wander', spots: LOUNGE_SPOTS }, { x: 0, y: 0 });
    assert.ok(LOUNGE_SPOTS.some((s) => s.x === w.x && s.y === w.y));
  }
});
