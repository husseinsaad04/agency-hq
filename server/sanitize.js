// Privacy gate for Claude Code hook events. Both the hook script and the server use this.
// We keep only: event type, a short session id, the tool category, and a harmless label
// (file BASENAME, command NAME, web HOST, subagent type). Never prompts, commands, file contents or env.
const SAFE = /[^A-Za-z0-9._ -]/g;
const clean = (s, n = 40) => String(s ?? '').replace(SAFE, '').trim().slice(0, n);
const base = (p) => clean(String(p || '').split('/').filter(Boolean).pop() || '', 40);

export const EVENTS = {
  SessionStart: 'start', SessionEnd: 'end', UserPromptSubmit: 'prompt', PreToolUse: 'tool',
  Stop: 'stop', Notification: 'notify', SubagentStart: 'sub_start', SubagentStop: 'sub_stop',
  PostToolUse: 'tool_ok', PostToolUseFailure: 'tool_fail',
};
export const KINDS = ['read', 'edit', 'run', 'web', 'agent', 'think', 'tool'];
const NOTES = ['permission', 'idle', 'other'];

// A shell command counts as a "test run" only if it is clearly a test runner. We send just a yes/no, never the command.
const TEST_CMD = /(^|[\s;&|])(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bvitest\b|\bjest\b|\bgo\s+test\b|\bcargo\s+test\b|\bswift\s+test\b|\bnode\s+--test\b|\bmake\s+test\b|\bpython3?\s+-m\s+(pytest|unittest)\b|\bxcodebuild\b[^\n]*\btest\b/;
export const isTestCommand = (cmd) => TEST_CMD.test(String(cmd || ''));

const KIND_OF = {
  Read: 'read', Glob: 'read', Grep: 'read', LS: 'read', NotebookRead: 'read',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'run', BashOutput: 'run', WebFetch: 'web', WebSearch: 'web', Task: 'agent', Agent: 'agent', TodoWrite: 'think',
};

export const sessionKey = (id) => String(id ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 8).toLowerCase();

function commandName(cmd) {
  // first real word of a shell command, without paths, env assignments or arguments
  const words = String(cmd || '').trim().split(/\s+/);
  const w = words.find((x) => x && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) || '';
  return clean(w.split('/').pop(), 20);
}

function hostOf(url) {
  try {
    return clean(new URL(String(url)).hostname, 40);
  } catch {
    return '';
  }
}

/** Raw Claude Code hook JSON -> small safe payload (or null if we do not care about this event). */
export function sanitizeHook(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const event = EVENTS[raw.hook_event_name];
  const session = sessionKey(raw.session_id);
  if (!event || session.length !== 8) return null;
  const out = { event, session };
  if (event === 'tool_ok' || event === 'tool_fail') {
    // only test runs matter (they feed XP); everything else is dropped here
    const input = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {};
    if (raw.tool_name !== 'Bash' || !isTestCommand(input.command)) return null;
    out.kind = 'test';
  } else if (event === 'tool') {
    const tool = clean(raw.tool_name, 40);
    const input = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {};
    out.tool = tool;
    out.kind = tool.startsWith('mcp__') ? 'tool' : KIND_OF[tool] || 'tool';
    if (tool.startsWith('mcp__')) out.target = clean(tool.split('__')[1], 30);
    else if (out.kind === 'edit' || tool === 'Read') out.target = base(input.file_path || input.notebook_path);
    else if (tool === 'Bash') out.target = commandName(input.command);
    else if (tool === 'WebFetch') out.target = hostOf(input.url);
    else if (out.kind === 'agent') out.target = clean(input.subagent_type, 30);
  } else if (event === 'notify') {
    const hint = `${raw.notification_type || ''} ${raw.message || ''}`;
    out.note = /permission|approve|allow/i.test(hint) ? 'permission' : /idle|waiting|input/i.test(hint) ? 'idle' : 'other';
  } else if (event === 'sub_start' || event === 'sub_stop') {
    out.agent = clean(raw.agent_id, 24);
    out.atype = clean(raw.agent_type, 24);
    if (!out.agent) return null;
  }
  return out;
}

/** Server-side strict re-validation of a payload that arrived over HTTP. Returns a clean copy or null. */
export function validatePayload(p) {
  if (!p || typeof p !== 'object') return null;
  if (!Object.values(EVENTS).includes(p.event) || !/^[0-9a-f]{8}$/.test(String(p.session))) return null;
  const out = { event: p.event, session: p.session };
  if (p.event === 'tool_ok' || p.event === 'tool_fail') {
    if (p.kind !== 'test') return null;
    out.kind = 'test';
  } else if (p.event === 'tool') {
    if (!KINDS.includes(p.kind)) return null;
    out.kind = p.kind; out.tool = clean(p.tool, 40); out.target = clean(p.target, 40);
  } else if (p.event === 'notify') {
    if (!NOTES.includes(p.note)) return null;
    out.note = p.note;
  } else if (p.event === 'sub_start' || p.event === 'sub_stop') {
    out.agent = clean(p.agent, 24);
    out.atype = clean(p.atype, 24);
    if (!out.agent) return null;
  }
  return out;
}
