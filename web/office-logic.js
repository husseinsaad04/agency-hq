// Office map, walking and "where should each agent be" logic. Pure functions: no DOM, so it is unit-tested in Node.
export const TILE = 16;
export const COLS = 32;
export const ROWS = 20;

const key = (x, y) => `${x},${y}`;
export const DOOR = { x: 15, y: 18 }; // just inside the door; characters enter and leave here

function build() {
  const blocked = new Set();
  const walls = new Set();
  const furniture = [];
  const block = (x, y, w = 1, h = 1) => { for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) blocked.add(key(x + i, y + j)); };
  const wall = (x, y) => { walls.add(key(x, y)); blocked.add(key(x, y)); };

  for (let x = 0; x < COLS; x++) { wall(x, 0); if (x !== 15 && x !== 16) wall(x, ROWS - 1); }
  for (let y = 0; y < ROWS; y++) { wall(0, y); wall(COLS - 1, y); }
  for (let y = 1; y <= 7; y++) if (y !== 5) wall(21, y); // server room wall, doorway at y=5
  for (let x = 21; x < COLS - 1; x++) wall(x, 8);

  const desks = {};
  const addDesk = (id, cx, seatY) => {
    const d = { id, type: 'desk', x: cx - 1, y: seatY + 1, w: 3, h: 1, seat: { x: cx, y: seatY } };
    desks[id] = d;
    furniture.push(d);
    block(d.x, d.y, d.w, d.h);
  };
  [3, 7, 11, 15, 19].forEach((cx, i) => addDesk(`A${i + 1}`, cx, 3));
  [3, 7, 11, 15, 19].forEach((cx, i) => addDesk(`B${i + 1}`, cx, 8));

  furniture.push({ type: 'reception', x: 13, y: 16, w: 3, h: 1 }); block(13, 16, 3, 1);
  furniture.push({ type: 'sofa', x: 2, y: 14, w: 4, h: 1 });
  furniture.push({ type: 'coffee', x: 8, y: 14, w: 1, h: 1 }); block(8, 14);
  furniture.push({ type: 'table', x: 8, y: 16, w: 2, h: 2 }); block(8, 16, 2, 2);
  furniture.push({ type: 'plant', x: 1, y: 18, w: 1, h: 1 }); block(1, 18);
  furniture.push({ type: 'plant', x: 12, y: 14, w: 1, h: 1 }); block(12, 14);
  furniture.push({ type: 'plant', x: 20, y: 12, w: 1, h: 1 }); block(20, 12);
  for (const x of [23, 25, 27, 29]) { furniture.push({ type: 'rack', x, y: 1, w: 1, h: 2 }); block(x, 1, 1, 2); }
  furniture.push({ type: 'cage', x: 23, y: 10, w: 7, h: 5 });
  for (let x = 23; x <= 29; x++) for (let y = 10; y <= 14; y++) if (x === 23 || x === 29 || y === 10 || y === 14) blocked.add(key(x, y));
  furniture.push({ type: 'board', x: 23, y: 15, w: 6, h: 1 }); block(23, 15, 6, 1);
  furniture.push({ type: 'window', x: 0, y: 7, w: 1, h: 3 });

  return { blocked, walls, furniture, desks };
}

export const MAP = build();

export const SOFA_SEATS = [{ x: 2, y: 14 }, { x: 3, y: 14 }, { x: 4, y: 14 }, { x: 5, y: 14 }];
export const LOUNGE_SPOTS = [{ x: 6, y: 16 }, { x: 11, y: 16 }, { x: 5, y: 17 }, { x: 11, y: 18 }, { x: 3, y: 17 }, { x: 7, y: 18 }, { x: 10, y: 14 }, { x: 2, y: 16 }];
export const SESSION_DESKS = ['B1', 'B2', 'B3', 'B4', 'B5'];
export const CAGE_INTERIOR = { x0: 24, y0: 11, x1: 28, y1: 13 };
export const PATROL = [{ x: 6, y: 12 }, { x: 19, y: 12 }];

const DESK_OF = { 'claude-code': 'A1', opencode: 'A2', aider: 'A3', codex: 'A4', hermes: 'A5' };
const STATION = {
  jarvis: { x: 14, y: 15, face: 'down', sit: true },
  ollama: { x: 26, y: 4, face: 'up' },
  'job-jarvis-health': { x: 25, y: 16, face: 'up' },
  'job-clipflow-monitor': { x: 27, y: 16, face: 'up' },
  'routine-clipflow': { x: 1, y: 8, face: 'left' },
};

/** 4-direction breadth-first search on the tile grid. Returns tiles to walk (without the start), or null. */
export function findPath(from, to, blocked = MAP.blocked) {
  const sx = Math.round(from.x), sy = Math.round(from.y);
  if (sx === to.x && sy === to.y) return [];
  if (to.x < 0 || to.y < 0 || to.x >= COLS || to.y >= ROWS || blocked.has(key(to.x, to.y))) return null;
  const prev = new Map([[key(sx, sy), null]]);
  const queue = [[sx, sy]];
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS || prev.has(k) || blocked.has(k)) continue;
      prev.set(k, key(x, y));
      if (nx === to.x && ny === to.y) {
        const path = [];
        for (let c = k; c !== key(sx, sy); c = prev.get(c)) { const [px, py] = c.split(',').map(Number); path.unshift({ x: px, y: py }); }
        return path;
      }
      queue.push([nx, ny]);
    }
  }
  return null;
}

/** Keep earlier slot assignments stable; hand out free slots to newcomers. Returns Map(id -> slotIndex). */
export function assign(ids, capacity, prev = new Map()) {
  const out = new Map();
  const used = new Set();
  for (const id of ids) if (prev.has(id) && prev.get(id) < capacity && !used.has(prev.get(id))) { out.set(id, prev.get(id)); used.add(prev.get(id)); }
  for (const id of ids) {
    if (out.has(id)) continue;
    for (let s = 0; s < capacity; s++) if (!used.has(s)) { out.set(id, s); used.add(s); break; }
  }
  return out;
}

const BUBBLE = { waiting: '!', error: 'x', unknown: '?' };
const ACT_BUBBLE = { think: 'think', read: 'read', run: 'run', web: 'web', agent: 'agent' }; // edit has no bubble: typing says it all
const actOf = (a) => (a.state === 'working' && a.meta && a.meta.activity && a.meta.activity.kind) || null;
const bubbleOf = (a) => BUBBLE[a.state] || ACT_BUBBLE[actOf(a)] || null;

/**
 * Decide where every agent should be and what it is doing.
 * plan.mode: type | sit | sleep | stand | wander | pace | patrol | absent
 */
export function planAgents(agents, prev = { sofa: new Map(), sdesk: new Map() }) {
  const plans = new Map();
  const needSofa = [];
  const sessionDesk = [];
  const helpers = [];

  for (const a of agents) {
    const bubble = bubbleOf(a);
    const base = { id: a.id, state: a.state, bubble, act: actOf(a) };
    if (a.kind === 'subagent') { helpers.push(a); continue; }
    const gone = a.state === 'stopped';

    if (a.kind === 'session') {
      if (a.state === 'working' || a.state === 'waiting') sessionDesk.push(a.id);
      else plans.set(a.id, { ...base, mode: 'wander', spots: LOUNGE_SPOTS, face: 'down' });
      continue;
    }
    if (DESK_OF[a.id]) {
      const d = MAP.desks[DESK_OF[a.id]];
      if (gone) plans.set(a.id, { ...base, mode: 'absent' });
      else if (['working', 'running', 'waiting', 'error', 'unknown'].includes(a.state)) {
        plans.set(a.id, { ...base, mode: a.state === 'working' || a.state === 'running' ? 'type' : 'sit', tile: d.seat, face: 'down', desk: d.id });
      } else needSofa.push(a.id); // idle / standby / scheduled: rest on the sofa
      continue;
    }
    if (a.id === 'openclaw') {
      plans.set(a.id, gone ? { ...base, mode: 'absent' } : { ...base, mode: 'pace', box: CAGE_INTERIOR, face: 'down' });
      continue;
    }
    if (a.id === 'clipflow-monitor') {
      plans.set(a.id, gone ? { ...base, mode: 'absent' } : { ...base, mode: 'patrol', points: PATROL, face: 'right' });
      continue;
    }
    const st = STATION[a.id];
    if (st) {
      if (gone) { plans.set(a.id, { ...base, mode: 'absent' }); continue; }
      const working = a.state === 'working' || a.state === 'running' && a.id.startsWith('job-');
      const icon = a.id === 'routine-clipflow' ? 'cloud' : a.state === 'scheduled' && a.id.startsWith('job-') ? 'clock' : null;
      plans.set(a.id, { ...base, bubble: bubble || icon, mode: st.sit ? (a.state === 'working' ? 'type' : 'sit') : working ? 'type' : 'stand', tile: { x: st.x, y: st.y }, face: st.face, desk: st.sit ? 'reception' : null });
      continue;
    }
    plans.set(a.id, { ...base, mode: 'wander', spots: LOUNGE_SPOTS, face: 'down' });
  }

  const sofa = assign(needSofa, SOFA_SEATS.length, prev.sofa);
  for (const id of needSofa) {
    const a = agents.find((x) => x.id === id);
    const base = { id, state: a.state, bubble: null };
    if (sofa.has(id)) plans.set(id, { ...base, mode: 'sleep', tile: SOFA_SEATS[sofa.get(id)], face: 'down', bubble: 'zzz' });
    else plans.set(id, { ...base, mode: 'wander', spots: LOUNGE_SPOTS, face: 'down' });
  }

  const sdesk = assign(sessionDesk, SESSION_DESKS.length, prev.sdesk);
  for (const id of sessionDesk) {
    const a = agents.find((x) => x.id === id);
    const base = { id, state: a.state, bubble: bubbleOf(a), act: actOf(a) };
    if (sdesk.has(id)) {
      const d = MAP.desks[SESSION_DESKS[sdesk.get(id)]];
      plans.set(id, { ...base, mode: a.state === 'working' ? 'type' : 'sit', tile: d.seat, face: 'down', desk: d.id });
    } else plans.set(id, { ...base, mode: 'wander', spots: LOUNGE_SPOTS, face: 'down' });
  }
  for (const h of helpers) {
    const parent = h.meta && h.meta.parent;
    const slot = sdesk.get(parent);
    if (slot === undefined) { plans.set(h.id, { id: h.id, state: h.state, bubble: null, act: 'agent', mode: 'wander', spots: LOUNGE_SPOTS, face: 'down' }); continue; }
    const seat = MAP.desks[SESSION_DESKS[slot]].seat;
    const x = seat.x + 2 <= 19 ? seat.x + 2 : seat.x - 2; // the gap between desks; the last desk uses its left side
    plans.set(h.id, { id: h.id, state: h.state, bubble: null, act: 'agent', mode: 'type', tile: { x, y: seat.y }, face: 'down', desk: null });
  }
  return { plans, sofa, sdesk };
}

/** Pick a random walkable spot from a plan's region (wander / pace / patrol). */
export function randomSpot(plan, current, rnd = Math.random) {
  if (plan.mode === 'pace') {
    const b = plan.box;
    return { x: b.x0 + Math.floor(rnd() * (b.x1 - b.x0 + 1)), y: b.y0 + Math.floor(rnd() * (b.y1 - b.y0 + 1)) };
  }
  const list = plan.mode === 'patrol' ? plan.points : plan.spots;
  const others = list.filter((p) => p.x !== Math.round(current.x) || p.y !== Math.round(current.y));
  const pool = others.length ? others : list;
  return pool[Math.floor(rnd() * pool.length)];
}
