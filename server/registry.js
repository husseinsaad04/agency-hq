// The cast: every agent-like thing I run. Adapters fill in live state; this file only names them.
export const STATES = ['working', 'waiting', 'idle', 'running', 'scheduled', 'standby', 'stopped', 'error', 'unknown'];

export const ROSTER = {
  'claude-code': { name: 'Claude Code', role: 'Lead Architect', kind: 'agent' },
  opencode: { name: 'OpenCode', role: 'Generalist', kind: 'agent' },
  aider: { name: 'Aider', role: 'Quick-Fix Engineer', kind: 'agent' },
  codex: { name: 'Codex CLI', role: 'Safety Reviewer', kind: 'agent' },
  hermes: { name: 'Hermes', role: 'Sandboxed Explorer', kind: 'agent' },
  openclaw: { name: 'OpenClaw', role: 'Quarantined Assistant', kind: 'agent' },
  jarvis: { name: 'Jarvis', role: 'Receptionist', kind: 'agent' },
  'job-jarvis-health': { name: 'Jarvis Night Watch', role: 'Night Watch', kind: 'job' },
  'job-clipflow-monitor': { name: 'Clipflow Night Watch', role: 'Night Watch', kind: 'job' },
  'clipflow-monitor': { name: 'Clipflow Monitor', role: 'Field Scout', kind: 'service' },
  'routine-clipflow': { name: 'Clipflow Reviewer (cloud)', role: 'Cloud Scout', kind: 'job' },
  ollama: { name: 'Ollama', role: 'Engine Room', kind: 'service' },
};

/** Build an agent snapshot. Unknown ids are allowed (dynamic ones like Claude sessions). */
export function mk(id, state, detail = '', meta = {}, override = {}) {
  const base = ROSTER[id] || { name: id, role: 'Agent', kind: 'agent' };
  return {
    id,
    name: override.name || base.name,
    role: override.role || base.role,
    kind: override.kind || base.kind,
    state: STATES.includes(state) ? state : 'unknown',
    detail: String(detail).slice(0, 160),
    meta,
  };
}

/** A snapshot for every static roster id an adapter owns, used when that adapter fails. */
export function unknownFor(ids, why) {
  return ids.map((id) => mk(id, 'unknown', `collector error: ${why}`));
}
