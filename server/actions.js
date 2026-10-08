// The ONLY ways the dashboard can act on an agent. Every action: fixed argv, validated params, audit-logged.
// There is intentionally no generic "run a command" action.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { HOME, CONFIG } from './config.js';
import { run as defaultRun } from './exec.js';

const PRIVATE_PROJECTS = new Set(['agency-hq-services']); // service data and credentials are not agent workspaces
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NOISE = /^(s6-|cont-init|\[stage2\]|\[supervise|\/package\/admin|reconcile:|Syncing bundled|Done: \d+ new|\s+\+ )/;

export function listProjects(root = CONFIG.projectsDir) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && NAME_RE.test(d.name) && !d.name.startsWith('_') && !PRIVATE_PROJECTS.has(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function resolveProject(name, root = CONFIG.projectsDir) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.startsWith('_') || PRIVATE_PROJECTS.has(name)) throw new Error('invalid project');
  const dir = path.join(root, name);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('project not found');
  const real = fs.realpathSync(dir);
  const base = fs.realpathSync(root);
  if (!real.startsWith(base + path.sep)) throw new Error('project is outside the allowed projects folder');
  if (PRIVATE_PROJECTS.has(path.relative(base, real).split(path.sep)[0])) throw new Error('service data is not an agent workspace');
  return dir;
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // shell single-quote
const as = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); // AppleScript string

const TERMINAL_CMDS = {
  claude: { agent: 'claude-code', label: 'Open in Terminal', cmd: 'claude' },
  opencode: { agent: 'opencode', label: 'Open in Terminal', cmd: 'opencode' },
  aider: { agent: 'aider', label: 'Open in Terminal', cmd: 'OLLAMA_API_BASE=http://127.0.0.1:11434 aider --model ollama_chat/qwen3-coder:30b' },
  codex: { agent: 'codex', label: 'Open in Terminal', cmd: 'codex' },
};

const JOBS = {
  'job-jarvis-health': { dir: 'jarvis-health', label: 'local.automations.jarvis-health' },
  'job-clipflow-monitor': { dir: 'clipflow-monitor', label: 'local.automations.clipflow-monitor-check' },
};

export function createActions({ run = defaultRun, spawn = nodeSpawn, db, root = CONFIG.projectsDir, home = HOME, uid = process.getuid?.() ?? 501 } = {}) {
  const runs = new Map(); // hermes task runs (memory only)
  let runSeq = 0;

  const projectParam = { name: 'project', label: 'Project', type: 'select', options: () => listProjects(root) };
  const defs = [];
  const add = (d) => defs.push(d);

  // --- OpenClaw (Docker sandbox)
  add({ id: 'openclaw.start', agents: ['openclaw'], label: 'Start', params: [], exec: () => run('bash', [path.join(home, 'openclaw-sandbox', 'run.sh')], { timeout: 120000 }) });
  add({ id: 'openclaw.restart', agents: ['openclaw'], label: 'Restart', params: [], exec: () => run('bash', [path.join(home, 'openclaw-sandbox', 'run.sh')], { timeout: 120000 }) });
  add({ id: 'openclaw.stop', agents: ['openclaw'], label: 'Stop', confirm: 'Stop the OpenClaw sandbox container?', params: [], exec: () => run('docker', ['stop', 'openclaw-sandbox'], { timeout: 30000 }) });

  // --- Ollama (local model engine)
  add({ id: 'ollama.start', agents: ['ollama'], label: 'Start', params: [], exec: () => run('brew', ['services', 'start', 'ollama'], { timeout: 30000 }) });
  add({ id: 'ollama.stop', agents: ['ollama'], label: 'Stop', confirm: 'Stop Ollama? Local models (Aider, OpenCode local, Hermes) stop working until you start it again.', params: [], exec: () => run('brew', ['services', 'stop', 'ollama'], { timeout: 30000 }) });

  // --- Nightly jobs
  for (const [agent, job] of Object.entries(JOBS)) {
    add({
      id: `job.run.${agent}`, agents: [agent], label: 'Run now', params: [],
      confirm: 'Run this check now? It makes one Claude (Sonnet) call, which uses a little of your Pro allowance.',
      exec: () => run('bash', [path.join(home, 'Automations', job.dir, 'run.sh')], { timeout: 180000 }),
    });
    add({ id: `job.pause.${agent}`, agents: [agent], label: 'Pause', confirm: 'Pause this nightly job until you resume it?', params: [], exec: () => run('launchctl', ['bootout', `gui/${uid}/${job.label}`], { timeout: 15000 }) });
    add({ id: `job.resume.${agent}`, agents: [agent], label: 'Resume', params: [], exec: () => run('launchctl', ['bootstrap', `gui/${uid}`, path.join(home, 'Library', 'LaunchAgents', `${job.label}.plist`)], { timeout: 15000 }) });
  }

  // --- Terminal launchers (interactive tools open in a real Terminal window)
  for (const [tool, t] of Object.entries(TERMINAL_CMDS)) {
    add({
      id: `terminal.open.${tool}`, agents: [t.agent], label: t.label, params: [projectParam],
      exec: (p) => {
        const dir = resolveProject(p.project, root);
        const script = `cd ${q(dir)} && ${t.cmd}`;
        return run('osascript', ['-e', 'tell application "Terminal" to activate', '-e', `tell application "Terminal" to do script "${as(script)}"`], { timeout: 15000 });
      },
    });
  }

  // --- Hermes: run one task in the Docker sandbox, writes limited to the chosen project
  add({
    id: 'hermes.run', agents: ['hermes'], label: 'Run a task',
    note: 'Runs in a locked-down Docker sandbox with your local model. It can only write inside the chosen project.',
    params: [projectParam, { name: 'prompt', label: 'What should Hermes do?', type: 'text', maxLen: 2000 }],
    exec: (p) => {
      for (const r of runs.values()) if (r.status === 'running') return Promise.resolve({ code: 1, stdout: '', stderr: 'a Hermes task is already running' });
      const dir = resolveProject(p.project, root);
      const id = `r${++runSeq}`;
      const rec = { id, project: p.project, startedAt: Date.now(), status: 'running', output: '' };
      runs.set(id, rec);
      const child = spawn(path.join(home, 'hermes-sandbox', 'hermes.sh'), ['--project', dir, 'hermes', '--in', '/workspace', '-z', p.prompt], { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGTERM'), 600000);
      const take = (buf) => {
        const clean = String(buf).split('\n').filter((l) => !NOISE.test(l)).join('\n');
        rec.output = (rec.output + clean).slice(-20000);
      };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      child.on('close', (code) => {
        clearTimeout(timer);
        rec.status = code === 0 ? 'done' : 'error';
        rec.code = code;
        rec.endedAt = Date.now();
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        rec.status = 'error';
        rec.output += `\n${e.message}`;
      });
      return Promise.resolve({ code: 0, stdout: '', stderr: '', runId: id });
    },
  });

  const byId = new Map(defs.map((d) => [d.id, d]));

  function validate(def, params = {}) {
    const clean = {};
    for (const p of def.params) {
      const v = params[p.name];
      if (p.type === 'select') {
        const opts = p.options();
        if (typeof v !== 'string' || !opts.includes(v)) throw new Error(`invalid ${p.name}`);
        clean[p.name] = v;
      } else if (p.type === 'text') {
        if (typeof v !== 'string' || !v.trim() || v.length > p.maxLen) throw new Error(`invalid ${p.name}`);
        clean[p.name] = v.trim();
      }
    }
    return clean;
  }

  return {
    /** Public description for the UI (no functions). */
    describe() {
      return defs.map((d) => ({
        id: d.id, agents: d.agents, label: d.label, confirm: d.confirm || null, note: d.note || null,
        params: d.params.map((p) => ({ name: p.name, label: p.label, type: p.type, maxLen: p.maxLen, options: p.type === 'select' ? p.options() : undefined })),
      }));
    },

    async execute(id, params, { confirmed = false } = {}) {
      const def = byId.get(id);
      if (!def) return { ok: false, status: 404, message: 'unknown action' };
      if (def.confirm && confirmed !== true) return { ok: false, status: 400, message: 'confirmation required' };
      let clean;
      try {
        clean = validate(def, params);
      } catch (e) {
        db?.logAction(id, {}, false, e.message);
        return { ok: false, status: 400, message: e.message };
      }
      try {
        const r = await def.exec(clean);
        const ok = r.code === 0;
        const message = ok ? 'done' : (r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').slice(-2).join(' ').slice(0, 200);
        db?.logAction(id, clean.prompt ? { ...clean, prompt: `[${clean.prompt.length} chars]` } : clean, ok, message);
        return { ok, status: ok ? 200 : 500, message, runId: r.runId };
      } catch (e) {
        db?.logAction(id, clean.prompt ? { ...clean, prompt: `[${clean.prompt.length} chars]` } : clean, false, e.message);
        return { ok: false, status: 500, message: e.message };
      }
    },

    getRun(id) {
      const r = runs.get(id);
      return r ? { id: r.id, project: r.project, status: r.status, code: r.code ?? null, startedAt: r.startedAt, endedAt: r.endedAt ?? null, output: r.output } : null;
    },
    recentRuns() {
      return [...runs.values()].slice(-5).reverse().map((r) => ({ id: r.id, project: r.project, status: r.status, startedAt: r.startedAt }));
    },
  };
}
