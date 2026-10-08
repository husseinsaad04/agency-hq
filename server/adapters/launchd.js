// launchd: Jarvis, the two nightly jobs, and the Clipflow monitor. Read-only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HOME } from '../config.js';
import { run } from '../exec.js';
import { mk } from '../registry.js';
import { containers } from './docker.js';

export const name = 'launchd';
export const staticIds = ['jarvis', 'job-jarvis-health', 'job-clipflow-monitor', 'clipflow-monitor'];

export const JOBS = {
  'job-jarvis-health': { label: 'local.automations.jarvis-health', dir: 'jarvis-health', schedule: 'nightly 9:00 pm' },
  'job-clipflow-monitor': { label: 'local.automations.clipflow-monitor-check', dir: 'clipflow-monitor', schedule: 'nightly 9:05 pm' },
};

/** `launchctl list` -> Map(label -> {pid, status}) */
export function parseList(stdout) {
  const m = new Map();
  for (const line of stdout.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 3 || p[0] === 'PID') continue;
    m.set(p.slice(2).join(' '), { pid: p[0] === '-' ? null : Number(p[0]), status: Number(p[1]) });
  }
  return m;
}

/** Newest report's STATUS word for a job, e.g. OK/WARN/FAIL (null if none). */
export async function lastReport(dir, root = path.join(HOME, 'Automations', 'reports')) {
  try {
    const base = path.join(root, dir);
    const files = (await fs.readdir(base)).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
    if (!files.length) return null;
    const newest = files[files.length - 1];
    const text = await fs.readFile(path.join(base, newest), 'utf8');
    const m = /^STATUS:\s*([A-Z]+)/m.exec(text);
    return { date: newest.slice(0, 10), status: m ? m[1] : 'UNCLEAR' };
  } catch {
    return null;
  }
}

export function buildAgents(list, reports, dockerList) {
  const out = [];

  const j = list.get('local.jarvis.assistant');
  const rt = dockerList.find((c) => c.name === 'jarvis-conversation-runtime');
  out.push(
    j
      ? mk('jarvis', j.pid ? 'running' : 'stopped', `${j.pid ? `pid ${j.pid}` : 'not running'} · runtime ${rt && rt.state === 'running' ? 'up' : 'down'} · view only`, { port: 53284 })
      : mk('jarvis', 'stopped', 'launch agent not loaded')
  );

  for (const [id, job] of Object.entries(JOBS)) {
    const e = list.get(job.label);
    const rep = reports[id];
    if (!e) {
      out.push(mk(id, 'stopped', `${job.schedule} · disabled (not loaded)`, { label: job.label }));
      continue;
    }
    let state = e.pid ? 'running' : 'scheduled';
    let detail = `${job.schedule}`;
    if (rep) {
      detail += ` · last report ${rep.status} (${rep.date})`;
      if (!e.pid && rep.status !== 'OK') state = 'waiting'; // needs you: read the report
    }
    out.push(mk(id, state, detail, { label: job.label, report: rep }));
  }

  const c = list.get('com.clipflow.monitor');
  out.push(
    c
      ? mk(
          'clipflow-monitor',
          c.pid ? 'running' : 'scheduled',
          `every 5 min · last exit ${c.status}${c.status === 2 ? ' (provider work deferred, usually harmless)' : ''}`,
          { exit: c.status }
        )
      : mk('clipflow-monitor', 'stopped', 'launch agent not loaded')
  );
  return out;
}

export async function collect() {
  const r = await run('launchctl', ['list'], { timeout: 4000 });
  if (r.code !== 0) throw new Error('launchctl list failed');
  const list = parseList(r.stdout);
  let dockerList = [];
  try {
    dockerList = await containers();
  } catch {
    /* docker down: Jarvis runtime shows as down */
  }
  const reports = {};
  for (const [id, job] of Object.entries(JOBS)) reports[id] = await lastReport(job.dir);
  return buildAgents(list, reports, dockerList);
}
