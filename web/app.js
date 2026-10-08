// Agency HQ UI. All dynamic text goes through textContent (never innerHTML).
import { createTower } from './tower.js';
import {createProjectChatView} from './project-chat.js';
import { createMissions } from './missions.js';
import { createCompanyView } from './company.js';
import { createPaperclipView } from './paperclip.js';

const nonce = document.querySelector('meta[name="ahq-nonce"]').content;
const $ = (id) => document.getElementById(id);

const ORDER = ['claude-code', 'opencode', 'aider', 'codex', 'hermes', 'openclaw', 'jarvis', 'job-jarvis-health', 'job-clipflow-monitor', 'clipflow-monitor', 'routine-clipflow', 'ollama'];
const LABEL = { working: 'WORKING', waiting: 'NEEDS YOU', running: 'ONLINE', scheduled: 'SCHEDULED', idle: 'IDLE', standby: 'ON CALL', stopped: 'OFFLINE', error: 'ERROR', unknown: 'UNKNOWN' };

let actions = [];
let lastState = null;
let currentRun = null;
let office = null;

function el(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue; // an empty attribute means "not set", never the text "null"
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c) n.append(c);
  return n;
}

// ---------- pixel avatar (deterministic per agent, expression follows state)
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function avatar(id, state) {
  const h = hash(id);
  const dim = ['stopped', 'standby', 'unknown'].includes(state);
  const hue = h % 360;
  const skin = dim ? 'hsl(230 8% 55%)' : `hsl(${hue} 60% 62%)`;
  const dark = dim ? 'hsl(230 10% 22%)' : `hsl(${hue} 50% 24%)`;
  const accent = `hsl(${(hue + 170) % 360} 75% 62%)`;
  const px = [];
  const put = (x, y, c) => px.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${c}"/>`);
  for (let x = 0; x < 4; x++) if ((h >> (x + 3)) & 1) { put(x + 1, 0, accent); put(6 - x, 0, accent); }
  for (let y = 1; y <= 6; y++) for (let x = 1; x <= 6; x++) put(x, y, skin);
  const eye = state === 'error' ? '#ff4b63' : dark;
  if (['stopped', 'standby', 'unknown'].includes(state)) { put(2, 3, eye); put(5, 3, eye); put(2, 4, skin); }
  else if (state === 'idle' || state === 'scheduled') { put(2, 4, eye); put(5, 4, eye); }
  else { put(2, 3, eye); put(5, 3, eye); put(2, 2, skin); }
  if (state === 'error') { put(3, 5, '#ff4b63'); put(4, 5, '#ff4b63'); put(2, 6, '#ff4b63'); put(5, 6, '#ff4b63'); }
  else if (state === 'working') { put(2, 5, dark); put(3, 5, dark); put(4, 5, dark); put(5, 5, dark); }
  else { put(3, 5, dark); put(4, 5, dark); }
  if (state === 'waiting') { put(3, 0, '#ffcb6b'); put(4, 0, '#ffcb6b'); }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges">${px.join('')}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function ago(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// ---------- which buttons make sense in which state
const ACTIVE = ['running', 'working', 'scheduled', 'waiting'];
const OFF = ['stopped', 'standby', 'unknown'];
function visible(actionId, state) {
  if (/\.(stop|restart|pause)(\.|$)/.test(actionId)) return ACTIVE.includes(state);
  if (/\.(start|resume)(\.|$)/.test(actionId)) return OFF.includes(state);
  return true;
}
const danger = (a) => /\.(stop|pause)(\.|$)/.test(a.id);

function controls(a) {
  const acts = actions.filter((x) => x.agents.includes(a.id) && visible(x.id, a.state));
  return acts.length ? el('div', { class: 'btns' }, acts.map((x) => el('button', { class: `btn${danger(x) ? ' danger' : ''}`, type: 'button', onclick: () => openAction(x, a), text: x.label }))) : null;
}

function card(a, now, withControls) {
  return el('article', { class: `card s-${a.state}`, 'data-id': a.id }, [
    el('div', { class: 'head' }, [
      el('img', { class: 'avatar', alt: '', src: avatar(a.id, a.state), width: 56, height: 56 }),
      el('div', { class: 'who' }, [el('div', { class: 'name', text: a.name }), el('div', { class: 'role', text: a.role })]),
      withControls ? lvTag(a) : null,
    ]),
    el('div', {}, [el('span', { class: `badge b-${a.state}`, text: LABEL[a.state] || a.state })]),
    el('div', { class: 'detail', text: a.detail || ' ' }),
    el('div', { class: 'since', text: `in this state ${ago(a.since, now)}` }),
    withControls ? controls(a) : null,
  ]);
}

// ---------- the "computer screen" for the selected agent (real data only)
let selectedId = null;
let eventsCache = [];
let lastRun = null;
// ---------- levels (all numbers come from the server's ledger; this file only displays them)
let progressMap = {};
let studio = null;
let ledgerCache = {};
let ledgerAt = 0;
const credit = (id) => (/^(claude|sub):/.test(id) ? 'claude-code' : id);
const NO_RATING = new Set(['routine-clipflow']);
const bar = (xp, floor, next, n = 12) => { const f = Math.max(0, Math.min(n, Math.round(((xp - floor) / (next - floor)) * n))); return '█'.repeat(f) + '░'.repeat(n - f); };

function lvTag(a) {
  const p = progressMap[credit(a.id)];
  return el('div', { class: `lv${p ? ' has' : ''}`, text: p ? `LV ${p.level}` : 'LV 1', title: p ? `${p.rank} · ${p.xp} XP · XP comes only from verified results` : 'No verified results yet. XP comes only from your approvals, passing tests and nightly checks OK.' });
}

async function verdict(agentId, v) {
  try {
    const r = await (await fetch('/api/verdict', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ahq-nonce': nonce }, body: JSON.stringify({ agent: agentId, verdict: v }) })).json();
    if (!r.ok) return toast(r.message || 'could not record that', 'err');
    toast(v === 'approve' ? `+${r.xp} XP for ${credit(agentId)} · thanks!` : 'Noted. No XP, and it counts against its rank.', v === 'approve' ? 'ok' : 'err', r.id);
    ledgerAt = 0;
  } catch (e) { toast(`Could not reach Agency HQ: ${e.message}`, 'err'); }
}

function verdictRow(a) {
  if (NO_RATING.has(credit(a.id)) || a.id.startsWith('hq:')) return null;
  const who = credit(a.id) === a.id ? a.name : 'Claude Code';
  return el('div', { class: 'btns' }, [
    el('button', { class: 'btn good', type: 'button', title: `Tell ${who} it did well (+50 XP)`, onclick: () => verdict(a.id, 'approve'), text: '✓ Good result' }),
    el('button', { class: 'btn bad', type: 'button', title: `Mark ${who}'s work as not good (no XP, counts against rank)`, onclick: () => verdict(a.id, 'reject'), text: '✗ Not good' }),
  ]);
}

function levelBlock(a) {
  const c = credit(a.id);
  const p = progressMap[c];
  const out = [el('div', { class: 'sub', text: 'LEVEL' })];
  if (!p) {
    out.push(el('div', { class: 'ln xp' }, [el('b', { text: 'LV' }), '1 · Intern · 0 XP']));
    out.push(el('div', { class: 'ln evt', text: 'no verified results yet' }));
  } else {
    out.push(el('div', { class: 'ln xp' }, [el('b', { text: 'LV' }), `${p.level} · ${p.rank}`]));
    out.push(el('div', { class: 'ln xp' }, [el('b', { text: 'XP' }), el('span', { class: 'xpbar', text: bar(p.xp, p.floor, p.next) }), ` ${p.xp}/${p.next}`]));
    out.push(el('div', { class: 'ln' }, [el('b', { text: 'RATE' }), p.passRate === null ? '—' : `${Math.round(p.passRate * 100)}% pass · last ${p.verdicts}`]));
  }
  for (const e of (ledgerCache[c] || []).filter((x) => !x.revoked).slice(0, 4)) out.push(el('div', { class: 'ln evt' }, [el('span', { class: 'plus', text: e.xp ? `+${e.xp}` : ' 0' }), `  ${e.text}`]));
  if (credit(a.id) !== a.id) out.push(el('div', { class: 'rule', text: 'Sessions share Claude Code’s level.' }));
  out.push(el('div', { class: 'rule', text: 'XP only from: your approvals, passing tests (auto, capped), nightly checks OK.' }));
  return out;
}

async function loadLedger() {
  if (!selectedId || Date.now() - ledgerAt < 3000) return;
  ledgerAt = Date.now();
  const c = credit(selectedId);
  try { ledgerCache[c] = (await (await fetch(`/api/ledger?agent=${encodeURIComponent(c)}`)).json()).entries; renderScreen(); } catch { /* ignore */ }
}

let lastLevels = null;
function handleProgress(state) {
  progressMap = state.progress || {};
  studio = state.studio || null;
  $('studio').textContent = studio ? `★ STUDIO LV ${studio.level} · ${studio.xp} XP` : '';
  const now = Object.fromEntries(Object.entries(progressMap).map(([k, v]) => [k, v.level]));
  if (lastLevels) for (const [k, lv] of Object.entries(now)) if (lv > (lastLevels[k] || 1)) {
    toast(`🎉 ${(state.agents.find((a) => a.id === k) || { name: k }).name} reached level ${lv}!`, 'ok');
    if (office) office.celebrate(k);
  }
  lastLevels = now;
  if (office) office.setLevels(now);
}

const STATE_NOTE = { working: 'busy right now', waiting: 'is waiting for you', running: 'online', scheduled: 'waiting for its next run', idle: 'idle', standby: 'on call, not running', stopped: 'offline', error: 'has an error', unknown: 'status unknown' };

function renderScreen() {
  const box = $('screen');
  const a = lastState && lastState.agents.find((x) => x.id === selectedId);
  if (!a) {
    box.replaceChildren(
      el('div', { class: 'bar' }, [el('span', { text: 'SCREEN' }), el('span', { text: 'no agent selected' })]),
      el('div', { class: 'body' }, [el('div', { class: 'ln cursor', text: 'Choose a connected system to inspect its status and recent activity.' })])
    );
    return;
  }
  const now = lastState.now;
  const mine = eventsCache.filter((e) => e.agent_id === a.id).slice(0, 6);
  const lines = [
    el('div', { class: `ln${a.state === 'waiting' ? ' warn' : a.state === 'error' ? ' bad' : ''}` }, [el('b', { text: 'STATE' }), `${LABEL[a.state] || a.state} · ${STATE_NOTE[a.state] || ''}`]),
    el('div', { class: 'ln' }, [el('b', { text: 'ROLE' }), a.role]),
    el('div', { class: 'ln' }, [el('b', { text: 'DOING' }), a.detail || '—']),
    el('div', { class: 'ln' }, [el('b', { text: 'SINCE' }), `${ago(a.since, now)} ago`]),
  ];
  if (a.meta && a.meta.cwd) lines.push(el('div', { class: 'ln' }, [el('b', { text: 'FOLDER' }), String(a.meta.cwd).split('/').slice(-2).join('/')]));
  const body = [...lines, ...levelBlock(a), el('div', { class: 'sub', text: 'RECENT' })];
  if (mine.length) for (const e of mine) body.push(el('div', { class: 'ln evt', text: `${new Date(e.ts).toLocaleTimeString()}  ${e.summary.replace(`${a.name}: `, '')}` }));
  else body.push(el('div', { class: 'ln evt', text: 'nothing new since Agency HQ started' }));
  if (a.id === 'hermes' && lastRun) {
    body.push(el('div', { class: 'sub', text: `LAST TASK · ${lastRun.project} · ${lastRun.status}` }));
    body.push(el('pre', { text: (lastRun.output || '(waiting for output…)').split('\n').slice(-8).join('\n') }));
  }
  box.replaceChildren(
    el('div', { class: 'bar' }, [el('span', { text: a.name.toUpperCase().slice(0, 28) }), el('span', { text: LABEL[a.state] || a.state })]),
    el('div', { class: 'body' }, body),
    verdictRow(a),
    a.meta?.taskId ? el('div', { class: 'btns' }, [el('button', { class: 'btn primary', type: 'button', text: 'View assignment', onclick: () => { setView('tasks'); missions.showTask(a.meta.taskId); } })]) : null,
    a.kind === 'session' || a.kind === 'subagent' ? null : controls(a)
  );
}

function render(state) {
  lastState = state;
  handleProgress(state);
  const { agents, counts, now } = state;
  const roster = agents.filter((a) => a.kind !== 'session' && a.kind !== 'subagent').sort((p, q) => (ORDER.indexOf(p.id) + 100) % 100 - (ORDER.indexOf(q.id) + 100) % 100 || p.name.localeCompare(q.name));
  const sessions = agents.filter((a) => a.kind === 'session' || a.kind === 'subagent');
  $('roster').replaceChildren(...roster.map((a) => card(a, now, true)));
  $('sessions').replaceChildren(...(sessions.length ? sessions.map((a) => card(a, now, false)) : [el('div', { class: 'detail', text: 'No Claude Code sessions are open.' })]));
  const chip = (label, n) => el('span', { class: 'chip' }, [`${label} `, el('b', { text: String(n) })]);
  $('counts').replaceChildren(
    chip('▶ working', counts.working || 0), chip('! needs you', counts.waiting || 0),
    chip('● online', (counts.running || 0) + (counts.scheduled || 0)), chip('… on call', (counts.idle || 0) + (counts.standby || 0)),
    chip('■ offline', counts.stopped || 0), chip('✕ errors', (counts.error || 0) + (counts.unknown || 0))
  );
  if (office) office.update(agents);
  renderScreen();
  loadLedger();
}

// ---------- actions
function toast(msg, kind = 'ok', undoId = null) {
  const t = $('toast');
  t.textContent = msg;
  if (undoId) {
    t.append(el('button', { class: 'btn', type: 'button', text: 'Undo', onclick: async () => {
      const r = await (await fetch('/api/verdict/undo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ahq-nonce': nonce }, body: JSON.stringify({ id: undoId }) })).json();
      t.className = 'toast'; toast(r.ok ? 'Taken back.' : 'Too late to undo that one.', r.ok ? 'ok' : 'err'); ledgerAt = 0;
    } }));
  }
  t.className = `toast show ${kind}${undoId ? ' sticky' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = 'toast'), undoId ? 9000 : 4500);
}

async function post(id, params, confirmed) {
  const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ahq-nonce': nonce }, body: JSON.stringify({ id, params, confirmed }) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

function openAction(action, agent) {
  if (!action.params.length && !action.confirm) return doAction(action, {}, false, agent);
  $('dlgTitle').textContent = `${agent.name}: ${action.label}`;
  $('dlgNote').textContent = action.note || '';
  $('dlgConfirm').textContent = action.confirm || '';
  const fields = action.params.map((p) => {
    const id = `f-${p.name}`;
    const input = p.type === 'select'
      ? el('select', { id, name: p.name, required: '' }, [el('option', { value: '', text: `Choose a ${p.label.toLowerCase()}…` }), ...(p.options || []).map((o) => el('option', { value: o, text: o }))])
      : el('textarea', { id, name: p.name, maxlength: String(p.maxLen || 2000), required: '' });
    return el('div', { class: 'field' }, [el('label', { for: id, text: p.label }), input]);
  });
  $('dlgFields').replaceChildren(...fields);
  $('dlgOk').textContent = action.confirm ? 'Yes, do it' : 'Go';
  const dlg = $('dlg');
  $('dlgForm').onsubmit = (e) => {
    e.preventDefault();
    const params = {};
    for (const p of action.params) params[p.name] = $(`f-${p.name}`).value;
    dlg.close();
    doAction(action, params, Boolean(action.confirm), agent);
  };
  $('dlgCancel').onclick = () => dlg.close();
  dlg.showModal();
}

async function doAction(action, params, confirmed, agent) {
  toast(`${agent.name}: ${action.label}…`, 'ok');
  try {
    const r = await post(action.id, params, confirmed);
    if (r.ok) {
      toast(`${agent.name}: ${action.label} — ${r.runId ? 'started' : 'done'}`, 'ok');
      if (r.runId) { currentRun = r.runId; pollRun(); }
    } else toast(`${agent.name}: ${action.label} failed — ${r.message || r.status}`, 'err');
  } catch (e) {
    toast(`Could not reach Agency HQ: ${e.message}`, 'err');
  }
  loadLog();
}

const rated = new Set();
function renderRunVerdict() {
  const box = $('runVerdict');
  if (!lastRun || lastRun.status === 'running' || rated.has(lastRun.id)) { box.replaceChildren(); return; }
  const done = (v) => { rated.add(lastRun.id); verdict('hermes', v); renderRunVerdict(); };
  box.replaceChildren(el('span', { class: 'detail', text: 'Was this result good? ' }), el('button', { class: 'btn good', type: 'button', onclick: () => done('approve'), text: '✓ Good result' }), el('button', { class: 'btn bad', type: 'button', onclick: () => done('reject'), text: '✗ Not good' }));
}

async function pollRun() {
  if (!currentRun) return;
  const runId = currentRun;
  try {
    const response = await fetch(`/api/runs/${runId}`, { signal: AbortSignal.timeout(10000) });
    if (currentRun !== runId) return;
    if (response.status === 404) {
      currentRun = null;
      toast('This task is no longer available. Check Activity for its last update.', 'err');
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const r = await response.json();
    if (currentRun !== runId) return;
    lastRun = r;
    renderScreen();
    $('runOut').textContent = `Task ${r.id} · ${r.project} · ${r.status}${r.code === null || r.code === undefined ? '' : ` (exit ${r.code})`}\n\n${r.output || '(waiting for output…)'}`;
    renderRunVerdict();
    if (r.status === 'running') setTimeout(() => { if (currentRun === runId) pollRun(); }, 1500);
    else currentRun = null;
  } catch {
    if (currentRun !== runId) return;
    $('runOut').textContent = 'Task updates interrupted; reconnecting…\n\n' + (lastRun?.output || 'Waiting for output…');
    setTimeout(() => { if (currentRun === runId) pollRun(); }, 3000);
  }
}

async function loadLog() {
  try {
    const { events } = await (await fetch('/api/events?limit=120')).json();
    eventsCache = events;
    $('log').replaceChildren(...events.slice(0, 40).map((e) => el('li', {}, [el('time', { text: new Date(e.ts).toLocaleTimeString() }), e.summary])));
    renderScreen();
  } catch { /* ignore */ }
}

// ---------- live updates
const pageBoot = document.querySelector('meta[name="ahq-boot"]')?.content;
// HQ restarted under an open tab: its nonce is stale. Reload (keeps all checks), unless typed text would be lost.
function handleRestart(es) {
  es.close();
  const typing = [...document.querySelectorAll('textarea,input[type=text]')].some(el => el.value.trim());
  if (!typing) { $('conn').textContent = 'HQ restarted — reloading…'; setTimeout(() => location.reload(), 600); return; }
  const c = $('conn'); c.className = 'conn bad'; c.textContent = 'HQ restarted — click to reload (your typed text will be lost)';
  c.style.cursor = 'pointer'; c.onclick = () => location.reload();
}
function connect() {
  const es = new EventSource('/api/stream');
  let t = 0;
  es.addEventListener('state', (e) => {
    const data = JSON.parse(e.data);
    if (data.boot && data.boot !== pageBoot) return handleRestart(es);
    $('conn').textContent = 'live'; $('conn').className = 'conn ok';
    render(data);
    if (Date.now() - t > 2500) { t = Date.now(); loadLog(); }
  });
  es.onerror = () => { $('conn').textContent = 'disconnected, retrying…'; $('conn').className = 'conn bad'; };
}

// ---------- Office / Roster tabs
// ---------- self-improvement lab view
let labData = null;
let labRun = null;
let labTimer = null;
const f3 = (x) => (Math.round(x * 100) / 100).toFixed(2);
const pctOf = (x) => `${Math.round(x * 100)}%`;

function ask(title, note, okLabel) {
  return new Promise((resolve) => {
    const dlg = $('dlg');
    $('dlgTitle').textContent = title;
    $('dlgNote').textContent = '';
    $('dlgFields').replaceChildren();
    $('dlgConfirm').textContent = note;
    $('dlgOk').textContent = okLabel;
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    $('dlgForm').onsubmit = (e) => { e.preventDefault(); dlg.close(); end(true); };
    $('dlgCancel').onclick = () => { dlg.close(); end(false); };
    dlg.addEventListener('close', () => end(false), { once: true });
    dlg.showModal();
  });
}

async function labPost(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ahq-nonce': nonce }, body: JSON.stringify(body) });
  return r.json().catch(() => ({ ok: false, message: 'unexpected answer' }));
}

async function loadLab() {
  try {
    labData = await (await fetch('/api/lab')).json();
    labRun = (await (await fetch('/api/lab/run')).json()).run;
    const pending = (labData.subjects || []).reduce((n, x) => n + x.proposals.filter((p) => p.status === 'pending').length, 0);
    $('tabLab').replaceChildren('Lab', ...(pending ? [el('span', { class: 'dot', text: ` ●${pending}` })] : []));
    if (!$('labView').hidden) renderLab();
  } catch { /* lab not available */ }
}

function metricRow(label, a, b, fmt = f3) {
  const better = b > a + 1e-9, worse = b < a - 1e-9;
  return el('tr', {}, [el('td', { text: label }), el('td', { text: fmt(a) }), el('td', { class: better ? 'up' : worse ? 'down' : '', text: `${fmt(b)}${better ? ' ▲' : worse ? ' ▼' : ''}` })]);
}

function proposalCard(x, sub) {
  const m = x.metrics || {};
  const rows = m.baseline ? [
    metricRow('Practice score (12 cases)', m.baseline.dev.mean, m.dev.mean),
    metricRow('Hidden score (8 cases it never saw)', m.baseline.held.mean, m.held.mean),
    metricRow('Practice cases fully correct', m.baseline.dev.strict, m.dev.strict, pctOf),
    metricRow('Hidden cases fully correct', m.baseline.held.strict, m.held.strict, pctOf),
  ] : [];
  if (m.claude) rows.push(metricRow(`Re-check with ${m.claude.model} (all cases)`, m.claude.old.mean, m.claude.new.mean));
  const diff = el('pre', { class: 'diff' }, (x.diff || []).map((l) => el('div', { class: l.t, text: `${l.t === 'add' ? '+ ' : l.t === 'del' ? '- ' : '  '}${l.text}` })));
  const btns = x.status !== 'pending' ? null : el('div', { class: 'btns' }, [
    el('button', { class: 'btn good', type: 'button', text: '✓ Approve and deploy', onclick: async () => {
      if (!(await ask('Deploy this prompt?', `This replaces the live instructions for ${sub.name} (a backup is kept and “Revert” undoes it). You earn the agent +50 XP.`, 'Yes, deploy'))) return;
      const r = await labPost('/api/lab/decide', { id: x.id, decision: 'approve', confirmed: true });
      toast(r.ok === false ? r.message : `Deployed. +${r.xp || 0} XP.`, r.ok === false ? 'err' : 'ok'); loadLab(); ledgerAt = 0;
    } }),
    el('button', { class: 'btn bad', type: 'button', text: '✗ Reject', onclick: async () => { const r = await labPost('/api/lab/decide', { id: x.id, decision: 'reject' }); toast(r.ok === false ? r.message : 'Rejected. Nothing changed.', r.ok === false ? 'err' : 'ok'); loadLab(); } }),
    el('button', { class: 'btn', type: 'button', text: 'Re-check with Claude', title: 'Scores old and new with real Claude. Uses your Claude plan.', onclick: async () => {
      if (!(await ask('Re-check with Claude?', 'This makes about 40 small Claude calls (the Haiku model) and counts against your plan usage.', 'Yes, run it'))) return;
      toast('Checking with Claude… this takes a minute or two.', 'ok');
      const r = await labPost('/api/lab/verify', { id: x.id, confirmed: true });
      toast(r.ok === false ? r.message : 'Claude re-check finished.', r.ok === false ? 'err' : 'ok'); loadLab();
    } }),
  ]);
  return el('div', { class: `prop ${x.status}` }, [
    el('h4', {}, [`Proposal #${x.id}`, el('span', { class: `pill ${x.status}`, text: x.status.toUpperCase() }), el('span', { class: 'lab-meta', text: new Date(x.ts).toLocaleString() })]),
    rows.length ? el('table', { class: 'metrics' }, [el('tr', {}, [el('th', { text: 'Exam' }), el('th', { text: 'Before' }), el('th', { text: 'After' })]), ...rows]) : null,
    m.notes && m.notes.length ? el('div', { class: 'lab-meta', text: `Notes: ${m.notes.join(' | ')}` }) : null,
    el('div', { class: 'lab-meta', text: 'What would change (green = added, red = removed):' }),
    diff, btns,
  ]);
}

function renderLab() {
  if (!labData) return;
  const body = labData.subjects.map((s) => {
    const running = labRun && labRun.subject === s.id && labRun.status === 'running';
    const showLog = labRun && labRun.subject === s.id;
    return el('div', { class: 'lab-card' }, [
      el('h3', { text: s.name }),
      el('div', { class: 'lab-meta', text: s.describe }),
      el('div', { class: 'lab-meta', text: `Exam: ${s.practiceCases} practice + ${s.hiddenCases} hidden cases · Runs on your local model (free, private) · Version ${s.versionCount}${s.lastRun ? ` · Last cycle: ${s.lastRun.outcome.replace('_', ' ')} (${new Date(s.lastRun.ts).toLocaleString()})` : ''}` }),
      el('div', { class: 'btns' }, [
        el('button', { class: 'btn primary', type: 'button', disabled: running ? '' : null, text: running ? 'Running…' : 'Run an improvement cycle', onclick: async () => {
          if (!(await ask('Run an improvement cycle?', 'It tests the current prompt, asks your local model for a better one, and tests that too. Takes about 10 to 20 minutes, uses no Claude, and changes nothing until you approve.', 'Start'))) return;
          const r = await labPost('/api/lab/run', { subject: s.id, confirmed: true });
          toast(r.ok ? 'Started. You can watch the progress here.' : r.message, r.ok ? 'ok' : 'err'); loadLab();
        } }),
        el('button', { class: 'btn', type: 'button', disabled: running ? '' : null, text: 'Run with Claude Sonnet (more accurate)', title: 'Uses the same model as the nightly job. Counts against your Claude plan.', onclick: async () => {
          if (!(await ask('Run the cycle with real Claude?', 'The test-taker is Claude Sonnet, the same model the nightly job uses, so scores are more trustworthy. It makes roughly 60 to 120 small Claude calls and counts against your plan usage. Still changes nothing until you approve.', 'Yes, use Claude'))) return;
          const r = await labPost('/api/lab/run', { subject: s.id, worker: 'claude', confirmed: true });
          toast(r.ok ? 'Started with Claude. Watch the progress here.' : r.message, r.ok ? 'ok' : 'err'); loadLab();
        } }),
        s.canRevert ? el('button', { class: 'btn danger', type: 'button', text: 'Revert to previous version', onclick: async () => {
          if (!(await ask('Revert?', 'Puts the previous prompt back (the current one stays in history) and takes back the XP it earned.', 'Yes, revert'))) return;
          const r = await labPost('/api/lab/revert', { subject: s.id, confirmed: true });
          toast(r.ok ? 'Reverted.' : r.message, r.ok ? 'ok' : 'err'); loadLab(); ledgerAt = 0;
        } }) : null,
      ]),
      showLog ? el('pre', { class: `lab-log${labRun.status === 'error' ? ' err' : ''}`, text: labRun.log.join('\n') || 'starting…' }) : null,
      el('details', { class: 'cur' }, [el('summary', { text: 'Show the current live instructions' }), el('pre', { text: s.current })]),
      s.lastRun && s.lastRun.summary && s.lastRun.summary.attempts && s.lastRun.summary.attempts.length ? el('details', { class: 'cur' }, [el('summary', { text: `What the improver tried in the last cycle (${s.lastRun.summary.attempts.length})` }), ...s.lastRun.summary.attempts.map((a) => el('div', { class: 'lab-meta' }, [el('b', { text: `Attempt ${a.n}: ${a.outcome}${a.dev !== null ? ` (practice ${f3(a.dev)}${a.held !== null ? `, hidden ${f3(a.held)}` : ''})` : ''}` }), el('pre', { text: a.text || '(nothing returned)' })]))]) : null,
      ...(s.proposals.length ? [el('div', { class: 'sub lab-meta', text: 'PROPOSALS' }), ...s.proposals.map((x) => proposalCard(x, s))] : [el('div', { class: 'lab-meta', text: 'No proposals yet. Run a cycle to see if the agent can find a better version of its instructions.' })]),
    ]);
  });
  $('labBody').replaceChildren(...body);
  clearTimeout(labTimer);
  labTimer = setTimeout(loadLab, labRun && labRun.status === 'running' ? 2500 : 12000);
}

function setView(v) {
  const views = { office: 'officeView', roster: 'rosterView', lab: 'labView', tasks: 'tasksView', company: 'companyView', paperclip: 'paperclipView' };
  if (!views[v]) v = 'office';
  for (const [name, id] of Object.entries(views)) {
    $(id).hidden = name !== v;
    $(`tab${name[0].toUpperCase()}${name.slice(1)}`).setAttribute('aria-pressed', String(name === v));
  }
  $('bottom').hidden = v !== 'roster';
  window.scrollTo({top:0,behavior:'instant'});
  try { localStorage.setItem('ahq-view', v); } catch { /* storage may be unavailable */ }
  if (v === 'office' && office) office.resize();
  if (v === 'lab') loadLab();
}
$('tabOffice').addEventListener('click', () => setView('office'));
$('tabRoster').addEventListener('click', () => setView('roster'));
$('tabLab').addEventListener('click', () => setView('lab'));
$('tabTasks').addEventListener('click', () => setView('tasks'));
const missions = createMissions({ nonce, toast, ask, showOffice: async task => { setView('office'); try { await office.openTask(task); } catch { toast('Could not open this specialist’s office. Try again.','err'); } } });
$('tabCompany').addEventListener('click', () => setView('company'));
$('tabPaperclip').addEventListener('click', () => setView('paperclip'));
createPaperclipView({ assign: id => { setView('tasks'); missions.assign(id); }, showTask: id => { setView('tasks'); missions.showTask(id); } });
createCompanyView({ nonce, toast, ask, assign: (id, project, instructions) => { setView('tasks'); missions.assign(id, { project, instructions }); }, showTask: id => { setView('tasks'); missions.showTask(id); } });
setInterval(loadLab, 20000); // keeps the "needs you" counter on the LAB tab fresh

office = createTower({ assign: id => { setView('tasks'); missions.assign(id); }, showTask: id => { setView('tasks'); missions.showTask(id); }, openTeam: () => setView('paperclip'), openTasks: () => { setView('tasks'); $('newTask').click(); }, onSelect: id => { selectedId = id; ledgerAt = 0; renderScreen(); loadLedger(); document.querySelector('.system-detail').open = true; } });
createProjectChatView({nonce,toast,showTask:id=>{setView('tasks');missions.showTask(id);}});
$('towerReviews').onclick = () => { setView('tasks'); missions.showReviews(); };
let startView = 'office';
try { startView = localStorage.getItem('ahq-view') || 'office'; } catch { /* ignore */ }
setView(startView);
renderScreen();

async function loadActions() {
  try {
    const response = await fetch('/api/actions', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    actions = (await response.json()).actions;
    if (lastState) render(lastState);
  } catch {
    toast('Agent controls are unavailable; retrying in a few seconds.', 'err');
    setTimeout(loadActions, 3000);
  }
}
// Live status must start even if loading the controls temporarily fails.
connect();
loadActions();
loadLog();
setInterval(() => lastState && render({ ...lastState, now: Date.now() }), 15000); // keep "x ago" fresh
