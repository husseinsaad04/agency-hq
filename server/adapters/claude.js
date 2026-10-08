// Claude Code: reads ONLY the small live-session registry (~/.claude/sessions/<pid>.json).
// Never reads transcripts, .key files, socket paths or any message content.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HOME } from '../config.js';
import { mk } from '../registry.js';
import { activity as defaultActivity } from '../activity.js';

export const name = 'claude';
export const staticIds = ['claude-code'];

const STATE_OF = { busy: 'working', working: 'working', idle: 'idle', waiting: 'waiting' };

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Pure: turn parsed session files into agent snapshots. */
const VERB = { read: 'reading', edit: 'editing', run: 'running', web: 'browsing', agent: 'delegating to', think: 'thinking', tool: 'using' };
export function describeActivity(a) {
  if (!a || !a.kind) return '';
  if (a.kind === 'think') return 'thinking';
  const what = a.kind === 'tool' ? a.target || a.tool : a.target;
  return `${VERB[a.kind] || 'using'} ${what || (a.kind === 'run' ? 'a command' : a.kind === 'read' ? 'files' : '')}`.trim();
}

/** Pure: turn parsed session files (plus optional live hook activity) into agent snapshots. */
export function buildAgents(sessions, now = Date.now(), act = () => null) {
  const live = sessions.filter((s) => s && Number.isInteger(s.pid) && typeof s.sessionId === 'string');
  const out = [];
  const subs = [];
  let busy = 0;
  let headActivity = null;
  for (const s of live) {
    const key = s.sessionId.slice(0, 8).toLowerCase();
    const info = act(key);
    let state = STATE_OF[s.status] || 'unknown';
    if (state !== 'working' && info && info.waiting) state = 'waiting';
    if (state === 'working') busy += 1;
    const label = (typeof s.name === 'string' && s.name.trim()) || path.basename(String(s.cwd || '')) || 'session';
    const ageS = s.updatedAt ? Math.max(0, Math.round((now - s.updatedAt) / 1000)) : null;
    const doing = state === 'working' ? describeActivity(info) : state === 'waiting' ? 'waiting for you (permission)' : '';
    if (state === 'working' && info && info.kind && !headActivity) headActivity = { ...info, label: doing };
    const id = `claude:${key}`;
    out.push(
      mk(
        id,
        state,
        `${path.basename(String(s.cwd || ''))} · ${doing || (ageS === null ? '' : `updated ${ageS}s ago`)}`,
        { pid: s.pid, cwd: s.cwd, startedAt: s.startedAt, updatedAt: s.updatedAt, entrypoint: s.entrypoint, activity: info && info.kind ? { kind: info.kind, target: info.target } : null },
        { name: label.slice(0, 60), role: s.entrypoint === 'cli' ? 'Terminal session' : 'Desktop session', kind: 'session' }
      )
    );
    for (const sub of (info && info.subs) || []) {
      subs.push(mk(`sub:${key}:${sub.id}`.slice(0, 48), 'working', `helping ${label.slice(0, 30)}`, { parent: id, type: sub.type, activity: { kind: 'agent', target: sub.type } }, { name: `Helper (${sub.type})`.slice(0, 40), role: 'Sub-agent', kind: 'subagent' }));
    }
  }
  const head = live.length
    ? mk('claude-code', busy ? 'working' : 'idle', `${live.length} session${live.length === 1 ? '' : 's'}, ${busy} busy${headActivity ? ` · ${headActivity.label}` : ''}`, { sessions: live.length, busy, activity: headActivity ? { kind: headActivity.kind, target: headActivity.target } : null })
    : mk('claude-code', 'standby', 'no sessions open', { sessions: 0, busy: 0 });
  return [head, ...out, ...subs];
}

export async function collect({ sessionsDir = path.join(HOME, '.claude', 'sessions'), alive = pidAlive, now = Date.now(), tracker = defaultActivity } = {}) {
  let files = [];
  try {
    files = (await fs.readdir(sessionsDir)).filter((f) => /^\d+\.json$/.test(f)); // skips *.key files
  } catch {
    return buildAgents([], now);
  }
  tracker.prune(now);
  const sessions = [];
  for (const f of files) {
    try {
      const d = JSON.parse(await fs.readFile(path.join(sessionsDir, f), 'utf8'));
      if (alive(d.pid)) {
        // copy only whitelisted fields
        const { pid, sessionId, cwd, name, status, startedAt, updatedAt, entrypoint } = d;
        sessions.push({ pid, sessionId, cwd, name, status, startedAt, updatedAt, entrypoint });
      }
    } catch {
      /* unreadable or half-written file: skip */
    }
  }
  return buildAgents(sessions, now, (k) => tracker.get(k, now));
}
