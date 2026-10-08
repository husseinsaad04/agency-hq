// In-memory "what is each Claude session doing right now", fed by hook events. Nothing here is persisted.
export class ActivityTracker {
  constructor({ ttlMs = 8000, sessionKeepMs = 30 * 60 * 1000, subKeepMs = 15 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.sessionKeepMs = sessionKeepMs;
    this.subKeepMs = subKeepMs;
    this.sessions = new Map();
  }

  ingest(p, now = Date.now()) {
    let s = this.sessions.get(p.session);
    if (p.event === 'end') { this.sessions.delete(p.session); return; }
    if (!s) { s = { phase: 'idle', kind: null, tool: '', target: '', since: now, last: now, waiting: false, subs: new Map() }; this.sessions.set(p.session, s); }
    s.last = now;
    switch (p.event) {
      case 'start': s.phase = 'idle'; s.waiting = false; break;
      case 'prompt': s.phase = 'think'; s.kind = 'think'; s.tool = ''; s.target = ''; s.since = now; s.waiting = false; break;
      case 'tool': s.phase = 'tool'; s.kind = p.kind; s.tool = p.tool; s.target = p.target || ''; s.since = now; s.waiting = false; break;
      case 'notify': if (p.note !== 'other') s.waiting = true; break;
      case 'stop': s.phase = 'idle'; s.kind = null; s.waiting = false; s.since = now; break;
      case 'sub_start': s.subs.set(p.agent, { type: p.atype || 'helper', since: now }); break;
      case 'sub_stop': s.subs.delete(p.agent); break;
      default: break;
    }
  }

  /** Current activity for a session key, or null if we have never heard from it. */
  get(session, now = Date.now()) {
    const s = this.sessions.get(session);
    if (!s) return null;
    const age = now - s.since;
    const fresh = s.phase !== 'idle' && age < this.ttlMs;
    return {
      kind: fresh ? s.kind : s.phase === 'idle' ? null : 'think', // a stale tool means the model is thinking between tools
      tool: fresh ? s.tool : '',
      target: fresh ? s.target : '',
      waiting: s.waiting,
      lastEventAgeMs: now - s.last,
      subs: [...s.subs.entries()].filter(([, v]) => now - v.since < this.subKeepMs).map(([id, v]) => ({ id, type: v.type })),
    };
  }

  prune(now = Date.now()) {
    for (const [k, s] of this.sessions) if (now - s.last > this.sessionKeepMs) this.sessions.delete(k);
  }
}

export const activity = new ActivityTracker();
