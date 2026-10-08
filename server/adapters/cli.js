// OpenCode, Aider and Codex CLI: are any of their processes running? Read-only (`ps`).
// We cannot know busy vs idle for these, so a running process is "running", otherwise "standby".
import { run } from '../exec.js';
import { mk } from '../registry.js';

export const name = 'cli';
export const staticIds = ['opencode', 'aider', 'codex'];

/** Pure: classify `ps -axo pid=,etime=,command=` output. */
export function classify(psOut) {
  const found = { opencode: [], aider: [], codex: [], opencodeServer: [] };
  for (const raw of psOut.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(raw);
    if (!m) continue;
    const [, pid, etime, cmd] = m;
    if (/agency-hq/.test(cmd)) continue;
    const exe = cmd.split(/\s+/)[0];
    const base = exe.split('/').pop();
    if (/\.app\//.test(exe)) continue; // desktop apps (e.g. ChatGPT's bundled codex) are not the CLI
    if (base === 'opencode') {
      (/\bserve\b/.test(cmd) ? found.opencodeServer : found.opencode).push({ pid: Number(pid), etime });
    } else if (base === 'codex') {
      found.codex.push({ pid: Number(pid), etime });
    } else if (/(^|\s)\S*\/aider(\s|$)/.test(cmd) && /python/i.test(exe)) {
      found.aider.push({ pid: Number(pid), etime });
    }
  }
  return found;
}

export function buildAgents(found) {
  const mkOne = (id, list, extra = '') =>
    list.length
      ? mk(id, 'running', `${list.length} open (oldest ${list[0].etime})${extra}`, { count: list.length })
      : mk(id, 'standby', `on demand (not running)${extra}`);
  return [
    mkOne('opencode', found.opencode, found.opencodeServer.length ? ' · background server on' : ''),
    mkOne('aider', found.aider),
    mkOne('codex', found.codex),
  ];
}

export async function collect() {
  const r = await run('ps', ['-axo', 'pid=,etime=,command='], { timeout: 4000 });
  if (r.code !== 0) throw new Error('ps failed');
  return buildAgents(classify(r.stdout));
}
