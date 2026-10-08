// The pixel office: draws the map, walks the characters, shows real state on monitors and bubbles.
// All art is drawn with rectangles in code (no image files, no borrowed assets).
import { TILE, COLS, ROWS, DOOR, MAP, planAgents, findPath, randomSpot } from './office-logic.js';

const W = COLS * TILE;
const H = ROWS * TILE;
const SPEED = 3.2; // tiles per second

// ---- tiny 3x5 pixel font (A-Z, 0-9, a few symbols)
const G = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111', F: '111100110100100',
  G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100', Q: '010101101110011', R: '110101110101101',
  S: '011100010001110', T: '111010010010010', U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001110',
  '!': '010010010000010', '?': '110001010000010', '.': '000000000000010', ':': '000010000010000', '-': '000000111000000', _: '000000000000111', '/': '001001010100100',
};

const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const hsl = (h, s, l) => `hsl(${h} ${s}% ${l}%)`;
const SKINS = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
const ACCESSORY = { 'claude-code': 'crown', opencode: 'cap', aider: 'band', codex: 'pin', hermes: 'goggles', openclaw: 'mask', jarvis: 'headset', ollama: 'ears', 'clipflow-monitor': 'scout', 'routine-clipflow': 'cloud', 'job-jarvis-health': 'nightcap', 'job-clipflow-monitor': 'nightcap' };

export function createOffice(canvas, { onSelect = () => {} } = {}) {
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let S = 2;
  let agents = [];
  let planState = { sofa: new Map(), sdesk: new Map() };
  const chars = new Map();
  let selected = null;
  let hover = null;
  let levels = {};
  let t = 0;
  let raf = 0;
  let lastTs = 0;

  const R = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x) * S, Math.round(y) * S, w * S, h * S); };
  function text(str, x, y, c) {
    let cx = Math.round(x);
    for (const ch of String(str).toUpperCase()) {
      const g = G[ch];
      if (g) for (let i = 0; i < 15; i++) if (g[i] === '1') R(cx + (i % 3), y + Math.floor(i / 3), 1, 1, c);
      cx += 4;
    }
  }
  const textW = (str) => String(str).length * 4 - 1;

  // ---------- resize
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const avail = Math.max(320, canvas.parentElement.clientWidth - 16);
    S = Math.max(2, Math.round((avail * dpr) / W)); // whole-number pixel scale for the drawing buffer
    canvas.width = W * S;
    canvas.height = H * S;
    canvas.style.width = `${avail}px`; // fill the stage; CSS scales the crisp buffer
    canvas.style.height = `${(avail * H) / W}px`;
    ctx.imageSmoothingEnabled = false;
  }

  // ---------- characters
  function newChar(a) {
    const start = a.id === 'openclaw' ? { x: 26, y: 12 } : DOOR;
    return { id: a.id, x: start.x, y: start.y, path: [], dest: null, dir: 'down', walking: false, walkT: 0, alpha: 1, visible: true, leaving: false, gone: false, wait: 0, plan: { mode: 'wander' }, agent: a, hue: hash(a.id) % 360, skin: SKINS[hash(a.id + 's') % SKINS.length], acc: ACCESSORY[a.id] || (String(a.id).startsWith('sub:') ? 'hardhat' : null) };
  }
  function goTo(c, target) {
    c.dest = target;
    if (reduced) { c.x = target.x; c.y = target.y; c.path = []; return; }
    c.path = findPath({ x: c.x, y: c.y }, target) || [];
  }
  function applyPlans() {
    const res = planAgents(agents, planState);
    planState = { sofa: res.sofa, sdesk: res.sdesk };
    const seen = new Set();
    for (const a of agents) {
      seen.add(a.id);
      let c = chars.get(a.id);
      if (!c) { c = newChar(a); chars.set(a.id, c); }
      const plan = res.plans.get(a.id);
      c.agent = a;
      c.plan = plan;
      if (plan.mode === 'absent') {
        if (!c.leaving && c.visible) { c.leaving = true; goTo(c, DOOR); }
      } else {
        if (c.leaving || !c.visible) { c.leaving = false; c.visible = true; c.alpha = 1; if (!c.path.length && !c.dest) { c.x = DOOR.x; c.y = DOOR.y; } }
        if (plan.tile) { if (!c.dest || c.dest.x !== plan.tile.x || c.dest.y !== plan.tile.y) goTo(c, plan.tile); }
        else if (c.modeKey !== plan.mode) { c.dest = null; c.wait = 0; }
      }
      c.modeKey = plan.mode;
    }
    for (const [id, c] of chars) if (!seen.has(id) && !c.gone) { c.gone = true; c.leaving = true; c.plan = { mode: 'absent' }; goTo(c, DOOR); }
  }

  function tick(dt) {
    for (const [id, c] of chars) {
      if (!c.visible) { if (c.gone) chars.delete(id); continue; }
      if (c.path.length) {
        const n = c.path[0];
        const dx = n.x - c.x, dy = n.y - c.y;
        const dist = Math.hypot(dx, dy);
        const step = SPEED * dt;
        if (dist <= step) { c.x = n.x; c.y = n.y; c.path.shift(); } else { c.x += (dx / dist) * step; c.y += (dy / dist) * step; }
        if (Math.abs(dx) > Math.abs(dy)) c.dir = dx > 0 ? 'right' : 'left'; else if (dy !== 0) c.dir = dy > 0 ? 'down' : 'up';
        c.walking = true;
        c.walkT += dt;
        continue;
      }
      c.walking = false;
      if (c.leaving) {
        c.alpha -= dt * 2.2;
        if (c.alpha <= 0) { c.visible = false; c.x = DOOR.x; c.y = DOOR.y; c.dest = null; }
      } else if (c.plan.tile) {
        c.dir = c.plan.face || 'down';
      } else if (!reduced || !c.dest) {
        c.wait -= dt;
        if (c.wait <= 0) { goTo(c, randomSpot(c.plan, c)); c.wait = c.plan.mode === 'patrol' ? 1.5 + Math.random() * 2 : 3 + Math.random() * 7; }
      }
    }
  }

  const seated = (c) => !c.walking && c.plan.tile && (c.plan.desk || c.plan.mode === 'sleep') && Math.round(c.x) === c.plan.tile.x && Math.round(c.y) === c.plan.tile.y;

  // ---------- drawing: environment
  function floorColor(x, y) {
    const k = (x + y) % 2 === 0;
    if (x >= 22 && y <= 7) return k ? '#1a2036' : '#1e2540';
    if (x >= 24 && x <= 28 && y >= 11 && y <= 13) return k ? '#2a3050' : '#2f3658';
    if (x <= 12 && y >= 13) return k ? '#3a2f4a' : '#34294a';
    if (x >= 22 && y >= 15) return k ? '#1f2f3f' : '#233546';
    if (x >= 13 && x <= 16 && y >= 15) return k ? '#4a2a3a' : '#442534';
    return k ? '#242b50' : '#2a3158';
  }
  function drawFloor() {
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (MAP.walls.has(`${x},${y}`)) continue;
      R(x * 16, y * 16, 16, 16, floorColor(x, y));
    }
    text('SERVER ROOM', 23 * 16, 7 * 16 + 4, '#4a5690');
    text('LOUNGE', 2 * 16, 18 * 16 + 5, '#7a6890');
    text('RECEPTION', 13 * 16 + 4, 18 * 16 + 5, '#8f5a70');
    text('QUARANTINE', 24 * 16 + 6, 9 * 16 + 5, '#c0485c');
    R(15 * 16, 18 * 16 + 9, 32, 7, '#7a2a3a'); // door mat
    text('EXIT', 15 * 16 + 10, 18 * 16 + 10, '#d8a0ac');
  }
  function drawWalls() {
    for (const k of MAP.walls) {
      const [x, y] = k.split(',').map(Number);
      R(x * 16, y * 16, 16, 16, '#2e3566');
      R(x * 16, y * 16, 16, 4, '#4a548f');
      R(x * 16, y * 16 + 12, 16, 4, '#232a52');
    }
    for (const x of [2, 6, 10, 14, 18]) { R(x * 16 + 2, 2, 12, 10, '#7cc4ff'); R(x * 16 + 2, 2, 12, 3, '#a8dcff'); R(x * 16 + 7, 2, 2, 10, '#2e3566'); }
    for (const x of [23, 26, 29]) { R(x * 16 + 1, 2, 12, 10, '#0f1530'); } // server room "windows" (dark)
  }

  // ---------- drawing: furniture and characters (depth sorted)
  function monitor(d, occ) {
    const cx = d.seat.x * 16;
    const py = d.y * 16;
    R(cx + 1, py - 5, 14, 10, '#1b2140');
    R(cx + 6, py + 5, 4, 1, '#1b2140');
    const sx = cx + 2, sy = py - 4;
    const st = occ ? occ.plan.mode : null;
    const state = occ ? occ.agent.state : null;
    if (!occ) { R(sx, sy, 12, 7, '#0a0c14'); return; }
    if (state === 'error') { R(sx, sy, 12, 7, '#3a0a12'); text('X', sx + 4, sy + 1, '#ff6b81'); return; }
    if (state === 'waiting') { R(sx, sy, 12, 7, Math.floor(t * 2) % 2 ? '#4a3400' : '#2a1d00'); text('!', sx + 5, sy + 1, '#ffcb6b'); return; }
    if (st === 'type') {
      const act = occ.plan.act;
      if (act === 'read') { // reading: steady blue text lines scrolling slowly
        R(sx, sy, 12, 7, '#06182b');
        for (let i = 0; i < 3; i++) R(sx + 1, sy + 1 + i * 2, 4 + ((hash(occ.id) + i * 3 + Math.floor(t * 1.5)) % 7), 1, i === 1 ? '#6cb6ff' : '#3f7fbf');
      } else if (act === 'run') { // terminal: prompt + blinking amber output
        R(sx, sy, 12, 7, '#0b0b10');
        R(sx + 1, sy + 1, 2, 1, '#5af78e'); R(sx + 3, sy + 2, 1, 1, '#5af78e');
        R(sx + 5, sy + 1, 3 + (Math.floor(t * 3) % 4), 1, '#ffcb6b');
        R(sx + 1, sy + 4, 5, 1, '#8a93c4'); R(sx + 1, sy + 5, 3 + (Math.floor(t * 4) % 5), 1, '#8a93c4');
      } else if (act === 'web') { // browsing: cyan wave bars
        R(sx, sy, 12, 7, '#061c22');
        for (let i = 0; i < 6; i++) R(sx + 1 + i * 2, sy + 5 - Math.round(2 + 2 * Math.sin(t * 4 + i)), 1, 1 + Math.round(2 + 2 * Math.sin(t * 4 + i)), '#7fe3ff');
      } else if (act === 'think') { // thinking: three pulsing dots
        R(sx, sy, 12, 7, '#0d1630');
        for (let i = 0; i < 3; i++) if (Math.floor(t * 3) % 4 > i) R(sx + 3 + i * 3, sy + 3, 1, 1, '#b69cff');
      } else if (act === 'agent') { // delegating: purple blocks
        R(sx, sy, 12, 7, '#16102a');
        for (let i = 0; i < 3; i++) R(sx + 1 + i * 4, sy + 2 + ((i + Math.floor(t * 2)) % 2), 3, 3, '#b69cff');
      } else { // editing code: colourful lines
        R(sx, sy, 12, 7, '#07131f');
        const colors = ['#5af78e', '#6cb6ff', '#ffcb6b'];
        for (let i = 0; i < 3; i++) {
          const len = 3 + ((hash(occ.id) + Math.floor(t * 5) + i * 5) % 8);
          R(sx + 1, sy + 1 + i * 2, len, 1, colors[(i + Math.floor(t * 2)) % 3]);
        }
      }
      return;
    }
    R(sx, sy, 12, 7, '#0d1630');
    if (Math.floor(t * 2) % 2) R(sx + 2, sy + 4, 2, 1, '#6cb6ff');
  }

  function drawDesk(d, occ) {
    const px = d.x * 16, py = d.y * 16;
    R(px, py + 4, 48, 8, '#8a5a3c');
    R(px, py + 4, 48, 1, '#a8714a');
    R(px, py + 12, 48, 4, '#5e3b27');
    R(px + 3, py + 7, 10, 2, '#cfd6ff'); // keyboard
    monitor(d, occ);
  }

  function drawFurniture(f, occByDesk) {
    const px = f.x * 16, py = f.y * 16;
    switch (f.type) {
      case 'desk': drawDesk(f, occByDesk.get(f.id)); break;
      case 'reception': {
        R(px, py + 3, 48, 9, '#7a3d4f'); R(px, py + 3, 48, 1, '#a85a6f'); R(px, py + 12, 48, 4, '#4f2633');
        text('RECEPTION', px + 6, py + 5, '#f0c8d4');
        R(px + 38, py - 2, 6, 5, '#e8ecff'); R(px + 40, py - 4, 2, 2, '#ffcb6b'); // bell
        break;
      }
      case 'sofa': {
        R(px, py, 64, 5, '#5e2d52'); R(px, py + 2, 64, 14, '#7a3d6a');
        for (let i = 0; i < 4; i++) R(px + i * 16 + 1, py + 5, 14, 10, '#8f4a7a');
        break;
      }
      case 'coffee': {
        R(px + 3, py + 2, 10, 13, '#3a3f5c'); R(px + 5, py + 4, 6, 3, '#0f1530'); R(px + 6, py + 5, 2, 1, '#5af78e');
        R(px + 5, py + 10, 6, 3, '#e8ecff');
        for (let i = 0; i < 2; i++) R(px + 6 + i * 3, py - 1 - ((t * 5 + i * 2) % 4), 1, 1, 'rgba(255,255,255,.7)');
        break;
      }
      case 'table': R(px, py + 2, 32, 22, '#6b4a35'); R(px, py + 2, 32, 2, '#8a5a3c'); R(px + 10, py + 8, 5, 5, '#e8ecff'); R(px + 20, py + 12, 5, 5, '#ffcb6b'); break;
      case 'plant': R(px + 4, py + 10, 8, 6, '#8a5a3c'); R(px + 3, py + 2, 10, 9, '#2fae5a'); R(px + 5, py, 6, 4, '#44c773'); R(px + 6, py + 4, 2, 2, '#1d8a44'); break;
      case 'rack': {
        R(px + 1, py, 14, 32, '#1f2638'); R(px + 1, py, 14, 2, '#3a4470');
        const busy = occByDesk.get('__ollama') ? 3 : 1.2;
        for (let i = 0; i < 6; i++) {
          R(px + 3, py + 4 + i * 5, 10, 3, '#12172a');
          const on = Math.floor(t * busy * (2 + i * 0.7)) % 2;
          R(px + 11, py + 5 + i * 5, 1, 1, on ? '#5af78e' : '#2a6a44');
          R(px + 4, py + 5 + i * 5, 1, 1, (i + Math.floor(t * busy)) % 3 ? '#6cb6ff' : '#ffcb6b');
        }
        break;
      }
      case 'board': {
        R(px, py + 1, 96, 14, '#0f1530'); R(px, py + 1, 96, 1, '#4a548f'); R(px, py + 14, 96, 1, '#4a548f');
        text('NIGHT WATCH', px + 4, py + 5, '#6cb6ff');
        const now = new Date();
        const cx = px + 82, cy = py + 8;
        R(cx - 5, cy - 5, 11, 11, '#e8ecff'); R(cx - 4, cy - 4, 9, 9, '#151a30');
        const hand = (ang, len, col) => { for (let i = 0; i <= len; i++) R(cx + Math.round(Math.sin(ang) * i), cy - Math.round(Math.cos(ang) * i), 1, 1, col); };
        hand(((now.getHours() % 12) + now.getMinutes() / 60) * (Math.PI / 6), 2, '#ffcb6b');
        hand(now.getMinutes() * (Math.PI / 30), 3, '#5af78e');
        break;
      }
      case 'window': R(1, py + 2, 3, 44, '#7cc4ff'); R(1, py + 2, 3, 10, '#a8dcff'); R(5, py + 20, 3, 2, '#e8f6ff'); R(4, py + 19, 6, 3, '#e8f6ff'); break;
      case 'cage': {
        for (let x = 23; x <= 29; x++) for (let y = 10; y <= 14; y++) {
          if (!(x === 23 || x === 29 || y === 10 || y === 14)) continue;
          const tx = x * 16, ty = y * 16;
          R(tx, ty + 6, 16, 2, '#6c76a8');
          if (y === 10 || y === 14) { R(tx, ty + (y === 10 ? 12 : 0), 16, 2, '#8f9bd6'); }
          for (let b = 1; b < 16; b += 4) R(tx + b, ty, 1, 16, 'rgba(143,155,214,.85)');
        }
        break;
      }
      default: break;
    }
  }

  function drawChar(c) {
    const sitting = seated(c);
    const x = Math.round(c.x * 16) + 3;
    const y = Math.round(c.y * 16) + 2;
    const moving = c.walking;
    const f = moving ? Math.floor(c.walkT * 8) % 2 : 0;
    const bob = moving ? (f ? -1 : 0) : 0;
    const sleeping = sitting && c.plan.mode === 'sleep';
    const dim = c.agent.state === 'standby' || c.agent.state === 'idle';
    const skin = c.skin;
    const hair = hsl((c.hue + 40) % 360, 45, 28);
    const shirt = dim ? hsl(c.hue, 30, 42) : hsl(c.hue, 60, 56);
    const pants = '#2a3156';
    ctx.globalAlpha = c.alpha;
    const oy = y + bob + (sleeping ? 1 : 0);

    if (!sitting) R(x + 2, y + 14, 6, 1, 'rgba(0,0,0,.28)');
    if (c.dir === 'left' || c.dir === 'right') {
      const lx = c.dir === 'left' ? 0 : 1;
      R(x + 3, oy, 5, 5, skin); R(x + 3, oy, 5, 2, hair); R(x + (c.dir === 'left' ? 3 : 7), oy, 1, 4, hair);
      R(x + 3 + (c.dir === 'left' ? 1 : 3), oy + 3, 1, 1, '#111');
      R(x + 3, oy + 5, 4, 5, shirt);
      if (!sitting) { R(x + 4 + (f ? 1 : -1) * (lx ? 1 : -1) * 0, oy + 5, 2, 4, skin === '#8d5524' ? '#a06a3a' : shirt); R(x + 3 + f, oy + 10, 2, 3, pants); R(x + 5 - f, oy + 10, 2, 3, pants); R(x + 3 + f, oy + 13, 2, 1, '#10131f'); R(x + 5 - f, oy + 13, 2, 1, '#10131f'); }
    } else {
      R(x + 2, oy, 6, 5, skin);
      if (c.dir === 'up') R(x + 2, oy, 6, 5, hair); else { R(x + 2, oy, 6, 2, hair); if (sleeping) { R(x + 3, oy + 3, 2, 1, '#111'); R(x + 6, oy + 3, 2, 1, '#111'); } else { R(x + 3, oy + 3, 1, 1, '#111'); R(x + 6, oy + 3, 1, 1, '#111'); } }
      R(x + 2, oy + 5, 6, 5, shirt);
      if (sitting && c.plan.mode === 'type') { const k = Math.floor(t * 8) % 2; R(x + 1, oy + 8 + k, 2, 1, skin); R(x + 7, oy + 9 - k, 2, 1, skin); }
      else if (!sitting && !moving && c.plan.mode === 'type') { const k = Math.floor(t * 8) % 2; R(x + 1, oy + 6 + k, 2, 1, skin); R(x + 7, oy + 7 - k, 2, 1, skin); R(x + 1, oy + 7, 1, 2, skin); R(x + 8, oy + 7, 1, 2, skin); }
      else if (!sitting) { R(x + 1, oy + 5 + (moving && f ? 1 : 0), 1, 4, skin); R(x + 8, oy + 5 + (moving && !f ? 1 : 0), 1, 4, skin); }
      else { R(x + 1, oy + 6, 1, 3, skin); R(x + 8, oy + 6, 1, 3, skin); }
      if (!sitting) { R(x + 3, oy + 10 + (f ? 0 : 1), 2, 3 - (f ? 0 : 1), pants); R(x + 5, oy + 10 + (f ? 1 : 0), 2, 3 - (f ? 1 : 0), pants); R(x + 3, oy + 13, 2, 1, '#10131f'); R(x + 5, oy + 13, 2, 1, '#10131f'); }
    }
    switch (c.acc) {
      case 'crown': R(x + 2, oy - 1, 6, 1, '#ffd34e'); R(x + 2, oy - 2, 1, 1, '#ffd34e'); R(x + 4, oy - 2, 2, 1, '#ffd34e'); R(x + 7, oy - 2, 1, 1, '#ffd34e'); break;
      case 'cap': R(x + 2, oy - 1, 6, 2, '#3fb27f'); break;
      case 'band': R(x + 2, oy + 1, 6, 1, '#ff6b81'); break;
      case 'pin': R(x + 4, oy + 6, 2, 2, '#6cb6ff'); break;
      case 'goggles': R(x + 2, oy + 2, 6, 1, '#7fe3ff'); break;
      case 'mask': R(x + 2, oy + 3, 6, 1, '#222'); R(x + 2, oy + 2, 6, 1, '#8a3b4a'); break;
      case 'headset': R(x + 2, oy - 1, 6, 1, '#222'); R(x + 1, oy + 2, 1, 3, '#222'); R(x + 8, oy + 2, 1, 3, '#222'); break;
      case 'ears': R(x + 2, oy - 2, 1, 2, '#fff'); R(x + 7, oy - 2, 1, 2, '#fff'); break;
      case 'scout': R(x + 1, oy - 1, 8, 1, '#a8714a'); R(x + 3, oy - 2, 4, 1, '#a8714a'); break;
      case 'cloud': R(x + 3, oy - 2, 4, 2, '#cfe8ff'); R(x + 2, oy - 1, 6, 1, '#cfe8ff'); break;
      case 'hardhat': R(x + 2, oy - 1, 6, 2, '#ffd34e'); R(x + 1, oy + 1, 8, 1, '#e0b020'); break;
      case 'nightcap': R(x + 2, oy - 1, 6, 2, '#3b2f7f'); R(x + 7, oy - 2, 1, 1, '#ffd34e'); break;
      default: break;
    }
    ctx.globalAlpha = 1;
  }

  function drawBubble(c) {
    const b = c.plan.bubble;
    if (!b || c.alpha < 1 || c.walking || !c.visible) return;
    const x = Math.round(c.x * 16) + 2;
    const y = Math.round(c.y * 16) - 11 + (b === 'zzz' ? Math.round(Math.sin(t * 2)) : 0);
    if (b === '!' && Math.floor(t * 3) % 2) return; // blink
    R(x, y, 11, 9, '#e8ecff'); R(x + 4, y + 9, 3, 1, '#e8ecff');
    if (b === '!') text('!', x + 4, y + 2, '#c27a00');
    else if (b === '?') text('?', x + 4, y + 2, '#6a42d6');
    else if (b === 'x') text('X', x + 4, y + 2, '#c4223c');
    else if (b === 'zzz') { text('Z', x + 1, y + 3, '#5b6590'); text('Z', x + 6, y + 1, '#8a93c4'); }
    else if (b === 'clock') { R(x + 2, y + 1, 7, 7, '#1b5fc4'); R(x + 3, y + 2, 5, 5, '#e8ecff'); R(x + 5, y + 3, 1, 2, '#1b5fc4'); R(x + 5, y + 4, 2, 1, '#1b5fc4'); }
    else if (b === 'cloud') { R(x + 2, y + 4, 7, 3, '#7cc4ff'); R(x + 3, y + 2, 4, 3, '#7cc4ff'); R(x + 6, y + 3, 3, 2, '#7cc4ff'); }
    else if (b === 'think') { for (let i = 0; i < 3; i++) R(x + 2 + i * 3, y + 4, 2, 2, Math.floor(t * 3) % 3 === i ? '#6a42d6' : '#9aa3d8'); }
    else if (b === 'read') { R(x + 2, y + 2, 7, 5, '#1b5fc4'); R(x + 3, y + 3, 5, 3, '#e8ecff'); R(x + 5, y + 2, 1, 5, '#1b5fc4'); }
    else if (b === 'run') { R(x + 2, y + 1, 7, 7, '#0b0b10'); R(x + 3, y + 3, 2, 1, '#5af78e'); R(x + 3, y + 4, 1, 1, '#5af78e'); R(x + 6, y + 6, 2, 1, '#ffcb6b'); }
    else if (b === 'web') { R(x + 3, y + 1, 5, 7, '#1b8fc4'); R(x + 2, y + 2, 7, 5, '#1b8fc4'); R(x + 5, y + 1, 1, 7, '#e8ecff'); R(x + 2, y + 4, 7, 1, '#e8ecff'); }
    else if (b === 'agent') { R(x + 2, y + 2, 3, 3, '#6a42d6'); R(x + 6, y + 4, 3, 3, '#6a42d6'); R(x + 4, y + 4, 2, 1, '#6a42d6'); }
  }

  function drawOverlay(c) {
    if (!c.visible) return;
    const x = Math.round(c.x * 16), y = Math.round(c.y * 16);
    if (c.sparkleUntil && t < c.sparkleUntil) { // level-up celebration: twinkling stars around the character
      for (let i = 0; i < 6; i++) {
        const a = t * 3 + i * 1.05;
        if (Math.floor(t * 8 + i) % 2) R(x + 7 + Math.round(Math.cos(a) * 11), y + 6 + Math.round(Math.sin(a) * 11), 2, 2, i % 2 ? '#ffd34e' : '#fff6c2');
      }
    }
    if (c.id === selected) {
      const g = '#5af78e';
      const bx = x, by = y - 4, bw = 14, bh = 20; // corner brackets around the selected character
      for (const [cx, cy, sx, sy] of [[bx, by, 1, 1], [bx + bw - 1, by, -1, 1], [bx, by + bh - 1, 1, -1], [bx + bw - 1, by + bh - 1, -1, -1]]) {
        R(sx > 0 ? cx : cx - 2, cy, 3, 1, g);
        R(cx, sy > 0 ? cy : cy - 2, 1, 3, g);
      }
    }
    if (c.id === selected || c.id === hover) {
      const lv = levels[/^(claude|sub):/.test(c.id) ? 'claude-code' : c.id];
      const label = `${String(c.agent.name).toUpperCase().slice(0, 12)}${lv ? ` L${lv}` : ''}`;
      const w = textW(label) + 4;
      const tx = Math.max(1, Math.min(W - w - 1, x + 8 - Math.floor(w / 2)));
      const ty = Math.max(1, y - 22);
      R(tx, ty, w, 7, '#0b0e1c'); R(tx, ty, w, 1, '#5af78e');
      text(label, tx + 2, ty + 1, '#e8ecff');
    }
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawFloor();
    drawWalls();
    const occByDesk = new Map();
    for (const c of chars.values()) {
      if (c.visible && seated(c) && c.plan.desk) occByDesk.set(c.plan.desk, c);
      if (c.id === 'ollama' && c.agent.state === 'working') occByDesk.set('__ollama', c);
    }
    const list = [];
    for (const f of MAP.furniture) list.push({ k: f.type === 'sofa' ? f.y + 0.4 : f.type === 'window' ? -1 : f.type === 'board' ? f.y + 1 : f.y + f.h, draw: () => drawFurniture(f, occByDesk) });
    for (const c of chars.values()) if (c.visible) list.push({ k: c.y + 0.5, draw: () => drawChar(c) });
    list.sort((a, b) => a.k - b.k);
    for (const o of list) o.draw();
    for (const c of chars.values()) drawBubble(c);
    // desk plates (static labels)
    const plates = { A1: 'CLAUDE', A2: 'OPENCODE', A3: 'AIDER', A4: 'CODEX', A5: 'HERMES', B1: 'SESSION', B2: 'SESSION', B3: 'SESSION', B4: 'SESSION', B5: 'SESSION' };
    for (const [id, label] of Object.entries(plates)) { const d = MAP.desks[id]; text(label, d.x * 16 + 24 - Math.floor(textW(label) / 2), d.y * 16 + 17, '#7882b8'); }
    for (const c of chars.values()) drawOverlay(c);
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame); // browsers already pause this for hidden tabs
    const dt = Math.min(0.25, (ts - lastTs) / 1000 || 0);
    if (ts - lastTs < 30) return; // ~30 fps cap
    lastTs = ts;
    t += dt;
    tick(dt);
    render();
  }

  // ---------- mouse
  function pick(ev) {
    const r = canvas.getBoundingClientRect();
    const lx = ((ev.clientX - r.left) / r.width) * W;
    const ly = ((ev.clientY - r.top) / r.height) * H;
    let best = null;
    for (const c of chars.values()) {
      if (!c.visible) continue;
      const bx = c.x * 16 + 1, by = c.y * 16 - 3;
      if (lx >= bx && lx <= bx + 13 && ly >= by && ly <= by + 19 && (!best || c.y > best.y)) best = c;
    }
    return best;
  }
  canvas.addEventListener('mousemove', (e) => { const c = pick(e); hover = c ? c.id : null; canvas.classList.toggle('pointer', Boolean(c)); });
  canvas.addEventListener('mouseleave', () => { hover = null; });
  canvas.addEventListener('click', (e) => { const c = pick(e); selected = c ? c.id : null; onSelect(selected); });

  resize();
  window.addEventListener('resize', resize);
  raf = requestAnimationFrame(frame);

  let settled = false;
  /** Fast-forward the simulation so everyone is already at their post on first load. */
  function settle(seconds = 45) { for (let s = 0; s < seconds * 10; s++) tick(0.1); }

  return {
    update(list) {
      agents = list;
      applyPlans();
      if (!settled && list.length) { settled = true; settle(); }
    },
    select(id) { selected = id; },
    setLevels(map) { levels = map; },
    celebrate(id) { const c = chars.get(id) || [...chars.values()].find((x) => x.plan.mode && /^(claude|sub):/.test(x.id) && id === 'claude-code'); if (c) c.sparkleUntil = t + 3.5; },
    resize,
    destroy() { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); },
  };
}
